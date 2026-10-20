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
