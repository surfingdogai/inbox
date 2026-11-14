import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type App, AppContext } from "../src/context";
import type { PhoneAsk } from "../src/lib/client";
import { Connect } from "../src/screens/Connect";
import { PhoneAskSheet, Waiting } from "../src/screens/Settings";

/**
 * The screens of signing in with an email code and of a phone that confirms a phone (ADR-028
 * Amendment 4), drawn as the app first draws them: what they say, and nothing more than they need.
 */
const app = {
  native: { platform: "android", deviceSecure: async () => true },
  me: { business: { name: "Oficina Maré", timezone: "Europe/Lisbon" } },
  active: { alias: "ib_1", origin: "https://inbox.oficinamare.pt", name: "Oficina Maré", deviceId: "d1", addedAt: 0 },
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
  });

  it("offers signing in with email beside the camera, on the first screen", () => {
    const html = draw(createElement(Connect, { canGoBack: false, allowLocal: false }));
    expect(html).toContain("Scan the code");
    expect(html).toContain("Sign in with email instead");
    expect(html).toContain("Try the demo");
  });

  it("types the code only as a fallback, marked as a one-time code", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Connect.tsx"), "utf8");
    expect(source).toContain('autoComplete="one-time-code"');
    expect(source).toContain("Reading it on another device? Type its code:");
    expect(source).toContain("I don't have my other phone");
  });
});

describe("a new phone asking this one", () => {
  it("shows its name as its own say, and the two digits to compare, with Confirm and Not mine", () => {
    const html = draw(createElement(PhoneAskSheet, { ask: ask(null), onDone: () => undefined }));
    expect(html).toContain("A new phone wants to connect");
    expect(html).toContain("A phone that calls itself <b>&quot;Galaxy A15&quot;</b> asked to connect to Oficina Maré.");
    expect(html).toContain(">47<");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Not mine<");
  });

  it("only stops one that waits out its day: there are no digits to compare, so nothing to confirm", () => {
    const html = draw(
      createElement(PhoneAskSheet, {
        ask: ask(new Date(Date.now() + 86_400_000).toISOString()),
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
    expect(asks).toBeLessThan(confirm.indexOf("app.client.confirmPhone("));
    const client = readFileSync(path.resolve(import.meta.dirname, "../src/lib/client.ts"), "utf8");
    expect(client).toMatch(/confirmPhone\(id: string\)[\s\S]*this\.sessions\.confirmProof\(this\.entry, id\)/);
  });

  it("says when a phone waiting out its day is let in", () => {
    const html = draw(
      createElement(Waiting, { entry: { ...app.active, waitingUntil: Date.now() + 86_400_000 } as never }),
    );
    expect(html).toContain("Connecting on");
    expect(html).toContain("Until then it opens nothing.");
  });
});

describe("the app opened by the code email's button", () => {
  it("takes the code to the sign-in, before any other link is read", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
    const open = source.slice(source.indexOf("const openLink = useCallback"));
    expect(open.indexOf("readCodeLink(url)")).toBeGreaterThan(-1);
    expect(open.indexOf("readCodeLink(url)")).toBeLessThan(open.indexOf("readPhoneLink(url"));
  });
});
