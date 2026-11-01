/**
 * /integrations: every system the inbox works with, in one table, grouped by what it is for, and a
 * "More coming" group at the end. Each row is a name, what the inbox does with it in one short line,
 * and its state, in the words of src/lib/integrations.ts (STATE_LABEL): Built, not yet verified on a
 * live account, for a connection this release (0.2.0) ships with nothing to set but the owner's own
 * account, on a hosted inbox and on one's own server alike, until it has run with a business's real
 * account, and for Zapier and Make until a flow has run with an account of each; Tested against the
 * real platform, not yet on a live account, for one that has run end to end against the platform
 * itself (Stripe's test mode, a WooCommerce® store and a CalDAV server run on our own machine), its
 * line (`tested`) saying what ran, where and when, word for word as the doc it links to; Works, for what
 * reaches the inbox today (the assistants, any agent, n8n, which ran end to end), and for a connection
 * once it has run with one; Rolling out, for what its maker is still rolling out (Meta's
 * custom connectors for Muse); Built, waiting for the partner, for what is built and waits on another
 * company; Built, waiting for the standard, for what waits on a draft standard. Never a date. A row
 * of a connection on the /inbox row takes that connection's state, so a state is set in one place.
 * The calendar, shop, kitchen, stay, trade and payment groups (SYSTEM_GROUPS) carry the one line said
 * of their connections, under the last of them.
 *
 * test/integrations-table.node.test.ts reads every row against the connectors in packages/adapters:
 * a row that is built names connectors ready with nothing set, a row that waits names connectors that
 * are not, and every connector this release ships is in a row. Names are text, as their owners write
 * them, with the mark an owner asks for on its first use (WooCommerce®); never a logo.
 */

import { INTEGRATIONS, leastReady, type State } from "./integrations";

/** A connector a row stands for: its `kind` in builtInConnectors(), and the preset it names. */
export interface RowConnector {
  readonly kind: string;
  readonly preset?: string;
}

export interface Row {
  /** As its owner writes it, with the generic word or the mark its owner asks for. */
  readonly name: string;
  /** What the inbox does with it, in one short line. */
  readonly does: string;
  readonly state: State;
  /** Where to read more: its own page, its doc, or an assistant's page. */
  readonly href: string;
  /** The connectors it stands for, where it is one. */
  readonly connectors?: readonly RowConnector[];
  /** What ran against the platform itself, where and when, as the doc or page it links to says: tested only. */
  readonly tested?: string;
  /** An assistant's page (src/lib/assistants.ts), for a row of assistants. */
  readonly assistant?: string;
}

export interface TableGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly Row[];
}

/**
 * A connection this release ships: the state of the connections of src/lib/integrations.ts it stands
 * for (by connector and preset), the least ready of them, and built where it stands for none of them.
 */
const shipped = (name: string, does: string, href: string, connectors?: readonly RowConnector[]): Row => {
  const of = INTEGRATIONS.filter((i) => connectors?.some((c) => c.kind === i.connector && c.preset === i.preset));
  const state = of.length > 0 ? leastReady(of.map((i) => i.state)) : "built";
  const tested = of.flatMap((i) => (i.tested ? [i.tested] : [])).join(" ");
  return {
    name,
    does,
    state,
    href,
    ...(connectors ? { connectors } : {}),
    ...(state === "tested" ? { tested } : {}),
  };
};
/**
 * A connection this release ships that is on no name of the /inbox row, and has run end to end against
 * the platform itself: tested, with its line.
 */
const tested = (name: string, does: string, href: string, line: string, connectors: readonly RowConnector[]): Row => ({
  name,
  does,
  state: "tested",
  href,
  connectors,
  tested: line,
});

/** What ran of the CalDAV way that any other CalDAV server connects by, word for word as docs/calendars.md says it. */
export const CALDAV_TESTED =
  "Tested on 1 November 2026 against a real CalDAV server (Radicale 3.9, run on our own machine), connected the Other way with an app password and the server's address under More options: busy times from two calendars, with repeating events, Europe/Lisbon and America/New_York times and all-day events; bookings written, moved and removed; a read-only calendar refused for bookings; a changed password reported, then connected again in place. Not yet with iCloud's, Fastmail's or Nextcloud's own servers, nor with a server found from the email alone.";
