import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb, futureDay, openWeekdays } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { InboxClient, sendLater, sendQueued } from "../src/lib/client";
import { NativeError, webNative } from "../src/lib/native";
import { Box, type KV, Outbox } from "../src/lib/offline";
import { type Fetch, InboxError, Sessions } from "../src/lib/session";

/**
 * What the owner did on the phone and could not send at once (ADR-028): it waits on the phone until
 * the inbox answers. Offline is one reason; an inbox that is briefly not answering (a gateway's 502,
 * a 503 while it is updated, a 429) and an unlock the owner did not give just then are others, and
 * none of them may drop an Accept. Only the inbox's own refusal does. Two things done at once, or a
 * press while the app sends what waited, never write over each other.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@barbearia.example";
const T = Date.now();

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

async function setup() {
  const db = await freshDb();
  const mail = logMailOut(() => {});
  const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off" });
  const cookie = await signInByCode(inbox.app, mail, ORIGIN, OWNER);
  /** What answers the phone's sends: the inbox, or a gateway in front of it that is not answering now. */
  let gateway: number | null = null;
  const fetchImpl: Fetch = async (input, init) => {
    if (gateway !== null && init?.method === "POST" && input.includes("/transitions"))
      return new Response("<html><body>Bad gateway</body></html>", {
        status: gateway,
        headers: { "content-type": "text/html" },
      });
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientIp());
    return inbox.app.request(input, { ...init, headers });
  };
  const made = (await (
    await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    })
  ).json()) as { id: string; qr: string };
  const link = readPhoneLink(made.qr);
  if (!link) throw new Error("no code");
  const p = webNative(memory());
  const sessions = new Sessions(p, fetchImpl);
  const pending = await sessions.pair(link);
  await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings/${made.id}/confirm`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
  await sessions.confirmed(pending);
  const entry = await sessions.finish(pending);
  const client = new InboxClient(entry, sessions, fetchImpl);
  const outbox = new Outbox(await Box.open(p, memory()));
  return {
    db,
    inbox,
    client,
    outbox,
    setGateway: (status: number | null) => {
      gateway = status;
    },
  };
}

/** A booking request a customer sent from the business's page. */
async function booking(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const id = `svc_${crypto.randomUUID()}`;
  await s.db.orm.insert(schema.services).values({
    id,
    name: "Cut",
    durationMin: 30,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 2500, currency: "EUR" },
    createdAt: T,
    updatedAt: T,
  });
  const day = futureDay(5);
  const visitor = {
    actor: { kind: "customer_human" as const, id: "anon:7", channel: "form" as const },
    tier: "anonymous" as const,
    sandbox: false,
  };
  const input = {
    payload: {
      reservationFor: { serviceId: id, name: "Cut" },
      startTime: `${day}T10:00:00Z`,
      endTime: `${day}T10:30:00Z`,
    },
    contact: { name: "Rui Costa", email: "rui@example.net" },
  };
  const sha = await s.inbox.caps.createBooking(visitor, input).then(
    () => null,
    (e: { details?: { terms_sha?: string } }) => e.details?.terms_sha ?? null,
  );
  const b = await s.inbox.caps.createBooking(visitor, { ...input, ...(sha ? { terms_sha: sha } : {}) });
  return b.view.item.id;
}

describe("what waits to be sent", () => {
  it("waits on the phone while the inbox is not answering, and goes once it does", async () => {
    const s = await setup();
    await openWeekdays(s.db);
    const id = await booking(s);
    const before = await s.client.item(id);
    await s.outbox.add({
      alias: s.client.entry.alias,
      itemId: id,
      kind: "transition",
      body: { event: "confirm", expected_version: before.item.version },
      label: "Accept 10:00",
    });
    const send = (a: Parameters<typeof sendQueued>[1]) => sendQueued(s.client, a);
    for (const status of [502, 503, 504, 429]) {
      s.setGateway(status);
      // Not refused: kept, with nothing said about it being refused.
      expect(await s.outbox.flush(send)).toMatchObject({ sent: 0, refused: [], left: 1 });
    }
    s.setGateway(null);
    expect(await s.outbox.flush(send)).toMatchObject({ sent: 1, refused: [], left: 0 });
    expect((await s.client.item(id)).item.state).toBe("confirmed");
  });

  it("drops only what the inbox itself refused, and says why", async () => {
    const s = await setup();
    await openWeekdays(s.db);
    const id = await booking(s);
    const before = await s.client.item(id);
    await s.client.transition(id, { event: "confirm", expected_version: before.item.version }, crypto.randomUUID());
    // Accepted on the computer meanwhile: the phone's Accept, at the old version, is refused for good.
    await s.outbox.add({
      alias: s.client.entry.alias,
      itemId: id,
      kind: "transition",
      body: { event: "confirm", expected_version: before.item.version },
      label: "Accept 10:00",
    });
    const r = await s.outbox.flush((a) => sendQueued(s.client, a));
    expect(r).toMatchObject({ sent: 0, left: 0 });
    expect(r.refused).toHaveLength(1);
  });

  it("tells waiting apart from refused", () => {
    expect(sendLater(new InboxError("offline", 0, "network"))).toBe(true);
    for (const status of [408, 423, 425, 429, 500, 502, 503, 504, 520])
      expect(sendLater(new InboxError("x", status, `http_${status}`)), String(status)).toBe(true);
    // The fingerprint was asked for and not given, or the key would not sign yet: it waits too.
    expect(sendLater(new NativeError("Unlock to continue.", "auth_required"))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 410, 422])
      expect(sendLater(new InboxError("x", status, `http_${status}`)), String(status)).toBe(false);
  });

  it("keeps a press made while what waited is being sent, and two presses at once", async () => {
    const p = webNative(memory());
    const outbox = new Outbox(await Box.open(p, memory()));
    const first = await outbox.add({
      alias: "ib_1",
      itemId: "i1",
      kind: "reply",
      body: { body: "Yes" },
      label: "Reply",
    });
    let pressed: Promise<unknown> | null = null;
    const r = await outbox.flush(async (a) => {
      // The owner presses Accept on another item while the first goes out.
      pressed ??= outbox.add({ alias: "ib_1", itemId: "i2", kind: "transition", body: {}, label: "Accept" });
      await pressed;
      return a.id === first.id ? { ok: true } : { ok: false, offline: true, reason: "offline" };
    });
    expect(r.sent).toBe(1);
    expect((await outbox.list()).map((a) => a.itemId)).toEqual(["i2"]);
    await Promise.all([
      outbox.add({ alias: "ib_1", itemId: "i3", kind: "reply", body: { body: "a" }, label: "Reply" }),
      outbox.add({ alias: "ib_1", itemId: "i4", kind: "reply", body: { body: "b" }, label: "Reply" }),
    ]);
    expect((await outbox.list()).map((a) => a.itemId)).toEqual(["i2", "i3", "i4"]);
    // Two flushes at once send each thing once.
    const sent: string[] = [];
    const go = async (a: { itemId: string }) => {
      sent.push(a.itemId);
      return { ok: true as const };
    };
    await Promise.all([outbox.flush(go), outbox.flush(go)]);
    expect(sent).toEqual(["i2", "i3", "i4"]);
    expect(await outbox.list()).toEqual([]);
  });
});
