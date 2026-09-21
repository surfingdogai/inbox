import type { ItemType, ItemView, ListParams, Page } from "./types";

/** The rail: what the owner should look at, everything open, one type, or what is done. */
export type Filter = "needs" | "all" | "done" | ItemType;

export const FILTERS: readonly { readonly key: Filter; readonly label: string; readonly type?: ItemType }[] = [
  { key: "needs", label: "Needs you" },
  { key: "all", label: "All" },
  { key: "booking", label: "Bookings", type: "booking" },
  { key: "order", label: "Orders", type: "order" },
  { key: "quote_request", label: "Quotes", type: "quote_request" },
  { key: "message", label: "Messages", type: "message" },
  { key: "refund", label: "Refunds", type: "refund" },
  { key: "done", label: "Done" },
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
  /** More open items exist than were counted. */
  readonly openMore: boolean;
  readonly doneMore: boolean;
}

export function countsFrom(open: Page<ItemView>, everything: Page<ItemView>): Counts {
  const byType: Record<ItemType, number> = { message: 0, quote_request: 0, booking: 0, order: 0, refund: 0 };
  let needs = 0;
  for (const v of open.items) {
    byType[v.item.type] += 1;
    if (v.item.flags.needsHuman) needs += 1;
  }
  return {
    needs,
    all: open.items.length,
    done: everything.items.filter((v) => v.item.closedAt !== null).length,
    byType,
    openMore: open.next_cursor !== null,
    doneMore: everything.next_cursor !== null,
  };
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
    default:
      return suffix(counts.byType[filter], counts.openMore && counts.byType[filter] > 0);
  }
}
