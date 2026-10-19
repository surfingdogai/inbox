import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { InboxClient } from "../src/lib/client";
import { type Native, webNative } from "../src/lib/native";
import { Box, type KV, Outbox } from "../src/lib/offline";
import { type Fetch, InboxError, Sessions } from "../src/lib/session";
import { actionsFor, badgeOf, needsYou, today } from "../src/lib/view";

/**
 * The phone app's own logic against a real inbox (ADR-026): pairing with a code from Settings → Phone,
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
  const code = async () => {
    const res = await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    const link = readPhoneLink(((await res.json()) as { qr: string }).qr);
    if (!link) throw new Error("no code");
    return link;
  };
  return {
    db,
    inbox,
    cookie,
    fetchImpl,
    code,
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

describe("pairing and tokens", () => {
  it("pairs with a scanned code, keeps the inbox, and reads it with its own tokens", async () => {
    const { fetchImpl, code } = await setup();
    const p = phone();
    const sessions = new Sessions(p, fetchImpl);
    const entry = await sessions.pair(await code());
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

  it("refreshes with the device key after a restart, and is signed out once removed", async () => {
    const { fetchImpl, code, cookie, inbox } = await setup();
    const p = phone();
    const first = new Sessions(p, fetchImpl);
    const entry = await first.pair(await code());
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
    const one = await sessions.pair(await a.code());
    const two = await sessions.pair({ ...(await a.code()), origin: ORIGIN });
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

  it("is told it is offline, not that the inbox failed", async () => {
    const s = await setup();
    const p = phone();
    const sessions = new Sessions(p, s.fetchImpl);
    const entry = await sessions.pair(await s.code());
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
});
