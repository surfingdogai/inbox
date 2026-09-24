import { type CallerEnv, ensureNetworkPing } from "@surfingdog/adapters";
import {
  type Db,
  ensureJob,
  ensureLifecycleSweep,
  type JobHandler,
  type RuleDefinition,
  schema,
  ulid,
} from "@surfingdog/core";
import { LOCAL_SENDER, type MailOut, type OutboundMail } from "@surfingdog/platform";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { DEMO_SHOP_DOMAIN, type SeedDeps, seedShowcase } from "./seed";

/**
 * A public demo shop (INBOX_DEMO=1): an instance anyone's AI can book with, to see the inbox work.
 *
 * Anyone can type anyone's email address into a booking, so a demo must never become a way to email
 * strangers, and it must never speak for anyone to a network. So in a demo:
 *
 * - nothing is emailed to a customer, and the owner gets no email per item: every notification,
 *   reply, code and key email goes to a transport that delivers nothing (`silentMailOut`);
 * - the only mail that leaves is a sign-in link or the nightly summary, and only to an address in
 *   INBOX_OWNER_EMAIL (`ownerOnlyMailOut`);
 * - no network is ever called: network and first-contact jobs do nothing, and their fetch refuses;
 * - no webhook is ever sent, so nothing a tester typed leaves by that door either;
 * - rules answer, so a booking with a free slot is confirmed and a small order accepted in a second;
 * - limits are tighter, with a bucket every caller shares on top of each one's own, and a request's
 *   body is small;
 * - every night the shop sends its owner one summary, then wipes itself and seeds itself again;
 * - `GET /demo/live` shows what is happening, and never a name, an address, a phone or a word anyone wrote.
 *
 * It only ever starts on an empty database, and only ever wipes the shop it seeded itself. An
 * instance that already holds anything is refused: no live view, nothing wiped, and the Node server
 * will not start. Its mail stays off while INBOX_DEMO is set, since that is what the flag promises.
 */
export interface DemoOptions {
  /** INBOX_OWNER_EMAIL: the only addresses a demo ever emails (sign-in links, the nightly summary). */
  readonly ownerEmails: readonly string[];
  /** The summary's sender, for a transport without one of its own (MAIL_FROM, MAIL_FROM_NAME). */
  readonly from?: { readonly address: string; readonly name?: string | undefined } | undefined;
}

/** Whether an environment flag is on: `1`, `true`, `yes` or `on`. */
export function flagOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

// ---- mail and network --------------------------------------------------------------------

/**
 * Takes every email and sends none. `delivers: false`, so the mail log says each one was not sent
 * (`no_service`) and no item ever claims a customer was told something.
 */
export function silentMailOut(): MailOut {
  return {
    sender: LOCAL_SENDER,
    delivers: false,
    async send() {
      return { messageId: `demo-${crypto.randomUUID()}` };
    },
  };
}

/** Header names that could carry a message to someone besides its `to`. */
const RECIPIENT_HEADERS = /^(to|cc|bcc|resent-to|resent-cc|resent-bcc)$/i;

/**
 * Hands a message to `inner` only when every recipient is one of `owners`; anything else is
 * dropped, with a line in the log that names no address. A message from the placeholder sender (the
 * sign-in link's `inbox@localhost`) goes out from `from` when there is one (MAIL_FROM), since a real
 * mail service refuses to send from localhost and the owner would never get their link.
 */
export function ownerOnlyMailOut(
  inner: MailOut,
  owners: readonly string[],
  log: (line: string) => void = console.log,
  from?: DemoOptions["from"],
): MailOut {
  const allowed = new Set(owners.map((e) => e.trim().toLowerCase()).filter(Boolean));
  return {
    ...(inner.sender ? { sender: inner.sender } : {}),
    ...(inner.delivers === false ? { delivers: false } : {}),
    async send(mail: OutboundMail) {
      const toOwners = mail.to.length > 0 && mail.to.every((to) => allowed.has(to.trim().toLowerCase()));
      const extra = Object.keys(mail.headers ?? {}).some((h) => RECIPIENT_HEADERS.test(h));
      if (!toOwners || extra) {
        log("demo: an email to an address that is not the owner's was not sent");
        return { messageId: "" };
      }
      if (from && mail.from.address === LOCAL_SENDER.address) {
        const name = mail.from.name ?? from.name;
        return inner.send({ ...mail, from: { address: from.address, ...(name ? { name } : {}) } });
      }
      return inner.send(mail);
    },
  };
}

