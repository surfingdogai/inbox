import { z } from "zod";

/**
 * The connector SDK (ADR-014, ADR-015, ADR-022).
 *
 * A connector is a small object that says what it does for the inbox (its capabilities), what the
 * owner gives it (a Zod schema whose secret fields are marked), and how it syncs. Everything around
 * it is the inbox's: the settings form is drawn from the schema, secrets are sealed by the secret box
 * before they touch the database, every call leaves through the host's outbound fetch with its
 * checks, and the jobs that call it are claimed so two of them never write the same thing twice.
 *
 * A connector never sees the database, the settings or another connector. It is handed the
 * credentials it was given, what it said about itself last time, an HTTP client, and the bookings to
 * write; it answers with busy times, ids and errors in the owner's words. That narrow seam is what
 * lets anyone add one without learning the inbox.
 */

/** What a connector does for the inbox. More arrive with the platforms that need them. */
export type ConnectorCapability =
  /** Times the platform says are busy take those times off what the inbox offers. */
  | "busy_times"
  /** Bookings the inbox confirms are written on the platform, and kept in step when they move or end. */
  | "write_bookings"
  /**
   * Orders the inbox accepts get a link to pay in the business's own account on the platform, and the
   * platform's signed word that it was paid marks them paid (ADR-023). The money never passes the inbox.
   */
  | "pay_links";

export type ConnectorGroup = "calendars" | "payments" | "shops";

/* --- the form ------------------------------------------------------------ */

/** How one field of a connector's form is shown. Hints only: the schema is what is checked. */
export interface FieldHints {
  readonly label: string;
  readonly help?: string | undefined;
  /** Where the owner gets the value: an API-key page, an app-password page. */
  readonly link?: { readonly href: string; readonly text: string } | undefined;
  readonly placeholder?: string | undefined;
  readonly input?: "text" | "email" | "url" | "password" | undefined;
  /** Sealed before it is stored and never shown again, to the owner or to their AI. */
  readonly secret?: boolean | undefined;
  readonly autocomplete?: string | undefined;
  /** Kept under "More options": most people never need it. */
  readonly advanced?: boolean | undefined;
  /** A preset that needs a field the schema leaves optional says so here (a Nextcloud address). */
  readonly required?: boolean | undefined;
}

/** Where field hints live: a registry of their own, so nothing else in the schema is touched. */
export const fieldHints = z.registry<FieldHints>();

/** A form field with how it is shown. */
export function field<T extends z.ZodType>(schema: T, hints: FieldHints): T {
  fieldHints.add(schema, hints);
  return schema;
}

/**
 * A field that is sealed by the secret box and never read back: an API key, a password. It is never
 * filled in by a browser or a password manager: an app password made for this inbox is not the
 * account's password, and a manager that offers a new one breaks the connection before it starts.
 */
export function secretField<T extends z.ZodType>(schema: T, hints: Omit<FieldHints, "secret">): T {
  return field(schema, { input: "password", autocomplete: "off", ...hints, secret: true });
}

/** One field as the owner app draws it. */
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly input: "text" | "email" | "url" | "password";
  readonly required: boolean;
  readonly secret: boolean;
  readonly advanced: boolean;
  readonly help?: string | undefined;
  readonly link?: { readonly href: string; readonly text: string } | undefined;
  readonly placeholder?: string | undefined;
  readonly autocomplete?: string | undefined;
}

/**
 * A way of filling the form that people recognise ("iCloud", "Fastmail"): the values it fixes are not
 * asked for, and the fields it names are explained in that platform's words.
 */
export interface ConnectorPreset {
  readonly id: string;
  readonly label: string;
  readonly values: Readonly<Record<string, string>>;
  readonly fields?: Readonly<Record<string, Partial<FieldHints>>> | undefined;
  readonly note?: string | undefined;
}

/** The form for a connector's schema, as a preset fills it: every field the owner still has to give. */
export function describeForm(schema: z.ZodObject, preset?: ConnectorPreset | undefined): FormField[] {
  const out: FormField[] = [];
  for (const [key, raw] of Object.entries(schema.shape)) {
    if (preset && key in preset.values) continue;
    const zod = raw as z.ZodType;
    const hints = { ...hintsOf(zod), ...(preset?.fields?.[key] ?? {}) } as FieldHints;
    out.push({
      key,
      label: hints.label ?? key,
      input: hints.input ?? "text",
      required: hints.required ?? !zod.safeParse(undefined).success,
      secret: hints.secret === true,
      advanced: hints.advanced === true,
      ...(hints.help ? { help: hints.help } : {}),
      ...(hints.link ? { link: hints.link } : {}),
      ...(hints.placeholder ? { placeholder: hints.placeholder } : {}),
      ...(hints.autocomplete ? { autocomplete: hints.autocomplete } : {}),
    });
  }
  return out;
}

