import {
  type ConnectorAuth,
  type ConnectorDefinition,
  type ConnectorGroup,
  type ConnectorPreset,
  describeForm,
  type FormField,
  type Prefill,
} from "./sdk";

/**
 * Settings → Integrations, as cards (ADR-022, ADR-026 §6). A card is what the owner recognises (their
 * calendar, Cal.com, Stripe, their shop); a way is how it connects (iCloud, Google, an API key, a page
 * on their own store). The rules that keep it honest:
 *
 * - **A way is ready only when its connector is registered here and says it is ready.** Nothing says
 *   "Connect" before the connector that does it is in this release.
 * - **"Soon" only for what is being built now** (`building`): a card whose connector is on its way
 *   says so and has nothing to press. Any other card or way whose connector is not registered is not
 *   shown at all: no card for what nobody is building.
 * - A way that needs something only the server's operator can give says "set up", and how.
 *
 * Card ids, kinds and presets are frozen once merged: they name connection rows and
 * `/v1/hooks/<kind>`.
 */
export interface GalleryWay {
  readonly kind: string;
  readonly preset: string | null;
  readonly label: string;
  /** `ready`; `soon` (on its way); `setup` (needs something on the server: `hint`, `href`). */
  readonly status: "ready" | "soon" | "setup";
  readonly auth: ConnectorAuth;
  /** The fields the owner fills in (empty for a sign-in on the platform, or a link). */
  readonly form: readonly FormField[];
  /** For a sign-in that asks something first (a store's address, prefilled): its fields. */
  readonly before?: readonly FormField[] | undefined;
  /** Kept under "More options" on its card: a way most people never need (pasting a shop's keys). */
  readonly advanced?: boolean | undefined;
  /** The words on its one button: Connect, Connect your shop, Continue with Google, Make a link. */
  readonly action: string;
  /** What the platform will ask, said before the owner goes there. */
  readonly consent?: string | undefined;
  /** Steps on the platform once it is made: where to paste a link. */
  readonly steps?: readonly string[] | undefined;
  readonly note?: string | undefined;
  readonly hint?: string | undefined;
  readonly href?: string | undefined;
  /**
   * For a payment platform: where it sends what it says (this inbox's own address) and which events,
   * for an owner whose key cannot add the webhook itself and adds it by hand. Absent when this inbox
   * does not know its public address.
   */
  readonly hook?: { readonly url: string; readonly events: readonly string[] } | undefined;
  /**
   * What must be in place before the form is worth filling in, and where to do it: a payment platform
   * needs this inbox's own public https address (Settings, Inbox address) to tell it of payments.
   */
  readonly needs?: { readonly text: string; readonly href: string } | undefined;
}

/** The kinds of business a card is most used by, which order the cards for an inbox (`leanOf`). */
export type Industry =
  | "all"
  | "salons"
  | "clinics"
  | "gyms"
  | "trades"
  | "stays"
  | "shops"
  | "cafes"
  | "restaurants"
  | "bakeries";

export interface GalleryCard {
  readonly id: string;
  readonly title: string;
  /** A few words: what it does here. */
  readonly line: string;
  readonly group: ConnectorGroup;
  readonly industries: readonly Industry[];
  readonly status: "ready" | "soon";
  /** Ready ways first, then the ones to come; advanced ways last. */
  readonly ways: readonly GalleryWay[];
}

/** A group of cards, as the owner app heads it. */
export interface GalleryGroup {
  readonly id: ConnectorGroup;
  readonly label: string;
}

interface WaySpec {
  readonly kind: string;
  readonly preset: string | null;
  readonly label: string;
  readonly advanced?: true;
}

interface CardSpec {
  readonly id: string;
  readonly title: string;
  readonly line: string;
  readonly group: ConnectorGroup;
  readonly industries: readonly Industry[];
  /**
   * Being built now (ADR-026 §1): until its connector is registered, the card says "Soon". Removed
   * from the card once it is; a card without it and without a registered way is not shown.
   */
  readonly building?: true;
  readonly ways: readonly WaySpec[];
}

