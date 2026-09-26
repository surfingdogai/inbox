import type { Statement } from "@surfingdog/platform";
import { slotOffered } from "../capabilities/availability";
import { businessFacts } from "../customer/audience";
import {
  businessTimeTerms,
  changeTerms,
  type OfferLine,
  type OfferTerms,
  orderOfferTerms,
  promiseTerms,
  quoteOfferTerms,
} from "../customer/offer";
import type { Db } from "../db";
import type { Item, Money, PayloadOf, Personalised } from "../domain/types";
import { identityContext } from "../identity/context";
import { ulid } from "../ids";
import type { Transition } from "../machine/machine";
import { amountsHeld, amountsIn, discountIn, speltAmountIn } from "../negotiation/amounts";
import { BREACHES, type Breach, checkAccept, checkOffer, type LimitLine } from "../negotiation/limits";
import { nextRound, type OfferRow, openOf } from "../negotiation/offers";
import { rewardsOf } from "../negotiation/rewards";
import type { Settings } from "../settings/schema";
import { actorMeta, type Caller } from "./caller";
import {
  eventStatement,
  hasActiveWebhook,
  idempotencyStatement,
  jobStatement,
  threadEntryStatement,
  webhookFanoutStatement,
} from "./common";
import { dearer, lastBusinessOffer } from "./offers";
import {
  type LinePricing,
  linePricing,
  orderPersonalised,
  type PricingFor,
  sameMoney,
  servicePricing,
  withoutStatedPrices,
} from "./pricing";
import type { ItemView } from "./views";

/**
 * The owner's limits where the write path meets them (ADR-018 §4): what automation — the owner's AI,
 * a rule, another system's key without `money:write` — offers or accepts, judged by
 * `negotiation/limits.ts` against the catalogue's prices for this customer, the owner's floors and
 * rewards, what the customer asked, and what we said before. Outside them an offer becomes a draft for
 * a person (`draftStatements`), never sent and never refused; an acceptance is refused.
 */

/** The owner's rewards and this customer's standing, so the item's catalogue lines are priced as theirs. */
export async function pricingForItem(db: Db, item: Item, settings: Settings): Promise<PricingFor | undefined> {
  const rewards = rewardsOf(settings.negotiation.rewards);
  if (rewards.length === 0) return undefined;
  const who = await identityContext(db, item, settings);
  return { rewards, standing: { customer: who.customer, person: who.person } };
}

const DAY = 86_400_000;

/** The customer's own price for each product, when their open offer is a price they suggested below ours. */
function counteredPrices(rows: readonly OfferRow[]): { total: number | null; byProduct: Map<string, number> } {
  const open = openOf(rows);
  const byProduct = new Map<string, number>();
  if (open?.by !== "customer") return { total: null, byProduct };
  for (const l of open.terms.lines ?? []) if (l.productId) byProduct.set(l.productId, l.price.value);
  return { total: open.terms.totalPrice?.value ?? null, byProduct };
}

/** The customer's price for a line, when it is below ours: a counter. */
const below = (theirs: number | undefined, ours: number): number | null =>
  theirs !== undefined && theirs < ours ? theirs : null;

/** A line's personalised mark: the list price beside a lower price chosen for this customer. */
function listed(price: Money, list: Money | null): { listPrice?: Money } {
  return list && price.currency.toUpperCase() === list.currency.toUpperCase() && price.value < list.value
    ? { listPrice: list }
    : {};
}

export interface OfferJudgement {
  readonly breaches: Breach[];
  /**
   * The words the offer carries to the customer as automation wrote them, beyond its note: the names of
   * lines the catalogue does not name so. They name only money we offer, like the note.
   */
  readonly words: string[];
}

/**
 * What automation's offer is outside of (ADR-018 §4), with the offer as the transition leaves it in
 * `payload` — a time we propose, changes to an order, a quote, a change to what was agreed. Prices
 * each catalogue line at the customer's price on the way: a line automation writes at the list price,
 * for a customer who earned a reward, is theirs at P (it has not chosen a price: the inbox has), and a
 * price below the list carries the notice (`personalised`). `data` is kept in step, as the draft's input.
 */
