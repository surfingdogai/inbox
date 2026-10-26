import { minorUnits } from "@surfingdog/spec";
import { z } from "zod";
import type { SourceIdentity } from "../catalogue/identity";

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
  | "pay_links"
  /**
   * The platform's products come into the inbox's catalogue (ADR-030 §3): read in pages, a full pass
   * every six hours and what changed every five minutes, deactivated (never deleted) when a full pass
   * no longer sees them. The owner's own fields (withdrawal, negotiable) are never written.
   */
  | "catalogue"
  /**
   * Orders the inbox accepts are written into the business's own shop or till and paid at its own
   * checkout (ADR-030 §2): the connector is the payment platform for its orders, so it rides on
   * `pay_links`, and its `createLink` is given the order (`PayLinkRequest.order`).
   */
  | "shop_orders"
  /**
   * The names every industry track codes against (ADR-036), each defined with its track: a property
   * system's rooms, rates and availability read into the inbox (`stay_inventory`), stays written to it
   * before they are confirmed (`write_stays`), and its word that one changed, as a hint to read again
   * (`stay_events`); a job tool that takes the requests an owner accepts (`requests_out`); services,
   * staff, hours or a menu brought in to start from (`setup_in`); a booking system's free times
   * (`availability_in`); orders sent to a till or a kitchen (`orders_out`); and its word on where one
   * stands (`status_in`).
   */
  | "stay_inventory"
  | "write_stays"
  | "stay_events"
  | "requests_out"
  | "setup_in"
  | "availability_in"
  | "orders_out"
  | "status_in";

/**
 * Where a card sits in Settings → Integrations: calendars, payments, shops; and, for the industry
 * tracks (ADR-036), property systems (`lodging`), job tools (`work`), points of sale and ordering
 * (`pos`) and booking systems (`booking`).
 */
export type ConnectorGroup = "calendars" | "payments" | "shops" | "lodging" | "work" | "pos" | "booking";

/**
 * How the owner connects (ADR-030 §5): `form`, they fill in `form` (a key, an app password); `oauth`,
 * they approve a page on the platform, or on their own store (`OAuthFlow.delivery`); `link`, nothing
 * to sign in to: the inbox makes a private link the owner pastes into another platform.
 */
export type ConnectorAuth = "form" | "oauth" | "link";

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
  /**
   * Steps on the platform, one per line, shown under the help: the rows of a key page to tick. A step
   * with `items` is a short list under its line, each as the platform names it ("Bookings: Read and Write").
   */
  readonly steps?: readonly FieldStep[] | undefined;
  /**
   * A value that works once (an invite code): after the platform refuses it, the field is emptied for a
   * new one, so the same refusal is never asked for again.
   */
  readonly once?: boolean | undefined;
  /** Taken through the API but not drawn in the form: for the few who follow the docs to it. */
  readonly hidden?: boolean | undefined;
  /** A key's placeholder for each mode, for a second connection of the other one ("rk_test_…"). */
  readonly byMode?: { readonly live: string; readonly test: string } | undefined;
  /**
   * Filled in from what the inbox knows, editable: `website` is the business's own website (Settings →
   * Business), the address a shop is most often at. Never a format the owner has to guess.
   */
  readonly prefill?: "website" | undefined;
}

/** One step on the platform: a line, or a line with a short list under it. */
export type FieldStep = string | { readonly text: string; readonly items: readonly string[] };

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
  readonly steps?: readonly FieldStep[] | undefined;
  readonly once?: boolean | undefined;
  readonly byMode?: { readonly live: string; readonly test: string } | undefined;
  /** What the inbox filled in already (`FieldHints.prefill`), for the owner to keep or change. */
  readonly value?: string | undefined;
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
  /**
   * A way that connects otherwise than the definition (ADR-030 §5): a shop connected by approving a
   * page on the store, with a way to paste its keys instead (`form`), or a key with a one-click
   * sign-in beside it (`oauth`) that needs the platform app of whoever runs the server.
   */
  readonly auth?: ConnectorAuth | undefined;
  /** This way's own readiness, when it needs something the others do not (an OAuth client). */
  ready?(): true | string;
  readonly whenNotReady?: ConnectorDefinition["whenNotReady"];
  /** The words on its one button, when they are not the definition's (`ConnectorDefinition.action`). */
  readonly action?: string | undefined;
  /** What the platform will ask, said before the owner goes there (an OAuth consent page). */
  readonly consent?: string | undefined;
  /** The words on the button that connects it again, when they are not "Connect again with <label>". */
  readonly again?: string | undefined;
}

/** What `FieldHints.prefill` names, as the inbox knows it. */
export interface Prefill {
  readonly website?: string | undefined;
}

