import { AMENDMENT_LIMITS as NETWORK_AMENDMENT_LIMITS } from "@surfingdog/spec";
import type { OfferTerms } from "../customer/offer";
import type { Db } from "../db";
import { CUSTOMER_ACTORS, type ItemType } from "../domain/types";
import { itemStopped } from "../identity/stops";
import { appliesV6, networkRulesOf } from "../network/index";
import { enabledNetworks, type Settings } from "../settings/schema";
import type { OfferRow } from "./offers";

/**
 * Changes to a promise (ADR-018 §3.1, §3.2, §8): a confirmed booking or an accepted order that both
 * sides agree to change. What bounds them, and whether one may be recorded at all where the promise
 * was reported. Pure but for the one query each that says what a network holds.
 */

/**
 * What a network honours of changes a customer's assistant did not confirm (ADR-018 §8, ADR-017
 * Amendment 3): at most three to one promise, moving what it is due by at most ninety days from
 * what was first agreed, so a business cannot put off its own promise on its own word. The inbox
 * counts every change accepted, acknowledged or not, so it never records one a network would not
 * honour; `negotiation.changes.maxPerItem` may only lower the first.
 */
export const AMENDMENT_LIMITS = {
  maxPerItem: NETWORK_AMENDMENT_LIMITS.unverified,
  dueShiftDays: NETWORK_AMENDMENT_LIMITS.dueShiftDays,
} as const;

const DAY = 86_400_000;

/** The changes to the promise both sides accepted so far. */
export function acceptedChanges(rows: readonly OfferRow[]): number {
  return rows.filter((r) => r.kind === "change" && r.status === "accepted").length;
}

/**
 * When a promise on these terms is due, in Unix ms: a booking's start, an order's delivery date;
 * null when the terms name none (an order due some days after it was accepted, which a change of
 * quantities does not move).
 */
