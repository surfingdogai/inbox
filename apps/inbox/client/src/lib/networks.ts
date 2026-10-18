import type { NetworkView } from "./types";

/**
 * Words for Settings → Networks. Pure functions, no DOM, so they run in tests on both runtimes.
 * The server checks every origin again; this is only so a typo is caught before the round trip.
 */

/** At most this many networks: the server's limit, repeated so the page can say so first. */
export const MAX_NETWORKS = 8;

/** Why a business is on a network, in one line: what Settings → Networks says first. */
export const NETWORKS_WHY =
  "A network lists you where AI agents search, and keeps your track record: each booking and order, and whether it was kept.";

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
  // Held by the host until the inbox is live at the business's own address: nothing goes to it yet.
  if (n.held) {
    return n.held.on_when_released
      ? { line: "On as soon as your inbox is live at your own address", tone: "neutral", detail: null }
      : { line: "Off, and stays off when your inbox is live", tone: "neutral", detail: null };
  }
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
 * "12 receipts published", "3 waiting", "1 refused", "2 held until the network reads them": only
 * the ones there are. Held ones are receipts a network on older rules is not sent yet — outcomes
 * before rules version 3, agreed changes and refunds before version 6 — which go when it moves to
 * rules that read them.
 */
export function receiptWords(r: NetworkView["receipts"]): string[] {
  const waiting = r.queued - r.held;
  return [
    `${r.published} receipt${r.published === 1 ? "" : "s"} published`,
    waiting > 0 ? `${waiting} waiting` : null,
    r.refused ? `${r.refused} refused` : null,
    r.held ? `${r.held} held until the network reads them` : null,
    r.withheld
      ? `${r.withheld} never sent: the customer${r.withheld === 1 ? "" : "s"} asked us not to use networks`
      : null,
  ].filter((s): s is string => s !== null);
}

/**
 * Which rules the network applies and what that means for what it is sent, in one line, or null
 * before the network has said (ADR-017 §2.5, Amendment 3): from rules version 3 — in force or
 * announced — it gets how each booking and order ended; from version 6 also the changes you and
 * your customers agree and your refunds; before version 3, confirmations and payments only.
 */
