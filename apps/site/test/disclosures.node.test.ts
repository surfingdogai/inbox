import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  around,
  GOOGLE_LIMITED_USE,
  GOOGLE_LIMITED_USE_AROUND,
  GOOGLE_PERMISSIONS_URL,
  GOOGLE_POLICY_NAME,
  GOOGLE_POLICY_URL,
  TURNSTILE_ADDENDUM_NAME,
  TURNSTILE_ADDENDUM_URL,
  TURNSTILE_FORMS,
  TURNSTILE_NOTE,
  TURNSTILE_NOTE_AROUND,
} from "../src/lib/disclosures";

/**
 * What two other companies ask our privacy pages to say (src/lib/disclosures.ts): how an inbox uses
 * Google user data, with the Limited Use sentence, held to the scopes the Google connector really asks
 * for; and the Turnstile check on app.surfingdog.ai's forms, with Cloudflare's addendum named. And the
 * section our outreach emails link to (#outreach).
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repo(path), "utf8");
const PRIVACY = "apps/site/src/pages/privacy.astro";
const HOSTED_PRIVACY = "apps/site/src/content/hosted/privacy.md";

/** The scopes in the connector's own source, so a new one fails here before Google's review does. */
function connectorScopes(): string[] {
  const src = read("packages/adapters/src/connectors/google.ts");
  const calendar = src.match(/GOOGLE_CALENDAR_SCOPES = \[([\s\S]*?)\] as const/);
  const all = src.match(/GOOGLE_SCOPES = \[([\s\S]*?)\] as const/);
  if (!calendar?.[1] || !all?.[1]) throw new Error("the connector's scope lists moved");
  const quoted = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  // GOOGLE_SCOPES is the account's two plus every calendar scope, spread in.
  expect(all[1]).toContain("...GOOGLE_CALENDAR_SCOPES");
  return [...new Set([...quoted(all[1]), ...quoted(calendar[1])])];
}

/** One section of the privacy page, from its heading to the next one, with its spaces folded. */
function section(id: string): string {
  const page = read(PRIVACY);
  const start = page.indexOf(`id="${id}"`);
  const end = page.indexOf('<h2 class="h-section"', start + 1);
  expect(start, `the section #${id}`).toBeGreaterThan(0);
  return page.slice(start, end).replace(/\s+/g, " ");
}
const googleSection = () => section("google-h");

/** A sentence shown word for word with a name inside it as a link: the parts, then the link, in the source. */
function linkedInside(text: string, parts: { before: string; after: string }, name: string, href: string): void {
  expect(text).toContain(
    `{${parts.before}}<a class="link" href={${href}} rel="noopener">{${name}}</a>{${parts.after}}`,
  );
}

