import type { Statement } from "@surfingdog/platform";
import { eq, inArray } from "drizzle-orm";
import { businessFacts } from "../customer/audience";
import { copyFor, vars } from "../customer/copy";
import type { Audience } from "../customer/describe";
import type { Db } from "../db";
import type { Item, ItemType, Money, PayloadOf, RefundKind } from "../domain/types";
import { ulid } from "../ids";
import type { Transition } from "../machine/machine";
import { lawOf } from "../negotiation/holidays";
import {
  classifyReturn,
  type EarlierReturn,
  leftOfOrder,
  linesLeft,
  owedForLines,
  paidFor,
  refundDueOf,
  SEND_BACK_DAYS,
} from "../negotiation/refunds";
import { ORDER_SENT, type WithdrawalRight, withdrawalRight } from "../negotiation/withdrawal";
import { items, products, services } from "../schema/tables";
import type { Settings } from "../settings/schema";
import { actorMeta, type Caller } from "./caller";
import { eventStatement, jobStatement, webhookFanoutStatement } from "./common";
import { WriteError } from "./errors";
import { rowToItem } from "./views";

/**
 * Returns and withdrawals on the write path (ADR-018 §3.4, §7): whether the customer may withdraw
 * from a booking or an order as it stands, and the `refund` item a transition makes — a withdrawal, a
 * return asked for, a paid order cancelled — written in that transition's batch.
 */
const DAY = 86_400_000;

/** The events of an order or a booking that end in a refund of what was paid, or a return. */
const WITHDRAWALS: ReadonlySet<string> = new Set(["withdraw", "record_withdrawal"]);

/**
 * Whether the customer may withdraw from a booking or an order at `at`, and until when: a consumer
 * (unless the business sells only to businesses), nothing on it excepted, a booking paid for and not
 * begun, within the period counted from delivery (goods) or the booking (a service).
 */
export async function withdrawalOf(
  db: Db,
  item: Item,
  settings: Settings,
  at: number,
  /** The business's own return policy instead of the law: the same period, for any customer. */
  opts: { readonly policy?: boolean } = {},
): Promise<WithdrawalRight> {
  if (item.type !== "booking" && item.type !== "order") return { available: false, until: null, why: "not_agreed" };
  const facts = await businessFacts(db, settings);
  const [flags, concludedAt, fulfilledAt] = await Promise.all([
    flagsOf(db, item),
    concludedAtOf(db, item),
    item.type === "order" && ORDER_SENT.has(item.state) ? fulfilledAtOf(db, item) : Promise.resolve(null),
  ]);
  const p = item.payload as { paymentRef?: string; paidAmount?: Money; deliveredAt?: string; startTime?: string };
  return withdrawalRight({
    type: item.type,
    state: item.state,
    consumer: opts.policy === true || settings.commerce.customers !== "businesses",
    flags,
    paid: p.paymentRef !== undefined || (p.paidAmount?.value ?? 0) > 0,
    ...(item.type === "booking" ? { startTime: Date.parse(item.payload.startTime) } : {}),
    period: {
      kind: item.type === "booking" ? "service" : "goods",
      concludedAt,
      deliveredAt: p.deliveredAt ? Date.parse(p.deliveredAt) : null,
      fulfilledAt,
      days: settings.returns.days,
      assumedTransitDays: settings.returns.assumedTransitDays,
      law: lawOf(settings.commerce.legal.country),
      timezone: facts.timezone,
    },
    now: at,
  });
}

/**
 * Why the customer cannot withdraw now, in their language when they asked, else for the business: the
 * words `withdrawal_open` refuses with. The customer's own door never shows it: it passes what they
 * asked to a person instead (`capabilities/customer.ts`).
 */
