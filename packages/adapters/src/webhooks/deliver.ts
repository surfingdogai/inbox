import {
  type Db,
  DEFAULT_SETTINGS,
  deliverJobPrefix,
  eventBaseUrl,
  type JobHandler,
  openWebhookHeaders,
  readSettings,
  rowToItem,
  type SecretBox,
  schema,
  type ThinEvent,
  thinEvent,
  USER_AGENT,
  usableSecrets,
  viewFor,
  WEBHOOK_DELIVERY_KIND,
  type WebhookSecrets,
  webhookHeaders,
} from "@surfingdog/core";
import type { Statement } from "@surfingdog/platform";
import { and, eq, isNotNull } from "drizzle-orm";
import { isPublicHost } from "../safe-fetch";
import { signWebhook } from "./sign";

/**
 * One delivery attempt (ADR-015 §5). The handler **never throws on a delivery failure**: it
 * records the attempt and schedules its own next one, exactly the way the network ping schedules
 * its successor, so the job runner's generic backoff stays reserved for our own bugs. That is why
 * these jobs carry a max_attempts of two: if this handler throws, we wrote a bug.
 *
 * Anything that is not 2xx is a failure, including a redirect, which is never followed — that also
 * removes a class of server-side request forgery for free.
 */
export { WEBHOOK_DELIVERY_KIND };

/** 0s, 5s, 5m, 30m, 2h, 5h, 10h, 10h — eight attempts, a little over a day, each with jitter. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
];
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_MS.length;
/** A tenth of the interval, derived from the delivery id: deterministic, so tests can predict it. */
export const JITTER_FRACTION = 0.1;
/** Our bugs only; a refused delivery is recorded by the handler, never raised to the runner. */
export const DELIVER_JOB_MAX_ATTEMPTS = 2;

/**
 * The defaults are the settings document's own, read through the schema rather than written out a
 * second time: a number that means one thing in `settings/schema.ts` and another here is a bug
 * nobody sees until an endpoint times out at a length no one configured.
 */
const DEFAULTS = DEFAULT_SETTINGS.integrations.webhooks;
const MAX_ERROR_CHARS = 300;
/**
 * How much of a failing receiver's body we will read to quote 300 characters of it. A timeout is a
 * time bound, not a memory bound: a fast endpoint answering with a stream would otherwise be
 * buffered whole, and a Workers isolate has about 128 MB to lose.
 */
const MAX_SNIPPET_BYTES = 8 * 1024;

export interface DeliverPayload {
  readonly deliveryId: string;
  readonly webhookId?: string;
  readonly eventId?: string;
  /** Zero-based index into `RETRY_SCHEDULE_MS`: attempt 0 is the immediate one. */
  readonly attempt?: number;
}

