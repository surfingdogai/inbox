import { type Statement, sha256Hex } from "@surfingdog/platform";
import { z } from "zod";
import { businessFacts } from "../customer/audience";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import { ensureJob } from "../jobs/schedule";
import { requireSecretBox, type SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, isOwnerAssistant, nowOf } from "../write/caller";
import { jobStatement } from "../write/common";
import { fromZod, WriteError } from "../write/errors";
import { type GalleryCard, gallery } from "./gallery";
import {
  type CalendarChoice,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttp,
  describeForm,
  type InboxIdentity,
  type LinkState,
  type OutboundBooking,
  type RunContext,
  secretKeys,
} from "./sdk";
import {
  BUSY_HORIZON_MS,
  claimLink,
  clearBusyStatements,
  dueRetries,
  type LinkRow,
  liveLinks,
  readLink,
  retryDelayMs,
  settleLink,
  writeBusy,
} from "./store";

/**
 * Connected platforms (ADR-014, ADR-015, ADR-020): the owner connects, chooses, syncs and
 * disconnects here; the jobs call `run` every few minutes and after every booking event.
 *
 * The rules that shape it:
 * - **A connector is a row, never a setting** (ADR-015 §1). Credentials are sealed by the secret
 *   box, bound to the row, and no answer of any door ever carries them. Without `INBOX_SECRET_KEY`
 *   nothing is connected (fail closed).
 * - **Connecting is the owner's**: it hands over a password or a sign-in. The owner's AI may list and
 *   sync what is connected, never connect or disconnect it.
 * - **Busy times only remove times.** They never move, cancel or refuse a booking already made.
 * - **One job at a time per booking calls the platform** (`claimLink`), so two syncs that meet never
 *   write a booking twice, and a run that stopped half way is finished by the next.
 */

export const CONNECTOR_SYNC_KIND = "connector_sync";
export const CONNECTOR_PUSH_KIND = "connector_push";
/** Busy times are read this often; a booking event writes out at once. */
export const CONNECTOR_SYNC_INTERVAL_MS = 5 * 60_000;
/** Calendars and event types are read again this often: they change rarely. */
const REFRESH_EVERY_MS = 6 * 3_600_000;
/** Bookings changed this long before the cursor are looked at again: writes that landed out of order. */
const CURSOR_LOOKBACK_MS = 2 * 60_000;
/** Calls to a platform in one run; the rest wait for the next, which is queued at once. */
const WRITES_PER_RUN = 25;
/** A sign-in on the platform's page must come back within this. */
const AUTH_TTL_MS = 10 * 60_000;

/** The non-secret half of a connection, as `connectors.config_public` keeps it. */
export interface PublicConfig {
  readonly preset: string | null;
  readonly account: string;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly calendars: readonly CalendarChoice[];
  readonly destinations: readonly CalendarChoice[];
  /** The calendars busy times are read from. */
  readonly busyCalendars: readonly string[];
  /** Where bookings go; null for the connector's own default. */
  readonly destination: string | null;
  /** The services busy times apply to; null for all of them. */
  readonly services: readonly string[] | null;
  readonly busyOn: boolean;
  readonly bookingsOn: boolean;
  readonly refreshedAt: number;
}

/** A connection as every door shows it: never a secret. */
export interface ConnectionView {
  readonly id: string;
  readonly kind: string;
  readonly preset: string | null;
  readonly title: string;
  readonly name: string;
  readonly account: string;
  /** `configured` (not synced yet), `active`, `error` or `disabled` (paused). */
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly busy_on: boolean;
  readonly bookings_on: boolean;
  readonly calendars: readonly CalendarChoice[];
  readonly busy_calendars: readonly string[];
  readonly destinations: readonly CalendarChoice[];
  readonly destination: string | null;
  readonly services: readonly string[] | null;
  readonly busy_times: number;
  readonly busy_read_at: number | null;
  readonly bookings_written: number;
  readonly bookings_failing: number;
  readonly booking_error: string | null;
  readonly last_sync_at: number | null;
  readonly last_error: string | null;
  readonly last_error_at: number | null;
  readonly created_at: number;
}

export interface IntegrationsView {
  readonly cards: readonly GalleryCard[];
  readonly connections: readonly ConnectionView[];
  /** False without INBOX_SECRET_KEY: nothing can be connected, and the owner is told why. */
  readonly can_connect: boolean;
}

export const connectInput = z.object({
  kind: z.string().min(1).max(40),
  preset: z.string().min(1).max(40).optional(),
  values: z.record(z.string(), z.string().max(4096)).default({}),
  name: z.string().trim().max(80).optional(),
});
export type ConnectInput = z.input<typeof connectInput>;

export const updateConnectionInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  busy_on: z.boolean().optional(),
  bookings_on: z.boolean().optional(),
  busy_calendars: z.array(z.string().max(2048)).max(50).optional(),
  destination: z.string().max(2048).nullable().optional(),
  services: z.array(z.string().max(64)).max(200).nullable().optional(),
  paused: z.boolean().optional(),
});
export type UpdateConnectionInput = z.input<typeof updateConnectionInput>;

export const authorizeInput = z.object({
  kind: z.string().min(1).max(40),
  /** A path in the owner app to come back to; never another site. */
  return_to: z.string().max(200).optional(),
});
export type AuthorizeInput = z.input<typeof authorizeInput>;

interface ConnectorRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly externalId: string | null;
  readonly configEnc: string | null;
  readonly config: PublicConfig;
  readonly cursor: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly lastSyncAt: number | null;
  readonly busyAt: number | null;
  readonly createdAt: number;
}

export interface RunReport {
  readonly written: number;
  readonly removed: number;
  readonly failed: number;
  readonly busy: number | null;
  readonly more: boolean;
  readonly note: string;
}

