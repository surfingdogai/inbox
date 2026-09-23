import type { Statement } from "@surfingdog/platform";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { ulid } from "../ids";
import { webhookDeliveries, webhooks as webhooksTable } from "../schema/tables";
import { requireSecretBox, type SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { isPublicHost } from "../util/hosts";
import { USER_AGENT } from "../version";
import { actorMeta, type Caller, type EventActor, eventActor, isCustomer, nowOf } from "../write/caller";
import { deliverJobPrefix, jobStatement, WEBHOOK_DELIVERY_KIND, WEBHOOK_FANOUT_KIND } from "../write/common";
import { WriteError } from "../write/errors";
import type * as S from "./setup-types";
import { MAX_WEBHOOK_HEADERS, reservedWebhookHeader } from "./setup-types";

/**
 * Outbound webhooks and the developer event cursor (ADR-015 §3–§6).
 *
 * A developer points Zapier, n8n, Make, a Slack bot or their own server at an inbox and receives
 * signed, retried, replayable events for every booking, order, quote and message — no platform, no
 * OAuth, nothing to register. What cannot receive a webhook polls `listEvents` instead, which is
 * the same events over the same ids.
 *
 * The signature is Standard Webhooks verbatim, so an off-the-shelf library in any language verifies
 * us. The secret is minted here, shown once, and sealed by the secret box; the row never gives it
 * back. Delivery itself is a job (`webhook_delivery`), because a remote server is allowed to be slow
 * and allowed to be down.
 */

/**
 * The two job kinds, defined in `write/common.ts` — the write path enqueues fanout, this file
 * enqueues delivery, and `@surfingdog/adapters` handles both — and re-exported here so that
 * everything to do with webhooks can be reached from one import.
 */
export { deliverJobPrefix, WEBHOOK_DELIVERY_KIND, WEBHOOK_FANOUT_KIND };

/** Both signatures travel for a day after a rotation (ADR-015 §4), so a receiver can catch up. */
export const SECRET_GRACE_MS = 24 * 3_600_000;

/**
 * How many events one `replayMissing` scans, and at most queues, per call. The scan is capped, not
 * the backfill: when the result comes back `truncated`, it carries a `next_after`, and the caller
 * passes that back as `after` to take the next window. Calling it again with the same arguments and
 * no `after` re-reads the same window for ever, which is why the cursor is in the result.
 */
export const REPLAY_MAX = 500;

/**
 * How far behind live the event cursor reads. An event's id is minted before its batch commits, and
 * `ulid()` is monotonic only inside one process, so a row with a lower id can become visible after a
 * poller has already moved past it — and `WHERE id > ?` would never show it again. Holding the top
 * of the range a few seconds back means a late commit is always still ahead of the horizon of the
 * poll that would have skipped it. The webhook path does not need this: its fanout job is enqueued
 * inside the batch that wrote the event.
 */
export const EVENT_SETTLE_MS = 3_000;

/**
 * The one event type that is not `<item type>.<event>`: `sendTestEvent` invents it, no item is
 * behind it, and its body carries `test: true` and a sentence saying so. A receiver that matches
 * on the item-type prefix will ignore it, which is the right behaviour — it is for the owner
 * standing in front of the Settings screen, not for the integration.
 */
export const TEST_EVENT_TYPE = "inbox.test";

const encoder = new TextEncoder();

/**
 * What `secret_enc` holds, sealed: the live secret and, during a rotation, the one it replaced.
 * The column is opaque TEXT, so keeping two secrets there needs no migration and no second table.
 */
export interface WebhookSecrets {
  readonly current: string;
  readonly previous?: string;
  /** Milliseconds UTC after which `previous` stops being signed with. */
  readonly previousUntil?: number;
}

/**
 * A thin event (ADR-015 §3): a pointer that never goes stale and never copies customer data. It
 * also says who caused the event, through which door, and whether the item is a sandbox item, so a
 * two-way sync can skip its own writes (compare `data.actor` with its own key) and a receiver can
 * skip test traffic without a second call.
 */
export interface ThinEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly data: {
    readonly id: string;
    readonly type: string;
    readonly state: string;
    readonly version: number;
    readonly url: string;
    readonly actor: EventActor;
    /** The door: `rest`, `mcp_owner`, `mcp_public`, `email`, `owner_ui`, `system`, … */
    readonly channel: string | null;
    readonly sandbox: boolean;
  };
}

export interface DeliverySummary {
  readonly pending: number;
  readonly delivered: number;
  readonly failed: number;
  readonly last_delivery_at: string | null;
}

