import { readFileSync } from "node:fs";
import path from "node:path";
import { logMailOut } from "@surfingdog/platform";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp } from "../../inbox/test/owner-session";
import type { Account, GrantedInbox } from "../src/lib/account";
import { InboxClient } from "../src/lib/client";
import { type Native, NativeError, webNative } from "../src/lib/native";
import { type Fetch, type InboxEntry, type PendingPhone, Sessions } from "../src/lib/session";
import { CheckNow } from "../src/screens/Connect";

/**
 * A new phone that waits for the owner's other phone's yes (ADR-028 Amendment 4) asks every two
 * seconds whether it came, for up to fifteen minutes. Those looks are the phone's own, so they never
 * ask for the fingerprint or face: its first token lasts ten minutes, and past them the look stops and
 * says "Check now", whose press may ask once. Only while the app is in front.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@example.com";
/** As Android's key: it signs only this long after an unlock (Keys.java AUTH_VALID_SECONDS). */
const AUTH_VALID_MS = 300_000;
const CONNECT = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Connect.tsx"), "utf8");
const APP = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
const constant = (name: string) =>
  Number(
    new RegExp(`const ${name} = ([\\d_ *]+);`)
      .exec(CONNECT)?.[1]
      ?.replaceAll("_", "")
      .split("*")
      .reduce((a, b) => a * Number(b), 1) ?? Number.NaN,
  );
const ASK_EVERY_MS = constant("ASK_EVERY_MS");
const PHONE_WAIT_MS = constant("PHONE_WAIT_MS");

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

/** The owner's first phone, in at once by the host's link, and a second one that waits for its yes. */
async function waiting(answer: (n: number) => boolean) {
  let clock = Date.now();
  const now = () => clock;
  const db = await freshDb();
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    ownerEmails: [OWNER],
    pushRelay: "off",
    baseUrl: ORIGIN,
    now,
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
  // The host's link, as its runtime makes it after its own email code (`phones.hostLink`).
  const host = {
    link: async (_grant: string, _inbox: GrantedInbox, challenge: string, key: unknown) => {
      const made = await inbox.caps.phones.hostLink({ email: OWNER, owner: OWNER, challenge, device_key: key }, clock);
      return { origin: ORIGIN, name: "Oficina Maré", secret: made.secret };
    },
  } as unknown as Account;
  const granted: GrantedInbox = { id: "tn_1", name: "Oficina Maré", origin: ORIGIN, state: "live", can_connect: true };
  const a = new Sessions({ ...webNative(memory()), deviceName: async () => "Pixel 8" }, fetchImpl, now);
  const first = await a.connectHosted(host, "g", granted);
  if (!("entry" in first)) throw new Error("the first phone should be in at once");
  // The new phone: its key signs only within five minutes of its last unlock, the sign-in's.
  const base = webNative(memory());
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
      const ok = answer(prompts);
      if (ok) unlockedAt = clock;
      return ok;
    },
  };
  const b = new Sessions(native, fetchImpl, now);
  const started = clock;
  const r = await b.connectHosted(host, "g", granted);
  if (!("pending" in r)) throw new Error("the second phone should wait for the first one's yes");
  return {
    pending: r.pending as PendingPhone,
    sessions: b,
    other: new InboxClient(first.entry as InboxEntry, a, fetchImpl),
    at: (ms: number) => {
      clock = started + ms;
    },
    prompts: () => prompts,
  };
}

/** Connect's own look, every two seconds from `from`, until something other than waiting comes. */
async function look(w: Awaited<ReturnType<typeof waiting>>, from: number, to = PHONE_WAIT_MS) {
  let t = from;
  for (; t <= to; t += ASK_EVERY_MS) {
    w.at(t);
    const state = await w.sessions.confirmed(w.pending, { quiet: true });
    if (state !== "waiting") return { state, at: t };
  }
  return { state: "waiting" as const, at: t };
}

