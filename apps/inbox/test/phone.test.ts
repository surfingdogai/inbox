import { createApiKey } from "@surfingdog/adapters";
import {
  b64uDecode,
  b64uEncode,
  decryptPush,
  pkceS256,
  proofStatement,
  readPhoneLink,
  schema,
  sha256b64u,
  signProof,
  ulid,
  verifyInstanceRequest,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type App, createInbox } from "../src/app";
import { freshDb, futureDay, openWeekdays } from "./harness";
import { clientIp, signInByCode } from "./owner-session";

/**
 * The phone app's doors, over HTTP (ADR-028): Settings → Phone shows a QR code only to the owner
 * signed in on a computer; the phone pairs with it and gets tokens bound to its device key; a phone
 * answers the inbox and nothing else; notifications reach it through a relay that sees ciphertext.
 */
const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficinamare.pt";
const RELAY = "https://relay.test";
const KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";

async function makePhone() {
  const device = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", device.publicKey);
  const push = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", push.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    key: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
    sign: (s: string) => signProof(device.privateKey, s),
    push: { privateKey: push.privateKey, publicPoint: point, auth },
    pushKeys: { p256dh: b64uEncode(point), auth: b64uEncode(auth) },
  };
}

/** What the relay is asked to do, as the inbox's outbound fetch carries it. */
function relayFetch() {
  const calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
    auth: string | null;
    request: Request;
    text: string;
  }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== RELAY) return new Response("no", { status: 599 });
    const text = init?.body ? String(init.body) : "";
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      auth: headers.get("authorization"),
      request: new Request(url, { method: init?.method ?? "GET", headers }),
      text,
    });
    if (url.pathname === "/v1/devices" && init?.method === "POST")
      return Response.json({ device: "pd_1", secret: "ps_relay_secret" }, { status: 201 });
    if (url.pathname.endsWith("/messages")) return Response.json({ status: "sent" }, { status: 200 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function setup() {
  const db = await freshDb();
  const mail = logMailOut();
  const relay = relayFetch();
  const inbox = createInbox({
    db,
    mailOut: mail,
    ownerEmails: [OWNER],
    secretKey: KEY,
    fetchImpl: relay.fetchImpl,
    pushRelay: RELAY,
  });
  const cookie = await signInByCode(inbox.app, mail, ORIGIN, OWNER);
  return { db, mail, relay, inbox, app: inbox.app, cookie };
}

const ownerReq = (app: App, cookie: string, method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, {
    method,
    headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const phoneReq = (app: App, token: string | null, method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "cf-connecting-ip": clientIp(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

type Phone = Awaited<ReturnType<typeof makePhone>>;

/** The phone scans; the owner confirms on the computer unless `confirm` is false. */
async function pairPhone(app: App, cookie: string, phone: Phone, opts: { confirm?: boolean } = {}) {
  const made = await ownerReq(app, cookie, "POST", "/v1/owner/phones/pairings");
  expect(made.status).toBe(201);
  const { id, qr } = (await made.json()) as { id: string; qr: string };
  const link = readPhoneLink(qr);
  expect(link?.kind).toBe("pair");
  expect(link?.origin).toBe(ORIGIN);
  if (!link) throw new Error("no link");
  const at = Date.now();
  const res = await phoneReq(app, null, "POST", "/v1/phone/pair", {
    secret: link.secret,
    device_key: phone.key,
    at,
    proof: await phone.sign(proofStatement("pair", link.origin, await sha256b64u(link.secret), at)),
    name: "Pixel 8",
    platform: "android",
  });
  expect(res.status).toBe(201);
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    device_id: string;
    state: string;
    match: string;
  };
  if (opts.confirm !== false)
    expect((await ownerReq(app, cookie, "POST", `/v1/owner/phones/pairings/${id}/confirm`)).status).toBe(200);
  return { pairing: id, tokens };
}

/** Waits for what the inbox does after answering (an email sent in the background). */
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("Settings → Phone", () => {
  it("shows a QR code only to the owner signed in on a computer", async () => {
    const { db, app, cookie } = await setup();
    // A key from the command line, and a cookie posted from another site: no code.
    const key = (await createApiKey(db, { kind: "owner", name: "cli" })).key;
    const byKey = await app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(byKey.status).toBe(401);
    const crossSite = await app.request(`${ORIGIN}/v1/owner/phones/pairings`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    const ok = await ownerReq(app, cookie, "POST", "/v1/owner/phones/pairings");
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = (await ok.json()) as { qr: string; expires_at: string };
    expect(body.qr).toMatch(/^https:\/\/inbox\.test\/phone#v=1&pair=sdi_pp_/);
  });

  it("lets a phone in only on the owner's Confirm, tells the owner by email, and lists it", async () => {
    const { app, cookie, mail } = await setup();
    const phone = await makePhone();
    const { pairing, tokens } = await pairPhone(app, cookie, phone, { confirm: false });
    expect(tokens.access_token).toMatch(/^sdi_pa_/);
    expect(tokens).toMatchObject({ state: "pending", match: expect.stringMatching(/^\d{2}$/) });
    // Waiting: the phone may ask whether it was confirmed, and nothing else.
    const me = (await (await phoneReq(app, tokens.access_token, "GET", "/v1/phone/me")).json()) as {
      phone: { confirmed: boolean };
    };
    expect(me.phone.confirmed).toBe(false);
    for (const [method, path] of [
      ["GET", "/v1/owner/items"],
      ["PUT", "/v1/phone/push"],
      ["GET", "/v1/phone/phones"],
    ] as const)
      expect((await phoneReq(app, tokens.access_token, method, path, method === "PUT" ? {} : undefined)).status).toBe(
        403,
      );
    // The computer shows the phone and the two digits it shows.
    const asking = (await (await ownerReq(app, cookie, "GET", `/v1/owner/phones/pairings/${pairing}`)).json()) as {
      state: string;
      match: string;
      phone: { name: string };
    };
    expect(asking).toMatchObject({ state: "confirm", match: tokens.match, phone: { name: "Pixel 8" } });
    const sentBefore = mail.sent.length;
    expect((await ownerReq(app, cookie, "POST", `/v1/owner/phones/pairings/${pairing}/confirm`)).status).toBe(200);
    const status = (await (await ownerReq(app, cookie, "GET", `/v1/owner/phones/pairings/${pairing}`)).json()) as {
      state: string;
      phone: { name: string };
    };
    expect(status).toMatchObject({ state: "paired", phone: { name: "Pixel 8" } });
    expect((await phoneReq(app, tokens.access_token, "GET", "/v1/owner/items")).status).toBe(200);
    await settle(() => mail.sent.length > sentBefore);
    const email = mail.sent.at(-1);
    expect(email?.subject).toContain("A phone was connected");
    // It leads with what to do when it was not the owner, and says the kind of phone, never its own name.
    expect(email?.text?.startsWith("Not you? Remove it now")).toBe(true);
    expect(email?.text).toContain(`${ORIGIN}/settings/phone`);
    expect(email?.text).toContain("Phone: an Android phone\n");
    expect(email?.text).not.toContain("Pixel");
    const list = (await (await ownerReq(app, cookie, "GET", "/v1/owner/phones")).json()) as {
      phones: { name: string; push: string }[];
      push: { available: boolean };
    };
    expect(list.phones).toMatchObject([{ name: "Pixel 8", push: "off" }]);
    expect(list.push.available).toBe(true);
  });

  it("removes a phone the owner says is not theirs, before it opens anything", async () => {
    const { app, cookie } = await setup();
    const { pairing, tokens } = await pairPhone(app, cookie, await makePhone(), { confirm: false });
    const refused = await ownerReq(app, cookie, "POST", `/v1/owner/phones/pairings/${pairing}/refuse`);
    expect(await refused.json()).toEqual({ removed: true });
    expect((await phoneReq(app, tokens.access_token, "GET", "/v1/phone/me")).status).toBe(401);
    expect((await ownerReq(app, cookie, "POST", `/v1/owner/phones/pairings/${pairing}/confirm`)).status).toBe(422);
  });
});

describe("what a phone may do", () => {
  it("answers the inbox, and nothing else: no settings, keys, phones, downloads, owner MCP or public writes", async () => {
    const { app, cookie } = await setup();
    const { tokens } = await pairPhone(app, cookie, await makePhone());
    const t = tokens.access_token;
    expect((await phoneReq(app, t, "GET", "/v1/owner/items")).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/v1/owner/settings", undefined],
      ["PUT", "/v1/owner/settings", { doc: {} }],
      ["GET", "/v1/owner/api-keys", undefined],
      ["POST", "/v1/owner/api-keys", { name: "x", scopes: ["inbox:read"] }],
      ["GET", "/v1/owner/phones", undefined],
      ["POST", "/v1/owner/phones/pairings", undefined],
      ["GET", "/v1/owner/download", undefined],
      ["GET", "/v1/owner/catalogue/floors", undefined],
      ["POST", "/v1/messages", { text: "hi", contact: { email: "a@example.com" } }],
    ] as const) {
      const res = await phoneReq(app, t, method, path, body);
      expect([401, 403], `${method} ${path}`).toContain(res.status);
    }
    const mcp = await app.request(`${ORIGIN}/mcp/owner`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
  });

  it("is nobody on the public doors: no MCP, no customer's item", async () => {
    const { app, cookie } = await setup();
    const { tokens } = await pairPhone(app, cookie, await makePhone());
    const t = tokens.access_token;
    const mcp = (body: unknown) =>
      app.request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${t}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": clientIp(),
        },
        body: JSON.stringify(body),
      });
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect(
      (
        await mcp({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "send_message", arguments: { text: "hi", contact: { email: "a@example.com" } } },
        })
      ).status,
    ).toBe(401);
    // Reading the customers' own door is refused too, not only writing to it.
    expect((await phoneReq(app, t, "GET", "/v1/items/01ANYTHING")).status).toBe(403);
    expect((await phoneReq(app, t, "GET", "/v1/business")).status).toBe(403);
  });

  it("refreshes with a proof from its key, and stops when the owner removes it", async () => {
    const { app, cookie } = await setup();
    const phone = await makePhone();
    const { tokens } = await pairPhone(app, cookie, phone);
    const at = Date.now();
    const refreshed = await phoneReq(app, null, "POST", "/v1/phone/token", {
      refresh_token: tokens.refresh_token,
      at,
      proof: await phone.sign(proofStatement("refresh", ORIGIN, await sha256b64u(tokens.refresh_token), at)),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; device_id: string };
    expect((await phoneReq(app, next.access_token, "GET", "/v1/phone/me")).status).toBe(200);
    expect((await ownerReq(app, cookie, "DELETE", `/v1/owner/phones/${next.device_id}`)).status).toBe(200);
    expect((await phoneReq(app, next.access_token, "GET", "/v1/owner/items")).status).toBe(401);
  });
});

describe("a lost phone", () => {
  it("is removed from another of the owner's phones, which sees them all", async () => {
    const { app, cookie } = await setup();
    const kept = await pairPhone(app, cookie, await makePhone());
    const lost = await pairPhone(app, cookie, await makePhone());
    const list = (await (await phoneReq(app, kept.tokens.access_token, "GET", "/v1/phone/phones")).json()) as {
      phones: { id: string }[];
      this: string;
    };
    expect(list.this).toBe(kept.tokens.device_id);
    // The owner's own phones: the ones this phone may remove.
    expect(list.phones.map((p) => p.id).sort()).toEqual([kept.tokens.device_id, lost.tokens.device_id].sort());
    const removed = await phoneReq(
      app,
      kept.tokens.access_token,
      "DELETE",
      `/v1/phone/phones/${lost.tokens.device_id}`,
    );
    expect(removed.status).toBe(200);
    expect((await phoneReq(app, lost.tokens.access_token, "GET", "/v1/owner/items")).status).toBe(401);
    expect((await phoneReq(app, kept.tokens.access_token, "GET", "/v1/owner/items")).status).toBe(200);
  });
});

describe("the sign-in link", () => {
  it("emails a link the asking phone alone can redeem, and says the same to a stranger's address", async () => {
    const { app, mail } = await setup();
    const phone = await makePhone();
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const ask = (email: string) =>
      phoneReq(app, null, "POST", "/v1/phone/link", {
        email,
        challenge: "",
        device_key: phone.key,
      });
    const before = mail.sent.length;
    const stranger = await phoneReq(app, null, "POST", "/v1/phone/link", {
      email: "nobody@example.com",
      challenge: await pkceS256(verifier),
      device_key: phone.key,
    });
    expect(stranger.status).toBe(202);
    await settle(() => false);
    expect(mail.sent.length).toBe(before);
    expect((await ask(OWNER)).status).toBe(422);
    const owner = await phoneReq(app, null, "POST", "/v1/phone/link", {
      email: OWNER,
      challenge: await pkceS256(verifier),
      device_key: phone.key,
    });
    expect(owner.status).toBe(202);
    expect(await owner.json()).toEqual(
      await stranger
        .clone()
        .json()
        .catch(() => ({})),
    );
    // The email goes after the answer: the answer's time tells nothing.
    await settle(() => mail.sent.length > before);
    const text = mail.sent.at(-1)?.text ?? "";
    const url = /https:\/\/\S+\/phone#\S+/.exec(text)?.[0] ?? "";
    const link = readPhoneLink(url);
    expect(link?.kind).toBe("link");
    if (!link) return;
    const at = Date.now();
    const res = await phoneReq(app, null, "POST", "/v1/phone/link/redeem", {
      secret: link.secret,
      verifier,
      device_key: phone.key,
      at,
      proof: await phone.sign(proofStatement("link", ORIGIN, await sha256b64u(link.secret), at)),
      name: "Pixel 8",
    });
    expect(res.status).toBe(201);
    // A phone the owner's mailbox vouched for needs no Confirm.
    const connected = (await res.json()) as { access_token: string; state: string };
    expect(connected.state).toBe("connected");
    expect((await phoneReq(app, connected.access_token, "GET", "/v1/owner/items")).status).toBe(200);
  });

  it("serves a page that keeps the secret out of the server, and item links that open the owner app", async () => {
    const { app } = await setup();
    const page = await app.request(`${ORIGIN}/phone`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    // On an Android phone the code goes to the app itself: an intent pinned to its package.
    expect(html).toContain("package=ai.surfingdog.inbox");
    expect(html).toContain("Connect this phone");
    expect(html).toContain("Opens the Surfing Dog Inbox app. Nothing to type.");
    // Without the app, the browser lands on the download page, never on a store that doesn't have it.
    expect(html).toContain('var G="https://surfingdog.ai/phone"');
    expect(html).not.toContain("Play Store");
    const item = await app.request(`${ORIGIN}/i/01ABC`);
    expect(item.status).toBe(302);
    expect(item.headers.get("location")).toBe("/items/01ABC");
  });
});

describe("notifications", () => {
  it("registers the phone with the relay, and sends it only ciphertext about a new request", async () => {
    const { db, app, cookie, relay, inbox } = await setup();
    const phone = await makePhone();
    const { tokens } = await pairPhone(app, cookie, phone);
    const reg = await phoneReq(app, tokens.access_token, "PUT", "/v1/phone/push", {
      token: "fcm-token-abc",
      ...phone.pushKeys,
    });
    expect(await reg.json()).toEqual({ push: "on", error: null, relay_device: "pd_1" });
    expect(relay.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/devices",
      body: { app: "ai.surfingdog.inbox", platform: "android", token: "fcm-token-abc", sender: ORIGIN },
    });
    // Signed sdi-instance/1 with the inbox's receipt key, as the relay verifies it from the manifest.
    const first = relay.calls[0];
    if (!first) return;
    const jwks = await inbox.caps.receipts.jwks();
    const verified = await verifyInstanceRequest({
      method: first.method,
      url: first.request.url,
      headers: first.request.headers,
      body: first.text,
      authorities: [new URL(RELAY).host],
      now: Date.now(),
      keysFor: async (domain) => (domain === "inbox.test" ? (jwks.keys as never) : null),
    });
    expect(verified.domain).toBe("inbox.test");
    // A test from the phone itself.
    expect((await phoneReq(app, tokens.access_token, "POST", "/v1/phone/test")).status).toBe(200);
    const test = relay.calls.at(-1);
    expect(test?.path).toBe("/v1/devices/pd_1/messages");
    expect(test?.auth).toBe("Bearer ps_relay_secret");
    // The relay delivers one notification once, whatever the retries.
    expect(String(test?.body?.id)).toMatch(/^n_/);

    // A booking request comes in through the business's own page.
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Cut & finish",
      durationMin: 45,
      capacity: 1,
      granularityMin: 15,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await openWeekdays(db);
    const day = futureDay();
    const created = await app.request(`${ORIGIN}/v1/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": clientIp() },
      body: JSON.stringify({
        payload: {
          reservationFor: { serviceId: svc, name: "Cut & finish" },
          startTime: `${day}T10:00:00Z`,
          endTime: `${day}T10:45:00Z`,
        },
        contact: { name: "Maya Chen", email: "maya@example.com" },
      }),
    });
    expect(created.status).toBe(201);
    const now = Date.now();
    for (const dt of [0, 5_000, 10_000]) await inbox.runner.runDue(db, { now: now + dt });
    const messages = relay.calls.filter((c) => c.path.endsWith("/messages"));
    expect(messages.length).toBe(2);
    const last = messages.at(-1);
    const payload = String(last?.body?.payload ?? "");
    expect(JSON.stringify(last?.body)).not.toContain("Maya");
    expect(JSON.stringify(last?.body)).not.toContain("Cut");
    const plain = JSON.parse(new TextDecoder().decode(await decryptPush(b64uDecode(payload), phone.push))) as {
      kind: string;
      title: string;
    };
    expect(plain).toMatchObject({ kind: "booking", title: "New booking request" });
  });
});

describe("signing in through the host, and a phone that confirms a phone (Amendment 4)", () => {
  /** An inbox whose clock the test moves: a day's wait passes in a line. */
  async function hosted() {
    let clock = Date.now();
    const db = await freshDb();
    const mail = logMailOut();
    const relay = relayFetch();
    const inbox = createInbox({
      db,
      mailOut: mail,
      ownerEmails: [OWNER],
      secretKey: KEY,
      fetchImpl: relay.fetchImpl,
      pushRelay: RELAY,
      baseUrl: ORIGIN,
      now: () => clock,
    });
    return {
      db,
      mail,
      relay,
      inbox,
      app: inbox.app,
      later: (ms: number) => {
        clock += ms;
      },
      at: () => clock,
    };
  }

  /** What the inbox's host does after its own email code: a link for the owner, with the phone's challenge and key. */
  async function signInOnPhone(h: Awaited<ReturnType<typeof hosted>>, phone: Phone, name: string) {
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const link = await h.inbox.caps.phones.hostLink(
      { email: OWNER, owner: OWNER, challenge: await pkceS256(verifier), device_key: phone.key },
      h.at(),
    );
    const at = h.at();
    const res = await phoneReq(h.app, null, "POST", "/v1/phone/link/redeem", {
      secret: link.secret,
      verifier,
      device_key: phone.key,
      at,
      proof: await phone.sign(proofStatement("link", ORIGIN, await sha256b64u(link.secret), at)),
      name,
      platform: "android",
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      access_token: string;
      refresh_token: string;
      device_id: string;
      state: string;
      match?: string;
    };
  }

  it("connects the first phone with no computer, and tells the owner how", async () => {
    const h = await hosted();
    const first = await signInOnPhone(h, await makePhone(), "Pixel 8");
    expect(first.state).toBe("connected");
    expect(first.match).toBeUndefined();
    const me = (await (await phoneReq(h.app, first.access_token, "GET", "/v1/phone/me")).json()) as {
      phone: { confirmed: boolean };
    };
    expect(me.phone.confirmed).toBe(true);
    expect((await phoneReq(h.app, first.access_token, "GET", "/v1/owner/items")).status).toBe(200);
    await settle(() => h.mail.sent.some((m) => m.subject.startsWith("A phone was connected")));
    const email = h.mail.sent.find((m) => m.subject.startsWith("A phone was connected"));
    expect(email?.text?.startsWith("Not you? Remove it now")).toBe(true);
    expect(email?.text).toContain("How: a sign-in code sent to this address.");
  });

  it("holds a second phone to its confirm until the first says yes with the same two digits", async () => {
    const h = await hosted();
    const firstPhone = await makePhone();
    const first = await signInOnPhone(h, firstPhone, "Pixel 8");
    await phoneReq(h.app, first.access_token, "PUT", "/v1/phone/push", { token: "fcm-1", ...firstPhone.pushKeys });
    const second = await signInOnPhone(h, await makePhone(), "Galaxy A15");
    expect(second.state).toBe("pending");
    expect(second.match).toMatch(/^\d{2}$/);
    // Waiting: it may ask whether it came, give up, or wait a day, and nothing else.
    const items = await phoneReq(h.app, second.access_token, "GET", "/v1/owner/items");
    expect(items.status).toBe(403);
    expect(((await items.json()) as { detail: string }).detail).toBe("Confirm this phone on your other phone first.");
    for (const [method, path] of [
      ["GET", "/v1/phone/pairings"],
      ["GET", "/v1/phone/phones"],
      ["PUT", "/v1/phone/push"],
    ] as const)
      expect((await phoneReq(h.app, second.access_token, method, path, method === "PUT" ? {} : undefined)).status).toBe(
        403,
      );
    const waiting = (await (await phoneReq(h.app, second.access_token, "GET", "/v1/phone/me")).json()) as {
      phone: { confirmed: boolean; waits_on: string };
    };
    expect(waiting.phone).toMatchObject({ confirmed: false, waits_on: "phone" });
    // The first phone is told, and sees the same two digits.
    for (const dt of [0, 1000]) await h.inbox.runner.runDue(h.db, { now: h.at() + dt });
    expect(h.relay.calls.some((c) => c.path.endsWith("/messages"))).toBe(true);
    const asks = (await (await phoneReq(h.app, first.access_token, "GET", "/v1/phone/pairings")).json()) as {
      pairings: { id: string; match: string; phone: { name: string } }[];
    };
    expect(asks.pairings).toMatchObject([{ id: second.device_id, match: second.match, phone: { name: "Galaxy A15" } }]);
    // A yes without the first phone's key signing it changes nothing.
    const unsigned = await phoneReq(
      h.app,
      first.access_token,
      "POST",
      `/v1/phone/pairings/${second.device_id}/confirm`,
      {
        at: h.at(),
        proof: "x",
      },
    );
    expect(unsigned.status).toBe(403);
    const at = h.at();
    const yes = await phoneReq(h.app, first.access_token, "POST", `/v1/phone/pairings/${second.device_id}/confirm`, {
      at,
      proof: await firstPhone.sign(proofStatement("confirm", ORIGIN, await sha256b64u(second.device_id), at)),
    });
    expect(yes.status).toBe(200);
    expect((await phoneReq(h.app, second.access_token, "GET", "/v1/owner/items")).status).toBe(200);
    await settle(() => h.mail.sent.some((m) => (m.text ?? "").includes("on your other phone")));
    expect(h.mail.sent.at(-1)?.text).toContain("How: you confirmed it on your other phone, an Android phone.");
    expect(h.mail.sent.at(-1)?.text).not.toContain("Pixel");
  });

  it("lets a phone wait a day when the owner doesn't have the other one, stopped by a link in the email", async () => {
    const h = await hosted();
    await signInOnPhone(h, await makePhone(), "Pixel 8");
    const third = await signInOnPhone(h, await makePhone(), "Moto G");
    // Asked through another name for this server: the link in the email is still this inbox's own.
    const waited = await h.app.request("https://evil.example/v1/phone/wait", {
      method: "POST",
      headers: {
        authorization: `Bearer ${third.access_token}`,
        "cf-connecting-ip": clientIp(),
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(waited.status).toBe(200);
    // No phone of the owner's hears of it at once (notifications off here): it waits three days.
    expect(await waited.json()).toMatchObject({ wait_hours: 72 });
    await settle(() => h.mail.sent.some((m) => m.subject.includes("in 3 days")));
    const email = h.mail.sent.find((m) => m.subject.includes("in 3 days"));
    expect(email?.subject).toBe("A new phone connects to your inbox in 3 days");
    // In the business's own time, as its notifications are (this one has none set: UTC), never with seconds.
    expect(email?.text).toMatch(/It will be let in on \w+day \d{1,2} \w+ at \d{2}:\d{2} \(UTC\), unless you stop it\./);
    // It leads with the way to stop it: this inbox's own page, whatever the asking phone sent as its host.
    expect(email?.text?.startsWith("Not you? Stop it now:\nhttps://inbox.test/auth/phone/stop?token=")).toBe(true);
    expect(email?.text).toContain("Phone: an Android phone\n");
    expect(email?.text).not.toContain("Moto");
    const stop = /https:\/\/inbox\.test(\/auth\/phone\/stop\?token=[A-Za-z0-9_-]+)/.exec(email?.text ?? "")?.[1] ?? "";
    const token = new URL(`${ORIGIN}${stop}`).searchParams.get("token") ?? "";
    // Opening the link (as a mail scanner does) stops nothing.
    const page = await h.app.request(`${ORIGIN}${stop}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Stop this Android phone?");
    expect((await phoneReq(h.app, third.access_token, "GET", "/v1/phone/me")).status).toBe(200);
    // A post from anywhere but its page is refused.
    const crossSite = await h.app.request(`${ORIGIN}/auth/phone/stop`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: `token=${token}`,
    });
    expect(crossSite.status).toBe(403);
    const stopped = await h.app.request(`${ORIGIN}/auth/phone/stop`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: `token=${token}`,
    });
    expect(stopped.status).toBe(200);
    expect((await phoneReq(h.app, third.access_token, "GET", "/v1/phone/me")).status).toBe(401);
    expect((await h.app.request(`${ORIGIN}${stop}`)).status).toBe(410);
    // The owner is told that someone used a code sent to them, and new phones wait a day.
    await settle(() => h.mail.sent.some((m) => m.subject.startsWith("A new phone was stopped")));
    const told = h.mail.sent.find((m) => m.subject.startsWith("A new phone was stopped"));
    expect(told?.text).toContain("someone else may be able to read your email");
    expect(told?.text).toContain("New phones can't connect for a day.");
  });

  it("never shows the owner a new phone's name that is not a phone's: its kind instead, everywhere", async () => {
    const h = await hosted();
    const first = await signInOnPhone(h, await makePhone(), "Pixel 8");
    const bait = "Not you? Stop it here: https://sd-stop.example/k";
    const second = await signInOnPhone(h, await makePhone(), bait);
    expect(second.state).toBe("pending");
    // The confirm sheet's list.
    const asks = (await (await phoneReq(h.app, first.access_token, "GET", "/v1/phone/pairings")).json()) as {
      pairings: { phone: { name: string; platform: string } }[];
    };
    expect(asks.pairings[0]?.phone).toMatchObject({ name: "Android phone", platform: "android" });
    // The wait email, the stop page and the stop email.
    expect((await phoneReq(h.app, second.access_token, "POST", "/v1/phone/wait", {})).status).toBe(200);
    await settle(() => h.mail.sent.some((m) => m.subject.startsWith("A new phone connects")));
    const wait = h.mail.sent.find((m) => m.subject.startsWith("A new phone connects"));
    expect(wait?.text).toContain("Phone: an Android phone\n");
    const stop = /https:\/\/inbox\.test(\/auth\/phone\/stop\?token=[A-Za-z0-9_-]+)/.exec(wait?.text ?? "")?.[1] ?? "";
    const page = await (await h.app.request(`${ORIGIN}${stop}`)).text();
    expect(page).toContain("Stop this Android phone?");
    const token = new URL(`${ORIGIN}${stop}`).searchParams.get("token") ?? "";
    const stopped = await h.app.request(`${ORIGIN}/auth/phone/stop`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: `token=${token}`,
    });
    expect(await stopped.text()).toContain("The Android phone can&#39;t open your inbox.");
    await settle(() => h.mail.sent.some((m) => m.subject.startsWith("A new phone was stopped")));
    const told = h.mail.sent.find((m) => m.subject.startsWith("A new phone was stopped"));
    expect(told?.text).toContain("You stopped an Android phone from connecting to");
    for (const m of h.mail.sent) {
      expect(m.text ?? "").not.toContain("sd-stop.example");
      expect(m.html ?? "").not.toContain("sd-stop.example");
    }
    expect(page).not.toContain("sd-stop.example");
  });

  it("says the kind of phone alone in every email and on the stop page, whatever a phone calls itself", async () => {
    // Names that read like a phone's to any rule, a stranger's and the owner's own alike.
    for (const name of ["Reset at getback dot io", "Surfin Dog Suport", "Galaxy A15 de Ana"]) {
      const h = await hosted();
      const pages: string[] = [];
      const firstPhone = await makePhone();
      const first = await signInOnPhone(h, firstPhone, name);
      // A second phone, confirmed on the first: both "A phone was connected" emails.
      const second = await signInOnPhone(h, await makePhone(), name);
      const asks = (await (await phoneReq(h.app, first.access_token, "GET", "/v1/phone/pairings")).json()) as {
        pairings: { phone: { name: string; platform: string } }[];
      };
      // The owner's own screen, signed in, still names it, beside its kind (the sheet).
      expect(asks.pairings[0]?.phone).toMatchObject({ name, platform: "android" });
      const at = h.at();
      const yes = await phoneReq(h.app, first.access_token, "POST", `/v1/phone/pairings/${second.device_id}/confirm`, {
        at,
        proof: await firstPhone.sign(proofStatement("confirm", ORIGIN, await sha256b64u(second.device_id), at)),
      });
      expect(yes.status).toBe(200);
      // A third waits a day, and is stopped from the email's page: the wait email, the page, its result, the stop email.
      const third = await signInOnPhone(h, await makePhone(), name);
      expect((await phoneReq(h.app, third.access_token, "POST", "/v1/phone/wait", {})).status).toBe(200);
      await settle(() => h.mail.sent.some((m) => m.subject.startsWith("A new phone connects")));
      const wait = h.mail.sent.find((m) => m.subject.startsWith("A new phone connects"));
      const stop = /https:\/\/inbox\.test(\/auth\/phone\/stop\?token=[A-Za-z0-9_-]+)/.exec(wait?.text ?? "")?.[1] ?? "";
      pages.push(await (await h.app.request(`${ORIGIN}${stop}`)).text());
      const token = new URL(`${ORIGIN}${stop}`).searchParams.get("token") ?? "";
      const stopped = await h.app.request(`${ORIGIN}/auth/phone/stop`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: `token=${token}`,
      });
      pages.push(await stopped.text());
      // A day on, a fourth is turned down on the first phone ("Not mine"): another stop email.
      h.later(25 * 3_600_000);
      const fourth = await signInOnPhone(h, await makePhone(), name);
      expect(
        (await phoneReq(h.app, first.access_token, "POST", `/v1/phone/pairings/${fourth.device_id}/refuse`, {})).status,
      ).toBe(200);
      await settle(
        () =>
          h.mail.sent.filter((m) => m.subject.startsWith("A phone was connected")).length >= 2 &&
          h.mail.sent.filter((m) => m.subject.startsWith("A new phone was stopped")).length >= 2,
      );
      const subjects = h.mail.sent.map((m) => m.subject);
      expect(subjects.filter((x) => x.startsWith("A phone was connected"))).toHaveLength(2);
      expect(subjects.filter((x) => x.startsWith("A new phone was stopped"))).toHaveLength(2);
      const said = [...h.mail.sent.map((m) => `${m.subject}\n${m.text ?? ""}\n${m.html ?? ""}`), ...pages].join("\n");
      expect(said).toContain("Phone: an Android phone\n");
      expect(said).toContain("How: you confirmed it on your other phone, an Android phone.");
      expect(said).toContain("You stopped an Android phone from connecting to");
      expect(said).toContain("Stop this Android phone?");
      expect(said).toContain("The Android phone can&#39;t open your inbox.");
      // No part of the name, in any of them.
      for (const part of name.split(" ").filter((w) => w.length >= 3))
        expect(said, `${name}: ${part}`).not.toMatch(new RegExp(`\\b${part}\\b`, "i"));
    }
  });

  it("lets a waiting phone in once its day is over and nothing stopped it, and says so", async () => {
    const h = await hosted();
    await signInOnPhone(h, await makePhone(), "Pixel 8");
    const fourthPhone = await makePhone();
    const fourth = await signInOnPhone(h, fourthPhone, "Moto G");
    expect((await phoneReq(h.app, fourth.access_token, "POST", "/v1/phone/wait", {})).status).toBe(200);
    h.later(3_600_000);
    const early = (await (await phoneReq(h.app, fourth.access_token, "GET", "/v1/phone/me")).json()) as {
      phone: { confirmed: boolean; wait_until: string };
    };
    expect(early.phone.confirmed).toBe(false);
    // Three days on (no phone of the owner's would hear of it), its access token long gone:
    // refreshed with its key, then let in.
    h.later(72 * 3_600_000);
    const at = h.at();
    const refreshed = await phoneReq(h.app, null, "POST", "/v1/phone/token", {
      refresh_token: fourth.refresh_token,
      at,
      proof: await fourthPhone.sign(proofStatement("refresh", ORIGIN, await sha256b64u(fourth.refresh_token), at)),
    });
    expect(refreshed.status).toBe(200);
    const tokens = (await refreshed.json()) as { access_token: string };
    const me = (await (await phoneReq(h.app, tokens.access_token, "GET", "/v1/phone/me")).json()) as {
      phone: { confirmed: boolean };
    };
    expect(me.phone.confirmed).toBe(true);
    await settle(() => h.mail.sent.some((m) => (m.text ?? "").includes("How: it waited")));
    expect(h.mail.sent.at(-1)?.text).toContain("How: it waited, as you were told by email, and nobody stopped it.");
  });
});
