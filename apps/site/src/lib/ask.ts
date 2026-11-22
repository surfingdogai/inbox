/**
 * What the one box on the home page decides, and what the live counts say. Pure functions, so the
 * site's tests can hold them to their word without a browser.
 */

/**
 * True when what was typed is a web address rather than words: one token, no spaces, with a dot and
 * a name after it ("salon.example", "https://shop.example/menu", "café.example"). Words, even with a
 * full stop at the end ("bakery."), are a search.
 */
export function looksLikeAddress(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  const host = s
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, "");
  if (!host) return false;
  return /^([\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}$/u.test(host);
}

/**
 * What a link to the home page with ?url= asks of the box (surfingdog.ai/?url=kllrcoffee.com): the
 * value to show in it, and, when it is a web address, the checker's own link to go to, which starts
 * the check when a person's browser opens it and only fills the field for a crawler, a preview or a
 * prefetch (the network's /check?url=). Null when the link names nothing to show.
 */
export function linkCheck(search: string): { value: string; go: string | null } | null {
  const value = (new URLSearchParams(search).get("url") ?? "").trim();
  if (!value || value.length > 200) return null;
  return { value, go: looksLikeAddress(value) ? `/check?url=${encodeURIComponent(value)}` : null };
}

/** The "directory" block of GET /v1/stats: aggregates, never a name or a domain. */
export interface DirectoryStats {
  checked: number;
  agent_ready: number;
  /**
   * Of the agent-ready, the real businesses (`real_businesses_verified`, since the listing rules of 19 October 2026: a
   * member, registered or claimed, or a site the network's crawler matched to its entry on public maps or in a business
   * register). Null from a network that does not count them, while it does not apply the rules, and when it counts none:
   * a 0 is never shown.
   */
  real: number | null;
  capabilities: Partial<Record<CapabilityKey, number>>;
  /**
   * The public listings an assistant can book or order from through the business's own page on its booking or
   * ordering software (`by_own_link`): most of them are not agent-ready, so `agent_ready` and the capability counts
   * leave them out. Null from a network that does not count them, and when it counts none.
   */
  byOwnLink: { listed: number; book: number; order: number } | null;
  /**
   * Every business an assistant can book or order from (`book_or_order`, the home page's headline since 22 November
   * 2026): the agent-ready that take bookings or orders through a door on their own site, together with the public
   * listings `by_own_link` counts, each business once. `book` and `order` count the same for bookings and for orders.
   * Null from a network that does not send it yet, when it counts none, and when the three do not hold together: a
   * total below either part, or above both parts added up.
   */
  bookOrOrder: { total: number; book: number; order: number } | null;
  as_of: string;
}

export type CapabilityKey =
  | "message"
  | "book"
  | "order"
  | "signup"
  | "cancel"
  | "change"
  | "negotiate"
  | "catalogue"
  | "availability"
  | "pay"
  | "track"
  | "return";

/** What the home page counts, in this order. `always` rows show even at 0; the others only once
 *  a business does it, so an empty line never sits there. */
export const COUNTED: readonly { key: CapabilityKey; label: string; always: boolean }[] = [
  { key: "message", label: "take messages", always: true },
  { key: "book", label: "take bookings", always: true },
  { key: "order", label: "take orders", always: true },
  { key: "signup", label: "sign up", always: false },
  { key: "catalogue", label: "have a catalogue", always: true },
  { key: "pay", label: "take payment", always: true },
  { key: "cancel", label: "let an agent cancel", always: false },
  { key: "negotiate", label: "negotiate", always: false },
];

/**
 * Where each count leads: the network's list of the businesses it counts (GET /leaderboard on this same address).
 * "businesses checked" is the board of every kind, "agent-ready" the list of every agent-ready business, and each
 * capability the agent-ready businesses that can do it, of every kind: the same businesses the count counts, so the
 * list names them, or says how many more it counts and does not name.
 */
export const CHECKED_HREF = "/leaderboard";
export const READY_HREF = "/leaderboard?ready=1";
export const REAL_HREF = "/leaderboard?real=1";
export function countHref(key: CapabilityKey): string {
  return `/leaderboard?can=${key}`;
}