export class ConnectorCapabilities {
  private readonly definitions = new Map<string, ConnectorDefinition>();
  private http: ConnectorHttp | null = null;
  /** The one redirect address every sign-in uses, when the host keeps one (hosted); else per inbox. */
  private fixedRedirect: ((kind: string) => string | undefined) | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
    private readonly baseUrl: string | undefined,
  ) {}

  /**
   * The connectors this inbox offers and how they reach the world: plugged in by the host, so core
   * holds no platform code and no fetch. Attaching again replaces what was attached.
   */
  attach(opts: {
    readonly definitions: readonly ConnectorDefinition[];
    readonly http: ConnectorHttp;
    readonly redirectUri?: ((kind: string) => string | undefined) | undefined;
  }): void {
    this.definitions.clear();
    for (const d of opts.definitions) this.definitions.set(d.kind, d);
    this.http = opts.http;
    this.fixedRedirect = opts.redirectUri ?? null;
  }

  definition(kind: string): ConnectorDefinition | undefined {
    return this.definitions.get(kind);
  }

  /**
   * A connect request as the idempotency layer may keep it: its secret fields left out, so no hash of
   * a password or an API key is ever stored beside the answer.
   */
  withoutSecrets(input: ConnectInput): ConnectInput {
    const form = this.definitions.get(input.kind)?.form;
    const secret = new Set(form ? secretKeys(form) : Object.keys(input.values ?? {}));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.values ?? {})) if (!secret.has(k)) values[k] = v;
    return { ...input, values };
  }

  /* --- what the owner sees ------------------------------------------------ */

  async integrations(caller: Caller): Promise<IntegrationsView> {
    requireOwnerSide(caller);
    return {
      cards: gallery(this.definitions),
      connections: await this.list(caller),
      can_connect: this.secrets !== null,
    };
  }

  async list(caller: Caller): Promise<ConnectionView[]> {
    requireOwnerSide(caller);
    const rows = await this.rows();
    const out: ConnectionView[] = [];
    for (const row of rows) out.push(await this.view(row));
    return out;
  }

  async get(caller: Caller, id: string): Promise<ConnectionView> {
    requireOwnerSide(caller);
    return this.view(await this.row(id));
  }

  /* --- connecting with a form ---------------------------------------------- */

  async connect(caller: Caller, raw: ConnectInput): Promise<ConnectionView> {
    requireOwnerSide(caller);
    requireNotAssistant(caller, "connect");
    const box = requireSecretBox(this.secrets);
    const input = parse(connectInput, raw);
    const def = this.usable(input.kind);
    if (def.auth !== "form" || !def.form || !def.connect) {
      throw new WriteError(
        "invalid_input",
        `${def.title} is connected by signing in on ${def.title}: use authorize, not a form.`,
        {
          details: { reason: "sign_in", kind: def.kind },
        },
      );
    }
    const preset = input.preset ? def.presets?.find((p) => p.id === input.preset) : undefined;
    if (input.preset && !preset) {
      throw new WriteError("invalid_input", `${def.title} has no way called ${input.preset}`, {
        fields: [{ path: "preset", problem: "invalid", message: "unknown preset" }],
      });
    }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.values)) values[k] = v.trim();
    for (const [k, v] of Object.entries(preset?.values ?? {})) values[k] = v;
    // Empty is absent: an optional field the owner left blank is not a value of nothing.
    for (const k of Object.keys(values)) if (values[k] === "") delete values[k];
    // What the preset says it needs, beyond the schema (a Nextcloud address), is asked for by name.
    const missing = describeForm(def.form, preset).filter((f) => f.required && values[f.key] === undefined);
    if (missing.length > 0) {
      throw new WriteError("invalid_input", `Missing: ${missing.map((f) => f.label).join(", ")}.`, {
        fields: missing.map((f) => ({
          path: `values.${f.key}`,
          problem: "missing" as const,
          message: `${f.label} is needed`,
        })),
      });
    }
    const checked = def.form.safeParse(values);
    if (!checked.success) throw fromZod(checked.error, "values");
    const now = nowOf(caller);
    let connected: Connected;
    try {
      connected = await def.connect(await this.connectContext(now), checked.data as Record<string, string>);
    } catch (error) {
      throw asWriteError(error, def.title);
    }
    return this.store(def, input.preset ?? null, connected, input.name, now, box);
  }

  /* --- connecting by signing in on the platform (OAuth with PKCE) ---------- */

  async authorize(caller: Caller, raw: AuthorizeInput, origin: string): Promise<{ authorize_url: string }> {
    requireOwnerSide(caller);
    requireNotAssistant(caller, "connect");
    const box = requireSecretBox(this.secrets);
    const input = parse(authorizeInput, raw);
    const def = this.usable(input.kind);
    if (def.auth !== "oauth" || !def.oauth) {
      throw new WriteError("invalid_input", `${def.title} is connected with a form, not a sign-in.`, {
        details: { reason: "form", kind: def.kind },
      });
    }
    const now = nowOf(caller);
    const fixed = this.fixedRedirect?.(def.kind);
    const cleanOrigin = origin.replace(/\/+$/, "");
    const redirectUri = fixed ?? `${cleanOrigin}${callbackPath(def.kind)}`;
    // With one redirect address for every inbox (hosted), the state says which inbox to come back to;
    // the rest of it is a secret only this inbox holds a hash of.
    const state = fixed ? `${toBase64Url(new TextEncoder().encode(cleanOrigin))}.${randomToken(24)}` : randomToken(24);
    const verifier = randomToken(48);
    const challenge = toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    const stateHash = await sha256Hex(new TextEncoder().encode(state));
    await this.db.batch([
      { sql: "DELETE FROM connector_auth WHERE expires_at < ?", params: [now - 86_400_000], method: "run" },
      {
        sql: `INSERT INTO connector_auth (state_hash, kind, verifier_enc, redirect_uri, return_to, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          stateHash,
          def.kind,
          await box.seal("connector-config", `auth:${stateHash}`, verifier),
          redirectUri,
          safeReturnPath(input.return_to),
          now,
          now + AUTH_TTL_MS,
        ],
        method: "run",
      },
    ]);
    return { authorize_url: def.oauth.authorizeUrl({ redirectUri, state, challenge }) };
  }

  /**
   * The platform sent the owner back. The state is the proof: it was minted for this inbox, is used
   * once, and lapses in ten minutes. Never throws: the owner lands back in Settings either way, and
   * is told in plain words what happened.
   */
  async finishAuthorization(p: {
    readonly kind: string;
    readonly state: string;
    readonly code?: string | undefined;
    readonly error?: string | undefined;
    readonly now: number;
  }): Promise<{ readonly returnTo: string; readonly ok: boolean; readonly message: string; readonly id?: string }> {
    const fallback = "/settings/integrations";
    const stateHash = await sha256Hex(new TextEncoder().encode(p.state));
    const { rows } = await this.db.client.query({
      sql: "SELECT kind, verifier_enc, redirect_uri, return_to, expires_at, used_at FROM connector_auth WHERE state_hash = ?",
      params: [stateHash],
      method: "all",
    });
    const row = rows[0];
    if (!row || String(row[0]) !== p.kind) {
      return { returnTo: fallback, ok: false, message: "That sign-in was not started here. Try again from Settings." };
    }
    const returnTo = String(row[3] || fallback);
    const claimed = await this.db.client.query({
      sql: "UPDATE connector_auth SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at >= ?",
      params: [p.now, stateHash, p.now],
      method: "run",
    });
    if (claimed.changes !== 1) {
      return { returnTo, ok: false, message: "That sign-in had expired or was used already. Try again." };
    }
    const def = this.definitions.get(p.kind);
    if (!def?.oauth || !this.secrets) {
      return { returnTo, ok: false, message: "This inbox cannot finish that sign-in now." };
    }
    if (p.error || !p.code) {
      const declined = p.error === "access_denied";
      return {
        returnTo,
        ok: false,
        message: declined
          ? "Nothing was connected: access was not allowed."
          : `${def.title} did not finish the sign-in.`,
      };
    }
    try {
      const verifier = await this.secrets.open("connector-config", `auth:${stateHash}`, String(row[1]));
      const ctx = await this.connectContext(p.now);
      const connected = await def.oauth.exchange(ctx, { code: p.code, verifier, redirectUri: String(row[2]) });
      const view = await this.store(def, null, connected, undefined, p.now, this.secrets, true);
      return { returnTo, ok: true, message: `${def.title} is connected.`, id: view.id };
    } catch (error) {
      const message =
        error instanceof ConnectorError || error instanceof WriteError
          ? error.message
          : `${def.title} did not finish the sign-in.`;
      return { returnTo, ok: false, message };
    }
  }

  /* --- choosing, pausing, syncing, disconnecting --------------------------- */

  async update(caller: Caller, id: string, raw: UpdateConnectionInput): Promise<ConnectionView> {
    requireOwnerSide(caller);
    requireNotAssistant(caller, "change");
    const input = parse(updateConnectionInput, raw);
    const row = await this.row(id);
    const now = nowOf(caller);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const json: [string, unknown][] = [];
    if (input.busy_calendars !== undefined) {
      const known = new Set(row.config.calendars.map((c) => c.id));
      const bad = input.busy_calendars.find((c) => !known.has(c));
      if (bad !== undefined) {
        throw new WriteError("invalid_input", "That calendar is not one this connection has.", {
          fields: [{ path: "busy_calendars", problem: "invalid", message: `unknown calendar ${bad}` }],
        });
      }
      json.push(["$.busyCalendars", [...new Set(input.busy_calendars)]]);
    }
    if (input.destination !== undefined) {
      const dest = input.destination;
      if (dest !== null && !row.config.destinations.some((d) => d.id === dest && d.writable)) {
        throw new WriteError("invalid_input", "Bookings cannot go there.", {
          fields: [{ path: "destination", problem: "invalid", message: "not a destination of this connection" }],
        });
      }
      json.push(["$.destination", dest]);
    }
    if (input.services !== undefined) {
      if (input.services !== null) {
        const { rows } = await this.db.client.query({ sql: "SELECT id FROM services", method: "all" });
        const known = new Set(rows.map((r) => String(r[0])));
        const bad = input.services.find((s) => !known.has(s));
        if (bad !== undefined) {
          throw new WriteError("invalid_input", "That is not one of your services.", {
            fields: [{ path: "services", problem: "invalid", message: `unknown service ${bad}` }],
          });
        }
      }
      json.push(["$.services", input.services === null ? null : [...new Set(input.services)]]);
    }
    if (input.busy_on !== undefined) json.push(["$.busyOn", input.busy_on]);
    if (input.bookings_on !== undefined) json.push(["$.bookingsOn", input.bookings_on]);
    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.paused !== undefined) {
      sets.push("status = ?");
      params.push(input.paused ? "disabled" : row.status === "disabled" ? "configured" : row.status);
    }
    const statements: Statement[] = [];
    if (json.length > 0) {
      // json_set on the keys the owner changed, never a rewrite of the document: a sync refreshing the
      // calendar list at the same moment keeps what it wrote, and so does the owner.
      sets.push(`config_public = json_set(config_public, ${json.map(() => "?, json(?)").join(", ")})`);
      for (const [path, value] of json) params.push(path, JSON.stringify(value));
    }
    if (sets.length > 0) {
      statements.push({
        sql: `UPDATE connectors SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
        params: [...params, now, id],
        method: "run",
      });
    }
    if (input.busy_on === false || input.paused === true) statements.push(...clearBusyStatements(id));
    // What changed shows at once: busy times are read again, bookings written out.
    if (input.paused !== true && (json.length > 0 || input.paused === false)) {
      statements.push(
        jobStatement(CONNECTOR_SYNC_KIND, { connectorId: id }, now, { dedupeKey: `csync:${id}:u${now}` }),
      );
    }
    if (statements.length > 0) await this.db.batch(statements);
    return this.view(await this.row(id));
  }

  async syncNow(caller: Caller, id: string): Promise<{ queued: true; connection_id: string }> {
    requireOwnerSide(caller);
    const row = await this.row(id);
    const now = nowOf(caller);
    await this.db.batch([
      jobStatement(CONNECTOR_SYNC_KIND, { connectorId: row.id }, now, { dedupeKey: `csync:${row.id}:n${now}` }),
    ]);
    return { queued: true, connection_id: row.id };
  }

  /**
   * Disconnects. Busy times stop blocking at once. Bookings already written stay in the calendar: they
   * are the business's own entries now, and taking them out is not something a disconnect should do.
   */
  async remove(caller: Caller, id: string): Promise<{ removed: true; left_in_calendar: number }> {
    requireOwnerSide(caller);
    requireNotAssistant(caller, "disconnect");
    const row = await this.row(id);
    const now = nowOf(caller);
    const left = (await liveLinks(this.db, row.id)).length;
    const def = this.definitions.get(row.kind);
    if (def?.disconnect) {
      try {
        await def.disconnect(await this.runContext(row, now));
      } catch {
        // Giving the access back is a courtesy to the platform: the connection goes either way.
      }
    }
    await this.db.batch([
      { sql: "DELETE FROM connector_busy WHERE connector_id = ?", params: [row.id], method: "run" },
      { sql: "DELETE FROM connector_links WHERE connector_id = ?", params: [row.id], method: "run" },
      { sql: "DELETE FROM connectors WHERE id = ?", params: [row.id], method: "run" },
    ]);
    return { removed: true, left_in_calendar: left };
  }

  /* --- the jobs ----------------------------------------------------------- */

  /**
   * One run for one connection: bookings written out first (so the busy times read next already leave
   * them out), then, for a full sync, busy times read and the calendar list refreshed now and then.
   * Records what happened on the row; throws only on our own bugs.
   */
  async run(connectorId: string, now: number, mode: "sync" | "push"): Promise<RunReport | null> {
    const row = await this.rowOrNull(connectorId);
    if (!row) return null;
    if (row.status === "disabled") {
      return { written: 0, removed: 0, failed: 0, busy: null, more: false, note: "paused" };
    }
    const def = this.definitions.get(row.kind);
    if (!def || !this.http || !this.secrets) {
      return { written: 0, removed: 0, failed: 0, busy: null, more: false, note: "not available on this instance" };
    }
    let ctx: RunContext;
    try {
      ctx = await this.runContext(row, now);
    } catch {
      await this.markError(row.id, "The saved credentials cannot be opened here. Connect it again.", now);
      return { written: 0, removed: 0, failed: 0, busy: null, more: false, note: "credentials do not open" };
    }

    let push = { written: 0, removed: 0, failed: 0, more: false };
    if (row.config.bookingsOn && def.bookings && def.capabilities.includes("write_bookings")) {
      push = await this.pushBookings(row, def, ctx, now);
    }
    if (mode === "push") {
      return { ...push, busy: null, note: `${push.written} written, ${push.removed} removed, ${push.failed} failed` };
    }

    let busy: number | null = null;
    try {
      if (def.refresh && now - (row.config.refreshedAt ?? 0) > REFRESH_EVERY_MS) {
        const fresh = await def.refresh(ctx);
        await this.db.client.query({
          sql: `UPDATE connectors SET config_public = json_set(config_public, '$.account', ?, '$.calendars', json(?),
                       '$.destinations', json(?), '$.refreshedAt', ?), updated_at = ? WHERE id = ?`,
          params: [
            fresh.account,
            JSON.stringify(fresh.calendars),
            JSON.stringify(fresh.destinations),
            now,
            now,
            row.id,
          ],
          method: "run",
        });
      }
      if (row.config.busyOn && def.busy && def.capabilities.includes("busy_times")) {
        // The owner's own bookings written since this run began are left out too.
        const own = await this.ownEvents(row.id);
        const intervals = await def.busy({ ...ctx, own }, { start: now - 3_600_000, end: now + BUSY_HORIZON_MS });
        busy = (await writeBusy(this.db, row.id, intervals, now)).rows;
      }
      await this.db.client.query({
        sql: `UPDATE connectors SET status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
                     last_sync_at = ?, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?`,
        params: [now, now, row.id],
        method: "run",
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      await this.markError(row.id, error.message, now);
      return { ...push, busy: null, note: error.message };
    }
    return {
      ...push,
      busy,
      note: `${busy ?? 0} busy, ${push.written} written, ${push.removed} removed, ${push.failed} failed`,
    };
  }

  /** Whether the connection is still there (and not paused): a job chain for one that is not ends. */
  async active(connectorId: string): Promise<boolean> {
    const row = await this.rowOrNull(connectorId);
    return row !== null && row.status !== "disabled";
  }

  /** The successor of a sync, queued before the run itself so a failing platform never ends the chain. */
  async scheduleNext(connectorId: string, now: number): Promise<void> {
    const next = now + CONNECTOR_SYNC_INTERVAL_MS;
    await ensureJob(
      this.db,
      CONNECTOR_SYNC_KIND,
      `csync:${connectorId}:${Math.floor(next / CONNECTOR_SYNC_INTERVAL_MS)}`,
      {
        now,
        runAt: next,
        payload: { connectorId },
      },
    );
  }

  private async pushBookings(
    row: ConnectorRow,
    def: ConnectorDefinition,
    ctx: RunContext,
    now: number,
  ): Promise<{ written: number; removed: number; failed: number; more: boolean }> {
    const writer = def.bookings;
    if (!writer) return { written: 0, removed: 0, failed: 0, more: false };
    const cursor = row.cursor === null ? Number.NaN : Number(row.cursor);
    const ids: string[] = [];
    let newest = Number.isFinite(cursor) ? cursor : 0;
    let more = false;
    if (!Number.isFinite(cursor)) {
      // The first run: every confirmed booking still to come goes into the calendar.
      const { rows } = await this.db.client.query({
        sql: `SELECT id, updated_at FROM items WHERE type = 'booking' AND state = 'confirmed' AND end_at > ?
               ORDER BY start_at LIMIT 500`,
        params: [Math.floor(now / 1000)],
        method: "all",
      });
      for (const r of rows) ids.push(String(r[0]));
      newest = now;
      more = rows.length === 500;
    } else {
      const since = cursor - CURSOR_LOOKBACK_MS;
      const { rows } = await this.db.client.query({
        sql: `SELECT i.id, MAX(i.updated_at, COALESCE(p.updated_at, 0)) AS changed FROM items i
                LEFT JOIN parties p ON p.id = i.party_id
               WHERE i.type = 'booking' AND (i.updated_at >= ? OR p.updated_at >= ?)
               ORDER BY changed LIMIT 200`,
        params: [since, since],
        method: "all",
      });
      for (const r of rows) {
        ids.push(String(r[0]));
        newest = Math.max(newest, Number(r[1]));
      }
      more = rows.length === 200;
    }
    for (const id of await dueRetries(this.db, row.id, now, 50)) if (!ids.includes(id)) ids.push(id);

    let calls = 0;
    let written = 0;
    let removed = 0;
    let failed = 0;
    for (const itemId of ids) {
      if (calls >= WRITES_PER_RUN) {
        more = true;
        break;
      }
      const outcome = await this.reconcileOne(row, writer, ctx, itemId, now);
      if (outcome === "none") continue;
      calls++;
      if (outcome === "written") written++;
      else if (outcome === "removed") removed++;
      else failed++;
    }
    // Forward only: two runs that meet never move the cursor back.
    if (calls < WRITES_PER_RUN && newest > 0) {
      await this.db.client.query({
        sql: "UPDATE connectors SET cursor = ? WHERE id = ? AND (cursor IS NULL OR CAST(cursor AS INTEGER) < ?)",
        params: [String(newest), row.id, newest],
        method: "run",
      });
    }
    if (more) {
      await ensureJob(this.db, CONNECTOR_PUSH_KIND, `cpush:${row.id}:more:${Math.floor(now / 10_000)}`, {
        now,
        runAt: now + 1_000,
        payload: { connectorId: row.id },
      });
    }
    return { written, removed, failed, more };
  }

  private async reconcileOne(
    row: ConnectorRow,
    writer: NonNullable<ConnectorDefinition["bookings"]>,
    ctx: RunContext,
    itemId: string,
    now: number,
  ): Promise<"none" | "written" | "removed" | "failed"> {
    const wanted = await this.outbound(itemId, ctx.inbox.origin);
    const link = await readLink(this.db, row.id, itemId);
    if (wanted === "keep") return "none";
    if (wanted) {
      // A booking that ended before it was ever written is history, not something to add now.
      if (!link && wanted.end < now - 86_400_000) return "none";
      const hash = await bookingHash(wanted, ctx.destination);
      if (link && link.state === "synced" && link.syncedHash === hash && !link.lastError) return "none";
      if (link?.lastError && link.retryAt !== null && link.retryAt > now) return "none";
      const claim = await claimLink(this.db, row.id, itemId, now);
      if (!claim) return "none";
      const claimed = claim.link;
      try {
        let current = stateOf(claimed);
        // A link that was there before, with no id: an earlier run may have written it and stopped
        // before it could say so. A connector that cannot choose its ids looks for it first.
        if (!current && !claim.fresh && writer.find) current = await writer.find(ctx, wanted);
        const out = await writer.put(ctx, wanted, current);
        await settleLink(
          this.db,
          claimed,
          {
            kind: "synced",
            externalId: out.externalId,
            etag: out.etag,
            calendar: out.calendar,
            hash,
            start: wanted.start,
            end: wanted.end,
          },
          now,
        );
        return "written";
      } catch (error) {
        await this.failLink(claimed, error, now);
        return "failed";
      }
    }
    if (!link || link.state === "removed") return "none";
    if (link.lastError && link.retryAt !== null && link.retryAt > now && link.externalId) return "none";
    const claim = await claimLink(this.db, row.id, itemId, now);
    if (!claim) return "none";
    const claimed = claim.link;
    try {
      let current = stateOf(claimed);
      if (!current && !claim.fresh && writer.find) {
        const gone = await this.outboundForFind(itemId, ctx.inbox.origin);
        if (gone) current = await writer.find(ctx, gone);
      }
      if (current) await writer.remove(ctx, current);
      await settleLink(this.db, claimed, { kind: "removed" }, now);
      return "removed";
    } catch (error) {
      await this.failLink(claimed, error, now);
      return "failed";
    }
  }

  private async failLink(link: LinkRow, error: unknown, now: number): Promise<void> {
    if (!(error instanceof ConnectorError)) {
      // Our own bug: the claim is let go so the next run tries, and the error is said where it can be read.
      await settleLink(
        this.db,
        link,
        { kind: "failed", error: `unexpected: ${String((error as Error)?.message ?? error)}`, retryAt: now + 600_000 },
        now,
      );
      return;
    }
    await settleLink(
      this.db,
      link,
      { kind: "failed", error: error.message, retryAt: now + (error.retryAfterMs ?? retryDelayMs(link.attempts)) },
      now,
    );
  }

  /**
   * What a booking should look like on the platform: written while confirmed, left alone once it has
   * happened (completed, a no-show), and absent otherwise (cancelled, declined, expired, still asked
   * for). Never a test booking. The title names the customer unless they were erased.
   */
  private async outbound(itemId: string, origin: string): Promise<OutboundBooking | null | "keep"> {
    const { rows } = await this.db.client.query({
      sql: `SELECT i.state, i.payload, i.sandbox, p.display_name, p.erased_at, s.name, s.duration_min
              FROM items i LEFT JOIN parties p ON p.id = i.party_id
              LEFT JOIN services s ON s.id = json_extract(i.payload, '$.reservationFor.serviceId')
             WHERE i.id = ? AND i.type = 'booking'`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const state = String(r[0]);
    if (Number(r[2] ?? 0) === 1) return null;
    if (state === "completed" || state === "no_show") return "keep";
    if (state !== "confirmed") return null;
    return bookingOf(itemId, r, origin);
  }

  /** The booking's last words, to find it on a platform after it was cancelled here. */
  private async outboundForFind(itemId: string, origin: string): Promise<OutboundBooking | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT i.state, i.payload, i.sandbox, p.display_name, p.erased_at, s.name, s.duration_min
              FROM items i LEFT JOIN parties p ON p.id = i.party_id
              LEFT JOIN services s ON s.id = json_extract(i.payload, '$.reservationFor.serviceId')
             WHERE i.id = ?`,
      params: [itemId],
      method: "all",
    });
    return rows[0] ? bookingOf(itemId, rows[0], origin) : null;
  }

  /* --- rows and contexts ----------------------------------------------------- */

  private usable(kind: string): ConnectorDefinition {
    const def = this.definitions.get(kind);
    if (!def) {
      throw new WriteError("not_found", `This inbox has no integration called ${kind}.`, {
        fields: [{ path: "kind", problem: "invalid", message: "unknown integration" }],
      });
    }
    const ready = def.ready ? def.ready() : true;
    if (ready !== true) {
      throw new WriteError("not_allowed", `${def.title} is not available on this inbox yet: ${ready}`, {
        details: { reason: "not_ready", kind: def.kind },
      });
    }
    if (!this.http) throw new WriteError("not_allowed", "This inbox cannot reach other services.");
    return def;
  }

  private async store(
    def: ConnectorDefinition,
    preset: string | null,
    connected: Connected,
    name: string | undefined,
    now: number,
    box: SecretBox,
    reconnect = false,
  ): Promise<ConnectionView> {
    const config: PublicConfig = {
      preset,
      account: connected.account,
      extra: connected.extra ?? {},
      calendars: connected.calendars,
      destinations: connected.destinations,
      busyCalendars: connected.defaults.busy.filter((id) => connected.calendars.some((c) => c.id === id)),
      destination: connected.defaults.destination,
      services: null,
      busyOn: def.capabilities.includes("busy_times"),
      bookingsOn: def.capabilities.includes("write_bookings"),
      refreshedAt: now,
    };
    const presetLabel = preset ? def.presets?.find((p) => p.id === preset)?.label : undefined;
    const title = name?.trim() || presetLabel || def.title;
    const existing = await this.db.client.query({
      sql: "SELECT id FROM connectors WHERE kind = ? AND external_id = ?",
      params: [def.kind, connected.externalId],
      method: "all",
    });
    const existingId = existing.rows[0] ? String(existing.rows[0][0]) : null;
    if (existingId && !reconnect) {
      throw new WriteError("wrong_state", `${connected.account} is connected already.`, {
        details: { connection_id: existingId },
      });
    }
    const id = existingId ?? ulid(now);
    const sealed = await box.seal("connector-config", id, JSON.stringify(connected.secret));
    if (existingId) {
      // Signing in again with the same account: new credentials, the owner's choices kept.
      await this.db.batch([
        {
          sql: `UPDATE connectors SET config_enc = ?, status = 'configured', last_error = NULL, last_error_at = NULL,
                       config_public = json_set(config_public, '$.account', ?, '$.calendars', json(?), '$.destinations', json(?),
                       '$.extra', json(?), '$.refreshedAt', ?), updated_at = ? WHERE id = ?`,
          params: [
            sealed,
            config.account,
            JSON.stringify(config.calendars),
            JSON.stringify(config.destinations),
            JSON.stringify(config.extra),
            now,
            now,
            id,
          ],
          method: "run",
        },
        jobStatement(CONNECTOR_SYNC_KIND, { connectorId: id }, now, { dedupeKey: `csync:${id}:r${now}` }),
      ]);
      return this.view(await this.row(id));
    }
    try {
      await this.db.batch([
        {
          sql: `INSERT INTO connectors (id, kind, name, external_id, config_enc, config_public, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'configured', ?, ?)`,
          params: [id, def.kind, title, connected.externalId, sealed, JSON.stringify(config), now, now],
          method: "run",
        },
        // The first sync straight away: the owner who just connected is watching the screen.
        jobStatement(CONNECTOR_SYNC_KIND, { connectorId: id }, now, { dedupeKey: `csync:${id}:first` }),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new WriteError("wrong_state", `${connected.account} is connected already.`);
      }
      throw error;
    }
    return this.view(await this.row(id));
  }

  private async connectContext(now: number): Promise<{ http: ConnectorHttp; now: number; inbox: InboxIdentity }> {
    if (!this.http) throw new WriteError("not_allowed", "This inbox cannot reach other services.");
    return { http: this.http, now, inbox: await this.identity() };
  }

  private async identity(): Promise<InboxIdentity> {
    const settings = await readSettings(this.db);
    const facts = await businessFacts(this.db, settings);
    let origin = (this.baseUrl ?? "").replace(/\/+$/, "");
    if (!origin && settings.notifications.appUrl) {
      try {
        origin = new URL(settings.notifications.appUrl).origin;
      } catch {
        origin = "";
      }
    }
    let host = "";
    try {
      host = origin ? new URL(origin).host : "";
    } catch {
      host = "";
    }
    return {
      origin,
      host: host || "inbox.invalid",
      name: facts.name || "Inbox",
      timezone: facts.timezone || "UTC",
      language: facts.languages[0] ?? "en",
    };
  }

  private async runContext(row: ConnectorRow, now: number): Promise<RunContext> {
    if (!this.http) throw new Error("no http");
    const box = this.secrets;
    if (!box || !row.configEnc) throw new Error("no secret");
    const secret = JSON.parse(await box.open("connector-config", row.id, row.configEnc)) as Record<string, string>;
    const db = this.db;
    return {
      http: this.http,
      now,
      inbox: await this.identity(),
      secret,
      extra: row.config.extra ?? {},
      calendars: row.config.calendars ?? [],
      busyCalendars: row.config.busyCalendars ?? [],
      destinations: row.config.destinations ?? [],
      destination: row.config.destination ?? null,
      own: await this.ownEvents(row.id),
      async saveSecret(next) {
        await db.client.query({
          sql: "UPDATE connectors SET config_enc = ? WHERE id = ?",
          params: [await box.seal("connector-config", row.id, JSON.stringify(next)), row.id],
          method: "run",
        });
      },
    };
  }

  private async ownEvents(connectorId: string): Promise<RunContext["own"]> {
    const links = await liveLinks(this.db, connectorId);
    return {
      ids: new Set(links.map((l) => l.externalId).filter((v): v is string => v !== null)),
      spans: links
        .filter((l) => l.syncedStart !== null && l.syncedEnd !== null)
        .map((l) => ({ start: l.syncedStart as number, end: l.syncedEnd as number })),
    };
  }

  private async markError(id: string, message: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: `UPDATE connectors SET status = CASE WHEN status = 'disabled' THEN status ELSE 'error' END,
                   last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?`,
      params: [message.slice(0, 500), now, now, id],
      method: "run",
    });
  }

  private async rows(): Promise<ConnectorRow[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${ROW_COLUMNS} FROM connectors WHERE kind <> 'feed' ORDER BY created_at`,
      method: "all",
    });
    return rows.map(rowOf);
  }

  private async rowOrNull(id: string): Promise<ConnectorRow | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${ROW_COLUMNS} FROM connectors WHERE id = ? AND kind <> 'feed'`,
      params: [id],
      method: "all",
    });
    return rows[0] ? rowOf(rows[0]) : null;
  }

  private async row(id: string): Promise<ConnectorRow> {
    const row = await this.rowOrNull(id);
    if (!row) {
      throw new WriteError("not_found", "No connection with that id.", { details: { connection_id: id } });
    }
    return row;
  }

  private async view(row: ConnectorRow): Promise<ConnectionView> {
    const def = this.definitions.get(row.kind);
    const [busy, links] = await Promise.all([
      this.db.client.query({
        sql: `SELECT COUNT(*) FROM connector_busy b JOIN connectors c ON c.id = b.connector_id AND b.gen = c.busy_gen
               WHERE b.connector_id = ?`,
        params: [row.id],
        method: "all",
      }),
      this.db.client.query({
        sql: `SELECT SUM(CASE WHEN state = 'synced' AND last_error IS NULL THEN 1 ELSE 0 END),
                     SUM(CASE WHEN last_error IS NOT NULL AND state <> 'removed' THEN 1 ELSE 0 END),
                     (SELECT last_error FROM connector_links WHERE connector_id = ? AND last_error IS NOT NULL
                       AND state <> 'removed' ORDER BY last_error_at DESC LIMIT 1)
                FROM connector_links WHERE connector_id = ?`,
        params: [row.id, row.id],
        method: "all",
      }),
    ]);
    const l = links.rows[0] ?? [];
    const presetLabel = row.config.preset ? def?.presets?.find((p) => p.id === row.config.preset)?.label : undefined;
    return {
      id: row.id,
      kind: row.kind,
      preset: row.config.preset ?? null,
      title: presetLabel ?? def?.title ?? row.kind,
      name: row.name,
      account: row.config.account ?? "",
      status: row.status,
      capabilities: def?.capabilities ?? [],
      busy_on: row.config.busyOn !== false,
      bookings_on: row.config.bookingsOn !== false,
      calendars: row.config.calendars ?? [],
      busy_calendars: row.config.busyCalendars ?? [],
      destinations: row.config.destinations ?? [],
      destination: row.config.destination ?? null,
      services: row.config.services ?? null,
      busy_times: Number(busy.rows[0]?.[0] ?? 0),
      busy_read_at: row.busyAt,
      bookings_written: Number(l[0] ?? 0),
      bookings_failing: Number(l[1] ?? 0),
      booking_error: l[2] === null || l[2] === undefined ? null : String(l[2]),
      last_sync_at: row.lastSyncAt,
      last_error: row.lastError,
      last_error_at: row.lastErrorAt,
      created_at: row.createdAt,
    };
  }
}

/**
 * The connections a booking event concerns, as push jobs: those that write bookings out. The webhook
 * fanout calls it for every booking event, so a change reaches the calendar within seconds.
 */
export async function connectorPushStatements(db: Db, eventId: string, now: number): Promise<Statement[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id FROM connectors WHERE kind <> 'feed' AND status <> 'disabled' AND json_extract(config_public, '$.bookingsOn') = 1`,
    method: "all",
  });
  return rows.map((r) =>
    jobStatement(CONNECTOR_PUSH_KIND, { connectorId: String(r[0]) }, now, {
      dedupeKey: `cpush:${String(r[0])}:${eventId}`,
    }),
  );
}

