/**
 * Two disclosures other companies ask us to make, in one place, word for word wherever they appear.
 * Awaiting legal review: both are drafts until the lawyer has read them, as is the privacy page's
 * section on the emails we write to businesses (#outreach), which our outreach emails link to.
 *
 * Google: an inbox that signs in with Surfing Dog Inbox's own Google client (every hosted inbox, and
 * ours) asks for the scopes in packages/adapters/src/connectors/google.ts and nothing more. Google's
 * verification of that client needs the privacy policy to say how the inbox uses Google user data,
 * and to say that it follows the Limited Use requirements of Google's API Services User Data Policy.
 * test/disclosures.node.test.ts holds the privacy page to those scopes, so a new scope cannot be
 * asked for without the page saying what it is for.
 *
 * Cloudflare Turnstile: the forms on app.surfingdog.ai (start, sign in, feedback, report) are
 * checked by it, out of sight. Its Invisible mode was taken on the condition that our privacy policy
 * names the Turnstile Privacy Addendum, which says what it reads and why.
 */

/** Google's policy, as its verification asks it to be linked. */
export const GOOGLE_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";

/** The policy's name, which is the link inside the sentence below. */
export const GOOGLE_POLICY_NAME = "Google API Services User Data Policy";

/** The sentence Google's Limited Use requirements ask for, with the app's name as Google shows it. */
export const GOOGLE_LIMITED_USE =
  "Surfing Dog Inbox's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";

/**
 * A sentence cut around the name inside it, so a page can make the name its link and still show the
 * sentence word for word: before + name + after is the sentence.
 */
export function around(sentence: string, name: string): { readonly before: string; readonly after: string } {
  const at = sentence.indexOf(name);
  if (at < 0 || sentence.indexOf(name, at + 1) >= 0) throw new Error(`"${name}" must be in the sentence once`);
  return { before: sentence.slice(0, at), after: sentence.slice(at + name.length) };
}

/** The Limited Use sentence, around the policy's name. */
export const GOOGLE_LIMITED_USE_AROUND = around(GOOGLE_LIMITED_USE, GOOGLE_POLICY_NAME);

/** Where an owner can take the access back at Google itself, as well as in their inbox. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

/** Cloudflare's own notice for Turnstile, and its name, which is the link in the sentence below. */
export const TURNSTILE_ADDENDUM_URL = "https://www.cloudflare.com/turnstile-privacy-policy/";
export const TURNSTILE_ADDENDUM_NAME = "Turnstile Privacy Addendum";

/** The forms the check runs on, in the words the pages use. */
export const TURNSTILE_FORMS =
  "setting up or signing in to a hosted inbox, sending us feedback, and reporting an inbox";

/** The sentence, on our privacy page; the hosted notice, which names no company, points to it. */
export const TURNSTILE_NOTE =
  "Cloudflare Turnstile checks these forms out of sight: it reads signals from your browser and connection, such as your IP address, your browser's name and its TLS fingerprint, to tell people from bots. Cloudflare does this for us, and on its own account uses the same signals to improve the check; its Turnstile Privacy Addendum says what it collects and why.";

/** The Turnstile sentence, around the addendum's name. */
export const TURNSTILE_NOTE_AROUND = around(TURNSTILE_NOTE, TURNSTILE_ADDENDUM_NAME);
