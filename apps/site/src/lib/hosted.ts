/**
 * The hosted pilot, in one place. While HOSTED_PILOT_OPEN is false the site says only what is true
 * today: there is no hosted inbox yet, and the waitlist stays. Nothing about the pilot is built into
 * the site: the pages under /hosted/ (src/content/hosted) are not generated, the docs page
 * "Get your agent inbox" is a draft, and every line below that depends on the switch reads the
 * closed wording.
 *
 * Switching it on is one commit, made only when the pilot works end to end, its terms are ready to
 * publish, and eu-storage is deployed (backups in the EU-jurisdiction bucket), because the open words
 * say the inbox and its backups are stored in the European Union. The commit: this constant to true,
 * `draft: false` on src/content/docs/docs/get-your-agent-inbox.md, that page in the docs sidebar
 * (astro.config.mjs), and a dated "Update:" line under the waitlist sentence in
 * src/content/blog/surfing-dog-inbox-is-open.md. test/hosted.node.test.ts fails when the first three
 * disagree, and, while open, unless the hosted terms say where the inbox and its backups are stored.
 *
 * Once it is open, every page that tells a business how to get the inbox offers the hosted inbox
 * first and running it yourself second: the /inbox hero, its points and its ways to run, the home
 * page, /install, the FAQ, the ways in on /search, how it works, the docs, the structured data and
 * llms.txt. None of them says that Surfing Dog is out of the middle of an inbox it hosts: that is
 * true only of an inbox the business runs itself. Their words are below. Each place has a function
 * that gives its words for either state, so the tests read both whichever is switched on, and a
 * constant with the words the site is built with. A null is a line the closed page does not have, or
 * a place where the closed page keeps the words written in it. The docs mark their two versions in
 * the Markdown itself (src/lib/hosted-markdown.ts).
 */
export const HOSTED_PILOT_OPEN = true;

/** Where a business starts: the card that is prefilled from its check result. */
export const START_URL = "https://app.surfingdog.ai/start";

/** The record a business adds, as the docs and the cards show it. */
export const DEFAULT_LABEL = "inbox";

/** One click that copies the open-source inbox to the business's own Cloudflare account. */
export const DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox";

/** A link a page shows: its words and where it goes. `rel` only for another company's site. */
export interface PilotLink {
  readonly label: string;
  readonly href: string;
  readonly rel?: "noopener";
}

/** The hosted pilot's own button, wherever it leads. */
const GET: PilotLink = { label: "Get your agent inbox", href: START_URL };

/**
 * The primary button of the pages a business lands on before it has an inbox (/hosted/, /try/,
 * /assistants/), while the pilot is open: the hosted inbox's start. Closed, those pages have none.
 */
export const hostedCta = (open: boolean): PilotLink | null => (open ? GET : null);
export const HOSTED_CTA = hostedCta(HOSTED_PILOT_OPEN);

/** One sentence for the places that list ways to run the inbox. */
export const HOSTED_LINE = HOSTED_PILOT_OPEN
  ? "Or let us run it for you, free, at an address on your own domain."
  : "There's no hosted version yet.";

/**
 * The status list's entry for hosting (src/lib/status.ts). It is a plain ternary, unlike the page
 * words below, because the status list reaches pages' scripts, where the bundler folds it away.
 */
export const HOSTED_STATUS = HOSTED_PILOT_OPEN
  ? { label: "A hosted inbox on your own domain, free", state: "live" as const }
  : { label: "A hosted inbox", state: "coming" as const };

/**
 * The /inbox hero while open: the hosted inbox is its lede and its first button, running it yourself
 * a quiet link after "Try it with your AI", and the pilot's terms one fine line under the buttons.
 * Closed, the hero keeps its own lede and Deploy to Cloudflare.
 */
export const hostedHero = (
  open: boolean,
): { primary: PilotLink; also: PilotLink | null; lede: string | null; note: string | null } =>
  open
    ? {
        primary: GET,
        also: { label: "Or run it yourself", href: "#run" },
        lede: "Soon your customers' AI agents will book and order for them. We host Surfing Dog Inbox for you at your own address, like inbox.yourbusiness.com: those requests come straight to you, and your rules answer the routine ones.",
        note: "Free, or Pro at $10 a month. Your inbox and its backups are stored in the European Union.",
      }
    : {
        primary: { label: "Deploy to Cloudflare", href: DEPLOY_URL, rel: "noopener" },
        also: null,
        lede: null,
        note: null,
      };
