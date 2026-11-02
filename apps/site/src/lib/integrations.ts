/**
 * What the inbox connects to, as the /inbox page's row of names and the business pages show it.
 * Only what an owner connects today with their own account, in this release (0.2.0), on a hosted
 * inbox and on their own server alike: nothing that waits on a partner programme, on the company's
 * go-ahead (apaleo, Cloudbeds, Mews, Smoobu) or on a switch only a server's operator sets.
 * test/integrations.node.test.ts reads every entry against the connectors in packages/adapters and
 * their docs.
 *
 * Every name is plain text, as its owner writes it: no logo. Stripe's terms keep its logo to checkout
 * pages, and no other owner here lets a third party show theirs without asking first.
 */

import { HOSTED_PILOT_OPEN } from "./hosted";

export type Group = "calendars" | "shops" | "stays" | "food" | "trades" | "payments";

/**
 * Where a connection stands, in the same words wherever the site lists it: the /integrations table,
 * the row of names on /inbox and on each business page, each platform's own page, and each
 * connection's doc (test/integrations.node.test.ts holds them to these words). A connection is
 * verified once it has run with a business's real account; none this release ships has yet, so each
 * is `built`, and becomes `works` in this file, with its doc, the day it has. `tested` is built and
 * has run end to end against the platform itself (its test mode, or its own software run on our own
 * machine), never yet with a business's real account: its `tested` line says what ran, where and
 * when, word for word as its doc says it. `partner` is built and waits on another company;
 * `standard`, on a standard still in draft; `rolling`, on its maker's roll-out (an assistant's, never
 * ours).
 */
export type State = "works" | "tested" | "built" | "partner" | "standard" | "rolling";

export const STATE_LABEL: Readonly<Record<State, string>> = {
  works: "Works",
  tested: "Tested against the real platform, not yet on a live account",
  built: "Built, not yet verified on a live account",
  partner: "Built, waiting for the partner",
  standard: "Built, waiting for the standard",
  rolling: "Rolling out",
};

/** From most ready to least: a page of several connections is as ready as its least ready one. */
const READINESS: readonly State[] = ["works", "rolling", "tested", "built", "partner", "standard"];
export const leastReady = (states: readonly State[]): State =>
  states.reduce<State>((a, b) => (READINESS.indexOf(b) > READINESS.indexOf(a) ? b : a), "works");

export interface Brand {
  /** Whose name it is. */
  readonly owner: string;
  /** The owner's own page on how others may use the name; null where none is published. */
  readonly guidelines: string | null;
  /** The symbol the guidelines ask for beside the first or most prominent use of the name. */
  readonly symbol?: "®";
  /** The credit line the guidelines ask for, said once under the row. */
  readonly notice?: string;
}

export interface Integration {
  readonly id: string;
  /** The name, as its owner writes it, with the generic word its owner asks for on first use. */
  readonly name: string;
  readonly group: Group;
  /** The connector it goes through: its `kind` in packages/adapters builtInConnectors(). */
  readonly connector: string;
  /** The connector's preset for it, where it has one (iCloud is a CalDAV preset). */
  readonly preset?: string;
  /** Where the owner reads how to connect it. */
  readonly href: string;
  /**
   * What it does, where that is less than the rest: a calendar's private link blocks busy times and
   * adds no bookings. Said beside the name.
   */
  readonly only?: "busy times";
  /**
   * Where it stands (STATE_LABEL): built until it has run with a business's real account, or tested
   * once it has run end to end against the platform itself.
   */
  readonly state: "works" | "tested" | "built";
  /**
   * What ran against the platform itself, where and when, said once and word for word in its doc and
   * at the foot of its page: only for a connection that is tested.
   */
  readonly tested?: string;
  readonly brand: Brand;
}

/**
 * How a connection's own doc says it has not run with a real account yet, word for word: the doc of
 * every calendar, shop, kitchen, stay, trade and payment connection that is built says it beside its
 * name, and docs/integrations.md once for them all (test/integrations.node.test.ts keeps them in
 * step); one that is tested says its `tested` line instead. It is the built state's own words
 * (STATE_LABEL.built). The assistants have a line of their own (ASSISTANTS_LINE).
 */
export const UNTRIED = "not yet verified on a live account";

/** The kinds of system the row's first line holds: every group but payments, which have a line of their own. */
export const SYSTEMS: readonly Group[] = ["calendars", "shops", "stays", "food", "trades"];

/**
 * The one line said of the connections, under them, wherever they are listed: the calendars, shops,
 * kitchens, stays, trades and payments, never the assistants or automations. It starts with the
 * built state's label. Closed, the pilot's clause gives way to what is true without it.
 */
export const untried = (pilotOpen: boolean): string =>
  pilotOpen
    ? `${STATE_LABEL.built}. We built each from its platform's documentation or the standard it follows, and tested it against a stand-in; the beta is where they first run with a business's real account.`
    : `${STATE_LABEL.built}. We built each from its platform's documentation or the standard it follows, and tested it against a stand-in.`;
