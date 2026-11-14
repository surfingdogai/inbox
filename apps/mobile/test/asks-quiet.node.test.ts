import { readFileSync } from "node:fs";
import path from "node:path";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp } from "../../inbox/test/owner-session";
import { InboxClient } from "../src/lib/client";
import { type Native, NativeError, webNative } from "../src/lib/native";
import { type Fetch, type InboxEntry, InboxError, Sessions } from "../src/lib/session";

/**
 * The app looks every half minute, while it is in front, for a new phone that waits for this one's yes
 * (ADR-028 Amendment 4). Those looks are the app's own, so they never ask for the fingerprint or face:
 * with the app left open, an owner who does nothing is never asked, and is never taught to say yes to
 * a prompt nobody asked for. An owner's own call still asks once, and a prompt that cannot show (the
 * app in the background) never leaves a refresh waiting for good.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@example.com";
/** As Android's key: it signs only this long after an unlock (Keys.java AUTH_VALID_SECONDS). */
const AUTH_VALID_MS = 300_000;
const APP = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
/** How often the app looks, as App.tsx has it. */
const ASK_EVERY_MS = Number(/const ASK_EVERY_MS = ([\d_]+);/.exec(APP)?.[1]?.replaceAll("_", "") ?? Number.NaN);

async function phoneWithInbox(opts: { authenticate: (n: number) => Promise<boolean>; unlockWaitMs?: number }) {
  let clock = Date.now();
  const db = await freshDb();
  const mail = logMailOut(() => {});
  const inbox = createInbox({
    db,
    mailOut: mail,
    ownerEmails: [OWNER],
    pushRelay: "off",
    baseUrl: ORIGIN,
    now: () => clock,
  });
  await db.client.query({
    sql: "INSERT INTO users (id, email, role, created_at) VALUES ('u_owner', ?, 'owner', ?)",
    params: [OWNER, clock],
    method: "run",
  });
  const fetchImpl: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp());
    return inbox.app.request(input, { ...init, headers });
  };
  const m = new Map<string, string>();
  const base = webNative({
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  });
  let unlockedAt = clock;
  let prompts = 0;
  const native: Native = {
    ...base,
    sign: async (alias, data) => {
      if (clock - unlockedAt > AUTH_VALID_MS) throw new NativeError("User not authenticated", "auth_required");
      return base.sign(alias, data);
    },
    authenticate: async () => {
      prompts++;
      const ok = await opts.authenticate(prompts);
      if (ok) unlockedAt = clock;
      return ok;
    },
  };
  const sessions = new Sessions(native, fetchImpl, () => clock, opts.unlockWaitMs);
  await sessions.askForLink(ORIGIN, OWNER);
  for (let i = 0; i < 100 && !mail.sent.some((x) => x.subject === "Sign in on your phone"); i++)
    await new Promise((r) => setTimeout(r, 10));
  const text = String(mail.sent.find((x) => x.subject === "Sign in on your phone")?.text ?? "");
  const link = readPhoneLink(/https:\/\/\S+/.exec(text)?.[0] ?? "") as NonNullable<ReturnType<typeof readPhoneLink>>;
  const r = await sessions.redeem(link);
  if (!("entry" in r)) throw new Error("the first phone should connect at once");
  return {
    sessions,
    entry: r.entry as InboxEntry,
    client: () => new InboxClient(r.entry, sessions, fetchImpl),
    at: () => clock,
    later: (ms: number) => {
      clock += ms;
    },
    unlockNow: () => {
      unlockedAt = clock;
    },
    prompts: () => prompts,
  };
}

