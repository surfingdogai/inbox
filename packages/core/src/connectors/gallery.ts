import { type ConnectorDefinition, type ConnectorGroup, describeForm, type FormField } from "./sdk";

/**
 * Settings → Integrations, as cards. A card is what the owner recognises (their calendar, Cal.com,
 * Stripe); a way is how it connects (iCloud, Google, an API key). A card whose ways are not built yet,
 * or not set up on this instance, says "Soon" and has nothing to press: never a button that goes
 * nowhere. A way that needs something only the server's operator can give says "set up", and how.
 */
export interface GalleryWay {
  readonly kind: string;
  readonly preset: string | null;
  readonly label: string;
  /** `ready`; `soon` (on its way); `setup` (needs something on the server: `hint`, `href`). */
  readonly status: "ready" | "soon" | "setup";
  readonly auth: "form" | "oauth";
  /** The fields the owner fills in (empty for a sign-in on the platform). */
  readonly form: readonly FormField[];
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

export interface GalleryCard {
  readonly id: string;
  readonly title: string;
  /** A few words: what it does here. */
  readonly line: string;
  readonly group: ConnectorGroup;
  readonly status: "ready" | "soon";
  /** Ready ways first, then the ones to come. */
  readonly ways: readonly GalleryWay[];
}

interface CardSpec {
  readonly id: string;
  readonly title: string;
  readonly line: string;
  readonly group: ConnectorGroup;
  readonly ways: readonly { readonly kind: string; readonly preset: string | null; readonly label: string }[];
}

/**
 * Every card, in the order they are shown: the calendar most businesses have first, then Cal.com, then
 * the payment platforms (ADR-023). Shops are on their way and say so; the kinds they name do not exist
 * yet, so they resolve to "Soon" until a connector registers them. Outlook is named so an Outlook
 * owner sees it is not forgotten.
 */
export const GALLERY: readonly CardSpec[] = [
  {
    id: "calendar",
    title: "Calendar",
    // Drawn from the ready ways (`calendarLine`); this is what is said when none is.
    line: "Busy times in, bookings out",
    group: "calendars",
    ways: [
      { kind: "google_calendar", preset: null, label: "Google" },
      { kind: "caldav", preset: "icloud", label: "iCloud" },
      { kind: "caldav", preset: "fastmail", label: "Fastmail" },
      { kind: "caldav", preset: "nextcloud", label: "Nextcloud" },
      { kind: "caldav", preset: "other", label: "Other" },
      { kind: "ics", preset: null, label: "Calendar link" },
      { kind: "outlook", preset: null, label: "Outlook" },
    ],
  },
  {
    id: "calcom",
    title: "Cal.com",
    line: "Busy times in, bookings out",
    group: "calendars",
    ways: [{ kind: "calcom", preset: null, label: "Cal.com" }],
  },
  {
    id: "stripe",
    title: "Stripe",
    line: "Paid into your own account",
    group: "payments",
    ways: [{ kind: "stripe", preset: null, label: "Stripe" }],
  },
  {
    id: "mollie",
    title: "Mollie",
    line: "Paid into your own account",
    group: "payments",
    ways: [{ kind: "mollie", preset: null, label: "Mollie" }],
  },
  {
    id: "shopify",
    title: "Shopify",
    line: "Orders and catalogue",
    group: "shops",
    ways: [{ kind: "shopify", preset: null, label: "Shopify" }],
  },
  {
    id: "woocommerce",
    title: "WooCommerce",
    line: "Orders and catalogue",
    group: "shops",
    ways: [{ kind: "woocommerce", preset: null, label: "WooCommerce" }],
  },
];

/** The card a connection belongs to, for its tile's state. */
export function cardOf(kind: string): string | undefined {
  return GALLERY.find((c) => c.ways.some((w) => w.kind === kind))?.id;
}

/**
 * The cards as this instance can offer them, from the connectors it registered. `hookBase` is where
 * platforms reach this inbox (`https://inbox.example.com/v1/hooks/`), for the webhook a payment
 * platform's form names.
 */
export function gallery(
  definitions: ReadonlyMap<string, ConnectorDefinition>,
  opts: { readonly hookBase?: string | null | undefined } = {},
): GalleryCard[] {
  return GALLERY.map((card) => {
    const ways = card.ways.map((w): GalleryWay => {
      const def = definitions.get(w.kind);
      const ready = def ? (def.ready ? def.ready() : true) : "not built yet";
      const preset = w.preset ? def?.presets?.find((p) => p.id === w.preset) : undefined;
      const unready = def && ready !== true ? def.whenNotReady : undefined;
      return {
        kind: w.kind,
        preset: w.preset,
        label: w.label,
        status: def && ready === true ? "ready" : (unready?.status ?? "soon"),
        auth: def?.auth ?? "form",
        form: def?.form && ready === true ? describeForm(def.form, preset) : [],
        ...((preset?.note ?? def?.note) ? { note: preset?.note ?? def?.note } : {}),
        ...(unready?.hint ? { hint: unready.hint } : {}),
        ...(unready?.href ? { href: unready.href } : {}),
        ...(def?.hookEvents && ready === true && opts.hookBase
          ? { hook: { url: `${opts.hookBase}${w.kind}`, events: def.hookEvents } }
          : {}),
        ...(def?.hookEvents && ready === true && !opts.hookBase
          ? { needs: { text: NEEDS_ADDRESS.text, href: NEEDS_ADDRESS.href } }
          : {}),
      };
    });
    const needs = ways.length > 0 && ways.every((w) => w.needs !== undefined);
    // Ready first, the rest after in the order given: what can be pressed comes first.
    const sorted = [...ways.filter((w) => w.status === "ready"), ...ways.filter((w) => w.status !== "ready")];
    return {
      id: card.id,
      title: card.title,
      line: card.id === "calendar" ? calendarLine(sorted) : needs ? NEEDS_ADDRESS.line : card.line,
      group: card.group,
      status: ways.some((w) => w.status === "ready") ? "ready" : "soon",
      ways: sorted,
    };
  });
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
    .filter((w) => w.status === "ready" && w.kind !== "ics" && w.preset !== "other")
    .map((w) => w.label);
  if (named.length === 0) return "Busy times in, bookings out";
  return `${named.slice(0, 3).join(", ")} and more`;
}
