import clsx from "clsx";
import { Check, Copy, CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { formatDateTime, formatMoney, methodName } from "../lib/format";
import { useProposeShopTotal } from "../lib/queries";
import type { PaymentView } from "../lib/types";

/**
 * An order's payment through the business's own Stripe or Mollie account (ADR-023), the one place it
 * shows: the link it was sent and what the platform said, in a line or two. Where the money is, the
 * owner refunds it: the payment's own page in their dashboard. A link that is closed is never shown;
 * earlier links (the total changed, a payment failed) fold into one quiet count. An order that could
 * have a link and has none says why, in one quiet line. A link held because the business's own shop
 * counts another total (ADR-030) says so, with the one thing to do: propose the shop's total.
 */
export function Payments({
  itemId,
  payments,
  none,
  tz,
}: {
  itemId: string;
  payments: readonly PaymentView[];
  none: string | null;
  tz: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const propose = useProposeShopTotal(itemId);
  if (payments.length === 0 && !none) return null;
  const shown = payments.filter((p) => p.state !== "closed" && p.state !== "failed");
  const earlier = payments.length - shown.length;
  const list = shown.length > 0 ? shown : payments.slice(0, 1);
  return (
    <div className="stack receipts payments">
      <div className="eyebrow">Payment</div>
      {payments.length === 0 && none && <p className="hint">{none}</p>}
      {list.length > 0 && (
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
                  aria-label={copied ? "Link copied" : "Copy the link to pay"}
                  title={copied ? "Copied" : "Copy the link to pay"}
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
              {(p.error || p.note) && p.state !== "held" && (
                <span
                  className={clsx("hint", p.state === "error" && "error")}
                  role={p.state === "error" ? "alert" : undefined}
                >
                  {p.error ?? p.note}
                </span>
              )}
              {p.state === "held" && (
                <span className="hint">
                  {p.propose_shop_total
                    ? "Your shop adds tax or delivery. Send the customer its total; the link goes once they accept."
                    : `Check the order's prices and taxes in ${p.provider}, then ask for payment again.`}
                </span>
              )}
              {p.state === "held" && p.propose_shop_total && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={propose.isPending || propose.isSuccess}
                  onClick={() => propose.mutate()}
                >
                  {propose.isSuccess ? "Proposed" : propose.isPending ? "Proposing…" : "Propose the shop's total"}
                </button>
              )}
              {p.state === "held" && propose.error && (
                <span className="hint error" role="alert">
                  {problemOf(propose.error).detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {earlier > 0 && shown.length > 0 && (
        <p className="hint">
          {earlier === 1 ? "An earlier link was closed." : `${earlier} earlier links were closed.`}
        </p>
      )}
    </div>
  );
}

/**
 * On a refund the inbox owes for an order paid through the platform: where to make it, the payment's
 * own page in the business's dashboard. Nothing to type: once refunded there, one click records it.
 */
export function RefundAt({ payment, owed }: { payment: PaymentView; owed: string }) {
  if (!payment.dashboard_url) return null;
  return (
    <p className="hint refund-at">
      <a className="int-link" href={payment.dashboard_url} target="_blank" rel="noopener noreferrer">
        Refund {owed} in {payment.provider}
        <ExternalLink className="icon-xs" aria-hidden="true" />
      </a>
    </p>
  );
}

function wordsOf(p: PaymentView): string {
  switch (p.state) {
    case "paid":
      return `paid ${formatMoney(p.paid_amount ?? p.amount)}${p.method ? ` by ${methodName(p.method)}` : ""}`;
    case "open":
      return `waiting for ${formatMoney(p.amount)}`;
    case "held":
      return `not sent: it counts ${formatMoney(p.shop_total ?? p.amount)}, not ${formatMoney(p.amount)}`;
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
