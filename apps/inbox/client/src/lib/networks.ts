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

/**
 * "12 receipts published", "3 waiting", "1 refused", "2 outcomes held until the network reads
 * them": only the ones there are. Held ones are acceptances and outcomes a network on older rules
 * is not sent yet; they go when it moves to rules that read them.
 */
export function receiptWords(r: NetworkView["receipts"]): string[] {
  const waiting = r.queued - r.held;
  return [
    `${r.published} receipt${r.published === 1 ? "" : "s"} published`,
    waiting > 0 ? `${waiting} waiting` : null,
    r.refused ? `${r.refused} refused` : null,
    r.held ? `${r.held} outcome${r.held === 1 ? "" : "s"} held until the network reads them` : null,
  ].filter((s): s is string => s !== null);
}

/**
 * Which rules the network applies and what that means for what it is sent, in one line, or null
 * before the network has said (ADR-017 §2.5): from rules version 3 — in force or announced — it
 * gets how each booking and order ended; before that, confirmations and payments only.
 */
export function rulesWords(r: NetworkView["rules"], locale?: string): string | null {
  if (r.version === null) return null;
  if (!r.v2) return `Rules version ${r.version}: it gets confirmations and payments, not yet how they ended.`;
  if (r.version >= 3) return `Rules version ${r.version}: it gets how each booking and order ended.`;
  const when = r.next_at
    ? ` from ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(r.next_at))}`
    : "";
  return `Rules version ${r.version}, version ${r.next}${when}: it already gets how each booking and order ended.`;
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const TIER_WORDS: Record<string, string> = { new: "New", building: "Building a record", trusted: "Trusted" };

/** "New", "Building a record", "Trusted": a network's tier in words (ADR-017 §5.3). */
export function tierWord(tier: string): string {
  return TIER_WORDS[tier] ?? tier;
}

/**
 * Your own standing at a network, in one line, and how sure the page can be of it (ADR-017 §7.3):
 * what the network said to the last signed ping, and when; or why there is nothing to show. Null
 * for a network that is off or has not been pinged yet.
 *
 *   "Trusted: score 0.82, sorted before the newcomers. Said 3 min ago."
 *   "New: no score yet. Scores start with rules version 3, on 9 Oct."
 *   "Shows once your inbox can sign its ping: it needs INBOX_SECRET_KEY."
 */
export function standingWords(
  n: NetworkView,
  now: number = Date.now(),
  locale?: string,
): { line: string; tone: NetworkTone } | null {
  if (!n.enabled) return null;
  const s = n.standing;
  if (s) {
    const said = ` Said ${agoWords(s.at, now)}.`;
    if (s.tier === "new" && s.score === 0) {
      const scoresFrom =
        n.rules.version !== null && n.rules.version < 3 && n.rules.next !== null && n.rules.next >= 3
          ? ` Scores start with rules version ${n.rules.next}${n.rules.next_at ? `, on ${dayWords(n.rules.next_at, locale)}` : ""}.`
          : " Kept bookings and orders build it.";
      return { line: `New: no score yet.${scoresFrom}${said}`, tone: "neutral" };
    }
    const order = s.ranked ? "sorted before the newcomers" : "shuffled with the newcomers until it reaches 0.40";
    return {
      line: `${tierWord(s.tier)}: score ${s.score.toFixed(2)}, ${order}.${said}`,
      tone: s.tier === "trusted" ? "success" : "neutral",
    };
  }
  switch (n.ping_signature) {
    case null:
    case "verified":
      return null;
    case "unsigned":
      return {
        line: "Your standing shows here once your inbox can sign its ping: it needs INBOX_SECRET_KEY.",
        tone: "neutral",
      };
    case "ignored":
      return { line: "This network does not tell an inbox its standing.", tone: "neutral" };
    case "refused":
      return { line: "This network does not take signed pings; it gets unsigned ones, as before.", tone: "neutral" };
    default:
      return {
        line: `The network could not check your inbox's signature (${n.ping_signature.replace(/^invalid: /, "").replace(/_/g, " ")}); it took the ping unsigned.`,
        tone: "warning",
      };
  }
}

/** "9 Oct": a day in UTC, as the rules name it. */
function dayWords(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}