export interface WebhookView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly payload_style: S.PayloadStyle;
  /** The names of the extra headers each delivery carries. Their values are never returned. */
  readonly headers: readonly string[];
  readonly active: boolean;
  readonly failing_since: string | null;
  readonly disabled_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deliveries: DeliverySummary;
}

/** Only ever returned by `createWebhook` and `rotateWebhookSecret`; nothing else can read it back. */
export interface WebhookWithSecret extends WebhookView {
  readonly secret: string;
  readonly secret_note: string;
  readonly previous_secret_until: string | null;
}

export interface DeliveryView {
  readonly id: string;
  readonly webhook_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly status: S.DeliveryStatus;
  readonly attempts: number;
  readonly last_status: number | null;
  readonly last_error: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly next_attempt_at: string | null;
}

export interface EventPage {
  readonly events: readonly ThinEvent[];
  readonly next_cursor: string | null;
}

export interface TestEventResult {
  readonly delivered: boolean;
  readonly status: number | null;
  readonly duration_ms: number;
  readonly error: string | null;
  readonly event: ThinEvent & { readonly test: true; readonly message: string };
  readonly delivery: DeliveryView;
}

// ---- signing (Standard Webhooks, verbatim) -----------------------------------------

/** `whsec_` + base64 of 32 random bytes, exactly as every Standard Webhooks sender issues it. */
export function mintWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `whsec_${btoa(binary)}`;
}

/** The secrets a signature must carry right now: the live one, plus a rotation still in its day. */
export function usableSecrets(secrets: WebhookSecrets, now: number): string[] {
  const out = [secrets.current];
  if (secrets.previous && (secrets.previousUntil ?? 0) > now) out.push(secrets.previous);
  return out;
}