export async function judgeOffer(o: {
  readonly db: Db;
  readonly item: Item;
  readonly rows: readonly OfferRow[];
  readonly t: Transition;
  readonly payload: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly settings: Settings;
  /** The request holds a price the business did not set (`unpriced` at its create). */
  readonly customerPriced: boolean;
}): Promise<OfferJudgement> {
  const { db, item, rows, t, payload, data, settings } = o;
  const pricing = await pricingForItem(db, item, settings);
  const round = nextRound(rows, "business");
  const countered = counteredPrices(rows);
  const last = lastBusinessOffer(rows);
  const lines: LimitLine[] = [];
  let custom = false;
  let customerPriced = false;
  let timeShiftMin: number | null = null;
  let timeNotOffered = false;
  let delayDays: number | null = null;
  let worse = false;
  const words: string[] = [];
  const change = t.change === true;

  if (item.type === "booking" && (t.event === "propose" || t.event === "propose_change")) {
    const b = item.payload;
    const offered = (change ? payload.change : payload.proposed) as
      | { startTime: string; endTime: string; totalPrice?: Money; personalised?: Personalised }
      | undefined;
    if (offered) {
      const sp = await servicePricing(db, b.reservationFor.serviceId, b.partySize, pricing);
      const length = Date.parse(offered.endTime) - Date.parse(offered.startTime);
      const agreedLength = Date.parse(b.endTime) - Date.parse(b.startTime);
      // Longer than the service (or than what was agreed) is a price the list does not cover.
      if (!sp || length > sp.durationMin * 60_000 || (change && length > agreedLength)) custom = true;
      // Named by automation, or kept: what the booking holds (what was agreed, for a change).
      const named = change ? data.totalPrice !== undefined : offered.totalPrice !== undefined;
      // What automation names at our list price is the customer's own price, when they earned one.
      if (named && offered.totalPrice && sp?.list && sp.customer && sameMoney(offered.totalPrice, sp.list)) {
        offered.totalPrice = sp.customer;
        data.totalPrice = sp.customer;
      }
      // The price the customer would be offered: the one named, else the one the booking holds.
      const price = offered.totalPrice ?? b.totalPrice;
      if (price) {
        if (!sp?.list || !sp.customer) {
          custom = true;
          if (!named && o.customerPriced) customerPriced = true;
        }
        // A price the customer's request set, kept by leaving ours out: not the business's (Q5).
        else if (!named && o.customerPriced) customerPriced = true;
        else if (change && !named) {
          // What was agreed, kept: not a new price, whatever it was.
        } else {
          const theirs = countered.total;
          lines.push({
            price: price.value,
            quantity: 1,
            list: sp.list.value,
            customer: sp.customer.value,
            floor: sp.floor,
            // A price of their own below ours is a counter automation takes or leaves, never answers with another.
            countered: !change && theirs !== null && theirs < sp.customer.value ? theirs : null,
          });
        }
        // Any price below the list that automation puts to the customer was chosen for them — a reward,
        // or their own price taken by proposing another time at it, named or kept — and carries the
        // notice (ADR-018 §5; CRD art. 6(1)(ea)).
        if (!change && sp?.list && !customerPriced) {
          const mark = listed(price, sp.list);
          if (mark.listPrice) {
            const says = sp.reward?.says && sp.customer && sameMoney(price, sp.customer) ? sp.reward.says : undefined;
            offered.personalised = { listPrice: mark.listPrice, ...(says ? { says } : {}) };
          } else delete offered.personalised;
        }
        // Never dearer than what was agreed (a change) or than what we last offered (a negotiation).
        if (change && named && b.totalPrice && price.value > b.totalPrice.value) worse = true;
      }
      const asked = Date.parse(b.startTime);
      timeShiftMin = Math.abs(Date.parse(offered.startTime) - asked) / 60_000;
      // A time we would offer the customer ourselves: open, not closed, on the grid, free but for theirs.
      timeNotOffered = !(await slotOffered(db, {
        serviceId: b.reservationFor.serviceId,
        start: Date.parse(offered.startTime),
        end: Date.parse(offered.endTime),
        timezone: (await businessFacts(db)).timezone,
        exceptItemId: item.id,
      }));
      if (!change && last) worse ||= dearer(last.terms, businessTimeTerms(payload as PayloadOf<"booking">));
    }
  } else if (item.type === "order" && (t.event === "propose" || t.event === "propose_change")) {
    const offered = (change ? payload.change : payload.proposed) as
      | {
          orderedItem: {
            productId?: string;
            sku?: string;
            name: string;
            quantity: number;
            price: Money;
            listPrice?: Money;
          }[];
          totalPrice: Money;
          delivery?: { method: string; when?: string };
          personalised?: Personalised;
        }
      | undefined;
    if (offered) {
      const agreed = item.payload.orderedItem;
      const priced: (LinePricing | null)[] = await linePricing(db, offered.orderedItem, pricing);
      let says: string | undefined;
      offered.orderedItem.forEach((line, i) => {
        const cat = priced[i] ?? null;
        // A catalogue line under its own name is the owner's words; under another, automation's.
        if (!cat || line.name !== cat.name.slice(0, 200)) words.push(line.name);
        if (!cat) {
          // A line the catalogue does not price: the price is automation's own, unless it is what was agreed.
          const kept = change && agreed.some((a) => a.name === line.name && sameMoney(a.price, line.price));
          if (!kept)
            lines.push({ price: line.price.value, quantity: line.quantity, list: null, customer: null, floor: null });
          return;
        }
        if (sameMoney(line.price, cat.list) && cat.customer.value < cat.list.value) line.price = cat.customer;
        const mark = listed(line.price, cat.list);
        if (mark.listPrice) {
          line.listPrice = mark.listPrice;
          if (cat.reward?.says && sameMoney(line.price, cat.customer)) says ??= cat.reward.says;
        } else delete line.listPrice;
        // A change keeps what was agreed for a product without judging it again; a new price is judged.
        const kept =
          change &&
          agreed.some((a) => (a.productId ?? a.sku) === (line.productId ?? line.sku) && sameMoney(a.price, line.price));
        if (kept) return;
        lines.push({
          price: line.price.value,
          quantity: line.quantity,
          list: cat.list.value,
          customer: cat.customer.value,
          floor: cat.floor,
          countered: change ? null : below(countered.byProduct.get(cat.productId), cat.customer.value),
        });
      });
      let total = 0;
      for (const l of offered.orderedItem) total += l.price.value * l.quantity;
      if (Number.isSafeInteger(total)) offered.totalPrice = { value: total, currency: offered.totalPrice.currency };
      data.totalPrice = offered.totalPrice;
      const personalised = orderPersonalised(offered.orderedItem, says);
      if (personalised) offered.personalised = personalised;
      else delete offered.personalised;
      const asked = item.payload.delivery?.when;
      const when = offered.delivery?.when;
      if (asked && when) delayDays = Math.max(0, (Date.parse(when) - Date.parse(asked)) / DAY);
      if (change) {
        const next = changeTerms({ ...item, payload } as Item);
        const was = promiseTerms(item);
        worse ||= next !== null && was !== null && dearer(was, next);
      } else if (last && payload.proposed) {
        worse ||= dearer(last.terms, orderOfferTerms(payload.proposed as NonNullable<PayloadOf<"order">["proposed"]>));
      }
    }
  } else if (item.type === "quote_request" && t.event === "quote") {
    // A quote prices what the catalogue does not: the owner lets automation do that, or does it.
    custom = true;
    const q = payload.quote as NonNullable<PayloadOf<"quote_request">["quote"]> | undefined;
    for (const l of q?.lines ?? []) words.push(l.name);
    if (q && last) worse ||= dearer(last.terms, quoteOfferTerms(q));
  }

  return {
    breaches: checkOffer(
      { lines, custom, customerPriced, timeShiftMin, timeNotOffered, delayDays, worseThanBefore: worse, round, change },
      settings.negotiation,
    ),
    words,
  };
}

