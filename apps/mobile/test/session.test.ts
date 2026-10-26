import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { InboxClient } from "../src/lib/client";
import { type Native, webNative } from "../src/lib/native";
import { Box, ITEM_KEEP_MS, type KV, Outbox } from "../src/lib/offline";
import { type Fetch, InboxError, type PendingPhone, Sessions } from "../src/lib/session";
import {
  actionsFor,
  ago,
  agoSentence,
  badgeOf,
  calendarWords,
  cardTitle,
  fulfilFact,
  holdNotes,
  money,
  needsYou,
  today,
} from "../src/lib/view";

/**
 * The phone app's own logic against a real inbox (ADR-028): pairing with a code from Settings → Phone,
 * tokens refreshed with the device key, being signed out when the owner removes the phone, the
 * encrypted offline cache, and what was done offline sent once with its idempotency key.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficinamare.pt";

function memory(): KV & { dump(): string } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
    dump: () => JSON.stringify([...m.entries()]),
  };
}

/** A phone: the browser stand-in for the keystore, with its storage in memory and keys in memory. */
function phone(): Native & { store: KV & { dump(): string } } {
  const store = memory();
  return { ...webNative(store), store };
}

async function setup() {
  const db = await freshDb();
  const mail = logMailOut();
  const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off" });
  const cookie = await signInByCode(inbox.app, mail, ORIGIN, OWNER);
  // The phone's requests reach the inbox's app directly, as native HTTP would.
  let online = true;
  const fetchImpl: Fetch = async (input, init) => {
    if (!online) throw new TypeError("offline");
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp());
    return inbox.app.request(input, { ...init, headers });
  };
  const codes: string[] = [];
  const code = async () => {
    const res = await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    const made = (await res.json()) as { id: string; qr: string };
    const link = readPhoneLink(made.qr);
    if (!link) throw new Error("no code");
    codes.push(made.id);
    return link;
  };
  /** The owner, on the computer: what the last code's phone shows, and Confirm (or Not mine). */
  const owner = async (what: "status" | "confirm" | "refuse") => {
    const id = codes[codes.length - 1];
    const res = await inbox.app.request(
      `${ORIGIN}/v1/owner/phones/pairings/${id}${what === "status" ? "" : `/${what}`}`,
      { method: what === "status" ? "GET" : "POST", headers: { cookie, origin: ORIGIN } },
    );
    return (await res.json()) as { state?: string; match?: string; removed?: boolean };
  };
  /** Scanned, agreed to, confirmed on the computer: the phone keeps the inbox. */
  const connect = async (sessions: Sessions, link?: Awaited<ReturnType<typeof code>>) => {
    const pending = await sessions.pair(link ?? (await code()));
    expect(await owner("confirm")).toMatchObject({ state: "paired" });
    expect(await sessions.confirmed(pending)).toBe("confirmed");
    return sessions.finish(pending);
  };
  return {
    db,
    inbox,
    cookie,
    fetchImpl,
    code,
    owner,
    connect,
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

describe("pairing and tokens", () => {
  it("waits for the owner to confirm the same two digits on the computer, then keeps the inbox", async () => {
    const { fetchImpl, code, owner } = await setup();
    const p = phone();
    const sessions = new Sessions(p, fetchImpl);
    const pending: PendingPhone = await sessions.pair(await code());
    expect(pending.match).toMatch(/^\d{2}$/);
    // Nothing is kept on the phone until the owner confirms; the tokens open nothing but "who am I".
    expect(await sessions.list()).toEqual([]);
    expect(await sessions.confirmed(pending)).toBe("waiting");
    const items = await fetchImpl(`${ORIGIN}/v1/owner/items`, {
      headers: { authorization: `Bearer ${pending.answer.access_token}` },
    });
    expect(items.status).toBe(403);
    // The computer shows the very digits the phone worked out.
    expect(await owner("status")).toMatchObject({ state: "confirm", match: pending.match });
    expect(await owner("confirm")).toMatchObject({ state: "paired" });
    expect(await sessions.confirmed(pending)).toBe("confirmed");
    const entry = await sessions.finish(pending);
    expect(entry).toMatchObject({ origin: ORIGIN, name: "inbox.test" });
    expect((await sessions.list()).map((e) => e.alias)).toEqual([entry.alias]);
    // The refresh token is kept in secure storage, the access token only in memory.
    expect(p.store.dump()).toContain(`tokens.${entry.alias}`);
    expect(p.store.dump()).not.toContain("sdi_pa_");
    const client = new InboxClient(entry, sessions, fetchImpl);
    expect((await client.items("all")).items).toEqual([]);
    const me = await client.me();
    expect(me.phone.name).toBe("This browser");
    expect(me.notify.kinds.handled).toBe(false);
  });

  it("is let go when the owner presses Not mine", async () => {
    const { fetchImpl, code, owner } = await setup();
    const sessions = new Sessions(phone(), fetchImpl);
    const pending = await sessions.pair(await code());
    expect(await owner("refuse")).toMatchObject({ removed: true });
    expect(await sessions.confirmed(pending)).toBe("refused");
    await sessions.abandon(pending);
    expect(await sessions.list()).toEqual([]);
  });

  it("connects nothing on a phone with no screen lock", async () => {
    const { fetchImpl, code } = await setup();
    const p = { ...phone(), deviceSecure: async () => false };
    await expect(new Sessions(p, fetchImpl).pair(await code())).rejects.toMatchObject({ code: "no_screen_lock" });
  });

  it("asks for the fingerprint once when the key will not sign without an unlock, then signs", async () => {
    const { fetchImpl, connect } = await setup();
    const base = phone();
    const entry = await connect(new Sessions(base, fetchImpl));
    let locked = true;
    let asked = 0;
    const p = {
      ...base,
      sign: async (alias: string, data: string) => {
        if (locked) {
          const { NativeError } = await import("../src/lib/native");
          throw new NativeError("Unlock to continue.", "auth_required");
        }
        return base.sign(alias, data);
      },
      authenticate: async () => {
        asked++;
        locked = false;
        return true;
      },
    };
    const restarted = new Sessions(p, fetchImpl);
    expect((await new InboxClient(entry, restarted, fetchImpl).items("all")).items).toEqual([]);
    expect(asked).toBe(1);
  });

  it("refreshes with the device key after a restart, and is signed out once removed", async () => {
    const { fetchImpl, connect, cookie, inbox } = await setup();
    const p = phone();
    const first = new Sessions(p, fetchImpl);
    const entry = await connect(first);
    // The app restarts: nothing in memory, the refresh token from secure storage, the key from the keystore.
    const again = new Sessions(p, fetchImpl);
    const client = new InboxClient(entry, again, fetchImpl);
    expect((await client.items("needs")).items).toEqual([]);
    // The owner removes the phone on the computer.
    await inbox.app.request(`${ORIGIN}/v1/owner/phones/${entry.deviceId}`, {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN },
    });
    const restarted = new Sessions(p, fetchImpl);
    await expect(new InboxClient(entry, restarted, fetchImpl).items("all")).rejects.toMatchObject({
      code: "signed_out",
    });
  });

  it("connects several inboxes, each with its own key, and forgets one without the others", async () => {
    const a = await setup();
    const p = phone();
    const sessions = new Sessions(p, a.fetchImpl);
    const one = await a.connect(sessions);
    const two = await a.connect(sessions, { ...(await a.code()), origin: ORIGIN });
    // The same inbox twice is one entry, the newer.
    expect((await sessions.list()).map((e) => e.alias)).toEqual([two.alias]);
    expect(one.alias).not.toBe(two.alias);
    await sessions.remove(two);
    expect(await sessions.list()).toEqual([]);
  });
});

