import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type App, AppContext } from "../src/context";
import type { PhoneAsk } from "../src/lib/client";
import { Connect, standing, whyNot } from "../src/screens/Connect";
import { PhoneAskSheet, Waiting } from "../src/screens/Settings";

/**
 * The screens of signing in with an email code and of a phone that confirms a phone (ADR-028
 * Amendment 4), drawn as the app first draws them: what they say, and nothing more than they need.
 */
const ACTIVE = {
  alias: "ib_1",
  origin: "https://inbox.oficinamare.pt",
  name: "Oficina Maré",
  deviceId: "d1",
  addedAt: 0,
};
const app = {
  native: { platform: "android", deviceSecure: async () => true },
  me: { business: { name: "Oficina Maré", timezone: "Europe/Lisbon" } },
  active: ACTIVE,
  inboxes: [ACTIVE],
  clientFor: () => ({}),
  account: { pending: async () => null },
} as unknown as App;

const draw = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(AppContext.Provider, { value: app }, el)).replace(/<!-- -->/g, "");

const ask = (wait: string | null): PhoneAsk => ({
  id: "d7",
  match: "47",
  wait_until: wait,
  phone: { id: "d7", name: "Galaxy A15", created_at: "", last_seen_at: null, push: "off" },
});

describe("signing in with email, on the phone", () => {
  it("asks for the address only, and says a code comes", () => {
    const html = draw(createElement(Connect, { canGoBack: false, allowLocal: false, start: "email" }));
    expect(html).toContain("Sign in with email");
    expect(html).toContain("We&#x27;ll send a code to the address you sign in to your inbox with.");
    expect(html).toContain("Send my code");
    // One field: the email. No password, no inbox address, no code to copy from elsewhere yet.
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('placeholder="you@example.com"');
    // An inbox on the owner's own server is chosen here, before anything goes to Surfing Dog.
    expect(html).toContain("My inbox is on my own server");
  });

  it("opens on signing in with email, with the computer's code beside it, and the camera only when chosen", () => {
    const html = draw(createElement(Connect, { canGoBack: false, allowLocal: false }));
    expect(html.indexOf("Sign in with email")).toBeLessThan(html.indexOf("Scan a code from your computer"));
    expect(html).toMatch(/class="btn primary"[^>]*>Sign in with email</);
    expect(html).toContain("No computer needed.");
    expect(html).not.toContain("<video");
    expect(html).toContain("Try the demo");
    const camera = draw(createElement(Connect, { canGoBack: false, allowLocal: false, start: "scan" }));
    expect(camera).toContain("Scan the code");
    expect(camera).toContain("Sign in with email instead");
  });

  it("types the code only as a fallback, marked as a one-time code, and never says an email went when none may have", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Connect.tsx"), "utf8");
    expect(source).toContain('autoComplete="one-time-code"');
    expect(source).toContain("Reading it on another device? Type its code:");
    expect(source).toContain("I don't have my other phone");
    // The label on screen is the field's name: nothing else stands in for it.
    expect(source).not.toContain('aria-label="The code from the email"');
    expect(source).not.toContain("Open the email we sent");
    expect(source).toContain("has an inbox with us, we've sent it a code");
    expect(source).toContain("Nothing? Check your spam folder.");
    expect(source).toContain("To add another, sign in again.");
    expect(source).toContain(["aria-label={`Open $", "{i.name}`}"].join(""));
  });
});

describe("an inbox that did not open on the phone", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Connect.tsx"), "utf8");
  const choose = source.slice(
    source.indexOf('if (step === "choose" && granted)'),
    source.indexOf('if (step === "code"'),
  );

  it("offers Try again with the same sign-in when asking again could open it, and says the error once", () => {
    expect(choose).toMatch(/again &&[\s\S]*onClick=\{\(\) => open\(only\)\}[\s\S]*"Try again"/);
    // The reason is said only when the inbox itself takes no phone: never beside the error.
    expect(choose).toContain("{!can && <p>");
    expect(source).not.toContain("Try again later");
    expect(standing({ code: "network" })).toBe(false);
    expect(standing({ code: "unreachable" })).toBe(false);
    for (const code of ["phone_paused", "not_owner", "closed", "grant"]) expect(standing({ code })).toBe(true);
  });

  it("says why an inbox takes no phone, and what nothing to choose means", () => {
    expect(whyNot("closing")).toBe("This inbox is closing, so it connects no new phone.");
    expect(whyNot("suspended")).toBe("This inbox is paused, so it can't connect a phone now.");
    expect(choose).toContain("Your inboxes are on this phone already.");
    expect(choose).toContain("None of these can open on this phone now: each says why.");
  });

  it("tells a no from the other phone from a wait that ran out", () => {
    expect(source).toContain('"Your other phone said no. New phones can\'t connect for a day."');
    expect(source).toMatch(/const saidNo = state === "refused" && Date\.now\(\) < waitEnds - RAN_OUT_MS;/);
  });
});

