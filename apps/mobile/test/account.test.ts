import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { b64uEncode, sha256b64u } from "../../../packages/core/src/phones/crypto";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp } from "../../inbox/test/owner-session";
import { ACCOUNT_ORIGIN, Account, readCodeLink } from "../src/lib/account";
import { InboxClient } from "../src/lib/client";
import { type Native, webNative } from "../src/lib/native";
import type { KV } from "../src/lib/offline";
import { type Fetch, Sessions } from "../src/lib/session";

/**
 * Signing in from the phone with an email code (ADR-028 Amendment 4), the app's side against a real
 * inbox: the hosted service's app API stands in as its contract says (start, confirm, link), and the
 * link it hands back is the inbox's own, made as the runtime makes it. No computer and no QR code: the
 * first phone is in at once; a second waits for the first one's yes, or for a day.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficinamare.pt";

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

function phone(name = "Pixel 8"): Native {
  return { ...webNative(memory()), deviceName: async () => name };
}

async function setup() {
  let clock = Date.now();
  const now = () => clock;
  const db = await freshDb();
  const mail = logMailOut();
  const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off", baseUrl: ORIGIN, now });
  // The hosted service, as its app API answers: a code only to the owner, the same answer to anyone.
  const sent: { id: string; code: string }[] = [];
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const signins = new Map<string, { email: string; challenge: string; code: string }>();
  const grants = new Map<string, { used: boolean }>();
  const service = async (url: URL, body: Record<string, unknown>): Promise<Response> => {
    seen.push({ path: url.pathname, body });
    const json = (b: unknown, status: number) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/app/signin") {
      const id = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
      const email = String(body.email);
      if (email === OWNER) {
        const code = String(100_000 + sent.length);
        signins.set(id, { email, challenge: String(body.challenge), code });
        sent.push({ id, code });
      }
      return json({ id, to: `${email[0]}••••@${email.split("@")[1]}`, resend_in: 60 }, 202);
    }
    const confirm = /^\/v1\/app\/signin\/([^/]+)\/confirm$/.exec(url.pathname);
    if (confirm) {
      const s = signins.get(confirm[1] ?? "");
      if (!s || s.code !== body.code || (await sha256b64u(String(body.verifier))) !== s.challenge)
        return json({ code: "bad_code", detail: "That code didn't work. Check the email, or send a new code." }, 422);
      signins.delete(confirm[1] ?? "");
      const grant = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
      grants.set(grant, { used: false });
      return json(
        {
          grant,
          expires_in: 600,
          inboxes: [{ id: "tn_1", name: "Oficina Maré", origin: ORIGIN, state: "live", can_connect: true }],
        },
        200,
      );
    }
    if (url.pathname === "/v1/app/inboxes/tn_1/link") {
      const g = grants.get(String(body.grant));
      if (!g || g.used) return json({ code: "grant", detail: "That sign-in has lapsed. Sign in again." }, 401);
      g.used = true;
      const link = await inbox.caps.phones.hostLink(
        { email: OWNER, owner: OWNER, challenge: body.challenge, device_key: body.device_key },
        now(),
      );
      return json(
        {
          inbox: { id: "tn_1", name: "Oficina Maré", origin: ORIGIN },
          link: { secret: link.secret, expires_at: new Date(link.expiresAt).toISOString() },
        },
        201,
      );
    }
    return json({ code: "not_found" }, 404);
  };
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin === ACCOUNT_ORIGIN)
      return service(url, JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp());
    return inbox.app.request(input, { ...init, headers });
  };
  /** One phone: its keystore, its sessions and its sign-in, on the test's clock. */
  const device = (name: string) => {
    const native = phone(name);
    return {
      native,
      sessions: new Sessions(native, fetchImpl, now),
      account: new Account(native, fetchImpl, ACCOUNT_ORIGIN, now),
    };
  };
  /** Signs in with the code from the owner's last email, and connects the one inbox. */
  const signIn = async (d: ReturnType<typeof device>) => {
    await d.account.start(OWNER);
    const last = sent.at(-1);
    if (!last) throw new Error("no code");
    const granted = await d.account.confirm(last.code, last.id);
    const inboxEntry = granted.inboxes[0];
    if (!inboxEntry) throw new Error("no inbox");
    return { granted, connected: await d.sessions.connectHosted(d.account, granted.grant, inboxEntry) };
  };
  return {
    inbox,
    db,
    mail,
    sent,
    seen,
    device,
    signIn,
    fetchImpl,
    later: (ms: number) => {
      clock += ms;
    },
  };
}