/**
 * The directory's lists of the businesses an assistant can book or order from (`book_or_order`), on the network at
 * /businesses on this same address: every one of them (the headline), those it can book (`?can=book`) and those it can
 * order from (`?can=order`). Each is the same businesses as its count: the agent-ready that do it through a door on
 * their own site, and the listings with their own booking or ordering page. They are directory lists, not leaderboards:
 * by the published rules a leaderboard names the agent-ready alone and reads no booking link, so /leaderboard?can=book
 * stays the agent-ready that take bookings.
 */
export const BOOK_OR_ORDER_HREF = "/businesses";
export function bookOrOrderHref(key: "book" | "order"): string {
  return `/businesses?can=${key}`;
}

/** The headline's words beside its number, at rest and once the network counts them. */
export const BOOK_OR_ORDER_LABEL = "businesses an assistant can book or order from";

/** Counts taken before this are no counts: the network sends the zero time when it has none yet. */
const EARLIEST = Date.parse("2026-01-01T00:00:00Z");

/**
 * The block, when it is there, whole and real; anything else is null, so the page says so rather
 * than guess. A degraded API with nothing checked, or counts from before 2026 (the zero time), are
 * zeros the network could not take, not a count of zero.
 */
export function readDirectory(stats: unknown): DirectoryStats | null {
  if (!stats || typeof stats !== "object") return null;
  const d = (stats as { directory?: unknown }).directory;
  const api = (stats as { status?: { api?: unknown } }).status?.api;
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!n(o.checked) || !n(o.agent_ready) || typeof o.as_of !== "string") return null;
  const at = Date.parse(o.as_of);
  if (Number.isNaN(at) || at < EARLIEST) return null;
  if (api === "degraded" && o.checked === 0) return null;
  const caps: Partial<Record<CapabilityKey, number>> = {};
  if (o.capabilities && typeof o.capabilities === "object") {
    for (const [k, v] of Object.entries(o.capabilities as Record<string, unknown>)) {
      if (n(v)) caps[k as CapabilityKey] = v as number;
    }
  }
  const l = o.by_own_link && typeof o.by_own_link === "object" ? (o.by_own_link as Record<string, unknown>) : null;
  const byOwnLink =
    l && n(l.listed) && n(l.book) && n(l.order) && (l.listed as number) > 0
      ? { listed: l.listed as number, book: l.book as number, order: l.order as number }
      : null;
  const b =
    o.book_or_order && typeof o.book_or_order === "object" ? (o.book_or_order as Record<string, unknown>) : null;
  const bookOrOrder =
    b && n(b.total) && n(b.book) && n(b.order) && holds(b.total as number, b.book as number, b.order as number)
      ? { total: b.total as number, book: b.book as number, order: b.order as number }
      : null;
  return {
    checked: o.checked as number,
    agent_ready: o.agent_ready as number,
    real:
      n(o.real_businesses_verified) && (o.real_businesses_verified as number) > 0
        ? (o.real_businesses_verified as number)
        : null,
    capabilities: caps,
    byOwnLink,
    bookOrOrder,
    as_of: o.as_of,
  };
}

/**
 * Whether a count of those an assistant can book or order from holds with its parts: some counted, none fewer than
 * those it can book or those it can order from, none more than both added up (each business is one of them, or both).
 */
function holds(total: number, book: number, order: number): boolean {
  return total > 0 && total >= book && total >= order && total <= book + order;
}

/** The line under the counts: "51,291 businesses an assistant can book or order from through their own booking or
 *  ordering page." Said only from a count the network sent. */
export function ownLinkLine(x: { listed: number }, format: (n: number) => string): string {
  return x.listed === 1
    ? "One business an assistant can book or order from through its own booking or ordering page."
    : `${format(x.listed)} businesses an assistant can book or order from through their own booking or ordering page.`;
}

/**
 * The headline: how many, in what words, and the list of the same businesses. Every business an assistant can book or
 * order from, once the network counts them; from a network that does not yet, the agent-ready, as before.
 */
