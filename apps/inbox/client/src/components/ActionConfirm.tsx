import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import {
  actionNote,
  type ButtonTone,
  inputKindFor,
  isoToLocal,
  localToIso,
  moneyMajor,
  networkNote,
  parseMoney,
  sumLines,
} from "../lib/actions";
import type { ApiProblem } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useSettings } from "../lib/queries";
import type { Item, Money, Transition } from "../lib/types";

/**
 * The confirmation for one transition. It uses the same words as the button, asks only for what
 * the event needs (a time, a quote, a payment reference, an optional note), and shows the API's own
 * sentence when the write is refused.
 */
export function ActionConfirm({
  transition,
  tone,
  item,
  currency,
  pending,
  error,
  showTitle = true,
  onSubmit,
  onCancel,
}: {
  transition: Transition;
  tone: ButtonTone;
  item: Item;
  currency: string;
  pending: boolean;
  error: ApiProblem | null;
  showTitle?: boolean | undefined;
  onSubmit: (input: Record<string, unknown> | undefined) => void;
  onCancel: () => void;
}) {
  const kind = inputKindFor(
    transition.event,
    item.state,
    item.type,
    (item.payload as { change?: { by: string } }).change?.by,
  );
  const settings = useSettings();
  const [local, setLocal] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [askedAtDefault] = useState(() => isoToLocal(new Date().toISOString()));
  const [askedAt, setAskedAt] = useState(askedAtDefault);

  const booking = item.type === "booking" ? item.payload : undefined;
  const [start, setStart] = useState(isoToLocal(booking?.startTime));
  const [end, setEnd] = useState(isoToLocal(booking?.endTime));
  const [price, setPrice] = useState(moneyMajor(booking?.totalPrice));

  const [total, setTotal] = useState("");
  const [validThrough, setValidThrough] = useState("");
  // Changes to an order start from the order as it stands: its lines, their products, its delivery.
  const order = item.type === "order" ? (item.payload.proposed ?? item.payload) : undefined;
  const [lines, setLines] = useState<LineDraft[]>(() =>
    kind === "order_propose" && order
      ? order.orderedItem.map((l, i) => ({
          id: 1_000 + i,
          name: l.name,
          quantity: String(l.quantity),
          price: moneyMajor(l.price),
          ...(l.productId ? { productId: l.productId } : {}),
          ...(l.sku ? { sku: l.sku } : {}),
        }))
      : [],
  );
  const [deliveryWhen, setDeliveryWhen] = useState(isoToLocal(order?.delivery?.when));
  const [notes, setNotes] = useState("");
  const [creates, setCreates] = useState<"order" | "booking">("order");
  const quoteFor = item.type === "quote_request" ? item.payload.requestedFor : undefined;
  const [quoteStart, setQuoteStart] = useState(isoToLocal(quoteFor));
  const [quoteEnd, setQuoteEnd] = useState("");
  const nextId = useRef(1);

  const [returnReason, setReturnReason] = useState("faulty");
  // A return asked for comes back unless the owner lets the customer keep it.
  const refund = item.type === "refund" ? item.payload : undefined;
  const [keepItem, setKeepItem] = useState(refund?.goodsBack === false);
  const [method, setMethod] = useState<"post" | "drop_off" | "collection">("post");
  const [address, setAddress] = useState("");
  const [ref, setRef] = useState("");
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState("");

  const build = (): { ok: true; input: Record<string, unknown> | undefined } | { ok: false; problem: string } => {
    switch (kind) {
      case "none":
        return { ok: true, input: undefined };
      case "note":
      case "agreed":
        return { ok: true, input: note.trim() ? { note: note.trim() } : undefined };
      case "note_required":
        if (!note.trim()) return { ok: false, problem: "Say why, in words for the customer." };
        return { ok: true, input: { note: note.trim() } };
      case "return_approve":
        return {
          ok: true,
          input: keepItem
            ? { goodsBack: false }
            : { goodsBack: true, instructions: { method, ...(address.trim() ? { address: address.trim() } : {}) } },
        };
      case "return_open":
        if (!note.trim()) return { ok: false, problem: "Say what the customer asked, in a few words." };
        return { ok: true, input: { reasonCode: returnReason, note: note.trim() } };
      case "customer_cancel": {
        if (!note.trim()) return { ok: false, problem: "Say what the customer said, in a few words." };
        // Left as it was, it means now, which the server knows to the second.
        const asked = askedAt === askedAtDefault ? undefined : localToIso(askedAt);
        if (askedAt && askedAt !== askedAtDefault && !asked) {
          return { ok: false, problem: "When they asked must be a date and time." };
        }
        return { ok: true, input: { note: note.trim(), ...(asked ? { askedAt: asked } : {}) } };
      }
      case "propose": {
        const startTime = localToIso(start);
        const endTime = localToIso(end);
        if (!startTime || !endTime) return { ok: false, problem: "Add the start and the end time." };
        if (endTime <= startTime) return { ok: false, problem: "The end must come after the start." };
        const totalPrice = price.trim() ? parseMoney(price, currency) : undefined;
        if (price.trim() && !totalPrice) return { ok: false, problem: "The price must be a number, like 45 or 45.90." };
        return {
          ok: true,
          input: {
            startTime,
            endTime,
            ...(totalPrice ? { totalPrice } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        };
      }
      case "order_propose": {
        const parsed: Record<string, unknown>[] = [];
        for (const l of lines.filter((x) => x.name.trim())) {
          const quantity = Number(l.quantity);
          const linePrice = parseMoney(l.price, currency);
          if (!Number.isInteger(quantity) || quantity < 1 || !linePrice) {
            return { ok: false, problem: `Line “${l.name}” needs a whole quantity and a price.` };
          }
          parsed.push({
            ...(l.productId ? { productId: l.productId } : {}),
            ...(l.sku ? { sku: l.sku } : {}),
            name: l.name.trim(),
            quantity,
            price: linePrice,
          });
        }
        if (parsed.length === 0) return { ok: false, problem: "Keep at least one line; to say no, decline instead." };
        const when = deliveryWhen ? localToIso(deliveryWhen) : undefined;
        if (deliveryWhen && !when) return { ok: false, problem: "The delivery date must be a date and time." };
        const valid = validThrough ? localToIso(validThrough) : undefined;
        if (validThrough && !valid) return { ok: false, problem: "Valid through must be a date and time." };
        return {
          ok: true,
          input: {
            orderedItem: parsed,
            ...(when ? { delivery: { method: order?.delivery?.method ?? "delivery", when } } : {}),
            ...(valid ? { validThrough: valid } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        };
      }
      case "quote": {
        const totalPrice = parseMoney(total, currency);
        if (!totalPrice) return { ok: false, problem: "Add the total price, like 89.30." };
        // Left empty, it holds for the hours set in Settings (`negotiation.offerValidHours`).
        const valid = validThrough ? localToIso(validThrough) : undefined;
        if (validThrough && !valid) return { ok: false, problem: "Valid through must be a date and time." };
        const kept = lines.filter((l) => l.name.trim());
        const parsed: { name: string; quantity: number; price: Money }[] = [];
        for (const l of kept) {
          const quantity = Number(l.quantity);
          const linePrice = parseMoney(l.price, currency);
          if (!Number.isInteger(quantity) || quantity < 1 || !linePrice) {
            return { ok: false, problem: `Line “${l.name}” needs a whole quantity and a price.` };
          }
          parsed.push({ name: l.name.trim(), quantity, price: linePrice });
        }
        // A quote that creates a booking is for a time: accepting it books that time.
        const startTime = creates === "booking" ? localToIso(quoteStart) : undefined;
        const endTime = creates === "booking" ? localToIso(quoteEnd) : undefined;
        if (creates === "booking" && !startTime) return { ok: false, problem: "Add the time the booking is for." };
        if (startTime && endTime && endTime <= startTime)
          return { ok: false, problem: "The end must come after the start." };
        return {
          ok: true,
          input: {
            totalPrice,
            ...(valid ? { validThrough: valid } : {}),
            lines: parsed,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            creates,
            ...(startTime ? { startTime } : {}),
            ...(endTime ? { endTime } : {}),
          },
        };
      }
      case "payment": {
        if (!ref.trim()) return { ok: false, problem: "Add the payment reference, like the transaction id." };
        const paid = amount.trim() ? parseMoney(amount, currency) : undefined;
        if (amount.trim() && !paid) return { ok: false, problem: "The amount must be a number, like 89.30." };
        return { ok: true, input: { paymentRef: ref.trim(), ...(paid ? { amount: paid } : {}) } };
      }
      case "payment_request": {
        if (!url.trim()) return { ok: true, input: undefined };
        try {
          const u = new URL(url.trim());
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
          return { ok: true, input: { paymentUrl: u.toString() } };
        } catch {
          return { ok: false, problem: "The payment link must be a full address, like https://pay.example/abc." };
        }
      }
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const built = build();
    if (!built.ok) {
      setLocal(built.problem);
      return;
    }
    setLocal(null);
    onSubmit(built.input);
  };

  const linesTotal = sumLines(
    lines.flatMap((l) => {
      const p = parseMoney(l.price, currency);
      const q = Number(l.quantity);
      return p && Number.isInteger(q) && q > 0 ? [{ name: l.name, quantity: q, price: p }] : [];
    }),
    currency,
  );
  const problem = local ?? error?.detail ?? null;
  const consequence = networkNote(transition.event, item);
  const meaning = actionNote(transition.event, item, (iso) => formatDateTime(iso), {
    minNoticeMin: settings.data?.doc.booking.minNoticeMin ?? 0,
    now: Date.now(),
  });

  return (
    <form className="confirm row-glass" onSubmit={submit}>
      {showTitle && <h3>{transition.label}</h3>}
      {meaning && <p className="hint">{meaning}</p>}
      {consequence && <p className="hint">{consequence}</p>}

      {kind === "agreed" && (
        <div>
          <label className="label" htmlFor="act-note">
            How did they agree? <span className="opt">· optional</span>
          </label>
          <textarea id="act-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="hint">For your records; the customer does not see it.</div>
        </div>
      )}

      {kind === "customer_cancel" && (
        <div className="grid2">
          <div className="wide">
            <label className="label" htmlFor="act-note">
              What did they say?
            </label>
            <textarea
              id="act-note"
              className="input"
              rows={2}
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="hint">For your records; the customer does not see it.</div>
          </div>
          <div>
            <label className="label" htmlFor="act-asked">
              When did they ask?
            </label>
            <input
              id="act-asked"
              className="input"
              type="datetime-local"
              value={askedAt}
              onChange={(e) => setAskedAt(e.target.value)}
            />
          </div>
        </div>
      )}

      {kind === "note_required" && (
        <div>
          <label className="label" htmlFor="act-note">
            {transition.event === "dispute_goods" ? "What came back?" : "Why?"}
          </label>
          <textarea
            id="act-note"
            className="input"
            rows={3}
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="hint">The customer receives this, in your words.</div>
        </div>
      )}

      {kind === "return_approve" && (
        <div className="grid2">
          <div className="wide">
            <label className="label" htmlFor="act-keep">
              <input id="act-keep" type="checkbox" checked={keepItem} onChange={(e) => setKeepItem(e.target.checked)} />{" "}
              They keep it: refund without it coming back
            </label>
          </div>
          {!keepItem && (
            <>
              <div>
                <label className="label" htmlFor="act-method">
                  How it comes back
                </label>
                <select
                  id="act-method"
                  className="input"
                  value={method}
                  onChange={(e) =>
                    setMethod(
                      e.target.value === "drop_off"
                        ? "drop_off"
                        : e.target.value === "collection"
                          ? "collection"
                          : "post",
                    )
                  }
                >
                  <option value="post">By post</option>
                  <option value="drop_off">They bring it</option>
                  <option value="collection">You collect it</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="act-address">
                  Where to <span className="opt">· optional</span>
                </label>
                <input
                  id="act-address"
                  className="input"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="hint wide">The customer is told how and by when to send it; the refund follows it.</div>
        </div>
      )}

      {kind === "return_open" && (
        <div className="grid2">
          <div>
            <label className="label" htmlFor="act-reason">
              Why are they sending it back?
            </label>
            <select
              id="act-reason"
              className="input"
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
            >
              <option value="faulty">It is faulty</option>
              <option value="not_as_described">Not as described</option>
              <option value="wrong_item">Wrong item</option>
              <option value="changed_mind">Changed their mind</option>
              <option value="other">Something else</option>
            </select>
          </div>
          <div className="wide">
            <label className="label" htmlFor="act-note">
              What did they say?
            </label>
            <textarea
              id="act-note"
              className="input"
              rows={2}
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="hint">For your records; the customer does not see it.</div>
          </div>
        </div>
      )}

      {kind === "note" && (
        <div>
          <label className="label" htmlFor="act-note">
            {transition.event === "request_info" ? "What do you need to know?" : "A word for the customer"}{" "}
            <span className="opt">· optional</span>
          </label>
          <textarea id="act-note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="hint">The customer receives this with the update.</div>
        </div>
      )}

      {kind === "propose" && (
        <div className="grid2">
          <div>
            <label className="label" htmlFor="act-start">
              Starts
            </label>
            <input
              id="act-start"
              className="input"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="act-end">
              Ends
            </label>
            <input
              id="act-end"
              className="input"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="act-price">
              Price ({currency}) <span className="opt">· optional</span>
            </label>
            <input
              id="act-price"
              className="input"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="wide">
            <label className="label" htmlFor="act-propose-note">
              A word for the customer <span className="opt">· optional</span>
            </label>
            <textarea
              id="act-propose-note"
              className="input"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="hint wide">
            Times are in your local time zone. The customer accepts it, declines it or picks another time, from our
            email or their assistant.
          </div>
        </div>
      )}

      {(kind === "quote" || kind === "order_propose") && (
        <>
          <div className="lines">
            {lines.map((l) => (
              <div className="line" key={l.id}>
                <div>
                  <label className="label" htmlFor={`line-name-${l.id}`}>
                    Line
                  </label>
                  <input
                    id={`line-name-${l.id}`}
                    className="input"
                    value={l.name}
                    onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)))}
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`line-qty-${l.id}`}>
                    Qty
                  </label>
                  <input
                    id={`line-qty-${l.id}`}
                    className="input"
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) =>
                      setLines(lines.map((x) => (x.id === l.id ? { ...x, quantity: e.target.value } : x)))
                    }
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`line-price-${l.id}`}>
                    Price ({currency})
                  </label>
                  <input
                    id={`line-price-${l.id}`}
                    className="input"
                    inputMode="decimal"
                    value={l.price}
                    onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, price: e.target.value } : x)))}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove line ${l.name || ""}`.trim()}
                  onClick={() => setLines(lines.filter((x) => x.id !== l.id))}
                >
                  <X className="icon" aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className="rowx">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setLines([...lines, { id: nextId.current++, name: "", quantity: "1", price: "" }])}
              >
                <Plus className="icon" aria-hidden="true" />
                Add a line
              </button>
              {kind === "quote" && lines.length > 0 && linesTotal.value > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTotal(moneyMajor(linesTotal))}>
                  Lines add up to {formatMoney(linesTotal)} · use it
                </button>
              )}
              {kind === "order_propose" && <span className="hint">Total {formatMoney(linesTotal)}</span>}
            </div>
          </div>
          {kind === "order_propose" && (
            <div className="grid2">
              <div>
                <label className="label" htmlFor="act-delivery">
                  Delivery <span className="opt">· optional</span>
                </label>
                <input
                  id="act-delivery"
                  className="input"
                  type="datetime-local"
                  value={deliveryWhen}
                  onChange={(e) => setDeliveryWhen(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="act-order-valid">
                  Valid through <span className="opt">· optional</span>
                </label>
                <input
                  id="act-order-valid"
                  className="input"
                  type="datetime-local"
                  value={validThrough}
                  onChange={(e) => setValidThrough(e.target.value)}
                />
              </div>
              <div className="wide">
                <label className="label" htmlFor="act-order-note">
                  A word for the customer <span className="opt">· optional</span>
                </label>
                <textarea
                  id="act-order-note"
                  className="input"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="hint wide">
                The customer accepts the changes, declines them (the order closes) or tells you what they would change.
                Left empty, it holds for {settings.data?.doc.negotiation?.offerValidHours ?? 48} hours.
              </div>
            </div>
          )}
          {kind === "quote" && (
            <div className="grid2">
              <div>
                <label className="label" htmlFor="act-total">
                  Total ({currency})
                </label>
                <input
                  id="act-total"
                  className="input"
                  inputMode="decimal"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="act-valid">
                  Valid through <span className="opt">· optional</span>
                </label>
                <input
                  id="act-valid"
                  className="input"
                  type="datetime-local"
                  value={validThrough}
                  onChange={(e) => setValidThrough(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="act-creates">
                  Accepting creates
                </label>
                <select
                  id="act-creates"
                  className="input"
                  value={creates}
                  onChange={(e) => setCreates(e.target.value === "booking" ? "booking" : "order")}
                >
                  <option value="order">An order</option>
                  <option value="booking">A booking</option>
                </select>
              </div>
              {creates === "booking" && (
                <>
                  <div>
                    <label className="label" htmlFor="act-quote-start">
                      For the time
                    </label>
                    <input
                      id="act-quote-start"
                      className="input"
                      type="datetime-local"
                      value={quoteStart}
                      onChange={(e) => setQuoteStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="act-quote-end">
                      Until <span className="opt">· optional</span>
                    </label>
                    <input
                      id="act-quote-end"
                      className="input"
                      type="datetime-local"
                      value={quoteEnd}
                      onChange={(e) => setQuoteEnd(e.target.value)}
                    />
                  </div>
                  <div className="hint wide">
                    When the customer accepts, this time is booked and confirmed. The end defaults to the service's
                    length.
                  </div>
                </>
              )}
              <div className="wide">
                <label className="label" htmlFor="act-notes">
                  Notes for the customer <span className="opt">· optional</span>
                </label>
                <textarea
                  id="act-notes"
                  className="input"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
          )}
        </>
      )}

      {kind === "payment" && (
        <div className="grid2">
          <div>
            <label className="label" htmlFor="act-ref">
              Payment reference
            </label>
            <input
              id="act-ref"
              className="input"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="Transaction id"
            />
          </div>
          <div>
            <label className="label" htmlFor="act-amount">
              Amount ({currency}) <span className="opt">· optional</span>
            </label>
            <input
              id="act-amount"
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>
      )}

      {kind === "payment_request" && (
        <div>
          <label className="label" htmlFor="act-url">
            Payment link <span className="opt">· optional</span>
          </label>
          <input
            id="act-url"
            className="input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
          />
          <div className="hint">Sent to the customer with the request.</div>
        </div>
      )}

      {problem && (
        <p className="hint error" role="alert">
          {problem}
        </p>
      )}

      <div className="rowx">
        <button type="submit" className={clsx("btn", `btn-${tone}`)} disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {transition.label}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Keep as is
        </button>
      </div>
    </form>
  );
}

interface LineDraft {
  readonly id: number;
  readonly name: string;
  readonly quantity: string;
  readonly price: string;
  /** The catalogue product the line is, when it is one: kept as the line changes. */
  readonly productId?: string;
  readonly sku?: string;
}