/** base64 HMAC-SHA256 over exactly `{id}.{timestamp}.{body}` — the Standard Webhooks signed string. */
export async function signWebhook(secret: string, id: string, timestampSec: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    webhookSecretBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestampSec}.${body}`) as BufferSource);
  const bytes = new Uint8Array(mac);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The `webhook-signature` header: `v1,<sig>`, and during a rotation both, space separated. */
export async function webhookSignature(
  secrets: WebhookSecrets,
  id: string,
  timestampSec: number,
  body: string,
  now: number,
): Promise<string> {
  const sigs = await Promise.all(usableSecrets(secrets, now).map((s) => signWebhook(s, id, timestampSec, body)));
  return sigs.map((s) => `v1,${s}`).join(" ");
}

/**
 * Every header a delivery carries, built in one place so the test event and the delivery job are
 * byte-for-byte the same request. The three `webhook-*` headers are Standard Webhooks and are all
 * a receiver needs; `sdi-event-type` lets one route without parsing the body and
 * `sdi-delivery-attempt` counts from 1, so a `3` in a log says the first two never landed.
 */
export interface WebhookHeaderInput {
  /** The `events_v1` id: what is signed, and what the receiver deduplicates on. */
  readonly id: string;
  /** Unix **seconds** of this attempt, not of the event. */
  readonly timestampSec: number;
  readonly signature: string;
  readonly eventType: string;
  /** 1-based: the first attempt is 1. */
  readonly attempt: number;
  readonly userAgent?: string | undefined;
  /** The endpoint's extra headers (`headers` on the webhook). Never one of the names set here. */
  readonly extra?: Readonly<Record<string, string>> | undefined;
}

export function webhookHeaders(input: WebhookHeaderInput): Record<string, string> {
  // The owner's extra headers go first, so that whatever happens the delivery's own headers win:
  // the input schema refuses those names, and this ordering is the second lock on the same door.
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.extra ?? {})) {
    if (!reservedWebhookHeader(name)) extra[name.toLowerCase()] = value;
  }
  return {
    ...extra,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": input.userAgent ?? USER_AGENT,
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestampSec),
    "webhook-signature": input.signature,
    "sdi-event-type": input.eventType,
    "sdi-delivery-attempt": String(input.attempt),
  };
}

export async function openWebhookSecrets(box: SecretBox, webhookId: string, sealed: string): Promise<WebhookSecrets> {
  const plain = await box.open("webhook-secret", webhookId, sealed);
  const parsed = JSON.parse(plain) as WebhookSecrets;
  if (typeof parsed?.current !== "string") throw new Error("a webhook secret opened to something else");
  return parsed;
}

export function sealWebhookSecrets(box: SecretBox, webhookId: string, secrets: WebhookSecrets): Promise<string> {
  return box.seal("webhook-secret", webhookId, JSON.stringify(secrets));
}

/** The endpoint's extra headers, opened. An endpoint with none has no sealed blob at all. */
export async function openWebhookHeaders(
  box: SecretBox,
  webhookId: string,
  sealed: string | null,
): Promise<Record<string, string>> {
  if (!sealed) return {};
  const parsed = JSON.parse(await box.open("webhook-headers", webhookId, sealed)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  return out;
}

async function sealWebhookHeaders(
  box: SecretBox,
  webhookId: string,
  headers: Record<string, string>,
): Promise<{ sealed: string | null; names: string[] }> {
  const names = Object.keys(headers);
  if (names.length === 0) return { sealed: null, names };
  return { sealed: await box.seal("webhook-headers", webhookId, JSON.stringify(headers)), names };
}

// ---- subscriptions -----------------------------------------------------------------

/** `*` is everything, `booking.*` every booking event, `*.create` every new item. */
export function matchesEvent(patterns: readonly string[], type: string): boolean {
  const actual = type.split(".");
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    const parts = pattern.split(".");
    return parts.length === actual.length && parts.every((p, i) => p === "*" || p === actual[i]);
  });
}

/** https on a public host, unless the owner has opted into private targets for a machine they run. */
export function checkWebhookUrl(url: string, allowPrivate: boolean): WriteError | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return badUrl("that is not a URL");
  }
  // `allowPrivateTargets` relaxes the host and the plain-http rule, never the scheme itself: a
  // `file:` or `javascript:` URL is not an endpoint under any setting. The delivery job says the
  // same thing in the same words; this is the door that has to agree with it.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return badUrl("the endpoint must be http or https");
  }
  if (allowPrivate) return null;
  if (parsed.protocol !== "https:") {
    return badUrl("use https: an http address sends every event, and its signature, in the clear");
  }
  if (!isPublicHost(parsed.hostname)) {
    return badUrl(
      `${parsed.hostname} is not a public host. To reach a machine you control, set integrations.webhooks.allowPrivateTargets in Settings.`,
    );
  }
  return null;
}

/**
 * No IP literals, no local, internal or reserved names. The rule lives in `util/hosts.ts`, beside
 * the network-origin check that uses it too; it is re-exported here because this is where
 * `@surfingdog/adapters` has always imported it from.
 */
export { isPublicHost };

// ---- the capability ------------------------------------------------------------------

type EventRow = {
  id: string;
  type: string;
  createdAt: number;
  itemId: string;
  itemType: string;
  itemState: string;
  itemVersion: number;
  sandbox?: number | null | undefined;
  actorKind?: string | null | undefined;
  actorId?: string | null | undefined;
  actorName?: string | null | undefined;
  channel?: string | null | undefined;
};

export class WebhookCapabilities {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
    /** Test seam. Production delivery is the `webhook_delivery` job; this is only `sendTestEvent`. */
    private readonly fetchImpl?: typeof fetch | undefined,
    /** `INBOX_PUBLIC_URL`, when the host knows it. See `eventBaseUrl`. */
    private readonly baseUrl?: string | undefined,
    /**
     * How far behind live the cursor reads, in milliseconds. See `EVENT_SETTLE_MS`. Zero turns the
     * horizon off, which is only ever right for a test that writes and polls in the same tick.
     */
    private readonly settleMs: number = EVENT_SETTLE_MS,
  ) {}

  // ---- endpoints ---------------------------------------------------------------

  async listWebhooks(caller: Caller): Promise<WebhookView[]> {
    requireOwner(caller);
    const rows = await this.db.orm.select().from(webhooksTable).orderBy(desc(webhooksTable.createdAt));
    const summaries = await this.summaries();
    return rows.map((r) => webhookView(r, summaries.get(r.id)));
  }

  async createWebhook(caller: Caller, input: S.CreateWebhookInput): Promise<WebhookWithSecret> {
    requireOwner(caller);
    const box = requireSecretBox(this.box);
    const now = nowOf(caller);
    const bad = checkWebhookUrl(input.url, (await this.config()).allowPrivateTargets);
    if (bad) throw bad;
    const id = ulid(now);
    const secret = mintWebhookSecret();
    const headers = await sealWebhookHeaders(box, id, input.headers ?? {});
    await this.db.orm.insert(webhooksTable).values({
      id,
      url: input.url,
      secretEnc: await sealWebhookSecrets(box, id, { current: secret }),
      events: [...input.events],
      payloadStyle: input.payload_style,
      active: 1,
      headersEnc: headers.sealed,
      headerNames: headers.names,
      createdAt: now,
      updatedAt: now,
    });
    return withSecret(await this.view(id), secret, null);
  }

  async updateWebhook(caller: Caller, input: S.UpdateWebhookInput): Promise<WebhookView> {
    requireOwner(caller);
    const now = nowOf(caller);
    const current = await this.row(input.webhook_id);
    if (input.url !== undefined) {
      const bad = checkWebhookUrl(input.url, (await this.config()).allowPrivateTargets);
      if (bad) throw bad;
    }
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];
    if (input.url !== undefined) {
      sets.push("url = ?");
      params.push(input.url);
    }
    if (input.events !== undefined) {
      sets.push("events = ?");
      params.push(JSON.stringify(input.events));
    }
    if (input.payload_style !== undefined) {
      sets.push("payload_style = ?");
      params.push(input.payload_style);
    }
    if (input.active !== undefined) {
      sets.push("active = ?");
      params.push(input.active ? 1 : 0);
      // Waking an endpoint clears the failure run, so five more days have to pass before it sleeps.
      if (input.active) sets.push("failing_since = NULL", "disabled_at = NULL", "last_error = NULL");
    }
    if (input.headers !== undefined && Object.keys(input.headers).length > 0) {
      // A merge, like settings: the names given change, the rest keep their values. The values are
      // sealed, so the current ones are opened to lay the change over them.
      const box = requireSecretBox(this.box);
      const merged = await openWebhookHeaders(box, current.id, current.headersEnc);
      for (const [name, value] of Object.entries(input.headers)) {
        for (const existing of Object.keys(merged)) {
          if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
        }
        if (value !== null) merged[name] = value;
      }
      if (Object.keys(merged).length > MAX_WEBHOOK_HEADERS) {
        throw new WriteError("invalid_input", `at most ${MAX_WEBHOOK_HEADERS} headers per endpoint`, {
          fields: [{ path: "headers", problem: "invalid", message: "remove one first (set it to null)" }],
        });
      }
      const sealed = await sealWebhookHeaders(box, current.id, merged);
      sets.push("headers_enc = ?", "header_names = ?");
      params.push(sealed.sealed, JSON.stringify(sealed.names));
    }
    params.push(input.webhook_id);
    await this.db.client.query({
      sql: `UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?`,
      params,
      method: "run",
    });
    return this.view(input.webhook_id);
  }

  /**
   * A new secret, shown once. The old one keeps verifying for a day (ADR-015 §4), so a receiver can
   * be redeployed without dropping an event on the floor.
   */
  async rotateWebhookSecret(caller: Caller, input: S.WebhookIdInput): Promise<WebhookWithSecret> {
    requireOwner(caller);
    const box = requireSecretBox(this.box);
    const now = nowOf(caller);
    const row = await this.row(input.webhook_id);
    const old = await openWebhookSecrets(box, row.id, row.secretEnc);
    const secret = mintWebhookSecret();
    const until = now + SECRET_GRACE_MS;
    const sealed = await sealWebhookSecrets(box, row.id, {
      current: secret,
      previous: old.current,
      previousUntil: until,
    });
    await this.db.client.query({
      sql: "UPDATE webhooks SET secret_enc = ?, updated_at = ? WHERE id = ?",
      params: [sealed, now, row.id],
      method: "run",
    });
    return withSecret(await this.view(row.id), secret, until);
  }

  async deleteWebhook(caller: Caller, input: S.WebhookIdInput): Promise<{ deleted: true }> {
    requireOwner(caller);
    await this.row(input.webhook_id);
    // The deliveries point at the endpoint, so they go in the same batch or the foreign key bites.
    await this.db.batch([
      { sql: "DELETE FROM webhook_deliveries WHERE webhook_id = ?", params: [input.webhook_id], method: "run" },
      { sql: "DELETE FROM webhooks WHERE id = ?", params: [input.webhook_id], method: "run" },
    ]);
    return { deleted: true };
  }

  // ---- deliveries --------------------------------------------------------------

  async listDeliveries(
    caller: Caller,
    input: S.ListDeliveriesInput,
  ): Promise<{ items: DeliveryView[]; next_cursor: string | null }> {
    requireOwner(caller);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.webhook_id) {
      where.push("webhook_id = ?");
      params.push(input.webhook_id);
    }
    if (input.status) {
      where.push("status = ?");
      params.push(input.status);
    }
    if (input.cursor) {
      where.push("id < ?");
      params.push(input.cursor);
    }
    params.push(input.limit + 1);
    const { rows } = await this.db.client.query({
      sql: `SELECT id, webhook_id, event_id, event_type, status, attempts, next_at, last_status, last_error, duration_ms, created_at, delivered_at
            FROM webhook_deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY id DESC LIMIT ?`,
      params,
      method: "all",
    });
    const items = rows.slice(0, input.limit).map(deliveryFromRow);
    const last = items[items.length - 1];
    return { items, next_cursor: rows.length > input.limit && last ? last.id : null };
  }

  /** Re-sends one delivery on the row it already has, so the event is never delivered twice over. */
  async replayDelivery(caller: Caller, input: S.DeliveryIdInput): Promise<DeliveryView> {
    requireOwner(caller);
    const now = nowOf(caller);
    const res = await this.db.client.query({
      sql: "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_at = ?, last_error = NULL, delivered_at = NULL WHERE id = ?",
      params: [now, input.delivery_id],
      method: "run",
    });
    if (res.changes !== 1) throw unknown("delivery_id", "unknown delivery");
    await this.db.batch([
      ...clearAttemptJobs([input.delivery_id]),
      jobStatement(WEBHOOK_DELIVERY_KIND, { deliveryId: input.delivery_id }, now),
    ]);
    return this.delivery(input.delivery_id);
  }

  /**
   * Every event this endpoint should have had since an instant and does not: the fix after a URL was
   * wrong, a receiver was down, or an endpoint was added late. Existing rows are re-queued in place.
   */
  async replayMissing(
    caller: Caller,
    input: S.ReplayMissingInput,
  ): Promise<{
    webhook_id: string;
    matched: number;
    queued: number;
    truncated: boolean;
    next_after: string | null;
  }> {
    requireOwner(caller);
    const now = nowOf(caller);
    const row = await this.row(input.webhook_id);
    const since = Date.parse(input.since);
    const events = await this.readEvents({ since, after: input.after, limit: REPLAY_MAX + 1 });
    const truncated = events.length > REPLAY_MAX;
    // The cursor is the last event **scanned**, not the last one matched: a window in which nothing
    // matched this endpoint's subscriptions still has to advance, or the caller loops on it for ever.
    const nextAfter = truncated ? (events[REPLAY_MAX - 1]?.id ?? null) : null;
    const matching = events.slice(0, REPLAY_MAX).filter((e) => matchesEvent(row.events, e.type));
    if (matching.length === 0) {
      return { webhook_id: row.id, matched: 0, queued: 0, truncated, next_after: nextAfter };
    }
    await this.db.batch(
      matching.map((e) => ({
        sql: "INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
        params: [ulid(now), row.id, e.id, e.type, now, now],
        method: "run" as const,
      })),
    );
    for (const chunk of chunks(
      matching.map((e) => e.id),
      50,
    )) {
      await this.db.client.query({
        sql: `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_at = ?, last_error = NULL
              WHERE webhook_id = ? AND status <> 'delivered' AND event_id IN (${chunk.map(() => "?").join(", ")})`,
        params: [now, row.id, ...chunk],
        method: "run",
      });
    }
    const queued: string[] = [];
    for (const chunk of chunks(
      matching.map((e) => e.id),
      50,
    )) {
      const { rows } = await this.db.client.query({
        sql: `SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending' AND event_id IN (${chunk.map(() => "?").join(", ")})`,
        params: [row.id, ...chunk],
        method: "all",
      });
      for (const r of rows) queued.push(String(r[0]));
    }
    if (queued.length) {
      // Same reason as `replayDelivery`: a delivery that already burned a chain has jobs keyed
      // `whsend:<id>:<attempt>` sitting in the table, and attempts start from zero again here.
      await this.db.batch([
        ...clearAttemptJobs(queued),
        ...queued.map((id) => jobStatement(WEBHOOK_DELIVERY_KIND, { deliveryId: id }, now)),
      ]);
    }
    return {
      webhook_id: row.id,
      matched: matching.length,
      queued: queued.length,
      truncated,
      next_after: nextAfter,
    };
  }

  /**
   * One real, signed, clearly marked test event, delivered here and now so the answer is the actual
   * HTTP status. It is the one delivery that does not go through the job runner, because the owner
   * is standing in front of the screen waiting to know whether the URL works.
   */
  async sendTestEvent(caller: Caller, input: S.WebhookIdInput): Promise<TestEventResult> {
    requireOwner(caller);
    const box = requireSecretBox(this.box);
    const now = nowOf(caller);
    const row = await this.row(input.webhook_id);
    const secrets = await openWebhookSecrets(box, row.id, row.secretEnc);
    const settings = await readSettings(this.db);
    const extra = await openWebhookHeaders(box, row.id, row.headersEnc);
    const eventId = ulid(now);
    const event = {
      id: eventId,
      type: TEST_EVENT_TYPE,
      timestamp: new Date(now).toISOString(),
      test: true as const,
      message: "A test event from a Surfing Dog Inbox. Nothing was created; no item exists behind it.",
      data: {
        id: eventId,
        type: "test",
        state: "test",
        version: 1,
        url: `${eventBaseUrl(this.baseUrl, settings.notifications.appUrl)}/v1/owner/webhooks/${row.id}`,
        actor: eventActor(caller.actor.kind, caller.actor.id, actorMeta(caller).actor_name),
        channel: caller.actor.channel,
        sandbox: false,
      },
    };
    const body = JSON.stringify(event);
    const timestampSec = Math.floor(now / 1000);
    const signature = await webhookSignature(secrets, eventId, timestampSec, body, now);
    const started = Date.now();
    const fetchImpl = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.integrations.webhooks.timeoutMs);
    let status: number | null = null;
    let error: string | null = null;
    // The same rule the delivery job applies, re-checked here: an address that was public when it
    // was added is not necessarily public now that `allowPrivateTargets` has been turned back off.
    const unsafe = checkWebhookUrl(row.url, settings.integrations.webhooks.allowPrivateTargets);
    try {
      if (unsafe) throw new Error(unsafe.message);
      const res = await fetchImpl(row.url, {
        method: "POST",
        body,
        // A redirect is a failure, not a hop: it is also how an endpoint would be talked into
        // pointing somewhere else after the owner approved it (ADR-015 §5).
        redirect: "manual",
        signal: controller.signal,
        headers: webhookHeaders({
          id: eventId,
          timestampSec,
          signature,
          eventType: TEST_EVENT_TYPE,
          attempt: 1,
          extra,
        }),
      });
      status = res.status;
      if (!res.ok)
        error = `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? " (a redirect is a failure)" : ""}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - started;
    const delivered = error === null;
    const deliveryId = ulid(now);
    await this.db.orm.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId: row.id,
      eventId,
      eventType: TEST_EVENT_TYPE,
      status: delivered ? "delivered" : "failed",
      attempts: 1,
      nextAt: null,
      lastStatus: status,
      lastError: error,
      durationMs,
      createdAt: now,
      deliveredAt: delivered ? now : null,
    });
    return {
      delivered,
      status,
      duration_ms: durationMs,
      error,
      event,
      delivery: await this.delivery(deliveryId),
    };
  }

  // ---- the developer cursor ------------------------------------------------------

  /**
   * The event stream for someone who cannot receive a webhook: the same events, over the same ids,
   * read straight from `events_v1` with `WHERE id > ? ORDER BY id LIMIT ?`. Both arms of the view
   * have ULID primary keys, so the order is total and stable and an event is never returned twice.
   * Keep `next_cursor` and pass it back; an empty page returns null and your cursor still stands.
   *
   * The stream trails live by a few seconds (`EVENT_SETTLE_MS`). That lag is what makes
   * `next_cursor` safe as a hard watermark: an id is minted before its batch commits, so without it
   * a row that commits late could appear below a cursor that has already passed it, and `id > ?`
   * would never return it again.
   */
  async listEvents(caller: Caller, input: S.ListEventsInput): Promise<EventPage> {
    requireOwner(caller);
    const settings = await readSettings(this.db);
    const base = eventBaseUrl(this.baseUrl, settings.notifications.appUrl);
    const rows = await this.readEvents({
      after: input.cursor,
      limit: input.limit,
      ...(input.types ? { types: input.types } : {}),
      ...(input.since ? { since: Date.parse(input.since) } : {}),
    });
    const last = rows[rows.length - 1];
    return { events: rows.map((r) => thinEvent(r, base)), next_cursor: last ? last.id : null };
  }

  // ---- helpers --------------------------------------------------------------------

  private async readEvents(opts: {
    after?: string | undefined;
    since?: number | undefined;
    types?: readonly string[] | undefined;
    limit: number;
  }): Promise<EventRow[]> {
    // Two bounds, and they move together: `created_at` is the same `now` the id's timestamp prefix
    // is minted from, so holding the top of the range `settleMs` back means a batch that commits
    // late is still ahead of the horizon of the poll that would otherwise have stepped over it.
    const where: string[] = ["id > ?", "created_at <= ?"];
    const params: (string | number)[] = [opts.after ?? "", Date.now() - this.settleMs];
    if (opts.since !== undefined && Number.isFinite(opts.since)) {
      where.push("created_at >= ?");
      params.push(opts.since);
    }
    // `*` anywhere in the list means every type, so the test is made before the loop starts: a
    // pattern that pushed a parameter and then found a later `*` would leave that parameter behind
    // with no placeholder to bind it to, and the statement would be refused by the driver.
    if (opts.types?.length && !opts.types.includes("*")) {
      const ors: string[] = [];
      for (const pattern of opts.types) {
        const [left, right] = pattern.split(".");
        if (right === undefined) {
          ors.push("type = ?");
          params.push(pattern);
        } else if (left === "*") {
          ors.push("type LIKE ?");
          params.push(`%.${right}`);
        } else if (right === "*") {
          ors.push("type LIKE ?");
          params.push(`${left}.%`);
        } else {
          ors.push("type = ?");
          params.push(pattern);
        }
      }
      if (ors.length) where.push(`(${ors.join(" OR ")})`);
    }
    params.push(opts.limit);
    const { rows } = await this.db.client.query({
      sql: `SELECT id, type, created_at, item_id, item_type, item_state, item_version, sandbox, actor_kind, actor_id, actor_name, channel
            FROM events_v1 WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
      params,
      method: "all",
    });
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return rows.map((r) => ({
      id: String(r[0]),
      type: String(r[1]),
      createdAt: Number(r[2]),
      itemId: String(r[3]),
      itemType: String(r[4]),
      itemState: String(r[5]),
      itemVersion: Number(r[6]),
      sandbox: Number(r[7] ?? 0),
      actorKind: text(r[8]),
      actorId: text(r[9]),
      actorName: text(r[10]),
      channel: text(r[11]),
    }));
  }

  private async config() {
    return (await readSettings(this.db)).integrations.webhooks;
  }

  private async row(id: string): Promise<typeof webhooksTable.$inferSelect> {
    const [row] = await this.db.orm.select().from(webhooksTable).where(eq(webhooksTable.id, id));
    if (!row) throw unknown("webhook_id", "unknown webhook");
    return row;
  }

  private async view(id: string): Promise<WebhookView> {
    return webhookView(await this.row(id), (await this.summaries(id)).get(id));
  }

  private async delivery(id: string): Promise<DeliveryView> {
    const [row] = await this.db.orm.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    if (!row) throw unknown("delivery_id", "unknown delivery");
    return {
      id: row.id,
      webhook_id: row.webhookId,
      event_id: row.eventId,
      event_type: row.eventType,
      status: row.status as S.DeliveryStatus,
      attempts: row.attempts,
      last_status: row.lastStatus,
      last_error: row.lastError,
      duration_ms: row.durationMs,
      created_at: new Date(row.createdAt).toISOString(),
      delivered_at: row.deliveredAt === null ? null : new Date(row.deliveredAt).toISOString(),
      next_attempt_at: row.status === "pending" && row.nextAt !== null ? new Date(row.nextAt).toISOString() : null,
    };
  }

  private async summaries(webhookId?: string): Promise<Map<string, DeliverySummary>> {
    const { rows } = await this.db.client.query({
      sql: `SELECT webhook_id, status, COUNT(*), MAX(created_at) FROM webhook_deliveries
            ${webhookId ? "WHERE webhook_id = ?" : ""} GROUP BY webhook_id, status`,
      params: webhookId ? [webhookId] : [],
      method: "all",
    });
    const out = new Map<string, DeliverySummary>();
    for (const r of rows) {
      const id = String(r[0]);
      const current = out.get(id) ?? EMPTY_SUMMARY;
      const count = Number(r[2]);
      const at = Number(r[3]);
      const lastIso = new Date(at).toISOString();
      out.set(id, {
        pending: current.pending + (String(r[1]) === "pending" ? count : 0),
        delivered: current.delivered + (String(r[1]) === "delivered" ? count : 0),
        failed: current.failed + (String(r[1]) === "failed" ? count : 0),
        last_delivery_at:
          current.last_delivery_at && current.last_delivery_at > lastIso ? current.last_delivery_at : lastIso,
      });
    }
    return out;
  }
}

