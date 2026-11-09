import type { Statement } from "@surfingdog/platform";
import type { ReturnPolicy } from "@surfingdog/spec";
import { eq, inArray } from "drizzle-orm";
import { loadPolicies } from "../catalogue/policies";
import { businessFacts } from "../customer/audience";
import {
  copyFor,
  type ExceptionWords,
  type LineReturnTold,
  type LineTold,
  vars,
  withdrawalCopy,
} from "../customer/copy";
import type { Audience } from "../customer/describe";
import type { Db } from "../db";
import type { Item, ItemType, Money, PayloadOf, RefundKind, ReturnTerms, WithdrawalFlag } from "../domain/types";
import { ulid } from "../ids";
import type { Transition } from "../machine/machine";
import { contractLawOf, type Law } from "../negotiation/holidays";
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
import {
  contractAgreed,
  exceptionOf,
  ORDER_SENT,
  type WithdrawalRight,
  withdrawalRight,
} from "../negotiation/withdrawal";
import { items, products, returnPolicies, services } from "../schema/tables";
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

/** Lines of an order, by index, as a return or a withdrawal names them (`{ index, quantity }`). */
type NamedLines = readonly { readonly index: number; readonly quantity?: number }[] | undefined;

/**
 * Whether the customer may withdraw from a booking or an order at `at`, and until when: a consumer
 * (unless the business sells only to businesses), nothing on it excepted, a booking paid for and not
 * begun, within the period counted from delivery (goods) or the booking (a service), under the law the
 * contract was made under (`contractLawOf`). Once an order's goods went out, `lines` judges only the
 * lines coming back: an excepted line keeps the others from nothing (CRD art. 16 excepts goods, not
 * orders). Under another country's law (`other`) there is no such right; asked of the business's own
 * policy there, it is what the customer was told of returning those lines (`payload.returnTerms`): an
 * excepted line never, else the days the owner's written policy gave, and nothing where none was told.
 */