export function headline(d: DirectoryStats): { n: number; label: string; href: string } {
  const b = d.bookOrOrder;
  if (!b) return { n: d.agent_ready, label: "agent-ready businesses", href: READY_HREF };
  return {
    n: b.total,
    label: b.total === 1 ? "business an assistant can book or order from" : BOOK_OR_ORDER_LABEL,
    href: BOOK_OR_ORDER_HREF,
  };
}

/** A count under the headline: what it counts, how many, and the list of the same businesses. */
export interface CountRow {
  key: CapabilityKey | "ready";
  label: string;
  n: number;
  href: string;
}

/**
 * The rows to show, from the block. From a network that counts every business an assistant can book or order from,
 * the agent-ready come first, as a count of their own, and bookings and orders count those an assistant can book or
 * order from, with the lists of the same businesses; every other row counts the agent-ready that do it. From one that
 * does not yet, every row counts the agent-ready, as before.
 */
export function countRows(d: DirectoryStats): CountRow[] {
  const b = d.bookOrOrder;
  const rows = COUNTED.map((c) => {
    const withPages = b && (c.key === "book" || c.key === "order") ? c.key : null;
    return {
      key: c.key,
      label: c.label,
      n: b && withPages ? b[withPages] : (d.capabilities[c.key] ?? 0),
      href: withPages ? bookOrOrderHref(withPages) : countHref(c.key),
      always: c.always,
    };
  })
    .filter((r) => r.always || r.n > 0)
    .map(({ key, label, n, href }): CountRow => ({ key, label, n, href }));
  return b ? [{ key: "ready", label: "agent-ready", n: d.agent_ready, href: READY_HREF }, ...rows] : rows;
}

/**
 * How many of the businesses an assistant can book or order from are listed with their own booking or ordering page:
 * every listing `by_own_link` counts is one of them, counted in the same pass. Null without both counts, and when it
 * would only repeat the headline: every one of them.
 */
function ownPageCount(d: DirectoryStats): number | null {
  const b = d.bookOrOrder;
  const l = d.byOwnLink;
  return b && l && l.listed < b.total ? l.listed : null;
}

/** The quiet line right under the headline: "103,670 of them through their own booking or ordering page". */
export function ownPageLine(d: DirectoryStats, format: (n: number) => string): string | null {
  const n = ownPageCount(d);
  if (n === null) return null;
  return n === 1
    ? "One of them through its own booking or ordering page"
    : `${format(n)} of them through their own booking or ordering page`;
}

/** A count as the page paints it: its row, and what a screen reader hears for its link. */
export interface CountLink extends CountRow {
  /**
   * The link's name: the words the page shows, final number first, then, once the network counts those an assistant
   * can book or order from, whose count it is ("1,210 take messages, of the agent-ready businesses").
   */
  name: string;
}

/** What the counts show, from one answer: the page paints it, and a screen reader hears `said`, once. */
export interface CountsView {
  head: { n: number; label: string; href: string };
  /** The quiet line right under the headline; null for none. */
  via: string | null;
  rows: CountLink[];
  /** The rows' name for a screen reader; null for none, where the row holds two groups and each link names its own. */
  rowsLabel: string | null;
  /** The line under the rows, from a network that does not count book_or_order yet; null for none. */
  links: string | null;
  /** The note's words, before how long ago the counts were taken. */
  note: string;
  /** The final numbers in words, for the live region. */
  said: string;
}

/**
 * Everything the counts say, from the block. From a network that does not send `book_or_order` yet, the page as it was
 * before 22 November 2026, word for word: the agent-ready as the headline, every row of them, and the own-link line
 * under the rows.
 *
 * Otherwise the row holds two groups. Bookings and orders count the headline's businesses; the agent-ready are not all
 * among them, and messages, a catalogue and payment count the agent-ready alone. The page shows the row as it is, and
 * a screen reader hears whose count each one is. Each link's name says it after the words the page shows, and the
 * live region groups the counts as the network's /check line does: "207,100 businesses an assistant can book or order
 * from. Of them, 86,120 take bookings and 127,300 take orders; 103,670 through their own booking or ordering page.
 * 108,566 businesses are agent-ready. Of those, 1,210 take messages, 2,306 have a catalogue, 349 take payment."
 */
