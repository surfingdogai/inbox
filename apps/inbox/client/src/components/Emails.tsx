import clsx from "clsx";
import { MailCheck, Mail as MailIcon, MailWarning } from "lucide-react";
import { useState } from "react";
import { deliveryWord, formatDateTime, mailWord } from "../lib/format";
import type { Mail } from "../lib/types";

/**
 * Every email about the item, to the customer and to the owner, and what became of each: sent,
 * still being tried, failed, or not sent and why. One click shows what it said. Nothing here claims
 * an email went out before the mail service took it.
 */
export function Emails({ mail, tz }: { mail: readonly Mail[]; tz: string | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  if (mail.length === 0) return null;
  return (
    <div className="stack receipts">
      <div className="eyebrow">Emails</div>
      <ul className="receipt-list">
        {mail.map((m) => {
          const bad = m.status === "failed" || m.status === "skipped" || m.status === "retrying";
          const Icon = m.status === "sent" ? MailCheck : bad ? MailWarning : MailIcon;
          return (
            <li className="receipt" key={m.id}>
              <Icon className="icon" aria-hidden="true" />
              <span className="what">
                <button
                  type="button"
                  className="linkish"
                  aria-expanded={open === m.id}
                  onClick={() => setOpen(open === m.id ? null : m.id)}
                >
                  <b>{mailWord(m)}</b>
                </button>
                {` · ${m.subject}`}
              </span>
              <span className={clsx("pill pill-xs", m.status === "sent" ? "tint-success" : bad && "tint-warning")}>
                {deliveryWord(m, tz)}
              </span>
              <time className="when" dateTime={m.created_at}>
                {formatDateTime(m.created_at, tz)}
              </time>
              {open === m.id && <pre className="mail-body row-glass">{m.body}</pre>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
