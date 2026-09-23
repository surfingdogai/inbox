import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import {
  type Caller,
  generateKeyPair,
  MANIFEST_PATH,
  networkSuccessStatement,
  type PublicJwk,
  schema,
  signRequest,
  TAG_AGENT,
  thumbprint,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { fakeNetwork } from "../../../packages/adapters/test/fake-network";
import { type App, createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * People through the doors an agent uses (ADR-017 §2, §8.4): REST and MCP answer a first booking
 * with the pass to keep and say so in words; a pass in `Sdi-Pass` is enough to read the item later;
 * a weak match proves itself with a code; a signed request is verified, its failure said in
 * `Sdi-Signature`, and a copy refused unless it is a retry. Runs on Node and inside workerd.
 */
const ORIGIN = "https://inbox.example.com";
const HOST = "net.example.com";
const NET = `https://${HOST}`;
const T0 = Date.parse("2026-09-23T09:00:00Z");

async function setup() {
  const db = await freshDb();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const mail = logMailOut();
  let inboxRef: ReturnType<typeof createInbox> | null = null;
  const net = fakeNetwork({
    host: HOST,
    keys: async () => (await (inboxRef as ReturnType<typeof createInbox>).caps.receipts.jwks()).keys as PublicJwk[],
    instanceDomain: "inbox.example.com",
  });
  const inbox = createInbox({
    db,
    mailOut: mail,
    secretKey: "identity-app-instance-key-0123456789",
    baseUrl: ORIGIN,
    fetchImpl: net.fetchImpl,
    background: () => {},
  });
  inboxRef = inbox;
  const ownerCaller: Caller = {
    actor: { kind: "owner", id: "u1", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
  };
  await inbox.caps.updateSettings(ownerCaller, {
    doc: {
      networks: { [NET]: { enabled: true, share: { listing: false, counts: false, receipts: false } } },
      business: { name: "Oficina Maré" },
    },
  });
  await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
  // The network has verified this inbox, so a customer's address may go to it (Tiago, 23 Sep 2026).
  await db.client.query(networkSuccessStatement(NET, Date.now(), { registration: "registered", pinged: true }));
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  return { db, svc, inbox, app: inbox.app, mail, net, ownerKey: owner.key };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const booking = (svc: string, day = 2) => ({
  reservationFor: { serviceId: svc, name: "Surf lesson" },
  startTime: new Date(Date.now() + day * 86_400_000).toISOString(),
  endTime: new Date(Date.now() + day * 86_400_000 + 90 * 60_000).toISOString(),
});

async function connect(app: App, headers: Record<string, string> = {}) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return app.request(String(input), { ...init, headers: merged });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: fetchLike });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

type Created = {
  view: { item: { id: string; partyId: string } };
  accessToken: string;
  identity: { recognised: string; passes: { network: string; pass: string }[]; verify: { available: boolean } };
};

describe("people at the doors", () => {
  it("hands a first booking's pass back over REST, reads the item by pass alone, and says so in the manifest", async () => {
    const s = await setup();
    const res = await s.app.request(
      post("/v1/bookings", { payload: booking(s.svc), contact: { name: "Rita", email: "rita@example.com" } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.identity).toMatchObject({ recognised: "none", verify: { available: false } });
    const pass = body.identity.passes[0]?.pass as string;
    expect(pass).toMatch(/^sdpass1_net\.example\.com_/);

    // Later, with nothing but the pass in Sdi-Pass (never in a URL), the item is theirs to read.
    const status = await s.app.request(
      new Request(`${ORIGIN}/v1/items/${body.view.item.id}`, { headers: { "Sdi-Pass": `"${pass}"` } }),
    );
    expect(status.status).toBe(200);
    const read = (await status.json()) as { identity: { passes: unknown[] } };
    expect(read.identity.passes).toEqual(body.identity.passes);
    // Without it, it is someone else's.
    const stranger = await s.app.request(new Request(`${ORIGIN}/v1/items/${body.view.item.id}`));
    expect(stranger.status).toBe(403);

    const manifest = (await (await s.app.request(`${ORIGIN}${MANIFEST_PATH}`)).json()) as {
      agent_policy: Record<string, unknown>;
    };
    expect(manifest.agent_policy).toEqual({
      tiers: ["anonymous", "signed_agent", "verified_principal", "reputed_principal"],
      signatures: ["sdi-agent/1"],
      passes: true,
      networks: [NET],
      guide: "https://surfingdog.ai/for-agents.md",
    });
  });

  it("says the pass to keep in the MCP result's text, which many assistants read alone", async () => {
    const s = await setup();
    const client = await connect(s.app);
    const args = {
      payload: booking(s.svc),
      contact: { name: "Rita", email: "rita@example.com" },
      idempotency_key: "b-1",
    };
    const r = (await client.callTool({ name: "create_booking", arguments: args })) as {
      content: { text: string }[];
      structuredContent: Created;
    };
    const text = r.content[0]?.text ?? "";
    const pass = r.structuredContent.identity.passes[0]?.pass as string;
    expect(text.endsWith(`Keep this pass for Rita: ${pass} (network ${HOST}).`)).toBe(true);
    // Said to the assistant, and nothing it is asked to pass on to Rita about keys or networks.
    expect(text).not.toMatch(/Tell Rita|comes by email/);
    // The same request again: the same item, the same pass, and no second first contact.
    const again = (await client.callTool({ name: "create_booking", arguments: args })) as {
      structuredContent: Created & { replayed?: boolean };
    };
    expect(again.structuredContent.replayed).toBe(true);
    expect(again.structuredContent.identity.passes).toEqual(r.structuredContent.identity.passes);
    expect(s.net.calls.filter((c) => c.path === "/v1/persons")).toHaveLength(1);
  });

  it("proves a weak match over REST with a code sent to the known address", async () => {
    const s = await setup();
    s.net.addPerson("ana@example.pt"); // known to the network already: no first contact is issued
    await s.app.request(
      post("/v1/bookings", { payload: booking(s.svc, 2), contact: { name: "Ana Silva", email: "ana@example.pt" } }),
    );
    const weak = (await (
      await s.app.request(post("/v1/bookings", { payload: booking(s.svc, 3), contact: { email: "ana@example.pt" } }))
    ).json()) as Created;
    expect(weak.identity).toMatchObject({ recognised: "weak", verify: { available: true } });
    const sent = await s.app.request(
      post("/v1/customers/verify", { item_id: weak.view.item.id, access_token: weak.accessToken }),
    );
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ sent_to: "a•••@e•••.pt" });
    // From the business, under its own name, like every other email the customer gets from it.
    expect(s.mail.sent.at(-1)).toMatchObject({
      from: { name: "Oficina Maré" },
      subject: "Your code for Oficina Maré",
    });
    const code = /\b(\d{6})\b/.exec(s.mail.sent.at(-1)?.text ?? "")?.[1] as string;
    const wrong = await s.app.request(
      post("/v1/customers/verify", {
        item_id: weak.view.item.id,
        access_token: weak.accessToken,
        code: code === "000000" ? "111111" : "000000",
      }),
    );
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: "bad_code" });
    const ok = await s.app.request(
      post("/v1/customers/verify", { item_id: weak.view.item.id, access_token: weak.accessToken, code }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ recognised: "strong" });
    const again = await s.app.request(
      post("/v1/customers/verify", { item_id: weak.view.item.id, access_token: weak.accessToken }),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "already_verified" });
  });

  it("verifies a signed request, says why one fails, and refuses a copy that is not a retry", async () => {
    const s = await setup();
    const key = await generateKeyPair();
    const make = async (body: string, extra: Record<string, string> = {}, url = `${ORIGIN}/v1/bookings`) => {
      const jwk = { kty: "OKP", crv: "Ed25519", x: key.publicJwk.x };
      let binary = "";
      for (const b of new TextEncoder().encode(JSON.stringify(jwk))) binary += String.fromCharCode(b);
      const headers = { "Sdi-Agent-Key": `sig1=:${btoa(binary)}:`, ...extra };
      const created = Math.floor(Date.now() / 1000);
      const signed = await signRequest({
        method: "POST",
        url,
        body,
        headers,
        covered: [{ name: "sdi-agent-key", key: "sig1" }],
        keyid: await thumbprint(jwk),
        privateJwk: key.privateJwk,
        tag: TAG_AGENT,
        created,
        expires: created + 60,
      });
      return { headers: { "content-type": "application/json", ...signed.headers }, body };
    };
    const body = JSON.stringify({ payload: booking(s.svc), contact: { email: "sig@example.com" } });
    const good = await make(body, { "Idempotency-Key": "k-1" });
    const first = await s.app.request(new Request(`${ORIGIN}/v1/bookings`, { method: "POST", ...good }));
    expect(first.status).toBe(201);
    expect(first.headers.get("sdi-signature")).toBeNull();
    const item = ((await first.json()) as Created).view.item.id;
    const [row] = (
      await s.db.client.query({
        sql: "SELECT agent_level, agent_thumbprint FROM items WHERE id = ?",
        params: [item],
        method: "all",
      })
    ).rows;
    expect(row).toEqual(["self", await thumbprint(key.publicJwk)]);
    const events = await s.db.client.query({
      sql: "SELECT json_extract(meta, '$.tier') FROM item_events WHERE item_id = ? AND seq = 1",
      params: [item],
      method: "all",
    });
    expect(events.rows).toEqual([["signed_agent"]]);

    // The same signed request again, with its idempotency key: a retry, answered as the first was.
    const retry = await s.app.request(new Request(`${ORIGIN}/v1/bookings`, { method: "POST", ...good }));
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    // Without one, a copy.
    const bare = await make(body);
    expect((await s.app.request(new Request(`${ORIGIN}/v1/bookings`, { method: "POST", ...bare }))).status).toBe(201);
    const copy = await s.app.request(new Request(`${ORIGIN}/v1/bookings`, { method: "POST", ...bare }));
    expect(copy.status).toBe(401);
    expect(await copy.json()).toMatchObject({ code: "replayed_signature" });

    // Made for another host: it still books, unsigned, and the answer says why.
    const elsewhere = await make(body, {}, "https://elsewhere.example.com/v1/bookings");
    const wrong = await s.app.request(new Request(`${ORIGIN}/v1/bookings`, { method: "POST", ...elsewhere }));
    expect(wrong.status).toBe(201);
    expect(wrong.headers.get("sdi-signature")).toBe('invalid; reason="bad_signature"');
  });
});