export const GROUP_LABELS: Readonly<Record<ConnectorGroup, string>> = {
  calendars: "Calendars",
  payments: "Payments",
  shops: "Shops and tills",
  // The industry tracks' groups (ADR-032).
  lodging: "Property systems",
  work: "Job tools",
  pos: "Point of sale and ordering",
  booking: "Booking systems",
};

const APPOINTMENTS: readonly Industry[] = ["salons", "clinics", "gyms", "trades"];
const FOOD_AND_SHOPS: readonly Industry[] = ["shops", "cafes", "restaurants", "bakeries"];

/**
 * Every card, in the order they are shown within their group: the calendar most businesses have
 * first, then the booking platforms, the calendar link to share, the payment platforms (ADR-023) and
 * the shops and tills. Outlook is the calendar's published link with Outlook's own steps: busy times
 * only, which is what Outlook offers without an app of ours.
 */
export const GALLERY: readonly CardSpec[] = [
  {
    id: "calendar",
    title: "Calendar",
    // Drawn from the ready ways (`calendarLine`); this is what is said when none is.
    line: "Busy times in, bookings out",
    group: "calendars",
    industries: ["all"],
    ways: [
      { kind: "google_calendar", preset: null, label: "Google" },
      { kind: "caldav", preset: "icloud", label: "iCloud" },
      { kind: "caldav", preset: "fastmail", label: "Fastmail" },
      { kind: "caldav", preset: "nextcloud", label: "Nextcloud" },
      { kind: "caldav", preset: "other", label: "Other" },
      { kind: "ics", preset: null, label: "Calendar link" },
      { kind: "ics", preset: "outlook", label: "Outlook" },
    ],
  },
  {
    id: "calcom",
    title: "Cal.com",
    line: "Busy times in, bookings out",
    group: "calendars",
    industries: ["salons", "trades", "clinics", "gyms"],
    ways: [{ kind: "calcom", preset: null, label: "Cal.com" }],
  },
  {
    id: "calendly",
    title: "Calendly",
    line: "Busy times in, bookings out",
    group: "calendars",
    industries: ["trades", "salons", "clinics", "gyms"],
    building: true,
    ways: [{ kind: "calendly", preset: null, label: "Calendly" }],
  },
  {
    id: "ics_feed",
    title: "Calendar link to share",
    line: "Your bookings, for any calendar",
    group: "calendars",
    industries: ["stays", "all"],
    building: true,
    ways: [{ kind: "ics_feed", preset: null, label: "Calendar link to share" }],
  },
  {
    id: "stripe",
    title: "Stripe",
    line: "Paid into your own account",
    group: "payments",
    industries: ["all"],
    ways: [{ kind: "stripe", preset: null, label: "Stripe" }],
  },
  {
    id: "mollie",
    title: "Mollie",
    line: "Paid into your own account",
    group: "payments",
    industries: ["all"],
    ways: [{ kind: "mollie", preset: null, label: "Mollie" }],
  },
  {
    id: "woocommerce",
    title: "WooCommerce",
    line: "Catalogue in, paid at your checkout",
    group: "shops",
    industries: ["shops", "bakeries", "restaurants", "cafes"],
    building: true,
    ways: [
      { kind: "woocommerce", preset: null, label: "WooCommerce" },
      { kind: "woocommerce", preset: "keys", label: "Paste the keys instead", advanced: true },
    ],
  },
  {
    id: "shopify",
    title: "Shopify",
    line: "Catalogue in, quotes become orders",
    group: "shops",
    industries: ["shops", "cafes", "bakeries"],
    building: true,
    ways: [
      { kind: "shopify", preset: null, label: "Your app's keys" },
      { kind: "shopify", preset: "oauth", label: "Sign in with Shopify" },
    ],
  },
  {
    id: "square",
    title: "Square",
    line: "Bookings, catalogue and payments",
    group: "shops",
    industries: ["salons", "cafes", "restaurants", "trades", "gyms", "shops"],
    building: true,
    ways: [
      { kind: "square", preset: null, label: "Access token" },
      { kind: "square", preset: "oauth", label: "Sign in with Square" },
    ],
  },
  // Booking systems (ADR-035): a salon's own system, which takes each booking first. Each needs
  // something only the company can arrange, so each says "set up" until then.
  {
    id: "phorest",
    title: "Phorest",
    line: "Services, staff and bookings, written there first",
    group: "booking",
    industries: ["salons"],
    ways: [
      { kind: "phorest", preset: "eu", label: "Phorest (Europe)" },
      { kind: "phorest", preset: "us", label: "Phorest (Americas, Australia)" },
    ],
  },
  {
    id: "mindbody",
    title: "Mindbody",
    line: "Services, staff and bookings",
    group: "booking",
    industries: ["salons", "gyms"],
    ways: [{ kind: "mindbody", preset: null, label: "Mindbody" }],
  },
];