export interface DeliverDeps {
  /** Opens the endpoint's sealed signing secret. Null on an instance with no INBOX_SECRET_KEY. */
  readonly secrets: SecretBox | null;
  readonly version: string;
  /** This instance's public URL, for the `url` a thin event points at. */
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface WebhookSettings {
  /** Off: no endpoint is called and nothing is queued. */
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly disableAfterDays: number;
  readonly retainDeliveryDays: number;
  /** Lets an endpoint sit on a private, local or plain-http address. Only for a machine you control. */
  readonly allowPrivateTargets: boolean;
}

/**
 * `settings.integrations.webhooks`, read defensively: the Integrations half of the settings
 * document is written by the Settings screen, and an instance that has never opened it — or one
 * running an older document — still delivers on the defaults rather than refusing to.
 */
export function webhookSettings(settings: unknown): WebhookSettings {
  const w = (settings as { integrations?: { webhooks?: Record<string, unknown> } } | null)?.integrations?.webhooks;
  return {
    enabled: w?.enabled !== false,
    // The bounds are `settingsSchema`'s, so a value that got past the schema is never clamped and
    // a hand-written document is held to the same range the Settings door enforces.
    timeoutMs: positive(w?.timeoutMs, DEFAULTS.timeoutMs, 1_000, 30_000),
    maxAttempts: positive(w?.maxAttempts, DEFAULTS.maxAttempts, 1, 12),
    disableAfterDays: positive(w?.disableAfterDays, DEFAULTS.disableAfterDays, 1, 30),
    retainDeliveryDays: positive(w?.retainDeliveryDays, DEFAULTS.retainDeliveryDays, 1, 90),
    allowPrivateTargets: w?.allowPrivateTargets === true,
  };
}

/** What this module enqueues: every field present, so a reader never has to guess. */
export type DeliverJob = Required<DeliverPayload>;

/**
 * The key is core's — `deliverJobPrefix` — because `replayDelivery` has to delete by the same
 * format when it starts a delivery's attempts over from zero. Two spellings of it is how a replay
 * ends up silently keeping one attempt and losing the rest of its chain.
 */
export function deliverDedupeKey(deliveryId: string, attempt: number): string {
  return `${deliverJobPrefix(deliveryId)}${attempt}`;
}

/** The job row for one attempt. Written inside the same batch as the delivery row it belongs to. */
export function deliverJobStatement(payload: DeliverJob, runAt: number, now: number): Statement {
  return {
    sql: "INSERT OR IGNORE INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
    params: [
      deliverDedupeKey(payload.deliveryId, payload.attempt),
      WEBHOOK_DELIVERY_KIND,
      JSON.stringify(payload),
      runAt,
      DELIVER_JOB_MAX_ATTEMPTS,
      deliverDedupeKey(payload.deliveryId, payload.attempt),
      now,
    ],
    method: "run",
  };
}

/**
 * When the next attempt runs: the schedule plus up to a tenth of it, derived from the delivery id
 * and the attempt number rather than from `Math.random()`. Time comes from the job's `now`, never
 * from `Date.now()` inside the handler, so a test knows the answer before it runs.
 */
export function retryAt(now: number, attempt: number, deliveryId: string): number {
  const base = RETRY_SCHEDULE_MS[attempt] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] ?? 0;
  return now + base + Math.floor(base * JITTER_FRACTION * fraction(`${deliveryId}:${attempt}`));
}

