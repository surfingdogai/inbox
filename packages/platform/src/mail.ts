import type { MailOut, OutboundMail } from "./index";

/** Collects messages instead of sending them: development and tests. */
export interface LogMailOut extends MailOut {
  readonly sent: OutboundMail[];
}

export function logMailOut(log: (line: string) => void = () => {}): LogMailOut {
  const sent: OutboundMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
      log(`mail to ${mail.to.join(", ")}: ${mail.subject}`);
      return { messageId: `log-${sent.length}` };
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
        ...(mail.headers ? { headers: mail.headers } : {}),
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
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        errors?: { code: number; message: string }[];
        result?: { messageId?: string; id?: string };
      };
      if (!res.ok || body.success === false) {
        const e = body.errors?.[0];
        throw new Error(e ? `cloudflare email: ${e.message} (code ${e.code})` : `cloudflare email: HTTP ${res.status}`);
      }
      return { messageId: body.result?.messageId ?? body.result?.id ?? `cf-${Date.now()}` };
    },
  };
}