describe("signing in with an email code", () => {
  it("connects the first phone with no computer and no QR code, the verifier never leaving the phone early", async () => {
    const { device, signIn, seen, fetchImpl } = await setup();
    const one = device("Pixel 8");
    const { connected } = await signIn(one);
    if (!("entry" in connected)) throw new Error("waited for a phone it does not have");
    expect(connected.entry).toMatchObject({ origin: ORIGIN, name: "Oficina Maré" });
    // The start carried the challenge and the kind of phone, never its name, and no verifier: only the
    // confirm did. The code email says which kind of phone asked, and nothing a phone calls itself.
    const start = seen.find((s) => s.path === "/v1/app/signin");
    expect(start?.body).toMatchObject({ email: OWNER, device: { platform: "android" } });
    expect(start?.body.device).toEqual({ platform: "android" });
    expect(JSON.stringify(start?.body)).not.toContain("Pixel");
    expect(JSON.stringify(start?.body)).not.toContain("verifier");
    const confirm = seen.find((s) => s.path.endsWith("/confirm"));
    expect(await sha256b64u(String(confirm?.body.verifier))).toBe(start?.body.challenge);
    // The link's challenge is a fresh one, for the inbox's own device key: not the sign-in's.
    const link = seen.find((s) => s.path.endsWith("/link"));
    expect(link?.body.challenge).not.toBe(start?.body.challenge);
    expect(link?.body.device_key).toMatchObject({ kty: "EC", crv: "P-256" });
    const client = new InboxClient(connected.entry, one.sessions, fetchImpl);
    expect((await client.items("all")).items).toEqual([]);
    expect((await client.me()).phone.confirmed).toBe(true);
    // Nothing of the sign-in is left on the phone.
    expect(await one.account.pending()).toBeNull();
  });

  it("takes the code the email's button hands over, for the sign-in this phone started only", async () => {
    const { device, sent } = await setup();
    expect(readCodeLink("ai.surfingdog.inbox://code?i=AAAAAAAAAAAAAAAAAAAAAA&c=123456")).toEqual({
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      code: "123456",
    });
    for (const bad of [
      "ai.surfingdog.inbox://code?i=short&c=123456",
      "ai.surfingdog.inbox://code?i=AAAAAAAAAAAAAAAAAAAAAA&c=12345",
      "ai.surfingdog.inbox://link?i=AAAAAAAAAAAAAAAAAAAAAA&c=123456",
      "https://app.surfingdog.ai/app/code#v=1&i=AAAAAAAAAAAAAAAAAAAAAA&c=123456",
    ])
      expect(readCodeLink(bad)).toBeNull();
    const one = device("Pixel 8");
    // A code nobody asked for on this phone does nothing here.
    await expect(one.account.confirm("123456", "AAAAAAAAAAAAAAAAAAAAAA")).rejects.toMatchObject({ code: "no_signin" });
    const started = await one.account.start(OWNER);
    expect(started.to).toBe("o••••@oficinamare.pt");
    // Another phone's sign-in: its code is not this phone's.
    await expect(one.account.confirm("123456", "BBBBBBBBBBBBBBBBBBBBBB")).rejects.toMatchObject({ code: "no_signin" });
    // A wrong code keeps the sign-in waiting; the right one, handed over, opens it.
    await expect(one.account.confirm("000000")).rejects.toMatchObject({ code: "bad_code" });
    expect((await one.account.pending())?.id).toBe(started.id);
    const last = sent.at(-1);
    if (!last) throw new Error("no code");
    expect((await one.account.confirm(last.code, last.id)).inboxes).toHaveLength(1);
  });

  it("holds a second phone until the first says yes to its two digits, signed after an unlock", async () => {
    const { device, signIn, fetchImpl } = await setup();
    const one = device("Pixel 8");
    const first = (await signIn(one)).connected;
    if (!("entry" in first)) throw new Error("first phone waited");
    const two = device("Galaxy A15");
    const second = (await signIn(two)).connected;
    if (!("pending" in second)) throw new Error("the second phone was let in with nobody's yes");
    expect(second.pending).toMatchObject({ waitsOn: "phone", match: expect.stringMatching(/^\d{2}$/) });
    expect(await two.sessions.list()).toEqual([]);
    expect(await two.sessions.confirmed(second.pending)).toBe("waiting");
    // The first phone is asked, with the same two digits.
    const firstClient = new InboxClient(first.entry, one.sessions, fetchImpl);
    const asks = await firstClient.phoneAsks();
    expect(asks).toMatchObject([{ match: second.pending.match, phone: { name: "Galaxy A15" }, wait_until: null }]);
    await firstClient.confirmPhone(asks[0]?.id ?? "");
    expect(await two.sessions.confirmed(second.pending)).toBe("confirmed");
    const entry = await two.sessions.finish(second.pending);
    expect((await new InboxClient(entry, two.sessions, fetchImpl).items("all")).items).toEqual([]);
  });

  it("lets a second phone go on Not mine", async () => {
    const { device, signIn, fetchImpl } = await setup();
    const one = device("Pixel 8");
    const first = (await signIn(one)).connected;
    if (!("entry" in first)) throw new Error("first phone waited");
    const two = device("Moto G");
    const second = (await signIn(two)).connected;
    if (!("pending" in second)) throw new Error("not waiting");
    const firstClient = new InboxClient(first.entry, one.sessions, fetchImpl);
    const [ask] = await firstClient.phoneAsks();
    expect(await firstClient.refusePhone(ask?.id ?? "")).toEqual({ removed: true });
    expect(await two.sessions.confirmed(second.pending)).toBe("refused");
    await two.sessions.abandon(second.pending);
    expect(await two.sessions.list()).toEqual([]);
  });

  it("waits a day without the other phone, opening nothing until it is let in", async () => {
    const { device, signIn, fetchImpl, later, mail } = await setup();
    const one = device("Pixel 8");
    await signIn(one);
    const two = device("Moto G");
    const second = (await signIn(two)).connected;
    if (!("pending" in second)) throw new Error("not waiting");
    // None of the owner's phones would hear of it at once (notifications are off here): three days.
    expect(second.pending.waitHours).toBe(72);
    const kept = await two.sessions.waitADay(second.pending);
    expect(kept.waitingUntil).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    expect((await two.sessions.list()).map((e) => e.alias)).toEqual([kept.alias]);
    // It opens nothing meanwhile.
    await expect(new InboxClient(kept, two.sessions, fetchImpl).items("all")).rejects.toMatchObject({ status: 403 });
    expect(await two.sessions.confirmed(kept)).toBe("waiting");
    // The owner's email goes after the answer (on a Worker, once the answer is out).
    for (let i = 0; i < 50 && !mail.sent.some((m) => m.subject.includes("in 3 days")); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(mail.sent.some((m) => m.subject.includes("in 3 days"))).toBe(true);
    // Its days on: let in, and an ordinary inbox on the phone from then.
    later(72 * 3_600_000 + 1000);
    expect(await two.sessions.confirmed(kept)).toBe("confirmed");
    const settled = await two.sessions.settled(kept);
    expect(settled.waitingUntil).toBeUndefined();
    expect((await two.sessions.list())[0]?.waitingUntil).toBeUndefined();
    expect((await new InboxClient(settled, two.sessions, fetchImpl).items("all")).items).toEqual([]);
  });

  it("redeems an emailed link on a second phone: in at once today, and waiting for the first phone's yes once emailed links wait", async () => {
    const { device, signIn, fetchImpl, inbox, mail } = await setup();
    const one = device("Pixel 8");
    const first = (await signIn(one)).connected;
    if (!("entry" in first)) throw new Error("first phone waited");
    /** A phone asks its own server for a link, and opens the one the email brings. */
    const emailed = async (d: ReturnType<typeof device>) => {
      const links = () => mail.sent.filter((m) => m.subject === "Sign in on your phone");
      const before = links().length;
      await d.sessions.askForLink(ORIGIN, OWNER);
      for (let i = 0; i < 50 && links().length === before; i++) await new Promise((r) => setTimeout(r, 10));
      const text = links().at(-1)?.text ?? "";
      const link = readPhoneLink(/https:\/\/\S+/.exec(text)?.[0] ?? "");
      if (link?.kind !== "link") throw new Error(`no link in ${text}`);
      return d.sessions.redeem(link);
    };
    // Today: in at once, as the app released before Amendment 4 expects of an emailed link.
    const two = device("Galaxy A15");
    const now = await emailed(two);
    if (!("entry" in now)) throw new Error("an emailed link waited while emailed links do not");
    expect((await new InboxClient(now.entry, two.sessions, fetchImpl).items("all")).items).toEqual([]);
    // Once emailed links wait: the app keeps nothing, shows the two digits, and waits for the yes.
    inbox.caps.phones.emailedLinksWait = true;
    const three = device("Moto G");
    const waits = await emailed(three);
    if (!("pending" in waits)) throw new Error("let in with nobody's yes");
    expect(waits.pending).toMatchObject({ waitsOn: "phone", match: expect.stringMatching(/^\d{2}$/) });
    expect(await three.sessions.list()).toEqual([]);
    const firstClient = new InboxClient(first.entry, one.sessions, fetchImpl);
    const [ask] = await firstClient.phoneAsks();
    expect(ask).toMatchObject({ match: waits.pending.match, phone: { name: "Moto G" } });
    await firstClient.confirmPhone(ask?.id ?? "");
    expect(await three.sessions.confirmed(waits.pending)).toBe("confirmed");
    const entry = await three.sessions.finish(waits.pending);
    expect((await new InboxClient(entry, three.sessions, fetchImpl).items("all")).items).toEqual([]);
  });
});
