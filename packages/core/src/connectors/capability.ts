import { type Statement, sha256Hex } from "@surfingdog/platform";
import { z } from "zod";
import { businessFacts } from "../customer/audience";
import { moneyIn } from "../customer/format";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import { ensureJob } from "../jobs/schedule";
import { requireSecretBox, type SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { isTrade } from "../trades/job";
import { jobToolConnections } from "../trades/job-tool";
import { type Caller, isCustomer, isOwnerAssistant, isPerson, nowOf } from "../write/caller";
import { jobStatement } from "../write/common";
import { fromZod, WriteError } from "../write/errors";
import { type TransitionResult, transitionItem } from "../write/transition";
import {
  activeProducts,
  connectorSource,
  deactivateSource,
  deactivateUnseen,
  MAX_CATALOGUE,
  upsertCatalogue,
} from "./catalogue";
import { cardOf, type GalleryCard, type GalleryGroup, gallery, galleryGroups, leanOf, readiness } from "./gallery";
import {
  ConnectorHooks,
  feedBookings,
  type HookAnswer,
  type HookHost,
  inboundHash,
  isInboundToken,
  newInboundToken,
} from "./hooks";
import { PAY_CLOSE_KIND } from "./pay-queue";
import { type PayConnection, type PayHost, PaymentLinks, type PaymentView } from "./payments";
import {
  type CalendarChoice,
  type Connected,
  type ConnectionChoice,
  type ConnectorAuth,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorErrorCode,
  type ConnectorGroup,
  type ConnectorHttp,
  type ConnectorPreset,
  calendarName,
  describeForm,
  type FeedResponse,
  type InboundRequest,
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
  instanceId,
  type LinkClaim,
  type LinkRow,
  liveLinks,
  readLink,
  retryDelayMs,
  settleLink,
  writeBusy,
} from "./store";

/**
 * Connected platforms (ADR-014, ADR-015, ADR-022): the owner connects, chooses, syncs and
 * disconnects here; the jobs call `run` every few minutes and after every booking event.
 *
 * The rules that shape it:
 * - **A connector is a row, never a setting** (ADR-015 §1). Credentials are sealed by the secret
 *   box, bound to the row, and no answer of any door ever carries them. Without `INBOX_SECRET_KEY`
 *   nothing is connected (fail closed).
 * - **Connecting is the owner's, in person**: it hands over a password or a sign-in, and what is
 *   chosen decides which times customers are offered. The owner's AI and a key handed to another
 *   system may list and sync what is connected, never connect, change or disconnect it.
 * - **Busy times only remove times.** They never move, cancel or refuse a booking already made.
 *   Past how far ahead a calendar was read, nothing is offered: not known to be free is not free.
 * - **One job at a time per booking calls the platform** (`claimLink`), so two syncs that meet never
 *   write a booking twice, and a run that stopped half way is finished by the next.
 */

export const CONNECTOR_SYNC_KIND = "connector_sync";
export const CONNECTOR_PUSH_KIND = "connector_push";
/** The one email to the owner that a connection stopped syncing. */
export const CONNECTOR_NOTICE_KIND = "connector_notice";
/** A shop's catalogue read on its own (ADR-026 §3): on a webhook, and to go on with a pass that has more. */
export const CONNECTOR_CATALOGUE_KIND = "connector_catalogue";
/** Busy times are read this often; a booking event writes out at once. */
export const CONNECTOR_SYNC_INTERVAL_MS = 5 * 60_000;
/** A connection that keeps failing is read less often: at most this far apart for a refused sign-in… */
const AUTH_BACKOFF_MAX_MS = 6 * 3_600_000;
/** …and this for a platform that does not answer. */
const OTHER_BACKOFF_MAX_MS = 30 * 60_000;
/** A sign-in refused for this long stops being tried until the owner connects again or syncs now. */
const AUTH_GIVE_UP_MS = 24 * 3_600_000;
/** A platform that does not answer for this long is told to the owner, like a refused sign-in at once. */
const NOTICE_AFTER_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
/** Calendars and event types are read again this often: they change rarely. */
const REFRESH_EVERY_MS = 6 * 3_600_000;
/**
 * Bookings changed this recently are looked at again by the next run: a write stamped a moment
 * before it landed would otherwise slip behind the cursor. The cursor never passes them until then.
 */
const CURSOR_LOOKBACK_MS = 2 * 60_000;
/** Bookings read per page, first all the confirmed ones still to come, then the ones that changed. */
const PUSH_PAGE = 200;
/** Calls to a platform in one run; the rest wait for the next, which is queued at once. */
const WRITES_PER_RUN = 25;
/** A sign-in on the platform's page must come back within this. */
const AUTH_TTL_MS = 10 * 60_000;
/** A full pass of a shop's catalogue this often; what changed since the last read on every sync. */
const CATALOGUE_FULL_EVERY_MS = 6 * 3_600_000;
/** Pages of a catalogue one sync reads; a pass that has more goes on at the next. */
const CATALOGUE_PAGES_PER_RUN = 10;
/** What changed is read from a little before the last read began: a change stamped a moment early is not missed. */
const CATALOGUE_LOOKBACK_MS = 2 * 60_000;

/**
 * Where a connection's catalogue reading is (ADR-026 §3): a full pass under way (its page, when it
 * began, how many it saw), when the last one ended, and from when what changed is read next.
 */
export interface CatalogueState {
  readonly full: { readonly cursor: string | null; readonly startedAt: number; readonly seen: number } | null;
  readonly lastFullAt: number;
  /** What changed since this is read next; null before the first full pass ends. */
  readonly since: number | null;
  /** An incremental pass under way: its page, and when it began. */
  readonly partial: { readonly cursor: string | null; readonly startedAt: number } | null;
  /** The last full pass stopped at `MAX_CATALOGUE`: nothing it did not see was taken off sale. */
  readonly truncated: boolean;
}

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
  /**
   * What the owner typed that is not secret (an email, a server address), so connecting again asks
   * only for the new password or key.
   */
  readonly inputs: Readonly<Record<string, string>>;
  /** A payment platform makes pay links for accepted orders (ADR-023): on when connected. */
  readonly payOn: boolean;
  /** A payment platform's mode: a test key makes links for test orders only, a live key for real ones. */
  readonly mode: "live" | "test" | null;
  /**
   * A payment platform being disconnected (ADR-023): since when, and how many times its links were
   * tried. It makes no new link; its key and webhook stay until the links it made are switched off.
   */
  readonly disconnectingAt: number | null;
  readonly disconnectTries: number;
  /** What else the owner chooses (a till's location), with what is chosen (ADR-026 §5). */
  readonly choices: readonly ConnectionChoice[];
  /** A shop's catalogue reading (ADR-026 §3); null for a connection that sends none. */
  readonly catalogue: CatalogueState | null;
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
  /** The busy times still ahead, as read. */
  readonly busy_times: number;
  readonly busy_read_at: number | null;
  /** How far ahead they were read: past it nothing is offered. */
  readonly busy_until: number | null;
  /** Read less far ahead than usual: the calendar had more ahead than one sync reads. */
  readonly busy_partial: boolean;
  readonly bookings_written: number;
  readonly bookings_failing: number;
  readonly booking_error: string | null;
  readonly last_sync_at: number | null;
  readonly last_error: string | null;
  readonly last_error_at: number | null;
  /** What kind of failure it is (`auth`: connect again; `unreachable`: it is tried again). */
  readonly error_code: string | null;
  readonly failing_since: number | null;
  readonly created_at: number;
  /** A payment platform: pay links for accepted orders on or off (ADR-023). */
  readonly pay_on: boolean;
  /** `live` or `test` for a payment platform; null otherwise. */
  readonly mode: "live" | "test" | null;
  /** A payment platform's links: waiting to be paid, paid, and failing to be made; null otherwise. */
  readonly payments: {
    readonly open: number;
    readonly paid: number;
    readonly failing: number;
    readonly last_paid_at: number | null;
    /**
     * How the platform tells this inbox of payments: a webhook it added itself, one the owner added,
     * one per link (Mollie), or one to add once the inbox is live (`pending`; until then it asks).
     */
    readonly webhook: "added" | "by_hand" | "per_link" | "pending" | null;
    /** The business's own dashboard on the platform: where payments are seen and refunded. */
    readonly dashboard_url: string | null;
    /** Being disconnected: its links are being switched off, and how many are left. */
    readonly disconnecting: boolean;
    readonly closing: number;
    /** A shop's orders made but not sent, since it counts another total (ADR-026 §2). */
    readonly held: number;
  } | null;
  /** The gallery card it belongs to. */
  readonly card: string | null;
  /** What else the owner chooses, drawn as choosers: a till's location, a team member. */
  readonly choices: readonly ConnectionChoice[];
  /** A shop's catalogue: products on sale from it, when it was last read, and whether it was cut at the limit. */
  readonly catalogue: {
    readonly products: number;
    readonly read_at: number | null;
    readonly truncated: boolean;
  } | null;
  /**
   * A link the connection serves (a calendar of bookings to import elsewhere), to the owner in person
   * only: whoever holds it reads what it shows. Null otherwise, and for the owner's AI and keys.
   */
  readonly link: string | null;
  /** What the owner removes by hand once it is disconnected, when the platform does not let the inbox. */
  readonly disconnect_note: string | null;
}

export interface IntegrationsView {
  /** The groups the cards are in, in the order this inbox sees them. */
  readonly groups: readonly GalleryGroup[];
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
  /**
   * Connect this connection again, in place: a new password or key for the same account, with what
   * was typed before and every choice kept. Only the secret fields need to be given.
   */
  connection_id: z.string().min(1).max(64).optional(),
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
  /** A payment platform: make pay links for the orders the inbox accepts (ADR-023). */
  pay_on: z.boolean().optional(),
  /** What the owner chose of the connection's choosers, by key: an option's id, or null for none. */
  choices: z.record(z.string().max(40), z.string().max(200).nullable()).optional(),
});
export type UpdateConnectionInput = z.input<typeof updateConnectionInput>;

