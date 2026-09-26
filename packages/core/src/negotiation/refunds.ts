import type { Money, RefundKind } from "../domain/types";

/**
 * What a return or a refund owes, and when (ADR-018 §3.4, §8), as pure functions.
 *
 * - A withdrawal is refunded within 14 days of the customer's notice (CRD art. 13(1)); where goods
 *   have to come back, the business may wait for them or proof of sending, so it is due at the later of
 *   the notice's 14 days and three days after they arrive.
 * - Anything else is due `returns.refundDays` (14 at most) after nothing more has to come back: the
 *   approval, the goods arriving, or the business's own cancellation.
 * - The amount is what was paid for what comes back: the lines named (all of them when none are),
 *   never more than the order's total, and for a booking or a cancellation, what was paid.
 */
const DAY = 86_400_000;

/** Days the business has to refund a withdrawal from the customer's notice (CRD art. 13(1)). */
export const WITHDRAWAL_REFUND_DAYS = 14;
/** Days after goods, or proof of sending them, arrive until a withdrawal's refund is due at the latest. */
export const AFTER_GOODS_DAYS = 3;
/** Days the customer has to send goods back after withdrawing (CRD art. 14(1)); a policy return's default. */
export const SEND_BACK_DAYS = 14;

/** Which kind of return a customer's request is: faulty goods, a withdrawal within the period, or the business's policy. */
export function classifyReturn(
  reasonCode: string | null | undefined,
  withdrawalOpen: boolean,
): Extract<RefundKind, "withdrawal" | "faulty" | "policy"> {
  if (reasonCode === "faulty" || reasonCode === "not_as_described" || reasonCode === "wrong_item") return "faulty";
  return withdrawalOpen ? "withdrawal" : "policy";
}

export interface OrderLike {
  readonly orderedItem: readonly { readonly quantity: number; readonly price: Money }[];
  readonly totalPrice: Money;
  readonly paidAmount?: Money | undefined;
}

/**
 * What a return of these lines owes: each line's price times how many come back (all of them when no
 * lines are named), never more than the order's total or than was paid, when a payment says how much.
 * Null when a line is not one of the order's, or asks for more than was bought.
 */
export function owedForLines(
  order: OrderLike,
  lines: readonly { readonly index: number; readonly quantity: number }[] | undefined,
): Money | null {
  const currency = order.totalPrice.currency;
  let value = 0;
  if (!lines || lines.length === 0) {
    value = order.totalPrice.value;
  } else {
    const seen = new Map<number, number>();
    for (const l of lines) {
      const line = order.orderedItem[l.index];
      const already = seen.get(l.index) ?? 0;
      if (!line || already + l.quantity > line.quantity) return null;
      seen.set(l.index, already + l.quantity);
      value += line.price.value * l.quantity;
    }
  }
  const cap =
    order.paidAmount && order.paidAmount.currency.toUpperCase() === currency.toUpperCase()
      ? Math.min(order.paidAmount.value, order.totalPrice.value)
      : order.totalPrice.value;
  return { value: Math.min(value, cap), currency };
}

/** An earlier return of the same order, neither refused nor dropped: what came back, and what it owed or paid. */
export interface EarlierReturn {
  /** The lines it took back; none named is the whole order. */
  readonly lines?: readonly { readonly index: number; readonly quantity: number }[] | undefined;
  /** What it owes, or, once refunded, what was paid back. */
  readonly money: Money;
}

/**
 * What of an order has not come back by its earlier returns (ADR-018 §3.4): how many of each line are
 * still with the customer, and how much of what was paid has not been owed or paid back already. The
 * same goods never come back twice, and no more is ever owed back than was paid.
 */
export function leftOfOrder(
  order: OrderLike,
  paid: Money | null,
  earlier: readonly EarlierReturn[],
): { readonly quantities: number[]; readonly money: number } {
  const quantities = order.orderedItem.map((l) => l.quantity);
  let money = paid && paid.currency.toUpperCase() === order.totalPrice.currency.toUpperCase() ? paid.value : 0;
  for (const r of earlier) {
    if (!r.lines || r.lines.length === 0) quantities.fill(0);
    else
      for (const l of r.lines) {
        const left = quantities[l.index];
        if (left !== undefined) quantities[l.index] = Math.max(0, left - l.quantity);
      }
    if (r.money.currency.toUpperCase() === order.totalPrice.currency.toUpperCase()) money -= r.money.value;
  }
  return { quantities, money: Math.max(0, money) };
}

/**
 * The lines a new return takes back, given what is left: those named, when every one is still with the
 * customer; else, none named, all that is left (undefined, the whole order, when nothing came back
 * before). Null when there is nothing of what was asked left to return.
 */
export function linesLeft(
  asked: readonly { readonly index: number; readonly quantity: number }[] | undefined,
  left: readonly number[],
  before: boolean,
): { index: number; quantity: number }[] | undefined | null {
  if (asked && asked.length > 0) {
    const taken = new Map<number, number>();
    for (const l of asked) {
      const now = (taken.get(l.index) ?? 0) + l.quantity;
      if (now > (left[l.index] ?? 0)) return null;
      taken.set(l.index, now);
    }
    return [...asked];
  }
  if (!before) return undefined;
  const rest = left.flatMap((quantity, index) => (quantity > 0 ? [{ index, quantity }] : []));
  return rest.length ? rest : null;
}

/** What was paid for an order or a booking: the payment recorded, else its total when it is paid. */
export function paidFor(p: {
  readonly paidAmount?: Money | undefined;
  readonly totalPrice?: Money | undefined;
  readonly paymentRef?: string | undefined;
}): Money | null {
  if (p.paidAmount && p.paidAmount.value > 0) return p.paidAmount;
  if (p.paymentRef && p.totalPrice && p.totalPrice.value > 0) return p.totalPrice;
  return null;
}

export interface DueInput {
  readonly kind: RefundKind;
  /** When the customer told us (a withdrawal's notice). */
  readonly noticeAt?: number | undefined;
  /** When nothing more had to come back: the approval with nothing to return, the business's cancellation. */
  readonly settledAt?: number | undefined;
  /** When the goods, or proof of sending them, arrived. */
  readonly evidenceAt?: number | undefined;
  readonly refundDays: number;
}

/** When the refund is due; null while goods still have to come back. */
export function refundDueOf(i: DueInput): number | null {
  if (i.kind === "withdrawal") {
    const notice = i.noticeAt ?? i.settledAt ?? i.evidenceAt;
    if (notice === undefined) return null;
    const byNotice = notice + WITHDRAWAL_REFUND_DAYS * DAY;
    if (i.evidenceAt !== undefined) return Math.max(byNotice, i.evidenceAt + AFTER_GOODS_DAYS * DAY);
    return i.settledAt !== undefined ? byNotice : null;
  }
  const from = i.evidenceAt ?? i.settledAt;
  return from === undefined ? null : from + i.refundDays * DAY;
}