describe("the app's own look for new phones", () => {
  it("never asks an owner who does nothing for the fingerprint, over twenty minutes in front", async () => {
    expect(ASK_EVERY_MS).toBe(30_000);
    const p = await phoneWithInbox({ authenticate: async () => false });
    for (let t = 0; t <= 20 * 60_000; t += ASK_EVERY_MS) {
      await p
        .client()
        .phoneAsks()
        .catch(() => undefined);
      p.later(ASK_EVERY_MS);
    }
    expect(p.prompts()).toBe(0);
  });

  it("asks once when the owner does something, and looks again quietly once they unlocked", async () => {
    const p = await phoneWithInbox({ authenticate: async () => true });
    p.later(15 * 60_000);
    // The access token ran out and the key will not sign without an unlock: the look gives up.
    await expect(p.client().phoneAsks()).rejects.toMatchObject({ code: "locked" });
    expect(p.prompts()).toBe(0);
    // The owner opens their inbox: asked once.
    await p.client().items("all");
    expect(p.prompts()).toBe(1);
    // A look now needs nothing more.
    expect(await p.client().phoneAsks()).toEqual([]);
    expect(p.prompts()).toBe(1);
  });

  it("lets the owner's own call ask even while a quiet look for the same inbox is giving up", async () => {
    const p = await phoneWithInbox({ authenticate: async () => true });
    p.later(15 * 60_000);
    const [look, items] = await Promise.allSettled([p.client().phoneAsks(), p.client().items("all")]);
    expect(look.status).toBe("rejected");
    expect(items.status).toBe("fulfilled");
    expect(p.prompts()).toBe(1);
  });

  it("is only a look: a notification the owner opened may ask", async () => {
    const p = await phoneWithInbox({ authenticate: async () => true });
    p.later(15 * 60_000);
    expect(await p.client().phoneAsks({ quiet: false })).toEqual([]);
    expect(p.prompts()).toBe(1);
  });
});

describe("the fingerprint or face, when it cannot show", () => {
  it("is never asked for in the background", async () => {
    const p = await phoneWithInbox({ authenticate: async () => true });
    p.later(15 * 60_000);
    p.sessions.setFront(false);
    await expect(p.client().items("all")).rejects.toMatchObject({ code: "locked" });
    expect(p.prompts()).toBe(0);
    // Back in front, the owner's call asks.
    p.sessions.setFront(true);
    await p.client().items("all");
    expect(p.prompts()).toBe(1);
  });

  it("shares a prompt already showing, even when it took the app out of front (as an iPhone's does)", async () => {
    let answer: (ok: boolean) => void = () => undefined;
    const p = await phoneWithInbox({ authenticate: () => new Promise<boolean>((r) => (answer = r)) });
    p.later(15 * 60_000);
    const items = p.client().items("all");
    for (let i = 0; i < 50 && p.prompts() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(p.prompts()).toBe(1);
    p.sessions.setFront(false);
    const signed = p.sessions.confirmProof(p.entry, "d_other");
    answer(true);
    await expect(items).resolves.toMatchObject({ items: [] });
    await expect(signed).resolves.toMatchObject({ proof: expect.any(String) });
    expect(p.prompts()).toBe(1);
  });

  it("gives up on a prompt that never answers, so the next call can ask again", async () => {
    const p = await phoneWithInbox({
      // The first prompt never shows and never answers (asked as the app went to the background).
      authenticate: (n) => (n === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
      unlockWaitMs: 50,
    });
    p.later(15 * 60_000);
    const error = await p
      .client()
      .items("all")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboxError);
    expect(error).toMatchObject({ code: "locked" });
    // Nothing waits on it any more: the owner's next call asks again, and opens.
    const page = await p.client().items("all");
    expect(page.items).toEqual([]);
    expect(p.prompts()).toBe(2);
  });
});

describe("the app's half-minute look, as the app runs it", () => {
  const source = APP;

  it("runs only while the app is in front, and the background tells the sessions so", () => {
    const poll = source.slice(
      source.indexOf("const t = setInterval("),
      source.indexOf("return () => clearInterval(t);"),
    );
    expect(poll).toContain("askAll.current(false)");
    const effect = source.slice(source.lastIndexOf("useEffect(() => {", source.indexOf("const t = setInterval(")));
    expect(effect.slice(0, effect.indexOf("const t = setInterval("))).toContain("!front");
    // A listener of its own, made once (its only dependency is the sessions), and the state read at the start.
    const front = source.slice(source.indexOf("const said = (isActive: boolean)"), source.indexOf("}, [sessions]);"));
    expect(front).toContain("sessions.setFront(isActive)");
    expect(front).toContain("CapApp.getState()");
    expect(front).toContain('CapApp.addListener("appStateChange", ({ isActive }) => said(isActive))');
  });

  it("asks loudly only for a notification the owner opened, and brings back what was put off", () => {
    const open = source.slice(
      source.indexOf("const opened = readOpenLink("),
      source.indexOf("const item = readItemLink("),
    );
    expect(open).toContain("putOff.current.clear()");
    expect(open).toContain("askAll.current(true)");
    const back = source.slice(source.indexOf('CapApp.addListener("appStateChange", async'));
    expect(back.slice(0, back.indexOf("const away ="))).toContain("putOff.current.clear()");
    expect(source.match(/askAll\.current\(true\)/g)).toHaveLength(1);
  });
});