export async function withdrawalOf(
  db: Db,
  item: Item,
  settings: Settings,
  at: number,
  opts: {
    /** The business's own return policy instead of the law (the owner's AI approving inside it), for any customer. */
    readonly policy?: boolean;
    /** The lines coming back, once the goods went out; all of them when none are named. */
    readonly lines?: NamedLines;
  } = {},
): Promise<WithdrawalRight> {
  if (item.type !== "booking" && item.type !== "order") return { available: false, until: null, why: "not_agreed" };
  const law = contractLawOf(settings.commerce.legal.country, item);
  // Under another country's law no right is claimed, and nothing more needs reading to say so.
  if (law === "other" && opts.policy !== true)
    return { available: false, until: null, why: contractAgreed(item.type, item.state) ? "other_law" : "not_agreed" };
  const facts = await businessFacts(db, settings);
  // Before the goods went out a withdrawal ends the whole order, so every line counts.
  const lines =
    item.type === "order"
      ? namedLines(item.payload.orderedItem, ORDER_SENT.has(item.state) ? opts.lines : undefined)
      : undefined;
  const [judged, concludedAt, fulfilledAt] = await Promise.all([
    item.type === "booking"
      ? Promise.all([
          withdrawalFlagsOf(db, "booking", item.payload),
          law === "other" ? 0 : withdrawalDaysOf(db, "booking", item.payload, settings),
        ]).then(([flags, days]) => ({ flags, days }))
      : law === "other"
        ? toldOf(db, item.payload.returnTerms, lines ?? [])
        : Promise.all([
            lineFlagsOf(db, lines ?? []),
            withdrawalDaysOf(db, "order", { orderedItem: lines ?? [] }, settings),
          ]).then(([flags, days]) => ({ flags, days })),
    concludedAtOf(db, item),
    item.type === "order" && ORDER_SENT.has(item.state) ? fulfilledAtOf(db, item) : Promise.resolve(null),
  ]);
  const { flags, days } = judged;
  const p = item.payload as { paymentRef?: string; paidAmount?: Money; deliveredAt?: string; startTime?: string };
  return withdrawalRight({
    type: item.type,
    state: item.state,
    consumer: opts.policy === true || settings.commerce.customers !== "businesses",
    flags,
    paid: p.paymentRef !== undefined || (p.paidAmount?.value ?? 0) > 0,
    ...(item.type === "booking" ? { startTime: Date.parse(item.payload.startTime) } : {}),
    ...(opts.policy === true ? { policy: true } : {}),
    period: {
      kind: item.type === "booking" ? "service" : "goods",
      concludedAt,
      deliveredAt: p.deliveredAt ? Date.parse(p.deliveredAt) : null,
      fulfilledAt,
      days,
      assumedTransitDays: settings.returns.assumedTransitDays,
      law,
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
  if (audience && right.why === "other_law")
    return withdrawalCopy(audience.lang, "other").noRight(
      vars({ yourNoun: copyFor(audience.lang).yourNoun[type as ItemType] }),
    );
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
    case "other_law":
      return "this contract was made while your business's country (commerce.legal.country) was outside the EU, the EEA, Gibraltar and the UK, so no right of withdrawal is claimed for it: record the customer's cancellation, or open a return under your policy, if you agree to it";
    case "lapsed":
      return `the period to withdraw ended ${right.until !== null ? new Date(right.until).toISOString() : ""}: record the customer's cancellation, or open a return, if you agree to it`;
    default:
      return `there is no agreed ${type} to withdraw from: the customer cancels a request`;
  }
}

/** How long "unlimited" is held to here: ten years, past any order anyone returns. */
const UNLIMITED_DAYS = 3650;

/**
 * The days a refund stays open on every line of an order by the return policies the business publishes
 * (`GET /v1/catalogue/policies`): each line's product's own, else the default; the fewest of them, so
 * each line is inside its own. A policy without a refund (an exchange, store credit) or with no returns
 * gives none, and the settings' `returns.days` and the law's 14 days stand, as they always do.
 */
export async function publishedRefundDays(
  db: Db,
  payload: Record<string, unknown> | PayloadOf<"order">,
  settings: Settings,
): Promise<number> {
  const lines = (payload as PayloadOf<"order">).orderedItem ?? [];
  if (!lines.length) return 0;
  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const named = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db.orm
      .select({ id: products.id, policy: products.returnPolicyId })
      .from(products)
      .where(inArray(products.id, ids.slice(i, i + 90)));
    for (const r of rows) named.set(r.id, r.policy);
  }
  const { return_policies } = await loadPolicies(db, settings);
  const fallback = return_policies.find((p) => p.default);
  let fewest = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const own = l.productId ? named.get(l.productId) : null;
    fewest = Math.min(fewest, refundDaysOf(own ? return_policies.find((p) => p.id === own) : fallback));
  }
  return Number.isFinite(fewest) ? fewest : 0;
}

/** The days a return policy keeps a refund open: its window, ten years for unlimited, none without a refund. */
function refundDaysOf(p: Pick<ReturnPolicy, "eligibility" | "window_days" | "resolutions"> | undefined): number {
  if (!p?.resolutions.includes("refund")) return 0;
  if (p.eligibility === "unlimited") return UNLIMITED_DAYS;
  return p.eligibility === "window" ? (p.window_days ?? 0) : 0;
}

/**
 * The days a customer has to withdraw or return, as they are told it and as it is held: the settings'
 * `returns.days`, and for an order never shorter than the refund window its products' published return
 * policies give (`publishedRefundDays`), so what an agent read in the policies document is what holds.
 */
export async function withdrawalDaysOf(
  db: Db,
  type: string,
  payload: Record<string, unknown> | PayloadOf<"order"> | PayloadOf<"booking">,
  settings: Settings,
): Promise<number> {
  if (type !== "order") return settings.returns.days;
  return Math.max(settings.returns.days, await publishedRefundDays(db, payload as PayloadOf<"order">, settings));
}

type OrderLine = PayloadOf<"order">["orderedItem"][number];