const works = (name: string, does: string, href: string): Row => ({ name, does, state: "works", href });
const waiting = (
  state: "partner" | "standard",
  name: string,
  does: string,
  href: string,
  connectors?: readonly RowConnector[],
): Row => ({
  name,
  does,
  state,
  href,
  ...(connectors ? { connectors } : {}),
});
const assistant = (slug: string, name: string, does: string, state: State = "works"): Row => ({
  name,
  does,
  state,
  href: `/assistants/${slug}/`,
  assistant: slug,
});

/** The groups of connections a business makes, whose state the one line under them is said of: payments last. */
export const SYSTEM_GROUPS: readonly string[] = ["calendars", "shops", "restaurants", "stays", "trades", "payments"];

export const TABLE: readonly TableGroup[] = [
  {
    id: "calendars",
    title: "Calendars and bookings",
    rows: [
      shipped("Google Calendar", "Busy times, from its private link", "/integrations/calendars/", [{ kind: "ics" }]),
      shipped("iCloud Calendar", "Busy times in, bookings out", "/integrations/calendars/", [
        { kind: "caldav", preset: "icloud" },
      ]),
      shipped("Microsoft Outlook", "Busy times, from its published link", "/integrations/calendars/", [
        { kind: "ics", preset: "outlook" },
      ]),
      shipped("Fastmail and Nextcloud", "Busy times in, bookings out", "/integrations/calendars/", [
        { kind: "caldav", preset: "fastmail" },
        { kind: "caldav", preset: "nextcloud" },
      ]),
      tested(
        "Other CalDAV calendars",
        "Busy times in, bookings out",
        "/docs/calendars/#icloud-fastmail-nextcloud-and-other-caldav-calendars",
        CALDAV_TESTED,
        [{ kind: "caldav", preset: "other" }],
      ),
      shipped("Cal.com", "Busy times in, bookings out", "/integrations/calcom/", [{ kind: "calcom" }]),
      shipped("Calendly", "Busy times in; bookings out on its paid plans", "/integrations/calendly/", [
        { kind: "calendly" },
      ]),
      shipped(
        "Square Appointments",
        "Busy times in; bookings out on Appointments Plus or Premium",
        "/integrations/square/",
        [{ kind: "square" }],
      ),
      shipped(
        "Any calendar that imports a link",
        "Your confirmed bookings, never who booked",
        "/docs/connectors/calendar-link/",
        [{ kind: "ics_feed" }],
      ),
    ],
  },
  {
    id: "shops",
    title: "Shops and orders",
    rows: [
      shipped(
        "WooCommerce®",
        "Products and stock in; accepted orders go in pending, paid at your checkout",
        "/integrations/woocommerce/",
        [{ kind: "woocommerce" }],
      ),
      shipped(
        "Shopify",
        "Products in; accepted quotes and orders become draft orders, paid at your checkout",
        "/integrations/shopify/",
        [{ kind: "shopify" }],
      ),
      shipped("Square", "Items in; orders you accept paid at your Square checkout", "/integrations/square/", [
        { kind: "square" },
      ]),
      shipped(
        "A product feed, from any shop",
        "Your catalogue, from the CSV or Google feed it publishes",
        "/docs/feeds/",
      ),
    ],
  },
  {
    id: "restaurants",
    title: "Restaurants and cafés",
    rows: [
      shipped(
        "GloriaFood",
        "Your menu in, to start from; GloriaFood itself closes on 30 April 2027",
        "/integrations/gloriafood/",
        [{ kind: "gloriafood" }],
      ),
      shipped(
        "Flipdish",
        "Your menu and collection hours in; your store closed while you pause",
        "/integrations/flipdish/",
        [{ kind: "flipdish" }],
      ),
    ],
  },
  {
    id: "stays",
    title: "Places to stay",
    rows: [
      shipped("Beds24", "What is free in; each stay written there first", "/integrations/beds24/", [
        { kind: "beds24" },
      ]),
      shipped("Hostaway", "Free nights in; each booking written there first", "/integrations/hostaway/", [
        { kind: "hostaway" },
      ]),
      shipped(
        "Airbnb, Booking.com and Vrbo calendar links",
        "Nights taken there, as hints for you to check",
        "/docs/property-systems/#in-this-release",
      ),
    ],
  },
  {
    id: "trades",
    title: "Trades",
    rows: [
      shipped(
        "ServiceM8",
        "Requests you take on become jobs, with their photos; its visits block times",
        "/integrations/servicem8/",
        [{ kind: "servicem8" }],
      ),
    ],
  },
  {
    id: "payments",
    title: "Payments",
    rows: [
      shipped("Stripe", "A link to pay into your own account, for each order you accept", "/integrations/stripe/", [
        { kind: "stripe" },
      ]),
      shipped("Mollie", "A link to pay into your own account, for each order you accept", "/integrations/mollie/", [
        { kind: "mollie" },
      ]),
    ],
  },
  {
    id: "assistants",
    title: "AI assistants that reach your inbox",
    rows: [
      assistant("chatgpt", "ChatGPT", "As a connector, in developer mode on paid plans"),
      assistant("claude", "Claude", "As a custom connector, on every plan"),
      assistant("gemini", "Gemini", "As a custom app in the Gemini app"),
      assistant("microsoft-copilot", "Microsoft Copilot Studio", "As a tool of an agent you build"),
      assistant("grok", "Grok and Grok Bot", "As a custom connector on paid plans; in Grok Bot, a plugin"),
      assistant("meta-muse", "Meta Muse", "As a custom connector", "rolling"),
      works("Any other agent", "Over MCP, REST with OpenAPI, or email", "/docs/mcp/"),
    ],
  },
  {
    id: "automations",
    title: "Automations",
    rows: [
      // n8n ran end to end on 1 November 2026 (docs/webhooks.md, "n8n, Zapier and Make"); Zapier and
      // Make have not run with an account of either, so they are built until one has.
      works(
        "n8n",
        "Signed webhooks in; replies and moves back with an Automation tool key",
        "/docs/webhooks/#n8n-zapier-and-make",
      ),
      shipped("Zapier and Make", "The same signed webhooks and key", "/docs/webhooks/#n8n-zapier-and-make"),
    ],
  },
];

