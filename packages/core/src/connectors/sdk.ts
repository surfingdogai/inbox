import { z } from "zod";

/**
 * The connector SDK (ADR-014, ADR-015, ADR-020).
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
  | "write_bookings";

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

/** A field that is sealed by the secret box and never read back: an API key, a password. */
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
}

/** The inbox a connector works for: its origin (for links) and its business's name, zone and language. */
export interface InboxIdentity {
  readonly origin: string;
  readonly host: string;
  readonly name: string;
  readonly timezone: string;
  readonly language: string;
}

export interface ConnectContext {
  readonly http: ConnectorHttp;
  readonly now: number;
  readonly inbox: InboxIdentity;
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
  /** Keeps a changed secret (a refreshed access token) sealed, for the next run. */
  saveSecret(next: Readonly<Record<string, string>>): Promise<void>;
}

/** Milliseconds since the epoch, start inclusive, end exclusive. */
export interface Interval {
  readonly start: number;
  readonly end: number;
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
  /** True when this instance can offer it; otherwise why not (an OAuth app with no client set). */
  ready?(): true | string;
  /** Checks what the owner gave against the platform, and reads what they can choose. Called on save. */
  connect?(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected>;
  readonly oauth?: OAuthFlow | undefined;
  /** Reads the account's calendars and destinations again (they change). */
  refresh?(ctx: RunContext): Promise<Pick<Connected, "account" | "calendars" | "destinations">>;
  /** Busy times inside the window, leaving out what this inbox wrote itself (`ctx.own`). */
  busy?(ctx: RunContext, window: Interval): Promise<Interval[]>;
  readonly bookings?: BookingWriter | undefined;
  /** Gives the access back on the platform, as the connection goes (best effort). */
  disconnect?(ctx: RunContext): Promise<void>;
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
