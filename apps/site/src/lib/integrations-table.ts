/**
 * /integrations: every system the inbox works with, in one table, grouped by what it is for, and a
 * "More coming" group at the end. Each row is a name, what the inbox does with it in one short line,
 * and a status of a word or two: Works, for what this release (0.2.0) does with nothing to set but
 * the owner's own account, on a hosted inbox and on one's own server alike; Rolling out, for what its
 * maker is still rolling out (Meta's custom connectors for Muse); Coming, for what is built and waits
 * on another company, or on a standard. Never a date. The calendar, shop, kitchen, stay and trade
 * groups (SYSTEM_GROUPS) carry the one line said of their connections, under the last of them.
 *
 * test/integrations-table.node.test.ts reads every row against the connectors in packages/adapters:
 * a row that Works names connectors ready with nothing set, a row Coming names connectors that are
 * not, and every connector this release ships is in a row. Names are text, as their owners write
 * them, with the mark an owner asks for on its first use (WooCommerce®); never a logo.
 */

export type Status = "Works" | "Rolling out" | "Coming";

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
  readonly status: Status;
  /** Where to read more: its own page, its doc, or an assistant's page. */
  readonly href: string;
  /** The connectors it stands for, where it is one. */
  readonly connectors?: readonly RowConnector[];
  /** An assistant's page (src/lib/assistants.ts), for a row of assistants. */
  readonly assistant?: string;
}

export interface TableGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly Row[];
}

const works = (name: string, does: string, href: string, connectors?: readonly RowConnector[]): Row => ({
  name,
  does,
  status: "Works",
  href,
  ...(connectors ? { connectors } : {}),
});
const coming = (name: string, does: string, href: string, connectors?: readonly RowConnector[]): Row => ({
  name,
  does,
  status: "Coming",
  href,
  ...(connectors ? { connectors } : {}),
});
const assistant = (slug: string, name: string, does: string, status: Status = "Works"): Row => ({
  name,
  does,
  status,
  href: `/assistants/${slug}/`,
  assistant: slug,
});

/** The groups of systems a business runs, whose connections the one line under them is said of. */
export const SYSTEM_GROUPS: readonly string[] = ["calendars", "shops", "restaurants", "stays", "trades"];