/** The lines a return or a withdrawal names, from the order's own; every line when it names none. */
export function namedLines(lines: readonly OrderLine[], named: NamedLines): OrderLine[] {
  if (!named?.length) return [...lines];
  const out: OrderLine[] = [];
  for (const n of named) {
    const l = lines[n.index];
    if (l && !out.includes(l)) out.push(l);
  }
  // Naming none of its lines judges the order as a whole, as the write that follows refuses it.
  return out.length ? out : [...lines];
}

/**
 * The key what a line was told of returns is kept under (`payload.returnTerms`): its product's id, else
 * `sku:` and its sku, else "" for a line naming neither, which is judged as standard under the default
 * return policy. Kept by the line it is for rather than its place, so a change to the order's lines keeps it.
 */
export function returnKeyOf(line: {
  readonly productId?: string | undefined;
  readonly sku?: string | undefined;
}): string {
  return (line.productId ?? (line.sku ? `sku:${line.sku}` : "")).slice(0, 120);
}

/** The catalogue products an order's lines name, by id and by sku, for their flags and their return policies. */
async function productsOf(
  db: Db,
  lines: readonly OrderLine[],
): Promise<{
  readonly byId: Map<string, { withdrawal: string; policy: string | null }>;
  readonly bySku: Map<string, { withdrawal: string; policy: string | null }>;
}> {
  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const skus = [...new Set(lines.flatMap((l) => (!l.productId && l.sku ? [l.sku] : [])))];
  const byId = new Map<string, { withdrawal: string; policy: string | null }>();
  const bySku = new Map<string, { withdrawal: string; policy: string | null }>();
  const columns = {
    id: products.id,
    sku: products.sku,
    withdrawal: products.withdrawal,
    policy: products.returnPolicyId,
  };
  // At most 90 values an `IN (…)`: D1 binds at most a hundred.
  for (let i = 0; i < ids.length; i += 90) {
    for (const r of await db.orm
      .select(columns)
      .from(products)
      .where(inArray(products.id, ids.slice(i, i + 90))))
      byId.set(r.id, { withdrawal: r.withdrawal, policy: r.policy });
  }
  for (let i = 0; i < skus.length; i += 90) {
    for (const r of await db.orm
      .select(columns)
      .from(products)
      .where(inArray(products.sku, skus.slice(i, i + 90))))
      if (r.sku !== null && !bySku.has(r.sku)) bySku.set(r.sku, { withdrawal: r.withdrawal, policy: r.policy });
  }
  return { byId, bySku };
}

/** Each line's withdrawal flag from the catalogue, in the order's own order: its product's, else standard. */
export async function lineFlagsOf(db: Db, lines: readonly OrderLine[]): Promise<string[]> {
  const { byId, bySku } = await productsOf(db, lines);
  return lines.map(
    (l) => (l.productId ? byId.get(l.productId) : l.sku ? bySku.get(l.sku) : undefined)?.withdrawal ?? "standard",
  );
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
  return lineFlagsOf(db, (payload as PayloadOf<"order">).orderedItem);
}

/**
 * What each line of an order made under another country's law is told of returns, where no right of
 * withdrawal is claimed (ADR-018 Amendment 7), by `returnKeyOf`: a line excepted by its withdrawal flag
 * (`perishable` and the rest) cannot be returned; else the return policy the owner wrote for its product,
 * or the default one, gives its window's days or `unlimited`; else nothing is told. The standard policy
 * that only follows the settings (`follows_settings`, or stands in for an empty table) is not the owner's
 * to have written, and a policy of no returns, or without a refund, says nothing. What `kept` told
 * already stands, whatever the policies say now: only the lines it does not cover are judged.
 */