/** A demo's fetch for anything that would reach a network: it refuses, every time. */
export const noNetworkFetch = (async () => {
  throw new Error("demo: this instance contacts no network");
}) as unknown as typeof fetch;

/** What a demo's network and first-contact jobs do instead: nothing, and they say so. */
export const noNetworkHandler: JobHandler = async () => ({ note: "demo: no network is contacted" });

/**
 * What a demo's webhook jobs do instead. A webhook carries the customer's name, address and words to
 * any URL, and in a demo those are whatever a stranger typed about whomever they liked.
 */
export const noWebhookHandler: JobHandler = async () => ({ note: "demo: no webhook is sent" });

/** The largest request body a demo reads: a booking, an order or a message fits many times over. */
export const DEMO_MAX_BODY = 64 * 1024;

// ---- the shop ----------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The job that sends the summary, wipes and seeds again, once a day. */
export const DEMO_NIGHTLY_KIND = "demo_nightly";
/** It runs at 03:00 UTC, when Europe is asleep. */
export const NIGHTLY_AT_MS = 3 * HOUR;

/** The next nightly run strictly after `now`. */
export function nextNightly(now: number): number {
  const today = Math.floor(now / DAY) * DAY + NIGHTLY_AT_MS;
  return today > now ? today : today + DAY;
}

/**
 * Tables the nightly wipe keeps: who may sign in as the owner and their keys, the receipt-signing
 * keys, the rate-limit buckets (a wipe is not a way round a limit) and the migrations. `jobs` is
 * emptied but for the nightly chain itself. Everything else, including any table added later, goes.
 */
export const DEMO_KEEP: ReadonlySet<string> = new Set([
  "migrations",
  "users",
  "sessions",
  "login_tokens",
  "passkeys",
  "api_keys",
  "oauth_clients",
  "oauth_codes",
  "oauth_tokens",
  "signing_keys",
  "rate_limits",
  "jobs",
]);

/**
 * The demo's own rule, added after the showcase's week of history is in place: small orders are
 * accepted at once, so a tester sees an order accepted. The showcase's own rule still flags large ones.
 */
const DEMO_RULES: { name: string; priority: number; definition: RuleDefinition }[] = [
  {
    name: "Accept orders up to €200 at once",
    priority: 85,
    definition: {
      on: ["item.created"],
      if: {
        all: [
          { path: "item.type", op: "eq", value: "order" },
          { path: "item.flags.sandbox", op: "neq", value: true },
          { path: "item.payload.totalPrice.value", op: "lte", value: 20_000 },
        ],
      },
      actions: [{ action: "transition", event: "accept", reason: "auto-accepted: under the approval limit" }],
      stop: true,
      maxRunsPerItem: 1,
    },
  },
];

/**
 * Room at every service for every tester who asks for Saturday morning. A 90-minute service holds
 * its place across overlapping start times, so four hours hold only about twice the capacity: at 12,
 * thirty testers (or one script) filled Saturday morning and every AI after them heard "fully
 * booked" until the night. At this size it takes more new items than every caller together may
 * create in an hour (`DEMO_SHARED.create`).
 */
export const DEMO_CAPACITY = 500;

/** Whether this instance's business is the demo shop, the only one a demo ever wipes. */
export async function isDemoShop(db: Db): Promise<boolean> {
  const [row] = await db.orm
    .select({ domain: schema.business.domain })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  return row?.domain === DEMO_SHOP_DOMAIN;
}

