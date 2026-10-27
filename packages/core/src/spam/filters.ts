import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { ulid } from "../ids";
import { dayOf, FILTERS, type Filter, type FilterChoice, LEARNING_KEPT_MS, LEARNING_MS } from "./types";

/**
 * When each filter is on (ADR-041 §2), kept as spans: who switched it, and its days on can be recounted
 * at any time (a filter-day is a UTC day the filter was on at any moment). A filter switched on for the
 * first time learns for a week (it labels what it would put aside, and puts nothing aside); switched off
 * and on again within thirty days, it carries on where it was. The free protection's own point-based
 * part learns for a week from the day the filter arrived (`basic`).
 */

export interface FilterState {
  readonly filter: Filter;
  readonly on: boolean;
  readonly choice: FilterChoice;
  /** Until when it only labels; null when it is past its learning week. */
  readonly learningUntil: number | null;
  /** When it was switched on, while it is. */
  readonly since: number | null;
}

interface SpanRow {
  readonly id: string;
  readonly filter: string;
  readonly choice: FilterChoice;
  readonly fromAt: number;
  readonly toAt: number | null;
  readonly learningUntil: number | null;
  readonly byKind: string;
}

async function spans(db: Db, filter?: string): Promise<SpanRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id, filter, choice, from_at, to_at, learning_until, by_kind FROM spam_filter_spans
           ${filter ? "WHERE filter = ?" : ""} ORDER BY from_at DESC LIMIT 2000`,
    params: filter ? [filter] : [],
    method: "all",
  });
  return rows.map((r) => ({
    id: String(r[0]),
    filter: String(r[1]),
    choice: r[2] === "label" ? "label" : "aside",
    fromAt: Number(r[3]),
    toAt: r[4] === null || r[4] === undefined ? null : Number(r[4]),
    learningUntil: r[5] === null || r[5] === undefined ? null : Number(r[5]),
    byKind: String(r[6] ?? ""),
  }));
}

/** Every filter as it is now. */
export async function filterStates(db: Db, now: number): Promise<Map<Filter, FilterState>> {
  const all = await spans(db);
  const out = new Map<Filter, FilterState>();
  for (const filter of FILTERS) {
    const open = all.find((s) => s.filter === filter && s.toAt === null);
    out.set(filter, {
      filter,
      on: open !== undefined,
      choice: open?.choice ?? "aside",
      learningUntil:
        open?.learningUntil !== null && open?.learningUntil !== undefined && open.learningUntil > now
          ? open.learningUntil
          : null,
      since: open?.fromAt ?? null,
    });
  }
  return out;
}

/** Until when the free protection's point-based part only labels; null once past. */
export async function basicLearningUntil(db: Db, now: number): Promise<number | null> {
  const [basic] = await spans(db, "basic");
  return basic?.learningUntil !== null && basic?.learningUntil !== undefined && basic.learningUntil > now
    ? basic.learningUntil
    : null;
}

/**
 * The statements that switch a filter on or off, or change what it does. On: a new span, learning for
 * a week — or as far into its week as it was, when it was on within the last thirty days. Off: the open
 * span closed. Doing what is already so writes nothing.
 */
export async function switchFilterStatements(
  db: Db,
  input: {
    readonly filter: Filter;
    readonly on: boolean;
    readonly choice?: FilterChoice | undefined;
    readonly byKind: string;
    readonly byId: string;
    readonly now: number;
  },
): Promise<Statement[]> {
  const mine = await spans(db, input.filter);
  const open = mine.find((s) => s.toAt === null);
  if (!input.on) {
    if (!open) return [];
    // Who switched it off is kept: a filter a person switched off is never switched on again by a plan.
    return [
      {
        sql: "UPDATE spam_filter_spans SET to_at = ?, by_kind = ?, by_id = ? WHERE id = ? AND to_at IS NULL",
        params: [input.now, input.byKind, input.byId.slice(0, 200), open.id],
        method: "run",
      },
    ];
  }
  if (open) {
    if (!input.choice || input.choice === open.choice) return [];
    return [
      {
        sql: "UPDATE spam_filter_spans SET choice = ? WHERE id = ? AND to_at IS NULL",
        params: [input.choice, open.id],
        method: "run",
      },
    ];
  }
  const last = mine.find((s) => s.toAt !== null);
  const learningUntil =
    last && last.toAt !== null && input.now - last.toAt <= LEARNING_KEPT_MS
      ? last.learningUntil
      : input.now + LEARNING_MS;
  return [
    {
      sql: `INSERT INTO spam_filter_spans (id, filter, choice, from_at, to_at, learning_until, by_kind, by_id)
            SELECT ?, ?, ?, ?, NULL, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM spam_filter_spans WHERE filter = ? AND to_at IS NULL)`,
      params: [
        ulid(input.now),
        input.filter,
        input.choice ?? last?.choice ?? "aside",
        input.now,
        learningUntil,
        input.byKind,
        input.byId.slice(0, 200),
        input.filter,
      ],
      method: "run",
    },
  ];
}

/** "Start now": the learning week ends for this filter (or the free protection). */
export function endLearningStatement(filter: Filter | "basic", now: number): Statement {
  return {
    sql: "UPDATE spam_filter_spans SET learning_until = ? WHERE filter = ? AND to_at IS NULL AND learning_until > ?",
    params: [now, filter, now],
    method: "run",
  };
}

/** Per filter, the UTC days of a range it was on at any moment: how long each was used, in the month's usage. */
export async function filterDays(
  db: Db,
  range: { readonly from: number; readonly to: number },
  now: number,
): Promise<Record<Filter, number>> {
  const all = await spans(db);
  const out = { pitches: 0, scams: 0, junk: 0 } as Record<Filter, number>;
  for (const filter of FILTERS) {
    const days = new Set<string>();
    for (const s of all) {
      if (s.filter !== filter) continue;
      const start = Math.max(s.fromAt, range.from);
      const end = Math.min(s.toAt ?? now, range.to - 1, now);
      if (end < start) continue;
      for (let t = Date.UTC(...ymd(start)); t <= end; t += 86_400_000) days.add(dayOf(t));
    }
    out[filter] = days.size;
  }
  return out;
}

function ymd(ms: number): [number, number, number] {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/** The filters a host withdrew: switched off by the system, not by a person. */
export async function closeWithdrawnStatements(
  db: Db,
  allowed: ReadonlySet<Filter>,
  now: number,
): Promise<Statement[]> {
  const out: Statement[] = [];
  for (const s of await spans(db)) {
    if (s.toAt !== null || s.filter === "basic") continue;
    if (allowed.has(s.filter as Filter)) continue;
    out.push({
      sql: "UPDATE spam_filter_spans SET to_at = ?, by_kind = 'system', by_id = 'host' WHERE id = ? AND to_at IS NULL",
      params: [now, s.id],
      method: "run",
    });
  }
  return out;
}

/**
 * The filters a plan includes from the start (Pro, ADR-041 §15.3): each allowed filter nobody has
 * switched is switched on by the system, learning for a week first; one the host itself switched off
 * (a plan that lapsed) comes back as it was. A filter a person switched off stays off.
 */
export async function defaultOnStatements(db: Db, allowed: readonly Filter[], now: number): Promise<Statement[]> {
  const all = await spans(db);
  const out: Statement[] = [];
  for (const filter of allowed) {
    const mine = all.filter((s) => s.filter === filter);
    if (mine.some((s) => s.toAt === null)) continue;
    const last = mine[0];
    if (last && last.byKind !== "system") continue;
    out.push(...(await switchFilterStatements(db, { filter, on: true, byKind: "system", byId: "host", now })));
  }
  return out;
}
