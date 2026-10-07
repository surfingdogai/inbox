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

/** The "directory" block of GET /v1/stats: aggregates, never a name or a domain. */
export interface DirectoryStats {
  checked: number;
  agent_ready: number;
  capabilities: Partial<Record<CapabilityKey, number>>;
  as_of: string;
}

export type CapabilityKey =
  | "message"
  | "book"
  | "order"
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
  { key: "catalogue", label: "have a catalogue", always: true },
  { key: "pay", label: "take payment", always: true },
  { key: "cancel", label: "let an agent cancel", always: false },
  { key: "negotiate", label: "negotiate", always: false },
];

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
  return {
    checked: o.checked as number,
    agent_ready: o.agent_ready as number,
    capabilities: caps,
    as_of: o.as_of,
  };
}

/** The rows to show, from the block. */
export function countRows(d: DirectoryStats): { key: CapabilityKey; label: string; n: number }[] {
  return COUNTED.map((c) => ({ key: c.key, label: c.label, n: d.capabilities[c.key] ?? 0, always: c.always }))
    .filter((r) => r.always || r.n > 0)
    .map(({ key, label, n }) => ({ key, label, n }));
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