export function countsView(d: DirectoryStats, format: (n: number) => string): CountsView {
  const head = headline(d);
  const top = `${format(head.n)} ${head.label}.`;
  const words = (r: CountRow) => `${format(r.n)} ${r.label}`;
  if (!d.bookOrOrder) {
    const rows = countRows(d).map((r) => ({ ...r, name: words(r) }));
    const links = d.byOwnLink ? ownLinkLine(d.byOwnLink, format) : null;
    return {
      head,
      via: null,
      rows,
      rowsLabel: "Of the agent-ready businesses",
      links,
      note: "Of the agent-ready businesses · updated ",
      said: `${top}${rows.length ? ` Of them, ${rows.map(words).join(", ")}.` : ""}${links ? ` ${links}` : ""}`,
    };
  }
  const ofHead = (r: CountRow) => r.key === "book" || r.key === "order";
  const rows = countRows(d).map((r) => ({
    ...r,
    name:
      r.key === "ready"
        ? `${format(r.n)} agent-ready ${r.n === 1 ? "business" : "businesses"}`
        : `${words(r)}, of the ${ofHead(r) ? "businesses an assistant can book or order from" : "agent-ready businesses"}`,
  }));
  const own = ownPageCount(d);
  const ofThem = [
    rows.filter(ofHead).map(words).join(" and "),
    own === null
      ? ""
      : own === 1
        ? "one through its own booking or ordering page"
        : `${format(own)} through their own booking or ordering page`,
  ].filter(Boolean);
  const ready = rows.find((r) => r.key === "ready");
  const ofThose = rows.filter((r) => r.key !== "ready" && !ofHead(r)).map(words);
  const said = [top];
  if (ofThem.length) said.push(`Of them, ${ofThem.join("; ")}.`);
  if (ready) {
    said.push(ready.n === 1 ? "1 business is agent-ready." : `${format(ready.n)} businesses are agent-ready.`);
    if (ofThose.length) said.push(`Of those, ${ofThose.join(", ")}.`);
  }
  return {
    head,
    via: ownPageLine(d, format),
    rows,
    rowsLabel: null,
    links: null,
    note: "Live counts from the network · updated ",
    said: said.join(" "),
  };
}

/**
 * The agent-ready businesses that are not among the real businesses verified: how many, and whether most of them sell
 * online, for the home page's one line under the counts. Null while the network does not count the real businesses,
 * and when it counts them all, so the line never shows a number it did not read.
 *
 * "Most sell online" is said only while the counts themselves prove that most of them take orders through an agent
 * door: the agent-ready businesses that take no orders are agent_ready − order, and at most all of those are among
 * them, so at least them − (agent_ready − order) of them take orders. It says what that count proves and nothing
 * more: not "online shops", which /v1/stats does not count (on 31 October 2026 the floor was 97% of them, and a
 * one-off count found 96% of them in the directory's online-shops group). Without an orders count it is not said.
 */
export function notYetReal(d: DirectoryStats): { n: number; mostSellOnline: boolean } | null {
  if (d.real === null || d.real >= d.agent_ready) return null;
  const n = d.agent_ready - d.real;
  const order = d.capabilities.order;
  const takeNoOrders = typeof order === "number" ? Math.max(0, d.agent_ready - order) : n;
  return { n, mostSellOnline: (n - takeNoOrders) * 2 > n };
}

/** The line itself: "36,848 of the agent-ready are not yet confirmed as real local businesses: most sell online." */
export function notYetRealLine(x: { n: number; mostSellOnline: boolean }, format: (n: number) => string): string {
  const head =
    x.n === 1
      ? "One of the agent-ready is not yet confirmed as a real local business"
      : `${format(x.n)} of the agent-ready are not yet confirmed as real local businesses`;
  return x.mostSellOnline && x.n > 1 ? `${head}: most sell online.` : `${head}.`;
}

/** "just now", "6 minutes ago", "2 hours ago", "3 days ago": how old the counts are, in plain words. */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86400), "day");
}