/** Jobs for one connection run one after another in a run: a lane per connection. */
export function connectorLane(payload: unknown): string | undefined {
  const id = (payload as { connectorId?: unknown } | null)?.connectorId;
  return typeof id === "string" ? `connector:${id}` : undefined;
}

const ROW_COLUMNS =
  "id, kind, name, external_id, config_enc, config_public, cursor, status, last_error, last_error_at, last_sync_at, busy_at, created_at";

function rowOf(r: readonly unknown[]): ConnectorRow {
  let config: unknown = r[5];
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      config = {};
    }
  }
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r[0]),
    kind: String(r[1]),
    name: String(r[2]),
    externalId: r[3] === null ? null : String(r[3]),
    configEnc: r[4] === null ? null : String(r[4]),
    config: normaliseConfig(config),
    cursor: r[6] === null || r[6] === undefined ? null : String(r[6]),
    status: String(r[7]),
    lastError: r[8] === null || r[8] === undefined ? null : String(r[8]),
    lastErrorAt: n(r[9]),
    lastSyncAt: n(r[10]),
    busyAt: n(r[11]),
    createdAt: Number(r[12]),
  };
}

function normaliseConfig(raw: unknown): PublicConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<PublicConfig>;
  return {
    preset: typeof c.preset === "string" ? c.preset : null,
    account: typeof c.account === "string" ? c.account : "",
    extra: c.extra && typeof c.extra === "object" ? c.extra : {},
    calendars: Array.isArray(c.calendars) ? c.calendars : [],
    destinations: Array.isArray(c.destinations) ? c.destinations : [],
    busyCalendars: Array.isArray(c.busyCalendars) ? c.busyCalendars.map(String) : [],
    destination: typeof c.destination === "string" ? c.destination : null,
    services: Array.isArray(c.services) ? c.services.map(String) : null,
    busyOn: c.busyOn !== false,
    bookingsOn: c.bookingsOn !== false,
    refreshedAt: typeof c.refreshedAt === "number" ? c.refreshedAt : 0,
  };
}