/** The keys of a schema's secret fields: what is sealed, and what no answer ever carries. */
export function secretKeys(schema: z.ZodObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, raw]) => hintsOf(raw as z.ZodType)?.secret === true)
    .map(([key]) => key);
}

function hintsOf(schema: z.ZodType): Partial<FieldHints> {
  let current: z.ZodType | undefined = schema;
  // Hints sit on the field as written; a wrapper (optional, default) added later is looked through.
  for (let depth = 0; current && depth < 4; depth++) {
    const hints = fieldHints.get(current);
    if (hints) return hints;
    const inner: z.ZodType | undefined = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
    current = inner;
  }
  return {};
}

/* --- talking to a platform ------------------------------------------------ */

export interface ConnectorHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Larger answers are cut off and refused (default 2 MB). */
  readonly maxBytes?: number | undefined;
  /** Default 15 s. */
  readonly timeoutMs?: number | undefined;
  /**
   * Follow redirects, each hop checked again (https, a public host). Credentials travel only to the
   * same site as the request's own host; to any other the request goes without them, or not at all.
   */
  readonly followRedirects?: boolean | undefined;
}

export interface ConnectorHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Where the answer came from, after any redirects. */
  readonly url: string;
}

/**
 * The only way a connector reaches the world. The host's implementation refuses what is not https
 * or not a public host, bounds redirects, sizes and time, and on Node connects only to an address it
 * resolved and checked (`pinnedFetch`).
 */
export interface ConnectorHttp {
  request(request: ConnectorHttpRequest): Promise<ConnectorHttpResponse>;
}

export type ConnectorErrorCode =
  /** The platform did not take the credentials: they are wrong, expired or withdrawn. */
  | "auth"
  /** What was asked for is not there (a calendar removed, an event type gone). */
  | "not_found"
  /** The platform could not be reached, or did not answer in time. */
  | "unreachable"
  /** The platform answered and said no (a time it would not take). */
  | "refused"
  | "rate_limited"
  /** The platform answered with something we could not read. */
  | "bad_response"
  /** What the owner gave cannot work (a server that is not a calendar server). */
  | "config";

/** A failure in the owner's words: what went wrong and, where it helps, which field to fix. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly field: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    opts: { readonly field?: string | undefined; readonly retryAfterMs?: number | undefined } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.field = opts.field;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/* --- what a connection holds ---------------------------------------------- */

/** A calendar the owner can read busy times from, or send bookings to. */
export interface CalendarChoice {
  readonly id: string;
  readonly name: string;
  /** Whether bookings can be written to it. */
  readonly writable: boolean;
  readonly primary?: boolean | undefined;
  /** For a destination that is a Cal.com event type: its length, and the other lengths it takes. */
  readonly lengths?: readonly number[] | undefined;
}

/** What `connect` (or an OAuth exchange) found: who it is, what to seal, what the owner can choose. */
export interface Connected {
  /** What the owner recognises the account by: an address, a username. */
  readonly account: string;
  /** The platform's own id for the account, unique per kind: the same account is never connected twice. */
  readonly externalId: string;
  /** Sealed by the secret box. */
  readonly secret: Readonly<Record<string, string>>;
  /** What the connector keeps about itself that is not secret: a discovered server address, a user id. */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
  /** Calendars busy times may be read from. */
  readonly calendars: readonly CalendarChoice[];
  /** Where bookings may be written: calendars, or event types. */
  readonly destinations: readonly CalendarChoice[];
  /** What is chosen until the owner chooses otherwise. */
  readonly defaults: { readonly busy: readonly string[]; readonly destination: string | null };
  /**
   * A payment platform's mode: a test key makes links for test items only, and a live key for real
   * ones, so nobody is ever asked for real money for a test, nor marked paid with a test card.
   */
  readonly mode?: "live" | "test" | undefined;
}

/**
 * The inbox a connector works for: its own id (which the entries it writes carry, so it knows them
 * wherever its address moves), its origin (for links) and its business's name, zone and language.
 */
export interface InboxIdentity {
  /** Made once at random, never shown: marks what this inbox wrote. Never its host, which changes. */
  readonly id: string;
  readonly origin: string;
  /** For links only: never to tell this inbox's entries from another's. */
  readonly host: string;
  readonly name: string;
  readonly timezone: string;
  readonly language: string;
}

