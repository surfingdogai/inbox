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
 */
export const HOSTED_PILOT_OPEN = false;

/** Where a business starts: the card that is prefilled from its check result. */
export const START_URL = "https://app.surfingdog.ai/start";

/** The record a business adds, as the docs and the cards show it. */
export const DEFAULT_LABEL = "inbox";

/** One sentence for the places that list ways to run the inbox. */
export const HOSTED_LINE = HOSTED_PILOT_OPEN
  ? "Or let us run it for you: free during the pilot, at an address on your own domain."
  : "There's no hosted version yet.";

/** The status list's entry for hosting (src/lib/status.ts). */
export const HOSTED_STATUS = HOSTED_PILOT_OPEN
  ? { label: "A hosted inbox on your own domain, free during the pilot", state: "live" as const }
  : { label: "A hosted inbox", state: "coming" as const };
