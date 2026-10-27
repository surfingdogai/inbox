import type { ItemType, ItemView, ListParams, Page } from "./types";

/**
 * The rail: what the owner should look at, everything open, one type, what is done, items with an
 * email to the customer that could not be sent, and messages put aside as spam (by the owner, or as
 * they arrived: ADR-026 §7).
 */
export type Filter = "needs" | "all" | "done" | "unsent" | "held" | "spam" | ItemType;

export const FILTERS: readonly { readonly key: Filter; readonly label: string; readonly type?: ItemType }[] = [
  { key: "needs", label: "Needs you" },
  { key: "all", label: "All" },
  { key: "stay", label: "Stays", type: "stay" },
  { key: "booking", label: "Bookings", type: "booking" },
  { key: "order", label: "Orders", type: "order" },
  { key: "quote_request", label: "Quotes", type: "quote_request" },
  { key: "message", label: "Messages", type: "message" },
  { key: "refund", label: "Refunds", type: "refund" },
  { key: "done", label: "Done" },
  { key: "unsent", label: "Email not sent" },
  // What the spam filter holds until the sender confirms or a person lets it in (ADR-029): shown only
  // while something is held.
  { key: "held", label: "Held" },
  { key: "spam", label: "Spam" },
];

export function parseFilter(value: unknown): Filter | undefined {
  return FILTERS.some((f) => f.key === value) ? (value as Filter) : undefined;
}

export function filterLabel(filter: Filter): string {
  return FILTERS.find((f) => f.key === filter)?.label ?? "All";
}

export function paramsFor(filter: Filter, q: string | undefined, sandbox: boolean): ListParams {
  const base: ListParams = { sandbox, limit: 30, ...(q ? { q } : {}) };
  switch (filter) {
    case "needs":
      return { ...base, needs_human: true, open_only: true };
    case "all":
      return { ...base, open_only: true };
    case "done":
      // The API has no closed-only filter: ask for everything and keep the closed rows.
      return { ...base, open_only: false, limit: 50 };
    case "unsent":
      return { ...base, mail_failed: true, open_only: false };
    case "held":
      return { ...base, screen: "held", open_only: false };
    case "spam":
      // Everything put aside: by you, by a mail server as it arrived, and by the spam filter.
      return { ...base, state: "spam", open_only: false };
    default:
      return { ...base, type: filter, open_only: true };
  }
}

/** The search params with a new query: the filter stays, an empty query disappears from the URL. */
export function withQuery(
  prev: { readonly f?: Filter; readonly q?: string },
  q: string | undefined,
): { f?: Filter; q?: string } {
  return { ...(prev.f ? { f: prev.f } : {}), ...(q ? { q } : {}) };
}

export function visibleIn(filter: Filter, view: ItemView): boolean {
  return filter === "done" ? view.item.closedAt !== null : true;
}

export interface Counts {
  readonly needs: number;
  readonly all: number;
  readonly done: number;
  readonly byType: Record<ItemType, number>;
  readonly needsByType: Record<ItemType, number>;
  /** More open items exist than were counted. */
  readonly openMore: boolean;
  readonly doneMore: boolean;
  /** What the spam filter holds for the sender or a person (ADR-029): the rail shows Held only then. */
  readonly held: number;
  readonly heldMore: boolean;
}

export function countsFrom(open: Page<ItemView>, everything: Page<ItemView>, held?: Page<ItemView>): Counts {
  const byType: Record<ItemType, number> = { message: 0, quote_request: 0, booking: 0, order: 0, refund: 0, stay: 0 };
  const needsByType: Record<ItemType, number> = {
    message: 0,
    quote_request: 0,
    booking: 0,
    order: 0,
    refund: 0,
    stay: 0,
  };
  let needs = 0;
  for (const v of open.items) {
    byType[v.item.type] += 1;
    if (v.item.flags.needsHuman) {
      needs += 1;
      needsByType[v.item.type] += 1;
    }
  }
  return {
    needs,
    all: open.items.length,
    done: everything.items.filter((v) => v.item.closedAt !== null).length,
    byType,
    needsByType,
    openMore: open.next_cursor !== null,
    doneMore: everything.next_cursor !== null,
    held: held?.items.length ?? 0,
    heldMore: (held?.next_cursor ?? null) !== null,
  };
}

/** Whether the rail shows Held: only while something is held, or while the owner is looking at it. */
export function showHeld(counts: Counts | undefined, current: Filter): boolean {
  return current === "held" || (counts?.held ?? 0) > 0;
}

export function countFor(counts: Counts | undefined, filter: Filter): string {
  if (!counts) return "";
  const suffix = (n: number, more: boolean) => (more ? `${n}+` : String(n));
  switch (filter) {
    case "needs":
      return suffix(counts.needs, counts.openMore && counts.needs > 0);
    case "all":
      return suffix(counts.all, counts.openMore);
    case "done":
      return suffix(counts.done, counts.doneMore);
    case "held":
      return counts.held > 0 ? suffix(counts.held, counts.heldMore) : "";
    case "unsent":
    case "spam":
      // Not counted: the rail's counts come from the open items, and Spam shouts nothing.
      return "";
    default:
      return suffix(counts.byType[filter], counts.openMore && counts.byType[filter] > 0);
  }
}