export function webhookDeliverHandler(deps: DeliverDeps): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as DeliverPayload;
    if (!p?.deliveryId) return { note: "no delivery id" };
    const [delivery] = await db.orm
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, p.deliveryId));
    if (!delivery) return { note: `delivery ${p.deliveryId} is gone` };
    if (delivery.status === "delivered") return { note: "already delivered" };

    const [endpoint] = await db.orm.select().from(schema.webhooks).where(eq(schema.webhooks.id, delivery.webhookId));
    if (!endpoint) return { note: `endpoint ${delivery.webhookId} is gone` };
    if (endpoint.active === 0) return { note: "endpoint is inactive; the delivery stays replayable" };

    const settings = await readSettings(db);
    const conf = webhookSettings(settings);
    if (!conf.enabled) return { note: "outbound webhooks are switched off in Settings" };
    // A payload that carries only the delivery id is complete: the row knows the rest.
    const attempt = Number.isFinite(p.attempt) ? Number(p.attempt) : delivery.attempts;

    let secrets: string[];
    let extra: Record<string, string>;
    try {
      if (!deps.secrets) throw new Error("this instance has no INBOX_SECRET_KEY, so the secret cannot be opened");
      secrets = splitSecrets(await deps.secrets.open("webhook-secret", endpoint.id, endpoint.secretEnc), now);
      if (secrets.length === 0) throw new Error("the stored secret is empty");
      // The owner's extra headers are sealed the same way; a blob that no longer opens is the same
      // configuration problem as a signing secret that does not, and is recorded the same way.
      extra = await openWebhookHeaders(deps.secrets, endpoint.id, endpoint.headersEnc);
    } catch (error) {
      // Our configuration, not the receiver's fault: record it and stop. Nothing retries a missing
      // key, and the delivery stays replayable once the key is back.
      // `failing_since` is deliberately untouched: the endpoint did nothing wrong, and a key that
      // is missing for a week must not deactivate every endpoint the moment it comes back.
      await db.batch([
        haltStatement(delivery.id, delivery.attempts, `signing secret: ${message(error)}`),
        {
          sql: "UPDATE webhooks SET last_error = ?, updated_at = ? WHERE id = ?",
          params: [`signing secret: ${message(error)}`.slice(0, MAX_ERROR_CHARS), now, endpoint.id],
          method: "run",
        },
      ]);
      return { note: `cannot sign for ${endpoint.url}: ${message(error)}` };
    }

    const event = await readEvent(db, delivery.eventId);
    if (!event) {
      await db.batch([haltStatement(delivery.id, delivery.attempts, "the event is no longer in events_v1")]);
      return { note: `event ${delivery.eventId} is gone` };
    }

    // The same resolution the cursor uses, from the same function: host URL, then the address in
    // Settings, then relative. A webhook body and `GET /v1/owner/events` must not disagree here.
    const baseUrl = eventBaseUrl(deps.baseUrl, settings.notifications.appUrl);
    const body = JSON.stringify(
      await buildEvent(db, event, endpoint.payloadStyle === "full" ? "full" : "thin", baseUrl),
    );
    const attemptNumber = attempt + 1;
    const timestampSec = Math.floor(now / 1000);
    // The header set is core's, the same one `sendTestEvent` sends, so a test event and a real
    // delivery are the same request to the byte apart from what is inside them.
    const headers = webhookHeaders({
      id: event.id,
      timestampSec,
      signature: await signWebhook(secrets, { id: event.id, timestamp: timestampSec, body }),
      eventType: event.type,
      attempt: attemptNumber,
      userAgent: deps.version ? `surfingdog-inbox/${deps.version}` : USER_AGENT,
      extra,
    });
    const result = await post(endpoint.url, body, headers, conf, deps.fetchImpl);

    if (result.status >= 200 && result.status < 300) {
      await db.batch([
        {
          sql: "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, next_at = NULL, last_status = ?, last_error = NULL, duration_ms = ?, delivered_at = ? WHERE id = ?",
          params: [attemptNumber, result.status, result.durationMs, now, delivery.id],
          method: "run",
        },
        {
          sql: "UPDATE webhooks SET failing_since = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
          params: [now, endpoint.id],
          method: "run",
        },
      ]);
      return { note: `${event.type} → ${endpoint.url}: ${result.status} in ${result.durationMs} ms` };
    }

    // Everything else is a failure, including a 3xx, which we never follow.
    const failure = result.error ?? `HTTP ${result.status}${result.snippet ? `: ${result.snippet}` : ""}`;
    const failingSince = endpoint.failingSince ?? now;
    const deactivate = now - failingSince >= conf.disableAfterDays * 86_400_000;
    const more = attempt + 1 < conf.maxAttempts && !deactivate;
    const next = more ? retryAt(now, attempt + 1, delivery.id) : null;
    const statements: Statement[] = [
      {
        sql: "UPDATE webhook_deliveries SET status = ?, attempts = ?, next_at = ?, last_status = ?, last_error = ?, duration_ms = ? WHERE id = ?",
        params: [
          more ? "pending" : "failed",
          attemptNumber,
          next,
          result.status || null,
          failure.slice(0, MAX_ERROR_CHARS),
          result.durationMs,
          delivery.id,
        ],
        method: "run",
      },
      endpointErrorStatement(endpoint.id, failure, now, endpoint.failingSince, deactivate),
    ];
    if (more && next !== null) {
      statements.push(
        deliverJobStatement(
          { deliveryId: delivery.id, webhookId: endpoint.id, eventId: delivery.eventId, attempt: attempt + 1 },
          next,
          now,
        ),
      );
    }
    await db.batch(statements);
    const tail = deactivate
      ? `; ${endpoint.url} has done nothing but fail for ${conf.disableAfterDays} days and is now inactive`
      : more
        ? `; attempt ${attemptNumber + 1} of ${MAX_DELIVERY_ATTEMPTS} at ${new Date(next ?? now).toISOString()}`
        : `; giving up after ${attemptNumber} attempts`;
    return { note: `${event.type} → ${endpoint.url} failed (${failure.slice(0, 120)})${tail}` };
  };
}

/** Deliveries are a log, not an archive: an unbounded one is how a database reaches its size cap. */
export async function pruneWebhookDeliveries(db: Db, olderThanMs: number, now = Date.now()): Promise<number> {
  const r = await db.client.query({
    sql: "DELETE FROM webhook_deliveries WHERE created_at < ?",
    params: [now - olderThanMs],
    method: "run",
  });
  return r.changes;
}

export interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly createdAt: number;
  readonly itemId: string;
  readonly itemType: string;
  readonly itemState: string;
  readonly itemVersion: number;
  readonly partyId: string;
  readonly sandbox: number;
  readonly source: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly channel: string | null;
}

