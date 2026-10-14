/**
 * The hosted pilot, in one place. While HOSTED_PILOT_OPEN is false the site says only what is true
 * today: there is no hosted inbox yet, and the waitlist stays. Nothing about the pilot is built into
 * the site: the pages under /hosted/ (src/content/hosted) are not generated, the docs page
 * "Get your agent inbox" is a draft, and every line below that depends on the switch reads the
 * closed wording.
 *
 * Switching it on is one commit, made only when the pilot works end to end and its terms are ready
 * to publish: this constant to true, `draft: false` on src/content/docs/docs/get-your-agent-inbox.md,
 * and that page in the docs sidebar (astro.config.mjs). test/hosted.node.test.ts fails when the
 * three disagree.
 *
 * Once it is open, every page that tells a business how to get the inbox offers the hosted inbox
 * first and running it yourself second: the /inbox hero and its ways to run, the home page, /install,
 * the FAQ, the ways in on /search, how it works, the docs and llms.txt. Their words are below. Each
 * place has a function that gives its words for either state, so the tests read both whichever is
 * switched on, and a constant with the words the site is built with. A null is a line the closed
 * page does not have, or a place where the closed page keeps the words written in it. The docs mark their two versions in the Markdown itself
 * (src/lib/hosted-markdown.ts).
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

/** One sentence for the places that list ways to run the inbox. */
export const HOSTED_LINE = HOSTED_PILOT_OPEN
  ? "Or let us run it for you: free during the pilot, at an address on your own domain."
  : "There's no hosted version yet.";

/**
 * The status list's entry for hosting (src/lib/status.ts). It is a plain ternary, unlike the page
 * words below, because the status list reaches pages' scripts, where the bundler folds it away.
 */
export const HOSTED_STATUS = HOSTED_PILOT_OPEN
  ? { label: "A hosted inbox on your own domain, free during the pilot", state: "live" as const }
  : { label: "A hosted inbox", state: "coming" as const };

/** The /inbox hero: its first button, a second one while open, and a line under the lede. */
export const hostedHero = (open: boolean): { primary: PilotLink; secondary: PilotLink | null; note: string | null } =>
  open
    ? {
        primary: GET,
        secondary: { label: "Run it yourself", href: "#run" },
        note: "Or we host it for you at that address, free during the pilot. Your data is stored in the European Union.",
      }
    : { primary: { label: "Deploy to Cloudflare", href: DEPLOY_URL, rel: "noopener" }, secondary: null, note: null };
export const HOSTED_HERO = hostedHero(HOSTED_PILOT_OPEN);

/**
 * The ways to run, at /inbox/#run: while open the hosted card comes first, the lede begins with it,
 * and Deploy to Cloudflare steps back to a secondary button.
 */
export const hostedRun = (open: boolean) =>
  open
    ? { lede: "We host it for you, or you run it yourself.", deployClass: "btn btn-secondary" }
    : { lede: "", deployClass: "btn btn-primary" };
export const HOSTED_RUN = hostedRun(HOSTED_PILOT_OPEN);

/** The home page's inbox panel while open. Closed, the page keeps its own words. */
export const hostedHome = (open: boolean) =>
  open
    ? {
        title: "Get your own inbox",
        lead: { text: "We host it at your own address, free during the pilot.", link: GET },
        what: "Or give this to your AI to run the open-source inbox yourself. It asks before anything that costs money.",
      }
    : null;
export const HOSTED_HOME = hostedHome(HOSTED_PILOT_OPEN);

/** The head of /install while open. Closed, the page keeps its own words. */
export const hostedInstall = (open: boolean) =>
  open
    ? {
        title: "Get your inbox",
        lede: "We host it at your own address, free during the pilot. Or give the line below to your AI, and it sets the whole thing up on your own account or server.",
        cta: GET,
      }
    : null;
export const HOSTED_INSTALL = hostedInstall(HOSTED_PILOT_OPEN);

/** Where the inbox runs, in the FAQ's answer to "Does my business move onto Surfing Dog?". */
export const hostedFaq = (open: boolean) =>
  open
    ? "where we host it for you, free during the pilot, or you run it on your Cloudflare account or your own server"
    : "on your Cloudflare account or your own server (a hosted option, where we run it for you, is coming)";
export const HOSTED_FAQ = hostedFaq(HOSTED_PILOT_OPEN);

/**
 * The "No door yet?" card among the ways in on /search, and the line of prices under it. Closed,
 * the card keeps its own words and its one button.
 */
export const hostedNoDoor = (open: boolean) =>
  open
    ? {
        pills: [
          { id: "hosted", text: "Live: hosted" },
          { id: "inbox", text: "Live: self-host" },
        ] as const,
        card: {
          text: "Get the inbox at your own address, and agents write to you there. We host it, free during the pilot, or your AI sets it up from one line.",
          cta: GET,
          also: { label: "Or set it up yourself", href: "/install/" } as PilotLink,
        },
        price: "Hosted inbox: free during the pilot · Self-host: free",
      }
    : {
        pills: [
          { id: "inbox", text: "Live: self-host" },
          { id: "hosted", text: "Coming: hosted" },
        ] as const,
        card: null,
        price: "Inbox: free to self-host · Hosted: coming",
      };
export const HOSTED_NO_DOOR = hostedNoDoor(HOSTED_PILOT_OPEN);

/** The first step on /how-it-works, "Pick where it runs". */
export const hostedHow = (open: boolean) =>
  open
    ? "We host it for you at your own address, free during the pilot. Or deploy it to your Cloudflare account in one click, or run it on your own server."
    : "Deploy to your own Cloudflare account in one click, or run it on your own server. We will also host it for you once that opens.";
export const HOSTED_HOW = hostedHow(HOSTED_PILOT_OPEN);

/** llms.txt (astro.config.mjs): where the inbox runs, how to get it, and the open-source line. */
export const hostedLlms = (open: boolean) =>
  open
    ? {
        where: "hosted by us, free during the pilot, or on its own Cloudflare account or server",
        get: `To have it hosted, a business starts at ${START_URL}; to install it, an AI follows https://surfingdog.ai/install.md.`,
        open: "We host the inbox, free during the pilot, or self-host it.",
      }
    : {
        where: "on its Cloudflare account or its own server; a hosted option is not open yet",
        get: "To install it, an AI follows https://surfingdog.ai/install.md.",
        open: "Self-host the inbox today; a hosted inbox is not open yet.",
      };
export const HOSTED_LLMS = hostedLlms(HOSTED_PILOT_OPEN);