export function rulesWords(r: NetworkView["rules"], locale?: string): string | null {
  if (r.version === null) return null;
  const when = r.next_at
    ? ` from ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(r.next_at))}`
    : "";
  if (!r.v2) return `Rules version ${r.version}: it gets confirmations and payments, not yet how they ended.`;
  if (r.version >= 6) {
    return `Rules version ${r.version}: it gets how each booking and order ended, the changes agreed to them, and refunds.`;
  }
  if (r.v6) {
    return `Rules version ${r.version}, version ${r.next}${when}: it gets how each booking and order ended, and already takes the changes agreed to them and refunds. A booking or order that changed goes to it once version ${r.next} is in force.`;
  }
  if (r.version >= 3) return `Rules version ${r.version}: it gets how each booking and order ended.`;
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

/**
 * Whether customers' email addresses go to a network, in the owner's words: only once it has
 * verified the inbox. Null for the network that always could (the default one), which says
 * nothing new.
 */
export function emailWords(n: Pick<NetworkView, "receives_emails" | "registration">): string | null {
  if (n.receives_emails && n.registration !== "registered") return null;
  return `Customers' email addresses go to this network only once it has verified your inbox. Verified: ${n.registration === "registered" ? "yes" : "not yet"}.`;
}

// ---- How agents got on (network protocol §4.15) -----------------------------------------------

type Doors = NonNullable<NetworkView["doors"]>;
type DoorCounts = Doors["doors"][number];

/** The words for a door type, as the owner knows its doors. */
function doorLabel(type: string): string {
  if (type.startsWith("platform:")) return `${type.slice("platform:".length)} door`;
  const known: Record<string, string> = {
    inbox: "Inbox door",
    mcp: "MCP door",
    a2a: "A2A door",
    openapi: "OpenAPI door",
    api: "API door",
    ucp: "UCP door",
    acp: "ACP door",
    nlweb: "NLWeb door",
  };
  return known[type] ?? `${type} door`;
}

/** What went wrong, in a few plain words; the class itself for one this page does not know. */
const CLASS_WORDS: Record<string, string> = {
  "dns.name_not_resolved": "name did not resolve",
  "dns.failed": "name lookup failed",
  "tcp.timed_out": "connection timed out",
  "tcp.refused": "connection refused",
  "tcp.reset": "connection reset",
  "tls.cert.invalid": "certificate not valid",
  "tls.failed": "secure connection failed",
  "http.error": "server error",
  "http.response.invalid": "answer was not valid HTTP",
  abandoned: "answer cut off",
  timeout: "no answer in time",
  "operation.timeout": "never finished",
  "protocol.internal": "internal error",
  "protocol.advertised_missing": "an advertised tool was missing",
  "protocol.version": "protocol version refused",
  "protocol.invalid_answer": "answer did not follow the protocol",
  "protocol.unsigned_answer": "answers not signed",
  "operation.tool_error": "tool error",
  "operation.failed": "operation failed",
  "operation.internal": "internal error in the operation",
  payment_failed: "payment step failed",
  slot_taken: "time taken",
  out_of_stock: "out of stock",
  item_unavailable: "not offered now",
  outside_limits: "outside your limits",
  wrong_state: "not possible at that stage",
  customer_side: "on the customer's side",
  escalation: "handed to a person",
  auth: "sign-in needed",
  person: "the customer had to act",
  "client.invalid_params": "arguments it cannot take",
  "client.parse_error": "JSON that does not parse",
  "client.invalid_request": "requests that are not valid JSON-RPC",
  "client.mcp_headers": "requests with MCP headers missing or wrong",
  "client.mcp_refused": "requests the MCP server refused",
  "client.http": "requests it answered with 4xx",
  "client.rate_limited": "too many requests",
};

export function classWords(cls: string): string {
  return CLASS_WORDS[cls] ?? cls;
}

const RESULT_WORDS: Record<string, string> = {
  ok: "done",
  refused: "refused",
  fail: "failed",
  info: "needed a person",
  invalid: "the agents' own mistakes",
};

/** "12 done, 2 refused, 1 failed" for one window, or null when there was nothing. */
function tally(rows: DoorCounts["reports"], window: "d7" | "d30"): string | null {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.result, (by.get(r.result) ?? 0) + r[window]);
  const parts = ["ok", "refused", "fail", "info", "invalid"].flatMap((k) => {
    const n = by.get(k) ?? 0;
    return n > 0 ? [`${n} ${RESULT_WORDS[k]}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "the last 30 days: 2 connection timed out, 1 server error": what failed, most first. */
function failures(rows: DoorCounts["reports"]): string | null {
  const by = new Map<string, number>();
  for (const r of rows)
    if (r.result === "fail" && r.class && r.d30 > 0) by.set(r.class, (by.get(r.class) ?? 0) + r.d30);
  const list = [...by].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${classWords(c)}`);
  return list.length > 0 ? `What failed in the last 30 days: ${list.join(", ")}.` : null;
}

export interface DoorPanel {
  /** "Counts to 12 Oct. Said 3 min ago." */
  readonly said: string;
  readonly doors: readonly {
    readonly title: string;
    readonly check: { readonly line: string; readonly tone: NetworkTone };
    readonly lines: readonly string[];
  }[];
  /** Open incidents and trouble the network's own reads do not see. */
  readonly alerts: readonly { readonly line: string; readonly tone: NetworkTone }[];
  /** What to fix, in the network's own plain lines. */
  readonly fixes: readonly string[];
}

/**
 * What an incident's public_from means for the listing: shown already when that day has come (the
 * network sets it to the day the incident opened when the door's state is public at once), a
 * condition on a later day, and nothing when the network shows nothing of it yet.
 */
function publicWords(publicFrom: string | null | undefined, asOf: string, locale?: string): string {
  if (!publicFrom) return "";
  if (publicFrom <= asOf) return " It shows on your listing as failing.";
  return ` If it still holds on ${dayWords(publicFrom, locale)}, it shows on your listing.`;
}

/**
 * "How agents got on": what a network's answer to the last signed ping said about the business's own
 * doors (network protocol §4.15), in the owner's words. Each count says what proved it: signed by the
 * business's own door, or from agents the network cannot tell apart; the network's own check is said
 * apart. Null while no network has said anything.
 */
export function doorPanel(n: NetworkView, now: number = Date.now(), locale?: string): DoorPanel | null {
  const d = n.doors;
  if (!n.enabled || !d) return null;
  const when = (iso: string) => sinceWords(iso, now, locale);
  const doors = d.doors.map((door) => {
    const title = `${doorLabel(door.type)} · ${shortUrl(door.url)}`;
    const check = checkLine(door, when);
    const lines: string[] = [];
    for (const [proof, label] of [
      ["token", "Signed by your door"],
      ["none", "Agents the network cannot tell apart"],
    ] as const) {
      const rows = door.reports.filter((r) => r.proof === proof);
      const week = tally(rows, "d7");
      const month = tally(rows, "d30");
      if (month) lines.push(`${label}: ${week ?? "nothing"} in the last 7 days; ${month} in 30.`);
    }
    const failed = failures(door.reports);
    if (failed) lines.push(failed);
    const faults = new Map<string, number>();
    for (const r of door.reports) {
      if (r.result !== "invalid" || r.d30 === 0) continue;
      const key = `${r.tool ?? r.op}\u0000${r.class ?? ""}`;
      faults.set(key, (faults.get(key) ?? 0) + r.d30);
    }
    for (const [key, count] of faults) {
      const [what, cls] = key.split("\u0000") as [string, string];
      lines.push(
        `Agents sent ${what} ${cls ? classWords(cls) : "requests it could not take"} ${count} time${count === 1 ? "" : "s"} in 30 days.`,
      );
    }
    if (door.platforms.length > 0) {
      lines.push(`Agents from ${door.platforms.map(hostOf).join(", ")} used it.`);
    }
    const notReproduced = door.not_reproduced ?? 0;
    if (notReproduced > 0) {
      lines.push(
        `Agents reported it down; the network checked it ${notReproduced} time${notReproduced === 1 ? "" : "s"} for that in 7 days and found it answering.`,
      );
    }
    if (lines.length === 0) lines.push("No agent has reported on it in the last 30 days.");
    return { title, check, lines };
  });
  const alerts = [
    ...d.incidents.map((i) => ({
      line: `${doorLabel(i.type)}: ${classWords(i.class)}, since ${when(i.opened_at)}. ${
        i.reproduced ? "The network's own check saw it too." : "The network's own check has not seen it."
      }${publicWords(i.public_from, d.as_of, locale)}`,
      tone: "danger" as NetworkTone,
    })),
    ...d.trouble.map((t) => ({
      line: `Agents report trouble at your ${doorLabel(t.type)} that the network's own check does not see, since ${when(t.since)}.`,
      tone: "warning" as NetworkTone,
    })),
  ];
  return {
    said: `Counts to ${dayWords(d.as_of, locale)}. Said ${agoWords(d.at, now)}.`,
    doors,
    alerts,
    fixes: d.fixes.map((f) => f.text),
  };
}

function checkLine(door: DoorCounts, when: (iso: string) => string): { line: string; tone: NetworkTone } {
  if (door.status === "gone") {
    return { line: "Gone: the network's check has failed for 30 days, and it no longer shows it.", tone: "danger" };
  }
  const c = door.checked;
  if (door.status === "failing") {
    return {
      line: `Failing: the network's check could not use it${c ? ` (last tried ${when(c.at)})` : ""}. It counts for nothing until a check works.`,
      tone: "danger",
    };
  }
  if (!c) return { line: "Not checked by the network yet.", tone: "neutral" };
  if (c.result === "good") return { line: `It answered the network's check, ${when(c.at)}.`, tone: "success" };
  if (c.result === "blocked") {
    return {
      line: `The network's check was blocked, ${when(c.at)} (a 403, a 429 or a challenge page). That is never a failure, but the network cannot vouch for the door while it is blocked.`,
      tone: "warning",
    };
  }
  return { line: `The network's check failed, ${when(c.at)}; it tries again soon.`, tone: "warning" };
}

/** The door's host and path, without the scheme: "bakery.example/mcp". */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** Why a carried request did not arrive, in the owner's words (ADR-020). */
const CARRIED_WHY: Record<string, string> = {
  switched_off: "you had them switched off",
  failed: "your inbox could not be reached",
  busy: "your inbox asked for a pause",
  refused: "your inbox refused them",
  not_taken: "a kind of request you do not take",
  elsewhere: "a kind you take somewhere else",
  no_inbox: "your inbox could not be found",
};

/**
 * What a network says assistants tried, through it, over its last 30 days: the requests it carried
 * here, the bookings waiting for the person to confirm a price, and the ones that did not arrive and
 * why. Only this inbox is told; null when the network said nothing, or nothing happened.
 */
export function carriedWords(n: Pick<NetworkView, "enabled" | "carried">): string | null {
  const c = n.carried;
  if (!n.enabled || !c) return null;
  const many = (k: number, one: string, more: string) => `${k} ${k === 1 ? one : more}`;
  const missed = Object.entries(c.not_delivered).filter(([, k]) => k > 0);
  const lost = missed.reduce((sum, [, k]) => sum + k, 0);
  if (c.delivered + c.confirm + lost === 0) return null;
  const parts: string[] = [];
  if (c.delivered) parts.push(`${many(c.delivered, "request", "requests")} delivered`);
  if (c.confirm) parts.push(`${many(c.confirm, "booking", "bookings")} shown to the person to confirm the price`);
  if (lost) {
    const why = missed.map(([k]) => CARRIED_WHY[k] ?? k.replaceAll("_", " ")).join("; ");
    parts.push(`${lost} did not arrive (${why})`);
  }
  return `Assistants tried to reach you through it in the last 30 days: ${parts.join(", ")}.`;
}
