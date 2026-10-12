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
 * No mail service: the whole message is written to the log, so a sign-in link can be copied from the
 * terminal (Node) or the Worker's logs. A customer's network key or pass is not the operator's to
 * copy: its secret is cut. `delivers: false`, so the mail log never records a message as sent.
 */
export function consoleMailOut(log: (line: string) => void = console.log): MailOut {
  return {
    // Nothing leaves this machine, so a message with no sender of its own can still be shown.
    sender: LOCAL_SENDER,
    delivers: false,
    async send(mail) {
      const body = mail.text
        .replace(/\b(sd(?:key|pass)1_[a-z0-9.-]+_[a-z2-7]{16}_)[a-z2-7]{32}\b/g, "$1…")
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      const headers = Object.entries(mail.headers ?? {})
        .map(([k, v]) => `    ${k}: ${v}\n`)
        .join("");
      log(`mail to ${mail.to.join(", ")}: ${mail.subject}\n${headers}${body}`);
      return { messageId: `console-${crypto.randomUUID()}` };
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

/**
 * The binding sends from the address a message names, which must be on a domain onboarded to Email
 * Sending on the same account. `sender` (MAIL_FROM) is the address a message with none of its own
 * goes out from, such as the owner's sign-in link.
 */
export function cloudflareEmailMailOut(
  binding: CloudflareEmailBinding,
  sender?: { address: string; name?: string | undefined } | undefined,
): MailOut {
  return {
    ...(sender ? { sender } : {}),
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

/** `text` on one line: each run of control characters, line breaks among them, becomes one space. */
function oneLine(text: string): string {
  let out = "";
  let control = false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (!control) out += " ";
      control = true;
    } else {
      out += ch;
      control = false;
    }
  }
  return out;
}

/**
 * A display name as RFC 5322 writes it in a From line: as it is when it is only words, else in
 * quotes, with quotes and backslashes escaped, so `Acme <other@example.com>` is a name and never a
 * second address. On one line: a name is never another header. Empty when nothing of it is left.
 */
export function displayName(name: string): string {
  const clean = oneLine(name).replace(/\s+/g, " ").trim();
  return /[()<>[\]:;@\\,."]/.test(clean) ? `"${clean.replace(/["\\]/g, "\\$&")}"` : clean;
}

/** A header's name as RFC 5322 allows one: printable, with no space and no colon. */
const HEADER_NAME = /^[!-9;-~]+$/;

/** Headers a service is handed as they are: names that are names, values on one line. */
function oneLineHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => HEADER_NAME.test(name))
      .map(([name, value]) => [name, oneLine(value).trim()]),
  );
}

/** Resend's HTTP API; runs anywhere fetch does. `sender` (MAIL_FROM) is for messages that name none. */
export function resendMailOut(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  sender?: { address: string; name?: string | undefined } | undefined,
): MailOut {
  return {
    ...(sender ? { sender } : {}),
    async send(mail) {
      // One string, as Resend takes it: the name quoted when it holds anything an address could.
      const name = displayName(mail.from.name ?? "");
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: name ? `${name} <${mail.from.address}>` : mail.from.address,
          to: mail.to,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          subject: mail.subject,
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
          ...(mail.headers ? { headers: oneLineHeaders(mail.headers) } : {}),
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

/**
 * Header names that would name another sender or more recipients than `to`. A pinned transport
 * never passes them on, so nothing in a message's headers can change who it is from or who gets it.
 */
const ADDRESS_HEADERS = /^(from|sender|reply-to|return-path|to|cc|bcc|resent-[a-z-]+)$/i;

/**
 * A transport that sends every message from one address, whatever the message names: the sender
 * set where the inbox is run, not Send from, Sender name or Customers reply to in Settings. Wraps
 * any transport.
 *
 * - From is `from.address`, with `from.name` when one is given, else the message's own name, on one
 *   line and without angle brackets, so no name it was given can read as another address.
 * - Reply-To is `replyTo` when one is given, and absent otherwise: a reply then comes back to the
 *   sender, never to an address someone typed into Settings.
 * - Headers that name a sender or a recipient are left out, and the rest are each kept to one line.
 *
 * `sender` is the pinned address, so a message that names none (the owner's sign-in link) goes from
 * it too, and `pinned` tells the inbox its email is from here. What the inner transport says of
 * itself (`delivers`) and its hooks (`allowCustomerMail`, `beforeSend`) are kept.
 */
export function pinnedMailOut(
  inner: MailOut,
  pin: {
    readonly from: { readonly address: string; readonly name?: string | undefined };
    readonly replyTo?: string | undefined;
  },
): MailOut {
  const sender = pin.from.name ? { address: pin.from.address, name: pin.from.name } : { address: pin.from.address };
  return {
    sender,
    pinned: true,
    ...(inner.delivers === false ? { delivers: false } : {}),
    ...(inner.allowCustomerMail ? { allowCustomerMail: inner.allowCustomerMail } : {}),
    ...(inner.beforeSend ? { beforeSend: inner.beforeSend } : {}),
    async send(mail) {
      const own = mail.from.name?.replace(/[<>]/g, " ");
      const name = oneLine(pin.from.name ?? own ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const headers = oneLineHeaders(
        Object.fromEntries(
          Object.entries(mail.headers ?? {}).filter(([header]) => !ADDRESS_HEADERS.test(header.trim())),
        ),
      );
      return inner.send({
        from: name ? { address: pin.from.address, name } : { address: pin.from.address },
        to: mail.to,
        ...(pin.replyTo ? { replyTo: pin.replyTo } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      });
    },
  };
}

function headersOf(mail: OutboundMail): { headers?: Record<string, string> } {
  const headers = cloudflareHeaders(mail.headers);
  return headers ? { headers } : {};
}
