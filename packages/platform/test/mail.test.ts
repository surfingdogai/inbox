import { describe, expect, it } from "vitest";
import {
  type CloudflareEmailBinding,
  cloudflareEmailMailOut,
  cloudflareEmailRestMailOut,
  cloudflareHeaders,
} from "../src/mail";

/**
 * The two Cloudflare senders speak two different wire shapes, and each was once wrong in a way that
 * compiled and failed only in production: the binding was sent the REST API's `{ address }` where
 * workerd wants `{ email }`, and the REST API was sent the binding's `replyTo` where its schema says
 * `reply_to` (which it drops without an error, so the customer's reply went to the sender instead of
 * the business). These tests pin each to the shape its own reference defines:
 *   binding — workerd's EmailAddress { name: string; email: string } (worker-configuration.d.ts)
 *   REST    — POST /accounts/{id}/email/sending/send, fields from / to / subject / text / html /
 *             reply_to (developers.cloudflare.com/api/resources/email_sending/methods/send)
 */
const mail = {
  from: { address: "inbox@oficinamare.pt", name: "Oficina Maré" },
  to: ["rita@example.com"],
  replyTo: "hello@oficinamare.pt",
  subject: "Confirmed: Full service",
  text: "See you on Tuesday.",
};

describe("the send_email binding", () => {
  it("gets workerd's EmailAddress: email and name, never address", async () => {
    const seen: Parameters<CloudflareEmailBinding["send"]>[0][] = [];
    const binding: CloudflareEmailBinding = {
      async send(m) {
        seen.push(m);
        return { messageId: "m-1" };
      },
    };
    const r = await cloudflareEmailMailOut(binding).send(mail);
    expect(r.messageId).toBe("m-1");
    expect(seen[0]?.from).toEqual({ email: "inbox@oficinamare.pt", name: "Oficina Maré" });
    expect(JSON.stringify(seen[0])).not.toContain('"address"');
    // The binding's reply field is camelCase.
    expect(seen[0]?.replyTo).toBe("hello@oficinamare.pt");
  });

  it("passes allowlisted headers only, and none when nothing is left", async () => {
    const seen: Parameters<CloudflareEmailBinding["send"]>[0][] = [];
    const binding: CloudflareEmailBinding = {
      async send(m) {
        seen.push(m);
        return { messageId: "m-3" };
      },
    };
    await cloudflareEmailMailOut(binding).send({
      ...mail,
      headers: { References: "<a.1@oficinamare.pt>", "Message-ID": "<x@y>" },
    });
    await cloudflareEmailMailOut(binding).send({ ...mail, headers: { "Message-ID": "<x@y>" } });
    expect(seen[0]?.headers).toEqual({ References: "<a.1@oficinamare.pt>" });
    expect(seen[1]).not.toHaveProperty("headers");
    // A value over 2,048 bytes, or with a line break in it, never reaches the service as it was.
    expect(cloudflareHeaders({ References: `<${"a".repeat(2100)}@x>` })).toBeUndefined();
    expect(cloudflareHeaders({ "In-Reply-To": "<a@x>\r\nBcc: someone@example.com" })).toEqual({
      "In-Reply-To": "<a@x> Bcc: someone@example.com",
    });
    // The headers that keep out-of-office replies away: the X- one goes; Auto-Submitted is not on
    // Cloudflare's list, would get the whole message refused, and is left out.
    expect(
      cloudflareHeaders({
        "X-Auto-Response-Suppress": "OOF, AutoReply",
        "Auto-Submitted": "auto-replied",
        References: "<a.1@oficinamare.pt>",
      }),
    ).toEqual({ "X-Auto-Response-Suppress": "OOF, AutoReply", References: "<a.1@oficinamare.pt>" });
  });

  it("sends a bare address when there is no name, because workerd's name is required", async () => {
    let from: unknown;
    const binding: CloudflareEmailBinding = {
      async send(m) {
        from = m.from;
        return { messageId: "m-2" };
      },
    };
    await cloudflareEmailMailOut(binding).send({ ...mail, from: { address: "inbox@oficinamare.pt" } });
    expect(from).toBe("inbox@oficinamare.pt");
  });
});

describe("the REST API", () => {
  function capture() {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ success: true, errors: [], result: { delivered: ["rita@example.com"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("names the reply field reply_to, as the schema does", async () => {
    const net = capture();
    const out = cloudflareEmailRestMailOut(
      { accountId: "acc", token: "tok", from: { address: "hello@surfingdog.ai", name: "Surfing Dog" } },
      net.fetchImpl,
    );
    await out.send(mail);
    const body = net.calls[0]?.body ?? {};
    expect(net.calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send");
    expect(net.calls[0]?.auth).toBe("Bearer tok");
    expect(body.reply_to).toBe("hello@oficinamare.pt");
    expect(body).not.toHaveProperty("replyTo");
    // The REST from object is { address, name } — the opposite of the binding.
    expect(body.from).toEqual({ address: "hello@surfingdog.ai", name: "Oficina Maré" });
  });

  it("leaves reply_to out rather than send something that is not an address", async () => {
    const net = capture();
    const out = cloudflareEmailRestMailOut(
      { accountId: "acc", token: "tok", from: { address: "hello@surfingdog.ai" } },
      net.fetchImpl,
    );
    await out.send({ ...mail, replyTo: "not an address" });
    expect(net.calls[0]?.body).not.toHaveProperty("reply_to");
  });

  it("passes the threading headers, and leaves out what Cloudflare would refuse the whole message for", async () => {
    const net = capture();
    const out = cloudflareEmailRestMailOut(
      { accountId: "acc", token: "tok", from: { address: "hello@oficinamare.pt" } },
      net.fetchImpl,
    );
    await out.send({
      ...mail,
      headers: {
        "In-Reply-To": "<a.1@oficinamare.pt>",
        References: "<a.1@oficinamare.pt> <m.2@oficinamare.pt>",
        "Message-ID": "<ours@oficinamare.pt>",
        Date: "Tue, 22 Sep 2026 10:00:00 +0000",
        "X-Item-Ref": "7K3QXA",
      },
    });
    expect(net.calls[0]?.body.headers).toEqual({
      "In-Reply-To": "<a.1@oficinamare.pt>",
      References: "<a.1@oficinamare.pt> <m.2@oficinamare.pt>",
      "X-Item-Ref": "7K3QXA",
    });
    // Its own address is the sender a message without one goes out from.
    expect(out.sender).toEqual({ address: "hello@oficinamare.pt" });
  });

  it("counts a recipient the service bounced as a failed send, never a sent one", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: { delivered: [], permanent_bounces: ["rita@example.com"], queued: [] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const out = cloudflareEmailRestMailOut(
      { accountId: "acc", token: "tok", from: { address: "hello@oficinamare.pt" } },
      fetchImpl,
    );
    await expect(out.send(mail)).rejects.toThrow("cloudflare email: bounced");
  });

  it("throws the API's own message when it refuses", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
        }),
        { status: 400 },
      )) as unknown as typeof fetch;
    const out = cloudflareEmailRestMailOut(
      { accountId: "acc", token: "tok", from: { address: "hello@surfingdog.ai" } },
      fetchImpl,
    );
    await expect(out.send(mail)).rejects.toThrow(/invalid_request_schema \(code 10001\)/);
  });
});
