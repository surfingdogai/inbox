import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { capitalise, channelWord, formatAddress, formatDateTime, formatMoney, formatWhen } from "../lib/format";
import type { Item, ItemOf, Money } from "../lib/types";

/** The typed card body: the facts of the payload, per type, then how and when it arrived. */
export function Fields({ item, tz }: { item: Item; tz: string | undefined }) {
  return (
    <>
      {item.type === "order" && <Lines lines={item.payload.orderedItem} total={item.payload.totalPrice} />}
      <dl className="fields">
        <Typed item={item} tz={tz} />
        <F label="Via">{capitalise(channelWord(item.channel).replace(/^(the|a|an) /, ""))}</F>
        <F label="Received">{formatDateTime(item.createdAt, tz)}</F>
      </dl>
      <Reference id={item.id} />
      {item.type === "quote_request" && item.payload.quote && <QuoteBlock quote={item.payload.quote} tz={tz} />}
    </>
  );
}

function F({
  label,
  children,
  wide,
  prose,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean | undefined;
  prose?: boolean | undefined;
}) {
  return (
    <div className={wide ? "wide" : undefined}>
      <dt>{label}</dt>
      <dd className={prose ? "prose" : undefined}>{children}</dd>
    </div>
  );
}

function Typed({ item, tz }: { item: Item; tz: string | undefined }) {
  switch (item.type) {
    case "booking":
      return <BookingFields item={item} tz={tz} />;
    case "order":
      return <OrderFields item={item} tz={tz} />;
    case "quote_request":
      return <QuoteFields item={item} tz={tz} />;
    case "message":
      return (
        <F label="Message" wide prose>
          {item.payload.text}
        </F>
      );
    case "refund":
      return <RefundFields item={item} />;
  }
}

function BookingFields({ item, tz }: { item: ItemOf<"booking">; tz: string | undefined }) {
  const p = item.payload;
  return (
    <>
      <F label="When">{formatWhen(p.startTime, p.endTime, tz)}</F>
      {p.proposed && (
        <F label="Proposed instead">
          {formatWhen(p.proposed.startTime, p.proposed.endTime, tz)}
          {p.proposed.totalPrice ? ` · ${formatMoney(p.proposed.totalPrice)}` : ""}
        </F>
      )}
      <F label="Service">{p.reservationFor.name}</F>
      {p.totalPrice && <F label="Price">{formatMoney(p.totalPrice)}</F>}
      {p.partySize !== undefined && <F label="Party size">{p.partySize}</F>}
      {p.notes && (
        <F label="Notes" wide prose>
          {p.notes}
        </F>
      )}
    </>
  );
}

function OrderFields({ item, tz }: { item: ItemOf<"order">; tz: string | undefined }) {
  const p = item.payload;
  const shipTo = formatAddress(p.shippingAddress);
  const billTo = formatAddress(p.billingAddress);
  const payment = [p.paymentMethod, p.paymentRef ? `ref ${p.paymentRef}` : undefined].filter(Boolean).join(" · ");
  return (
    <>
      {p.delivery && (
        <F label="Delivery">
          {capitalise(p.delivery.method)}
          {p.delivery.when ? ` · ${formatDateTime(p.delivery.when, tz)}` : ""}
        </F>
      )}
      {payment && <F label="Payment">{payment}</F>}
      {p.paymentUrl && (
        <F label="Payment link">
          <a href={p.paymentUrl} target="_blank" rel="noreferrer">
            {p.paymentUrl}
          </a>
        </F>
      )}
      {shipTo && <F label="Ship to">{shipTo}</F>}
      {billTo && <F label="Bill to">{billTo}</F>}
      {p.notes && (
        <F label="Notes" wide prose>
          {p.notes}
        </F>
      )}
    </>
  );
}

function QuoteFields({ item, tz }: { item: ItemOf<"quote_request">; tz: string | undefined }) {
  const p = item.payload;
  const deliverTo = formatAddress(p.deliveryAddress);
  return (
    <>
      <F label="Item">
        {p.itemOffered.name}
        {p.itemOffered.sku ? ` · ${p.itemOffered.sku}` : ""}
      </F>
      {p.quantity !== undefined && <F label="Quantity">{p.quantity}</F>}
      {p.budget && <F label="Budget">{formatMoney(p.budget)}</F>}
      {p.requestedFor && <F label="Requested for">{formatDateTime(p.requestedFor, tz)}</F>}
      {deliverTo && <F label="Deliver to">{deliverTo}</F>}
      <F label="Description" wide prose>
        {p.description}
      </F>
    </>
  );
}

function RefundFields({ item }: { item: ItemOf<"refund"> }) {
  const p = item.payload;
  return (
    <>
      <F label="Amount">{formatMoney(p.amount)}</F>
      <F label="For order">
        <Link to="/items/$id" params={{ id: p.orderItemId }} search={(prev) => prev} className="mono">
          {p.orderItemId}
        </Link>
      </F>
      <F label="Reason" wide prose>
        {p.reason}
      </F>
    </>
  );
}

function QuoteBlock({
  quote,
  tz,
}: {
  quote: NonNullable<ItemOf<"quote_request">["payload"]["quote"]>;
  tz: string | undefined;
}) {
  return (
    <div className="stack">
      <div className="eyebrow">Your quote</div>
      {quote.lines.length > 0 && <Lines lines={quote.lines} total={quote.totalPrice} />}
      <dl className="fields quote-fields">
        <F label="Total">{formatMoney(quote.totalPrice)}</F>
        <F label="Valid through">{formatDateTime(quote.validThrough, tz)}</F>
        <F label="Accepting creates">{quote.creates === "booking" ? "A booking" : "An order"}</F>
        {quote.notes && (
          <F label="Notes" wide prose>
            {quote.notes}
          </F>
        )}
      </dl>
    </div>
  );
}

/** Money and times line up: a three-column grid with the total under a hairline. */
export function Lines({
  lines,
  total,
}: {
  lines: readonly { name: string; quantity: number; price: Money; sku?: string | undefined }[];
  total: Money;
}) {
  const seen = new Map<string, number>();
  return (
    <div className="money">
      {lines.map((l) => {
        const base = `${l.sku ?? ""}|${l.name}|${l.quantity}|${l.price.value}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return (
          <Fragment key={`${base}#${n}`}>
            <span>{l.name}</span>
            <span>{l.quantity} ×</span>
            <span>{formatMoney(l.price)}</span>
          </Fragment>
        );
      })}
      <span className="tot">Total</span>
      <span className="tot" />
      <span className="tot">{formatMoney(total)}</span>
    </div>
  );
}

/** The item's id, for emails and receipts: small, monospace, one click to copy. */
function Reference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(id).then(() => setCopied(true));
  };
  return (
    <div className="card-ref">
      <span>Reference</span>
      <span className="mono">{id}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