export function dueOfTerms(type: ItemType, terms: OfferTerms): number | null {
  const at = type === "booking" ? terms.startTime : terms.delivery?.when;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The date a network's R30 reads for a promise on these terms, in Unix ms: a booking's end, an
 * order's due (ADR-017 §3.3). A network bounds an unverified amendment's move of this date as it
 * bounds `due`'s (Amendment 3, A3.1), so a business cannot stretch a booking's end on its own word.
 */
export function r30OfTerms(type: ItemType, terms: OfferTerms): number | null {
  if (type === "booking") {
    const end = terms.endTime ? Date.parse(terms.endTime) : Number.NaN;
    if (Number.isFinite(end)) return end;
  }
  return dueOfTerms(type, terms);
}

/**
 * When the promise was first due, in Unix ms. What a network measures from is the `due` of the
 * item's earliest promise receipt (ADR-017 Amendment 3, A3.1), so that comes first when there is
 * one (`promised`): an order agreed with no delivery date was sent as due `orders.dueDays` after it
 * was accepted, and raising that setting later must not move the date the limit is measured from.
 * Without a receipt, the date named by the terms first agreed (its earliest accepted offer that is
 * not itself a change, else what it holds now), else `orders.dueDays` after it was agreed. A date
 * named only later is measured from that, so it cannot escape the limit. `r30` asks the same of
 * the date R30 reads (a booking's end; an order's due).
 */
function firstDue(
  type: ItemType,
  rows: readonly OfferRow[],
  current: OfferTerms,
  settings: Settings,
  now: number,
  promised: PromisedDates | null,
  r30 = false,
) {
  if (promised !== null) return r30 ? (promised.end ?? promised.due) : promised.due;
  const agreed = rows.find((r) => r.status === "accepted" && r.kind !== "change");
  const named = (r30 ? r30OfTerms : dueOfTerms)(type, agreed?.terms ?? current);
  if (named !== null || type !== "order") return named;
  return (agreed?.updatedAt ?? now) + settings.orders.dueDays * DAY;
}

/** The dates of the item's earliest promise receipt, in Unix ms: its `due`, and a booking's `end`. */
export interface PromisedDates {
  readonly due: number;
  readonly end: number | null;
}

/**
 * The `due` and `end` of the item's earliest promise receipt that carries them (claims v2), in Unix
 * ms: the dates every network that holds the promise measures an amendment from (A3.1). Null when
 * none was signed yet, or the item's promises name no date (claims v1).
 */
export async function promisedDatesOf(db: Db, itemId: string): Promise<PromisedDates | null> {
  const { rows } = await db.client.query({
    sql: `SELECT json_extract(payload, '$.due'), json_extract(payload, '$.end'), json_extract(payload, '$.iat'), json_extract(payload, '$.nonce')
            FROM receipts
           WHERE item_id = ? AND kind IN ('confirmed', 'accepted', 'paid') AND json_extract(payload, '$.ver') = 2
           ORDER BY json_extract(payload, '$.iat'), json_extract(payload, '$.nonce') LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  const due = Number(rows[0]?.[0]);
  if (!rows[0] || !Number.isFinite(due) || due <= 0) return null;
  const end = rows[0][1] === null || rows[0][1] === undefined ? Number.NaN : Number(rows[0][1]);
  return { due: due * 1000, end: Number.isFinite(end) && end > 0 ? end * 1000 : null };
}

export type ChangesLeft = { readonly ok: true } | { readonly ok: false; readonly why: "count" | "shift" };

/**
 * Whether the promise can take this change: fewer changes accepted than the owner allows (and the
 * network honours), and neither its due date nor the date R30 reads (a booking's end) further than
 * `AMENDMENT_LIMITS.dueShiftDays` from the one first agreed — the one its earliest receipt was
 * signed with, when there is one — either way: a network honours no unverified amendment that
 * moves either further (ADR-017 Amendment 3, A3.1), and would hold the business to the first dates.
 */
export function changesLeft(
  type: ItemType,
  rows: readonly OfferRow[],
  current: OfferTerms,
  next: OfferTerms,
  settings: Settings,
  now: number,
  /** The earliest promise receipt's dates, in Unix ms (`promisedDatesOf`), when one was signed. */
  promised: PromisedDates | null = null,
): ChangesLeft {
  const most = Math.min(settings.negotiation.changes.maxPerItem, AMENDMENT_LIMITS.maxPerItem);
  if (acceptedChanges(rows) >= most) return { ok: false, why: "count" };
  const limit = AMENDMENT_LIMITS.dueShiftDays * DAY;
  const first = firstDue(type, rows, current, settings, now, promised);
  const due = dueOfTerms(type, next);
  if (first !== null && due !== null && Math.abs(due - first) > limit) return { ok: false, why: "shift" };
  const firstR30 = firstDue(type, rows, current, settings, now, promised, true);
  const r30 = r30OfTerms(type, next);
  if (firstR30 !== null && r30 !== null && Math.abs(r30 - firstR30) > limit) return { ok: false, why: "shift" };
  return { ok: true };
}

/** Actors whose items carry claims v2, with a due date a network holds the business to (ADR-017 §3.2). */
const V2_CREATORS: ReadonlySet<string> = new Set([...CUSTOMER_ACTORS, "connector"]);

/**
 * Whether a change to this promise can be recorded without breaking it where it was reported
 * (ADR-018 §8, ADR-017 Amendment 3): a network on rules before version 6 holds the promise to the
 * date it was sent with, and would count a booking moved later as a promise never closed (R30). So a
 * change is taken only where every network that holds the promise, or will be sent it, applies rules
 * version 6 — in force, not only announced — and so reads the `amended` receipt: each network that
 * took one of the item's receipts, and, unless the customer stopped the networks for themselves,
 * each one switched on to take receipts. Also always for a promise that carries no due date (the
 * business made it itself: claims v1) and for a test. With no network in the way, at once.
 */
export async function amendmentsLive(
  db: Db,
  settings: Settings,
  item: { readonly id: string; readonly flags: { readonly sandbox?: boolean } },
): Promise<boolean> {
  if (item.flags.sandbox) return true;
  const { rows: made } = await db.client.query({
    sql: "SELECT actor_kind FROM item_events WHERE item_id = ? AND seq = 1",
    params: [item.id],
    method: "all",
  });
  // An item the business wrote down itself promises no due date to any network (claims v1).
  if (!V2_CREATORS.has(String(made[0]?.[0] ?? ""))) return true;
  // A customer who asked us not to use booking networks: nothing more of theirs is sent to any, so
  // only what a network already took holds the business to a date.
  const stopped = await itemStopped(db, item.id);
  const { rows: published } = await db.client.query({
    sql: `SELECT DISTINCT p.network FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
           WHERE r.item_id = ? AND p.state IN (${stopped ? "'published'" : "'published', 'queued'"})`,
    params: [item.id],
    method: "all",
  });
  const holding = published.map((r) => String(r[0]));
  const future = stopped ? [] : enabledNetworks(settings, "receipts");
  const networks = [...new Set([...holding, ...future])];
  if (networks.length === 0) return true;
  const rules = await networkRulesOf(db, networks);
  return networks.every((n) => appliesV6(rules.get(n)));
}

/**
 * A condition on a receipt `r`: it names a date a network holds the business to (claims v2). A
 * promise the business wrote down itself, or one made before outcomes were recorded, is claims v1 and
 * names none, so a change to it moves nothing a network holds, and nothing of it waits for newer rules.
 */
const DATED_SQL = (alias: string): string => `COALESCE(json_extract(${alias}.payload, '$.ver'), 1) = 2`;

/**
 * A condition on a receipt `r` (a `receipts` row alias): its item's promise was never changed, or it
 * names no date. What a network that does not apply rules version 6 may be sent: a changed promise's
 * first receipts name the date first agreed, and such a network would hold the business to it and
 * count the promise unclosed nine days after (ADR-017 R30). So it is sent none of them — not by the
 * backfill of a network switched on after the change, and not the outcome that closes the promise at
 * its new date.
 */
export const RECEIPT_NOT_AMENDED_SQL = (alias: string): string =>
  `(NOT ${DATED_SQL(alias)} OR NOT EXISTS (SELECT 1 FROM item_offers ao WHERE ao.item_id = ${alias}.item_id AND ao.kind = 'change' AND ao.status = 'accepted'))`;

/**
 * A condition on a receipt `r`: every change both sides agreed to its item's promise has its
 * `amended` receipt, or it names no date. What a network that applies rules version 6 may be sent:
 * the promise, each amendment and the outcome, so it holds the business to the latest agreed dates. A
 * change recorded without its receipt (none could be signed, or it came before these receipts) keeps
 * the item's dated receipts from every network, as before.
 */
export const RECEIPT_AMENDMENTS_ISSUED_SQL = (alias: string): string =>
  `(NOT ${DATED_SQL(alias)} OR NOT EXISTS (SELECT 1 FROM item_offers ao WHERE ao.item_id = ${alias}.item_id AND ao.kind = 'change' AND ao.status = 'accepted'
     AND NOT EXISTS (SELECT 1 FROM receipts ar WHERE ar.item_id = ao.item_id AND ar.kind = 'amended' AND ar.offer_id = ao.id)))`;

/** Whether the item's promise was changed: its receipts go only to networks applying rules version 6. */
export async function itemAmended(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_offers WHERE item_id = ? AND kind = 'change' AND status = 'accepted' LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Whether the item's receipts may go to a network, as far as changes to its promise go: always when
 * it never changed; when it did, only to a network that applies rules version 6, and only once every
 * agreed change has its `amended` receipt (`RECEIPT_AMENDMENTS_ISSUED_SQL`).
 */
export async function amendmentsSendable(db: Db, itemId: string, applies: boolean): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM receipts r WHERE r.item_id = ? AND ${applies ? RECEIPT_AMENDMENTS_ISSUED_SQL("r") : RECEIPT_NOT_AMENDED_SQL("r")} LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}