/**
 * What automation's acceptance of the customer's request is outside of (ADR-018 §4): a price under the
 * owner's floor for this customer (a price of their own they suggested), an order above the value the
 * owner accepts in person. A price the business did not set at all is `business_priced`'s, not here.
 * When it takes a price below ours, the price is personalised (the notice goes with it).
 */
/**
 * The prices the inbox itself put on the request for a customer it chose a price for (a reward,
 * `personalised`, Q3, Q5), while nothing is agreed yet: the business's own, which the customer
 * confirmed, so automation may take them whatever the rewards say by now. Per unit, as a reward
 * prices. Every other price is judged — a person's offer included, which was for the terms it named.
 */
function pricedByInbox(rows: readonly OfferRow[], rewarded: boolean): { totals: Money[]; units: OfferLine[] } {
  const first = rows.find((r) => r.rev === 1);
  if (!rewarded || !first || first.by !== "customer" || rows.some((r) => r.status === "accepted")) {
    return { totals: [], units: [] };
  }
  return { totals: first.terms.totalPrice ? [first.terms.totalPrice] : [], units: [...(first.terms.lines ?? [])] };
}

export async function judgeAccept(o: {
  readonly db: Db;
  readonly item: Item;
  readonly rows: readonly OfferRow[];
  readonly payload: Record<string, unknown>;
  readonly settings: Settings;
}): Promise<Breach[]> {
  const { db, item, payload, settings } = o;
  const pricing = await pricingForItem(db, item, settings);
  if (item.type === "booking") {
    const b = payload as PayloadOf<"booking">;
    const sp = await servicePricing(db, b.reservationFor.serviceId, b.partySize, pricing);
    if (!b.totalPrice) return [];
    // What the catalogue does not price for this booking — a service priced from or by quote, a longer
    // time — a person priced. A price of the customer's own on it has no floor to be judged against, so
    // it is a person's to take, as a line a person priced on an order is (`business_priced`).
    const longer = sp !== null && Date.parse(b.endTime) - Date.parse(b.startTime) > sp.durationMin * 60_000;
    if (!sp?.list || !sp.customer || longer) {
      const open = openOf(o.rows);
      const theirs = open?.by === "customer" ? open.terms.totalPrice : undefined;
      const ours = lastBusinessOffer(o.rows)?.terms.totalPrice;
      return theirs && !(ours && sameMoney(ours, theirs)) ? ["custom_line"] : [];
    }
    const total = b.totalPrice;
    if (pricedByInbox(o.rows, b.personalised !== undefined).totals.some((m) => sameMoney(m, total))) return [];
    const breaches = checkAccept(
      {
        lines: [
          { price: b.totalPrice.value, quantity: 1, list: sp.list.value, customer: sp.customer.value, floor: sp.floor },
        ],
      },
      settings.negotiation,
    );
    if (breaches.length === 0 && !b.personalised) {
      const mark = listed(b.totalPrice, sp.list);
      if (mark.listPrice) payload.personalised = { listPrice: mark.listPrice };
    }
    return breaches;
  }
  if (item.type === "order") {
    const p = payload as PayloadOf<"order">;
    const priced = await linePricing(db, p.orderedItem, pricing);
    const ours = pricedByInbox(o.rows, p.personalised !== undefined).units;
    const lines: LimitLine[] = [];
    p.orderedItem.forEach((line, i) => {
      const cat = priced[i];
      if (!cat) return;
      if (ours.some((u) => u.productId === cat.productId && sameMoney(u.price, line.price))) return;
      lines.push({
        price: line.price.value,
        quantity: line.quantity,
        list: cat.list.value,
        customer: cat.customer.value,
        floor: cat.floor,
      });
    });
    const breaches = checkAccept(
      { lines, total: p.totalPrice.value, approvalMax: settings.orders.maxValueWithoutApprovalMinor },
      settings.negotiation,
    );
    if (breaches.length === 0 && !p.personalised) {
      const marked = p.orderedItem.map((line, i) => ({ ...line, ...listed(line.price, priced[i]?.list ?? null) }));
      const personalised = orderPersonalised(marked);
      if (personalised) {
        p.orderedItem = marked;
        payload.personalised = personalised;
      }
    }
    return breaches;
  }
  return [];
}