export const TABLE: readonly TableGroup[] = [
  {
    id: "calendars",
    title: "Calendars and bookings",
    rows: [
      works("Google Calendar", "Busy times, from its private link", "/integrations/calendars/", [{ kind: "ics" }]),
      works("iCloud Calendar", "Busy times in, bookings out", "/integrations/calendars/", [
        { kind: "caldav", preset: "icloud" },
      ]),
      works("Microsoft Outlook", "Busy times, from its published link", "/integrations/calendars/", [
        { kind: "ics", preset: "outlook" },
      ]),
      works(
        "Fastmail, Nextcloud and other CalDAV calendars",
        "Busy times in, bookings out",
        "/integrations/calendars/",
        [
          { kind: "caldav", preset: "fastmail" },
          { kind: "caldav", preset: "nextcloud" },
          { kind: "caldav", preset: "other" },
        ],
      ),
      works("Cal.com", "Busy times in, bookings out", "/integrations/calcom/", [{ kind: "calcom" }]),
      works("Calendly", "Busy times in; bookings out on its paid plans", "/integrations/calendly/", [
        { kind: "calendly" },
      ]),
      works(
        "Square Appointments",
        "Busy times in; bookings out on Appointments Plus or Premium",
        "/integrations/square/",
        [{ kind: "square" }],
      ),
      works(
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
      works(
        "WooCommerce®",
        "Products and stock in; accepted orders go in pending, paid at your checkout",
        "/integrations/woocommerce/",
        [{ kind: "woocommerce" }],
      ),
      works(
        "Shopify",
        "Products in; accepted quotes and orders become draft orders, paid at your checkout",
        "/integrations/shopify/",
        [{ kind: "shopify" }],
      ),
      works("Square", "Items in; orders you accept paid at your Square checkout", "/integrations/square/", [
        { kind: "square" },
      ]),
      works(
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
      works(
        "GloriaFood",
        "Your menu in, to start from; GloriaFood itself closes on 30 April 2027",
        "/integrations/gloriafood/",
        [{ kind: "gloriafood" }],
      ),
      works(
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
      works("Beds24", "What is free in; each stay written there first", "/integrations/beds24/", [{ kind: "beds24" }]),
      works("Hostaway", "Free nights in; each booking written there first", "/integrations/hostaway/", [
        { kind: "hostaway" },
      ]),
      works(
        "Airbnb, Booking.com and Vrbo calendar links",
        "Nights taken there, as hints for you to check",
        "/docs/property-systems/#what-works-today",
      ),
    ],
  },
  {
    id: "trades",
    title: "Trades",
    rows: [
      works(
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
      works("Stripe", "A link to pay into your own account, for each order you accept", "/integrations/stripe/", [
        { kind: "stripe" },
      ]),
      works("Mollie", "A link to pay into your own account, for each order you accept", "/integrations/mollie/", [
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
      assistant("meta-muse", "Meta Muse", "As a custom connector", "Rolling out"),
      works("Any other agent", "Over MCP, REST with OpenAPI, or email", "/docs/mcp/"),
    ],
  },
  {
    id: "automations",
    title: "Automations",
    rows: [
      works("Zapier, Make and n8n", "Signed webhooks for every booking, order, quote and message", "/docs/webhooks/"),
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
      coming("apaleo", "What is free in; each stay written there first", "/docs/connectors/apaleo/", [
        { kind: "apaleo" },
      ]),
      coming("Cloudbeds", "What is free in; each stay written there first", "/docs/connectors/cloudbeds/", [
        { kind: "cloudbeds" },
      ]),
      coming("Mews", "What is free in; each stay written there first", "/docs/connectors/mews/", [{ kind: "mews" }]),
      coming("Smoobu", "Free nights in; each booking written there first", "/docs/connectors/smoobu/", [
        { kind: "smoobu" },
      ]),
      coming(
        "Google Calendar, signed in",
        "Bookings written into it too, once Google has checked our sign-in",
        "/docs/calendars/#google-calendar",
        [{ kind: "google_calendar" }],
      ),
      coming("Toast", "Your menu in; orders you accept written into your till", "/docs/ordering/#which-tills", [
        { kind: "toast" },
      ]),
      coming(
        "Lightspeed Restaurant",
        "Your menu in; orders you accept as to-go orders",
        "/docs/ordering/#which-tills",
        [{ kind: "lightspeed" }],
      ),
      coming("Clover", "Your menu in; orders you accept as Clover orders", "/docs/ordering/#which-tills", [
        { kind: "clover" },
      ]),
      coming("Deliverect", "Orders you accept, into your Deliverect channel", "/docs/ordering/#which-tills", [
        { kind: "deliverect" },
      ]),
      coming("Jobber", "Requests you take on, on your request form", "/docs/job-tools/#which-tools", [
        { kind: "jobber" },
      ]),
      coming("Housecall Pro", "Requests you take on, as leads in your Job inbox", "/docs/job-tools/#which-tools", [
        { kind: "housecallpro" },
      ]),
      coming("Fergus", "Requests you take on, as enquiries with their photos", "/docs/job-tools/#which-tools", [
        { kind: "fergus" },
      ]),
    ],
  },
  {
    id: "standard",
    title: "Built; off while the standard is a draft (on your own server, `INBOX_UCP_LODGING=on`)",
    rows: [
      coming(
        "UCP Lodging",
        "Stays booked from AI platforms, for rooms that confirm at once",
        "/docs/stays/#ucp-lodging-off-for-now",
      ),
    ],
  },
];

/** Every row, the "More coming" ones last. */
export const ROWS: readonly Row[] = [...TABLE, ...COMING].flatMap((g) => g.rows);
