import type { Db } from "../db";
import type { Item } from "../domain/types";
import type { Settings } from "../settings/schema";

/**
 * One-time corrections (ADR-017 §3): a booking's outcome corrected once — a no-show that was not,
 * a completion that was a no-show — until `booking.autoCompleteHours` after its end, and a
 * charge-back recorded once on a completed order. Once made, after its window, or on an item
 * promised before outcomes were recorded (`legacy_promise`), a correction is dead: its guard
 * refuses it, and nothing lists it — not the owner app's buttons, not the owner's AI's "Next:",
 * not a full webhook's `transitions`.
 */
export interface CorrectionFacts {
  /** Promised before outcomes were recorded: its outcome is not corrected (0008). */
  readonly legacy: boolean;
  /** The booking's outcome was corrected already. */
  readonly corrected: boolean;
  /** A charge-back is recorded on the order already. */
  readonly chargedBack: boolean;
}

/** An `item_events` condition: the booking's outcome was corrected (not a flags change on it). */
export const CORRECTED_SQL = "event IN ('complete', 'no_show') AND from_state IN ('completed', 'no_show')";
/** An `item_events` condition: a charge-back is recorded. */
export const CHARGED_BACK_SQL = "event IN ('charge_back', 'record_charge_back')";

/** Until when a booking's outcome may be corrected: `booking.autoCompleteHours` after its end. */
export function correctionUntil(endTime: string, settings: Settings): number {
  return Date.parse(endTime) + settings.booking.autoCompleteHours * 3_600_000;
}

/** Whether an item in its state could have a correction offered at all: the only ones worth a query. */
function mayCorrect(type: string, state: string): boolean {
  return (
    (type === "booking" && (state === "completed" || state === "no_show")) ||
    (type === "order" && state === "completed")
  );
}

/** The corrections on this item that can no longer be made, by event. */
export function deadCorrections(item: Item, facts: CorrectionFacts, settings: Settings, now: number): Set<string> {
  const dead = new Set<string>();
  if (item.type === "booking" && (item.state === "completed" || item.state === "no_show")) {
    const until = correctionUntil(item.payload.endTime, settings);
    if (facts.legacy || facts.corrected || !(now <= until))
      dead.add(item.state === "completed" ? "no_show" : "complete");
  }
  if (item.type === "order" && item.state === "completed" && facts.chargedBack) dead.add("record_charge_back");
  return dead;
}

/** What each item's history says about its corrections, in one query for all the items that could have one. */
export async function correctionFacts(
  db: Db,
  rows: readonly {
    readonly id: string;
    readonly type: string;
    readonly state: string;
    readonly legacyPromise: number;
  }[],
): Promise<Map<string, CorrectionFacts>> {
  const out = new Map<string, CorrectionFacts>();
  for (const r of rows) out.set(r.id, { legacy: r.legacyPromise === 1, corrected: false, chargedBack: false });
  const ids = rows.filter((r) => mayCorrect(r.type, r.state)).map((r) => r.id);
  // In chunks: a statement may bind at most 100 parameters on some runtimes.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { rows: found } = await db.client.query({
      sql: `SELECT item_id, MAX(CASE WHEN ${CORRECTED_SQL} THEN 1 ELSE 0 END), MAX(CASE WHEN ${CHARGED_BACK_SQL} THEN 1 ELSE 0 END)
              FROM item_events WHERE item_id IN (${chunk.map(() => "?").join(", ")}) GROUP BY item_id`,
      params: chunk,
      method: "all",
    });
    for (const f of found) {
      const id = String(f[0]);
      const had = out.get(id);
      if (had) out.set(id, { ...had, corrected: Number(f[1]) === 1, chargedBack: Number(f[2]) === 1 });
    }
  }
  return out;
}

/**
 * The events to leave out of each item's `transitions`: its dead corrections. Items that could not
 * have one cost nothing; the rest share one query.
 */
export async function hiddenTransitions(
  db: Db,
  entries: readonly { readonly item: Item; readonly legacyPromise: number }[],
  settings: Settings,
  now: number,
): Promise<Map<string, ReadonlySet<string>>> {
  const facts = await correctionFacts(
    db,
    entries.map((e) => ({ id: e.item.id, type: e.item.type, state: e.item.state, legacyPromise: e.legacyPromise })),
  );
  const out = new Map<string, ReadonlySet<string>>();
  for (const e of entries) {
    const f = facts.get(e.item.id);
    if (!f) continue;
    const dead = deadCorrections(e.item, f, settings, now);
    if (dead.size) out.set(e.item.id, dead);
  }
  return out;
}