/** The draft an offer outside the limits becomes, and what the owner sees of it. */
export interface DraftPlan {
  readonly statements: Statement[];
  readonly view: ItemView;
  readonly drafted: { readonly id: string; readonly breaches: readonly Breach[] };
}

/**
 * An offer outside the owner's limits, kept for a person (ADR-018 §4): the self-transition
 * `draft_offer` — no state change, no word to the customer, the item marked for a person — and the
 * draft itself, replacing the item's last one. The owner hears of drafts at most once an hour per item.
 * Nothing reaches the customer, and no rule runs on it (a rule that drafted would draft again).
 */
export async function draftStatements(o: {
  readonly db: Db;
  readonly caller: Caller;
  readonly item: Item;
  readonly t: Transition;
  /** The transition's input, as validated, with the customer's prices the inbox put in. */
  readonly input: Record<string, unknown>;
  /** What the customer would be offered. */
  readonly terms: OfferTerms;
  readonly breaches: readonly Breach[];
  readonly now: number;
  readonly idem?: { readonly scope: string; readonly key: string } | undefined;
  readonly requestHash?: string | undefined;
  readonly causation?: { readonly id: string; readonly depth: number } | undefined;
  readonly viewOf: (item: Item) => ItemView;
}): Promise<DraftPlan> {
  const { caller, item, now } = o;
  const seq = item.version + 1;
  const eventId = ulid();
  const draftId = ulid();
  const flags = { ...item.flags, needsHuman: true };
  const updated = { ...item, version: seq, flags, updatedAt: new Date(now).toISOString() } as Item;
  const view = o.viewOf(updated);
  const drafted = { id: draftId, breaches: [...o.breaches] };
  const statements: Statement[] = [];
  if (o.idem && o.requestHash) {
    statements.push(idempotencyStatement(o.idem, o.requestHash, 202, { view, drafted }, item.id, now));
  }
  statements.push(
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: "draft_offer",
      fromState: item.state,
      toState: item.state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: null,
      diff: { flags: [item.flags, flags] },
      meta: {
        channel: caller.actor.channel,
        tier: caller.tier,
        draft: draftId,
        would: o.t.event,
        breaches: [...o.breaches],
        ...actorMeta(caller),
      },
      causationId: o.causation?.id ?? null,
      depth: o.causation?.depth ?? 0,
      now,
    }),
    {
      sql: "UPDATE items SET version = ?, flags = ?, updated_at = ? WHERE id = ? AND version = ?",
      params: [seq, JSON.stringify(flags), now, item.id, item.version],
      method: "run",
    },
    {
      sql: `INSERT INTO offer_drafts (item_id, id, event, input, terms, breaches, item_version, actor_kind, actor_id, actor_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (item_id) DO UPDATE SET id = excluded.id, event = excluded.event, input = excluded.input,
              terms = excluded.terms, breaches = excluded.breaches, item_version = excluded.item_version,
              actor_kind = excluded.actor_kind, actor_id = excluded.actor_id, actor_name = excluded.actor_name,
              created_at = excluded.created_at`,
      params: [
        item.id,
        draftId,
        o.t.event,
        JSON.stringify(o.input),
        JSON.stringify(o.terms),
        JSON.stringify(o.breaches),
        seq,
        caller.actor.kind,
        caller.actor.id,
        actorMeta(caller).actor_name ?? null,
        now,
      ],
      method: "run",
    },
    // One email an hour per item, however many drafts: a customer who keeps asking is not a flood.
    jobStatement("notify", { to: "owner", itemId: item.id, event: "draft_offer", eventId }, now, {
      dedupeKey: `notify:draft:${item.id}:${Math.floor(now / 3_600_000)}`,
    }),
  );
  if (await hasActiveWebhook(o.db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${item.type}.draft_offer`, itemId: item.id }, now));
  }
  return { statements, view, drafted };
}

/** The terms a business offer made by `t` leaves on the item, as the customer would be offered them. */
export function offeredTerms(item: Item, t: Transition, payload: Record<string, unknown>): OfferTerms {
  if (t.change) return changeTerms({ ...item, payload } as Item) ?? {};
  if (item.type === "booking") return businessTimeTerms(payload as PayloadOf<"booking">);
  if (item.type === "order" && payload.proposed) {
    return orderOfferTerms(payload.proposed as NonNullable<PayloadOf<"order">["proposed"]>);
  }
  if (item.type === "quote_request" && payload.quote) {
    return quoteOfferTerms(payload.quote as NonNullable<PayloadOf<"quote_request">["quote"]>);
  }
  return {};
}

/** The breaches in their fixed order, `extra` added. */
export function withBreach(breaches: readonly Breach[], extra: Breach): Breach[] {
  return BREACHES.filter((b) => b === extra || breaches.includes(b));
}

/**
 * Whether words automation would send the customer name money the business has not offered (ADR-018
 * §4; DL 7/2004 art. 32(1)): an amount that neither our terms on this item, nor what this very
 * transition offers or takes (`offered`), nor the catalogue holds — or something taken off a price.
 * The customer's own prices are not ours to write back to them: one they stated, one they countered
 * with, one on a request the business did not price. A yes in words is a yes, and taking their price
 * is an acceptance, judged as one.
 */
export async function namesOtherMoney(
  db: Db,
  item: Item,
  rows: readonly OfferRow[],
  text: string,
  offered?: unknown,
): Promise<boolean> {
  if (discountIn(text) || speltAmountIn(text)) return true;
  const named = amountsIn(text);
  if (named.length === 0) return false;
  const ours = new Set<number>();
  for (const r of rows) if (r.by === "business" || r.status === "accepted") amountsHeld(r.terms, ours);
  if (offered !== undefined) amountsHeld(offered, ours);
  const theirs = new Set<number>();
  if (item.type === "booking" || item.type === "order") {
    amountsHeld((item.payload as { customerStatedPrice?: unknown }).customerStatedPrice, theirs);
    if (item.type === "order") for (const l of item.payload.orderedItem) amountsHeld(l.customerStatedPrice, theirs);
  }
  const open = openOf(rows);
  if (open?.by === "customer" && (open.round > 1 || (await createdUnpriced(db, item.id))))
    amountsHeld(open.terms, theirs);
  const held = amountsHeld(withoutStatedPrices(item).payload);
  const rest = named.filter((a) => ours.has(a) === false && (held.has(a) === false || theirs.has(a)));
  if (rest.length === 0) return false;
  const marks = rest.map(() => "?").join(", ");
  const { rows: listed } = await db.client.query({
    sql: `SELECT CAST(json_extract(price, '$.value') AS INTEGER), name FROM products
           WHERE CAST(json_extract(price, '$.value') AS INTEGER) IN (${marks})
          UNION
          SELECT CAST(json_extract(price, '$.value') AS INTEGER), name FROM services
           WHERE price IS NOT NULL AND CAST(json_extract(price, '$.value') AS INTEGER) IN (${marks})`,
    params: [...rest, ...rest],
    method: "all",
  });
  // A catalogue price is ours to say beside what it is the price of — "our chains are €18.50" — never
  // on its own, where it would be a price for this item: "€18.50 and it's yours".
  const said = text.toLocaleLowerCase();
  const catalogue = new Set(
    listed
      .filter((r) => typeof r[1] === "string" && r[1].trim() !== "" && said.includes(r[1].toLocaleLowerCase()))
      .map((r) => Number(r[0])),
  );
  return rest.some((a) => !catalogue.has(a));
}

/** Whether the customer's request held a price the business did not set when it was made. */
async function createdUnpriced(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_events WHERE item_id = ? AND seq = 1 AND json_extract(meta, '$.unpriced') = 1 LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * A reply automation wrote that names money the business has not offered (`namesOtherMoney`), kept for
 * a person (ADR-018 §4): written as an internal note, never sent, the item marked for a person, the
 * owner told at most once an hour per item. One batch.
 */
export async function heldReplyStatements(o: {
  readonly db: Db;
  readonly caller: Caller;
  readonly item: Item;
  readonly body: string;
  readonly writtenBy: "person" | "automation" | null;
  readonly now: number;
}): Promise<{ statements: Statement[]; item: Item }> {
  const { caller, item, now } = o;
  const seq = item.version + 1;
  const eventId = ulid();
  const entryId = ulid();
  const flags = { ...item.flags, needsHuman: true };
  const statements: Statement[] = [
    threadEntryStatement({
      id: entryId,
      itemId: item.id,
      direction: "note",
      channel: caller.actor.channel,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      partyId: null,
      body: o.body,
      writtenBy: o.writtenBy,
      now,
    }),
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: "flags",
      fromState: item.state,
      toState: item.state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: "A reply naming an amount of money we have not offered: kept as a note for a person, not sent",
      diff: { flags: [item.flags, flags] },
      meta: { channel: caller.actor.channel, held_reply: entryId, breaches: ["amount_named"], ...actorMeta(caller) },
      causationId: null,
      depth: 0,
      now,
    }),
    {
      sql: "UPDATE items SET version = ?, flags = ?, updated_at = ? WHERE id = ? AND version = ?",
      params: [seq, JSON.stringify(flags), now, item.id, item.version],
      method: "run",
    },
    jobStatement("notify", { to: "owner", itemId: item.id, event: "held_reply", eventId }, now, {
      dedupeKey: `notify:held:${item.id}:${Math.floor(now / 3_600_000)}`,
    }),
  ];
  if (await hasActiveWebhook(o.db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${item.type}.flags`, itemId: item.id }, now));
  }
  return {
    statements,
    item: { ...item, version: seq, flags, updatedAt: new Date(now).toISOString() } as Item,
  };
}
