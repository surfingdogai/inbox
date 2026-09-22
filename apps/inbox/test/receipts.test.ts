import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import {
  ACK_TYP,
  ALG,
  b64u,
  generateKeyPair,
  MANIFEST_PATH,
  type PublicJwk,
  receiptSha,
  schema,
  ulid,
  verifyReceipt,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Receipts through the doors an agent actually uses (ADR-016): REST to book, the owner's API to
 * confirm, the job runner to sign, REST to read and acknowledge, the JWKS to verify — and the
 * same acknowledgement through MCP. Runs on Node and inside workerd.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const ORIGIN = "https://inbox.test";

async function setup() {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  const inbox = createInbox({
    db,
    secretKey: "http-test-instance-key-0123456789",
    baseUrl: ORIGIN,
    // Jobs are drained by hand below, so the run is deterministic.
    background: () => {},
  });
  return { db, svc, inbox, app: inbox.app, ownerKey: owner.key };
}

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function counterSign(receiptId: string, receiptJws: string, iatSec: number) {
  const agent = await generateKeyPair();
  const enc = new TextEncoder();
  const header = { alg: ALG, typ: ACK_TYP, jwk: agent.publicJwk };
  const body = { rcp: receiptId, sha: await receiptSha(receiptJws), iat: iatSec };
  const input = `${b64u(enc.encode(JSON.stringify(header)))}.${b64u(enc.encode(JSON.stringify(body)))}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...agent.privateJwk, key_ops: ["sign"], ext: true },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(input) as BufferSource);
  return `${input}.${b64u(new Uint8Array(sig))}`;
}

async function connect(app: App, path: string) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> =>
    app.request(String(input), init);
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}${path}`), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

interface Receipt {
  id: string;
  kind: string;
  jws: string;
  payload: { iss: string; sub: string; itm: string; typ: string; knd: string };
  acknowledged_at: string | null;
}

async function bookAndConfirm(s: Awaited<ReturnType<typeof setup>>) {
  const created = await s.app.request(
    jsonPost("/v1/bookings", {
      payload: {
        reservationFor: { serviceId: s.svc, name: "Full service" },
        startTime: "2026-09-23T08:00:00Z",
        endTime: "2026-09-23T09:30:00Z",
        totalPrice: { value: 4500, currency: "EUR" },
      },
      contact: { name: "Rita", email: "rita@example.com" },
    }),
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { view: { item: { id: string } }; accessToken: string };
  const confirmed = await s.app.request(
    jsonPost(
      `/v1/owner/items/${body.view.item.id}/transitions`,
      { event: "confirm" },
      { authorization: `Bearer ${s.ownerKey}` },
    ),
  );
  expect(confirmed.status).toBe(200);
  const run = await s.inbox.runner.runDue(s.db, { workerId: "test" });
  expect(run.failed + run.dead).toBe(0);
  return { id: body.view.item.id, token: body.accessToken };
}

describe("the manifest", () => {
  it("names the network under review_services once the owner joins", async () => {
    const s = await setup();
    const before = (await (await s.app.request(`${ORIGIN}${MANIFEST_PATH}`)).json()) as { review_services: string[] };
    expect(before.review_services).toEqual([]);
    const put = await s.app.request(
      new Request(`${ORIGIN}/v1/owner/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.ownerKey}` },
        body: JSON.stringify({ doc: { network: { url: "https://network.surfingdog.ai", join: true } } }),
      }),
    );
    expect(put.status).toBe(200);
    const after = (await (await s.app.request(`${ORIGIN}${MANIFEST_PATH}`)).json()) as { review_services: string[] };
    expect(after.review_services).toEqual(["https://network.surfingdog.ai"]);
  });
});