export const HOSTED_HERO = hostedHero(HOSTED_PILOT_OPEN);

/**
 * Two of the points under "Every request in one list" on /inbox, while open: where it runs, and the
 * ways in, since a hosted inbox takes no email in during the pilot. Closed, the points keep their words.
 */
export const hostedInboxPoints = (open: boolean) =>
  open
    ? {
        yours:
          "It runs on your own subdomain, hosted by us or on your own Cloudflare account or server. Customers and their agents write to you there. You can download everything it holds and leave whenever you like.",
        waysIn:
          "Agents reach you through a REST API or MCP, and by email when you run it yourself. It all lands in one list. Your own AI connects over a separate owner MCP. People who add Surfing Dog to their own AI can reach you too; you can switch that off.",
      }
    : null;
export const HOSTED_INBOX_POINTS = hostedInboxPoints(HOSTED_PILOT_OPEN);

/**
 * The ways to run, at /inbox/#run: while open the hosted card comes first, the lede says both ways in
 * one sentence, and Deploy to Cloudflare steps back to a secondary button. Closed, the lede keeps its words.
 */
export const hostedRun = (open: boolean): { lede: string | null; deployClass: string } =>
  open
    ? {
        lede: "We host it for you, or you run it on your Cloudflare account or your own server. Joining the network is optional.",
        deployClass: "btn btn-secondary",
      }
    : { lede: null, deployClass: "btn btn-primary" };
export const HOSTED_RUN = hostedRun(HOSTED_PILOT_OPEN);

/** The home page's inbox panel while open: the hosted inbox and its button, then the line to copy. */
export const hostedHome = (open: boolean) =>
  open
    ? {
        title: "Your own inbox",
        lead: { text: "We host it for you at inbox.yourbusiness.com, free.", link: GET },
        what: "Or give this to your AI to run the open-source inbox yourself. It asks before anything that costs money.",
      }
    : null;
export const HOSTED_HOME = hostedHome(HOSTED_PILOT_OPEN);

/**
 * /install while open: its head offers the hosted inbox and its button, and the line for your AI
 * follows as the other way. Closed, the page keeps its own words.
 */
export const hostedInstall = (open: boolean) =>
  open
    ? {
        title: "Your own inbox",
        lede: "We host it for you at inbox.yourbusiness.com, free.",
        cta: GET,
        promptEyebrow: "Or let your AI set it up",
      }
    : null;
export const HOSTED_INSTALL = hostedInstall(HOSTED_PILOT_OPEN);

/** Where the inbox runs, in the FAQ's answer to "Does my business move onto Surfing Dog?". */
export const hostedFaq = (open: boolean) =>
  open
    ? "where we host it for you for free, or you run it on your Cloudflare account or your own server"
    : "on your Cloudflare account or your own server (a hosted option, where we run it for you, is coming)";
export const HOSTED_FAQ = hostedFaq(HOSTED_PILOT_OPEN);

/**
 * Who is in the middle, where the inbox is said to be the business's own: the FAQ's answer and
 * llms.txt. Surfing Dog keeps nothing anyone writes only of an inbox the business runs itself; a
 * hosted one runs on our servers. Open, the promise of carried requests (ADR-025, src/lib/gateway.ts)
 * replaces "not in the middle", which a carried request would make untrue. Closed, the sentences of
 * before, word for word.
 */
export const hostedOwnership = (open: boolean) =>
  open
    ? {
        faq: "When you run it yourself, Surfing Dog never touches the money and never keeps what anyone writes; when we host it, it runs on our servers. Either way you can take all your data and leave whenever you like.",
        llms: "When the business runs it itself, Surfing Dog never touches the money and never keeps what anyone writes; when we host it, it runs on our servers. When a business allows it, we carry an assistant's request to the business's own inbox and keep only a record that it was delivered. Either way the business can download all its data and leave any time.",
      }
    : {
        faq: "Surfing Dog is not in the middle of a message, a booking, an order or a payment, and your data is in your own database, so you can leave whenever you like.",
        llms: "Installing it does not put a business on Surfing Dog: Surfing Dog is not in the middle of a message, a booking, an order or a payment, and the business can leave any time with its data, which is in its own database.",
      };
export const HOSTED_OWNERSHIP = hostedOwnership(HOSTED_PILOT_OPEN);