describe("a new phone waiting for the other phone's yes", () => {
  it("looks every two seconds for fifteen minutes", () => {
    expect(ASK_EVERY_MS).toBe(2_000);
    expect(PHONE_WAIT_MS).toBe(15 * 60_000);
  });

  it("never asks for the fingerprint or face by itself, over the whole wait, and stops when it would", async () => {
    const w = await waiting(() => false);
    const found = await look(w, 0);
    expect(w.prompts()).toBe(0);
    // Its first token lasts ten minutes (less the half minute kept in hand): past it, the look stops.
    expect(found.state).toBe("locked");
    expect(found.at).toBeGreaterThan(9 * 60_000);
    expect(found.at).toBeLessThanOrEqual(10 * 60_000);
    // Nothing more looks by itself until Check now; the wait running out asks nothing either.
    w.at(PHONE_WAIT_MS + ASK_EVERY_MS);
    await w.sessions.abandon(w.pending);
    expect(w.prompts()).toBe(0);
  });

  it("asks once when the owner taps Check now, then looks quietly to the end of the wait", async () => {
    const w = await waiting(() => true);
    const found = await look(w, 0);
    expect(found.state).toBe("locked");
    expect(w.prompts()).toBe(0);
    // Check now: the owner's press, so it may ask, once.
    expect(await w.sessions.confirmed(w.pending)).toBe("waiting");
    expect(w.prompts()).toBe(1);
    const rest = await look(w, found.at + ASK_EVERY_MS);
    expect(rest.state).toBe("waiting");
    expect(w.prompts()).toBe(1);
  });

  it("keeps Check now when the owner turns the prompt down, and asks nothing more by itself", async () => {
    const w = await waiting(() => false);
    const found = await look(w, 0);
    expect(await w.sessions.confirmed(w.pending)).toBe("locked");
    expect(w.prompts()).toBe(1);
    w.at(found.at + 60_000);
    expect(await w.sessions.confirmed(w.pending, { quiet: true })).toBe("locked");
    expect(w.prompts()).toBe(1);
  });

  it("sees the other phone's yes while its token lasts, with no prompt", async () => {
    const w = await waiting(() => false);
    w.at(5 * 60_000);
    expect(await w.sessions.confirmed(w.pending, { quiet: true })).toBe("waiting");
    const [asked] = await w.other.phoneAsks();
    expect(asked?.match).toBe(w.pending.match);
    await w.other.confirmPhone(asked?.id ?? "");
    w.at(5 * 60_000 + ASK_EVERY_MS);
    expect(await w.sessions.confirmed(w.pending, { quiet: true })).toBe("confirmed");
    expect(w.prompts()).toBe(0);
  });
});

describe("the waiting screen, as Connect runs it", () => {
  const effect = CONNECT.slice(
    CONNECT.indexOf("if (!pending || stopped || !front) return;"),
    CONNECT.indexOf("const checkNow = async"),
  );

  it("looks quietly, only in front, and stops on a look that would need an unlock", () => {
    expect(effect).toContain("sessions.confirmed(pending, { quiet: true })");
    expect(effect).toMatch(/if \(state === "locked"\) \{\s*setStoppedFor\(pending\.alias\);\s*return;/);
    expect(effect).toContain("clearTimeout(timer)");
    expect(effect).toContain("}, [pending, stopped, front, sessions, settle]);");
    // The app says whether it is in front, from its own listener.
    expect(APP).toMatch(/const value: AppValue = \{[\s\S]*\bfront,[\s\S]*\};/);
    // The wait's end is kept with the waiting phone: looking again never moves it.
    expect(CONNECT).toMatch(/const waitEnds = useMemo\([\s\S]*\[pending\],\s*\);/);
  });

  it("looks loudly only on Check now, and a wait given up on asks nothing", () => {
    const check = CONNECT.slice(CONNECT.indexOf("const checkNow = async"), CONNECT.indexOf('/** "Wait 24 hours"'));
    expect(check).toContain("sessions.confirmed(p);");
    const session = readFileSync(path.resolve(import.meta.dirname, "../src/lib/session.ts"), "utf8");
    const abandon = session.slice(session.indexOf("async abandon("), session.indexOf("async connectHosted("));
    expect(abandon).toContain("this.token(Sessions.entryOf(pending), false, true)");
    // A phone waiting out its day: the app's own look is quiet too; Check again may ask.
    expect(APP).toContain("sessions.confirmed(active, { quiet: !checking.current })");
  });

  it("says Check now in one line, with the press", () => {
    const phone = renderToString(createElement(CheckNow, { from: "phone", busy: false, onCheck: () => undefined }));
    expect(phone).toContain("Tap Check now to see if your other phone said yes.");
    expect(phone).toContain(">Check now<");
    const computer = renderToString(
      createElement(CheckNow, { from: "computer", busy: false, onCheck: () => undefined }),
    );
    expect(computer).toContain("Tap Check now to see if you confirmed on your computer.");
    expect(CONNECT).toContain('<CheckNow from="phone" busy={busy} onCheck={() => void checkNow(pending)} />');
    expect(CONNECT).toContain('<CheckNow from="computer" busy={busy} onCheck={() => void checkNow(pending)} />');
  });
});