/** The card a connection belongs to, for its tile's state. */
export function cardOf(kind: string, preset?: string | null): string | undefined {
  const exact = GALLERY.find((c) => c.ways.some((w) => w.kind === kind && w.preset === (preset ?? null)));
  return (exact ?? GALLERY.find((c) => c.ways.some((w) => w.kind === kind)))?.id;
}

/**
 * What kind of business this inbox mostly is, from what it holds: one with services to book leans to
 * appointments, one with more products than services to a shop. Orders the groups and the cards in
 * them; it never hides one.
 */
export type Lean = "appointments" | "shop" | null;

export function leanOf(counts: { readonly services: number; readonly products: number }): Lean {
  if (counts.products > counts.services) return "shop";
  if (counts.services > 0) return "appointments";
  return null;
}

/**
 * The groups in the order this inbox sees them: a shop sees its shop and till first. A group the
 * industry tracks add (ADR-032) is shown once it has a card here: booking systems after calendars for
 * a business with services to book, any other after the rest.
 */
export function galleryGroups(lean: Lean, cards: readonly Pick<GalleryCard, "group">[] = []): GalleryGroup[] {
  const order: ConnectorGroup[] =
    lean === "shop" ? ["shops", "payments", "calendars"] : ["calendars", "payments", "shops"];
  const present = new Set(cards.map((c) => c.group));
  if (present.has("booking") && !order.includes("booking")) {
    if (lean === "shop") order.push("booking");
    else order.splice(order.indexOf("calendars") + 1, 0, "booking");
  }
  for (const g of present) if (!order.includes(g)) order.push(g);
  return order.map((id) => ({ id, label: GROUP_LABELS[id] }));
}

/**
 * The cards as this instance can offer them, from the connectors it registered. `hookBase` is where
 * platforms reach this inbox (`https://inbox.example.com/v1/hooks/`), for the webhook a payment
 * platform's form names; `prefill` what the inbox knows that a form may start from (its website).
 */
export function gallery(
  definitions: ReadonlyMap<string, ConnectorDefinition>,
  opts: {
    readonly hookBase?: string | null | undefined;
    readonly prefill?: Prefill | undefined;
    readonly lean?: Lean | undefined;
  } = {},
): GalleryCard[] {
  const out: GalleryCard[] = [];
  for (const card of GALLERY) {
    const ways: GalleryWay[] = [];
    for (const w of card.ways) {
      const way = wayOf(card, w, definitions.get(w.kind), opts);
      if (way) ways.push(way);
    }
    if (ways.length === 0) continue;
    const needs = ways.every((w) => w.needs !== undefined);
    // Ready first, the rest after in the order given, the advanced ones last: what can be pressed comes first.
    const rank = (w: GalleryWay) => (w.advanced ? 2 : w.status === "ready" ? 0 : 1);
    const sorted = ways.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i);
    const ordered = sorted.map((x) => x.w);
    out.push({
      id: card.id,
      title: card.title,
      line: card.id === "calendar" ? calendarLine(ordered) : needs ? NEEDS_ADDRESS.line : card.line,
      group: card.group,
      industries: card.industries,
      status: ordered.some((w) => w.status === "ready") ? "ready" : "soon",
      ways: ordered,
    });
  }
  const lean = opts.lean ?? null;
  if (lean === null) return out;
  // Within a group, the cards this kind of business uses most first; otherwise as listed.
  const fits = new Set<Industry>(lean === "shop" ? FOOD_AND_SHOPS : APPOINTMENTS);
  const score = (c: GalleryCard) => (c.industries.includes("all") || c.industries.some((i) => fits.has(i)) ? 0 : 1);
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.group === b.c.group ? score(a.c) - score(b.c) || a.i - b.i : a.i - b.i))
    .map((x) => x.c);
}