export const UNTRIED_LINE = untried(HOSTED_PILOT_OPEN);

/** The same, of one platform on its own page. */
export const untriedOne = (platform: string, pilotOpen: boolean): string =>
  pilotOpen
    ? `${STATE_LABEL.built}. We built it from ${platform}'s documentation and tested it against a stand-in; the beta is where it first runs with a business's real account.`
    : `${STATE_LABEL.built}. We built it from ${platform}'s documentation and tested it against a stand-in.`;
export const untriedOf = (platform: string): string => untriedOne(platform, HOSTED_PILOT_OPEN);

/**
 * The tested state, said once under the connections where any is tested: what the label means, and
 * where each one's own line is. Never a date: each one's line has its own.
 */
export const TESTED_LINE = `${STATE_LABEL.tested}: run end to end against the platform itself, in its test mode or as its own software on our own machine. Each one's page says what ran, and when.`;

/** The notice WooCommerce's guidelines ask for near the name. */
export const WOO_NOTICE = "WooCommerce and its associated designs are trademarks of Automattic Inc.";
/** The credit Apple's guidelines ask for, in the form for use outside the U.S. */
export const APPLE_NOTICE =
  "iCloud is a trademark of Apple Inc., registered in the U.S. and other countries and regions.";

const GOOGLE = "https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/terms-and-conditions/";
const MICROSOFT = "https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general";

export const INTEGRATIONS: readonly Integration[] = [
  {
    // Through the calendar's private link, busy times only, on every inbox. Signing in with Google
    // needs a Google client on the server (Soon on a hosted inbox), so it is not what this names.
    id: "google-calendar",
    name: "Google Calendar",
    group: "calendars",
    connector: "ics",
    href: "/docs/calendars/#a-calendar-link",
    only: "busy times",
    state: "built",
    brand: { owner: "Google", guidelines: GOOGLE },
  },
  {
    // Apple asks for the generic word after its mark ("iCloud Calendar") and a credit line.
    id: "icloud",
    name: "iCloud Calendar",
    group: "calendars",
    connector: "caldav",
    preset: "icloud",
    href: "/docs/calendars/#icloud-fastmail-nextcloud-and-other-caldav-calendars",
    state: "built",
    brand: {
      owner: "Apple",
      guidelines: "https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html",
      notice: APPLE_NOTICE,
    },
  },
  {
    // Microsoft asks third parties to put "Microsoft" before the app's name the first time.
    id: "outlook",
    name: "Microsoft Outlook",
    group: "calendars",
    connector: "ics",
    preset: "outlook",
    href: "/docs/calendars/#a-calendar-link",
    only: "busy times",
    state: "built",
    brand: { owner: "Microsoft", guidelines: MICROSOFT },
  },
  {
    // Cal.com's terms allow its marks only with consent, or as its brand guidelines permit; they
    // grant none clearly, so its name only.
    id: "calcom",
    name: "Cal.com",
    group: "calendars",
    connector: "calcom",
    href: "/docs/calendars/#calcom",
    state: "built",
    brand: { owner: "Cal.com, Inc.", guidelines: "https://cal.com/brand" },
  },
  {
    id: "calendly",
    name: "Calendly",
    group: "calendars",
    connector: "calendly",
    href: "/docs/connectors/calendly/",
    state: "built",
    brand: { owner: "Calendly", guidelines: "https://calendly.com/legal/customer-terms-conditions" },
  },
  {
    // Automattic: the name in plain text, never the logo, with ® on its first or most prominent use
    // and the notice that it is theirs nearby.
    id: "woocommerce",
    name: "WooCommerce",
    group: "shops",
    connector: "woocommerce",
    href: "/docs/connectors/woocommerce/",
    state: "tested",
    tested:
      "Tested on 1 November 2026 against a real WooCommerce 11.2.1 store (WordPress 7.1, run on our own machine): connected by its Approve page and by its keys; products, variations, sale prices, stock and pictures in; stock changes followed; orders written in, one paid at the store's own checkout by bank transfer and marked paid once the shop took it as received, then completed and refunded, others cancelled from either side; tax included in prices and added at checkout; disconnected. Not yet on a business's live shop.",
    brand: {
      owner: "Automattic",
      guidelines: "https://woocommerce.com/trademark-guidelines/",
      symbol: "®",
      notice: WOO_NOTICE,
    },
  },
  {
    // Shopify: brand assets only with its written authorisation, so its name only.
    id: "shopify",
    name: "Shopify",
    group: "shops",
    connector: "shopify",
    href: "/docs/connectors/shopify/",
    state: "built",
    brand: { owner: "Shopify", guidelines: "https://www.shopify.com/brand-assets" },
  },
  {
    id: "square",
    name: "Square",
    group: "shops",
    connector: "square",
    href: "/docs/connectors/square/",
    state: "built",
    brand: { owner: "Block, Inc.", guidelines: "https://developer.squareup.com/docs/brand-guidelines" },
  },
  {
    id: "beds24",
    name: "Beds24",
    group: "stays",
    connector: "beds24",
    href: "/docs/connectors/beds24/",
    state: "built",
    brand: { owner: "Beds24", guidelines: null },
  },
  {
    id: "hostaway",
    name: "Hostaway",
    group: "stays",
    connector: "hostaway",
    href: "/docs/connectors/hostaway/",
    state: "built",
    brand: { owner: "Hostaway", guidelines: null },
  },
  {
    id: "gloriafood",
    name: "GloriaFood",
    group: "food",
    connector: "gloriafood",
    href: "/docs/ordering/#which-tills",
    state: "built",
    brand: { owner: "Oracle", guidelines: "https://www.oracle.com/legal/trademarks/" },
  },
  {
    id: "flipdish",
    name: "Flipdish",
    group: "food",
    connector: "flipdish",
    href: "/docs/ordering/#which-tills",
    state: "built",
    brand: { owner: "Flipdish", guidelines: null },
  },
  {
    id: "servicem8",
    name: "ServiceM8",
    group: "trades",
    connector: "servicem8",
    href: "/docs/job-tools/#which-tools",
    state: "built",
    brand: { owner: "ServiceM8", guidelines: "https://developer.servicem8.com/docs/addon-store-requirements" },
  },
  {
    // Stripe's Marks Usage Terms keep its logo to the part of a site about paying with it (a
    // checkout page) unless Stripe agrees: its name only.
    id: "stripe",
    name: "Stripe",
    group: "payments",
    connector: "stripe",
    href: "/docs/payments/#stripe",
    state: "tested",
    tested:
      "Tested on 1 November 2026 against Stripe's test mode, with a test secret key standing in for a restricted one (the check that refuses secret keys was set aside for the test): connected, with the inbox adding its webhook; a payment link for an accepted order; a declined card; paid, as found by the inbox's own sync, and as told by Stripe's own event, which we fetched from Stripe and passed on signed with the webhook's secret, since Stripe could not reach our machine; the link closed on cancel and on disconnect; a refund made in Stripe and recorded in the inbox. Not yet with a restricted key, a webhook Stripe delivers itself, a bank payment that clears later, or on a live account.",
    brand: { owner: "Stripe", guidelines: "https://stripe.com/legal/marks" },
  },
  {
    id: "mollie",
    name: "Mollie",
    group: "payments",
    connector: "mollie",
    href: "/docs/payments/#mollie",
    state: "built",
    brand: { owner: "Mollie", guidelines: null },
  },
];

