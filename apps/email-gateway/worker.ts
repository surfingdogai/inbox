/**
 * The email gateway: Cloudflare Email Routing hands a message to this Worker, and the Worker hands
 * it, byte for byte, to the inbox it is for. Nothing is parsed here and nothing is stored: the inbox
 * does the threading, the deduplication on Message-ID, the loop and spam checks and the reply
 * parsing, so this stays small enough to trust (ADR-005, ADR-026 §1).
 *
 * Two kinds of address reach it:
 *
 * - an address on the hosted inbound domain (`HOSTED_INBOUND_DOMAIN`, e.g. `in.surfingdog.ai`):
 *   `<slug>@…` is a hosted inbox's own address and `<slug>+<token>@…` one of its conversations. The
 *   message goes to the hosted router (`HOSTED_INBOUND_URL`), signed with `HOSTED_INBOUND_KEY`, the
 *   envelope and what the receiving server found about the sender in the signed query;
 * - any other address routed here: our own inbox (`INBOX_INBOUND_URL`), with its inbound secret.
 */
import { authSummary, deliveryTarget, headerFields, routeFor, signDelivery, verdictOf } from "./route";

interface Env {
  /** Our own inbox, e.g. https://inbox.surfingdog.ai/v1/email/inbound */
  readonly INBOX_INBOUND_URL: string;
  /** Our own inbox's `email.inboundSecret`, set with `wrangler secret put`. */
  readonly INBOX_EMAIL_SECRET: string;
  /** The domain hosted inboxes' addresses are on, e.g. in.surfingdog.ai. Unset: no hosted mail. */
  readonly HOSTED_INBOUND_DOMAIN?: string;
  /** The hosted router's delivery address, e.g. https://mail-in.example.org (the router's HOSTED_INBOUND_HOST). */
  readonly HOSTED_INBOUND_URL?: string;
  /** The key deliveries are signed with: the router's HOSTED_INBOUND_KEY, set with `wrangler secret put`. */
  readonly HOSTED_INBOUND_KEY?: string;
  /**
   * The receiving server's own Authentication-Results ids, comma-separated (e.g. mx.cloudflare.net),
   * set only once a real delivery showed Email Routing puts its results on top of every message.
   * Unset (the default): no verdict is passed on, and the inboxes judge nothing by one.
   */
  readonly TRUSTED_AUTHSERV?: string;
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
    const route = routeFor(message.to, env.HOSTED_INBOUND_DOMAIN);
    if (route.kind === "refuse") {
      message.setReject(route.reason);
      return;
    }
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const auth = env.TRUSTED_AUTHSERV ? authSummary(headerFields(raw), env.TRUSTED_AUTHSERV.split(",")) : undefined;
    let res: Response;
    try {
      if (route.kind === "hosted") {
        if (!env.HOSTED_INBOUND_URL || !env.HOSTED_INBOUND_KEY) {
          // Hosted addresses routed here before the gateway was told where they go: held, never bounced.
          throw new Error("hosted delivery is not set up");
        }
        const target = deliveryTarget({ slug: route.slug, to: message.to, from: message.from, auth });
        res = await fetch(new URL(target, env.HOSTED_INBOUND_URL), {
          method: "POST",
          headers: {
            "content-type": "message/rfc822",
            ...(await signDelivery(env.HOSTED_INBOUND_KEY, "POST", target, raw)),
          },
          body: raw,
        });
      } else {
        res = await fetch(env.INBOX_INBOUND_URL, {
          method: "POST",
          headers: {
            "content-type": "message/rfc822",
            "x-inbox-email-secret": env.INBOX_EMAIL_SECRET,
            "x-envelope-from": message.from,
            "x-envelope-to": message.to,
            ...(auth ? { "x-inbox-email-auth": auth } : {}),
          },
          body: raw,
        });
      }
    } catch (error) {
      // The inbox is unreachable. Throwing answers the sending server with a temporary failure,
      // and every real mail server retries those for days; a reject would bounce the message.
      throw new Error(`inbox unreachable: ${(error as Error).message}`);
    }
    const verdict = verdictOf(res.status);
    if (verdict === "taken") return;
    if (verdict === "later") throw new Error(`inbox answered ${res.status}`);
    // A permanent answer: no such inbox, a refused sender, too large. Bounced with the reason.
    message.setReject(
      route.kind === "hosted" && res.status === 422 ? "no such address" : `inbox refused the message (${res.status})`,
    );
  },
};
