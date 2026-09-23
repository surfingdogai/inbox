import { createApiKey } from "@surfingdog/adapters";
import { type Caller, type Db, type PublicJwk, schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { fakeNetwork } from "../../../packages/adapters/test/fake-network";
// The published verifier, by path (MIT, deliberately not a dependency of this AGPL app).
import { verifyWebhook } from "../../../packages/sdk/src/index";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * What an existing integration sees after people and outcomes arrive (ADR-017 §2.5, R18): a
 * request that carries no pass and no key is answered as before, with only the `identity` block
 * added; a network that is slow, down or hanging costs a booking at most the first contact's 3 s
 * and never fails it; the owner's rules still act in the pass that follows the request (on
 * Workers that pass is the request's `waitUntil`, and the next is the cron, minutes later); the
 * emails an order's cancellation sent are still sent; and webhook bodies only gain fields, signed
 * so the published helper accepts them. Runs on Node and inside workerd.
 */
const ORIGIN = "https://inbox.example.com";
const HOST = "net.example.com";
const NET = `https://${HOST}`;
const WEBHOOK = "https://receiver.example.com/hooks";
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
};

type NetworkMode = "none" | "answers" | "down" | "hangs";

async function setup(mode: NetworkMode, opts: { webhooks?: boolean } = {}) {
  const db = await freshDb();
  const svc = ulid();
  const now = Date.now();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: now,
    updatedAt: now,
  });
  let inboxRef: ReturnType<typeof createInbox> | null = null;
  const net = fakeNetwork({
    host: HOST,
    keys: async () => (await (inboxRef as ReturnType<typeof createInbox>).caps.receipts.jwks()).keys as PublicJwk[],
    instanceDomain: "inbox.example.com",
  });
  const outbound: string[] = [];
  const received: { headers: Headers; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push(url);
    if (url.startsWith(WEBHOOK)) {
      received.push({ headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    }
    if (url.startsWith(NET)) {
      if (mode === "down") throw new TypeError("connection refused");
      if (mode === "hangs") {
        // A network that accepted the connection and never answers: only the caller's abort ends it.
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return net.fetchImpl(input, init);
    }
    return new Response("not here", { status: 404 });
  };
  const pending: Promise<unknown>[] = [];
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    secretKey: "compat-reputation-instance-key-0123456789",
    baseUrl: ORIGIN,
    fetchImpl,
    // What Workers' waitUntil runs after each write: one pass of the job runner.
    background: (work) => void pending.push(work),
    eventSettleMs: 0,
  });
  inboxRef = inbox;
  await inbox.caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      ...(mode === "none"
        ? {}
        : { networks: { [NET]: { enabled: true, share: { listing: false, counts: false, receipts: false } } } }),
    },
  });
  // The owner's rule, as an existing instance has one: every booking request is confirmed at once.
  await inbox.caps.setup.createRule(owner, {
    name: "Confirm every booking",
    priority: 100,
    enabled: true,
    definition: {
      on: ["item.created"],
      if: { path: "item.type", op: "eq", value: "booking" },
      actions: [{ action: "transition", event: "confirm" }],
      stop: false,
      maxRunsPerItem: 1,
    },
  });
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "compat" })).key;
  let secret = "";
  if (opts.webhooks) {
    const created = await inbox.app.request(
      post("/v1/owner/webhooks", { url: WEBHOOK, events: ["booking.*", "order.*"], payload_style: "full" }, ownerKey),
    );
    expect(created.status).toBe(201);
    secret = ((await created.json()) as { secret: string }).secret;
  }
  await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
  pending.length = 0;
  outbound.length = 0;
  /** The pass Workers runs after the response, and nothing more. */
  const afterResponse = async () => {
    const work = [...pending];
    pending.length = 0;
    await Promise.all(work);
  };
  return { db, svc, inbox, app: inbox.app, net, outbound, received, secret, ownerKey, afterResponse };
}