/** The form for a connector's schema, as a preset fills it: every field the owner still has to give. */
export function describeForm(
  schema: z.ZodObject,
  preset?: ConnectorPreset | undefined,
  prefill: Prefill = {},
): FormField[] {
  const out: FormField[] = [];
  for (const [key, raw] of Object.entries(schema.shape)) {
    if (preset && key in preset.values) continue;
    const zod = raw as z.ZodType;
    const hints = { ...hintsOf(zod), ...(preset?.fields?.[key] ?? {}) } as FieldHints;
    if (hints.hidden) continue;
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
      ...(hints.steps?.length ? { steps: hints.steps } : {}),
      ...(hints.once ? { once: true } : {}),
      ...(hints.byMode ? { byMode: hints.byMode } : {}),
      ...(hints.prefill && prefill[hints.prefill] ? { value: prefill[hints.prefill] } : {}),
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
  /**
   * What is chosen until the owner chooses otherwise. `bookings`: whether confirmed bookings are added
   * from the start (absent: when the connector writes bookings); false for an account whose plan does
   * not let other apps add them, so nothing is promised that the platform will refuse.
   */
  readonly defaults: {
    readonly busy: readonly string[];
    readonly destination: string | null;
    readonly bookings?: boolean | undefined;
  };
  /**
   * One line the owner reads on the connection, in their words, when it does less than its card says:
   * "Calendly Free: busy times only". Null or absent for none; a sync's `refresh` says it again or clears it.
   */
  readonly note?: string | null | undefined;
  /**
   * A payment platform's mode: a test key makes links for test items only, and a live key for real
   * ones, so nobody is ever asked for real money for a test, nor marked paid with a test card.
   */
  readonly mode?: "live" | "test" | undefined;
  /**
   * Called once the connection is kept (`true`) or was refused after all (`false`, another of the
   * same account connected already): what the connector made on the platform for the new key is
   * kept or taken away again, and what the old one had goes only once the new one is in place (a
   * payment platform's webhook endpoints). Best effort; never throws.
   */
  readonly settle?: ((kept: boolean) => Promise<void>) | undefined;
  /**
   * What else the owner chooses once connected (ADR-030 §5), each drawn by the owner app as a chooser,
   * never a typed id: a till's location, a team member bookings go to. `value` is the default until
   * the owner chooses; a sync's `refresh` may send the options again, and a value still among them
   * is kept.
   */
  readonly choices?: readonly ConnectionChoice[] | undefined;
}

/** A line the owner app shows under a connection (`ConnectorDefinition.notes`), with where to act on it. */
export interface ConnectionNote {
  readonly text: string;
  readonly href?: string | undefined;
  /** The words of the link to `href`. */
  readonly link?: string | undefined;
}

/** One chooser the owner app draws for a connection: a till's location, a team member. */
export interface ConnectionChoice {
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly value: string | null;
  /**
   * A choice about bookings only (who takes them): a till that also takes payments draws it with its
   * booking choices, and its other choices (the location) with its payments.
   */
  readonly bookings?: boolean | undefined;
}

/**
 * What a connection cannot do for its account now, a line each saying why, in the owner's words: a
 * till whose plan takes no bookings from this way of connecting keeps its busy times and writes none.
 */
export interface Withheld {
  readonly busy_times?: string | undefined;
  readonly write_bookings?: string | undefined;
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
   * Where the platform sends what it tells this inbox, on the inbox's own public address; null when
   * the inbox does not know its address (no INBOX_PUBLIC_URL, nor an Inbox address in Settings). A
   * connector with `hooks` (ADR-030 §4) is given its connection's own address,
   * `POST /v1/hooks/<kind>/<token>`, made for it when it is first connected and kept after; a payment
   * platform without, the kind's (`POST /v1/hooks/<kind>`, ADR-023).
   */
  readonly hookUrl?: string | null | undefined;
  /**
   * Whether the platform can reach `hookUrl` now. A hosted inbox before it goes live answers only
   * its owner, so a webhook added then would fail until it does; false until then. Absent is true.
   */
  readonly hooksLive?: boolean | undefined;
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
  /** What the owner chose of the connection's `Connected.choices`, by key; null where they chose nothing. */
  readonly choices?: Readonly<Record<string, string | null>> | undefined;
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
  /**
   * Whose busy times these are, for a connection tied to one resource (a member of staff's own
   * calendar, ADR-036): the inbox's resource id. Absent: the whole business's.
   */
  readonly resourceId?: string | undefined;
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
  /** The resource it is with (a member of staff), for a system that books per person (ADR-036). */
  readonly resourceId?: string | undefined;
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

/**
 * Money in minor units of its currency's own ISO 4217 exponent (4500 is 45.00 KES, ¥4,500 JPY), with
 * its code in capitals (ADR-036).
 */
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
  /** Shown on a link that is closed (paid, the order changed or ended, or the platform disconnected): true in every case. */
  readonly inactive: string;
  /** Where the platform says a payment changed, for platforms told per link (Mollie). */
  readonly hookUrl: string;
  /**
   * For a connector with `shop_orders` only (ADR-030 §2): the order as the shop needs it to make and
   * fulfil it. Absent for a payment platform, which is told only what to ask for.
   */
  readonly order?: ShopOrder | undefined;

  /**
   * What the link is for (ADR-036): the whole of an order (`pay`, the default), or one entry of an
   * item's payment schedule — a deposit, the balance, the difference after a change. A booking's
   * links say "book" on the platform's button where it has one.
   */
  readonly purpose?: PayPurpose | undefined;
  /** The schedule entry it is for (`deposit`, `balance`), unique per item: one live link each. */
  readonly scheduleId?: string | undefined;
  /**
   * When the link stops taking payments (milliseconds): a deposit's pay window. A platform that can be
   * told at creation is (Mollie's `expiresAt`); every link is also closed by the inbox once it passes.
   */
  readonly expiresAt?: number | undefined;
}

/** What a pay link is for: an order's total, or one entry of an item's payment schedule. */
export type PayPurpose = "pay" | "deposit" | "balance" | "guarantee" | "difference";

/**
 * A card saved to hold a booking (ADR-036), asked for on the business's own payment platform with
 * nothing charged now: the business charges a no-show or a late cancellation itself, in its own
 * dashboard, under the policy the customer saw. Made when the customer opens the inbox's own link,
 * so it never expires unseen.
 */
export interface GuaranteeRequest {
  readonly ref: string;
  readonly itemId: string;
  /** The currency the business would charge in. */
  readonly currency: string;
  readonly reference: string;
  readonly language: string;
  /** Where the platform sends the customer after saving the card, and if they turn back. */
  readonly returnUrl: string;
  readonly cancelUrl: string;
  /** When the platform's page closes (30 minutes to 24 hours from now on Stripe). */
  readonly expiresAt: number;
}

/** A card hold as the platform says it stands, read back with the business's key. */
export interface GuaranteeFact {
  readonly status: "open" | "saved" | "expired";
  /** The platform's id for the customer the card was saved to: where the business charges it. */
  readonly customerId?: string | undefined;
  /** The customer in the business's own dashboard. */
  readonly dashboardUrl?: string | undefined;
  readonly livemode: boolean;
}

export interface PayLink {
  /** The platform's id for the link: `plink_…` (Stripe), `pl_…` (Mollie), a shop's order or draft id. */
  readonly externalId: string;
  /** Where the customer pays. */
  readonly url: string;
  /**
   * What the shop says the order comes to, with the tax or delivery it adds itself (ADR-030 §2). When it
   * is not what the customer accepted (`PayLinkRequest.amount`), the link is held, never sent: the
   * owner is offered to propose the shop's total, which the customer then accepts or not.
   */
  readonly total?: PayAmount | undefined;
  /** The order in the business's own shop dashboard: "Open in Shopify". */
  readonly dashboardUrl?: string | undefined;
}

/** A postal address as the inbox holds it (schema.org `PostalAddress`). */
export interface PostalAddress {
  readonly streetAddress?: string | undefined;
  readonly addressLocality?: string | undefined;
  readonly addressRegion?: string | undefined;
  readonly postalCode?: string | undefined;
  /** ISO 3166-1 alpha-2, in capitals. */
  readonly addressCountry?: string | undefined;
}

/** One line of a shop order: a product of the shop's own catalogue (`externalId`), or one of the inbox's. */
export interface ShopOrderLine {
  /** The shop's id for the product (`CatalogueProduct.externalId`), when the line is one it sent in. */
  readonly externalId: string | null;
  readonly sku: string | null;
  readonly name: string;
  readonly quantity: number;
  /** The price per unit the customer accepted, in hundredths. */
  readonly unit: PayAmount;
}

/**
 * What a shop needs to make and fulfil an order the inbox accepted (ADR-030 §2), given to `createLink`
 * of a connector with `shop_orders`. The customer's details go to the business's own shop, which is the
 * same business, and to no one else; only what fulfilling needs.
 */
export interface ShopOrder {
  /** The lines to write into the shop, at the inbox's prices. */
  readonly lines: readonly ShopOrderLine[];
  /**
   * The part of `total` the shop adds itself (tax, delivery, as it counts them), which the customer
   * accepted when the owner proposed the shop's total: never written as a line, since the shop adds it.
   * Null when there is none.
   */
  readonly charges: PayAmount | null;
  /** What the customer accepted: the lines plus `charges`. The shop's own total must come to it. */
  readonly total: PayAmount;
  readonly delivery: "pickup" | "delivery" | "digital" | null;
  /** When it is due, ISO 8601, when the order says. */
  readonly when: string | null;
  /** The business's own shop: the same controller. Never sent to any other platform. */
  readonly customer: {
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly language: string;
  };
  readonly shipping: PostalAddress | null;
  readonly billing: PostalAddress | null;
  /** The customer's own note, as they wrote it: untrusted text, to be shown as theirs and nothing else. */
  readonly note: string | null;
}

/** What a shop says became of an order it made for the inbox, read back with the business's key. */
export interface OrderFact {
  /** The order as the shop names it (`PayLink.externalId`), and the inbox's own (`ref`) when it kept it. */
  readonly linkId: string | null;
  readonly ref: string | null;
  /**
   * `fulfilled`: sent or ready; `delivered`: it reached the customer; `cancelled`: cancelled in the shop
   * (an unpaid one closes the link, and the owner decides about the order); `refunded`: money given back.
   */
  readonly state: "fulfilled" | "delivered" | "cancelled" | "refunded";
  /** When, in milliseconds since the epoch. */
  readonly at: number;
  /** For `refunded`: how much, in all. */
  readonly refunded?: PayAmount | undefined;
  /** For `fulfilled`: where it can be followed, when the shop says. */
  readonly tracking?:
    | { readonly url?: string | undefined; readonly number?: string | undefined; readonly carrier?: string | undefined }
    | undefined;
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
  /** When it was paid, for a link the inbox follows after payment (`orderState`): a shop may show old orders no more. */
  readonly paidAt?: number | null | undefined;
}

/** What a platform's request said, once its signature (or the platform itself) vouched for it. */
export interface InboundResult {
  /** The platform's id for what it sent, so a request sent twice is counted once. */
  readonly eventId: string;
  readonly topic: string;
  /** Read back from the platform with the business's key: never what the request body claimed. */
  readonly facts: readonly PaymentFact[];
}

/** What a platform says was refunded of one payment, read back with the business's key. */
export interface RefundFact {
  readonly amount: PayAmount;
  /** The platform's ids for the refunds, newest first: `re_…` (Mollie). */
  readonly refundIds: readonly string[];
}

export interface PaymentsHandler {
  /**
   * Why the platform cannot be asked for this amount in its currency, or null when it can (ADR-036):
   * the adapter converts the inbox's ISO 4217 minor units to the platform's own, from a table with a
   * test per currency, and names the reason for one it has none for. Absent: only currencies counted
   * in hundredths are asked for, as before.
   */
  currencyProblem?(amount: PayAmount): string | null;
  /** Makes the link in the business's own account. Safe to call again with the same `ref`. */
  createLink(ctx: RunContext, request: PayLinkRequest): Promise<PayLink>;
  /**
   * A page on the platform where the customer saves a card to hold a booking, nothing charged
   * (ADR-036). Only where the platform can (Stripe Checkout in `mode=setup`), and only once the owner
   * switched card holds on, which asks the key for what it needs then (`guaranteePermissions`).
   */
  createGuarantee?(
    ctx: RunContext,
    request: GuaranteeRequest,
  ): Promise<{ readonly externalId: string; readonly url: string; readonly expiresAt: number }>;
  /** Whether the card was saved, read back with the key; never what a request body claimed. */
  guaranteeFact?(ctx: RunContext, hold: { readonly externalId: string }): Promise<GuaranteeFact | null>;
  /**
   * What the key lacks to take card holds, in the platform's own names ("Checkout Sessions: Write"),
   * asked when the owner switches them on and never before: empty when it has everything.
   */
  guaranteePermissions?(ctx: RunContext): Promise<readonly string[]>;
  /** Stops the link taking payments: the order changed, was cancelled, or was paid another way. */
  closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void>;
  /**
   * What happened on the link so far, asked of the platform (a webhook that never came): every
   * payment it took, paid or failed, so a second one on the same link is seen too. Empty for none.
   */
  check(ctx: RunContext, link: KnownLink): Promise<readonly PaymentFact[]>;
  /**
   * What was refunded of a payment, asked of the platform, for a platform whose key may read it
   * (Mollie): the refund made in the dashboard marks the inbox's refund done. Absent when the key
   * cannot (Stripe's restricted key asks for no refunds).
   */
  refunded?(ctx: RunContext, payment: { readonly paymentId: string }): Promise<RefundFact | null>;
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
  /**
   * For a connector with `shop_orders`: what became of an order it made, asked of the shop (a webhook
   * that never came): fulfilled, delivered, cancelled or refunded; null while nothing happened that the
   * inbox follows. Asked for open links on each reconciliation, and for paid ones hourly until the order
   * ends.
   */
  orderState?(ctx: RunContext, link: KnownLink): Promise<OrderFact | null>;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OAuthFlow {
  /**
   * What is asked before the owner goes to the platform (ADR-030 §5): a store's address, prefilled
   * from the business's website (`FieldHints.prefill`). Drawn like a form; its values are `input`.
   */
  readonly before?: z.ZodObject | undefined;
  /**
   * How the platform hands the inbox its key: `redirect` (the default), a code on the owner's way
   * back, exchanged by `exchange`; `post`, the platform POSTs the key to `postUrl` itself, server to
   * server, before the owner comes back (WooCommerce's authorize endpoint), taken by `receivePosted`.
   */
  readonly delivery?: "redirect" | "post" | undefined;
  /**
   * The platform's consent page for this sign-in. `input` holds the `before` values; `postUrl`, for a
   * `post` flow, where the platform sends the key (`POST /v1/hooks/<kind>/authorized`).
   */
  authorizeUrl(p: {
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
    readonly input?: Readonly<Record<string, string>> | undefined;
    readonly postUrl?: string | undefined;
  }): string;
  /** Turns the code the platform sent back into a connection. */
  exchange(
    ctx: ConnectContext,
    p: {
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
      readonly input?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<Connected>;
  /**
   * For a `post` flow: the state the platform's POST carries (WooCommerce's `user_id`), so the inbox
   * finds the sign-in it belongs to before anything else is read. Null when it carries none.
   */
  postedState?(request: InboundRequest): string | null;
  /**
   * For a `post` flow: the key the platform POSTed, taken from what the POST says (its shape, its
   * permissions) without asking the platform anything: the platform is waiting for this answer, and a
   * small host may have no one free to answer another request meanwhile. The key is checked against
   * the platform on the first sync. Throws `ConnectorError` when it is not one this inbox can use.
   */
  receivePosted?(
    ctx: ConnectContext,
    request: InboundRequest,
    input: Readonly<Record<string, string>>,
  ): Promise<Connected>;
  /**
   * The account the `before` values name (a store's address), when they name one: connecting the same
   * account again on the platform's own page is then connecting again in place, given `previous` and
   * keeping the connection's own address, so what it made on the platform last time is found again.
   */
  accountOf?(input: Readonly<Record<string, string>>): string | null;
}

/* --- the catalogue (ADR-030 §3) -------------------------------------------- */

/**
 * One sellable unit as a shop sends it in: a simple product, or one variation of a product. Its barcode,
 * brand, part number, condition, page and picture (`SourceIdentity`, ADR-029) only when the shop gives
 * them: a barcode with the kind of field it came from, checked when it is stored, so one that fails the
 * check is kept for the owner to read and never published.
 */
export interface CatalogueProduct extends SourceIdentity {
  /** The shop's own id for it, stable: what the inbox keys it on (`p:<id>`, `v:<id>`, a GID). */
  readonly externalId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sku: string | null;
  /** Its price in hundredths; null when the shop gives none (the last one is kept, or it is not sold). */
  readonly price: PayAmount | null;
  /** How many are in stock, when the shop counts them; null when it does not. */
  readonly stock: number | null;
  /** On sale now (published, purchasable). False takes it off what agents are offered. */
  readonly available: boolean;
}

export interface CatalogueReader {
  /**
   * One page of products. `cursor: null` asks for the first page, and an answer with `cursor: null` is
   * the last. `since` (milliseconds) reads only what changed after it; null reads everything (a full
   * pass, after which what it did not see is deactivated).
   */
  page(
    ctx: RunContext,
    p: { readonly cursor: string | null; readonly since: number | null },
  ): Promise<{ readonly products: readonly CatalogueProduct[]; readonly cursor: string | null }>;
}

/* --- webhooks a platform sends (ADR-030 §4) -------------------------------- */

/** What a platform's signed request named, once its signature checked out: ids and a topic, never the body. */
export interface HookEvent {
  /** The platform's id for the delivery, so one sent twice is counted once. */
  readonly eventId: string;
  readonly topic: string;
  /** The ids of what it is about (an order, a product, a payment), to read back with the business's key. */
  readonly refs: readonly string[];
}

/** What reading back an event found, as the inbox applies it. */
export type HookFact =
  | { readonly kind: "payment"; readonly fact: PaymentFact }
  | { readonly kind: "order"; readonly fact: OrderFact }
  /** Products changed: read the catalogue again now (what changed since the last read). */
  | { readonly kind: "catalogue"; readonly externalIds: readonly string[] | "all" }
  /** Read busy times again now. */
  | { readonly kind: "busy" }
  /** The access was withdrawn on the platform (the app uninstalled, the key deleted): connect again. */
  | { readonly kind: "revoked" }
  /**
   * A property system says some nights changed (ADR-037 §4.5): they are read again before anything is
   * believed. Rooms by the system's own ids; all of them when absent. `to` is excluded.
   */
  | {
      readonly kind: "stay_nights";
      readonly roomIds?: readonly string[] | undefined;
      readonly from: string;
      readonly to: string;
    };

export interface HooksHandler {
  /** The topics the connector asks the platform for, when it makes its webhooks in `connect`. */
  readonly topics: readonly string[];
  /**
   * Checks the request's signature over the exact bytes received, in constant time (`hook-sign.ts` in
   * adapters), and answers what it names. Throws `ConnectorError("refused")` when the signature does
   * not check out, so nothing is written; null for a ping (a platform's test delivery). Calls nothing.
   */
  verify(ctx: RunContext, request: InboundRequest): Promise<HookEvent | null>;
  /**
   * Reads back from the platform, with the business's own key, what the event names: never what the
   * body said. Runs in a job after the platform was answered, so it may take its time; a
   * `ConnectorError` that is worth trying again (`unreachable`, `rate_limited`) is tried again.
   */
  read(ctx: RunContext, event: HookEvent): Promise<readonly HookFact[]>;
}

/* --- links the inbox serves (ADR-030 §5) ----------------------------------- */

/** A confirmed booking as a feed may show it: times and the service's name, never who booked. */
export interface FeedBooking {
  readonly itemId: string;
  readonly start: number;
  readonly end: number;
  readonly serviceName: string;
  /** Goes up whenever the booking changes (a move): an iCalendar `SEQUENCE`. */
  readonly sequence: number;
  readonly updatedAt: number;
}

export interface FeedContext {
  readonly now: number;
  readonly inbox: InboxIdentity;
  readonly extra: Readonly<Record<string, unknown>>;
  /** Confirmed bookings overlapping the window, test ones left out. Never a customer's name or address. */
  bookings(window: Interval): Promise<readonly FeedBooking[]>;
}

/** A request for a link the inbox serves, as it arrived: the part after the token (`.ics`) and its headers. */
export interface FeedRequest {
  readonly headers: Headers;
  readonly extension: string;
}

export interface FeedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A link a connection serves (`GET /v1/feeds/<kind>/<token><extension>`): a calendar of confirmed
 * bookings for another platform to import. The token is the secret; making a new link stops the old.
 */
export interface FeedServer {
  /** What the link ends in, as the owner copies it (`.ics`). */
  readonly extension: string;
  serve(ctx: FeedContext, request: FeedRequest): Promise<FeedResponse>;
}

export interface ConnectorDefinition {
  readonly kind: string;
  readonly title: string;
  readonly group: ConnectorGroup;
  readonly capabilities: readonly ConnectorCapability[];
  /**
   * `form`: the owner fills in `form`; `oauth`: the owner signs in on the platform, or approves a page
   * on their own store; `link`: the inbox makes a private link (`feed`). A preset may connect another
   * way (`ConnectorPreset.auth`).
   */
  readonly auth: ConnectorAuth;
  readonly form?: z.ZodObject | undefined;
  readonly presets?: readonly ConnectorPreset[] | undefined;
  /** A few words shown above its form, when it does less than others (busy times only). */
  readonly note?: string | undefined;
  /** The words on its one button: "Connect your shop". Default: Connect, Continue with <title>, Make a link. */
  readonly action?: string | undefined;
  /** What the platform will ask, said before the owner goes there: "Google will ask to let this inbox…". */
  readonly consent?: string | undefined;
  /** Steps on the platform after connecting, one per line: where to paste a link the inbox made. */
  readonly steps?: readonly string[] | undefined;
  /**
   * What the owner removes by hand once it is disconnected, in a line, when the platform does not let
   * the inbox remove it: "Remove the key in WooCommerce → Settings → Advanced → REST API".
   */
  readonly disconnectNote?: string | undefined;
  /**
   * What a connection in test mode is called on its row, in the platform's words: "test key" (the
   * default) for a payment platform's test key, "development store" for a shop that takes only test orders.
   */
  readonly testLabel?: string | undefined;
  /** The words on the button that connects it again, when they are not "Connect again with <label>". */
  readonly again?: string | undefined;
  /**
   * What the owner should know about a connection now, a line each under it, from what the connection
   * keeps about itself (`extra`): a shop that adds tax at checkout, an earlier key to remove. Plain
   * words, never a secret; `href` where the owner does it.
   */
  notes?(view: { readonly extra: Readonly<Record<string, unknown>>; readonly now: number }): readonly ConnectionNote[];
  /**
   * What this account cannot do now (`Withheld`), read from what the connection keeps about itself
   * (`extra`): left out of what the owner app offers, said in a line, and never run. Read again with
   * every refresh, so an account that changes plan gets it back.
   */
  withheld?(view: { readonly extra: Readonly<Record<string, unknown>> }): Withheld;
  /** A line under "Add confirmed bookings": what the platform does with them, when the owner should know. */
  readonly bookingsNote?: string | undefined;
  /** True when this instance can offer it; otherwise why not (an OAuth app with no client set). */
  ready?(): true | string;
  /**
   * Built from the platform's own documentation and not yet checked against a live account: the gallery
   * says "new" beside it, and its `note` says what that means for the owner. Removed once a first real
   * account confirms what the documentation left open.
   */
  readonly fresh?: boolean | undefined;
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
    Pick<Connected, "account" | "calendars" | "destinations" | "choices" | "note"> & {
      readonly extra?: Readonly<Record<string, unknown>> | undefined;
    }
  >;
  /**
   * Whether to read again before the usual six hours: a payment platform whose webhook names another
   * address than the inbox's own now (a business took its inbox to its own domain), or that has a link
   * waiting to be paid (`openLinks`), so a webhook removed or switched off is found within minutes.
   */
  stale?(ctx: RunContext, opts?: { readonly openLinks: boolean }): boolean;
  /**
   * Busy times inside the window, leaving out what this inbox wrote itself (`ctx.own`). A connector
   * that could not read all of the window says how far it got (`BusyRead`).
   */
  busy?(ctx: RunContext, window: Interval): Promise<Interval[] | BusyRead>;
  readonly bookings?: BookingWriter | undefined;
  /** Pay links in the business's own account, and the platform's word that they were paid (ADR-023). */
  readonly payments?: PaymentsHandler | undefined;
  /** A property system's rooms, rates and what is free (ADR-037): read into the stays cache. */
  readonly stays?: StayInventory | undefined;
  /** A property system that takes stays, written to it before anything is promised (ADR-037). */
  readonly stayWriter?: StayWriter | undefined;
  /**
   * For a payment platform: the mode a key is for, read from the form before the platform is asked
   * anything (`rk_live_…` is live), so connecting a second key of a mode already connected is
   * refused before it can touch what the first one made. Null when the form does not say.
   */
  modeOf?(input: Readonly<Record<string, string>>): "live" | "test" | null;
  /**
   * For a connector the platform tells of payments by webhook: the events to send to
   * `POST /v1/hooks/<kind>`, so the form can say what to add by hand when the key cannot add it.
   */
  readonly hookEvents?: readonly string[] | undefined;
  /** Gives the access back on the platform, as the connection goes (best effort). */
  disconnect?(ctx: RunContext): Promise<void>;
  /** Products into the inbox's catalogue (capability `catalogue`, ADR-030 §3). */
  readonly catalogue?: CatalogueReader | undefined;
  /** Webhooks the platform sends to the connection's own address (ADR-030 §4). */
  readonly hooks?: HooksHandler | undefined;
  /** A link the inbox serves for the connection (`auth: "link"`, ADR-030 §5). */
  readonly feed?: FeedServer | undefined;
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

/**
 * Every amount in this inbox is an integer count of its currency's own ISO 4217 minor unit (ADR-036):
 * 4500 KES is 45.00, 4500 JPY is ¥4,500, 4500 KWD is 4.500. A platform that counts a currency
 * otherwise (Stripe's ISK, written as hundredths) converts in its own adapter, from a table with a
 * test per currency, and refuses a currency it has no test for (`PaymentsHandler.currencyProblem`):
 * a guess is a link for a hundred times the order.
 */

/**
 * Minor units as a decimal string in `exponent` places (the currency's ISO exponent when not given),
 * the way some platforms want it: 4500 EUR → "45.00", 4500 JPY → "4500", 4500 KWD → "4.500".
 */
export function decimalAmount(amount: PayAmount, exponent?: number): string {
  const e = exponent ?? minorUnits(amount.currency) ?? 2;
  const digits = String(Math.abs(Math.trunc(amount.value)));
  const sign = amount.value < 0 ? "-" : "";
  if (e === 0) return `${sign}${digits}`;
  const s = digits.padStart(e + 1, "0");
  return `${sign}${s.slice(0, -e)}.${s.slice(-e)}`;
}

/**
 * A decimal string back to minor units of `exponent` places (2 when not given): "45.00" → 4500,
 * "45.5" → 4550, "4500" in 0 places → 4500; null when it is not one, or names a part smaller than the
 * minor unit that is not zero.
 */
export function minorAmount(value: string, exponent = 2): number | null {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[2] ?? "";
  // More places than the minor unit that are not zeros is not an amount this inbox can hold.
  if (/[1-9]/.test(fraction.slice(exponent))) return null;
  const whole = Number(m[1]) * 10 ** exponent;
  return exponent === 0 ? whole : whole + Number(fraction.padEnd(exponent, "0").slice(0, exponent));
}

/* --- property systems (ADR-037) ------------------------------------------- */

/**
 * A place to stay's own system (a channel manager or a property management system): what it says is
 * free is the truth, and a stay is written to it first, so a room is never sold twice. Built from each
 * system's public documentation, against recorded fixtures and local fakes; a system that needs a
 * partner account ships switched off (`whenNotReady: {status: "setup"}`).
 */
export interface ExternalProperty {
  readonly id: string;
  readonly name: string;
  readonly currency?: string | undefined;
  readonly timezone?: string | undefined;
}

export interface ExternalRoom {
  readonly id: string;
  readonly name: string;
  /** How many like it the system sells. */
  readonly units: number;
  readonly capacity?: { readonly adults: number; readonly children: number; readonly total: number } | undefined;
  readonly beds?: readonly { readonly type: string; readonly count: number }[] | undefined;
  /**
   * True when the system holds no price for the room on the nights it was asked about: a system whose
   * availability calls answer nothing for an unpriced room (Beds24) cannot offer it, which the owner is
   * told while mapping rooms. `rules`: it has prices, but each set by the number of guests or the length
   * or timing of a stay, which the inbox does not work out: guests ask first, and the owner confirms each
   * one. Absent: not known, or priced.
   */
  readonly unpriced?: boolean | "rules" | undefined;
  /**
   * Charges the system has set for the room besides its nightly price (a cleaning fee, a tax, a security
   * deposit, an extra every guest pays), which the inbox's quote does not include unless the owner adds
   * them in Taxes & fees: the owner is told while mapping rooms, and says they are covered before stays
   * confirm at once. Absent: none known.
   */
  readonly charges?: readonly ("cleaning" | "tax" | "deposit" | "extra")[] | undefined;
}

export interface ExternalRate {
  readonly id: string;
  readonly name: string;
  /** The room ids it prices; absent for every room. */
  readonly roomIds?: readonly string[] | undefined;
}

/** One room's night as the system said it: units free, restrictions and prices by its rate ids. */
export interface AriRow {
  readonly roomId: string;
  readonly night: string;
  readonly units: number;
  readonly closed?: boolean | undefined;
  readonly minStay?: number | undefined;
  readonly maxStay?: number | undefined;
  readonly noArrival?: boolean | undefined;
  readonly noDeparture?: boolean | undefined;
  /** Rate id → price of the night, in minor units of the property's currency. */
  readonly prices?: Readonly<Record<string, number>> | undefined;
}

export interface StayPriceQuery {
  readonly propertyId: string;
  readonly roomId: string;
  readonly rateId?: string | undefined;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly adults: number;
  readonly childrenAges: readonly number[];
}

export interface StayInventory {
  /** The properties the connection can see: the owner chooses which one is theirs. */
  properties(ctx: RunContext): Promise<ExternalProperty[]>;
  rooms(ctx: RunContext, propertyId: string): Promise<ExternalRoom[]>;
  ratePlans(ctx: RunContext, propertyId: string): Promise<ExternalRate[]>;
  /**
   * What is free night by night, for the nights from `from` up to `to` (local dates, `to` excluded).
   * A system that could not read all of it says how far it got (`until`, excluded).
   */
  ari(
    ctx: RunContext,
    propertyId: string,
    window: { readonly from: string; readonly to: string },
  ): Promise<AriRow[] | { readonly rows: readonly AriRow[]; readonly until: string }>;
  /** The system's own price for a stay, night by night; null when it gives none. */
  price?(
    ctx: RunContext,
    q: StayPriceQuery,
  ): Promise<{ readonly subtotal: PayAmount; readonly nights?: readonly { night: string; amount: number }[] } | null>;
  /** What a call cost, from the answer's headers, where the system counts credits. */
  credits?(res: ConnectorHttpResponse): { readonly remaining: number; readonly resetsInMs: number } | null;
  /** Where the owner sets the prices the inbox reads, in the system's own words: "Prices → Daily Price Rules". */
  readonly pricesAt?: string | undefined;
}

/** A stay as it is written to the property's own system. */
export interface OutboundStay {
  readonly itemId: string;
  /** The guest's reference, as on the confirmation. */
  readonly reference: string;
  /** Sent as the system's own idempotency key or reference, so a write is found again by it. */
  readonly key: string;
  readonly propertyId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: readonly {
    readonly roomId: string;
    readonly rateId?: string | undefined;
    readonly adults: number;
    readonly childrenAges: readonly number[];
    /** What the room costs, written by the inbox: a system does not price what an API writes. */
    readonly price: PayAmount;
  }[];
  /** Only once confirmed, and only to the property's own system. */
  readonly guest?:
    | { readonly name: string; readonly email?: string | undefined; readonly phone?: string | undefined }
    | undefined;
  readonly notes?: string | undefined;
  /**
   * Once confirmed: what the guest has paid in the inbox and what is left to pay at the property, as
   * amounts only, so the front desk neither charges twice nor misses a balance. Never a card or a
   * commission.
   */
  readonly amounts?: { readonly paid: PayAmount; readonly atProperty: PayAmount } | undefined;
}

export type StayWriteStatus = "hold" | "provisional" | "confirmed";

export interface StayWriter {
  /**
   * What the system's documentation says of a normal write (ADR-033 §5.3): it refuses a night it has no
   * room for (`refuses_unavailable`), or nothing says it does, so the inbox checks live, writes, and reads
   * back (`check_then_write`, with `oversold`). Absent: `check_then_write` when `oversold` is given.
   */
  readonly writeGuard?: "refuses_unavailable" | "check_then_write" | undefined;
  /**
   * How a stay waiting for what is due now keeps its room off sale on the system (ADR-033 D6): a hold
   * the system releases itself (`native_release`), a status it documents as blocking
   * (`provisional_status`), or none known yet (`none`). With `none` the adapter writes such a stay as
   * confirmed, marked as waiting, for the inbox to cancel if it is not paid; declared so the stays layer
   * can keep confirming at once to stays with nothing due now (paid at the property, or held by a card)
   * until a blocking status is tested. Absent: not declared.
   */
  readonly hold?: "native_release" | "provisional_status" | "none" | undefined;
  /** Writes the stay, or moves the one written (`link`) to these dates, rooms and status. */
  put(ctx: RunContext, stay: OutboundStay, link: LinkState | null, status: StayWriteStatus): Promise<LinkState>;
  /** Cancels it on the system: never a delete. */
  cancel(ctx: RunContext, link: LinkState): Promise<void>;
  /** The stay as the system holds it, found by our key; null when it is not there. */
  find(ctx: RunContext, stay: OutboundStay): Promise<LinkState | null>;
  /**
   * For a system that takes a stay even on a night it has no room for: its own definite word on whether
   * the stay written (`link`) left any of its nights oversold — the system's overbooking flag, or its
   * count of bookings against its rooms, as its documentation gives it. Throws when it cannot tell; the
   * inbox then promises nothing until it can. A system that refuses a full night instead leaves this out.
   */
  oversold?(ctx: RunContext, stay: OutboundStay, link: LinkState): Promise<boolean>;
  /**
   * Puts a stay back as it stood a moment ago (`stay`), after a change of ours oversold: its own bookings
   * by their ids, the nights it held then counted as its own, so another channel's booking made since
   * does not stop the stay going back to what the guest holds. The inbox reads it back with `oversold`
   * after, and tells the owner if those nights are now oversold. Absent: `put`, as confirmed.
   */
  restore?(ctx: RunContext, stay: OutboundStay, link: LinkState): Promise<LinkState>;
}

/** A connector that is a property system: rooms, rates and what is free, and stays written first. */
export type PropertySystem = { readonly stays: StayInventory } & Pick<
  ConnectorDefinition,
  "stayWriter" | "kind" | "title"
>;

/** Whether a connector is a property system. */
export function isPropertySystem(def: ConnectorDefinition | undefined): def is ConnectorDefinition & PropertySystem {
  return def?.stays !== undefined;
}