export async function returnTermsOf(
  db: Db,
  lines: readonly OrderLine[],
  kept?: ReturnTerms | undefined,
): Promise<ReturnTerms> {
  const out: Record<string, ReturnTerms[string]> = { ...(kept ?? {}) };
  const wanted = lines.filter((l) => !Object.hasOwn(out, returnKeyOf(l)));
  if (!wanted.length) return out;
  const [{ byId, bySku }, written] = await Promise.all([
    productsOf(db, wanted),
    db.orm
      .select({ id: returnPolicies.id, isDefault: returnPolicies.isDefault, terms: returnPolicies.terms })
      .from(returnPolicies)
      .where(eq(returnPolicies.followsSettings, 0)),
  ]);
  const policies = new Map(written.map((r) => [r.id, r.terms as Omit<ReturnPolicy, "id" | "name" | "default">]));
  const fallback = written.find((r) => r.isDefault === 1)?.id;
  for (const l of wanted) {
    const p = l.productId ? byId.get(l.productId) : l.sku ? bySku.get(l.sku) : undefined;
    const exception = exceptionOf([p?.withdrawal]);
    if (exception) {
      out[returnKeyOf(l)] = { exception: exception as Exclude<WithdrawalFlag, "standard"> };
      continue;
    }
    // A line's own policy names it by its product's id; a line by sku alone, or none, has the default.
    const named = l.productId ? (p?.policy ?? null) : null;
    const days = refundDaysOf(named ? policies.get(named) : fallback ? policies.get(fallback) : undefined);
    out[returnKeyOf(l)] = days >= UNLIMITED_DAYS ? { days: "unlimited" } : days > 0 ? { days } : {};
  }
  return out;
}

/**
 * Under another country's law, what `lines` were told of returns, as `withdrawalRight` asks of the
 * policy: the exceptions among them, and the fewest days told for the rest (none where one was told
 * nothing). An order from before this was recorded is judged by the policies as they stand.
 */
async function toldOf(
  db: Db,
  recorded: ReturnTerms | undefined,
  lines: readonly OrderLine[],
): Promise<{ flags: string[]; days: number }> {
  const told = await returnTermsOf(db, lines, recorded);
  const flags: string[] = [];
  let fewest = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const t = told[returnKeyOf(l)] ?? {};
    if (t.exception) {
      flags.push(t.exception);
      continue;
    }
    flags.push("standard");
    fewest = Math.min(fewest, t.days === "unlimited" ? UNLIMITED_DAYS : (t.days ?? 0));
  }
  return { flags, days: Number.isFinite(fewest) ? fewest : UNLIMITED_DAYS };
}

/** What a line was told of returns (`ReturnTerms`), as `lineReturnSentences` says it. */
function toldOfTerms(t: ReturnTerms[string] | undefined): LineReturnTold {
  if (t?.exception) return { kind: "except", exception: t.exception };
  return t?.days !== undefined ? { kind: "policy", days: t.days } : { kind: "none" };
}

/**
 * What each line of an order is told of returning it (`lineReturnSentences`), before it binds and in its
 * confirmations: under another country's law what it was told, or would be (`payload.returnTerms`, else
 * the owner's written policies as they stand); else the law's right, or the exception its withdrawal flag
 * makes (ADR-018 §7, Amendment 7).
 */
export async function toldLinesOf(db: Db, payload: PayloadOf<"order">, law: Law): Promise<LineTold[]> {
  const lines = payload.orderedItem;
  if (law === "other") {
    const terms = await returnTermsOf(db, lines, payload.returnTerms);
    return lines.map((l) => ({ name: l.name, quantity: l.quantity, told: toldOfTerms(terms[returnKeyOf(l)]) }));
  }
  const flags = await lineFlagsOf(db, lines);
  return lines.map((l, i) => {
    const exception = exceptionOf([flags[i]]);
    return {
      name: l.name,
      quantity: l.quantity,
      told: exception ? { kind: "except", exception: exception as keyof ExceptionWords } : { kind: "right" },
    };
  });
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
  return (await withdrawalOf(db, linked, settings, notice, { lines: refund.payload.lines })).available;
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
    // Judged on the lines coming back: an excepted line keeps the others from nothing.
    const right = await withdrawalOf(o.db, item, settings, o.noticeAt, { lines: asked });
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
