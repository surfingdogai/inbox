import { BadgeCheck, Check, Copy, ReceiptText } from "lucide-react";
import { useState } from "react";
import { formatDateTime, formatMoney, receiptWord } from "../lib/format";
import type { Receipt } from "../lib/types";

/**
 * The receipts an item has earned: what was attested, when, and whether the customer's agent has
 * counter-signed. The JWS itself is one click to copy, for an owner who wants to show it to a
 * network or a verifier; nothing here is editable, a receipt is issued once and kept.
 */
export function Receipts({ receipts, tz }: { receipts: readonly Receipt[]; tz: string | undefined }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (receipts.length === 0) return null;
  const copy = (r: Receipt) => {
    void navigator.clipboard.writeText(r.jws).then(() => setCopied(r.id));
  };
  return (
    <div className="stack receipts">
      <div className="eyebrow">Receipts</div>
      <ul className="receipt-list">
        {receipts.map((r) => (
          <li className="receipt" key={r.id}>
            <ReceiptText className="icon" aria-hidden="true" />
            <span className="what">
              <b>{receiptWord(r)}</b>
              {r.payload.amt ? ` · ${formatMoney(r.payload.amt)}` : ""}
              {r.payload.pay ? ` · ${r.payload.pay}` : ""}
            </span>
            <time className="when" dateTime={r.issued_at}>
              {formatDateTime(r.issued_at, tz)}
            </time>
            {r.acknowledged_at ? (
              <span
                className="pill tint-success pill-xs"
                title={`Counter-signed ${formatDateTime(r.acknowledged_at, tz)}`}
              >
                <BadgeCheck className="icon-xs" aria-hidden="true" />
                Both sides hold it
              </span>
            ) : (
              <span className="pill pill-xs">Issued, not yet counter-signed</span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={copied === r.id ? "Receipt copied" : "Copy the signed receipt"}
              onClick={() => copy(r)}
            >
              {copied === r.id ? (
                <Check className="icon-xs" aria-hidden="true" />
              ) : (
                <Copy className="icon-xs" aria-hidden="true" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