export async function readEvent(db: Db, eventId: string): Promise<EventRow | undefined> {
  const [row] = await db.orm
    .select({
      id: schema.eventsV1.id,
      type: schema.eventsV1.type,
      createdAt: schema.eventsV1.createdAt,
      itemId: schema.eventsV1.itemId,
      itemType: schema.eventsV1.itemType,
      itemState: schema.eventsV1.itemState,
      itemVersion: schema.eventsV1.itemVersion,
      partyId: schema.eventsV1.partyId,
      sandbox: schema.eventsV1.sandbox,
      source: schema.eventsV1.source,
      actorKind: schema.eventsV1.actorKind,
      actorId: schema.eventsV1.actorId,
      actorName: schema.eventsV1.actorName,
      channel: schema.eventsV1.channel,
    })
    .from(schema.eventsV1)
    .where(eq(schema.eventsV1.id, eventId));
  return row;
}

/**
 * The two payload styles (ADR-015 §3). **Thin** carries a pointer and nothing about the customer,
 * so it never goes stale when it is retried ten hours later and never copies a name and an address
 * to a URL somebody pasted once. **Full** is the same envelope with the item, the party and, for a
 * message, the message itself — because a webhook a no-code tool cannot read is not useful, and the
 * Settings screen says in plain words that this style sends customer data to that address.
 */
export async function buildEvent(
  db: Db,
  event: EventRow,
  style: "thin" | "full",
  baseUrl: string,
): Promise<Record<string, unknown>> {
  // The thin event is built by core's `thinEvent`, the very function `GET /v1/owner/events`
  // returns, so what a webhook carries and what the cursor hands back are the same object by
  // construction and cannot drift apart field by field. Full is that envelope with more in `data`.
  const thin: ThinEvent = thinEvent(event, baseUrl);
  const data: Record<string, unknown> = { ...thin.data };
  const envelope = { id: thin.id, type: thin.type, timestamp: thin.timestamp, data };
  if (style === "thin") return envelope;

  const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, event.itemId));
  if (!row) return envelope;
  const party = await partyView(db, row.partyId);
  const view = viewFor(rowToItem(row), "owner", party);
  data.item = view.item;
  data.transitions = view.transitions;
  data.human = view.human;
  if (party) data.party = party;
  if (event.source === "thread_entry") {
    const [entry] = await db.orm.select().from(schema.threadEntries).where(eq(schema.threadEntries.id, event.id));
    if (entry) {
      data.message = {
        id: entry.id,
        direction: entry.direction,
        channel: entry.channel,
        subject: entry.subject,
        body: entry.bodyText,
        at: new Date(entry.createdAt).toISOString(),
      };
    }
  }
  if (event.source === "receipt" || event.source === "receipt_ack") {
    // The acknowledgement's event id is `<receipt id>:ack` (see migration 0005); the receipt
    // itself is what a developer wants either way, with `acknowledged_at` telling the two apart.
    const receiptId = event.source === "receipt_ack" ? event.id.replace(/:ack$/, "") : event.id;
    const [r] = await db.orm.select().from(schema.receipts).where(eq(schema.receipts.id, receiptId));
    if (r) {
      data.receipt = {
        id: r.id,
        kind: r.kind,
        jws: r.jws,
        payload: r.payload,
        issued_at: new Date(r.issuedAt).toISOString(),
        acknowledged_at: r.ackAt === null ? null : new Date(r.ackAt).toISOString(),
      };
    }
  }
  return envelope;
}

async function partyView(db: Db, partyId: string) {
  const [p] = await db.orm.select().from(schema.parties).where(eq(schema.parties.id, partyId));
  if (!p) return undefined;
  const verified = await db.orm
    .select({ id: schema.partyIdentities.partyId })
    .from(schema.partyIdentities)
    .where(and(eq(schema.partyIdentities.partyId, partyId), isNotNull(schema.partyIdentities.verifiedAt)));
  const contact = (p.contact ?? {}) as { email?: string; phone?: string; name?: string };
  return {
    id: p.id,
    name: p.displayName ?? contact.name ?? null,
    kind: p.kind,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    verified: verified.length > 0,
  };
}

