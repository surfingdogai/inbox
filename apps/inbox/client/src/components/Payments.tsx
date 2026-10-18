import clsx from "clsx";
import { Check, Copy, CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatDateTime, formatMoney } from "../lib/format";
import { useItemPayments } from "../lib/queries";
import type { PaymentView } from "../lib/types";

/**
 * An order's payment through the business's own Stripe or Mollie account (ADR-023): the link it was
 * sent and what the platform said, in a line or two. Where the money is, the owner refunds it: the
 * payment's own page in their dashboard. Earlier links (the total changed, a payment failed) fold
 * into one quiet count.
 */
export function Payments({ itemId, state, tz }: { itemId: string; state: string; tz: string | undefined }) {
  // While the order waits to be paid, a link may be on its way: it is looked for now and then.
  const query = useItemPayments(itemId, WAITING.has(state));
  const [copied, setCopied] = useState(false);
  const all = query.data?.payments ?? [];
  if (all.length === 0) return null;
  const shown = all.filter((p) => p.state !== "closed" && p.state !== "failed");
  const earlier = all.length - shown.length;
  const list = shown.length > 0 ? shown : all.slice(0, 1);
  return (
    <div className="stack receipts payments">
      <ul className="receipt-list">
        {list.map((p) => (
          <li className="receipt" key={p.id}>
            <CreditCard className="icon" aria-hidden="true" />
            <span className="what">
              <b>{p.provider}</b> · {wordsOf(p)}
              {!p.livemode && <span className="opt"> · test</span>}
            </span>
            {p.paid_at && (
              <time className="when" dateTime={new Date(p.paid_at).toISOString()}>
                {formatDateTime(new Date(p.paid_at).toISOString(), tz)}
              </time>
            )}
            {p.state === "open" && p.url && (
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label={copied ? "Link copied" : "Copy the payment link"}
                onClick={() => void navigator.clipboard.writeText(p.url ?? "").then(() => setCopied(true))}
              >
                {copied ? (
                  <Check className="icon-xs" aria-hidden="true" />
                ) : (
                  <Copy className="icon-xs" aria-hidden="true" />
                )}
              </button>
            )}
            {p.dashboard_url && (
              <a className="int-link" href={p.dashboard_url} target="_blank" rel="noopener noreferrer">
                {p.state === "paid" ? `Refund in ${p.provider}` : `Open ${p.provider}`}
                <ExternalLink className="icon-xs" aria-hidden="true" />
              </a>
            )}
            {(p.error || p.note) && (
              <span
                className={clsx("hint", p.state === "error" && "error")}
                role={p.state === "error" ? "alert" : undefined}
              >
                {p.error ?? p.note}
              </span>
            )}
          </li>
        ))}
      </ul>
      {earlier > 0 && shown.length > 0 && (
        <p className="hint">
          {earlier === 1 ? "An earlier link was closed." : `${earlier} earlier links were closed.`}
        </p>
      )}
    </div>
  );
}

const WAITING = new Set(["accepted", "awaiting_payment", "payment_failed"]);

function wordsOf(p: PaymentView): string {
  switch (p.state) {
    case "paid":
      return `paid ${formatMoney(p.paid_amount ?? p.amount)}${p.method ? ` by ${p.method.replaceAll("_", " ")}` : ""}`;
    case "open":
      return `waiting for ${formatMoney(p.amount)}`;
    case "creating":
      return p.error ? "making the link again soon" : "making the link";
    case "error":
      return "no link";
    case "failed":
      return "the payment did not go through";
    case "closed":
      return "link closed";
  }
}