function post(path: string, body: unknown, bearer?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

const booking = (svc: string, days = 2) => {
  const start = Math.ceil((Date.now() + days * 86_400_000) / 1_800_000) * 1_800_000;
  return {
    reservationFor: { serviceId: svc, name: "Surf lesson" },
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 90 * 60_000).toISOString(),
  };
};

async function stateOf(db: Db, id: string): Promise<string> {
  const { rows } = await db.client.query({ sql: "SELECT state FROM items WHERE id = ?", params: [id], method: "all" });
  return String(rows[0]?.[0]);
}

async function drain(inbox: ReturnType<typeof createInbox>, db: Db) {
  for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { limit: 100 })).claimed === 0) return;
}

describe("an existing integration after ADR-017", () => {
  it("answers a request with no pass or key as before, adding only identity, and calls no network when none is on", async () => {
    const s = await setup("none");
    const created = await s.app.request(
      post("/v1/bookings", { payload: booking(s.svc), contact: { name: "Rita", email: "rita@example.com" } }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown> & {
      view: { item: { id: string } };
      accessToken: string;
    };
    expect(Object.keys(body).sort()).toEqual(["accessToken", "identity", "replayed", "view"]);
    expect(Object.keys(body.view).sort()).toEqual(["human", "item", "transitions"]);
    expect(body.identity).toEqual({
      recognised: "none",
      passes: [],
      verify: { available: false, sent_to: null },
      networks: [],
      guide: "https://surfingdog.ai/for-agents.md",
    });
    const id = body.view.item.id;
    const status = await s.app.request(`${ORIGIN}/v1/items/${id}?access_token=${body.accessToken}`);
    expect(status.status).toBe(200);
    expect(Object.keys((await status.json()) as object).sort()).toEqual([
      "human",
      "identity",
      "item",
      "receipts",
      "transitions",
    ]);
    await s.afterResponse();
    expect(await stateOf(s.db, id)).toBe("confirmed");
    const cancelled = await s.app.request(
      post(`/v1/items/${id}/cancel`, { access_token: body.accessToken, reason: "plans changed" }),
    );
    expect(cancelled.status).toBe(200);
    expect(Object.keys((await cancelled.json()) as object).sort()).toEqual(["replayed", "view"]);
    // Nothing left this inbox: no network is on, and nobody signed anything.
    expect(s.outbound).toEqual([]);
  });

  for (const mode of ["answers", "down", "hangs"] as const) {
    it(`books a first contact when the network ${mode === "answers" ? "answers" : mode === "down" ? "is down" : "never answers"}, and the owner's rule confirms it in the pass after the request`, async () => {
      const s = await setup(mode);
      const started = Date.now();
      const res = await s.app.request(
        post("/v1/bookings", { payload: booking(s.svc), contact: { name: "Rita", email: "rita@example.com" } }),
      );
      const took = Date.now() - started;
      expect(res.status).toBe(201);
      // The first contact's budget (§2.1): 3 s for the network, whatever it does.
      expect(took).toBeLessThan(mode === "hangs" ? 4_500 : 1_500);
      const body = (await res.json()) as {
        view: { item: { id: string; state: string } };
        identity: { passes: unknown[]; networks: { network: string; state: string }[] };
      };
      expect(body.view.item.state).toBe("requested");
      expect(body.identity.networks).toEqual([{ network: NET, state: mode === "answers" ? "issued" : "pending" }]);
      expect(body.identity.passes).toHaveLength(mode === "answers" ? 1 : 0);
      // As before the change: the rule has run by the time the request's own after-work is done.
      await s.afterResponse();
      expect(await stateOf(s.db, body.view.item.id)).toBe("confirmed");
    }, 10_000);
  }

  it("still tells both sides when an accepted order is cancelled, by the customer or by the owner", async () => {
    const s = await setup("none");
    const order = async () => {
      const r = await s.app.request(
        post("/v1/orders", {
          payload: {
            orderedItem: [{ name: "Chain", quantity: 1, price: { value: 1500, currency: "EUR" } }],
            totalPrice: { value: 1500, currency: "EUR" },
          },
          contact: { name: "Rita", email: "rita@example.com" },
        }),
      );
      const b = (await r.json()) as { view: { item: { id: string } }; accessToken: string };
      const accepted = await s.app.request(
        post(`/v1/owner/items/${b.view.item.id}/transitions`, { event: "accept" }, s.ownerKey),
      );
      expect(accepted.status).toBe(200);
      return b;
    };
    const notified = async (id: string, event: string) => {
      const { rows } = await s.db.client.query({
        sql: "SELECT json_extract(payload, '$.to') FROM jobs WHERE kind = 'notify' AND json_extract(payload, '$.itemId') = ? AND json_extract(payload, '$.event') = ? ORDER BY 1",
        params: [id, event],
        method: "all",
      });
      return rows.map((r) => String(r[0]));
    };
    const byCustomer = await order();
    const cancelled = await s.app.request(
      post(`/v1/items/${byCustomer.view.item.id}/cancel`, { access_token: byCustomer.accessToken }),
    );
    expect(cancelled.status).toBe(200);
    expect(await notified(byCustomer.view.item.id, "cancel")).toEqual(["customer", "owner"]);

    const byOwner = await order();
    const dropped = await s.app.request(
      post(`/v1/owner/items/${byOwner.view.item.id}/transitions`, { event: "cancel" }, s.ownerKey),
    );
    expect(dropped.status).toBe(200);
    expect(await notified(byOwner.view.item.id, "cancel")).toEqual(["customer", "owner"]);
  });

  it("keeps every webhook field it had, adds the outcome, and signs it so the published helper verifies", async () => {
    const s = await setup("none", { webhooks: true });
    const res = await s.app.request(
      post("/v1/bookings", { payload: booking(s.svc), contact: { name: "Rita", email: "rita@example.com" } }),
    );
    const id = ((await res.json()) as { view: { item: { id: string } } }).view.item.id;
    await s.afterResponse();
    await drain(s.inbox, s.db);
    const done = await s.app.request(post(`/v1/owner/items/${id}/transitions`, { event: "complete" }, s.ownerKey));
    expect(done.status).toBe(200);
    await drain(s.inbox, s.db);
    const events = [];
    for (const r of s.received) {
      events.push(
        await verifyWebhook({
          payload: r.body,
          headers: r.headers,
          secret: s.secret,
          now: Number(r.headers.get("webhook-timestamp")) * 1000,
        }),
      );
    }
    expect(events.map((e) => e.type)).toEqual([
      "booking.create",
      "booking.confirm",
      "booking.receipt_issued",
      "booking.complete",
      "booking.receipt_issued",
    ]);
    // The full style as ADR-015 defined it: every member still there, the receipt gaining `outcome`.
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["data", "id", "timestamp", "type"]);
      const data = e.data as unknown as Record<string, unknown>;
      for (const k of [
        "id",
        "type",
        "state",
        "version",
        "url",
        "actor",
        "channel",
        "sandbox",
        "item",
        "transitions",
        "human",
        "party",
      ]) {
        expect(data, `${e.type} data.${k}`).toHaveProperty(k);
      }
      expect(Object.keys(data.item as object).sort()).toEqual([
        "channel",
        "closedAt",
        "createdAt",
        "flags",
        "id",
        "linkedItemId",
        "locationId",
        "partyId",
        "payload",
        "state",
        "subject",
        "type",
        "updatedAt",
        "version",
      ]);
      expect(Object.keys(data.party as object).sort()).toEqual(["email", "id", "kind", "name", "verified"]);
    }
    const receipts = events
      .filter((e) => e.type === "booking.receipt_issued")
      .map((e) => (e.data as unknown as { receipt: Record<string, unknown> }).receipt);
    for (const r of receipts) {
      expect(Object.keys(r).sort()).toEqual([
        "acknowledged_at",
        "id",
        "issued_at",
        "jws",
        "kind",
        "outcome",
        "payload",
      ]);
    }
    expect(receipts.map((r) => [r.kind, r.outcome])).toEqual([
      ["confirmed", null],
      ["outcome", "booking.completed"],
    ]);
  });
});