/**
 * The POST itself, built from the same rules as `safeFetchJson`: https only, no IP literals, no
 * local or internal hosts, a short timeout, and `redirect: "manual"` so a 3xx comes back as a
 * status to record rather than a hop to follow.
 */
async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  conf: WebhookSettings,
  fetchImpl: typeof fetch | undefined,
): Promise<{ status: number; error?: string; snippet?: string; durationMs: number }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { status: 0, error: `${url} is not a URL`, durationMs: 0 };
  }
  if (!conf.allowPrivateTargets) {
    if (target.protocol !== "https:") return { status: 0, error: "the endpoint must be https", durationMs: 0 };
    if (!isPublicHost(target.hostname)) {
      return { status: 0, error: `${target.hostname} is not a public host`, durationMs: 0 };
    }
  } else if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { status: 0, error: "the endpoint must be http or https", durationMs: 0 };
  }
  const impl = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  // A wall-clock delta is a measurement, not a decision: it never reaches the schedule.
  const started = Date.now();
  try {
    const res = await impl(target.toString(), {
      method: "POST",
      body,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    const snippet = await readSnippet(res);
    return { status: res.status, durationMs: Date.now() - started, ...(snippet ? { snippet } : {}) };
  } catch (error) {
    return { status: 0, error: message(error), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enough of the body to quote in `last_error`, and not a byte more: the reader is cancelled at
 * `MAX_SNIPPET_BYTES` rather than drained, so a receiver answering an error with a very large or
 * endless body cannot be read into memory. A truncated multi-byte sequence decodes to U+FFFD and
 * falls off the 300-character slice anyway, and an abort mid-read still lands in the `catch`.
 */
async function readSnippet(res: Response): Promise<string> {
  if (res.status >= 200 && res.status < 300) return "";
  const clip = (text: string) => text.slice(0, MAX_ERROR_CHARS).replace(/\s+/g, " ").trim();
  try {
    const reader = res.body?.getReader();
    if (!reader) return clip(await res.text());
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel();
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return clip(new TextDecoder().decode(all));
  } catch {
    return "";
  }
}

/** Stops a delivery without scheduling another attempt; it stays in the log, replayable. */
function haltStatement(deliveryId: string, attempts: number, error: string): Statement {
  return {
    sql: "UPDATE webhook_deliveries SET status = 'failed', attempts = ?, next_at = NULL, last_error = ?, duration_ms = 0 WHERE id = ?",
    params: [attempts, `${error}`.slice(0, MAX_ERROR_CHARS), deliveryId],
    method: "run",
  };
}

function endpointErrorStatement(
  webhookId: string,
  error: string,
  now: number,
  failingSince: number | null,
  deactivate: boolean,
): Statement {
  if (deactivate) {
    return {
      sql: "UPDATE webhooks SET active = 0, disabled_at = ?, failing_since = COALESCE(failing_since, ?), last_error = ?, updated_at = ? WHERE id = ?",
      params: [now, now, error.slice(0, MAX_ERROR_CHARS), now, webhookId],
      method: "run",
    };
  }
  return {
    sql: "UPDATE webhooks SET failing_since = COALESCE(failing_since, ?), last_error = ?, updated_at = ? WHERE id = ?",
    params: [failingSince ?? now, error.slice(0, MAX_ERROR_CHARS), now, webhookId],
    method: "run",
  };
}

/**
 * What the sealed blob holds. The owner-facing half stores a rotation document
 * (`{current, previous, previousUntil}`); older rows, and anything written by hand, hold the secret
 * as plain text, optionally with the one it replaced beside it. Both are read here, newest first,
 * and a `previous` whose grace period has passed is dropped rather than signed with.
 */
export function splitSecrets(plaintext: string, now: number): string[] {
  const trimmed = plaintext.trim();
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(trimmed) as Partial<WebhookSecrets>;
      // `usableSecrets` is core's: it is what `rotateWebhookSecret` wrote the document for, and
      // what decides when the day of grace is over. Reading it any other way here would mean two
      // answers to "which secrets are live right now".
      if (typeof doc.current === "string" && doc.current) return usableSecrets(doc as WebhookSecrets, now);
    } catch {
      // Not a rotation document after all: fall through and read it as text.
    }
  }
  return trimmed
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function fraction(seed: string): number {
  return hash32(seed) / 0x1_0000_0000;
}

function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function positive(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
