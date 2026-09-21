import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import {
  type ButtonTone,
  inputKindFor,
  isoToLocal,
  localToIso,
  moneyMajor,
  parseMoney,
  sumLines,
} from "../lib/actions";
import type { ApiProblem } from "../lib/api";
import { formatMoney } from "../lib/format";
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
  const kind = inputKindFor(transition.event);
  const [local, setLocal] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const booking = item.type === "booking" ? item.payload : undefined;
  const [start, setStart] = useState(isoToLocal(booking?.startTime));
  const [end, setEnd] = useState(isoToLocal(booking?.endTime));
  const [price, setPrice] = useState(moneyMajor(booking?.totalPrice));

  const [total, setTotal] = useState("");
  const [validThrough, setValidThrough] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [creates, setCreates] = useState<"order" | "booking">("order");
  const nextId = useRef(1);

  const [ref, setRef] = useState("");
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState("");

  const build = (): { ok: true; input: Record<string, unknown> | undefined } | { ok: false; problem: string } => {
    switch (kind) {
      case "none":
        return { ok: true, input: undefined };
      case "note":
        return { ok: true, input: note.trim() ? { note: note.trim() } : undefined };
      case "propose": {
        const startTime = localToIso(start);
        const endTime = localToIso(end);
        if (!startTime || !endTime) return { ok: false, problem: "Add the start and the end time." };
        if (endTime <= startTime) return { ok: false, problem: "The end must come after the start." };
        const totalPrice = price.trim() ? parseMoney(price, currency) : undefined;
        if (price.trim() && !totalPrice) return { ok: false, problem: "The price must be a number, like 45 or 45.90." };
        return { ok: true, input: { startTime, endTime, ...(totalPrice ? { totalPrice } : {}) } };
      }
      case "quote": {
        const totalPrice = parseMoney(total, currency);
        if (!totalPrice) return { ok: false, problem: "Add the total price, like 89.30." };
        const valid = localToIso(validThrough);
        if (!valid) return { ok: false, problem: "Add the date the quote is valid through." };
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
        return {
          ok: true,
          input: {
            totalPrice,
            validThrough: valid,
            lines: parsed,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            creates,
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

  return (
    <form className="confirm row-glass" onSubmit={submit}>
      {showTitle && <h3>{transition.label}</h3>}

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
          <div className="hint wide">
            Times are in your local time zone. The customer accepts or declines the proposal.
          </div>
        </div>
      )}

      {kind === "quote" && (
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
              {lines.length > 0 && linesTotal.value > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTotal(moneyMajor(linesTotal))}>
                  Lines add up to {formatMoney(linesTotal)} · use it
                </button>
              )}
            </div>
          </div>
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
                Valid through
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
}