/** One way of a card as this instance offers it, or null when it is not shown at all. */
function wayOf(
  card: CardSpec,
  w: WaySpec,
  def: ConnectorDefinition | undefined,
  opts: { readonly hookBase?: string | null | undefined; readonly prefill?: Prefill | undefined },
): GalleryWay | null {
  const preset = w.preset ? def?.presets?.find((p) => p.id === w.preset) : undefined;
  // Not in this release (its connector, or the preset the way names): "Soon" while it is being built,
  // and not shown otherwise.
  if (!def || (w.preset && !preset)) {
    if (!card.building) return null;
    return {
      kind: w.kind,
      preset: w.preset,
      label: w.label,
      status: "soon",
      auth: "form",
      form: [],
      action: "Connect",
      ...(w.advanced ? { advanced: true } : {}),
    };
  }
  const auth: ConnectorAuth = preset?.auth ?? def.auth;
  const ready = readiness(def, preset);
  const unready = ready !== true ? (preset?.whenNotReady ?? def.whenNotReady) : undefined;
  const status: GalleryWay["status"] = ready === true ? "ready" : (unready?.status ?? "soon");
  const live = status === "ready";
  const form = auth === "form" && def.form && live ? describeForm(def.form, preset, opts.prefill) : [];
  const before =
    auth === "oauth" && def.oauth?.before && live ? describeForm(def.oauth.before, undefined, opts.prefill) : [];
  const note = preset?.note ?? def.note;
  const consent = preset?.consent ?? def.consent;
  return {
    kind: w.kind,
    preset: w.preset,
    label: w.label,
    status,
    auth,
    form,
    ...(before.length > 0 ? { before } : {}),
    ...(w.advanced ? { advanced: true } : {}),
    action: preset?.action ?? def.action ?? defaultAction(auth, w.label),
    ...(consent ? { consent } : {}),
    ...(def.steps?.length ? { steps: def.steps } : {}),
    ...(note ? { note } : {}),
    ...(unready?.hint ? { hint: unready.hint } : {}),
    ...(unready?.href ? { href: unready.href } : {}),
    ...(def.hookEvents && live && opts.hookBase
      ? { hook: { url: `${opts.hookBase}${w.kind}`, events: def.hookEvents } }
      : {}),
    ...(def.hookEvents && live && !opts.hookBase
      ? { needs: { text: NEEDS_ADDRESS.text, href: NEEDS_ADDRESS.href } }
      : {}),
  };
}

/** Whether a way can be used here: the definition's readiness, then the preset's own. */
export function readiness(def: ConnectorDefinition, preset?: ConnectorPreset | undefined): true | string {
  const first = def.ready ? def.ready() : true;
  if (first !== true) return first;
  return preset?.ready ? preset.ready() : true;
}

function defaultAction(auth: ConnectorAuth, label: string): string {
  if (auth === "link") return "Make a link";
  if (auth === "oauth") return `Continue with ${label}`;
  return "Connect";
}

/** A payment platform tells this inbox of payments at its own address, which it needs to know first. */
const NEEDS_ADDRESS = {
  line: "Needs this inbox's address first",
  text: "Stripe and Mollie tell this inbox of payments at its own https address. Add it first: Settings → General, Inbox address.",
  href: "/settings#s-app-url",
} as const;

/**
 * The calendar card says which calendars it takes, as people know them: "iCloud, Fastmail, Nextcloud
 * and more" while Google is not set up, "Google, iCloud, Fastmail and more" once it is.
 */
function calendarLine(ways: readonly GalleryWay[]): string {
  const named = ways
    .filter((w) => w.status === "ready" && !(w.kind === "ics" && w.preset === null) && w.preset !== "other")
    .map((w) => w.label);
  if (named.length === 0) return "Busy times in, bookings out";
  return `${named.slice(0, 3).join(", ")} and more`;
}
