import { describe, expect, it } from "vitest";
import { amzDate, buildMime, encodeWord, sesMailOut, signV4 } from "../src/ses";

/**
 * The SES transport (ADR-026 §3): its request signing against AWS's own published test vector, and
 * the message it hands SES.
 */
describe("AWS Signature Version 4", () => {
  it("signs AWS's get-vanilla test request to the published signature", async () => {
    const h = await signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: Date.parse("2015-08-30T12:36:00Z"),
    });
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("writes AWS's date form", () => {
    expect(amzDate(Date.parse("2026-10-19T09:05:07.123Z"))).toBe("20261019T090507Z");
  });
});

describe("the message", () => {
  it("encodes names and subjects that are not ASCII, keeps threading headers, and never lets a header name a sender", () => {
    const mime = buildMime(
      {
        from: { address: "support@oficinamare.example", name: "Oficina Maré" },
        to: ["rita@example.com"],
        replyTo: "support+tabcdefghijklmnop@oficinamare.example",
        subject: "Orçamento: roda traseira",
        text: "Olá Rita,\n\nSim.",
        headers: {
          "In-Reply-To": "<a.1@oficinamare.example>",
          References: "<a.1@oficinamare.example>",
          "X-Inbox-Loop": "sdi.0123456789abcdef0123",
          From: "evil@example.org",
          Bcc: "evil@example.org",
          "Bad\nHeader": "x",
        },
      },
      { now: Date.parse("2026-10-19T09:00:00Z") },
    );
    expect(mime).toContain(`From: ${encodeWord("Oficina Maré")} <support@oficinamare.example>`);
    expect(mime).toContain("Reply-To: <support+tabcdefghijklmnop@oficinamare.example>");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("In-Reply-To: <a.1@oficinamare.example>");
    expect(mime).toContain("X-Inbox-Loop: sdi.0123456789abcdef0123");
    expect(mime).not.toContain("evil@example.org");
    expect(mime).not.toContain("Bad");
    const body = mime.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe("Olá Rita,\n\nSim.");
  });

  it("is the text alone when there is no HTML, as it always was", () => {
    const mime = buildMime(
      { from: { address: "support@oficinamare.example" }, to: ["rita@example.com"], subject: "Hi", text: "Hello" },
      { now: Date.parse("2026-10-19T09:00:00Z") },
    );
    expect(mime).toBe(
      [
        "From: <support@oficinamare.example>",
        "To: <rita@example.com>",
        "Subject: Hi",
        "Date: Mon, 19 Oct 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8=",
        "",
      ].join("\r\n"),
    );
  });

  it("sends the text and the HTML as two parts of one message, the text first", () => {
    const html = `<!doctype html><p>Olá ${"x".repeat(300)}</p>`;
    const mime = buildMime(
      {
        from: { address: "support@oficinamare.example" },
        to: ["rita@example.com"],
        subject: "Hi",
        text: "Olá Rita",
        html,
      },
      { now: Date.parse("2026-10-19T09:00:00Z") },
    );
    const boundary = /^Content-Type: multipart\/alternative; boundary="(=_sd_[0-9a-f]{24})"$/m.exec(mime)?.[1] ?? "";
    expect(boundary).not.toBe("");
    const [head, ...rest] = mime.split(`--${boundary}`);
    expect(head).toContain("MIME-Version: 1.0");
    expect(rest.at(-1)).toBe("--\r\n");
    const parts = rest.slice(0, -1).map((p) => {
      const [headers = "", body = ""] = p.replace(/^\r\n/, "").split("\r\n\r\n");
      const bytes = Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0));
      return { headers, body, text: new TextDecoder().decode(bytes) };
    });
    expect(parts.map((p) => p.headers.split("\r\n")[0])).toEqual([
      "Content-Type: text/plain; charset=utf-8",
      "Content-Type: text/html; charset=utf-8",
    ]);
    expect(parts.map((p) => p.text)).toEqual(["Olá Rita", html]);
    // Neither part holds the boundary, and every line is within the limit.
    for (const p of parts) expect(p.body).not.toContain(boundary);
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    // A boundary of its own for each message.
    expect(
      buildMime({ from: { address: "a@b.example" }, to: ["c@d.example"], subject: "s", text: "t", html }, { now: 0 }),
    ).not.toContain(boundary);
  });

  it("sends from its own address through SES v2, signed, in the region asked", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ MessageId: "0102-abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = sesMailOut(
      {
        region: "eu-west-1",
        credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" },
        from: { address: "support@oficinamare.example", name: "Oficina Maré" },
      },
      fake,
      () => Date.parse("2026-10-19T09:00:00Z"),
    );
    const r = await out.send({
      from: { address: "someone@else.example" },
      to: ["rita@example.com"],
      subject: "Hi",
      text: "Hello",
    });
    expect(r.messageId).toBe("0102-abc");
    expect(calls[0]?.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261019\/eu-west-1\/ses\/aws4_request, /,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      FromEmailAddress: string;
      Content: { Raw: { Data: string } };
    };
    expect(body.FromEmailAddress).toContain("<support@oficinamare.example>");
    expect(atob(body.Content.Raw.Data)).toContain("From: ");
    expect(atob(body.Content.Raw.Data)).not.toContain("someone@else.example");
  });

  it("says why SES refused", async () => {
    const out = sesMailOut(
      {
        region: "eu-west-1",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
        from: { address: "a@b.example" },
      },
      (async () =>
        new Response(JSON.stringify({ message: "Email address is not verified." }), {
          status: 400,
        })) as unknown as typeof fetch,
    );
    await expect(
      out.send({ from: { address: "a@b.example" }, to: ["c@d.example"], subject: "s", text: "t" }),
    ).rejects.toThrow("ses: Email address is not verified.");
  });
});