/** Whether the instance holds nothing a person could have put there: no business, item, customer or catalogue. */
export async function isEmptyInstance(db: Db): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT EXISTS (SELECT 1 FROM business) OR EXISTS (SELECT 1 FROM items) OR EXISTS (SELECT 1 FROM parties)
             OR EXISTS (SELECT 1 FROM services) OR EXISTS (SELECT 1 FROM products)`,
    method: "all",
  });
  return Number(rows[0]?.[0]) === 0;
}

/** Why a demo will not start on this instance, in the operator's words. */
export const DEMO_REFUSED =
  "INBOX_DEMO is on, but this database already holds data the demo did not create. The demo only starts on an " +
  "empty database, so nothing here is shown or wiped. Unset INBOX_DEMO, or point the demo at an empty database.";

/** The showcase, as a demo: no mail, no network, a rule that accepts small orders, room for everyone. */
export async function seedDemoShop(
  db: Db,
  now: number,
  deps: SeedDeps = {},
): Promise<{ seeded: boolean; items: number }> {
  const r = await seedShowcase(db, now, deps, { demo: true });
  if (!r.seeded) return r;
  await db.orm.batch([
    db.orm.update(schema.services).set({ capacity: DEMO_CAPACITY, updatedAt: now }),
    ...DEMO_RULES.map((rule) =>
      db.orm.insert(schema.rules).values({
        id: ulid(),
        name: rule.name,
        priority: rule.priority,
        enabled: 1,
        definition: rule.definition,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  ]);
  return r;
}

/**
 * Makes an instance in demo mode ready: seeds the shop when the instance is empty and queues the
 * nightly run. `active` is false for an instance that holds anything else, a business, an item, a
 * customer or a catalogue the demo did not seed: it is left exactly as it is, and never wiped.
 */
export async function ensureDemo(
  db: Db,
  now: number,
  deps: SeedDeps = {},
): Promise<{ seeded: boolean; active: boolean }> {
  let seeded = false;
  if (!(await isDemoShop(db))) {
    if (!(await isEmptyInstance(db))) return { seeded: false, active: false };
    seeded = (await seedDemoShop(db, now, deps)).seeded;
    // Another process may have seeded it a moment before this one: then it is the demo shop all the same.
    if (!seeded && !(await isDemoShop(db))) return { seeded: false, active: false };
  }
  const next = nextNightly(now);
  await ensureJob(db, DEMO_NIGHTLY_KIND, `${DEMO_NIGHTLY_KIND}:${next}`, {
    now,
    runAt: next,
    payload: seeded ? { since: now } : {},
  });
  return { seeded, active: true };
}

/**
 * Empties the instance but for `DEMO_KEEP`, in one batch: every other table, the search index, and
 * every job but the nightly chain (and `keepJob`, the run doing it). Returns the tables emptied.
 */
export async function wipeDemo(db: Db, keepJob = ""): Promise<string[]> {
  const { rows } = await db.client.query({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
            AND name NOT LIKE 'd1_%' AND name NOT LIKE 'search_fts%'`,
    method: "all",
  });
  const tables = rows
    .map((r) => String(r[0]))
    .filter((name) => !DEMO_KEEP.has(name) && /^[a-z0-9_]+$/.test(name))
    .sort();
  await db.client.batch([
    // Children and parents go in one statement list; the foreign keys are checked at the end.
    { sql: "PRAGMA defer_foreign_keys = ON", method: "run" },
    ...tables.map((name) => ({ sql: `DELETE FROM "${name}"`, method: "run" as const })),
    { sql: "DELETE FROM search_fts", method: "run" },
    { sql: "DELETE FROM jobs WHERE kind <> ? AND id <> ?", params: [DEMO_NIGHTLY_KIND, keepJob], method: "run" },
  ]);
  return tables;
}

/** Counts what arrived since `since`, by type, state and channel: numbers only. */
async function tally(db: Db, since: number) {
  const { rows } = await db.client.query({
    sql: "SELECT type, state, channel, COUNT(*) FROM items WHERE created_at > ? GROUP BY type, state, channel",
    params: [since],
    method: "all",
  });
  return rows.map((r) => ({ type: String(r[0]), state: String(r[1]), channel: String(r[2]), n: Number(r[3]) }));
}

const TYPE_WORDS: Record<string, [string, string]> = {
  booking: ["booking", "bookings"],
  order: ["order", "orders"],
  quote_request: ["quote request", "quote requests"],
  message: ["message", "messages"],
  refund: ["refund", "refunds"],
};

const plural = (n: number, type: string) => {
  const [one, many] = TYPE_WORDS[type] ?? [type, type];
  return `${n} ${n === 1 ? one : many}`;
};