describe("a new phone asking this one", () => {
  it("shows its name as its own say, and the two digits to compare, with Confirm and Not mine", () => {
    const html = draw(
      createElement(PhoneAskSheet, { entry: ACTIVE, ask: ask(null), many: false, onDone: () => undefined }),
    );
    expect(html).toContain("A new phone wants to connect");
    expect(html).toContain("A phone that calls itself <b>&quot;Galaxy A15&quot;</b> asked to connect to Oficina Maré.");
    expect(html).toContain(">47<");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Not mine<");
    // A dialog that says what it is, and that a tap beside it never answers.
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="phone-ask-h"');
    expect(html).toContain("it asks again when you next open the app");
    expect(html).not.toMatch(/class="scrim"[^>]*onClick/);
  });

  it("says the kind of phone, never a name that is not a phone's, and what Not mine does", () => {
    const bait = ask(null);
    const html = draw(
      createElement(PhoneAskSheet, {
        entry: ACTIVE,
        ask: { ...bait, phone: { ...bait.phone, name: "Not you? Call 0800 555 0100", platform: "android" } },
        many: false,
        onDone: () => undefined,
      }),
    );
    expect(html).toContain("An Android phone asked to connect to Oficina Maré.");
    expect(html).not.toContain("0800");
    expect(html).toContain("Not mine: new phones then wait a day, and we email you.");
  });

  it("names the inbox it asks about when the phone has several", () => {
    const other = { ...ACTIVE, alias: "ib_2", origin: "https://inbox.kiri.example", name: "Kiri's Kitchen" };
    const html = draw(
      createElement(PhoneAskSheet, { entry: other, ask: ask(null), many: true, onDone: () => undefined }),
    );
    expect(html).toContain("A new phone wants to connect: Kiri&#x27;s Kitchen");
    expect(html).toContain("asked to connect to Kiri&#x27;s Kitchen.");
  });

  it("only stops one that waits out its day: there are no digits to compare, so nothing to confirm", () => {
    const html = draw(
      createElement(PhoneAskSheet, {
        entry: ACTIVE,
        ask: ask(new Date(Date.now() + 86_400_000).toISOString()),
        many: false,
        onDone: () => undefined,
      }),
    );
    expect(html).toContain("Not you? Stop it");
    expect(html).not.toContain(">47<");
    expect(html).not.toContain(">Confirm<");
  });

  it("asks for the fingerprint or face before a yes, and signs it with this phone's key", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Settings.tsx"), "utf8");
    const confirm = source.slice(source.indexOf("const confirm = async"), source.indexOf("const refuse = async"));
    const asks = confirm.search(/app\.native\s*\.authenticate\(/);
    expect(asks).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(confirm.indexOf("client.confirmPhone("));
    const client = readFileSync(path.resolve(import.meta.dirname, "../src/lib/client.ts"), "utf8");
    expect(client).toMatch(/confirmPhone\(id: string\)[\s\S]*this\.sessions\.confirmProof\(this\.entry, id\)/);
  });

  it("says when a phone waiting out its day is let in", () => {
    const html = draw(
      createElement(Waiting, { entry: { ...app.active, waitingUntil: Date.now() + 86_400_000 } as never }),
    );
    expect(html).toContain("Connecting on");
    expect(html).toContain("Until then it opens nothing.");
    // A phone-only owner's way not to wait, in order, with no computer needed.
    expect(html).toContain(
      "No need to wait: stop waiting here, remove your old phone in Settings → Phone on the web (any browser), then sign in on this one again.",
    );
    expect(html).not.toContain("on a computer");
    // Check again says it is still waiting, when it is.
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Settings.tsx"), "utf8");
    expect(source).toContain("app.checkAgain()");
    const shell = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
    expect(shell).toMatch(
      /else if \(checking\.current\)\s*toast\([\s\S]*`Still waiting\. It connects on \$\{dayAndTime\(active\.waitingUntil\)\}\.`/,
    );
  });
});

describe("the app opened by the code email's button", () => {
  it("takes the code to the sign-in, before any other link is read", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
    const open = source.slice(source.indexOf("const openLink = useCallback"));
    expect(open.indexOf("readCodeLink(url)")).toBeGreaterThan(-1);
    expect(open.indexOf("readCodeLink(url)")).toBeLessThan(open.indexOf("readPhoneLink(url"));
  });

  it("puts in front the inbox a notification about it names, where the sheet asks", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
    const open = source.slice(source.indexOf("const openLink = useCallback"));
    expect(open).toMatch(
      /readOpenLink\(url, deps\.allowLocal\)[\s\S]*setActive\(entry\)[\s\S]*askAll\.current\(true\)/,
    );
    // An emailed link that waits for the owner's other phone goes to Connect's two digits.
    expect(open).toMatch(/sessions\.redeem\(phone\)[\s\S]*setWaitingPhone\(r\.pending\)/);
  });
});
