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

/** Cloudflare Email Service `send_email` binding (structural type; `env.EMAIL` satisfies it). */
export interface CloudflareEmailBinding {
  send(message: {
    from: { address: string; name?: string } | string;
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
        from: { address: mail.from.address, ...(mail.from.name ? { name: mail.from.name } : {}) },
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