export interface ConnectContext {
  readonly http: ConnectorHttp;
  readonly now: number;
  readonly inbox: InboxIdentity;
  /**
   * Connecting again in place: what the connection said about itself before (`extra`), so a connector
   * can find what it made on the platform last time (a payment platform's webhook endpoint).
   */
  readonly previous?:
    | { readonly externalId: string | null; readonly extra: Readonly<Record<string, unknown>> }
    | undefined;
  /**
   * Where the platform sends what it tells this inbox (`POST /v1/hooks/<kind>`), on the inbox's own
   * public address; null when the inbox does not know its address (no INBOX_PUBLIC_URL, nor an Inbox address in Settings).
   */
  readonly hookUrl?: string | null | undefined;
}

/** What this inbox has written on the platform, so a connector leaves it out of busy times. */
export interface OwnEvents {
  /** The platform's ids for the events this inbox wrote. */
  readonly ids: ReadonlySet<string>;
  /** Their spans, for a platform that answers with times and no ids (a free/busy query). */
  readonly spans: readonly Interval[];
}

export interface RunContext extends ConnectContext {
  readonly secret: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, unknown>>;
  /** The calendars the connection has, and the ones the owner chose to read busy times from. */
  readonly calendars: readonly CalendarChoice[];
  readonly busyCalendars: readonly string[];
  /** Where bookings can go, and where the owner chose; null for the connector's own default. */
  readonly destinations: readonly CalendarChoice[];
  readonly destination: string | null;
  readonly own: OwnEvents;
  /**
   * A secret only this inbox can make, the same for every connection of this account (connected
   * again or not): put on what the connector writes where the platform keeps no id of the inbox's
   * own choosing, so it finds its own and nobody else can pass for it.
   */
  readonly marker: string;
  /** Keeps a changed secret (a refreshed access token) sealed, for the next run. */
  saveSecret(next: Readonly<Record<string, string>>): Promise<void>;
}

/** Milliseconds since the epoch, start inclusive, end exclusive. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * Busy times as a connector read them, when it could not read the whole window (a platform that
 * answers only so many pages): `until` is how far ahead the answer is complete. Past it the inbox
 * offers nothing, rather than a time nobody knows is free.
 */
export interface BusyRead {
  readonly intervals: readonly Interval[];
  readonly until: number;
}

/** A confirmed booking as a connector writes it: times, and words the owner wants to see in a calendar. */
export interface OutboundBooking {
  readonly itemId: string;
  readonly start: number;
  readonly end: number;
  /** "Haircut · Ana": the service, and the customer's name unless they were erased. */
  readonly title: string;
  readonly description: string;
  /** The booking in the owner app. */
  readonly url: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly customerName: string | null;
  readonly durationMin: number;
}

/** What a connector keeps about one booking it wrote. */
export interface LinkState {
  readonly externalId: string | null;
  readonly etag: string | null;
  /** Where it was written: a calendar, an event type. */
  readonly calendar: string | null;
  /** The times last written, when known: a platform that moves a booking by rescheduling needs them. */
  readonly start?: number | undefined;
  readonly end?: number | undefined;
}

export interface BookingWriter {
  /**
   * Writes the booking: creates it when `link` is null, else moves it to the booking's times. Safe to
   * call again with the same booking, which is what a retry does.
   */
  put(ctx: RunContext, booking: OutboundBooking, link: LinkState | null): Promise<LinkState>;
  /** Takes it off the platform. Done, not an error, when it was gone already. */
  remove(ctx: RunContext, link: LinkState): Promise<void>;
  /**
   * The booking as this inbox wrote it earlier, for a run that stopped between writing and noting the
   * id. A connector whose ids are its own to choose finds it by that id in `put` instead.
   */
  find?(ctx: RunContext, booking: OutboundBooking): Promise<LinkState | null>;
}

/* --- getting paid (ADR-023) ------------------------------------------------ */

/** Money in minor units (cents), with its ISO 4217 code in capitals. */
export interface PayAmount {
  readonly value: number;
  readonly currency: string;
}

/**
 * A link to pay for one order, as the inbox asks for it. `ref` is the inbox's own id for the link:
 * it makes the request safe to send again (the platform's idempotency key is made from it) and comes
 * back on everything the platform says about the payment.
 */