const EMPTY_SUMMARY: DeliverySummary = { pending: 0, delivered: 0, failed: 0, last_delivery_at: null };

/**
 * The thin event (ADR-015 §3), built here and nowhere else: `GET /v1/owner/events` returns this,
 * and the delivery job POSTs this with the same base URL, so the two cannot drift apart a field at
 * a time. `appBaseUrl` is normalised rather than trusted — a trailing slash in Settings must not
 * become a double slash in somebody's logs.
 */
export function thinEvent(row: EventRow, appBaseUrl: string): ThinEvent {
  const base = appBaseUrl.replace(/\/+$/, "");
  return {
    id: row.id,
    type: row.type,
    timestamp: new Date(row.createdAt).toISOString(),
    data: {
      id: row.itemId,
      type: row.itemType,
      state: row.itemState,
      version: row.itemVersion,
      url: `${base}/v1/owner/items/${row.itemId}`,
      actor: eventActor(row.actorKind ?? "system", row.actorId ?? null, row.actorName),
      channel: row.channel ?? null,
      sandbox: Number(row.sandbox ?? 0) === 1,
    },
  };
}

function webhookView(row: typeof webhooksTable.$inferSelect, summary: DeliverySummary | undefined): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    payload_style: row.payloadStyle as S.PayloadStyle,
    headers: Array.isArray(row.headerNames) ? row.headerNames : [],
    active: row.active === 1,
    failing_since: row.failingSince === null ? null : new Date(row.failingSince).toISOString(),
    disabled_at: row.disabledAt === null ? null : new Date(row.disabledAt).toISOString(),
    last_error: row.lastError,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    deliveries: summary ?? EMPTY_SUMMARY,
  };
}