/**
 * The "More coming" group: built, and on once each company agrees (a partner programme, an app's
 * review, cleared terms); and UCP Lodging, built and off while its standard is a draft.
 */
export const COMING: readonly TableGroup[] = [
  {
    id: "company",
    title: "Built; on once each company agrees",
    rows: [
      waiting("partner", "apaleo", "What is free in; each stay written there first", "/docs/connectors/apaleo/", [
        { kind: "apaleo" },
      ]),
      waiting("partner", "Cloudbeds", "What is free in; each stay written there first", "/docs/connectors/cloudbeds/", [
        { kind: "cloudbeds" },
      ]),
      waiting("partner", "Mews", "What is free in; each stay written there first", "/docs/connectors/mews/", [
        { kind: "mews" },
      ]),
      waiting("partner", "Smoobu", "Free nights in; each booking written there first", "/docs/connectors/smoobu/", [
        { kind: "smoobu" },
      ]),
      waiting(
        "partner",
        "Google Calendar, signed in",
        "Bookings written into it too, once Google has checked our sign-in",
        "/docs/calendars/#google-calendar",
        [{ kind: "google_calendar" }],
      ),
      waiting(
        "partner",
        "Toast",
        "Your menu in; orders you accept written into your till",
        "/docs/ordering/#which-tills",
        [{ kind: "toast" }],
      ),
      waiting(
        "partner",
        "Lightspeed Restaurant",
        "Your menu in; orders you accept as to-go orders",
        "/docs/ordering/#which-tills",
        [{ kind: "lightspeed" }],
      ),
      waiting("partner", "Clover", "Your menu in; orders you accept as Clover orders", "/docs/ordering/#which-tills", [
        { kind: "clover" },
      ]),
      waiting(
        "partner",
        "Deliverect",
        "Orders you accept, into your Deliverect channel",
        "/docs/ordering/#which-tills",
        [{ kind: "deliverect" }],
      ),
      waiting("partner", "Jobber", "Requests you take on, on your request form", "/docs/job-tools/#which-tools", [
        { kind: "jobber" },
      ]),
      waiting(
        "partner",
        "Housecall Pro",
        "Requests you take on, as leads in your Job inbox",
        "/docs/job-tools/#which-tools",
        [{ kind: "housecallpro" }],
      ),
      waiting(
        "partner",
        "Fergus",
        "Requests you take on, as enquiries with their photos",
        "/docs/job-tools/#which-tools",
        [{ kind: "fergus" }],
      ),
    ],
  },
  {
    id: "standard",
    title: "Built; off while the standard is a draft (on your own server, `INBOX_UCP_LODGING=on`)",
    rows: [
      waiting(
        "standard",
        "UCP Lodging",
        "Stays booked from AI platforms, for rooms that confirm at once",
        "/docs/stays/#ucp-lodging-off-for-now",
      ),
    ],
  },
];

/** Every row, the "More coming" ones last. */
export const ROWS: readonly Row[] = [...TABLE, ...COMING].flatMap((g) => g.rows);