describe("Google user data, as the privacy page says it", () => {
  it("carries the Limited Use sentence word for word, with the policy linked", () => {
    expect(GOOGLE_LIMITED_USE).toBe(
      "Surfing Dog Inbox's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(GOOGLE_POLICY_URL).toBe("https://developers.google.com/terms/api-services-user-data-policy");
    // The policy's name is the link, and the sentence still reads word for word around it.
    expect(GOOGLE_LIMITED_USE_AROUND.before + GOOGLE_POLICY_NAME + GOOGLE_LIMITED_USE_AROUND.after).toBe(
      GOOGLE_LIMITED_USE,
    );
    const google = googleSection();
    linkedInside(
      google,
      { before: "GOOGLE_LIMITED_USE_AROUND.before", after: "GOOGLE_LIMITED_USE_AROUND.after" },
      "GOOGLE_POLICY_NAME",
      "GOOGLE_POLICY_URL",
    );
    expect(google).toContain("href={GOOGLE_PERMISSIONS_URL}");
    expect(GOOGLE_PERMISSIONS_URL).toBe("https://myaccount.google.com/permissions");
  });

  it("says what each scope the connector asks for is used for, and asks for nothing else", () => {
    const scopes = connectorScopes();
    expect(scopes.sort()).toEqual([
      "email",
      "https://www.googleapis.com/auth/calendar.events.owned",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "openid",
    ]);
    const google = googleSection();
    // openid + email: which account it is.
    expect(google).toContain("Which Google account it is");
    // calendar.freebusy: times only, never what an event is.
    expect(google).toContain("as start and end times only, never what an event is");
    // calendar.events.owned: what Google's consent screen says it grants, then what the inbox uses it for.
    expect(google).toContain("permission to see and change events on calendars you own, as Google's screen puts it");
    expect(google).toContain("only to add, move and remove the events it made");
    expect(google).toContain("It only ever changes events it added itself.");
  });

  it("says where it is kept, who sees it, what it is never used for, and how to take it back", () => {
    const google = googleSection();
    for (const said of [
      "kept encrypted with your inbox's own key",
      "none of it goes to our network, and no other company gets it, except the companies that host an inbox for us",
      "Nobody at Surfing Dog reads it, unless",
      "We never sell it, use it for advertising, or use it to train AI",
      // The free times are worked out from the busy times, and they leave the inbox: say so.
      "The times your inbox still offers, which leave out when you are busy, are public",
      "Search passes them on and keeps none.",
      // Giving the access back is asked of Google; the page does not promise Google always answers.
      "your inbox asks Google to take the access back at once",
      "deletes the account, the busy times and the events' ids",
      "If Google does not answer just then",
    ]) {
      expect(google, said).toContain(said);
    }
    // The calendar's time zone is read, never kept: "What it keeps" does not list it.
    const keeps = google.slice(google.indexOf("What it keeps"), google.indexOf("Who sees it"));
    expect(keeps).not.toContain("time zone");
  });

  it("is pointed to from the hosted privacy notice, as data kept for the owner", () => {
    const hosted = read(HOSTED_PRIVACY);
    expect(hosted).toContain("**Google Calendar, if you connect it**");
    expect(hosted).toContain("(/privacy/#google-h)");
    expect(hosted).toContain("which we process for you under the [processing agreement]");
  });
});

describe("the Turnstile check, as both privacy pages say it", () => {
  it("names Cloudflare's addendum, on the general page and on the hosted notice", () => {
    expect(TURNSTILE_ADDENDUM_URL).toBe("https://www.cloudflare.com/turnstile-privacy-policy/");
    expect(TURNSTILE_NOTE).toContain("Turnstile Privacy Addendum");
    expect(TURNSTILE_NOTE_AROUND.before + TURNSTILE_ADDENDUM_NAME + TURNSTILE_NOTE_AROUND.after).toBe(TURNSTILE_NOTE);
    const page = read(PRIVACY).replace(/\s+/g, " ");
    linkedInside(
      page,
      { before: "TURNSTILE_NOTE_AROUND.before", after: "TURNSTILE_NOTE_AROUND.after" },
      "TURNSTILE_ADDENDUM_NAME",
      "TURNSTILE_ADDENDUM_URL",
    );
    expect(page).toContain("{TURNSTILE_FORMS}");
    expect(page).toContain('<p id="bot-check">');
    // The hosted notice names no company (test/hosted.node.test.ts): it points to the general page,
    // which is our privacy policy and names the addendum.
    expect(read(HOSTED_PRIVACY)).toContain(
      "the addendum that describes it, are on our [privacy page](/privacy/#bot-check)",
    );
  });

  it("covers every form the check runs on, and says Cloudflare's own use of the signals", () => {
    for (const form of ["setting up or signing in to a hosted inbox", "sending us feedback", "reporting an inbox"]) {
      expect(TURNSTILE_FORMS).toContain(form);
    }
    expect(read(HOSTED_PRIVACY)).toContain(
      "runs the bot check on the forms to sign up, sign in, send feedback and report an inbox",
    );
    expect(TURNSTILE_NOTE).toContain("Cloudflare does this for us, and on its own account uses the same signals");
  });
});

describe("cutting a sentence around the name that links", () => {
  it("gives the parts on each side, and refuses a name that is missing or there twice", () => {
    expect(around("Read the Policy today.", "Policy")).toEqual({ before: "Read the ", after: " today." });
    expect(() => around("Read it today.", "Policy")).toThrow();
    expect(() => around("Policy, Policy.", "Policy")).toThrow();
  });
});

describe("the emails we write to businesses, as the privacy page says them", () => {
  it("has the #outreach section the emails link to: where the address came from, what is kept, the basis, how to stop", () => {
    const outreach = section("outreach");
    for (const said of [
      "Writing to businesses",
      "at most one more if it does not answer",
      "at an address they publish for their business on their own website, never to consumers",
      "we never buy or rent lists",
      "Basis: our legitimate interest",
      'Reply "stop"',
      "we never write again",
      "list of those we must not write to",
    ]) {
      expect(outreach, said).toContain(said);
    }
  });
});