function withSecret(view: WebhookView, secret: string, previousUntil: number | null): WebhookWithSecret {
  return {
    ...view,
    secret,
    secret_note: "Store this now. It is shown once and never again; if it is lost, rotate the secret to get a new one.",
    previous_secret_until: previousUntil === null ? null : new Date(previousUntil).toISOString(),
  };
}

function deliveryFromRow(r: readonly unknown[]): DeliveryView {
  const status = String(r[4]) as S.DeliveryStatus;
  const nextAt = r[6] === null || r[6] === undefined ? null : Number(r[6]);
  const deliveredAt = r[11] === null || r[11] === undefined ? null : Number(r[11]);
  return {
    id: String(r[0]),
    webhook_id: String(r[1]),
    event_id: String(r[2]),
    event_type: String(r[3]),
    status,
    attempts: Number(r[5]),
    last_status: r[7] === null || r[7] === undefined ? null : Number(r[7]),
    last_error: r[8] === null || r[8] === undefined ? null : String(r[8]),
    duration_ms: r[9] === null || r[9] === undefined ? null : Number(r[9]),
    created_at: new Date(Number(r[10])).toISOString(),
    delivered_at: deliveredAt === null ? null : new Date(deliveredAt).toISOString(),
    next_attempt_at: status === "pending" && nextAt !== null ? new Date(nextAt).toISOString() : null,
  };
}

