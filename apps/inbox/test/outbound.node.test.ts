import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiKey } from "@surfingdog/adapters";
import { type Db, schema, ulid } from "@surfingdog/core";
import { parseAddressRange } from "@surfingdog/platform";
import { pinnedFetch, type ResolvedAddress } from "@surfingdog/platform/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInbox, type Inbox } from "../src/app";
import { outboundDenyFrom } from "../src/env";
import { freshDb, futureDay, openWeekdays } from "./harness";

/**
 * The inbox's outbound calls on the Node server, end to end: a webhook, a test event and a product
 * feed go through `pinnedFetch`, which resolves each name, refuses one that reaches anything but a
 * public address (or the host's own, INBOX_OUTBOUND_DENY), and connects to the address it checked.
 * A local server stands in for what a refused call would have reached: an admin port on loopback.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = futureDay();
const SECRET_KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";
/** This server's own public address, as an operator would write it in INBOX_OUTBOUND_DENY. */
const OWN_ADDRESS = "203.0.114.7";

let server: Server;
let port = 0;
const reached: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    reached.push(`${req.method} ${req.headers.host}${req.url}`);
    req.resume();
    res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

/** What each name resolves to, standing in for DNS a stranger controls. */
const DNS: Record<string, string[]> = {
  "hooks.example.com": ["127.0.0.1"],
  "feed.example.com": ["169.254.169.254"],
  "self.example.com": [OWN_ADDRESS],
  "box.example.com": ["127.0.0.1"],
};
const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const all = DNS[hostname];
  if (!all) throw Object.assign(new Error(`${hostname} not found`), { code: "ENOTFOUND" });
  return all.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

async function setup() {
  const db = await freshDb();
  const serviceId = ulid(T0);
  await db.orm.insert(schema.services).values({
    id: serviceId,
    name: "Full service",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  await openWeekdays(db);
  const ownerKey = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
  const pending: Promise<unknown>[] = [];
  const { ranges: deny } = outboundDenyFrom(OWN_ADDRESS);
  const inbox = createInbox({
    db,
    secretKey: SECRET_KEY,
    baseUrl: "https://inbox.example.com",
    eventSettleMs: 0,
    background: (work) => void pending.push(work),
    fetchImpl: pinnedFetch({ deny, resolve }),
    privateFetchImpl: pinnedFetch({ deny, resolve, allowPrivate: true }),
  });
  const owner = { authorization: `Bearer ${ownerKey}` };
  const call = (method: string, path: string, body?: unknown) =>
    inbox.app.request(
      new Request(`https://inbox.example.com${path}`, {
        method,
        headers: { ...owner, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const book = async () => {
    const res = await inbox.app.request(
      new Request("https://inbox.example.com/v1/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            reservationFor: { serviceId, name: "Full service" },
            startTime: `${DAY}T08:00:00Z`,
            endTime: `${DAY}T09:30:00Z`,
          },
          contact: { name: "Rita", email: "rita@example.com" },
        }),
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
  };
  const settle = async () => {
    await Promise.all(pending);
    await drain(inbox, db);
  };
  return { db, inbox, call, book, settle };
}

async function drain(inbox: Inbox, db: Db): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    if ((await inbox.runner.runDue(db)).claimed === 0) return;
  }
  throw new Error("the outbox never settled");
}

async function hook(call: Awaited<ReturnType<typeof setup>>["call"], url: string): Promise<string> {
  const res = await call("POST", "/v1/owner/webhooks", { url, events: ["booking.*"] });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function lastError(call: Awaited<ReturnType<typeof setup>>["call"], id: string): Promise<string> {
  const res = await call("GET", `/v1/owner/webhooks/${id}/deliveries`);
  const page = (await res.json()) as { items: { status: string; last_error: string | null }[] };
  expect(page.items.length).toBeGreaterThan(0);
  expect(page.items.every((d) => d.status !== "delivered")).toBe(true);
  return page.items[0]?.last_error ?? "";
}

describe("outbound calls from the Node server", () => {
  it("refuses a webhook written as a loopback address before it is stored", async () => {
    const { call } = await setup();
    for (const url of [`http://127.0.0.1:${port}/stop`, "https://169.254.169.254/latest", "https://[::1]/hook"]) {
      const res = await call("POST", "/v1/owner/webhooks", { url, events: ["booking.*"] });
      expect(res.status, url).toBe(422);
    }
  });

  it("refuses to deliver to a public name that resolves to loopback, and says why", async () => {
    const { call, book, settle } = await setup();
    const before = reached.length;
    const id = await hook(call, `https://hooks.example.com:${port}/stop`);
    await book();
    await settle();
    expect(await lastError(call, id)).toContain("hooks.example.com resolves to 127.0.0.1, a loopback address");
    // A test event from Settings meets the same refusal.
    const test = await call("POST", `/v1/owner/webhooks/${id}/test`, {});
    expect(await test.json()).toMatchObject({
      delivered: false,
      error: "hooks.example.com resolves to 127.0.0.1, a loopback address: not called",
    });
    expect(reached.length).toBe(before);
  });

  it("refuses a feed whose name resolves to the metadata service", async () => {
    const { call, settle } = await setup();
    const res = await call("POST", "/v1/owner/feeds", { url: "https://feed.example.com/products.csv" });
    expect(res.status, await res.clone().text()).toBe(201);
    const feed = (await res.json()) as { id: string };
    await settle();
    const after = (await (await call("GET", `/v1/owner/feeds/${feed.id}`)).json()) as { last_error: string };
    expect(after.last_error).toContain("feed.example.com resolves to 169.254.169.254, a link-local address");
  });

  it("reaches a machine of the owner's own once private targets are allowed, and never the host's own address", async () => {
    const { call, book, settle } = await setup();
    const allowed = await call("PUT", "/v1/owner/settings", {
      doc: { integrations: { webhooks: { allowPrivateTargets: true } } },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    const own = await hook(call, "https://self.example.com/hook");
    const before = reached.length;
    await hook(call, `http://box.example.com:${port}/hook`);
    await book();
    await settle();
    expect(await lastError(call, own)).toContain(`self.example.com resolves to ${OWN_ADDRESS}, an address this host`);
    // The owner's machine got the booking, at the name the owner gave and the address it resolved to.
    expect(reached.slice(before)).toContain(`POST box.example.com:${port}/hook`);
  });
});

describe("INBOX_OUTBOUND_DENY", () => {
  it("reads into the ranges pinnedFetch refuses", () => {
    const { ranges, bad } = outboundDenyFrom(`${OWN_ADDRESS}, 2a01:4f8::/32`);
    expect(bad).toEqual([]);
    expect(ranges).toEqual([parseAddressRange(OWN_ADDRESS), parseAddressRange("2a01:4f8::/32")]);
  });
});