export function withdrawalRefusal(right: WithdrawalRight, type: string, audience: Audience | undefined): string {
  if (audience)
    return copyFor(audience.lang).returns.problems.noWithdrawal(
      vars({ yourNoun: copyFor(audience.lang).yourNoun[type as ItemType] }),
    );
  switch (right.why) {
    case "business_customer":
      return "you sell to businesses only (commerce.customers), and a business has no right of withdrawal";
    case "excepted":
      return `what was bought is excepted from withdrawal (${right.exception}): record the customer's cancellation instead, if you agree to it`;
    case "not_paid":
      return "nothing was paid for this booking, so it is a reservation to cancel, not a contract to withdraw from: record the customer's cancellation";
    case "started":
      return "the booking has begun: settle what is left with the customer";
    case "lapsed":
      return `the period to withdraw ended ${right.until !== null ? new Date(right.until).toISOString() : ""}: record the customer's cancellation, or open a return, if you agree to it`;
    default:
      return `there is no agreed ${type} to withdraw from: the customer cancels a request`;
  }
}

function flagsOf(db: Db, item: Item): Promise<string[]> {
  return item.type === "booking" || item.type === "order"
    ? withdrawalFlagsOf(db, item.type, item.payload)
    : Promise.resolve([]);
}

/** Each line's, or the service's, withdrawal flag from the catalogue; a line naming no product is standard. */
export async function withdrawalFlagsOf(
  db: Db,
  type: "booking" | "order",
  payload: Record<string, unknown> | PayloadOf<"booking"> | PayloadOf<"order">,
): Promise<string[]> {
  if (type === "booking") {
    const serviceId = (payload as PayloadOf<"booking">).reservationFor.serviceId;
    const [s] = await db.orm
      .select({ withdrawal: services.withdrawal })
      .from(services)
      .where(inArray(services.id, [serviceId]));
    return [s?.withdrawal ?? "standard"];
  }
  const lines = (payload as PayloadOf<"order">).orderedItem;
  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const skus = [...new Set(lines.flatMap((l) => (!l.productId && l.sku ? [l.sku] : [])))];
  const out: string[] = [];
  // At most 90 values an `IN (…)`: D1 binds at most a hundred.
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db.orm
      .select({ withdrawal: products.withdrawal })
      .from(products)
      .where(inArray(products.id, ids.slice(i, i + 90)));
    out.push(...rows.map((r) => r.withdrawal));
  }
  for (let i = 0; i < skus.length; i += 90) {
    const rows = await db.orm
      .select({ withdrawal: products.withdrawal })
      .from(products)
      .where(inArray(products.sku, skus.slice(i, i + 90)));
    out.push(...rows.map((r) => r.withdrawal));
  }
  return out;
}

/** When the contract was made: the booking first confirmed, the order first accepted (or paid); else when it was asked for. */
async function concludedAtOf(db: Db, item: Item): Promise<number> {
  const states = item.type === "booking" ? ["confirmed"] : ["accepted", "awaiting_payment", "paid", "fulfilling"];
  const { rows } = await db.client.query({
    sql: `SELECT MIN(created_at) FROM item_events WHERE item_id = ? AND to_state IN (${states.map(() => "?").join(", ")})`,
    params: [item.id, ...states],
    method: "all",
  });
  const at = rows[0]?.[0];
  return at === null || at === undefined ? Date.parse(item.createdAt) : Number(at);
}

/** When the order was marked fulfilled: what the payload says, else its first `fulfil` event. */
async function fulfilledAtOf(db: Db, item: Extract<Item, { type: "order" }>): Promise<number | null> {
  if (item.payload.fulfilledAt) return Date.parse(item.payload.fulfilledAt);
  const { rows } = await db.client.query({
    sql: "SELECT MIN(created_at) FROM item_events WHERE item_id = ? AND event = 'fulfil'",
    params: [item.id],
    method: "all",
  });
  const at = rows[0]?.[0];
  return at === null || at === undefined ? Date.parse(item.updatedAt) : Number(at);
}

/**
 * Whether the customer asked for this return while they could still withdraw (ADR-018 §7): a consumer,
 * nothing excepted, within the period at the moment they told us. Then the goods may come back
 * whatever reason they gave (faulty, not as described, their policy's), so nobody refuses the return.
 */
export async function askedWithinRight(db: Db, refund: Item, settings: Settings): Promise<boolean> {
  if (refund.type !== "refund") return false;
  const [row] = await db.orm.select().from(items).where(eq(items.id, refund.payload.orderItemId));
  if (!row) return false;
  const linked = rowToItem(row);
  if (linked.type !== "order" && linked.type !== "booking") return false;
  const notice = refund.payload.noticeAt ? Date.parse(refund.payload.noticeAt) : Date.parse(refund.createdAt);
  return (await withdrawalOf(db, linked, settings, notice)).available;
}

