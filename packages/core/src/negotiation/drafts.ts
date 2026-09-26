import type { Statement } from "@surfingdog/platform";
import type { OfferTerms } from "../customer/offer";
import type { Db } from "../db";
import type { Breach } from "./limits";

/**
 * Drafts (ADR-018 §4): what the owner's AI, a rule or another system's key would have offered outside
 * the owner's limits, kept for a person — never sent, never an offer the customer saw, so it takes no
 * place among the item's offers. One per item, the latest; the owner sends it as it is, makes their own
 * offer instead, or drops it. It was made on the item as it stood (`item_version`): once the item has
 * moved, it can no longer be sent as it is.
 */
export interface DraftView {
  readonly id: string;
  /** The transition it would make: propose, quote, propose_change. */
  readonly event: string;
  /** What the customer would be offered. */
  readonly terms: OfferTerms;
  /** The limits it is outside, as codes. */
  readonly breaches: readonly Breach[];
  /** Who drafted it: the owner's AI, a rule, a key, and its name when it has one. */
  readonly by: { readonly kind: string; readonly id: string; readonly name?: string | undefined };
  readonly created_at: string;
  /** The item has moved since: it can no longer be sent as it is. */
  readonly stale: boolean;
}

export interface DraftRow {
  readonly itemId: string;
  readonly id: string;
  readonly event: string;
  readonly input: Record<string, unknown>;
  readonly terms: OfferTerms;
  readonly breaches: readonly Breach[];
  readonly itemVersion: number;
  readonly actorKind: string;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly createdAt: number;
}

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** The item's draft, if it has one. */
export async function draftRow(db: Db, itemId: string): Promise<DraftRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT id, event, input, terms, breaches, item_version, actor_kind, actor_id, actor_name, created_at
            FROM offer_drafts WHERE item_id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  return {
    itemId,
    id: String(r[0]),
    event: String(r[1]),
    input: json<Record<string, unknown>>(r[2], {}),
    terms: json<OfferTerms>(r[3], {}),
    breaches: json<Breach[]>(r[4], []),
    itemVersion: Number(r[5]),
    actorKind: String(r[6]),
    actorId: String(r[7]),
    actorName: r[8] === null || r[8] === undefined ? null : String(r[8]),
    createdAt: Number(r[9]),
  };
}

/**
 * Whether the item moved since the draft was made: anything but a flag set (a reply kept for a person,
 * a priority) or another draft. A customer's message is no move; their answer is.
 */
export async function draftIsStale(db: Db, d: DraftRow, itemVersion: number): Promise<boolean> {
  if (itemVersion === d.itemVersion) return false;
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_events WHERE item_id = ? AND seq > ? AND event NOT IN ('flags', 'draft_offer') LIMIT 1",
    params: [d.itemId, d.itemVersion],
    method: "all",
  });
  return rows.length > 0;
}

/** The draft as the owner's doors show it. */
export function draftView(d: DraftRow, stale: boolean): DraftView {
  return {
    id: d.id,
    event: d.event,
    terms: d.terms,
    breaches: d.breaches,
    by: { kind: d.actorKind, id: d.actorId, ...(d.actorName ? { name: d.actorName } : {}) },
    created_at: new Date(d.createdAt).toISOString(),
    stale,
  };
}

/** Drops the item's draft: this one only, when named, so a newer one is never dropped by mistake. */
export function dropDraftStatement(itemId: string, draftId?: string): Statement {
  return draftId
    ? { sql: "DELETE FROM offer_drafts WHERE item_id = ? AND id = ?", params: [itemId, draftId], method: "run" }
    : { sql: "DELETE FROM offer_drafts WHERE item_id = ?", params: [itemId], method: "run" };
}