/**
 * The base every event's `url` hangs off, resolved in exactly one place and in exactly one order:
 * the URL the host was started with (`INBOX_PUBLIC_URL`) first, then the Inbox address the owner
 * typed into Settings, and a relative path when the instance has never been told either.
 *
 * The delivery job resolves it with this same function, so the `data.url` in a webhook body and
 * the `data.url` in `GET /v1/owner/events` are the same string for the same event — which is the
 * whole promise of the cursor being "the same stream by polling".
 */
export function eventBaseUrl(hostBaseUrl: string | undefined, appUrl: string | undefined): string {
  return (hostBaseUrl ?? appUrl ?? "").replace(/\/+$/, "");
}

/**
 * The key material: the base64 after the `whsec_` prefix. A secret that is not base64 at all is
 * used as its own bytes rather than refused, because some receivers hand out a passphrase — and
 * those bytes are the **whole** secret, prefix and all, which is what `@surfingdog/sdk`'s
 * `verifyWebhook` does. Both sides computing the same thing is the entire requirement; the one
 * thing that must never happen is the two of them disagreeing about where the prefix went.
 */
export function webhookSecretBytes(secret: string): Uint8Array {
  const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (body.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    try {
      const binary = atob(body);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch {
      // Falls through: `atob` still refuses some strings the shape test lets past.
    }
  }
  return encoder.encode(secret);
}

/**
 * Deletes the delivery-attempt jobs a previous chain left behind, so a replay's own chain can
 * number its attempts from zero again without colliding with them. ULIDs contain no `%` or `_`, so
 * the LIKE needs no ESCAPE, and `dedupe_key` is the unique-indexed column, so the delete is cheap.
 * A still-queued job from the old chain going with them is correct: the replay supersedes it.
 */
function clearAttemptJobs(deliveryIds: readonly string[]): Statement[] {
  return deliveryIds.map((id) => ({
    sql: "DELETE FROM jobs WHERE kind = ? AND dedupe_key LIKE ?",
    params: [WEBHOOK_DELIVERY_KIND, `${deliverJobPrefix(id)}%`],
    method: "run" as const,
  }));
}

function* chunks<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) {
    throw new WriteError("not_allowed", "webhooks and the event stream need an owner or staff principal");
  }
}

function unknown(path: string, message: string): WriteError {
  return new WriteError("invalid_input", message, { fields: [{ path, problem: "invalid", message }] });
}

function badUrl(message: string): WriteError {
  return new WriteError("invalid_input", message, { fields: [{ path: "url", problem: "invalid", message }] });
}