/**
 * The assistants a customer's request reaches the inbox from, each linked to its own page on how
 * it connects and what it needs (src/lib/assistants.ts). Names only: none of their makers lets a
 * third party show the logo without asking first.
 */
export const ASSISTANT_LINKS: readonly { readonly slug: string; readonly name: string; readonly guidelines: string }[] =
  [
    { slug: "chatgpt", name: "ChatGPT", guidelines: "https://openai.com/brand/" },
    { slug: "claude", name: "Claude", guidelines: "https://www.anthropic.com/legal/trademark-guidelines" },
    { slug: "gemini", name: "Gemini", guidelines: GOOGLE },
    { slug: "microsoft-copilot", name: "Microsoft Copilot Studio", guidelines: MICROSOFT },
    { slug: "grok", name: "Grok", guidelines: "https://x.ai/legal/brand-guidelines" },
    { slug: "meta-muse", name: "Meta Muse", guidelines: "https://about.meta.com/brand/resources/meta/company-brand/" },
  ];

/**
 * What is true of the five assistants that are built (the founder, 2 November 2026), said once under
 * them wherever they are listed (the /integrations table, the row of names on /inbox,
 * /inbox/assistants). It names them, since it sits under Meta Muse, rolling out as Meta rolls out its
 * custom connectors, and "Any other agent", which works, too. What did run is said where it ran, word
 * for word (docs/mcp.md, "Tested with"): Gemini CLI and the MCP Inspector, against an inbox on our own
 * machine.
 */
export const ASSISTANTS_LINE = `ChatGPT, Claude, Gemini's app, Copilot Studio and Grok: ${STATE_LABEL.built.toLowerCase()}. The inbox serves the remote MCP server and the sign-in each one's maker documents, and none of the five has run against an inbox yet. Gemini CLI and the MCP Inspector have, against an inbox on our own machine; the MCP docs say what ran.`;

export function integration(id: string): Integration {
  const found = INTEGRATIONS.find((i) => i.id === id);
  if (!found) throw new Error(`integrations.ts has no "${id}"`);
  return found;
}

/** The credit lines a set of names needs, once each, in the row's order. */
export const noticesOf = (items: readonly Integration[]): readonly string[] => [
  ...new Set(items.flatMap((i) => (i.brand.notice ? [i.brand.notice] : []))),
];
