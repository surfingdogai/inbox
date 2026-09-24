/**
 * The email gateway: Cloudflare Email Routing hands a message to this Worker, and the Worker
 * hands it, byte for byte, to an Inbox's `POST /v1/email/inbound` with that Inbox's shared
 * secret. Nothing is parsed here and nothing is stored: the Inbox does the threading, the
 * deduplication on Message-ID and the reply parsing, so this stays small enough to trust.
 *
 * One tenant today, our own inbox. Hosted tenancy makes ROUTES a lookup keyed on the local part
 * of the address rather than a single secret; the shape of this file does not change.
 */
interface Env {
  /** Where to deliver, e.g. https://inbox.surfingdog.ai/v1/email/inbound */
  readonly INBOX_INBOUND_URL: string;
  /** The Inbox's `email.inboundSecret`, set with `wrangler secret put`. */
  readonly INBOX_EMAIL_SECRET: string;
}

interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** Email Routing accepts up to 25 MiB; an Inbox parses in memory, so the same cap applies. */
const MAX_BYTES = 25 * 1024 * 1024;

export default {
  async email(message: EmailMessage, env: Env): Promise<void> {
    if (message.rawSize > MAX_BYTES) {
      message.setReject("message too large");
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    let res: Response;
    try {
      res = await fetch(env.INBOX_INBOUND_URL, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-inbox-email-secret": env.INBOX_EMAIL_SECRET,
          "x-envelope-from": message.from,
          "x-envelope-to": message.to,
        },
        body: raw,
      });
    } catch (error) {
      // The Inbox is unreachable. Throwing answers the sending server with a temporary failure,
      // and every real mail server retries those for days; a reject would bounce the message.
      throw new Error(`inbox unreachable: ${(error as Error).message}`);
    }
    if (res.ok) return;
    // 5xx, and 429 (too many from this sender right now): temporary, so the sending server retries.
    if (res.status >= 500 || res.status === 429) throw new Error(`inbox answered ${res.status}`);
    // 4xx is a permanent answer: wrong secret, refused sender, too large. Bounce with the reason.
    message.setReject(`inbox refused the message (${res.status})`);
  },
};