function bookingOf(itemId: string, r: readonly unknown[], origin: string): OutboundBooking | null {
  let payload: unknown = r[1];
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const p = payload as {
    startTime?: unknown;
    endTime?: unknown;
    reservationFor?: { serviceId?: unknown; name?: unknown };
  };
  const start = Date.parse(String(p.startTime ?? ""));
  const end = Date.parse(String(p.endTime ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const serviceName = String(r[5] ?? p.reservationFor?.name ?? "Booking").trim() || "Booking";
  const erased = r[4] !== null && r[4] !== undefined;
  const display = typeof r[3] === "string" ? r[3].trim() : "";
  const customerName = !erased && display ? display.slice(0, 80) : null;
  const url = origin ? `${origin}/items/${itemId}` : "";
  return {
    itemId,
    start,
    end,
    title: customerName ? `${serviceName} · ${customerName}` : serviceName,
    description: url ? `Booked in your inbox.\n${url}` : "Booked in your inbox.",
    url,
    serviceId: String(p.reservationFor?.serviceId ?? ""),
    serviceName,
    customerName,
    durationMin: Math.round((end - start) / 60_000),
  };
}

async function bookingHash(b: OutboundBooking, destination: string | null): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(JSON.stringify([b.start, b.end, b.title, b.description, destination ?? ""])),
  );
}