describe("what a copy and the business cannot get (security review)", () => {
  /** A booking signed by an agent's own key, covering only what sdi-agent/1 requires. */
  async function signedBooking(key: Awaited<ReturnType<typeof generateKeyPair>>, body: string) {
    const jwk = { kty: "OKP", crv: "Ed25519", x: key.publicJwk.x };
    let binary = "";
    for (const b of new TextEncoder().encode(JSON.stringify(jwk))) binary += String.fromCharCode(b);
    const created = Math.floor(Date.now() / 1000);
    const signed = await signRequest({
      method: "POST",
      url: `${ORIGIN}/v1/bookings`,
      body,
      headers: { "Sdi-Agent-Key": `sig1=:${btoa(binary)}:` },
      covered: [{ name: "sdi-agent-key", key: "sig1" }],
      keyid: await thumbprint(jwk),
      privateJwk: key.privateJwk,
      tag: TAG_AGENT,
      created,
      expires: created + 60,
    });
    return signed.headers;
  }
  const send = (app: App, headers: Record<string, string>, body: string, extra: Record<string, string> = {}) =>
    app.request(
      new Request(`${ORIGIN}/v1/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "agent/1", ...headers, ...extra },
        body,
      }),
    );

  it("answers a copy of a signed request as a retry only for the same sender with the same key", async () => {
    const s = await setup();
    const key = await generateKeyPair();
    const count = async () =>
      Number((await s.db.client.query({ sql: "SELECT COUNT(*) FROM items", params: [], method: "all" })).rows[0]?.[0]);

    // The idempotency key in the body: covered by the digest, so a copy carries it too — and is
    // still a copy when it comes from anyone but the sender (another client here), never a second item.
    const withKey = JSON.stringify({
      payload: booking(s.svc),
      contact: { email: "sig@example.com" },
      idempotency_key: "b-1",
    });
    const h1 = await signedBooking(key, withKey);
    expect((await send(s.app, h1, withKey)).status).toBe(201);
    const retry = await send(s.app, h1, withKey);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    const elsewhere = await send(s.app, h1, withKey, { "user-agent": "someone-else/2" });
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.json()).toMatchObject({ code: "replayed_signature" });
    expect(await count()).toBe(1);

    // No key at first: a copy that adds an Idempotency-Key header of its own is still a copy.
    const bare = JSON.stringify({ payload: booking(s.svc, 3), contact: { email: "sig@example.com" } });
    const h2 = await signedBooking(key, bare);
    expect((await send(s.app, h2, bare)).status).toBe(201);
    const added = await send(s.app, h2, bare, { "Idempotency-Key": "fresh" });
    expect(added.status).toBe(401);
    expect(await count()).toBe(2);

    // The key in the header: a retry must carry the same one.
    const hdr = JSON.stringify({ payload: booking(s.svc, 4), contact: { email: "sig@example.com" } });
    const h3 = await signedBooking(key, hdr);
    expect((await send(s.app, h3, hdr, { "Idempotency-Key": "k-3" })).status).toBe(201);
    expect((await send(s.app, h3, hdr, { "Idempotency-Key": "k-3" })).status).toBe(200);
    expect((await send(s.app, h3, hdr, { "Idempotency-Key": "k-other" })).status).toBe(401);
    expect(await count()).toBe(3);
  });

  it("never hands the business a customer's pass through the customer's own door", async () => {
    const s = await setup();
    const created = (await (
      await s.app.request(
        post("/v1/bookings", { payload: booking(s.svc), contact: { name: "Rita", email: "rita@example.com" } }),
      )
    ).json()) as Created;
    expect(created.identity.passes).toHaveLength(1);
    const pass = created.identity.passes[0]?.pass as string;
    const read = async (headers: Record<string, string>) =>
      (await (await s.app.request(new Request(`${ORIGIN}/v1/items/${created.view.item.id}`, { headers }))).json()) as {
        identity: { passes: unknown[] };
      };

    // The creator, by its access token, gets it back; the owner's key reads the item and no pass.
    expect((await read({ "x-access-token": created.accessToken })).identity.passes).toEqual(created.identity.passes);
    expect((await read({ authorization: `Bearer ${s.ownerKey}` })).identity.passes).toEqual([]);
    // Nor over MCP.
    const client = await connect(s.app, { authorization: `Bearer ${s.ownerKey}` });
    const r = (await client.callTool({ name: "get_item_status", arguments: { item_id: created.view.item.id } })) as {
      content: { text: string }[];
      structuredContent: { identity: { passes: unknown[] } };
    };
    expect(r.structuredContent.identity.passes).toEqual([]);
    expect(r.content[0]?.text).not.toContain(pass);
  });
});
