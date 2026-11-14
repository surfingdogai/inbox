import { schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { PHONE_OPERATIONS } from "../../../packages/adapters/src/access";
import { readPhoneLink } from "../../../packages/core/src/phones/links";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { clientIp, signInByCode } from "../../inbox/test/owner-session";
import { priceOffer } from "../src/lib/chips";
import { InboxClient, sendQueued } from "../src/lib/client";
import { webNative } from "../src/lib/native";
import { Box, type KV, Outbox, type QueuedAction } from "../src/lib/offline";
import { type Fetch, Sessions } from "../src/lib/session";
import { Waiting } from "../src/lib/undo";

/**
 * Answering fast from the phone (ADR-028 Amendment 5): the chips' facts read as any assistant reads
 * them, the price sheet's price sent as the inbox's own offer, Undo before anything leaves, an answer
 * pressed offline kept with its idempotency key, a draft sent as it is, and no new power for a phone.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficina.example";
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

const visitor = {
  actor: { kind: "customer_human" as const, id: "anon:7", channel: "form" as const },
  tier: "anonymous" as const,
  sandbox: false,
};

async function setup() {
  const db = await freshDb();
  const mail = logMailOut(() => {});
  const inbox = createInbox({ db, mailOut: mail, ownerEmails: [OWNER], pushRelay: "off" });
  const cookie = await signInByCode(inbox.app, mail, ORIGIN, OWNER);
  /** Every request the phone made, and whether the inbox can be reached now. */
  const calls: { method: string; url: string; headers: Headers }[] = [];
  let offline = false;
  const fetchImpl: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url: input, headers });
    if (offline) throw new TypeError("Failed to fetch");
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
  const native = webNative(memory());
  const sessions = new Sessions(native, fetchImpl);
  const pending = await sessions.pair(link);
  await inbox.app.request(`${ORIGIN}/v1/owner/phones/pairings/${made.id}/confirm`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
  await sessions.confirmed(pending);
  const entry = await sessions.finish(pending);
  const client = new InboxClient(entry, sessions, fetchImpl);
  const outbox = new Outbox(await Box.open(native, memory()));
  return {
    db,
    inbox,
    client,
    outbox,
    calls,
    setOffline: (v: boolean) => {
      offline = v;
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function priceRequest(s: Setup): Promise<{ id: string; token: string }> {
  const r = await s.inbox.caps.requestQuote(visitor, {
    payload: { itemOffered: { name: "Wheel rebuild" }, description: "How much to rebuild a rear wheel?" },
    contact: { name: "Rui Costa", email: "rui@example.net" },
  });
  return { id: r.view.item.id, token: r.accessToken ?? "" };
}

/** One thing pressed on the phone, as the outbox keeps it. */
async function pressed(
  s: Setup,
  itemId: string,
  kind: QueuedAction["kind"],
  body: Record<string, unknown>,
): Promise<QueuedAction> {
  return s.outbox.add({ alias: s.client.entry.alias, itemId, kind, body, label: kind });
}

const sendAll = (s: Setup) => s.outbox.flush((a) => sendQueued(s.client, a));

describe("answering fast from the phone", { timeout: 30_000 }, () => {
  it("reads the prices and languages its chips are made from with no token, as any assistant does", async () => {
    const s = await setup();
    await s.db.orm.insert(schema.services).values({
      id: `svc_${crypto.randomUUID()}`,
      name: "Wheel rebuild",
      durationMin: 60,
      price: { model: "fixed", value: 8000, currency: "EUR" },
      createdAt: T,
      updatedAt: T,
    });
    s.calls.length = 0;
    const facts = await s.client.facts();
    expect(facts.services.map((x) => [x.name, x.price])).toEqual([
      ["Wheel rebuild", { model: "fixed", value: 8000, currency: "EUR" }],
    ]);
    expect(facts.languages).toContain("en");
    expect(facts.currency).toBe("EUR");
    expect(s.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`).sort()).toEqual([
      "GET /v1/business",
      "GET /v1/services",
    ]);
    for (const c of s.calls) expect(c.headers.has("authorization")).toBe(false);
  });

  it("sends the price sheet's price as the inbox's own offer, which the customer can accept", async () => {
    const s = await setup();
    const { id, token } = await priceRequest(s);
    const before = await s.client.item(id);
    await pressed(s, id, "offer", {
      input: priceOffer({ value: 8000, currency: "EUR" }, "About two hours."),
      expected_version: before.item.version,
    });
    expect(await sendAll(s)).toMatchObject({ sent: 1, refused: [], left: 0 });
    const after = await s.client.item(id);
    expect(after.item.state).toBe("quoted");
    expect(after.item.type === "quote_request" && after.item.payload.quote).toMatchObject({
      totalPrice: { value: 8000, currency: "EUR" },
      notes: "About two hours.",
    });
    // Built as the inbox builds every offer, open until a date: the customer's, or their assistant's, to accept.
    expect(
      after.item.type === "quote_request" && Date.parse(after.item.payload.quote?.validThrough ?? ""),
    ).toBeGreaterThan(Date.now());
    const theirs = await s.inbox.caps.getItemStatus(
      { ...visitor, accessToken: token },
      { item_id: id, access_token: token },
    );
    expect(theirs.transitions.map((t) => t.event)).toContain("accept");
  });

  it("sends nothing when Undo is pressed within the six seconds", async () => {
    const s = await setup();
    const { id } = await priceRequest(s);
    const before = await s.client.item(id);
    s.calls.length = 0;
    // As the item screen sends what waited: kept on the phone, then sent.
    let sending: Promise<void> = Promise.resolve();
    const waiting = new Waiting<Record<string, unknown>>((input) => {
      sending = (async () => {
        await pressed(s, id, "offer", { input, expected_version: before.item.version });
        await sendAll(s);
      })();
      return sending;
    }, 30);
    waiting.start(priceOffer({ value: 8000, currency: "EUR" }, ""));
    waiting.undo();
    await new Promise((r) => setTimeout(r, 80));
    await sending;
    expect(s.calls).toEqual([]);
    expect(await s.outbox.list()).toEqual([]);
    expect((await s.client.item(id)).item.state).toBe("received");
    // Not undone, it goes when its time is up.
    waiting.start(priceOffer({ value: 8000, currency: "EUR" }, ""));
    await new Promise((r) => setTimeout(r, 80));
    await sending;
    expect((await s.client.item(id)).item.state).toBe("quoted");
  });

  it("keeps an answer pressed offline, and sends it once, under the key it was given", async () => {
    const s = await setup();
    const sent = await s.inbox.caps.sendMessage(visitor, {
      body: "Can I bring my bike in on Saturday?",
      contact: { name: "Ana Ribeiro", email: "ana@example.org" },
    });
    const id = (sent as { view: { item: { id: string } } }).view.item.id;
    s.setOffline(true);
    const chip = await pressed(s, id, "reply", { body: "Yes, we can.", internal: false });
    expect(await sendAll(s)).toMatchObject({ sent: 0, refused: [], left: 1 });
    expect((await s.outbox.list())[0]?.key).toBe(chip.key);
    s.setOffline(false);
    expect(await sendAll(s)).toMatchObject({ sent: 1, left: 0 });
    const posted = s.calls.filter((c) => c.method === "POST" && c.url.endsWith("/replies"));
    expect(new Set(posted.map((c) => c.headers.get("idempotency-key")))).toEqual(new Set([chip.key]));
    // Its answer lost on the way back, the same press sent again is the same reply, not a second one.
    expect(await sendQueued(s.client, chip)).toEqual({ ok: true });
    const item = await s.client.item(id);
    expect(item.item.state).toBe("answered");
    expect(item.thread.filter((t) => t.direction === "out").map((t) => t.body)).toEqual(["Yes, we can."]);
  });

  it("sends a draft as it is, and drops one, as the owner's own presses", async () => {
    const asked: { method: string; path: string; body: unknown; key: string | null }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const u = new URL(input);
      asked.push({
        method: init?.method ?? "GET",
        path: `${u.pathname}${u.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(JSON.stringify({ dropped: true }), { headers: { "content-type": "application/json" } });
    };
    const sessions = { token: async () => "sdi_pa_test" } as unknown as Sessions;
    const client = new InboxClient(
      { alias: "ib_1", origin: ORIGIN, name: "Oficina", deviceId: "d1", addedAt: 0 },
      sessions,
      fetchImpl,
    );
    const r = await sendQueued(client, {
      id: "q1",
      alias: "ib_1",
      itemId: "it_1",
      kind: "draft",
      body: { draft_id: "dr_1" },
      key: "phone-k1",
      label: "The drafted offer",
      at: 0,
    });
    expect(r).toEqual({ ok: true });
    await client.dropDraft("it_1", "dr_2");
    expect(asked).toEqual([
      { method: "POST", path: "/v1/owner/items/it_1/offers/draft/send", body: { draft_id: "dr_1" }, key: "phone-k1" },
      { method: "DELETE", path: "/v1/owner/items/it_1/offers/draft?draft_id=dr_2", body: null, key: null },
    ]);
  });

  it("gives a phone no new power: what it may do through the owner's door is as it was", () => {
    expect([...PHONE_OPERATIONS].sort()).toEqual(
      [
        "GET /items",
        "GET /items/:id",
        "POST /items/:id/transitions",
        "POST /items/:id/replies",
        "GET /items/:id/offers",
        "POST /items/:id/offers",
        "POST /items/:id/offers/draft/send",
        "DELETE /items/:id/offers/draft",
        "GET /items/:id/payments",
        "POST /items/:id/let-in",
        "POST /items/:id/looks-fine",
        "POST /items/:id/spam",
        "POST /items/:id/move-to-inbox",
        "DELETE /items/:id/notice",
        "DELETE /items/:id/notices-from-sender",
      ].sort(),
    );
  });
});