function stateOf(link: LinkRow): LinkState | null {
  if (!link.externalId) return null;
  return {
    externalId: link.externalId,
    etag: link.etag,
    calendar: link.calendar,
    ...(link.syncedStart !== null ? { start: link.syncedStart } : {}),
    ...(link.syncedEnd !== null ? { end: link.syncedEnd } : {}),
  };
}

/** The path a platform sends the owner back to after signing in. */
export function callbackPath(kind: string): string {
  return `/oauth/connect/${encodeURIComponent(kind)}/callback`;
}

/** A path in the owner app, or Settings → Integrations: never an address on another site. */
export function safeReturnPath(raw: string | undefined): string {
  const path = (raw ?? "").trim();
  const control = [...path].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || control) {
    return "/settings/integrations";
  }
  return path.slice(0, 200);
}

function asWriteError(error: unknown, title: string): WriteError {
  if (error instanceof WriteError) return error;
  if (error instanceof ConnectorError) {
    const field = error.field ? `values.${error.field}` : undefined;
    return new WriteError("invalid_input", error.message, {
      ...(field ? { fields: [{ path: field, problem: "invalid" as const, message: error.message }] } : {}),
      details: { reason: error.code },
    });
  }
  return new WriteError("internal", `${title} could not be checked: ${String((error as Error)?.message ?? error)}`);
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

function requireOwnerSide(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "this needs the owner");
}

/**
 * Connecting hands over a password or a sign-in, and disconnecting changes what customers can book:
 * the owner does both in Settings. Their AI may read what is connected and sync it, nothing more.
 */
function requireNotAssistant(caller: Caller, verb: string): void {
  if (!isOwnerAssistant(caller)) return;
  throw new WriteError(
    "not_allowed",
    `A connection holds the owner's password or sign-in, so you cannot ${verb} one. Tell the owner in a note; they do it in Settings → Integrations.`,
    { details: { reason: "owner_credentials", draft_for_owner: true } },
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export { secretKeys };
