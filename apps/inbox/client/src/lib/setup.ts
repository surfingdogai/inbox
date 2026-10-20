import { parseMajor } from "./actions";
import { minorUnitsOf } from "./currencies";
import type { ConnectorGroup, PresetKey, ProductBody, ServiceBody } from "./types";

/**
 * What the setup wizard's "What you offer" step sends, as pure functions so they run in tests on
 * both runtimes. A price is read the way the owner typed it (`parseMajor`): `45,50` is forty-five
 * fifty, never free. A price that does not read as one stops the step and says how to write it;
 * nothing is saved at 0 by mistake.
 */
export interface OfferDraft {
  readonly name: string;
  readonly minutes: string;
  readonly price: string;
}

export type OfferBodies =
  | { readonly kind: "services"; readonly bodies: readonly ServiceBody[] }
  | { readonly kind: "products"; readonly bodies: readonly ProductBody[] }
  | { readonly problem: string };

export const PRICE_HINT = "Write a price like 45,50 or 45.50.";

export function offerBodies(
  offers: readonly OfferDraft[],
  sells: "services" | "products",
  currency: string,
  /** The services are asked about for a price, not booked (agents can ask for a price and not book). */
  asked = false,
): OfferBodies {
  const wanted = offers.filter((o) => o.name.trim());
  const priced: { offer: OfferDraft; value: number | undefined }[] = [];
  for (const o of wanted) {
    const typed = o.price.trim();
    const value = typed ? parseMajor(typed, minorUnitsOf(currency)) : undefined;
    if (typed && value === undefined) return { problem: `${o.name.trim()}: ${PRICE_HINT}` };
    // A product is sold at a price: one without is not saved as free.
    if (sells === "products" && value === undefined)
      return { problem: `${o.name.trim()} needs a price. ${PRICE_HINT}` };
    priced.push({ offer: o, value });
  }
  if (sells === "services" && asked) {
    return {
      kind: "services",
      bodies: priced.map(({ offer }) => ({
        name: offer.name.trim(),
        active: true,
        price: { model: "quote" as const },
      })),
    };
  }
  if (sells === "services") {
    return {
      kind: "services",
      bodies: priced.map(({ offer, value }) => ({
        name: offer.name.trim(),
        duration_min: Math.max(5, Number(offer.minutes) || 60),
        active: true,
        ...(value !== undefined ? { price: { model: "fixed" as const, value, currency } } : {}),
      })),
    };
  }
  return {
    kind: "products",
    bodies: priced.map(({ offer, value }) => ({
      name: offer.name.trim(),
      price: { value: value ?? 0, currency },
      active: true,
    })),
  };
}

/** The address owner emails go to, as the wizard saves it: trimmed, and null when left empty. */
export function ownerEmailDoc(typed: string): { notifications: { ownerEmail: string | null } } {
  const email = typed.trim();
  return { notifications: { ownerEmail: email || null } };
}

/** What agents can do, as the wizard asks it: the same three switches as Settings. */
export interface WizardDoors {
  readonly booking: boolean;
  readonly quoteRequest: boolean;
  readonly message: boolean;
}

/**
 * The settings write the wizard's switches make (`settings.doors`): booking and messages follow
 * what the inbox holds when on (a booking still needs a service and hours), off is off; asking for
 * a price on opens it before anything is listed.
 */
export function wizardDoorsDoc(d: WizardDoors): { doors: Record<string, boolean | null> } {
  return {
    doors: {
      booking: d.booking ? null : false,
      quoteRequest: d.quoteRequest,
      message: d.message ? null : false,
    },
  };
}

/**
 * What a business runs, as the setup's first question asks it (ADR-032): each kind sets the rules to
 * start from, what agents can do to begin with, and which systems "Connect your system" shows first.
 * A later kind (a place to stay) is one more entry here.
 */
export interface SetupKind {
  readonly key: string;
  readonly label: string;
  /** One line under the chip: what kind of business it is. */
  readonly line: string;
  readonly preset: PresetKey;
  readonly doors: WizardDoors;
  /** The integration groups its businesses run their days in, shown first when connecting. */
  readonly connect: readonly ConnectorGroup[];
}

export const KINDS: readonly SetupKind[] = [
  {
    key: "appointments",
    label: "Appointments",
    line: "A salon, a clinic, a studio, classes.",
    preset: "appointments",
    doors: { booking: true, quoteRequest: true, message: true },
    connect: ["booking", "calendars"],
  },
  {
    key: "trades",
    label: "Trades and quotes",
    line: "Jobs you quote for and visits you arrange.",
    preset: "trades",
    doors: { booking: false, quoteRequest: true, message: true },
    connect: ["work", "calendars"],
  },
  {
    key: "shop",
    label: "A shop",
    line: "Things people order, to collect or to deliver.",
    preset: "shop",
    doors: { booking: false, quoteRequest: false, message: true },
    connect: ["shops", "payments"],
  },
  {
    key: "salon",
    label: "A salon or barber",
    line: "Hair, nails, beauty: staff people book by name.",
    preset: "salon",
    doors: { booking: true, quoteRequest: false, message: true },
    connect: ["booking", "calendars"],
  },
];

/** The kind of a key, if it is one. */
export function kindOf(key: string | null | undefined): SetupKind | undefined {
  return KINDS.find((k) => k.key === key);
}

/**
 * The rules to start from: the kind's, once the owner said what they run; else bookings' when agents
 * can book, requests for a price's when they can only ask.
 */
export function wizardPreset(d: WizardDoors, kind?: SetupKind | undefined): PresetKey | null {
  if (kind) return kind.preset;
  if (d.booking) return "appointments";
  if (d.quoteRequest) return "trades";
  return null;
}

/** The network a new inbox is offered at setup, switched on unless the owner says no (core `DEFAULT_NETWORK`). */
export const SETUP_NETWORK = "https://network.surfingdog.ai";

/**
 * What the wizard's last step says about joining `SETUP_NETWORK`:
 *
 * - `switch`: the switch, on unless the owner says no;
 * - `later`: only a line saying to list it once the inbox has a public https address, since a
 *   network cannot verify one at localhost, on a private address or on a port;
 * - null: nothing, when the host holds the networks (it joins a hosted inbox itself), when the inbox
 *   reports to it already, and when this is not a first setup (the wizard run again by an owner who
 *   chose already: Settings → Networks is where they switch it).
 */
export function networkOffer(
  settings: {
    readonly locked?: readonly string[] | undefined;
    readonly doc: { readonly networks: Readonly<Record<string, { readonly enabled: boolean }>> };
  },
  o: { readonly firstRun: boolean; readonly reportable: boolean },
): "switch" | "later" | null {
  if ((settings.locked ?? []).some((l) => l === "networks" || l.startsWith("networks."))) return null;
  if (!o.firstRun || settings.doc.networks[SETUP_NETWORK]?.enabled === true) return null;
  return o.reportable ? "switch" : "later";
}

/**
 * The settings write that joins it, a merge: every other network stays as it is. Listing, counts and
 * receipts; giving first-time customers a key stays off until the owner switches it on in Settings.
 */
export function joinNetworkDoc(): { networks: Record<string, { enabled: true; issue: false }> } {
  return { networks: { [SETUP_NETWORK]: { enabled: true, issue: false } } };
}