/** The owner's one email a day: how many of what arrived, how they arrived, and where they stand. */
export function summaryText(
  business: string,
  counts: readonly { type: string; state: string; channel: string; n: number }[],
  liveUrl: string | null,
): { subject: string; text: string } {
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const byType = new Map<string, Map<string, number>>();
  const byChannel = new Map<string, number>();
  for (const c of counts) {
    const states = byType.get(c.type) ?? new Map<string, number>();
    states.set(c.state, (states.get(c.state) ?? 0) + c.n);
    byType.set(c.type, states);
    const via = arrivedVia(c.channel);
    byChannel.set(via, (byChannel.get(via) ?? 0) + c.n);
  }
  const lines = [...byType.entries()].map(([type, states]) => {
    const n = [...states.values()].reduce((a, b) => a + b, 0);
    const detail = [...states.entries()].map(([state, k]) => `${k} ${stateWords(state)}`).join(", ");
    return `  ${plural(n, type)}: ${detail}`;
  });
  const via = [...byChannel.entries()].map(([how, n]) => `${n} ${how === "email" ? "by email" : `through ${how}`}`);
  return {
    subject: `${business} demo: ${total} new ${total === 1 ? "request" : "requests"} since the last reset`,
    text: [
      `The ${business} demo took ${total} new ${total === 1 ? "request" : "requests"} since it was last reset.`,
      "",
      ...lines,
      "",
      `How they arrived: ${via.join(", ")}.`,
      "",
      "The shop has now been wiped and set up again. Nobody who used it was emailed.",
      ...(liveUrl ? ["", `Live view: ${liveUrl}`] : []),
    ].join("\n"),
  };
}

/**
 * The nightly run: queue tomorrow's first (so a failure never breaks the chain), send the owner the
 * day's numbers once, wipe, seed the shop again, and put back the housekeeping the wipe took.
 */
export function demoNightlyHandler(deps: {
  mailOut: MailOut;
  demo: DemoOptions;
  baseUrl?: string | undefined;
  seed?: SeedDeps | undefined;
}): JobHandler {
  const mail = ownerOnlyMailOut(deps.mailOut, deps.demo.ownerEmails);
  return async (job, { db, now }) => {
    const next = nextNightly(now);
    await ensureJob(db, DEMO_NIGHTLY_KIND, `${DEMO_NIGHTLY_KIND}:${next}`, {
      now,
      runAt: next,
      payload: { since: now },
    });
    if (!(await isDemoShop(db)))
      return { note: "this instance holds a business that is not the demo shop; nothing wiped" };
    const since = Number((job.payload as { since?: unknown } | null)?.since) || now - DAY;
    const notes: string[] = [];
    // A retry never sends the summary twice.
    if (job.attempts <= 1) notes.push(await sendSummary(db, mail, deps, since));
    await wipeDemo(db, job.id);
    const seeded = await seedDemoShop(db, now, deps.seed);
    await ensureLifecycleSweep(db, now);
    await ensureNetworkPing(db, now);
    notes.push(`wiped and seeded ${seeded.items} items`);
    return { note: notes.join("; ") };
  };
}

