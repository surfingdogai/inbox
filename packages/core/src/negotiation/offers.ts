import type { Statement } from "@surfingdog/platform";
import type { OfferForm, OfferTerms } from "../customer/offer";
import type { Db } from "../db";
import type { OfferPointer } from "../domain/types";

/**
 * Offers as the inbox keeps them (ADR-018 §1): one row per offer in `item_offers`, never edited but
 * to close it — or, for the customer's open request, to follow the request's clock when it is wound
 * again (`items.request_expires_at`), which is its validity. A verb closes the open offer (accepted, declined, countered, retracted, expired,
 * superseded) and, when it makes one, inserts the next, both in the batch of the item's transition;
 * the item's version makes each verb happen once, and the partial unique index keeps one open offer
 * per item. This module reads rows and builds statements; it writes nothing on its own.
 */
export type OfferSide = "business" | "customer";

export type OfferStatus =
  | "draft"
  | "open"
  | "accepted"
  | "declined"
  | "countered"
  | "retracted"
  | "expired"
  | "superseded";

export const OFFER_STATUSES: readonly OfferStatus[] = [
  "draft",
  "open",
  "accepted",
  "declined",
  "countered",
  "retracted",
  "expired",
  "superseded",
];

/** Why a customer answered as they did, in ACP's `intent_trace` codes (ADR-018 §1). */
export const REASON_CODES = [
  "price_sensitivity",
  "timing_deferred",
  "quantity",
  "delivery",
  "returns_policy",
  "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface OfferRow {
  readonly id: string;
  readonly itemId: string;
  readonly rev: number;
  readonly parentId: string | null;
  /** `offer` before a promise. */
  readonly kind: string;
  readonly form: OfferForm;
  readonly by: OfferSide;
  readonly actorKind: string;
  readonly actorId: string;
  readonly round: number;
  readonly status: OfferStatus;
  readonly validThrough: number | null;
  readonly terms: OfferTerms;
  readonly termsSha: string;
  readonly changes: readonly string[] | null;
  readonly shown: OfferShown | null;
  readonly authored: "person" | "automated";
  readonly binding: boolean;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly eventId: string | null;
  readonly closedEventId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What the other side was shown with an offer: the business's sentence, in the customer's language. */
export interface OfferShown {
  readonly lang: string;
  readonly human: string;
  readonly disclosures?: readonly string[];
}

const COLUMNS =
  "id, item_id, rev, parent_id, kind, form, by, actor_kind, actor_id, round, status, valid_through, terms, terms_sha, changes, shown, authored, binding, reason_code, note, event_id, closed_event_id, created_at, updated_at";

/** Every offer of an item, oldest first. */
export async function offerRows(db: Db, itemId: string): Promise<OfferRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM item_offers WHERE item_id = ? ORDER BY rev`,
    params: [itemId],
    method: "all",
  });
  return rows.map(toRow);
}

/** The offers of several items, by item: at most 90 ids a query, so D1 binds under its hundred. */
export async function offerRowsFor(db: Db, itemIds: readonly string[]): Promise<Map<string, OfferRow[]>> {
  const out = new Map<string, OfferRow[]>();
  const ids = [...new Set(itemIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { rows } = await db.client.query({
      sql: `SELECT ${COLUMNS} FROM item_offers WHERE item_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY item_id, rev`,
      params: chunk,
      method: "all",
    });
    for (const r of rows.map(toRow)) {
      const list = out.get(r.itemId) ?? [];
      list.push(r);
      out.set(r.itemId, list);
    }
  }
  return out;
}

export const openOf = (rows: readonly OfferRow[]): OfferRow | undefined => rows.find((r) => r.status === "open");

/** The last offer both sides agreed, if any. */
export function agreedOf(rows: readonly OfferRow[]): OfferRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.status === "accepted") return rows[i];
  return undefined;
}

/** The round the next offer is in: the open one's, when its own side replaces it; one more when it answers. */
export function nextRound(rows: readonly OfferRow[], by: OfferSide): number {
  const open = openOf(rows);
  if (open) return open.by === by ? open.round : open.round + 1;
  const agreed = agreedOf(rows);
  const since = agreed ? rows.filter((r) => r.rev > agreed.rev) : rows;
  const last = since.at(-1);
  return last ? last.round + 1 : 1;
}

export const nextRev = (rows: readonly OfferRow[]): number => (rows.at(-1)?.rev ?? 0) + 1;

/** The pointer the item's payload carries: the open offer, else the last agreed one. */
export function pointerOf(row: OfferRow, extra: { readonly held?: boolean } = {}): OfferPointer {
  return {
    id: row.id,
    rev: row.rev,
    by: row.by,
    round: row.round,
    status: row.status === "accepted" ? "accepted" : "open",
    ...(row.validThrough !== null ? { validThrough: new Date(row.validThrough).toISOString() } : {}),
    ...(extra.held ? { held: true as const } : {}),
    ...(row.by === "business" && !row.binding && row.status === "open" ? { binding: false as const } : {}),
  };
}

export function insertOfferStatement(row: OfferRow, opts: { readonly orIgnore?: boolean } = {}): Statement {
  return {
    sql: `INSERT${opts.orIgnore ? " OR IGNORE" : ""} INTO item_offers (${COLUMNS}) VALUES (${COLUMNS.split(",")
      .map(() => "?")
      .join(", ")})`,
    params: [
      row.id,
      row.itemId,
      row.rev,
      row.parentId,
      row.kind,
      row.form,
      row.by,
      row.actorKind,
      row.actorId,
      row.round,
      row.status,
      row.validThrough,
      JSON.stringify(row.terms),
      row.termsSha,
      row.changes ? JSON.stringify(row.changes) : null,
      row.shown ? JSON.stringify(row.shown) : null,
      row.authored,
      row.binding ? 1 : 0,
      row.reasonCode,
      row.note,
      row.eventId,
      row.closedEventId,
      row.createdAt,
      row.updatedAt,
    ],
    method: "run",
  };
}

/**
 * Closes an open offer. Only an open one: a verb that raced another finds nothing to close, and the
 * item's version refuses it anyway.
 */
export function closeOfferStatement(
  id: string,
  status: OfferStatus,
  eventId: string,
  now: number,
  /** Why the customer declined it, when they said. */
  reasonCode?: string | null,
): Statement {
  return {
    sql: "UPDATE item_offers SET status = ?, closed_event_id = ?, updated_at = ?, reason_code = COALESCE(?, reason_code) WHERE id = ? AND status = 'open'",
    params: [status, eventId, now, reasonCode ?? null, id],
    method: "run",
  };
}

/** The id of the offer a legacy item gets for what it already held: the same from every writer, so a race writes it once. */
export const legacyOfferId = (itemId: string): string => `lgo_${itemId}`;

function toRow(r: readonly unknown[]): OfferRow {
  const json = <T>(v: unknown): T | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return v as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  };
  return {
    id: String(r[0]),
    itemId: String(r[1]),
    rev: Number(r[2]),
    parentId: r[3] === null || r[3] === undefined ? null : String(r[3]),
    kind: String(r[4]),
    form: String(r[5]) as OfferForm,
    by: r[6] === "customer" ? "customer" : "business",
    actorKind: String(r[7]),
    actorId: String(r[8]),
    round: Number(r[9]),
    status: String(r[10]) as OfferStatus,
    validThrough: r[11] === null || r[11] === undefined ? null : Number(r[11]),
    terms: json<OfferTerms>(r[12]) ?? {},
    termsSha: String(r[13]),
    changes: json<string[]>(r[14]),
    shown: json<OfferShown>(r[15]),
    authored: r[16] === "person" ? "person" : "automated",
    binding: Number(r[17]) === 1,
    reasonCode: r[18] === null || r[18] === undefined ? null : String(r[18]),
    note: r[19] === null || r[19] === undefined ? null : String(r[19]),
    eventId: r[20] === null || r[20] === undefined ? null : String(r[20]),
    closedEventId: r[21] === null || r[21] === undefined ? null : String(r[21]),
    createdAt: Number(r[22]),
    updatedAt: Number(r[23]),
  };
}

/** An offer as the owner's doors show it: every field, times as ISO 8601. */
export interface OfferView {
  readonly id: string;
  readonly rev: number;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly form: OfferForm;
  readonly by: OfferSide;
  readonly actor: { readonly kind: string; readonly id: string | null };
  readonly round: number;
  readonly status: OfferStatus;
  readonly valid_through: string | null;
  readonly terms: OfferTerms;
  readonly terms_sha: string;
  readonly changes: readonly string[];
  readonly shown: OfferShown | null;
  readonly authored: "person" | "automated";
  readonly binding: boolean;
  readonly reason_code: string | null;
  readonly note: string | null;
  readonly created_at: string;
  readonly closed_at: string | null;
}

export function offerView(r: OfferRow): OfferView {
  const customer = r.actorKind === "customer_agent" || r.actorKind === "customer_human";
  return {
    id: r.id,
    rev: r.rev,
    parent_id: r.parentId,
    kind: r.kind,
    form: r.form,
    by: r.by,
    // A customer's id is a fingerprint and events travel: never given out (`eventActor`).
    actor: { kind: r.actorKind, id: customer ? null : r.actorId },
    round: r.round,
    status: r.status,
    valid_through: r.validThrough === null ? null : new Date(r.validThrough).toISOString(),
    terms: r.terms,
    terms_sha: r.termsSha,
    changes: r.changes ?? [],
    shown: r.shown,
    authored: r.authored,
    binding: r.binding,
    reason_code: r.reasonCode,
    note: r.note,
    created_at: new Date(r.createdAt).toISOString(),
    closed_at: r.status === "open" || r.status === "draft" ? null : new Date(r.updatedAt).toISOString(),
  };
}
