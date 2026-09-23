import type { NetworkView } from "./types";

/**
 * Words for Settings → Networks. Pure functions, no DOM, so they run in tests on both runtimes.
 * The server checks every origin again; this is only so a typo is caught before the round trip.
 */

/** At most this many networks: the server's limit, repeated so the page can say so first. */
export const MAX_NETWORKS = 8;

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".onion",
  ".test",
  ".invalid",
  ".example",
];

/**
 * What the owner typed, as the origin a network is keyed by, or the sentence that says why not.
 * `network.example.com` is read as `https://network.example.com`; a trailing slash is dropped.
 */
export function parseNetworkOrigin(input: string): { origin: string } | { problem: string } {
  const typed = input.trim();
  if (!typed) return { problem: "Type the network's address, like https://network.example.com." };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { problem: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { problem: "A network is reached over https." };
  if (url.username || url.password) return { problem: "Leave out any user name or password." };
  if (url.port) return { problem: "Leave out the port: a network answers on the standard https port." };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { problem: `Only the address itself: https://${url.hostname}, without a path.` };
  }
  const host = url.hostname.replace(/\.$/, "");
  if (
    !host.includes(".") ||
    host === "localhost" ||
    /^[\d.]+$/.test(host) ||
    host.startsWith("[") ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    return { problem: `${host} is not a public address a network could be at.` };
  }
  return { origin: `https://${host}` };
}

export type NetworkTone = "neutral" | "success" | "warning" | "danger";

/**
 * The one line under each network: "Reporting, last ping 3 min ago", "Not reachable since 14:05",
 * "Off". `detail` is the last error, when the line itself does not already say it.
 */
export function networkStatus(
  n: NetworkView,
  now: number = Date.now(),
  locale?: string,
): { line: string; tone: NetworkTone; detail: string | null } {
  if (!n.enabled) return { line: "Off", tone: "neutral", detail: null };
  if (n.failing_since) {
    return {
      line: `Not reachable since ${sinceWords(n.failing_since, now, locale)}`,
      tone: "danger",
      detail: n.last_error,
    };
  }
  if (n.last_error) return { line: `Not reporting: ${n.last_error}`, tone: "warning", detail: null };
  if (n.registration === "pending") {
    return {
      line: `Waiting for ${hostOf(n.origin)} to verify your domain`,
      tone: "warning",
      detail: n.last_ping_at ? null : "It checks your inbox's address; this can take a few minutes.",
    };
  }
  if (n.last_ping_at) {
    // Pings are hourly; one much older than that means this inbox's own jobs are not running.
    const stale = now - Date.parse(n.last_ping_at) > 2 * 3_600_000;
    return {
      line: `Reporting, last ping ${agoWords(n.last_ping_at, now)}`,
      tone: stale ? "warning" : "success",
      detail: null,
    };
  }
  return { line: "Starting: the first report goes out in a moment", tone: "neutral", detail: null };
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago". */
export function agoWords(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** A time today as "14:05", any other day as "12 Sep, 14:05". */
export function sinceWords(iso: string, now: number = Date.now(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a while";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  if (new Date(now).toDateString() === d.toDateString()) return time;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
  return `${day}, ${time}`;
}

/** "12 receipts published", "3 waiting", "1 refused": only the ones there are. */
export function receiptWords(r: NetworkView["receipts"]): string[] {
  return [
    `${r.published} receipt${r.published === 1 ? "" : "s"} published`,
    r.queued ? `${r.queued} waiting` : null,
    r.refused ? `${r.refused} refused` : null,
  ].filter((s): s is string => s !== null);
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
