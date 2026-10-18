import { type ConnectorDefinition, type ConnectorGroup, describeForm, type FormField } from "./sdk";

/**
 * Settings → Integrations, as cards. A card is what the owner recognises (Cal.com, their calendar,
 * Stripe); a way is how it connects (iCloud, Google, an API key). A card whose ways are not built yet,
 * or not set up on this instance, says "Soon" and has nothing to press: never a button that goes
 * nowhere.
 */
export interface GalleryWay {
  readonly kind: string;
  readonly preset: string | null;
  readonly label: string;
  readonly status: "ready" | "soon";
  readonly auth: "form" | "oauth";
  /** The fields the owner fills in (empty for a sign-in on the platform). */
  readonly form: readonly FormField[];
  readonly note?: string | undefined;
}

export interface GalleryCard {
  readonly id: string;
  readonly title: string;
  /** A few words: what it does here. */
  readonly line: string;
  readonly group: ConnectorGroup;
  readonly status: "ready" | "soon";
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
 * Every card, in the order they are shown. Payments and shops are on their way and say so; the
 * kinds they name do not exist yet, so they resolve to "Soon" until a connector registers them.
 */
export const GALLERY: readonly CardSpec[] = [
  {
    id: "calcom",
    title: "Cal.com",
    line: "Busy times in, bookings out",
    group: "calendars",
    ways: [{ kind: "calcom", preset: null, label: "Cal.com" }],
  },
  {
    id: "calendar",
    title: "Calendar",
    line: "Busy times in, bookings out",
    group: "calendars",
    ways: [
      { kind: "google_calendar", preset: null, label: "Google" },
      { kind: "caldav", preset: "icloud", label: "iCloud" },
      { kind: "caldav", preset: "fastmail", label: "Fastmail" },
      { kind: "caldav", preset: "nextcloud", label: "Nextcloud" },
      { kind: "caldav", preset: "other", label: "Other" },
    ],
  },
  {
    id: "stripe",
    title: "Stripe",
    line: "Payments",
    group: "payments",
    ways: [{ kind: "stripe", preset: null, label: "Stripe" }],
  },
  {
    id: "mollie",
    title: "Mollie",
    line: "Payments",
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

/** The cards as this instance can offer them, from the connectors it registered. */
export function gallery(definitions: ReadonlyMap<string, ConnectorDefinition>): GalleryCard[] {
  return GALLERY.map((card) => {
    const ways = card.ways.map((w): GalleryWay => {
      const def = definitions.get(w.kind);
      const ready = def ? (def.ready ? def.ready() : true) : "not built yet";
      const preset = w.preset ? def?.presets?.find((p) => p.id === w.preset) : undefined;
      return {
        kind: w.kind,
        preset: w.preset,
        label: w.label,
        status: def && ready === true ? "ready" : "soon",
        auth: def?.auth ?? "form",
        form: def?.form && ready === true ? describeForm(def.form, preset) : [],
        ...(preset?.note ? { note: preset.note } : {}),
      };
    });
    return {
      id: card.id,
      title: card.title,
      line: card.line,
      group: card.group,
      status: ways.some((w) => w.status === "ready") ? "ready" : "soon",
      ways,
    };
  });
}