describe("offline", () => {
  it("keeps the cache encrypted, bound to its name", async () => {
    const p = phone();
    const kv = memory();
    const box = await Box.open(p, kv);
    await box.put("list.ib_1", { views: [{ who: "Maya Chen" }] });
    expect(kv.dump()).not.toContain("Maya");
    expect(await box.get("list.ib_1")).toEqual({ views: [{ who: "Maya Chen" }] });
    // Copied under another inbox's name, it does not open.
    kv.setItem("sdi.cache.list.ib_2", kv.getItem("sdi.cache.list.ib_1") ?? "");
    expect(await box.get("list.ib_2")).toBeNull();
    // The same key opens it after a restart.
    expect(await (await Box.open(p, kv)).get("list.ib_1")).toEqual({ views: [{ who: "Maya Chen" }] });
  });

  it("sends what was done offline once, in order, with the key it was given when pressed", async () => {
    const p = phone();
    const outbox = new Outbox(await Box.open(p, memory()));
    const a = await outbox.add({
      alias: "ib_1",
      itemId: "i1",
      kind: "transition",
      body: { event: "confirm" },
      label: "Accept 14:00",
    });
    const b = await outbox.add({ alias: "ib_1", itemId: "i2", kind: "reply", body: { body: "Yes" }, label: "Reply" });
    const keys: string[] = [];
    // Still offline: nothing goes, nothing is lost.
    expect(await outbox.flush(async () => ({ ok: false, offline: true, reason: "offline" }))).toMatchObject({
      sent: 0,
      left: 2,
    });
    // Back online: the first is refused by the inbox (already answered), the second goes.
    const r = await outbox.flush(async (x) => {
      keys.push(x.key);
      return x.id === a.id
        ? { ok: false, offline: false, reason: "That booking was confirmed already." }
        : { ok: true };
    });
    expect(r.sent).toBe(1);
    expect(r.refused.map((f) => f.reason)).toEqual(["That booking was confirmed already."]);
    expect(keys).toEqual([a.key, b.key]);
    expect(await outbox.list()).toEqual([]);
  });

  it("leaves nothing of a removed inbox readable on the phone, and drops what nobody opened for a month", async () => {
    const p = phone();
    const kv = memory();
    const box = await Box.open(p, kv);
    await box.put("list.ib_1", { at: 1, views: [] });
    await box.put("item.ib_1.i1", { at: Date.now(), detail: { who: "Maya Chen" } });
    await box.put("item.ib_2.i9", { at: Date.now(), detail: { who: "Tom Hale" } });
    await box.put("item.ib_2.old", { at: Date.now() - ITEM_KEEP_MS - 1, detail: {} });
    const outbox = new Outbox(box);
    await outbox.add({ alias: "ib_1", itemId: "i1", kind: "reply", body: { body: "Yes" }, label: "Reply" });
    await outbox.add({ alias: "ib_2", itemId: "i9", kind: "reply", body: { body: "Ok" }, label: "Reply" });
    await box.forgetInbox("ib_1", p, false);
    expect(kv.keys?.().filter((k) => k.includes("ib_1"))).toEqual([]);
    expect((await outbox.list()).map((a) => a.alias)).toEqual(["ib_2"]);
    expect(await box.evict()).toBe(1);
    expect(box.names("item.")).toEqual(["item.ib_2.i9"]);
    // The last inbox gone: the cache and its key go too.
    await box.forgetInbox("ib_2", p, true);
    expect(kv.keys?.().filter((k) => k.startsWith("sdi.cache."))).toEqual([]);
    expect(await p.secureGet("cache.key")).toBeNull();
  });

  it("is told it is offline, not that the inbox failed", async () => {
    const s = await setup();
    const p = phone();
    const sessions = new Sessions(p, s.fetchImpl);
    const entry = await s.connect(sessions);
    const client = new InboxClient(entry, sessions, s.fetchImpl);
    await client.items("all");
    s.setOnline(false);
    const error = await client.items("all").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboxError);
    expect((error as InboxError).offline).toBe(true);
  });
});