export interface PayLinkRequest {
  readonly ref: string;
  readonly itemId: string;
  readonly amount: PayAmount;
  /** What the customer sees on the platform's page: "Sourdough and 2 more (4F2K9Q)". */
  readonly title: string;
  /** The order's six-character reference, as the business's emails give it. */
  readonly reference: string;
  /** The customer's language, for the few words the platform shows after paying. */
  readonly language: string;
  /** Shown on the platform's page once the customer paid. */
  readonly thanks: string;
  /** Shown when the link is no longer in use (the order changed, was cancelled, or paid). */
  readonly inactive: string;
  /** Where the platform says a payment changed, for platforms told per link (Mollie). */
  readonly hookUrl: string;
}

export interface PayLink {
  /** The platform's id for the link: `plink_…` (Stripe), `pl_…` (Mollie). */
  readonly externalId: string;
  /** Where the customer pays. */
  readonly url: string;
}

/** A payment as the platform confirmed it, read back with the business's own key. */
export interface PaymentFact {
  /** `paid`: the money is the business's; `failed`: this attempt did not go through and the link is spent. */
  readonly status: "paid" | "failed" | "pending";
  /** The link it was made through: the platform's id, and the inbox's own (`ref`) when the platform kept it. */
  readonly linkId: string | null;
  readonly ref: string | null;
  /** The platform's id for the payment: `pi_…`/`cs_…` (Stripe), `tr_…` (Mollie). */
  readonly paymentId: string;
  readonly amount: PayAmount | null;
  /** How it was paid, in the receipt's words (`card`, `ideal`, `bancontact`), when the platform says. */
  readonly method?: string | undefined;
  readonly paidAt?: number | undefined;
  /** The payment in the business's own dashboard: where it is refunded. */
  readonly dashboardUrl?: string | undefined;
  readonly livemode: boolean;
}

/** A request a platform sent to `POST /v1/hooks/<kind>`, as it arrived. */
export interface InboundRequest {
  readonly headers: Headers;
  /** The body exactly as sent: signatures are over these bytes. */
  readonly body: string;
  readonly query: URLSearchParams;
}

/** The link a request is about, as the inbox knows it, for a platform whose request names only ours. */
export interface KnownLink {
  readonly ref: string;
  readonly externalId: string | null;
  readonly itemId: string;
}

/** What a platform's request said, once its signature (or the platform itself) vouched for it. */
export interface InboundResult {
  /** The platform's id for what it sent, so a request sent twice is counted once. */
  readonly eventId: string;
  readonly topic: string;
  /** Read back from the platform with the business's key: never what the request body claimed. */
  readonly facts: readonly PaymentFact[];
}

