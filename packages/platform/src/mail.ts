import type { MailOut, OutboundMail } from "./index";

/** Collects messages instead of sending them: development and tests. */
export interface LogMailOut extends MailOut {
  readonly sent: OutboundMail[];
}

/**
 * The sender a transport that delivers nothing gives a message that names none: it only ever
 * reaches a log, so a development instance shows its emails before anyone configured an address.
 */
export const LOCAL_SENDER = { address: "inbox@localhost" } as const;

/**
 * A transport that keeps what it is given and writes a line to `log`. Tests use it as a mail service
 * that works; an instance with no mail service falls back to it with `delivers: false`, so the mail
 * log says nothing went out (`skip_reason: no_service`) while a developer still sees each email.
 */
export function logMailOut(log: (line: string) => void = () => {}, opts: { delivers?: boolean } = {}): LogMailOut {
  const sent: OutboundMail[] = [];
  return {
    sent,
    sender: LOCAL_SENDER,
    ...(opts.delivers === false ? { delivers: false } : {}),
    async send(mail) {
      sent.push(mail);
      log(`mail to ${mail.to.join(", ")}: ${mail.subject}`);
      // Unique across instances, like a real service's id: a reply naming it must find one item.
      return { messageId: `log-${sent.length}-${crypto.randomUUID()}` };
    },
  };
}

/**
 * Cloudflare Email Service `send_email` binding (structural type; `env.EMAIL` satisfies it).
 *
 * The shape is workerd's own `EmailAddress`: `{ email, name }`, name required, or a plain string.
 * It is NOT the REST API's `{ address, name }` — this type once said `address`, it compiled, and
 * every send through the binding would have failed, because a hand-written structural type checks
 * nothing against the runtime. The test in mail.test.ts pins it to the runtime shape.
 */
export interface CloudflareEmailBinding {
  send(message: {
    from: { email: string; name: string } | string;
    to: string | string[];
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/**
 * The headers Cloudflare Email Service accepts in `headers` (developers.cloudflare.com/email-service/
 * reference/headers): an allowlist, plus any `X-` header, each value at most 2,048 bytes. It refuses
 * the whole message over one header it does not accept (`E_HEADER_NOT_ALLOWED`), so anything else —
 * a `Message-ID`, which it writes itself — is left out rather than sent.
 */
const CLOUDFLARE_HEADERS = new Set(
  [
    "In-Reply-To",
    "References",
    "Thread-Index",
    "Thread-Topic",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "Require-Recipient-Valid-Since",
    "Expires",
    "Reply-By",
    "Archived-At",
  ].map((h) => h.toLowerCase()),
);

export function cloudflareHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const allowed = CLOUDFLARE_HEADERS.has(name.toLowerCase()) || /^X-[A-Za-z0-9\-_]+$/i.test(name);
    const clean = value.replace(/[\r\n]+/g, " ").trim();
    if (!allowed || !clean || new TextEncoder().encode(clean).byteLength > 2048) continue;
    out[name] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

export function cloudflareEmailMailOut(binding: CloudflareEmailBinding): MailOut {
  return {
    async send(mail) {
      const r = await binding.send({
        from: mail.from.name ? { email: mail.from.address, name: mail.from.name } : mail.from.address,
        to: [...mail.to],
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...headersOf(mail),
      });
      return { messageId: r.messageId };
    },
  };
}

/** Resend's HTTP API; runs anywhere fetch does. */
export function resendMailOut(apiKey: string, fetchImpl: typeof fetch = fetch): MailOut {
  return {
    async send(mail) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address,
          to: mail.to,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          subject: mail.subject,
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
          ...(mail.headers ? { headers: mail.headers } : {}),
        }),
      });
      if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { id: string };
      return { messageId: body.id };
    },
  };
}

/**
 * Cloudflare Email Service over its REST API, for runtimes without the `send_email` binding
 * (Node, Bun). Cloudflare only sends from domains onboarded on the account, so every message goes
 * out from the configured address; the message's own sender becomes Reply-To when it differs.
 */
export function cloudflareEmailRestMailOut(
  opts: { accountId: string; token: string; from: { address: string; name?: string | undefined } },
  fetchImpl: typeof fetch = fetch,
): MailOut {
  return {
    sender: opts.from,
    async send(mail) {
      const replyTo = mail.replyTo && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.replyTo) ? mail.replyTo : undefined;
      const name = mail.from.name ?? opts.from.name;
      const res = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/email/sending/send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: name ? { address: opts.from.address, name } : { address: opts.from.address },
            to: mail.to.length === 1 ? mail.to[0] : [...mail.to],
            // The REST API's field is reply_to. The binding's is replyTo; the two are not
            // interchangeable, and an unknown field is dropped without an error, which is how a
            // customer's reply ends up at the sender instead of the business.
            ...(replyTo ? { reply_to: replyTo } : {}),
            subject: mail.subject,
            text: mail.text,
            ...(mail.html ? { html: mail.html } : {}),
            // Threading (In-Reply-To, References): without them a customer's reply starts a new
            // conversation instead of landing on the item it answers.
            ...headersOf(mail),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        errors?: { code: number; message: string }[];
        result?: { messageId?: string; id?: string; permanent_bounces?: unknown };
      };
      if (!res.ok || body.success === false) {
        const e = body.errors?.[0];
        throw new Error(e ? `cloudflare email: ${e.message} (code ${e.code})` : `cloudflare email: HTTP ${res.status}`);
      }
      // A 200 that bounced the recipient delivered nothing: it is a failed send, never a sent one.
      const bounced = Array.isArray(body.result?.permanent_bounces)
        ? (body.result.permanent_bounces as unknown[]).map((b) => String(b).toLowerCase())
        : [];
      if (mail.to.some((to) => bounced.includes(to.toLowerCase()))) {
        throw new Error("cloudflare email: bounced");
      }
      return { messageId: body.result?.messageId ?? body.result?.id ?? "" };
    },
  };
}

function headersOf(mail: OutboundMail): { headers?: Record<string, string> } {
  const headers = cloudflareHeaders(mail.headers);
  return headers ? { headers } : {};
}