async function sendSummary(
  db: Db,
  mail: MailOut,
  deps: { demo: DemoOptions; baseUrl?: string | undefined; mailOut: MailOut },
  since: number,
): Promise<string> {
  const to = deps.demo.ownerEmails.filter(Boolean);
  if (to.length === 0) return "no summary: INBOX_OWNER_EMAIL is not set";
  const counts = await tally(db, since);
  if (counts.length === 0) return "no summary: nothing arrived";
  const [biz] = await db.orm.select({ name: schema.business.name }).from(schema.business).limit(1);
  const { subject, text } = summaryText(
    biz?.name || "Demo shop",
    counts,
    deps.baseUrl ? `${deps.baseUrl.replace(/\/+$/, "")}/demo/live` : null,
  );
  const from: { address: string; name?: string | undefined } = deps.demo.from ?? deps.mailOut.sender ?? LOCAL_SENDER;
  try {
    await mail.send({
      from: { address: from.address, ...(from.name ? { name: from.name } : {}) },
      to,
      subject,
      text,
      headers: { "Auto-Submitted": "auto-generated" },
    });
    return deps.mailOut.delivers === false
      ? "summary written to the log: no mail service"
      : "summary sent to the owner";
  } catch (error) {
    return `summary not sent: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---- the live view -----------------------------------------------------------------------

/** One line of the live view. Every field is from the shop's own catalogue, a state or a clock. */
export interface LiveEntry {
  /** Stable for an item, and not its id: the view has nothing that opens an item. */
  readonly key: string;
  readonly type: string;
  /** The service or products, by the shop's own names; never anything a customer typed. */
  readonly what: string;
  /** A booking's time in the shop's time zone; null for anything else. */
  readonly when: string | null;
  readonly state: string;
  readonly state_label: string;
  readonly tone: "good" | "waiting" | "stopped";
  readonly via: string;
  /** When it arrived and when it last changed, in epoch milliseconds. */
  readonly at: number;
  readonly changed_at: number;
  readonly test: boolean;
}

export interface LiveFeed {
  readonly business: string;
  readonly items: readonly LiveEntry[];
  /** When the shop is next wiped, in epoch milliseconds. */
  readonly next_reset: number;
  readonly now: number;
}

/** How an item arrived, in a word a developer knows. */
export function arrivedVia(channel: string): string {
  switch (channel) {
    case "mcp_public":
    case "mcp_owner":
      return "MCP";
    case "rest":
      return "REST";
    case "email":
    case "action_link":
      return "email";
    case "form":
      return "web form";
    case "owner_ui":
      return "the shop";
    case "a2a":
    case "ucp":
    case "acp":
    case "arp":
      return channel.toUpperCase();
    default:
      return "other";
  }
}

const STATE_WORDS: Record<string, string> = {
  requested: "waiting for the shop",
  received: "waiting for the shop",
  open: "waiting for the shop",
  needs_info: "details asked for",
  proposed: "another time offered",
  awaiting_payment: "awaiting payment",
  payment_failed: "payment failed",
  cancelled_by_customer: "cancelled",
  cancelled_by_business: "cancelled by the shop",
  no_show: "no-show",
};

function stateWords(state: string): string {
  return STATE_WORDS[state] ?? state.replaceAll("_", " ");
}

const GOOD = new Set([
  "confirmed",
  "completed",
  "accepted",
  "paid",
  "fulfilling",
  "fulfilled",
  "quoted",
  "answered",
  "approved",
  "refunded",
  "closed",
]);
const STOPPED = new Set([
  "declined",
  "cancelled",
  "cancelled_by_customer",
  "cancelled_by_business",
  "expired",
  "no_show",
  "spam",
  "rejected",
  "charged_back",
  "payment_failed",
]);

function toneOf(state: string): LiveEntry["tone"] {
  return GOOD.has(state) ? "good" : STOPPED.has(state) ? "stopped" : "waiting";
}

/** "Sat 27 Sep, 09:00" in the shop's time zone, or null for anything that is not a time. */
export function shopTime(iso: unknown, tz: string): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
  } catch {
    return null;
  }
}

async function keyOf(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`demo-live:${id}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Obj = Record<string, unknown>;

/** A count as the live view shows it: past 99 it is "99+", so no one can publish a number of their choosing. */
const few = (n: number): string => (n > 99 ? "99+" : String(n));
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * What the live view shows: the last `limit` items, each as a type, the catalogue's name for what
 * was asked for, a booking's time, the state, how it arrived and when. No name, email address,
 * phone number, message, note or anything else a person wrote ever leaves this function: the
 * `what` is looked up in the shop's own services and products by id or SKU, never read from the
 * request, and a line that names nothing the shop sells says so in the shop's words.
 */
export async function liveFeed(db: Db, now: number, limit = 20): Promise<LiveFeed> {
  const [rows, services, products, biz] = await Promise.all([
    db.orm
      .select({
        id: schema.items.id,
        type: schema.items.type,
        state: schema.items.state,
        channel: schema.items.channel,
        payload: schema.items.payload,
        flags: schema.items.flags,
        createdAt: schema.items.createdAt,
        updatedAt: schema.items.updatedAt,
      })
      .from(schema.items)
      .orderBy(desc(schema.items.createdAt), desc(schema.items.id))
      .limit(limit),
    db.orm.select({ id: schema.services.id, name: schema.services.name }).from(schema.services),
    db.orm
      .select({ id: schema.products.id, sku: schema.products.sku, name: schema.products.name })
      .from(schema.products),
    db.orm.select({ name: schema.business.name, timezone: schema.business.timezone }).from(schema.business).limit(1),
  ]);
  const tz = biz[0]?.timezone || "UTC";
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const productName = new Map<string, string>();
  for (const p of products) {
    productName.set(`id:${p.id}`, p.name);
    if (p.sku) productName.set(`sku:${p.sku}`, p.name);
  }
  const product = (line: Obj) =>
    productName.get(`id:${str(line.productId) ?? ""}`) ?? productName.get(`sku:${str(line.sku) ?? ""}`);

  const items = await Promise.all(
    rows.map(async (row): Promise<LiveEntry> => {
      const payload = obj(row.payload);
      let what = "a message";
      let when: string | null = null;
      if (row.type === "booking") {
        const svc = serviceName.get(str(obj(payload.reservationFor).serviceId) ?? "");
        what = svc ?? "a service";
        when = shopTime(payload.startTime, tz);
      } else if (row.type === "order") {
        const lines = Array.isArray(payload.orderedItem) ? payload.orderedItem.map(obj) : [];
        const named: string[] = [];
        let other = 0;
        for (const line of lines) {
          const name = product(line);
          const q = Number(line.quantity);
          if (name) named.push(`${few(Number.isInteger(q) && q > 0 ? q : 1)} × ${name}`);
          else other++;
        }
        const parts = named.length > 3 ? [...named.slice(0, 3), `${few(named.length - 3)} more`] : named;
        // A line that names nothing the shop sells is counted, never named: its name is the customer's.
        if (other > 0) parts.push(`${few(other)} ${other === 1 ? "item" : "items"} not in the catalogue`);
        what = parts.join(", ") || "an order";
      } else if (row.type === "quote_request") {
        const offered = obj(payload.itemOffered);
        what = serviceName.get(str(offered.serviceId) ?? "") ?? product(offered) ?? "something made to order";
      } else if (row.type === "refund") {
        what = "a refund";
      }
      return {
        key: await keyOf(row.id),
        type: row.type,
        what,
        when,
        state: row.state,
        state_label: stateWords(row.state),
        tone: toneOf(row.state),
        via: arrivedVia(row.channel),
        at: row.createdAt,
        changed_at: row.updatedAt,
        test: obj(row.flags).sandbox === true,
      };
    }),
  );
  return { business: biz[0]?.name || "Demo shop", items, next_reset: nextNightly(now), now };
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

const TYPE_LABEL: Record<string, string> = {
  booking: "Booking",
  order: "Order",
  quote_request: "Quote",
  message: "Message",
  refund: "Refund",
};

function rowHtml(e: LiveEntry, now: number): string {
  return `<li class="row" data-key="${esc(e.key)}" data-state="${esc(e.state)}">
  <span class="dot t-${esc(e.type)}" aria-hidden="true"></span>
  <span class="main"><b>${esc(TYPE_LABEL[e.type] ?? e.type)}</b> <span class="what">${esc(e.what)}</span>${
    e.when ? ` <span class="when">${esc(e.when)}</span>` : ""
  }</span>
  <span class="pill s-${e.tone}">${esc(e.state_label)}</span>
  <span class="meta"><span class="via">${esc(e.via)}</span> · <time data-at="${e.at}">${esc(ago(e.at, now))}</time>${
    e.test ? " · test" : ""
  }</span>
</li>`;
}

/** The live view as a page: rendered whole on the server, then kept fresh by /demo/live.js. */
export function livePage(feed: LiveFeed): string {
  const rows = feed.items.map((e) => rowHtml(e, feed.now)).join("\n");
  const reset = new Date(feed.next_reset).toISOString().slice(11, 16);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(feed.business)} · live</title>
<meta name="description" content="What AI agents are booking and ordering at this demo shop, as it happens.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--ground:#f6f5ff;--ink:#14163c;--ink-2:#474a75;--ink-3:#6b6e96;--card:rgba(255,255,255,.62);--edge:rgba(20,22,60,.08);--good:#147a5c;--good-bg:rgba(47,211,165,.16);--wait:#866000;--wait-bg:rgba(255,207,92,.22);--stop:#6b6e96;--stop-bg:rgba(107,110,150,.12);--booking:#ff6fa8;--order:#ff9650;--quote_request:#8a6bff;--message:#25cfe0;--refund:#ffcf5c;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ground:#0d0e26;--ink:#f2f1ff;--ink-2:#b9b8dd;--ink-3:#8e8db8;--card:rgba(255,255,255,.06);--edge:rgba(255,255,255,.1);--good:#72e6c3;--wait:#ffda80;--stop:#8e8db8}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(60rem 30rem at 10% -10%,rgba(255,111,168,.18),transparent),radial-gradient(50rem 30rem at 100% 0,rgba(37,207,224,.16),transparent),var(--ground);color:var(--ink);font:14.5px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 56px}
.eyebrow{margin:0;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
h1{margin:6px 0 0;font-size:clamp(23px,3vw,30px);line-height:1.15;letter-spacing:-.02em}
.lede{margin:10px 0 0;max-width:58ch;color:var(--ink-2)}
.status{display:inline-flex;align-items:center;gap:8px;margin-top:18px;font-size:13px;font-weight:600;color:var(--ink-2)}
.pulse{width:8px;height:8px;border-radius:50%;background:#2fd3a5;box-shadow:0 0 0 0 rgba(47,211,165,.6);animation:pulse 2s infinite}
.status.off .pulse{background:var(--ink-3);animation:none}
ul{list-style:none;margin:20px 0 0;padding:6px;border:1px solid var(--edge);border-radius:16px;background:var(--card);backdrop-filter:blur(18px)}
.row{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"dot main pill" ". meta meta";gap:2px 10px;align-items:center;padding:10px 12px;border-radius:12px}
.row+.row{border-top:1px solid var(--edge)}
.dot{grid-area:dot;width:10px;height:10px;border-radius:50%;background:var(--ink-3)}
.t-booking{background:var(--booking)}.t-order{background:var(--order)}.t-quote_request{background:var(--quote_request)}.t-message{background:var(--message)}.t-refund{background:var(--refund)}
.main{grid-area:main;min-width:0;overflow-wrap:anywhere}.what{color:var(--ink-2)}.when{color:var(--ink-3);white-space:nowrap}
.pill{grid-area:pill;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.s-good{color:var(--good);background:var(--good-bg)}.s-waiting{color:var(--wait);background:var(--wait-bg)}.s-stopped{color:var(--stop);background:var(--stop-bg)}
.meta{grid-area:meta;font-size:12px;color:var(--ink-3)}
.empty{padding:18px 12px;color:var(--ink-3)}
@media (max-width:520px){.row{grid-template-columns:auto 1fr;grid-template-areas:"dot main" ". pill" ". meta"}.pill{justify-self:start;margin:4px 0 2px}}
.fine{margin:16px 0 0;font-size:12px;color:var(--ink-3);max-width:62ch}
a{color:inherit}
@media (prefers-reduced-motion:no-preference){.row.is-new{animation:arrive .6s cubic-bezier(.2,.8,.2,1)}.pill.is-changed{animation:pop .5s cubic-bezier(.2,.8,.2,1)}}
@keyframes arrive{from{opacity:0;transform:translateY(-8px) scale(.98);background:rgba(138,107,255,.14)}to{opacity:1;transform:none}}
@keyframes pop{0%{transform:scale(1)}40%{transform:scale(1.14)}100%{transform:scale(1)}}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(47,211,165,0)}100%{box-shadow:0 0 0 0 rgba(47,211,165,0)}}
</style>
</head>
<body>
<main>
<p class="eyebrow">Live · a demo shop</p>
<h1>${esc(feed.business)}</h1>
<p class="lede">Every booking, order, quote request and message that reaches this demo shop, as it happens. Ask your AI to book something and watch it arrive.</p>
<p class="status" data-status><span class="pulse" aria-hidden="true"></span><span data-status-text>Live</span></p>
<ul data-live aria-live="polite">
${rows || '<li class="empty">Nothing yet. Be the first.</li>'}
</ul>
<p class="fine">No names, addresses, phone numbers or messages are shown here, and the shop never emails anyone who uses it. It is wiped and set up again every night at ${reset} UTC.</p>
</main>
<script src="/demo/live.js" defer></script>
</body>
</html>`;
}

/** Keeps the page fresh: polls the feed every few seconds while the tab is visible, animates what changed. */
export const LIVE_JS = `(() => {
  const list = document.querySelector("[data-live]");
  const status = document.querySelector("[data-status]");
  const statusText = document.querySelector("[data-status-text]");
  if (!list) return;
  const labels = { booking: "Booking", order: "Order", quote_request: "Quote", message: "Message", refund: "Refund" };
  const seen = new Map();
  for (const li of list.querySelectorAll("li[data-key]")) seen.set(li.dataset.key, li.dataset.state);
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 36) return h + " h ago";
    const d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const row = (item) => {
    const li = el("li", "row");
    li.dataset.key = item.key;
    li.dataset.state = item.state;
    const dot = el("span", "dot t-" + item.type);
    dot.setAttribute("aria-hidden", "true");
    const main = el("span", "main");
    main.append(el("b", "", labels[item.type] || item.type), " ", el("span", "what", item.what));
    if (item.when) main.append(" ", el("span", "when", item.when));
    const pill = el("span", "pill s-" + item.tone, item.state_label);
    const meta = el("span", "meta");
    const time = el("time", "", ago(item.at));
    time.dataset.at = String(item.at);
    meta.append(el("span", "via", item.via), " · ", time);
    if (item.test) meta.append(" · test");
    li.append(dot, main, pill, meta);
    if (!seen.has(item.key)) li.classList.add("is-new");
    else if (seen.get(item.key) !== item.state) pill.classList.add("is-changed");
    return li;
  };
  const render = (items) => {
    if (items.length === 0) return;
    list.replaceChildren(...items.map(row));
    seen.clear();
    for (const item of items) seen.set(item.key, item.state);
  };
  const tick = async () => {
    if (document.hidden) return;
    try {
      const res = await fetch("/demo/live.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      render((await res.json()).items || []);
      status.classList.remove("off");
      statusText.textContent = "Live";
    } catch {
      status.classList.add("off");
      statusText.textContent = "Reconnecting";
    }
    for (const t of list.querySelectorAll("time[data-at]")) t.textContent = ago(Number(t.dataset.at));
  };
  setInterval(tick, 4000);
  document.addEventListener("visibilitychange", tick);
})();
`;

/** How long one reading of the feed serves every viewer: the pages poll every four seconds. */
export const LIVE_FRESH_MS = 2_000;

/**
 * The demo's routes, mounted at /demo only when demo mode is on, and answered only once `active`
 * says this instance is the demo shop: on anything else they are a 404 like any unknown path. The
 * JSON may be read from any site, since it carries nothing about anyone: the website's Try page shows
 * it. Everyone polling it shares one reading every `LIVE_FRESH_MS`, so a crowd, or a script with no
 * limit to meet, costs the database one query set every two seconds, not one per request.
 */
export function demoRoutes(deps: {
  db: Db;
  now?: (() => number) | undefined;
  active: () => Promise<boolean>;
}): Hono<CallerEnv> {
  const clock = () => (deps.now ? deps.now() : Date.now());
  let cached: { at: number; feed: Promise<LiveFeed> } | null = null;
  const feed = (): Promise<LiveFeed> => {
    const now = clock();
    if (!cached || now - cached.at >= LIVE_FRESH_MS || now < cached.at) {
      const reading = liveFeed(deps.db, now);
      cached = { at: now, feed: reading };
      reading.catch(() => {
        if (cached?.feed === reading) cached = null;
      });
    }
    return cached.feed;
  };
  const routes = new Hono<CallerEnv>();
  routes.use("*", async (c, next) => {
    if (!(await deps.active().catch(() => false))) return c.notFound();
    await next();
  });
  routes.get("/live", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.html(livePage(await feed()));
  });
  routes.get("/live.json", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(await feed());
  });
  routes.get("/live.js", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.body(LIVE_JS, 200, { "Content-Type": "text/javascript; charset=utf-8" });
  });
  return routes;
}