export interface PaymentsHandler {
  /** Makes the link in the business's own account. Safe to call again with the same `ref`. */
  createLink(ctx: RunContext, request: PayLinkRequest): Promise<PayLink>;
  /** Stops the link taking payments: the order changed, was cancelled, or was paid another way. */
  closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void>;
  /** What happened on the link so far, asked of the platform (a webhook that never came). */
  check(ctx: RunContext, link: KnownLink): Promise<PaymentFact | null>;
  /**
   * A request the platform sent. Throws `ConnectorError("refused")` when its signature does not
   * check out. Answers null when it is not about a payment (another event, another inbox's link).
   * `lookup` finds the link a request names by the inbox's own `ref` (from the address it was sent
   * to), for platforms that send nothing signed (Mollie's per-link webhook: only an id, checked by
   * asking Mollie).
   */
  receive(
    ctx: RunContext,
    request: InboundRequest,
    lookup: (ref: string) => Promise<KnownLink | null>,
  ): Promise<InboundResult | null>;
  /** The business's own dashboard, for the owner app's "Open Stripe" link. */
  dashboardUrl(ctx: Pick<RunContext, "extra">, mode: "live" | "test"): string;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OAuthFlow {
  /** The platform's consent page for this sign-in. */
  authorizeUrl(p: { readonly redirectUri: string; readonly state: string; readonly challenge: string }): string;
  /** Turns the code the platform sent back into a connection. */
  exchange(
    ctx: ConnectContext,
    p: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
  ): Promise<Connected>;
}

export interface ConnectorDefinition {
  readonly kind: string;
  readonly title: string;
  readonly group: ConnectorGroup;
  readonly capabilities: readonly ConnectorCapability[];
  /** `form`: the owner fills in `form`; `oauth`: the owner signs in on the platform. */
  readonly auth: "form" | "oauth";
  readonly form?: z.ZodObject | undefined;
  readonly presets?: readonly ConnectorPreset[] | undefined;
  /** A few words shown above its form, when it does less than others (busy times only). */
  readonly note?: string | undefined;
  /** True when this instance can offer it; otherwise why not (an OAuth app with no client set). */
  ready?(): true | string;
  /**
   * How the gallery shows it while it is not ready: `soon` (on its way here), or `setup` (it needs
   * something on the server only its operator can give, said in `hint`, explained at `href`).
   */
  readonly whenNotReady?:
    | { readonly status: "soon" | "setup"; readonly hint?: string | undefined; readonly href?: string | undefined }
    | undefined;
  /** Checks what the owner gave against the platform, and reads what they can choose. Called on save. */
  connect?(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected>;
  readonly oauth?: OAuthFlow | undefined;
  /**
   * Reads the account's calendars and destinations again (they change). `extra`, when given, replaces
   * what the connector keeps about itself (a payment platform's webhook moved to a new address).
   */
  refresh?(ctx: RunContext): Promise<
    Pick<Connected, "account" | "calendars" | "destinations"> & {
      readonly extra?: Readonly<Record<string, unknown>> | undefined;
    }
  >;
  /**
   * Whether to read again before the usual six hours: a payment platform whose webhook names another
   * address than the inbox's own now (a business took its inbox to its own domain).
   */
  stale?(ctx: RunContext): boolean;
  /**
   * Busy times inside the window, leaving out what this inbox wrote itself (`ctx.own`). A connector
   * that could not read all of the window says how far it got (`BusyRead`).
   */
  busy?(ctx: RunContext, window: Interval): Promise<Interval[] | BusyRead>;
  readonly bookings?: BookingWriter | undefined;
  /** Pay links in the business's own account, and the platform's word that they were paid (ADR-023). */
  readonly payments?: PaymentsHandler | undefined;
  /**
   * For a connector the platform tells of payments by webhook: the events to send to
   * `POST /v1/hooks/<kind>`, so the form can say what to add by hand when the key cannot add it.
   */
  readonly hookEvents?: readonly string[] | undefined;
  /** Gives the access back on the platform, as the connection goes (best effort). */
  disconnect?(ctx: RunContext): Promise<void>;
}

/** How the owner is told of a connection by name: "iCloud" → "iCloud calendar"; "Google Calendar" stays. */
export function calendarName(name: string): string {
  const n = name.trim();
  return /calendar$/i.test(n) ? n : `${n} calendar`;
}

/* --- intervals ------------------------------------------------------------ */

/** Sorted, merged, clipped to the window, and only what has some length. */
export function mergeIntervals(intervals: readonly Interval[], window?: Interval | undefined): Interval[] {
  const clipped = intervals
    .map((i) => (window ? { start: Math.max(i.start, window.start), end: Math.min(i.end, window.end) } : i))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of clipped) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, i.end) };
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/**
 * `busy` with `spans` taken out: for a platform that answers with times and no ids, this inbox's own
 * bookings are removed by their times, so a booking never blocks the time it already holds.
 */
export function subtractIntervals(busy: readonly Interval[], spans: readonly Interval[]): Interval[] {
  const cut = mergeIntervals(spans);
  const out: Interval[] = [];
  for (const b of mergeIntervals(busy)) {
    let pieces: Interval[] = [b];
    for (const s of cut) {
      if (s.end <= b.start || s.start >= b.end) continue;
      const next: Interval[] = [];
      for (const p of pieces) {
        if (s.end <= p.start || s.start >= p.end) {
          next.push(p);
          continue;
        }
        if (s.start > p.start) next.push({ start: p.start, end: s.start });
        if (s.end < p.end) next.push({ start: s.end, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

/* --- money ---------------------------------------------------------------- */

/** ISO 4217 currencies without a minor unit (500 JPY is 500) and with three (1 KWD is 1000). */
const NO_MINOR = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_MINOR = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** How many digits a currency has after the decimal point (ISO 4217): 2 unless it says otherwise. */
export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (NO_MINOR.has(c)) return 0;
  if (THREE_MINOR.has(c)) return 3;
  return 2;
}

/** Minor units as a decimal string, the way some platforms want it: 4500 EUR → "45.00", 500 JPY → "500". */
export function decimalAmount(amount: PayAmount): string {
  const exp = currencyExponent(amount.currency);
  if (exp === 0) return String(amount.value);
  const s = String(Math.abs(amount.value)).padStart(exp + 1, "0");
  return `${amount.value < 0 ? "-" : ""}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

/** A decimal string back to minor units ("45.00" EUR → 4500), or null when it is not one. */
export function minorAmount(value: string, currency: string): number | null {
  const exp = currencyExponent(currency);
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const fraction = m[2] ?? "";
  if (fraction.length > exp && /[1-9]/.test(fraction.slice(exp))) return null;
  const minor = Number((fraction + "0".repeat(exp)).slice(0, exp) || "0");
  return whole * 10 ** exp + minor;
}