/**
 * The inbox's description in the structured data on / and /inbox, which search engines and AIs read
 * about it. Closed, today's words.
 */
export const hostedInboxLd = (open: boolean) =>
  open
    ? "An open-source inbox at a business's own address, hosted by Surfing Dog or run on the business's own Cloudflare account or server: people and AI agents send bookings, orders, quote requests and messages straight to the business over MCP or REST (and email, where the business runs it itself), and the business's rules answer them or pass them to a person."
    : "An open-source inbox a business runs itself, at its own address, on its own Cloudflare account or server: people and AI agents send bookings, orders, quote requests and messages straight to the business over MCP, REST or email, and the business's rules answer them or pass them to a person. Surfing Dog is not in the middle.";
export const HOSTED_INBOX_LD = hostedInboxLd(HOSTED_PILOT_OPEN);

/** A status pill on the "No door yet?" card: which entry of the status list it shows, and its words. */
export interface DoorPill {
  readonly id: string;
  readonly text: string;
}

/** The card's pills: one at least. */
type DoorPills = readonly [DoorPill, ...DoorPill[]];

/**
 * The "No door yet?" card among the ways in on /search, and the line of prices under it. While open,
 * one pill, the hosted inbox's button, and setting it up yourself as a link in the card's words.
 * Closed, the card keeps its own words, its one button and its two pills.
 */
export const hostedNoDoor = (open: boolean) =>
  open
    ? {
        pills: [{ id: "hosted", text: "Live" }] as DoorPills,
        card: {
          before: "Get the inbox at your own address, and agents write to you there. We host it for free, or",
          link: { label: "your AI sets it up", href: "/install/#prompt-h" } as PilotLink,
          after: "from one line.",
          cta: GET,
        },
        price: "Hosted inbox: free, Pro $10 a month · Self-host: free",
      }
    : {
        pills: [
          { id: "inbox", text: "Live: self-host" },
          { id: "hosted", text: "Coming: hosted" },
        ] as DoorPills,
        card: null,
        price: "Inbox: free to self-host · Hosted: coming",
      };
export const HOSTED_NO_DOOR = hostedNoDoor(HOSTED_PILOT_OPEN);

/** The first step on /how-it-works, "Pick where it runs". */
export const hostedHow = (open: boolean) =>
  open
    ? "We host it for you at your own address, for free. Or deploy it to your Cloudflare account in one click, or run it on your own server."
    : "Deploy to your own Cloudflare account in one click, or run it on your own server. We will also host it for you once that opens.";
export const HOSTED_HOW = hostedHow(HOSTED_PILOT_OPEN);

/**
 * Two cards on /how-it-works while open: where the data is, and where customers' details stay.
 * Closed, the page keeps its words.
 */
export const hostedHowData = (open: boolean) =>
  open
    ? {
        data: {
          title: "Your data stays yours",
          text: "Hosted by us, it and its backups are kept in the European Union, and you can download it any time. Run yourself, it lives on your Cloudflare account or your own server. If you join a network, it gets hourly counts and receipts, never names or messages.",
        },
        customers: "Their details stay in your own inbox, and it sends them where you tell it to, nowhere else.",
      }
    : null;
export const HOSTED_HOW_DATA = hostedHowData(HOSTED_PILOT_OPEN);

/**
 * llms.txt (astro.config.mjs): the inbox in its one-line description of the three products, where the
 * inbox runs, how to get it, and the open-source line.
 */
export const hostedLlms = (open: boolean) =>
  open
    ? {
        summary:
          "open-source software at a business's own address, hosted by us or run by the business itself, so people and agents write to the business directly",
        where: "hosted by us for free, or on its own Cloudflare account or server",
        get: `To have it hosted, a business starts at ${START_URL}; to install it, an AI follows https://surfingdog.ai/install.md.`,
        open: "We host the inbox for free, or self-host it.",
      }
    : {
        summary:
          "open-source software a business runs itself, at its own address, so people and agents write to the business directly; Surfing Dog is not in the middle",
        where: "on its Cloudflare account or its own server; a hosted option is not open yet",
        get: "To install it, an AI follows https://surfingdog.ai/install.md.",
        open: "Self-host the inbox today; a hosted inbox is not open yet.",
      };
export const HOSTED_LLMS = hostedLlms(HOSTED_PILOT_OPEN);
