import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import {
  capitalise,
  channelWord,
  formatAddress,
  formatDateTime,
  formatMoney,
  formatWhen,
  methodName,
  RETURN_KIND,
} from "../lib/format";
import type { Item, ItemOf, Money } from "../lib/types";
import { StayFields, StayQuoteBlock, StayQuoteComposer } from "./Stay";

/**
 * What the payment platform holds of an order (ADR-023): shown once, in its own block, so the fields
 * leave out its payment reference and its link.
 */
export interface PlatformPayment {
  /** The order's payment link is the platform's. */
  readonly linkIsOurs: boolean;
  /** The platform's id for the payment the order was marked paid with. */
  readonly paidRef: string | null;
}

/** The typed card body: the facts of the payload, per type, then how and when it arrived. */
export function Fields({
  item,
  tz,
  platform,
}: {
  item: Item;
  tz: string | undefined;
  platform?: PlatformPayment | undefined;
}) {
  return (
    <>
      {item.type === "order" && <Lines lines={item.payload.orderedItem} total={item.payload.totalPrice} />}
      <dl className="fields">
        <Typed item={item} tz={tz} platform={platform} />
      </dl>
      {item.type === "quote_request" && item.payload.quote && <QuoteBlock quote={item.payload.quote} tz={tz} />}
      {item.type === "stay" && item.payload.quote && <StayQuoteBlock quote={item.payload.quote} tz={tz} />}
      {item.type === "stay" && item.state === "requested" && <StayQuoteComposer item={item} />}
    </>
  );
}

/** How and when it arrived, and the reference: folded away until needed. */
export function Details({ item, tz }: { item: Item; tz: string | undefined }) {
  return (
    <details className="details">
      <summary>Details</summary>
      <dl className="fields">
        <F label="Via">{capitalise(channelWord(item.channel).replace(/^(the|a|an) /, ""))}</F>
        <F label="Received">{formatDateTime(item.createdAt, tz)}</F>
        <F label="Reference" wide>
          <Reference id={item.id} />
        </F>
      </dl>
    </details>
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

function Typed({ item, tz, platform }: { item: Item; tz: string | undefined; platform?: PlatformPayment | undefined }) {
  switch (item.type) {
    case "booking":
      return <BookingFields item={item} tz={tz} />;
    case "order":
      return <OrderFields item={item} tz={tz} platform={platform} />;
    case "quote_request":
      return <QuoteFields item={item} tz={tz} />;
    case "message":
      return (
        <F label="Message" wide prose>
          {item.payload.text}
        </F>
      );
    case "refund":
      return <RefundFields item={item} tz={tz} />;
    case "stay":
      return <StayFields item={item} tz={tz} />;
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
      {p.customerStatedPrice && <F label="Customer suggested">{formatMoney(p.customerStatedPrice)}</F>}
      {p.partySize !== undefined && <F label="Party size">{p.partySize}</F>}
      {p.notes && (
        <F label="Notes" wide prose>
          {p.notes}
        </F>
      )}
    </>
  );
}

function OrderFields({
  item,
  tz,
  platform,
}: {
  item: ItemOf<"order">;
  tz: string | undefined;
  platform?: PlatformPayment | undefined;
}) {
  const p = item.payload;
  const shipTo = formatAddress(p.shippingAddress);
  const billTo = formatAddress(p.billingAddress);
  // Paid through the platform, or asked to pay at its link: its own block says so, once.
  const byPlatform = platform?.paidRef != null && platform.paidRef === p.paymentRef;
  const payment = byPlatform
    ? ""
    : [p.paymentMethod ? methodName(p.paymentMethod) : undefined, p.paymentRef ? `ref ${p.paymentRef}` : undefined]
        .filter(Boolean)
        .join(" · ");
  const link = platform?.linkIsOurs ? undefined : p.paymentUrl;
  return (
    <>
      {p.customerStatedPrice && (
        <F label="Customer suggested">{formatMoney(p.customerStatedPrice)} for the whole order</F>
      )}
      {p.delivery && (
        <F label="Delivery">
          {capitalise(p.delivery.method)}
          {p.delivery.when ? ` · ${formatDateTime(p.delivery.when, tz)}` : ""}
        </F>
      )}
      {payment && <F label="Payment">{payment}</F>}
      {link && (
        <F label="Payment link">
          <a href={link} target="_blank" rel="noreferrer">
            {link}
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

function RefundFields({ item, tz }: { item: ItemOf<"refund">; tz: string | undefined }) {
  const p = item.payload;
  return (
    <>
      <F label="What">{RETURN_KIND[p.kind ?? "policy"] ?? "Return"}</F>
      <F label="Owed">{formatMoney(p.amount)}</F>
      <F label="For">
        <Link to="/items/$id" params={{ id: p.orderItemId }} search={(prev) => prev} className="mono">
          {p.orderItemId}
        </Link>
      </F>
      {p.lines?.length ? <F label="Lines">{p.lines.map((l) => `#${l.index + 1} × ${l.quantity}`).join(", ")}</F> : null}
      {p.goodsBack && p.returnBy && <F label="Send back by">{formatDateTime(p.returnBy, tz)}</F>}
      {p.evidenceAt && <F label="Goods back">{formatDateTime(p.evidenceAt, tz)}</F>}
      {p.refundDue && <F label="Refund due by">{formatDateTime(p.refundDue, tz)}</F>}
      {p.paidAmount && <F label="Refunded">{formatMoney(p.paidAmount)}</F>}
      {p.disputed && (
        <F label="Not what we sold" wide prose>
          {p.disputed.note}
        </F>
      )}
      {p.reason && (
        <F label="Reason" wide prose>
          {p.reason}
        </F>
      )}
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
      <span className="mono">{id}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