/** A return of this order or booking still being dealt with, if any. */
export async function openReturnOf(db: Db, itemId: string): Promise<{ id: string; state: string } | null> {
  const { rows } = await db.client.query({
    sql: `SELECT id, state FROM items WHERE type = 'refund' AND linked_item_id = ?
            AND state IN ('requested', 'approved', 'goods_received') ORDER BY created_at DESC LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  return r ? { id: String(r[0]), state: String(r[1]) } : null;
}

/**
 * Whether a charge-back on this order should close its promise against the customer: not while a
 * return of it is open, nor after one we refunded late (ADR-018 §8) — the customer took their money
 * back by the only way we left them.
 */
export async function chargeBackExcused(db: Db, orderId: string): Promise<boolean> {
  if (await openReturnOf(db, orderId)) return true;
  // Every refunded return, not the first few: a customer's dropped returns must not hide a late one.
  const { rows } = await db.client.query({
    sql: `SELECT json_extract(payload, '$.refundDue'), closed_at FROM items
           WHERE type = 'refund' AND linked_item_id = ? AND state = 'refunded' AND closed_at IS NOT NULL`,
    params: [orderId],
    method: "all",
  });
  return rows.some((r) => {
    const due = typeof r[0] === "string" ? Date.parse(r[0]) : Number.NaN;
    return Number.isFinite(due) && Number(r[1]) > due;
  });
}

/**
 * The returns of an order that took goods back or owe money, neither refused nor dropped: what each
 * took back, and what it owes or, once refunded, paid back (ADR-018 §3.4). All of them: each takes at
 * least one thing back, so they are as many as the order had things at most.
 */
export async function earlierReturnsOf(db: Db, orderId: string, exceptId = ""): Promise<EarlierReturn[]> {
  const { rows } = await db.client.query({
    sql: `SELECT state, payload FROM items
           WHERE type = 'refund' AND linked_item_id = ? AND id <> ? AND state NOT IN ('rejected', 'cancelled')`,
    params: [orderId, exceptId],
    method: "all",
  });
  return rows.map((r) => {
    const p = (typeof r[1] === "string" ? JSON.parse(r[1]) : r[1]) as PayloadOf<"refund">;
    const money = r[0] === "refunded" && p.paidAmount ? p.paidAmount : p.amount;
    return { ...(p.lines?.length ? { lines: p.lines } : {}), money };
  });
}

/** What the refund item a transition makes is: its kind, where it starts, what it owes, what comes back. */
export interface RefundPlan {
  readonly kind: RefundKind;
  readonly state: "requested" | "approved";
  readonly payload: Record<string, unknown>;
  /** The customer hears of it by an email of its own (a return asked for, goods to send back). */
  readonly acknowledge: boolean;
}

/**
 * The refund a transition of an order or a booking makes, or null when there is none: nothing was
 * paid, so nothing is owed back and nothing comes back.
 */
export async function refundFor(o: {
  readonly db: Db;
  readonly item: Item;
  readonly t: Transition;
  readonly data: Record<string, unknown>;
  readonly settings: Settings;
  readonly now: number;
  /** When the customer told us: a recorded withdrawal's moment. */
  readonly noticeAt: number;
  /** The customer, when it is theirs: why nothing more can come back, in their words. */
  readonly audience?: Audience | undefined;
}): Promise<RefundPlan | null> {
  const { item, t, data, settings, now } = o;
  const iso = (ms: number) => new Date(ms).toISOString();
  const notice = iso(o.noticeAt);
  const due = (kind: RefundKind, settledAt: number) =>
    refundDueOf({ kind, noticeAt: o.noticeAt, settledAt, refundDays: settings.returns.refundDays });
  const note = typeof data.note === "string" && data.note.trim() ? data.note.trim().slice(0, 2_000) : undefined;
  const orderItemId = item.id;
  if (item.type === "booking") {
    const paid = paidFor(item.payload);
    if (!paid) return null;
    // The business cancelled a booking that was paid for: owed back by its refund days, nothing to return.
    if (t.event === "cancel_by_business") {
      const refundDue = now + settings.returns.refundDays * DAY;
      return {
        kind: "cancellation",
        state: "approved",
        acknowledge: false,
        payload: {
          orderItemId,
          amount: paid,
          kind: "cancellation",
          noticeAt: notice,
          goodsBack: false,
          refundDue: iso(refundDue),
        },
      };
    }
    if (!WITHDRAWALS.has(t.event)) return null;
    const refundDue = due("withdrawal", now);
    return {
      kind: "withdrawal",
      state: "approved",
      acknowledge: false,
      payload: {
        orderItemId,
        amount: paid,
        kind: "withdrawal",
        noticeAt: notice,
        goodsBack: false,
        ...(refundDue !== null ? { refundDue: iso(refundDue) } : {}),
      },
    };
  }
  if (item.type !== "order") return null;
  const order = item.payload;
  const paid = paidFor(order);
  const sent = ORDER_SENT.has(item.state);
  const zero: Money = { value: 0, currency: order.totalPrice.currency };
  const asked = data.lines as { index: number; quantity: number }[] | undefined;
  /**
   * What comes back, and what it owes: only what is still with the customer — the same goods never
   * come back twice — for what was paid for it, and never more than is left of what was paid once
   * earlier returns are counted. Nothing paid (on delivery, on account), nothing owed.
   */
  const goodsBack = async (): Promise<{ lines: { index: number; quantity: number }[] | undefined; amount: Money }> => {
    if (!owedForLines(order, asked)) {
      throw new WriteError("invalid_input", "Name lines of the order, and no more of each than was bought.", {
        fields: [
          { path: "input.lines", problem: "invalid", message: `the order has ${order.orderedItem.length} lines` },
        ],
      });
    }
    const earlier = await earlierReturnsOf(o.db, item.id);
    const left = leftOfOrder(order, paid, earlier);
    const lines = linesLeft(asked, left.quantities, earlier.length > 0);
    if (lines === null) {
      throw new WriteError(
        "guard_failed",
        o.audience
          ? copyFor(o.audience.lang).returns.problems.alreadyBack
          : "What this names has already come back and been dealt with: there is nothing more of it to return.",
        { details: { guard: "nothing_to_return", left: left.quantities } },
      );
    }
    if (!paid) return { lines, amount: zero };
    const owed = owedForLines({ ...order, paidAmount: paid }, lines) ?? zero;
    return { lines, amount: { value: Math.min(owed.value, left.money), currency: owed.currency } };
  };
  if (WITHDRAWALS.has(t.event)) {
    if (!sent) {
      // Before the goods went out: what was paid comes back, and nothing has to.
      if (!paid) return null;
      const refundDue = due("withdrawal", now);
      return {
        kind: "withdrawal",
        state: "approved",
        acknowledge: false,
        payload: {
          orderItemId,
          amount: paid,
          kind: "withdrawal",
          noticeAt: notice,
          goodsBack: false,
          ...(refundDue !== null ? { refundDue: iso(refundDue) } : {}),
        },
      };
    }
    // After: the goods come back within 14 days of the notice, and the refund follows them.
    const back = await goodsBack();
    return {
      kind: "withdrawal",
      state: "approved",
      acknowledge: true,
      payload: {
        orderItemId,
        amount: back.amount,
        kind: "withdrawal",
        reasonCode: "changed_mind",
        ...(back.lines?.length ? { lines: back.lines } : {}),
        noticeAt: notice,
        goodsBack: true,
        returnBy: iso(o.noticeAt + SEND_BACK_DAYS * DAY),
        ...(note ? { reason: note } : {}),
      },
    };
  }
  if (t.event === "request_return" || t.event === "open_return") {
    const reasonCode = String(data.reasonCode);
    const right = await withdrawalOf(o.db, item, settings, o.noticeAt);
    const kind = classifyReturn(reasonCode, right.available);
    const wants = data.wants as string | undefined;
    // A withdrawal within the period nobody may refuse: agreed from the start, as `withdraw` is.
    const agreed = kind === "withdrawal";
    const back = await goodsBack();
    return {
      kind,
      state: agreed ? "approved" : "requested",
      acknowledge: true,
      payload: {
        orderItemId,
        amount: back.amount,
        kind,
        reasonCode,
        ...(back.lines?.length ? { lines: back.lines } : {}),
        ...(wants ? { wants } : {}),
        noticeAt: notice,
        goodsBack: true,
        ...(agreed ? { returnBy: iso(o.noticeAt + SEND_BACK_DAYS * DAY) } : {}),
        ...(note ? { reason: note } : {}),
      },
    };
  }
  if (t.event === "cancel" || t.event === "record_cancel") {
    if (!paid) return null;
    // The business cancelled what was paid for: owed at once. The customer cancelled: theirs to ask back.
    const ours = t.event === "cancel";
    const refundDue = ours ? now + settings.returns.refundDays * DAY : null;
    return {
      kind: ours ? "cancellation" : "policy",
      state: ours ? "approved" : "requested",
      acknowledge: false,
      payload: {
        orderItemId,
        amount: paid,
        kind: ours ? "cancellation" : "policy",
        noticeAt: notice,
        goodsBack: false,
        ...(refundDue !== null ? { refundDue: iso(refundDue) } : {}),
        ...(note && !ours ? { reason: note } : {}),
      },
    };
  }
  return null;
}

/**
 * The refund item, in the batch of the transition that makes it (the `planLinkedItem` pattern): the
 * order's or booking's customer — its party, its access token, the identity columns and the
 * presentations — so it reads and answers as the same person, linked to it, with its own `create`
 * event caused by the transition's.
 */
export function refundStatements(o: {
  readonly caller: Caller;
  readonly item: Item;
  readonly plan: RefundPlan;
  readonly causationId: string;
  readonly now: number;
  readonly webhooks: boolean;
}): { id: string; eventId: string; statements: Statement[] } {
  const { caller, item, plan, now } = o;
  const id = ulid();
  const eventId = ulid();
  const subject = item.subject ?? "Refund request";
  const statements: Statement[] = [
    {
      sql: `INSERT INTO items (id, type, state, version, party_id, location_id, channel, subject, linked_item_id, access_token_hash, payload, flags,
              agent_thumbprint, agent_level, agent_directory, customer_match, possible_party_id, created_at, updated_at, closed_at)
            SELECT ?, 'refund', ?, 1, o.party_id, o.location_id, ?, ?, o.id, o.access_token_hash, ?, ?,
                   o.agent_thumbprint, o.agent_level, o.agent_directory, o.customer_match, o.possible_party_id, ?, ?, NULL
              FROM items o WHERE o.id = ?`,
      params: [
        id,
        plan.state,
        caller.actor.channel,
        subject,
        JSON.stringify(plan.payload),
        // A return asked for waits for a person; the rest is the business's to settle in time.
        JSON.stringify({ ...item.flags, needsHuman: plan.state === "requested" }),
        now,
        now,
        item.id,
      ],
      method: "run",
    },
    eventStatement({
      id: eventId,
      itemId: id,
      seq: 1,
      event: "create",
      fromState: null,
      toState: plan.state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: `from ${item.type} ${item.id}`,
      meta: { channel: caller.actor.channel, tier: caller.tier, kind: plan.kind, ...actorMeta(caller) },
      causationId: o.causationId,
      depth: 1,
      now,
    }),
    // The customer each network presented for the order is the customer of its refund.
    {
      sql: `INSERT OR IGNORE INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at)
            SELECT ?, network, presentation_id, ppid, person, created_at FROM item_presentations WHERE item_id = ?`,
      params: [id, item.id],
      method: "run",
    },
    jobStatement("rules", { itemId: id, eventId, trigger: "item.created" }, now, { dedupeKey: `rules:${eventId}` }),
  ];
  if (plan.acknowledge) {
    statements.push(
      jobStatement("notify", { to: "customer", itemId: id, event: "create", eventId }, now, {
        dedupeKey: `notify:${eventId}:customer`,
      }),
    );
  }
  if (o.webhooks) statements.push(webhookFanoutStatement({ id: eventId, type: "refund.create", itemId: id }, now));
  return { id, eventId, statements };
}