describe("the screens' words", () => {
  const view = (over: Record<string, unknown>) =>
    ({
      item: {
        id: "i",
        type: "booking",
        state: "requested",
        version: 1,
        partyId: "p",
        locationId: null,
        channel: "mcp_public",
        subject: null,
        flags: { needsHuman: false, sandbox: false, priority: 0 },
        linkedItemId: null,
        createdAt: "2026-10-20T09:00:00Z",
        updatedAt: "2026-10-20T09:00:00Z",
        closedAt: null,
        payload: {
          reservationFor: { serviceId: "s", name: "Cut & finish" },
          startTime: "2026-10-20T14:00:00Z",
          endTime: "2026-10-20T14:45:00Z",
        },
        ...over,
      },
      transitions: [
        { event: "decline", label: "Decline" },
        { event: "confirm", label: "Confirm booking" },
        { event: "propose", label: "Propose another time" },
      ],
      human: "Booking is requested.",
      party: { id: "p", name: "Maya Chen", kind: "person", verified: false },
    }) as never;

  it("puts accepting first, as the design does, with the time in its words", () => {
    const a = actionsFor(view({}), "UTC");
    expect(a.primary).toEqual({ event: "confirm", label: "Accept 14:00" });
    expect(a.propose?.label).toBe("Propose another time");
    expect(a.decline?.event).toBe("decline");
  });

  it("knows what needs the owner, and lays out today", () => {
    expect(needsYou(view({}))).toBe(true);
    expect(needsYou(view({ state: "confirmed" }))).toBe(false);
    expect(needsYou(view({ state: "confirmed", flags: { needsHuman: true, sandbox: false, priority: 0 } }))).toBe(true);
    const day = today(
      [
        view({}),
        view({
          id: "j",
          state: "confirmed",
          payload: {
            reservationFor: { serviceId: "s", name: "Cut" },
            startTime: "2026-10-20T09:30:00Z",
            endTime: "2026-10-20T10:00:00Z",
          },
        }),
      ],
      Date.parse("2026-10-20T08:00:00Z"),
      "UTC",
    );
    expect(day.rows.map((r) => [r.at, r.kind])).toEqual([
      ["09:30", "booking"],
      ["10:00", "free"],
      ["14:00", "ask"],
    ]);
    expect(day.toConfirm).toBe(1);
    expect(badgeOf("Atelier Lumen")).toBe("AL");
    expect(badgeOf("café")).toBe("CA");
  });

  it("says times, money and the calendar as the approved screens do", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(ago("2026-10-20T11:58:00Z", now)).toBe("2 min");
    expect(ago("2026-10-20T11:00:00Z", now)).toBe("1 h");
    expect(ago("2026-10-19T09:00:00Z", now)).toBe("Yesterday");
    expect(agoSentence("2026-10-20T11:58:00Z", now)).toBe("2 min ago");
    expect(agoSentence("2026-10-20T11:59:40Z", now)).toBe("just now");
    expect(agoSentence("2026-10-18T09:00:00Z", now)).toBe("2 days ago");
    expect(money({ value: 4800, currency: "EUR" })).toMatch(/^€48$/);
    expect(money({ value: 3650, currency: "EUR" })).toMatch(/^€36\.50$/);
    expect(calendarWords({ calendar: { free: true, clash: null } })).toMatchObject({ free: true, short: "Free" });
    expect(
      calendarWords(
        { calendar: { free: false, clash: { name: "Tom Hale", startTime: "2026-10-21T14:00:00Z" } } },
        "UTC",
      )?.line,
    ).toBe("Clashes with Tom Hale, 14:00");
    expect(calendarWords({})).toBeNull();
  });

  it("says a kitchen's order for a time with its method and slot, and why it waits", () => {
    const now = Date.parse("2026-11-04T17:00:00Z");
    const order = (hold: string[]) =>
      view({
        type: "order",
        state: "received",
        payload: {
          orderedItem: [{ productId: "pr", name: "Pizza", quantity: 1, price: { value: 18900, currency: "MXN" } }],
          totalPrice: { value: 18900, currency: "MXN" },
          fulfil: { method: "pickup", slot: { start: "2026-11-04T23:30:00Z" } },
          kitchen: { instant: false, hold },
        },
      });
    expect(cardTitle(order([]), "America/Mexico_City", now)).toBe("1 item · pick-up 17:30");
    expect(fulfilFact(order([]), "America/Mexico_City", now)).toEqual(["Pick-up", "Today, 17:30"]);
    expect(holdNotes(order(["allergens_unconfirmed", "owner_accepts"]))).toEqual([
      "Allergens on this order are not confirmed yet: check them with the kitchen before you accept.",
    ]);
    expect(holdNotes(order([]))).toEqual([]);
    expect(holdNotes(view({}))).toEqual([]);
  });
});