export const authorizeInput = z.object({
  kind: z.string().min(1).max(40),
  /** The way, when the card has more than one: `oauth` for a one-click sign-in beside a key. */
  preset: z.string().min(1).max(40).optional(),
  /** What the way asks first (`OAuthFlow.before`): a store's address. */
  input: z.record(z.string(), z.string().max(2048)).optional(),
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
  readonly busyGen: number | null;
  readonly busyUntil: number | null;
  readonly errorCode: string | null;
  readonly failingSince: number | null;
  readonly failures: number;
  readonly notifiedAt: number | null;
  /** The connection's own address segment, sealed (ADR-026 §4): null for one that has none. */
  readonly inboundEnc: string | null;
}

export interface RunReport {
  /** The run read what it set out to (a failing platform, or a run that did not happen, is not). */
  readonly ok: boolean;
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
  /** Pay links in the business's own payment account (ADR-023). */
  readonly payments: PaymentLinks;
  /**
   * Whether platforms can reach this inbox's `/v1/hooks/*` now: a hosted inbox before it goes live
   * answers only its owner (its host says so through the policy).
   */
  private hooksLive = true;
  /** What platforms send a connection at its own address (ADR-026 §4). */
  readonly hooks: ConnectorHooks;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
    private readonly baseUrl: string | undefined,
  ) {
    this.payments = new PaymentLinks(this.payHost());
    this.hooks = new ConnectorHooks(this.hookHost());
  }

  /** What the host says of this inbox's public doors: closed to platforms until it goes live. */
  setHooksLive(live: boolean): void {
    this.hooksLive = live;
  }

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
    const settings = await readSettings(this.db);
    // A trade (ADR-034) sees its job tools first: one that set where it works or how it takes work.
    const trade = isTrade(settings) || (await jobToolConnections(this.db)).length > 0;
    const lean = leanOf({ ...(await this.holdings()), trade });
    return {
      groups: galleryGroups(lean),
      cards: gallery(this.definitions, {
        hookBase: await this.hookBase(),
        prefill: { website: settings.directory.url || undefined },
        lean,
      }),
      connections: await this.list(caller),
      can_connect: this.secrets !== null,
    };
  }

  async list(caller: Caller): Promise<ConnectionView[]> {
    requireOwnerSide(caller);
    const rows = await this.rows();
    const out: ConnectionView[] = [];
    for (const row of rows) out.push(await this.view(row, nowOf(caller), isPerson(caller)));
    return out;
  }

  async get(caller: Caller, id: string): Promise<ConnectionView> {
    requireOwnerSide(caller);
    return this.view(await this.row(id), nowOf(caller), isPerson(caller));
  }

  /** What the inbox holds, for the order its cards are shown in: services to book, products to sell. */
  private async holdings(): Promise<{ services: number; products: number }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT (SELECT COUNT(*) FROM services WHERE active = 1), (SELECT COUNT(*) FROM products WHERE active = 1)`,
      method: "all",
    });
    return { services: Number(rows[0]?.[0] ?? 0), products: Number(rows[0]?.[1] ?? 0) };
  }

  /**
   * An order's pay links (ADR-023): where the customer pays, what the platform said, and where the
   * payment is refunded. The owner's side only; never a secret, and nothing about the customer.
   */
  async itemPayments(
    caller: Caller,
    itemId: string,
  ): Promise<{
    readonly item_id: string;
    readonly payments: readonly PaymentView[];
    /** Why an order that could have a link has none, in a line for the owner; null otherwise. */
    readonly none: string | null;
    /** The order's payment link is one of these (shown as the platform's, never as a link of its own). */
    readonly link_is_ours: boolean;
  }> {
    requireOwnerSide(caller);
    const { rows } = await this.db.client.query({
      sql: "SELECT type FROM items WHERE id = ?",
      params: [itemId],
      method: "all",
    });
    if (!rows[0]) throw new WriteError("not_found", "no such item", { details: { item_id: itemId } });
    const payments = await this.payments.forItem(itemId);
    const none = payments.length === 0 ? await this.payments.whyNone(itemId, nowOf(caller)) : null;
    const ours = payments.length > 0 && (await this.payments.ownsOrderLink(itemId));
    return { item_id: itemId, payments, none, link_is_ours: ours };
  }

  /* --- connecting with a form ---------------------------------------------- */

  async connect(caller: Caller, raw: ConnectInput): Promise<ConnectionView> {
    requireOwnerSide(caller);
    requirePerson(caller, "connect");
    const box = requireSecretBox(this.secrets);
    const input = parse(connectInput, raw);
    const def = this.usable(input.kind);
    // Connecting again in place: the same account, with what was typed the first time.
    const again = input.connection_id ? await this.row(input.connection_id) : null;
    if (again && again.kind !== def.kind) {
      throw new WriteError("invalid_input", `That connection is not a ${def.title} one.`, {
        fields: [{ path: "connection_id", problem: "invalid", message: "another kind of connection" }],
      });
    }
    const presetId = input.preset ?? again?.config.preset ?? undefined;
    const preset = presetId ? def.presets?.find((p) => p.id === presetId) : undefined;
    if (presetId && !preset) {
      throw new WriteError("invalid_input", `${def.title} has no way called ${presetId}`, {
        fields: [{ path: "preset", problem: "invalid", message: "unknown preset" }],
      });
    }
    this.ready(def, preset);
    const auth: ConnectorAuth = preset?.auth ?? def.auth;
    // A link the inbox makes: nothing to fill in, nothing to check on another platform.
    if (auth === "link") {
      const made = await this.makeLink(def, presetId ?? null, input.name, nowOf(caller), box);
      // The owner in person sees the link they just made.
      return this.view(await this.row(made.id), nowOf(caller), true);
    }
    if (auth !== "form" || !def.form || !def.connect) {
      throw new WriteError(
        "invalid_input",
        `${def.title} is connected by signing in on ${def.title}: use authorize, not a form.`,
        {
          details: { reason: "sign_in", kind: def.kind },
        },
      );
    }
    const secret = new Set(secretKeys(def.form));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(again?.config.inputs ?? {})) if (!secret.has(k)) values[k] = v;
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
    // A payment platform takes one key per mode: a second live key is refused before the platform is
    // asked anything, so what the first one made there (its webhook) is never touched.
    if (def.modeOf && !again) {
      const mode = def.modeOf(checked.data as Record<string, string>);
      const same = mode ? (await this.rows()).find((r) => r.kind === def.kind && r.config.mode === mode) : undefined;
      if (same) {
        throw new WriteError(
          "wrong_state",
          same.config.disconnectingAt !== null
            ? `${def.title} is being disconnected: connect it again once that is done, in a minute or two.`
            : `${def.title} is connected already. Use Change → New key to replace its key.`,
          { details: { connection_id: same.id, mode } },
        );
      }
    }
    if (again?.config.disconnectingAt !== null && again?.config.disconnectingAt !== undefined) {
      throw new WriteError("wrong_state", `${def.title} is being disconnected.`, {
        details: { connection_id: again.id },
      });
    }
    let connected: Connected;
    // A connector told by webhook at its own address has one from its first connect, kept after.
    const inbound = await this.inboundFor(def, again);
    try {
      const ctx = await this.connectContext(now, def.kind, inbound?.token);
      connected = await def.connect(
        again ? { ...ctx, previous: { externalId: again.externalId, extra: again.config.extra } } : ctx,
        checked.data as Record<string, string>,
      );
    } catch (error) {
      throw asWriteError(error, def.title);
    }
    if (again && again.externalId !== connected.externalId) {
      await settle(connected, false);
      const first = [...secret][0];
      throw new WriteError(
        "invalid_input",
        `That is another account than ${again.config.account || again.name}. Connect it from its tile instead.`,
        {
          ...(first
            ? { fields: [{ path: `values.${first}`, problem: "invalid" as const, message: "another account" }] }
            : {}),
        },
      );
    }
    // Kept for connecting again: what the owner typed that is not a secret, nor fixed by the preset.
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (!secret.has(k) && !(k in (preset?.values ?? {}))) inputs[k] = v;
    let view: ConnectionView;
    try {
      view = await this.store(def, presetId ?? null, connected, input.name, now, box, again !== null, inputs, inbound);
    } catch (error) {
      // Not kept after all: what the connector made for it on the platform goes again.
      await settle(connected, false);
      throw error;
    }
    await settle(connected, true);
    return view;
  }

  /* --- connecting by signing in on the platform (OAuth with PKCE) ---------- */

  async authorize(caller: Caller, raw: AuthorizeInput, origin: string): Promise<{ authorize_url: string }> {
    requireOwnerSide(caller);
    requirePerson(caller, "connect");
    const box = requireSecretBox(this.secrets);
    const input = parse(authorizeInput, raw);
    const def = this.usable(input.kind);
    const preset = input.preset ? def.presets?.find((p) => p.id === input.preset) : undefined;
    if (input.preset && !preset) {
      throw new WriteError("invalid_input", `${def.title} has no way called ${input.preset}`, {
        fields: [{ path: "preset", problem: "invalid", message: "unknown preset" }],
      });
    }
    this.ready(def, preset);
    if ((preset?.auth ?? def.auth) !== "oauth" || !def.oauth) {
      throw new WriteError("invalid_input", `${def.title} is connected with a form, not a sign-in.`, {
        details: { reason: "form", kind: def.kind },
      });
    }
    // What the way asks first (a store's address): checked here, kept for the way back.
    let before: Record<string, string> = {};
    if (def.oauth.before) {
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.input ?? {})) if (v.trim()) values[k] = v.trim();
      const checked = def.oauth.before.safeParse(values);
      if (!checked.success) throw fromZod(checked.error, "input");
      before = checked.data as Record<string, string>;
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
        sql: `INSERT INTO connector_auth (state_hash, kind, verifier_enc, redirect_uri, return_to, created_at, expires_at, input)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          stateHash,
          def.kind,
          await box.seal("connector-config", `auth:${stateHash}`, verifier),
          redirectUri,
          safeReturnPath(input.return_to),
          now,
          now + AUTH_TTL_MS,
          JSON.stringify({ preset: preset?.id ?? null, values: before }),
        ],
        method: "run",
      },
    ]);
    const posted = def.oauth.delivery === "post";
    return {
      authorize_url: def.oauth.authorizeUrl({
        redirectUri,
        state,
        challenge,
        input: before,
        ...(posted ? { postUrl: `${cleanOrigin}/v1/hooks/${encodeURIComponent(def.kind)}/authorized` } : {}),
      }),
    };
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
      sql: "SELECT kind, verifier_enc, redirect_uri, return_to, expires_at, used_at, input, connector_id, message FROM connector_auth WHERE state_hash = ?",
      params: [stateHash],
      method: "all",
    });
    const row = rows[0];
    if (!row || String(row[0]) !== p.kind) {
      return { returnTo: fallback, ok: false, message: "That sign-in was not started here. Try again from Settings." };
    }
    const returnTo = String(row[3] || fallback);
    const started = authInputOf(row[6]);
    // A platform that POSTs the key itself (WooCommerce) did so before the owner came back: what it made,
    // or what went wrong, is waiting on the sign-in.
    const postDef = this.definitions.get(p.kind);
    if (postDef?.oauth?.delivery === "post") {
      await this.db.client.query({
        sql: "UPDATE connector_auth SET used_at = COALESCE(used_at, ?) WHERE state_hash = ?",
        params: [p.now, stateHash],
        method: "run",
      });
      if (row[7] !== null && row[7] !== undefined) {
        return { returnTo, ok: true, message: `${postDef.title} is connected.`, id: String(row[7]) };
      }
      if (row[8] !== null && row[8] !== undefined) return { returnTo, ok: false, message: String(row[8]) };
      return {
        returnTo,
        ok: false,
        message: `Nothing was connected: ${postDef.title} did not send this inbox a key. Try again from Settings.`,
      };
    }
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
      // Which account it is is known only once the platform answers: a sign-in gives the connection a
      // new address, which the connector names in what it makes there.
      const inbound = await this.inboundFor(def, null);
      const ctx = await this.connectContext(p.now, def.kind, inbound?.token);
      const connected = await def.oauth.exchange(ctx, {
        code: p.code,
        verifier,
        redirectUri: String(row[2]),
        input: started.values,
      });
      const view = await this.store(
        def,
        started.preset,
        connected,
        undefined,
        p.now,
        this.secrets,
        true,
        Object.keys(started.values).length > 0 ? started.values : undefined,
        inbound,
      );
      return { returnTo, ok: true, message: `${def.title} is connected.`, id: view.id };
    } catch (error) {
      const message =
        error instanceof ConnectorError || error instanceof WriteError
          ? error.message
          : `${def.title} did not finish the sign-in.`;
      return { returnTo, ok: false, message };
    }
  }

  /**
   * A platform that POSTs the key itself, server to server (WooCommerce's authorize endpoint, ADR-026
   * §5): `POST /v1/hooks/<kind>/authorized`. The state it carries is the proof, as on a way back: minted
   * for this inbox, used once, gone in ten minutes. The key is checked against the platform before it is
   * kept, and the connection it makes waits on the sign-in for the owner's browser to find.
   */
  async receiveAuthorized(kind: string, request: InboundRequest, now: number): Promise<HookAnswer> {
    const def = this.definitions.get(kind);
    const flow = def?.oauth;
    if (!def || flow?.delivery !== "post" || !flow.receivePosted || !flow.postedState) {
      return { status: 404, body: { error: "not_found" } };
    }
    if (request.body.length > 64 * 1024) return { status: 413, body: { error: "too_large" } };
    if (!this.secrets || !this.http) return { status: 503, body: { error: "unavailable" } };
    const state = flow.postedState(request);
    if (!state) return { status: 400, body: { error: "invalid_input", detail: "No sign-in is named." } };
    const stateHash = await sha256Hex(new TextEncoder().encode(state));
    const claimed = await this.db.client.query({
      sql: `UPDATE connector_auth SET used_at = ? WHERE state_hash = ? AND kind = ? AND used_at IS NULL AND expires_at >= ?
            RETURNING input`,
      params: [now, stateHash, kind, now],
      method: "all",
    });
    if (claimed.rows.length !== 1) {
      return { status: 400, body: { error: "invalid_input", detail: "That sign-in had expired or was used already." } };
    }
    const started = authInputOf(claimed.rows[0]?.[0]);
    const fail = async (message: string): Promise<HookAnswer> => {
      await this.db.client.query({
        sql: "UPDATE connector_auth SET message = ? WHERE state_hash = ?",
        params: [message.slice(0, 500), stateHash],
        method: "run",
      });
      return { status: 400, body: { error: "refused", detail: message } };
    };
    try {
      const inbound = await this.inboundFor(def, null);
      const ctx = await this.connectContext(now, kind, inbound?.token);
      const connected = await flow.receivePosted(ctx, request, started.values);
      let view: ConnectionView;
      try {
        view = await this.store(
          def,
          started.preset,
          connected,
          undefined,
          now,
          this.secrets,
          true,
          started.values,
          inbound,
        );
      } catch (error) {
        await settle(connected, false);
        throw error;
      }
      await settle(connected, true);
      await this.db.client.query({
        sql: "UPDATE connector_auth SET connector_id = ?, message = NULL WHERE state_hash = ?",
        params: [view.id, stateHash],
        method: "run",
      });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof ConnectorError || error instanceof WriteError) return fail(error.message);
      await fail(`${def.title} did not finish connecting.`);
      throw error;
    }
  }

  /** What a platform sent a connection at its own address (ADR-026 §4): checked, kept, read back later. */
  receiveHook(kind: string, token: string, request: InboundRequest, now: number): Promise<HookAnswer> {
    return this.hooks.receive(kind, token, request, now);
  }

  /**
   * A link a connection serves (ADR-026 §5): `GET /v1/feeds/<kind>/<token><extension>`. Whoever holds
   * the link reads it, so the token is all it takes, and it shows only what the connector says a link
   * may (dates and service names for a calendar). Null when the address names nothing here.
   */
  async serveFeed(
    kind: string,
    token: string,
    extension: string,
    headers: Headers,
    now: number,
  ): Promise<FeedResponse | null> {
    if (!isInboundToken(token)) return null;
    const def = this.definitions.get(kind);
    if (!def?.feed || (extension !== "" && extension !== def.feed.extension)) return null;
    const { rows } = await this.db.client.query({
      sql: `SELECT ${ROW_COLUMNS} FROM connectors WHERE kind = ? AND inbound_token = ?`,
      params: [kind, await inboundHash(token)],
      method: "all",
    });
    const row = rows[0] ? rowOf(rows[0]) : null;
    if (!row || row.status === "disabled") return null;
    const db = this.db;
    const inbox = await this.identity();
    const answer = await def.feed.serve(
      { now, inbox, extra: row.config.extra ?? {}, bookings: (window) => feedBookings(db, window) },
      { headers, extension: def.feed.extension },
    );
    await this.db.client.query({
      sql: `UPDATE connectors SET status = CASE WHEN status = 'configured' THEN 'active' ELSE status END, last_sync_at = ?
             WHERE id = ?`,
      params: [now, row.id],
      method: "run",
    });
    return answer;
  }

  /**
   * A new link for a connection that serves one: the old one stops at once, for whoever had it. The
   * owner's, in person: the link is the secret.
   */
  async rotateLink(caller: Caller, id: string): Promise<ConnectionView> {
    requireOwnerSide(caller);
    requirePerson(caller, "change");
    const box = requireSecretBox(this.secrets);
    const row = await this.row(id);
    if (!this.definitions.get(row.kind)?.feed) {
      throw new WriteError("invalid_input", "This connection serves no link.", { details: { connection_id: id } });
    }
    const token = newInboundToken();
    await this.db.client.query({
      sql: "UPDATE connectors SET inbound_token = ?, inbound_enc = ?, updated_at = ? WHERE id = ?",
      params: [await inboundHash(token), await box.seal("connector-inbound", row.id, token), nowOf(caller), row.id],
      method: "run",
    });
    return this.view(await this.row(id), nowOf(caller), isPerson(caller));
  }

  /**
   * "Propose the shop's total" (ADR-026 §2): an order whose link is held, since the shop counts its
   * tax or delivery on top, is offered to the customer at the shop's total, as a change they accept or
   * not (ADR-018 §3.2). Money is the owner's: in person only.
   */
  async proposeShopTotal(caller: Caller, itemId: string): Promise<TransitionResult> {
    requireOwnerSide(caller);
    requirePerson(caller, "propose a price for");
    const change = await this.payments.shopTotalChange(itemId);
    if (!change) {
      throw new WriteError("wrong_state", "This order has no link held for a higher shop total.", {
        details: { item_id: itemId },
      });
    }
    const total = moneyIn(change.shopTotal, change.lang);
    const note =
      change.lang === "pt"
        ? `Com impostos e encargos, a sua encomenda fica em ${total}.`
        : `With tax and charges, your order comes to ${total}.`;
    return transitionItem(this.db, caller, {
      itemId,
      event: "propose_change",
      input: { orderedItem: change.orderedItem, note },
    });
  }

  /* --- choosing, pausing, syncing, disconnecting --------------------------- */

  async update(caller: Caller, id: string, raw: UpdateConnectionInput): Promise<ConnectionView> {
    requireOwnerSide(caller);
    requirePerson(caller, "change");
    const input = parse(updateConnectionInput, raw);
    const row = await this.row(id);
    const now = nowOf(caller);
    if (row.config.disconnectingAt !== null) {
      throw new WriteError("wrong_state", "This connection is being disconnected.", {
        details: { connection_id: row.id },
      });
    }
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
    if (input.choices !== undefined) {
      const next: { key: string; label: string; options: ConnectionChoice["options"]; value: string | null }[] =
        row.config.choices.map((c) => ({ ...c }));
      for (const [key, value] of Object.entries(input.choices)) {
        const choice = next.find((c) => c.key === key);
        if (!choice) {
          throw new WriteError("invalid_input", "That is not something this connection lets you choose.", {
            fields: [{ path: `choices.${key}`, problem: "invalid", message: "unknown choice" }],
          });
        }
        if (value !== null && !choice.options.some((o) => o.id === value)) {
          throw new WriteError("invalid_input", `That is not one of the ${choice.label.toLowerCase()} options.`, {
            fields: [{ path: `choices.${key}`, problem: "invalid", message: "not an option" }],
          });
        }
        choice.value = value;
      }
      json.push(["$.choices", next]);
    }
    if (input.busy_on !== undefined) json.push(["$.busyOn", input.busy_on]);
    if (input.pay_on !== undefined) {
      if (!this.definitions.get(row.kind)?.capabilities.includes("pay_links")) {
        throw new WriteError("invalid_input", "This connection takes no payments.", {
          fields: [{ path: "pay_on", problem: "invalid", message: "not a payment platform" }],
        });
      }
      json.push(["$.payOn", input.pay_on]);
    }
    // One platform sends an order's links per mode: switching this one on switches the others of its
    // mode off (their links already sent keep working).
    const others =
      input.pay_on === true && row.config.mode
        ? (await this.rows()).filter(
            (r) => r.id !== row.id && r.config.mode === row.config.mode && r.config.payOn && this.paysFor(r.kind),
          )
        : [];
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
    for (const other of others) {
      statements.push({
        sql: "UPDATE connectors SET config_public = json_set(config_public, '$.payOn', json('false')), updated_at = ? WHERE id = ?",
        params: [now, other.id],
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
    return this.view(await this.row(id), now);
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
   *
   * A payment platform goes in two steps (ADR-023): it stops making links at once, and its links
   * still waiting to be paid are switched off on the platform, a few here and the rest by a job,
   * tried again when the platform does not answer. Its key and webhook stay until then, so a payment
   * made on one of them meanwhile is still recorded; then they go, and the owner is told which orders
   * were left waiting on a link that no longer works, and any link that could not be switched off.
   */
  async remove(
    caller: Caller,
    id: string,
  ): Promise<{ removed: true; left_in_calendar: number; links_closed?: number; links_closing?: number }> {
    requireOwnerSide(caller);
    requirePerson(caller, "disconnect");
    const row = await this.row(id);
    const now = nowOf(caller);
    const left = (await liveLinks(this.db, row.id)).length;
    if (this.paysFor(row.kind)) {
      if (row.config.disconnectingAt === null) {
        await this.db.client.query({
          sql: `UPDATE connectors SET config_public = json_set(config_public, '$.disconnectingAt', ?, '$.disconnectTries', 0),
                       updated_at = ? WHERE id = ?`,
          params: [now, now, row.id],
          method: "run",
        });
      }
      const step = await this.payments.closeForDisconnect(row.id, now, DISCONNECT_NOW);
      if (step.left === 0) {
        await this.finishDisconnect(row.id, now);
        return { removed: true, left_in_calendar: left, links_closed: step.closed };
      }
      await ensureJob(this.db, PAY_CLOSE_KIND, `payclose:${row.id}:0`, { now, payload: { connectorId: row.id } });
      return { removed: true, left_in_calendar: left, links_closed: step.closed, links_closing: step.left };
    }
    const def = this.definitions.get(row.kind);
    if (def?.disconnect) {
      try {
        await def.disconnect(await this.runContext(row, now));
      } catch {
        // Giving the access back is a courtesy to the platform: the connection goes either way.
      }
    }
    // Its products stay for the orders that name them, off sale.
    if (row.externalId) await deactivateSource(this.db, connectorSource(row.kind, row.externalId), now);
    await this.db.batch(deleteStatements(row.id));
    return { removed: true, left_in_calendar: left };
  }

  /**
   * One step of a payment platform's disconnect, from its job: more links switched off, those the
   * platform did not take tried again, and the connection gone once none is left (or after a few
   * tries, with the owner told which links could not be switched off).
   */
  async continueDisconnect(connectorId: string, now: number): Promise<string> {
    const row = await this.rowOrNull(connectorId);
    if (!row) return "gone";
    if (row.config.disconnectingAt === null) return "not being disconnected";
    const tries = row.config.disconnectTries + 1;
    await this.db.client.query({
      sql: "UPDATE connectors SET config_public = json_set(config_public, '$.disconnectTries', ?), updated_at = ? WHERE id = ?",
      params: [tries, now, row.id],
      method: "run",
    });
    const step = await this.payments.closeForDisconnect(row.id, now, DISCONNECT_STEP);
    if (step.left === 0 || tries >= DISCONNECT_BACKOFF_MS.length) {
      await this.finishDisconnect(row.id, now);
      return `${step.closed} closed; disconnected${step.left > 0 ? `, ${step.left} could not be switched off` : ""}`;
    }
    const runAt = now + (DISCONNECT_BACKOFF_MS[tries - 1] ?? 60 * 60_000);
    await ensureJob(this.db, PAY_CLOSE_KIND, `payclose:${row.id}:${tries}`, {
      now,
      runAt,
      payload: { connectorId: row.id },
    });
    return `${step.closed} closed, ${step.left} left; tried again at ${new Date(runAt).toISOString()}`;
  }

  /** The connection goes: its webhook taken back, its rows deleted, and the owner told what is left to do. */
  private async finishDisconnect(connectorId: string, now: number): Promise<void> {
    const row = await this.rowOrNull(connectorId);
    if (!row) return;
    const def = this.definitions.get(row.kind);
    const notice = def?.payments
      ? await this.payments.disconnectNotice(
          row.id,
          row.kind,
          def.payments.dashboardUrl({ extra: row.config.extra ?? {} }, row.config.mode ?? "live"),
        )
      : null;
    if (def?.disconnect) {
      try {
        await def.disconnect(await this.runContext(row, now));
      } catch {
        // Giving the access back is a courtesy to the platform: the connection goes either way.
      }
    }
    await this.payments.forget(row.id, now);
    if (notice) await this.payments.noticeDisconnected(row.id, notice, now);
    if (row.externalId) await deactivateSource(this.db, connectorSource(row.kind, row.externalId), now);
    await this.db.batch(deleteStatements(row.id));
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
    const idle = (note: string, ok = false): RunReport => ({
      ok,
      written: 0,
      removed: 0,
      failed: 0,
      busy: null,
      more: false,
      note,
    });
    if (row.status === "disabled") return idle("paused");
    const def = this.definitions.get(row.kind);
    if (!def || !this.http || !this.secrets) return idle("not available on this instance");
    let ctx: RunContext;
    try {
      ctx = await this.runContext(row, now);
    } catch {
      await this.markError(
        row,
        { code: "config", message: "The saved credentials cannot be opened here. Connect it again." },
        now,
      );
      return idle("credentials do not open");
    }

    let push = { written: 0, removed: 0, failed: 0, more: false };
    if (row.config.bookingsOn && def.bookings && def.capabilities.includes("write_bookings")) {
      push = await this.pushBookings(row, def, ctx, now);
    }
    if (mode === "push") {
      return {
        ok: true,
        ...push,
        busy: null,
        note: `${push.written} written, ${push.removed} removed, ${push.failed} failed`,
      };
    }

    let busy: number | null = null;
    let truncated = false;
    let payNote = "";
    let catalogueNote = "";
    try {
      // A payment platform with a link waiting to be paid looks at its webhook on every sync: one that was
      // removed or switched off is found within minutes, not hours.
      const openLinks = def.payments ? await this.payments.hasOpen(row.id) : false;
      if (
        def.refresh &&
        (now - (row.config.refreshedAt ?? 0) > REFRESH_EVERY_MS || def.stale?.(ctx, { openLinks }) === true)
      ) {
        const fresh = await def.refresh(ctx);
        // New options keep what the owner chose, where it is still one of them.
        const choices = fresh.choices ? mergeChoices(row.config.choices, fresh.choices) : null;
        await this.db.client.query({
          sql: `UPDATE connectors SET config_public = json_set(config_public, '$.account', ?, '$.calendars', json(?),
                       '$.destinations', json(?), '$.refreshedAt', ?${fresh.extra ? ", '$.extra', json(?)" : ""}${choices ? ", '$.choices', json(?)" : ""}), updated_at = ? WHERE id = ?`,
          params: [
            fresh.account,
            JSON.stringify(fresh.calendars),
            JSON.stringify(fresh.destinations),
            now,
            ...(fresh.extra ? [JSON.stringify(fresh.extra)] : []),
            ...(choices ? [JSON.stringify(choices)] : []),
            now,
            row.id,
          ],
          method: "run",
        });
      }
      if (row.config.busyOn && def.busy && def.capabilities.includes("busy_times")) {
        // Every booking any connection wrote is left out, the ones written since this run began too.
        const own = await this.ownEvents();
        const window = { start: now - 3_600_000, end: now + BUSY_HORIZON_MS };
        const read = await def.busy({ ...ctx, own }, window);
        const intervals = Array.isArray(read) ? read : read.intervals;
        const until = Array.isArray(read) ? window.end : Math.max(window.start, Math.min(window.end, read.until));
        const written = await writeBusy(this.db, row.id, intervals, now, until);
        busy = written.rows;
        truncated = written.truncated || written.until < window.end;
      } else if (!row.config.busyOn && row.busyGen !== null) {
        // Switched off while a sync was reading: whatever it left is taken away again.
        await this.db.batch(clearBusyStatements(row.id));
      }
      // A shop's products (ADR-026 §3): a full pass now and then, what changed on every sync.
      if (def.catalogue && def.capabilities.includes("catalogue") && row.externalId) {
        const read = await this.readCatalogue(row, def, ctx, now);
        catalogueNote = `, ${read.read} product${read.read === 1 ? "" : "s"} read${read.more ? " (more next time)" : ""}`;
      }
      // A payment platform (ADR-023): what a webhook may have missed is asked of the platform.
      if (def.payments && def.capabilities.includes("pay_links")) {
        const r = await this.payments.reconcile(this.payConnectionOf(row, def, ctx), now);
        payNote = `, ${r.checked} link${r.checked === 1 ? "" : "s"} checked, ${r.paid} paid${r.refunded ? `, ${r.refunded} refunded` : ""}`;
      }
      await this.db.client.query({
        sql: `UPDATE connectors SET status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
                     last_sync_at = ?, last_error = NULL, last_error_at = NULL, error_code = NULL, failing_since = NULL,
                     failures = 0, notified_at = NULL, updated_at = ? WHERE id = ?`,
        params: [now, now, row.id],
        method: "run",
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      await this.markError(row, error, now);
      return { ok: false, ...push, busy: null, note: error.message };
    }
    return {
      ok: true,
      ...push,
      busy,
      note: `${busy ?? 0} busy${truncated ? " (read only part of the way ahead)" : ""}, ${push.written} written, ${push.removed} removed, ${push.failed} failed${catalogueNote}${payNote}`,
    };
  }

  /**
   * A connection's definition and what it runs with, for a caller outside this class that drives one
   * (a property system's stays, ADR-033; a job tool's requests, ADR-034); null when it is gone, paused,
   * or cannot run here.
   */
  async contextFor(
    connectorId: string,
    now: number,
  ): Promise<{ readonly definition: ConnectorDefinition; readonly ctx: RunContext; readonly status: string } | null> {
    const row = await this.rowOrNull(connectorId);
    if (!row || row.status === "disabled") return null;
    const definition = this.definitions.get(row.kind);
    if (!definition || !this.http || !this.secrets) return null;
    try {
      return { definition, ctx: await this.runContext(row, now), status: row.status };
    } catch {
      return null;
    }
  }

  /** Whether the connection is still there (and not paused): a job chain for one that is not ends. */
  async active(connectorId: string): Promise<boolean> {
    const row = await this.rowOrNull(connectorId);
    return row !== null && row.status !== "disabled";
  }

  /**
   * How long until the next sync: five minutes, longer for a connection that keeps failing (twice as
   * long each time, at most six hours for a refused sign-in and half an hour otherwise), and null for
   * a sign-in refused for a day, which is tried again only when the owner connects again or syncs now.
   * Nextcloud and Apple count failed sign-ins, and every hosted inbox calls from the same address.
   */
  async nextSyncDelay(connectorId: string, now: number): Promise<number | null> {
    const row = await this.rowOrNull(connectorId);
    if (row?.status !== "error") return CONNECTOR_SYNC_INTERVAL_MS;
    const doubled = CONNECTOR_SYNC_INTERVAL_MS * 2 ** Math.min(Math.max(row.failures - 1, 0), 10);
    if (row.errorCode === "auth" || row.errorCode === "config") {
      if (row.failingSince !== null && now - row.failingSince > AUTH_GIVE_UP_MS) return null;
      return Math.min(doubled, AUTH_BACKOFF_MAX_MS);
    }
    return Math.min(doubled, OTHER_BACKOFF_MAX_MS);
  }

  /** The successor of a sync, queued before the run itself so a failing platform never ends the chain. */
  async scheduleNext(connectorId: string, now: number, delayMs: number = CONNECTOR_SYNC_INTERVAL_MS): Promise<void> {
    const next = now + delayMs;
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

  /**
   * A shop's catalogue read now, on its own (a webhook said products changed, or a pass has more to
   * read): what changed since the last read, or the next pages of a full pass. Records a failure on the
   * connection like a sync does.
   */
  async catalogueNow(connectorId: string, now: number): Promise<string> {
    const row = await this.rowOrNull(connectorId);
    if (!row) return "gone";
    if (row.status === "disabled") return "paused";
    const def = this.definitions.get(row.kind);
    if (!def?.catalogue || !def.capabilities.includes("catalogue") || !row.externalId || !this.http || !this.secrets) {
      return "no catalogue here";
    }
    let ctx: RunContext;
    try {
      ctx = await this.runContext(row, now);
    } catch {
      return "credentials do not open";
    }
    try {
      const read = await this.readCatalogue(row, def, ctx, now);
      return `${read.read} read${read.more ? ", more to come" : ""}`;
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      await this.markError(row, error, now);
      return error.message;
    }
  }

  /**
   * One reading of a shop's catalogue (ADR-026 §3), within a budget of pages: a full pass every six
   * hours (or first), what changed since the last read otherwise. Each page is written as it comes, by
   * the one upsert feeds share; a full pass that ends takes off sale what it did not see, unless it
   * stopped at `MAX_CATALOGUE`, when the owner is told once. Where it got to is kept on the connection,
   * so the next run goes on from there.
   */
  private async readCatalogue(
    row: ConnectorRow,
    def: ConnectorDefinition,
    ctx: RunContext,
    now: number,
  ): Promise<{ read: number; more: boolean }> {
    const reader = def.catalogue;
    if (!reader || !row.externalId) return { read: 0, more: false };
    const source = connectorSource(row.kind, row.externalId);
    const before = row.config.catalogue ?? EMPTY_CATALOGUE;
    const currency = (await readSettings(this.db)).business.currency;
    let full =
      before.full ??
      (before.since === null || now - before.lastFullAt >= CATALOGUE_FULL_EVERY_MS
        ? { cursor: null, startedAt: now, seen: 0 }
        : null);
    let partial = full ? null : (before.partial ?? { cursor: null, startedAt: now });
    let { lastFullAt, since, truncated } = before;
    let read = 0;
    let capped = false;
    for (let pages = 0; pages < CATALOGUE_PAGES_PER_RUN && (full || partial); pages++) {
      const cursor = full ? full.cursor : (partial?.cursor ?? null);
      const page = await reader.page(ctx, {
        cursor,
        since: full ? null : Math.max(0, (since ?? 0) - CATALOGUE_LOOKBACK_MS),
      });
      let products = page.products;
      if (full && full.seen + products.length > MAX_CATALOGUE) {
        products = products.slice(0, Math.max(0, MAX_CATALOGUE - full.seen));
        capped = true;
      }
      await upsertCatalogue(this.db, {
        source,
        products: products.map((p) => ({
          externalId: String(p.externalId).slice(0, 200),
          name: String(p.name ?? "").slice(0, 300) || "Product",
          description: p.description === null ? null : String(p.description).slice(0, 5_000),
          sku: p.sku,
          price: p.price,
          stock: p.stock === null || !Number.isFinite(p.stock) ? null : Math.max(0, Math.trunc(p.stock)),
          available: p.available,
        })),
        now,
        seenAt: now,
        currency,
      });
      read += products.length;
      if (full) {
        full = { cursor: page.cursor, startedAt: full.startedAt, seen: full.seen + products.length };
        if (capped || page.cursor === null) {
          // A pass cut at the limit is not evidence of absence: nothing it did not see goes off sale.
          if (!capped) await deactivateUnseen(this.db, source, full.startedAt, now);
          truncated = capped;
          lastFullAt = now;
          since = full.startedAt;
          full = null;
        }
      } else if (partial) {
        // What changed is read from when this pass began, next time: a change made while it read is not missed.
        if (page.cursor === null) {
          since = partial.startedAt;
          partial = null;
        } else {
          partial = { cursor: page.cursor, startedAt: partial.startedAt };
        }
      }
    }
    const state: CatalogueState = { full, lastFullAt, since, partial, truncated };
    await this.db.client.query({
      sql: "UPDATE connectors SET config_public = json_set(config_public, '$.catalogue', json(?)), updated_at = ? WHERE id = ?",
      params: [JSON.stringify(state), now, row.id],
      method: "run",
    });
    if (capped && !before.truncated) {
      await this.db.batch([
        jobStatement(CONNECTOR_NOTICE_KIND, { connectorId: row.id, reason: "catalogue_cap" }, now, {
          dedupeKey: `cnotice:${row.id}:cap`,
        }),
      ]);
    }
    const more = full !== null || partial !== null;
    if (more) {
      await ensureJob(this.db, CONNECTOR_CATALOGUE_KIND, `ccat:${row.id}:more:${Math.floor(now / 10_000)}`, {
        now,
        runAt: now + 1_000,
        payload: { connectorId: row.id },
      });
    }
    return { read, more };
  }

  /**
   * The bookings to write out, in two passes that share one budget of calls: first every confirmed
   * booking still to come (once, when the connection is new), page by page in (start, id) order; then
   * the bookings that changed, themselves or their customer, in (time, id) order. The cursor keeps
   * both places and moves forward only past what was done: never past a booking another job holds,
   * nor past one changed in the last two minutes (a write stamped a moment before it landed). The
   * answer says whether there is more to do now.
   */
  private async pushBookings(
    row: ConnectorRow,
    def: ConnectorDefinition,
    ctx: RunContext,
    now: number,
  ): Promise<{ written: number; removed: number; failed: number; more: boolean }> {
    const writer = def.bookings;
    if (!writer) return { written: 0, removed: 0, failed: 0, more: false };
    const before = row.cursor;
    const cursor = parseCursor(before, now);
    const counts = { calls: 0, written: 0, removed: 0, failed: 0 };
    let more = false;
    let progressed = false;
    const one = async (itemId: string): Promise<"held" | "done"> => {
      const outcome = await this.reconcileOne(row, writer, ctx, itemId, now);
      if (outcome === "held") return "held";
      if (outcome === "none" || outcome === "lost") return "done";
      counts.calls++;
      if (outcome === "written") counts.written++;
      else if (outcome === "removed") counts.removed++;
      else counts.failed++;
      return "done";
    };

    // 1. A new connection: every confirmed booking still to come goes into the calendar.
    if (cursor.fill) {
      const { rows } = await this.db.client.query({
        sql: `SELECT id, start_at FROM items
               WHERE type = 'booking' AND state = 'confirmed' AND end_at > ?
                 AND (COALESCE(start_at, '') > ? OR (COALESCE(start_at, '') = ? AND id > ?))
               ORDER BY COALESCE(start_at, ''), id LIMIT ?`,
        params: [Math.floor(now / 1000), cursor.fill.s, cursor.fill.s, cursor.fill.i, PUSH_PAGE],
        method: "all",
      });
      let blocked = false;
      let all = true;
      for (const r of rows) {
        if (counts.calls >= WRITES_PER_RUN) {
          all = false;
          break;
        }
        const id = String(r[0]);
        if ((await one(id)) === "held") blocked = true;
        if (!blocked) {
          cursor.fill = { s: String(r[1] ?? ""), i: id };
          progressed = true;
        }
      }
      if (!all || rows.length === PUSH_PAGE || blocked) more = true;
      else cursor.fill = null;
    }

    // 2. What changed since the last look, while the budget lasts.
    if (counts.calls < WRITES_PER_RUN) {
      const since = cursor.c;
      const { rows } = await this.db.client.query({
        sql: `SELECT id, MAX(changed) AS changed FROM (
                SELECT id, updated_at AS changed FROM items WHERE type = 'booking' AND updated_at >= ?
                UNION ALL
                SELECT i.id, p.updated_at AS changed FROM parties p JOIN items i ON i.party_id = p.id AND i.type = 'booking'
                 WHERE p.updated_at >= ?
              ) GROUP BY id
              HAVING MAX(changed) > ? OR (MAX(changed) = ? AND id > ?)
              ORDER BY MAX(changed), id LIMIT ?`,
        params: [since, since, since, since, cursor.i, PUSH_PAGE],
        method: "all",
      });
      const settled = now - CURSOR_LOOKBACK_MS;
      let blocked = false;
      let all = true;
      for (const r of rows) {
        if (counts.calls >= WRITES_PER_RUN) {
          all = false;
          break;
        }
        const id = String(r[0]);
        const changed = Number(r[1]);
        if ((await one(id)) === "held") blocked = true;
        if (!blocked && changed <= settled) {
          cursor.c = changed;
          cursor.i = id;
          progressed = true;
        }
      }
      if (!all || rows.length === PUSH_PAGE) more = true;
    } else {
      more = true;
    }

    for (const id of await dueRetries(this.db, row.id, now, 50)) {
      if (counts.calls >= WRITES_PER_RUN) {
        more = true;
        break;
      }
      await one(id);
    }

    const after = JSON.stringify(cursor);
    if (after !== before) {
      // Compare and set: two runs that meet never move the cursor back; the one that loses does its
      // part again next time, which writes nothing twice.
      await this.db.client.query({
        sql: "UPDATE connectors SET cursor = ? WHERE id = ? AND cursor IS ?",
        params: [after, row.id, before],
        method: "run",
      });
    }
    if (more) {
      // Straight on when this run got somewhere; when all it met was held or too new, after a pause.
      const wait = progressed || counts.calls > 0 ? 1_000 : CURSOR_LOOKBACK_MS;
      await ensureJob(this.db, CONNECTOR_PUSH_KIND, `cpush:${row.id}:more:${Math.floor((now + wait) / 10_000)}`, {
        now,
        runAt: now + wait,
        payload: { connectorId: row.id },
      });
    }
    return { written: counts.written, removed: counts.removed, failed: counts.failed, more };
  }

  /**
   * One booking made to match on the platform. `held`: another job holds it now and writes it;
   * `lost`: this job's claim ran out while it called, and the job that took it over records it.
   */
  private async reconcileOne(
    row: ConnectorRow,
    writer: NonNullable<ConnectorDefinition["bookings"]>,
    ctx: RunContext,
    itemId: string,
    now: number,
  ): Promise<"none" | "held" | "lost" | "written" | "removed" | "failed"> {
    const wanted = await this.outbound(itemId, ctx.inbox.origin);
    const link = await readLink(this.db, row.id, itemId);
    if (wanted) {
      const { booking, past } = wanted;
      // A booking that ended before it was ever written is history, not something to add now, nor a
      // failure to keep saying.
      if (booking.end < now - DAY_MS && !link?.externalId) {
        if (!link || link.state === "removed") return "none";
        const claim = await claimLink(this.db, row.id, itemId, now);
        if (!claim) return "held";
        await settleLink(this.db, claim, { kind: "removed" }, now);
        return "none";
      }
      // One that has happened (completed, a no-show) is never added, and stays where it was written:
      // it is only written again when its words changed (the customer's name taken off on erasure).
      if (past && (!link?.externalId || link.state === "removed")) return "none";
      const at = past ? { ...ctx, destination: link?.calendar ?? ctx.destination } : ctx;
      const hash = await bookingHash(booking, at.destination);
      if (link && link.state === "synced" && link.syncedHash === hash && !link.lastError) return "none";
      if (link?.lastError && link.retryAt !== null && link.retryAt > now) return "none";
      const claim = await claimLink(this.db, row.id, itemId, now);
      if (!claim) return "held";
      try {
        let current = stateOf(claim.link);
        // No id kept for it: an earlier run may have written it and stopped before it could say so, or
        // a connection to this account that was disconnected since wrote it. A connector whose
        // platform chooses the ids looks for it first.
        if (!current && writer.find) current = await writer.find(at, booking);
        const out = await writer.put(at, booking, current);
        const kept = await settleLink(
          this.db,
          claim,
          {
            kind: "synced",
            externalId: out.externalId,
            etag: out.etag,
            calendar: out.calendar,
            hash,
            start: booking.start,
            end: booking.end,
          },
          now,
        );
        return kept ? "written" : "lost";
      } catch (error) {
        await this.failLink(claim, error, now);
        return "failed";
      }
    }
    if (!link || link.state === "removed") return "none";
    if (link.lastError && link.retryAt !== null && link.retryAt > now && link.externalId) return "none";
    const claim = await claimLink(this.db, row.id, itemId, now);
    if (!claim) return "held";
    try {
      let current = stateOf(claim.link);
      if (!current && writer.find) {
        const gone = await this.outboundForFind(itemId, ctx.inbox.origin);
        if (gone) current = await writer.find(ctx, gone);
      }
      if (current) await writer.remove(ctx, current);
      const kept = await settleLink(this.db, claim, { kind: "removed" }, now);
      return kept ? "removed" : "lost";
    } catch (error) {
      await this.failLink(claim, error, now);
      return "failed";
    }
  }

  private async failLink(claim: LinkClaim, error: unknown, now: number): Promise<void> {
    if (!(error instanceof ConnectorError)) {
      // Our own bug: the claim is let go so the next run tries, and the error is said where it can be read.
      await settleLink(
        this.db,
        claim,
        { kind: "failed", error: `unexpected: ${String((error as Error)?.message ?? error)}`, retryAt: now + 600_000 },
        now,
      );
      return;
    }
    await settleLink(
      this.db,
      claim,
      {
        kind: "failed",
        error: error.message,
        retryAt: now + (error.retryAfterMs ?? retryDelayMs(claim.link.attempts)),
      },
      now,
    );
  }

  /**
   * What a booking should look like on the platform: written while confirmed; once it has happened
   * (completed, a no-show), `past`: left where it is, only its words kept up to date; and absent
   * otherwise (cancelled, declined, expired, still asked for). Never a test booking. The title names
   * the customer unless they were erased.
   */
  private async outbound(
    itemId: string,
    origin: string,
  ): Promise<{ readonly booking: OutboundBooking; readonly past: boolean } | null> {
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
    const past = state === "completed" || state === "no_show";
    if (state !== "confirmed" && !past) return null;
    const booking = bookingOf(itemId, r, origin);
    return booking ? { booking, past } : null;
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
    this.ready(def);
    if (!this.http) throw new WriteError("not_allowed", "This inbox cannot reach other services.");
    return def;
  }

  /** Refuses a way that is not ready here: the definition's readiness, then its preset's own. */
  private ready(def: ConnectorDefinition, preset?: ConnectorPreset | undefined): void {
    const ready = readiness(def, preset);
    if (ready !== true) {
      throw new WriteError("not_allowed", `${def.title} is not available on this inbox yet: ${ready}`, {
        details: { reason: "not_ready", kind: def.kind, ...(preset ? { preset: preset.id } : {}) },
      });
    }
  }

  /**
   * The address segment a connection is reached at (ADR-026 §4, §5), for a connector told by webhook at
   * its own address or one that serves a link: the one it has, when it is connected again in place, or a
   * new one. Null for a connector that needs none.
   */
  private async inboundFor(
    def: ConnectorDefinition,
    again: ConnectorRow | null,
  ): Promise<{ readonly token: string; readonly fresh: boolean } | null> {
    if (!def.hooks && !def.feed) return null;
    if (again?.inboundEnc && this.secrets) {
      try {
        return { token: await this.secrets.open("connector-inbound", again.id, again.inboundEnc), fresh: false };
      } catch {
        // Sealed under a key this instance no longer holds: a new address, which the connector names again.
      }
    }
    return { token: newInboundToken(), fresh: true };
  }

  /**
   * A connection that is a link the inbox makes (`auth: "link"`): nothing asked, nothing checked on
   * another platform, one per kind. The owner sees the link once it is made, and can make a new one.
   */
  private async makeLink(
    def: ConnectorDefinition,
    preset: string | null,
    name: string | undefined,
    now: number,
    box: SecretBox,
  ): Promise<ConnectionView> {
    if (!def.feed) {
      throw new WriteError("not_allowed", `${def.title} serves no link here.`, { details: { kind: def.kind } });
    }
    const connected: Connected = {
      account: def.title,
      externalId: def.kind,
      secret: {},
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
    };
    const inbound = await this.inboundFor(def, null);
    return this.store(def, preset, connected, name, now, box, false, undefined, inbound);
  }

  private async store(
    def: ConnectorDefinition,
    preset: string | null,
    connected: Connected,
    name: string | undefined,
    now: number,
    box: SecretBox,
    reconnect = false,
    inputs?: Readonly<Record<string, string>>,
    inbound?: { readonly token: string; readonly fresh: boolean } | null,
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
      inputs: inputs ?? {},
      payOn: def.capabilities.includes("pay_links"),
      // A connection that takes payments has a mode: a shop that says none takes real orders, and is
      // then the one connection that makes their links (ADR-023 §1, ADR-026 §2).
      mode: connected.mode ?? (def.capabilities.includes("pay_links") ? "live" : null),
      disconnectingAt: null,
      disconnectTries: 0,
      choices: connected.choices ?? [],
      catalogue: null,
    };
    const presetLabel = preset ? def.presets?.find((p) => p.id === preset)?.label : undefined;
    const title = name?.trim() || presetLabel || def.title;
    // A new payment platform sends the links of its mode from now on; the one that did stops making
    // new ones (what it sent keeps working, and it still hears of their payments).
    const replaced =
      config.payOn && config.mode
        ? (await this.rows()).filter(
            (r) => r.kind !== def.kind && r.config.mode === config.mode && r.config.payOn && this.paysFor(r.kind),
          )
        : [];
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
    // The connection's own address: written for a new one, and again when connecting gave it a new one.
    const address =
      inbound && (!existingId || inbound.fresh)
        ? { hash: await inboundHash(inbound.token), sealed: await box.seal("connector-inbound", id, inbound.token) }
        : null;
    if (existingId) {
      // Connecting again with the same account: new credentials, the owner's choices kept, and the
      // failing it did forgotten (the sync starts again at its usual pace).
      await this.db.batch([
        {
          sql: `UPDATE connectors SET config_enc = ?, status = CASE WHEN status = 'disabled' THEN status ELSE 'configured' END,
                       last_error = NULL, last_error_at = NULL, error_code = NULL, failing_since = NULL, failures = 0,
                       notified_at = NULL,
                       config_public = json_set(config_public, '$.account', ?, '$.calendars', json(?), '$.destinations', json(?),
                       '$.extra', json(?), '$.refreshedAt', ?, '$.mode', ?${inputs ? ", '$.inputs', json(?)" : ""}${connected.choices ? ", '$.choices', json(?)" : ""}),
                       ${address ? "inbound_token = ?, inbound_enc = ?, " : ""}updated_at = ? WHERE id = ?`,
          params: [
            sealed,
            config.account,
            JSON.stringify(config.calendars),
            JSON.stringify(config.destinations),
            JSON.stringify(config.extra),
            now,
            config.mode,
            ...(inputs ? [JSON.stringify(inputs)] : []),
            ...(connected.choices
              ? [JSON.stringify(mergeChoices(await this.choicesOf(existingId), connected.choices))]
              : []),
            ...(address ? [address.hash, address.sealed] : []),
            now,
            id,
          ],
          method: "run",
        },
        jobStatement(CONNECTOR_SYNC_KIND, { connectorId: id }, now, { dedupeKey: `csync:${id}:r${now}` }),
      ]);
      return this.view(await this.row(id), now);
    }
    try {
      await this.db.batch([
        {
          sql: `INSERT INTO connectors (id, kind, name, external_id, config_enc, config_public, status, inbound_token, inbound_enc, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?)`,
          params: [
            id,
            def.kind,
            title,
            connected.externalId,
            sealed,
            JSON.stringify(config),
            address?.hash ?? null,
            address?.sealed ?? null,
            now,
            now,
          ],
          method: "run",
        },
        ...replaced.map(
          (r): Statement => ({
            sql: "UPDATE connectors SET config_public = json_set(config_public, '$.payOn', json('false')), updated_at = ? WHERE id = ?",
            params: [now, r.id],
            method: "run",
          }),
        ),
        // The first sync straight away: the owner who just connected is watching the screen. A link
        // the inbox serves has nothing to read or write: no sync at all.
        ...(def.capabilities.length > 0 || def.refresh
          ? [jobStatement(CONNECTOR_SYNC_KIND, { connectorId: id }, now, { dedupeKey: `csync:${id}:first` })]
          : []),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new WriteError("wrong_state", `${connected.account} is connected already.`);
      }
      throw error;
    }
    return this.view(await this.row(id), now);
  }

  private async connectContext(
    now: number,
    kind: string,
    token?: string | undefined,
  ): Promise<{ http: ConnectorHttp; now: number; inbox: InboxIdentity; hookUrl: string | null; hooksLive: boolean }> {
    if (!this.http) throw new WriteError("not_allowed", "This inbox cannot reach other services.");
    const inbox = await this.identity();
    return { http: this.http, now, inbox, hookUrl: hookUrlOf(inbox.origin, kind, token), hooksLive: this.hooksLive };
  }

  /** What a connection's choosers hold now, for connecting it again in place. */
  private async choicesOf(id: string): Promise<readonly ConnectionChoice[]> {
    return (await this.rowOrNull(id))?.config.choices ?? [];
  }

  /** Where platforms send what they tell this inbox: `<origin>/v1/hooks/<kind>`; null without an https origin. */
  private async hookBase(): Promise<string | null> {
    const origin = (await this.identity()).origin;
    return hookUrlOf(origin, "") === null ? null : `${origin}/v1/hooks/`;
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
      id: await instanceId(this.db, Date.now()),
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
    const inbox = await this.identity();
    // A connector told by webhook at its own address names it with its token; the rest, the kind's.
    const hooked = this.definitions.get(row.kind)?.hooks !== undefined;
    let token: string | undefined;
    if (row.inboundEnc && hooked) {
      try {
        token = await box.open("connector-inbound", row.id, row.inboundEnc);
      } catch {
        token = undefined;
      }
    }
    return {
      http: this.http,
      now,
      inbox,
      // Without its own address (sealed under a key this instance no longer holds), none: never the kind's.
      hookUrl: hooked && !token ? null : hookUrlOf(inbox.origin, row.kind, token),
      hooksLive: this.hooksLive,
      secret,
      extra: row.config.extra ?? {},
      calendars: row.config.calendars ?? [],
      busyCalendars: row.config.busyCalendars ?? [],
      destinations: row.config.destinations ?? [],
      destination: row.config.destination ?? null,
      own: await this.ownEvents(),
      marker: await markerOf(box, row.kind, row.externalId ?? row.id),
      choices: Object.fromEntries((row.config.choices ?? []).map((c) => [c.key, c.value])),
      async saveSecret(next) {
        await db.client.query({
          sql: "UPDATE connectors SET config_enc = ? WHERE id = ?",
          params: [await box.seal("connector-config", row.id, JSON.stringify(next)), row.id],
          method: "run",
        });
      },
    };
  }

  /**
   * What this inbox wrote on any platform: every connection's bookings, not only this one's. Cal.com
   * writes the bookings it is given into a calendar the owner may have connected here as well, and
   * two calendars can show each other's events; a booking is never busy against itself.
   */
  private async ownEvents(): Promise<RunContext["own"]> {
    const links = await liveLinks(this.db);
    return {
      ids: new Set(links.map((l) => l.externalId).filter((v): v is string => v !== null)),
      spans: links
        .filter((l) => l.syncedStart !== null && l.syncedEnd !== null)
        .map((l) => ({ start: l.syncedStart as number, end: l.syncedEnd as number })),
    };
  }

  /**
   * A sync that failed: said on the row, counted (the sync backs off on it), and told to the owner
   * once — at once when the platform refused the sign-in or what was given cannot work, after two
   * hours when it does not answer — until it works again.
   */
  private async markError(
    row: ConnectorRow,
    error: { readonly code: ConnectorErrorCode; readonly message: string },
    now: number,
  ): Promise<void> {
    await this.db.client.query({
      sql: `UPDATE connectors SET status = CASE WHEN status = 'disabled' THEN status ELSE 'error' END,
                   last_error = ?, last_error_at = ?, error_code = ?, failing_since = COALESCE(failing_since, ?),
                   failures = failures + 1, updated_at = ? WHERE id = ?`,
      params: [error.message.slice(0, 500), now, error.code, now, now, row.id],
      method: "run",
    });
    const after = await this.rowOrNull(row.id);
    if (after?.status !== "error" || after.notifiedAt !== null) return;
    const since = after.failingSince ?? now;
    const tell = error.code === "auth" || error.code === "config" || now - since >= NOTICE_AFTER_MS;
    if (!tell) return;
    const claimed = await this.db.client.query({
      sql: "UPDATE connectors SET notified_at = ? WHERE id = ? AND notified_at IS NULL",
      params: [now, row.id],
      method: "run",
    });
    if (claimed.changes !== 1) return;
    await this.db.batch([
      jobStatement(CONNECTOR_NOTICE_KIND, { connectorId: row.id }, now, { dedupeKey: `cnotice:${row.id}:${since}` }),
    ]);
  }

  /**
   * The words of the one email that says a connection stopped syncing, or null when it works again
   * (or is gone) by the time the email would go.
   */
  async failingNotice(connectorId: string): Promise<{
    readonly title: string;
    readonly error: string;
    readonly group: ConnectorGroup | null;
  } | null> {
    const row = await this.rowOrNull(connectorId);
    if (row?.status !== "error") return null;
    const def = this.definitions.get(row.kind);
    const presetLabel = row.config.preset ? def?.presets?.find((p) => p.id === row.config.preset)?.label : undefined;
    const name = row.name || presetLabel || def?.title || row.kind;
    // A payment platform is named as it is ("Stripe"), never as a calendar.
    const payments = def?.group === "payments";
    return {
      title: payments ? name : calendarName(name),
      error: row.lastError ?? "",
      group: def?.group ?? null,
    };
  }

  /** The words of the one email that a shop's catalogue was cut at the limit; null when it no longer is. */
  async cappedNotice(connectorId: string): Promise<{ readonly title: string; readonly max: number } | null> {
    const row = await this.rowOrNull(connectorId);
    if (!row?.config.catalogue?.truncated) return null;
    return { title: row.name || this.definitions.get(row.kind)?.title || row.kind, max: MAX_CATALOGUE };
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

  private async view(row: ConnectorRow, now: number, person = false): Promise<ConnectionView> {
    const def = this.definitions.get(row.kind);
    const [busy, links] = await Promise.all([
      this.db.client.query({
        sql: `SELECT COUNT(*) FROM connector_busy b JOIN connectors c ON c.id = b.connector_id AND b.gen = c.busy_gen
               WHERE b.connector_id = ? AND b.end_ms > ?`,
        params: [row.id, now],
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
    const pays = def?.payments && def.capabilities.includes("pay_links") ? await this.payments.counts(row.id) : null;
    const hook = row.config.extra?.webhook;
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
      busy_until: row.busyUntil,
      busy_partial:
        row.busyUntil !== null && row.busyAt !== null && row.busyUntil < row.busyAt + BUSY_HORIZON_MS - 60_000,
      bookings_written: Number(l[0] ?? 0),
      bookings_failing: Number(l[1] ?? 0),
      booking_error: l[2] === null || l[2] === undefined ? null : String(l[2]),
      last_sync_at: row.lastSyncAt,
      last_error: row.lastError,
      last_error_at: row.lastErrorAt,
      error_code: row.errorCode,
      failing_since: row.failingSince,
      created_at: row.createdAt,
      pay_on: row.config.payOn,
      mode: row.config.mode,
      payments:
        pays && def?.payments
          ? {
              open: pays.open,
              paid: pays.paid,
              failing: pays.failing,
              last_paid_at: pays.lastPaidAt,
              webhook:
                hook === "added" || hook === "by_hand" || hook === "per_link" || hook === "pending" ? hook : null,
              dashboard_url: def.payments.dashboardUrl({ extra: row.config.extra ?? {} }, row.config.mode ?? "live"),
              disconnecting: row.config.disconnectingAt !== null,
              closing: pays.closing,
              held: pays.held,
            }
          : null,
      card: cardOf(row.kind, row.config.preset) ?? null,
      choices: row.config.choices ?? [],
      catalogue:
        def?.catalogue && def.capabilities.includes("catalogue") && row.externalId
          ? {
              products: await activeProducts(this.db, connectorSource(row.kind, row.externalId)),
              read_at: row.config.catalogue?.lastFullAt || null,
              truncated: row.config.catalogue?.truncated === true,
            }
          : null,
      link: person && def?.feed ? await this.linkOf(row, def.feed.extension) : null,
      disconnect_note: def?.disconnectNote ?? null,
    };
  }

  /** The link a connection serves, as the owner copies it; null when it cannot be opened here. */
  private async linkOf(row: ConnectorRow, extension: string): Promise<string | null> {
    if (!row.inboundEnc || !this.secrets) return null;
    const origin = (await this.identity()).origin;
    if (!origin) return null;
    try {
      const token = await this.secrets.open("connector-inbound", row.id, row.inboundEnc);
      return `${origin}/v1/feeds/${encodeURIComponent(row.kind)}/${token}${extension}`;
    } catch {
      return null;
    }
  }

  /* --- payments (ADR-023) ------------------------------------------------------ */

  /** Whether connections of this kind take payments here. */
  private paysFor(kind: string): boolean {
    const def = this.definitions.get(kind);
    return Boolean(def?.payments && def.capabilities.includes("pay_links"));
  }

  private payConnectionOf(row: ConnectorRow, def: ConnectorDefinition, ctx: RunContext): PayConnection {
    if (!def.payments) throw new Error(`${def.kind} takes no payments`);
    const presetLabel = row.config.preset ? def.presets?.find((p) => p.id === row.config.preset)?.label : undefined;
    return {
      id: row.id,
      kind: row.kind,
      title: presetLabel ?? def.title,
      mode: row.config.mode ?? "live",
      status: row.status,
      payOn: row.config.payOn,
      createdAt: row.createdAt,
      disconnecting: row.config.disconnectingAt !== null,
      payments: def.payments,
      ctx,
      shop:
        def.capabilities.includes("shop_orders") && row.externalId
          ? { source: connectorSource(row.kind, row.externalId) }
          : null,
      // A connector read back on every sync is told nothing it needs this inbox's address for.
      needsHookUrl: def.hooks === undefined,
    };
  }

  /** What the payments side is given: the database, the payment connections opened, and their state. */
  private payHost(): PayHost {
    const open = async (row: ConnectorRow, now: number): Promise<PayConnection | null> => {
      const def = this.definitions.get(row.kind);
      if (!def?.payments || !def.capabilities.includes("pay_links") || !this.http || !this.secrets) return null;
      try {
        return this.payConnectionOf(row, def, await this.runContext(row, now));
      } catch {
        // Credentials that do not open here (another instance key): nothing can be asked of the platform.
        return null;
      }
    };
    return {
      db: this.db,
      payConnections: async (now) => {
        const out: PayConnection[] = [];
        for (const row of await this.rows()) {
          if (!this.definitions.get(row.kind)?.payments) continue;
          const conn = await open(row, now);
          if (conn) out.push(conn);
        }
        return out;
      },
      payConnection: async (id, now) => {
        const row = await this.rowOrNull(id);
        return row ? open(row, now) : null;
      },
      failed: async (id, error, now) => {
        const row = await this.rowOrNull(id);
        if (row) await this.markError(row, error, now);
      },
      worked: async (id, now) => {
        await this.db.client.query({
          sql: `UPDATE connectors SET status = 'active', last_error = NULL, last_error_at = NULL, error_code = NULL,
                       failing_since = NULL, failures = 0, notified_at = NULL, updated_at = ?
                 WHERE id = ? AND status IN ('error', 'configured')`,
          params: [now, id],
          method: "run",
        });
      },
      title: (kind) => this.definitions.get(kind)?.title ?? kind,
    };
  }

  /** What the webhook side is given: the connections by address, opened, and how to say a failure. */
  private hookHost(): HookHost {
    return {
      db: this.db,
      payments: this.payments,
      definition: (kind) => this.definitions.get(kind),
      connectionByToken: async (kind, tokenHash) => {
        const { rows } = await this.db.client.query({
          sql: "SELECT id, kind FROM connectors WHERE kind = ? AND inbound_token = ?",
          params: [kind, tokenHash],
          method: "all",
        });
        return rows[0] ? { id: String(rows[0][0]), kind: String(rows[0][1]) } : null;
      },
      context: async (id, now) => {
        const row = await this.rowOrNull(id);
        if (!row || !this.http || !this.secrets) return null;
        try {
          return await this.runContext(row, now);
        } catch {
          return null;
        }
      },
      payConnection: async (id, now) => {
        const row = await this.rowOrNull(id);
        const def = row ? this.definitions.get(row.kind) : undefined;
        if (!row || !def?.payments || !def.capabilities.includes("pay_links")) return null;
        try {
          return this.payConnectionOf(row, def, await this.runContext(row, now));
        } catch {
          return null;
        }
      },
      failed: async (id, error, now) => {
        const row = await this.rowOrNull(id);
        if (row) await this.markError(row, error, now);
      },
      syncNow: async (id, now, key) => {
        const row = await this.rowOrNull(id);
        const def = row ? this.definitions.get(row.kind) : undefined;
        // Products changed: the catalogue alone, at once. Anything else: a sync.
        const kind = def?.catalogue ? CONNECTOR_CATALOGUE_KIND : CONNECTOR_SYNC_KIND;
        await this.db.batch([jobStatement(kind, { connectorId: id }, now, { dedupeKey: `${kind}:${id}:${key}` })]);
      },
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
  "id, kind, name, external_id, config_enc, config_public, cursor, status, last_error, last_error_at, last_sync_at, busy_at, created_at, busy_gen, busy_until, error_code, failing_since, failures, notified_at, inbound_enc";

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
    busyGen: n(r[13]),
    busyUntil: n(r[14]),
    errorCode: r[15] === null || r[15] === undefined ? null : String(r[15]),
    failingSince: n(r[16]),
    failures: Number(r[17] ?? 0),
    notifiedAt: n(r[18]),
    inboundEnc: r[19] === null || r[19] === undefined ? null : String(r[19]),
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
    inputs:
      c.inputs && typeof c.inputs === "object"
        ? Object.fromEntries(Object.entries(c.inputs).filter(([, v]) => typeof v === "string"))
        : {},
    payOn: c.payOn === true,
    mode: c.mode === "live" || c.mode === "test" ? c.mode : null,
    disconnectingAt: typeof c.disconnectingAt === "number" ? c.disconnectingAt : null,
    disconnectTries: typeof c.disconnectTries === "number" ? c.disconnectTries : 0,
    choices: Array.isArray(c.choices) ? c.choices.filter(isChoice) : [],
    catalogue: catalogueStateOf(c.catalogue),
  };
}

function isChoice(v: unknown): v is ConnectionChoice {
  const c = v as Partial<ConnectionChoice> | null;
  return (
    typeof c?.key === "string" &&
    typeof c.label === "string" &&
    Array.isArray(c.options) &&
    (c.value === null || typeof c.value === "string")
  );
}

const EMPTY_CATALOGUE: CatalogueState = { full: null, lastFullAt: 0, since: null, partial: null, truncated: false };

function catalogueStateOf(raw: unknown): CatalogueState | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<CatalogueState>;
  const pass = (v: unknown) => {
    const p = v as { cursor?: unknown; startedAt?: unknown; seen?: unknown } | null;
    return p && typeof p.startedAt === "number" && (p.cursor === null || typeof p.cursor === "string") ? p : null;
  };
  const full = pass(c.full);
  const partial = pass(c.partial);
  return {
    full: full
      ? {
          cursor: (full.cursor as string | null) ?? null,
          startedAt: full.startedAt as number,
          seen: Number(full.seen ?? 0),
        }
      : null,
    lastFullAt: typeof c.lastFullAt === "number" ? c.lastFullAt : 0,
    since: typeof c.since === "number" ? c.since : null,
    partial: partial
      ? { cursor: (partial.cursor as string | null) ?? null, startedAt: partial.startedAt as number }
      : null,
    truncated: c.truncated === true,
  };
}

/** Choosers sent again: their options anew, and what the owner chose kept where it is still an option. */
function mergeChoices(old: readonly ConnectionChoice[], fresh: readonly ConnectionChoice[]): ConnectionChoice[] {
  return fresh.map((c) => {
    const before = old.find((o) => o.key === c.key);
    const kept = before?.value && c.options.some((o) => o.id === before.value) ? before.value : null;
    return { key: c.key, label: c.label, options: c.options, value: kept ?? c.value };
  });
}

/** What a sign-in asked first, as `connector_auth.input` keeps it: the way, and the values. */
function authInputOf(raw: unknown): { readonly preset: string | null; readonly values: Record<string, string> } {
  try {
    const j = (typeof raw === "string" ? JSON.parse(raw) : null) as { preset?: unknown; values?: unknown } | null;
    const values: Record<string, string> = {};
    if (j?.values && typeof j.values === "object") {
      for (const [k, v] of Object.entries(j.values as Record<string, unknown>))
        if (typeof v === "string") values[k] = v;
    }
    return { preset: typeof j?.preset === "string" ? j.preset : null, values };
  } catch {
    return { preset: null, values: {} };
  }
}

/** Links a disconnect switches off in the owner's request; the rest by its job, more at a time. */
const DISCONNECT_NOW = 5;
const DISCONNECT_STEP = 20;
/** When a disconnect's job looks again, after each try: then it is done, whatever is left. */
const DISCONNECT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000] as const;

/**
 * What a connection leaves when it goes: its busy times, its links to bookings, and what its platform
 * told it (`connector_events` names it, so it goes first). A payment platform's links stay, as the
 * business's record of where its money went.
 */
function deleteStatements(connectorId: string): Statement[] {
  return [
    { sql: "DELETE FROM connector_busy WHERE connector_id = ?", params: [connectorId], method: "run" },
    { sql: "DELETE FROM connector_links WHERE connector_id = ?", params: [connectorId], method: "run" },
    { sql: "DELETE FROM connector_events WHERE connector_id = ?", params: [connectorId], method: "run" },
    { sql: "DELETE FROM connectors WHERE id = ?", params: [connectorId], method: "run" },
  ];
}

/**
 * `<origin>/v1/hooks/<kind>` for an https origin, or a connection's own `<origin>/v1/hooks/<kind>/<token>`;
 * null for none (a platform cannot reach it).
 */
function hookUrlOf(origin: string, kind: string, token?: string | undefined): string | null {
  if (!origin.startsWith("https://")) return null;
  return token ? `${origin}/v1/hooks/${kind}/${token}` : `${origin}/v1/hooks/${kind}`;
}

/** What the connector made on the platform for a key, kept or taken away again (`Connected.settle`). */
async function settle(connected: Connected, kept: boolean): Promise<void> {
  if (!connected.settle) return;
  try {
    await connected.settle(kept);
  } catch {
    // Best effort: what is left behind is listed, and removed, the next time it connects.
  }
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

/**
 * A path in the owner app, or Settings → Integrations: never an address on another site. The path is
 * resolved the way a browser would (`/.//evil.example` becomes `//evil.example`, another site) and
 * kept only when it stays here.
 */
export function safeReturnPath(raw: string | undefined): string {
  const fallback = "/settings/integrations";
  const path = (raw ?? "").trim();
  const control = [...path].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || control) return fallback;
  let url: URL;
  try {
    url = new URL(path, "https://inbox.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://inbox.invalid" || url.pathname.startsWith("//") || url.pathname.includes("\\")) {
    return fallback;
  }
  const kept = `${url.pathname}${url.search}`;
  return kept.length > 200 ? fallback : kept;
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
 * Connecting hands over a password or a sign-in, and what is chosen (or switched off, or
 * disconnected) changes what customers can book: the owner does it, in person, in Settings. Their AI
 * and a key handed to another system may read what is connected and sync it, nothing more.
 */
function requirePerson(caller: Caller, verb: string): void {
  if (isPerson(caller)) return;
  if (isOwnerAssistant(caller)) {
    throw new WriteError(
      "not_allowed",
      `A connection holds the owner's password or sign-in, so you cannot ${verb} one. Tell the owner in a note; they do it in Settings → Integrations.`,
      { details: { reason: "owner_credentials", draft_for_owner: true } },
    );
  }
  throw new WriteError(
    "not_allowed",
    `A connection holds the owner's password or sign-in, so a key cannot ${verb} one. The owner does it in Settings → Integrations.`,
    { details: { reason: "owner_credentials" } },
  );
}

/**
 * The mark a connector puts on what it writes where the platform chooses the ids: an HMAC under the
 * instance key of the platform and the account, so it is the same after connecting that account
 * again, and nobody without the key can make it.
 */
async function markerOf(box: SecretBox, kind: string, account: string): Promise<string> {
  const key = await box.mac("connector-marker");
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${kind}:${account}`) as BufferSource),
  );
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PushCursor {
  /**
   * Where the first pass is, through the confirmed bookings still to come (`items.start_at`, the
   * start as the booking gives it, and the id after it); null once it is done.
   */
  fill: { s: string; i: string } | null;
  /** Where the second pass is, through the bookings that changed: a time and the id after it. */
  c: number;
  i: string;
}

/** The cursor as a run reads it: a new connection starts with the first pass, changes from now. */
function parseCursor(raw: string | null, now: number): PushCursor {
  const fresh = { fill: { s: "", i: "" }, c: now - CURSOR_LOOKBACK_MS, i: "" };
  if (raw === null) return fresh;
  if (/^\d+$/.test(raw)) return { fill: null, c: Number(raw), i: "" };
  try {
    const j = JSON.parse(raw) as { fill?: unknown; c?: unknown; i?: unknown };
    const fill = j.fill as { s?: unknown; i?: unknown } | null | undefined;
    const okFill = fill === null || (typeof fill?.s === "string" && typeof fill?.i === "string");
    if (typeof j.c === "number" && typeof j.i === "string" && okFill) {
      return { fill: fill ? { s: String(fill.s), i: String(fill.i) } : null, c: j.c, i: j.i };
    }
  } catch {
    // Unreadable: start again from the beginning, which writes nothing that is already written.
  }
  return fresh;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export { secretKeys };