describe("receipts over HTTP", () => {
  it("are issued on confirm, readable by the customer, verifiable by the JWKS and named in the manifest", async () => {
    const s = await setup();
    const { id, token } = await bookAndConfirm(s);

    const status = await s.app.request(`${ORIGIN}/v1/items/${id}?access_token=${token}`);
    expect(status.status).toBe(200);
    const { receipts } = (await status.json()) as { receipts: Receipt[] };
    expect(receipts).toHaveLength(1);
    const rcp = receipts[0] as Receipt;
    expect(rcp.kind).toBe("confirmed");
    expect(rcp.acknowledged_at).toBeNull();
    expect(rcp.payload).toMatchObject({ iss: ORIGIN, itm: id, typ: "booking", knd: "confirmed" });

    const jwksRes = await s.app.request(`${ORIGIN}/.well-known/jwks.json`);
    expect(jwksRes.status).toBe(200);
    expect(jwksRes.headers.get("cache-control")).toContain("max-age=300");
    const jwks = (await jwksRes.json()) as { keys: PublicJwk[] };
    expect(jwks.keys).toHaveLength(1);
    expect(await verifyReceipt(rcp.jws, jwks.keys)).toMatchObject({ itm: id, amt: { value: 4500, currency: "EUR" } });

    const manifest = (await (await s.app.request(`${ORIGIN}${MANIFEST_PATH}`)).json()) as {
      receipt_keys: { keys: unknown[] };
    };
    expect(manifest.receipt_keys.keys).toEqual(jwks.keys);

    // The owner's detail carries it as well.
    const detail = await s.app.request(`${ORIGIN}/v1/owner/items/${id}`, {
      headers: { authorization: `Bearer ${s.ownerKey}` },
    });
    expect(((await detail.json()) as { receipts: Receipt[] }).receipts.map((r) => r.id)).toEqual([rcp.id]);
  });

  it("take a counter-signature from the customer's agent, and refuse a bad one", async () => {
    const s = await setup();
    const { id, token } = await bookAndConfirm(s);
    const [rcp] = (
      (await (await s.app.request(`${ORIGIN}/v1/items/${id}?access_token=${token}`)).json()) as { receipts: Receipt[] }
    ).receipts as [Receipt];
    const nowSec = Math.floor(Date.now() / 1000);

    // Nobody's item without the token.
    const anon = await s.app.request(
      jsonPost(`/v1/items/${id}/receipt-ack`, { counter_signature: await counterSign(rcp.id, rcp.jws, nowSec) }),
    );
    expect(anon.status).toBe(403);

    // A signature over the wrong receipt id.
    const wrong = await s.app.request(
      jsonPost(`/v1/items/${id}/receipt-ack`, {
        counter_signature: await counterSign("01NOTAREALRECEIPT", rcp.jws, nowSec),
        access_token: token,
      }),
    );
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get("content-type")).toContain("application/problem+json");

    // The real thing, token in the header this time.
    const ok = await s.app.request(
      jsonPost(
        `/v1/items/${id}/receipt-ack`,
        { counter_signature: await counterSign(rcp.id, rcp.jws, nowSec), receipt: rcp.jws },
        { "x-access-token": token },
      ),
    );
    expect(ok.status).toBe(200);
    const acked = (await ok.json()) as Receipt;
    expect(acked.id).toBe(rcp.id);
    expect(acked.acknowledged_at).not.toBeNull();

    const after = (await (await s.app.request(`${ORIGIN}/v1/items/${id}?access_token=${token}`)).json()) as {
      receipts: Receipt[];
    };
    expect(after.receipts[0]?.acknowledged_at).toBe(acked.acknowledged_at);
  });

  it("are acknowledged through MCP with the same rules", async () => {
    const s = await setup();
    const { id, token } = await bookAndConfirm(s);
    const client = await connect(s.app, "/mcp");
    const tools = await client.listTools();
    const ack = tools.tools.find((t) => t.name === "acknowledge_receipt");
    expect(ack?.description).toContain("sdi-receipt-ack+jws");

    const read = await client.callTool({ name: "get_item_status", arguments: { item_id: id, access_token: token } });
    const view = read.structuredContent as { receipts: Receipt[] };
    expect(view.receipts).toHaveLength(1);
    const rcp = view.receipts[0] as Receipt;

    const res = await client.callTool({
      name: "acknowledge_receipt",
      arguments: {
        item_id: id,
        access_token: token,
        counter_signature: await counterSign(rcp.id, rcp.jws, Math.floor(Date.now() / 1000)),
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect((res.structuredContent as Receipt).acknowledged_at).not.toBeNull();
    expect(String((res.content as { text: string }[])[0]?.text)).toContain("acknowledged");

    const stale = await client.callTool({
      name: "acknowledge_receipt",
      arguments: {
        item_id: id,
        access_token: token,
        counter_signature: await counterSign(rcp.id, rcp.jws, Math.floor(Date.now() / 1000) - 86_400),
      },
    });
    // Already acknowledged, so a stale second one is still refused on its own merits first.
    expect(stale.isError).toBe(true);
    expect(String((stale.content as { text: string }[])[0]?.text)).toMatch(/old|expired/);
  });
});
