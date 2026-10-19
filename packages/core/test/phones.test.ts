import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import {
  b64uDecode,
  b64uEncode,
  decryptPush,
  PAIRING_TTL_MS,
  PHONE_ACCESS_TTL_MS,
  type PushPayload,
  type PushRelay,
  pkceS256,
  proofStatement,
  REFRESH_GRACE_MS,
  sha256b64u,
  signProof,
} from "../src/phones/index";
import { buildPushPayload } from "../src/phones/payload";
import { deliverAt, notifyPrefsSchema, pushKindOf } from "../src/phones/prefs";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { jobs, services, users } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/index";
import { makeClient, openWeekdays, resetTables } from "./harness";

/**
 * The owner's phones (ADR-026): pairing by QR code and by emailed link, tokens bound to the phone's
 * device key, removing a phone, what each phone is told and when, and push through a relay that
 * only ever sees ciphertext.
 */
const T0 = Date.parse("2026-10-20T10:00:00Z");
const ORIGIN = "https://inbox.example.com";
const KEY = "2f8c1d0a6b4e37925c8f01ad6e3b47f0";

/** A phone: a device key (ECDSA) and push keys (ECDH + auth), as the app makes them in its keystore. */
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
type Phone = Awaited<ReturnType<typeof makePhone>>;

/** A relay that keeps what it is handed, as the real one does: ciphertext and a device id. */
function fakeRelay() {
  const sent: { device: string; payload: Uint8Array; urgency: string; collapse?: string | undefined }[] = [];
  const registered: { device: string; token: string; sender: string }[] = [];
  const removed: string[] = [];
  let gone = new Set<string>();
  const relay: PushRelay = {
    async register(input) {
      const device = `pd_${registered.length + 1}`;
      registered.push({ device, token: input.token, sender: input.sender });
      return { device, secret: `ps_secret_${device}` };
    },
    async updateToken(reg, token) {
      const r = registered.find((x) => x.device === reg.device);
      if (!r) throw new Error("unknown");
      r.token = token;
    },
    async remove(reg) {
      removed.push(reg.device);
    },
    async send(reg, message, opts) {
      if (gone.has(reg.device)) return { ok: false, gone: true, status: 410 };
      sent.push({ device: reg.device, payload: message, urgency: opts.urgency, collapse: opts.collapse });
      return { ok: true };
    },
  };
  return {
    relay,
    sent,
    registered,
    removed,
    goneFor: (d: string) => {
      gone = new Set([...gone, d]);
    },
  };
}

async function setup(opts: { secrets?: boolean } = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = new Capabilities(db, opts.secrets === false ? null : createSecretBox([KEY]));
  const relay = fakeRelay();
  caps.phones.attachRelay(relay.relay);
  const userId = ulid(T0);
  await db.orm.insert(users).values({ id: userId, email: "owner@example.com", role: "owner", createdAt: T0 });
  return { db, caps, relay, userId, phones: caps.phones };
}

async function pairWith(phones: Capabilities["phones"], phone: Phone, secret: string, now = T0) {
  const at = now;
  return phones.pair(
    {
      secret,
      device_key: phone.key,
      at,
      proof: await phone.sign(proofStatement("pair", ORIGIN, await sha256b64u(secret), at)),
      name: "Pixel 8",
      platform: "android",
    },
    ORIGIN,
    now,
  );
}

async function refreshWith(phones: Capabilities["phones"], phone: Phone, token: string, now: number) {
  return phones.refresh(
    {
      refresh_token: token,
      at: now,
      proof: await phone.sign(proofStatement("refresh", ORIGIN, await sha256b64u(token), now)),
    },
    ORIGIN,
    now,
  );
}

async function dump(db: Db): Promise<string> {
  const read = async (sql: string) => JSON.stringify((await db.client.query({ sql, method: "all" })).rows);
  return [
    await read("SELECT * FROM phone_pairings"),
    await read("SELECT * FROM phone_devices"),
    await read("SELECT * FROM phone_tokens"),
    await read("SELECT * FROM jobs"),
  ].join("\n");
}

describe("pairing by QR code", () => {
  it("trades a fresh code for tokens once, keeping only hashes", async () => {
    const { db, phones, userId } = await setup();
    const phone = await makePhone();
    const code = await phones.createPairing(userId, T0);
    expect(code.secret).toMatch(/^sdi_pp_/);
    expect(await phones.pairingStatus(userId, code.id, T0)).toEqual({ state: "waiting" });
    const tokens = await pairWith(phones, phone, code.secret, T0 + 1000);
    expect(tokens.access_token).toMatch(/^sdi_pa_/);
    expect(tokens.refresh_token).toMatch(/^sdi_pr_/);
    expect(tokens.expires_in).toBe(PHONE_ACCESS_TTL_MS / 1000);
    const status = await phones.pairingStatus(userId, code.id, T0 + 2000);
    expect(status.state).toBe("paired");
    expect(status.phone?.name).toBe("Pixel 8");
    // Used once: a second phone (or the same one again) gets nothing.
    await expect(pairWith(phones, await makePhone(), code.secret, T0 + 3000)).rejects.toMatchObject({
      code: "code_expired",
    });
    // Nothing secret is stored as it was given.
    const stored = await dump(db);
    for (const s of [code.secret, tokens.access_token, tokens.refresh_token]) expect(stored).not.toContain(s);
    // The access token is the owner, from this phone.
    expect(await phones.resolveAccess(tokens.access_token, T0 + 5000)).toMatchObject({ userId, name: "Pixel 8" });
    expect(await phones.resolveAccess(tokens.access_token, T0 + 1000 + PHONE_ACCESS_TTL_MS + 1)).toBeNull();
    expect(await phones.resolveAccess(tokens.refresh_token, T0 + 5000)).toBeNull();
  });

  it("refuses a code past its five minutes, a proof from another key, and another inbox's proof", async () => {
    const { phones, userId } = await setup();
    const phone = await makePhone();
    const old = await phones.createPairing(userId, T0);
    await expect(pairWith(phones, phone, old.secret, T0 + PAIRING_TTL_MS + 1)).rejects.toMatchObject({
      code: "code_expired",
    });
    expect((await phones.pairingStatus(userId, old.id, T0 + PAIRING_TTL_MS + 1)).state).toBe("expired");
    const code = await phones.createPairing(userId, T0);
    const thief = await makePhone();
    const at = T0;
    // The thief signs with its own key but claims the phone's.
    await expect(
      phones.pair(
        {
          secret: code.secret,
          device_key: phone.key,
          at,
          proof: await thief.sign(proofStatement("pair", ORIGIN, await sha256b64u(code.secret), at)),
        },
        ORIGIN,
        T0,
      ),
    ).rejects.toMatchObject({ code: "not_allowed" });
    // A proof made for another inbox's origin is no good here.
    await expect(
      phones.pair(
        {
          secret: code.secret,
          device_key: phone.key,
          at,
          proof: await phone.sign(
            proofStatement("pair", "https://elsewhere.example", await sha256b64u(code.secret), at),
          ),
        },
        ORIGIN,
        T0,
      ),
    ).rejects.toMatchObject({ code: "not_allowed" });
    // A phone whose clock is far off: its proof is dated ten minutes ago.
    const stale = T0 - 10 * 60_000;
    await expect(
      phones.pair(
        {
          secret: code.secret,
          device_key: phone.key,
          at: stale,
          proof: await phone.sign(proofStatement("pair", ORIGIN, await sha256b64u(code.secret), stale)),
        },
        ORIGIN,
        T0,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // The code was not spent by any of that.
    expect((await pairWith(phones, phone, code.secret, T0 + 1000)).device_id).toBeTruthy();
  });

  it("gives two phones racing with one code one phone between them", async () => {
    const { db, phones, userId } = await setup();
    const code = await phones.createPairing(userId, T0);
    const [a, b] = await Promise.allSettled([
      pairWith(phones, await makePhone(), code.secret, T0 + 1),
      pairWith(phones, await makePhone(), code.secret, T0 + 2),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const { rows } = await db.client.query({ sql: "SELECT COUNT(*) FROM phone_devices", method: "all" });
    expect(Number(rows[0]?.[0])).toBe(1);
    const t = await db.client.query({ sql: "SELECT COUNT(*) FROM phone_tokens", method: "all" });
    expect(Number(t.rows[0]?.[0])).toBe(2);
  });
});

describe("tokens bound to the phone", () => {
  it("rotates the refresh token, and only the phone's key can use it", async () => {
    const { phones, userId } = await setup();
    const phone = await makePhone();
    const first = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    const later = T0 + 3_600_000;
    // A copy of the refresh token without the phone's key: refused, and nothing changes.
    const thief = await makePhone();
    await expect(
      phones.refresh(
        {
          refresh_token: first.refresh_token,
          at: later,
          proof: await thief.sign(proofStatement("refresh", ORIGIN, await sha256b64u(first.refresh_token), later)),
        },
        ORIGIN,
        later,
      ),
    ).rejects.toMatchObject({ code: "not_allowed" });
    const second = await refreshWith(phones, phone, first.refresh_token, later);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await phones.resolveAccess(second.access_token, later + 1)).not.toBeNull();
    // A lost answer asked again at once gets fresh tokens; what the lost answer gave stops.
    const again = await refreshWith(phones, phone, first.refresh_token, later + 10_000);
    expect(await phones.resolveAccess(second.access_token, later + 10_001)).toBeNull();
    expect(await phones.resolveAccess(again.access_token, later + 10_001)).not.toBeNull();
    // Used again much later: not explained, so the phone is removed.
    await expect(
      refreshWith(phones, phone, first.refresh_token, later + REFRESH_GRACE_MS + 20_000),
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect(await phones.resolveAccess(again.access_token, later + REFRESH_GRACE_MS + 20_001)).toBeNull();
    expect(await phones.listPhones()).toEqual([]);
  });

  it("removes a phone: its tokens stop, the relay forgets it, and it pairs afresh with a new code", async () => {
    const { phones, userId, relay } = await setup();
    const phone = await makePhone();
    const t = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    await phones.registerPush(t.device_id, { token: "fcm-token-1", ...phone.pushKeys }, ORIGIN, T0);
    await phones.removePhone(t.device_id, T0 + 1000);
    expect(relay.removed).toEqual(["pd_1"]);
    expect(await phones.resolveAccess(t.access_token, T0 + 1001)).toBeNull();
    await expect(refreshWith(phones, phone, t.refresh_token, T0 + 2000)).rejects.toMatchObject({
      code: "not_allowed",
    });
    // The same phone may come back, with a new code.
    const back = await pairWith(phones, phone, (await phones.createPairing(userId, T0 + 3000)).secret, T0 + 3000);
    expect(back.device_id).not.toBe(t.device_id);
  });
});

describe("the sign-in link (no camera)", () => {
  it("sends a link only to an owner's address, which only the asking phone can redeem", async () => {
    const { phones } = await setup();
    const phone = await makePhone();
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await pkceS256(verifier);
    expect(await phones.startLink({ email: "stranger@example.com", challenge, device_key: phone.key }, T0)).toBeNull();
    const link = await phones.startLink({ email: "OWNER@example.com", challenge, device_key: phone.key }, T0);
    expect(link?.email).toBe("owner@example.com");
    if (!link) return;
    const redeem = async (p: Phone, v: string, at = T0 + 60_000) =>
      phones.redeemLink(
        {
          secret: link.secret,
          verifier: v,
          device_key: p.key,
          at,
          proof: await p.sign(proofStatement("link", ORIGIN, await sha256b64u(link.secret), at)),
        },
        ORIGIN,
        at,
      );
    // Another app that opened the link has neither the verifier nor the key.
    const other = await makePhone();
    await expect(redeem(other, verifier)).rejects.toMatchObject({ code: "not_allowed" });
    await expect(redeem(phone, b64uEncode(crypto.getRandomValues(new Uint8Array(32))))).rejects.toMatchObject({
      code: "not_allowed",
    });
    const tokens = await redeem(phone, verifier);
    expect(tokens.access_token).toMatch(/^sdi_pa_/);
    await expect(redeem(phone, verifier)).rejects.toMatchObject({ code: "code_expired" });
  });

  it("stops a link after three wrong verifiers, and sends at most three links an hour", async () => {
    const { phones } = await setup();
    const phone = await makePhone();
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await pkceS256(verifier);
    const link = await phones.startLink({ email: "owner@example.com", challenge, device_key: phone.key }, T0);
    if (!link) throw new Error("no link");
    const at = T0 + 1000;
    const proof = await phone.sign(proofStatement("link", ORIGIN, await sha256b64u(link.secret), at));
    const wrong = () => b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    for (let i = 0; i < 3; i++)
      await expect(
        phones.redeemLink({ secret: link.secret, verifier: wrong(), device_key: phone.key, at, proof }, ORIGIN, at),
      ).rejects.toMatchObject({ code: "not_allowed" });
    await expect(
      phones.redeemLink({ secret: link.secret, verifier, device_key: phone.key, at, proof }, ORIGIN, at),
    ).rejects.toMatchObject({ code: "code_expired" });
    expect(
      await phones.startLink({ email: "owner@example.com", challenge, device_key: phone.key }, T0 + 1),
    ).not.toBeNull();
    expect(
      await phones.startLink({ email: "owner@example.com", challenge, device_key: phone.key }, T0 + 2),
    ).not.toBeNull();
    expect(await phones.startLink({ email: "owner@example.com", challenge, device_key: phone.key }, T0 + 3)).toBeNull();
  });
});

describe("what a phone is told, and when", () => {
  it("reads settings leniently, maps item kinds, and holds notifications through quiet hours", () => {
    const prefs = notifyPrefsSchema.parse({ quiet: { on: true, from: "21:00", to: "08:00" }, tz: "Europe/Lisbon" });
    expect(prefs.kinds).toEqual({ booking: true, order: true, quote: true, message: true, handled: false });
    // 22:30 in Lisbon (WEST, UTC+1) is 21:30 UTC: held until 08:00 Lisbon, 07:00 UTC.
    const night = Date.parse("2026-10-19T21:30:00Z");
    expect(new Date(deliverAt(prefs, night, "UTC")).toISOString()).toBe("2026-10-20T07:00:00.000Z");
    // 12:00 is outside: at once.
    const noon = Date.parse("2026-10-20T11:00:00Z");
    expect(deliverAt(prefs, noon, "UTC")).toBe(noon);
    // Quiet hours inside one day (13:00 to 14:00, the business's zone when the phone gives none).
    const lunch = notifyPrefsSchema.parse({ quiet: { on: true, from: "13:00", to: "14:00" } });
    expect(new Date(deliverAt(lunch, Date.parse("2026-10-20T13:20:30Z"), "UTC")).toISOString()).toBe(
      "2026-10-20T14:00:00.000Z",
    );
    expect(pushKindOf({ type: "booking" }, true)).toBe("booking");
    expect(pushKindOf({ type: "refund" }, true)).toBe("order");
    expect(pushKindOf({ type: "quote_request" }, true)).toBe("quote");
    expect(pushKindOf({ type: "booking" }, false)).toBe("handled");
  });
});

async function seedService(db: Db): Promise<string> {
  const svc = ulid(T0);
  await db.orm.insert(services).values({
    id: svc,
    name: "Cut & finish",
    durationMin: 45,
    capacity: 1,
    granularityMin: 15,
    createdAt: T0,
    updatedAt: T0,
  });
  await openWeekdays(db);
  return svc;
}

const customer: Caller = {
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

describe("push, end to end", () => {
  it("encrypts a minimal notification for the phone: no name, no words, only the phone can read it", async () => {
    const { db, caps, phones, userId, relay } = await setup();
    const svc = await seedService(db);
    const phone = await makePhone();
    const t = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    expect(await phones.registerPush(t.device_id, { token: "fcm-token-1", ...phone.pushKeys }, ORIGIN, T0)).toEqual({
      push: "on",
      error: null,
    });
    expect(relay.registered).toEqual([{ device: "pd_1", token: "fcm-token-1", sender: ORIGIN }]);
    const runner = createRunner({ mailOut: logMailOut(), phones });
    const created = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T13:00:00Z",
        endTime: "2026-10-21T13:45:00Z",
        notes: "Around 2pm if you can",
      },
      contact: { name: "Maya Chen", email: "maya@example.com" },
    });
    await runner.runDue(db, { now: T0 });
    await runner.runDue(db, { now: T0 + 5_000 });
    await runner.runDue(db, { now: T0 + 6_000 });
    expect(relay.sent).toHaveLength(1);
    const sent = relay.sent[0];
    if (!sent) return;
    expect(sent.urgency).toBe("high");
    expect(sent.collapse).toBe(created.view.item.id);
    const bytes = new TextDecoder("latin1").decode(sent.payload);
    for (const word of ["Maya", "Cut", "booking", "2pm"]) expect(bytes).not.toContain(word);
    const payload = JSON.parse(new TextDecoder().decode(await decryptPush(sent.payload, phone.push))) as PushPayload;
    expect(payload).toMatchObject({
      v: 1,
      t: "item",
      item: created.view.item.id,
      kind: "booking",
      title: "New booking request",
    });
    expect(payload.body).toContain("Cut & finish");
    expect(payload.who).toBeUndefined();
    expect(payload.text).toBeUndefined();
    expect(payload.action?.event).toBe("confirm");
    // Nowhere in the database is the push token, the relay's secret or the push keys in plain.
    const stored = await dump(db);
    for (const s of ["fcm-token-1", "ps_secret_pd_1", phone.pushKeys.auth, phone.pushKeys.p256dh])
      expect(stored).not.toContain(s);
  });

  it("adds the name and first words only on a phone with details on, and skips kinds switched off", async () => {
    const { db, caps, phones, userId, relay } = await setup();
    const svc = await seedService(db);
    const a = await makePhone();
    const b = await makePhone();
    const ta = await pairWith(phones, a, (await phones.createPairing(userId, T0)).secret);
    const tb = await pairWith(phones, b, (await phones.createPairing(userId, T0)).secret);
    await phones.registerPush(ta.device_id, { token: "fcm-a", ...a.pushKeys }, ORIGIN, T0);
    await phones.registerPush(tb.device_id, { token: "fcm-b", ...b.pushKeys }, ORIGIN, T0);
    await phones.setNotify(ta.device_id, { details: true });
    await phones.setNotify(tb.device_id, { kinds: { booking: false } });
    const runner = createRunner({ mailOut: logMailOut(), phones });
    await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T13:00:00Z",
        endTime: "2026-10-21T13:45:00Z",
        notes: "Around 2pm if you can",
      },
      contact: { name: "Maya Chen", email: "maya@example.com" },
    });
    for (const dt of [0, 5_000, 6_000]) await runner.runDue(db, { now: T0 + dt });
    expect(relay.sent.map((s) => s.device)).toEqual(["pd_1"]);
    const sent = relay.sent[0];
    if (!sent) return;
    const payload = JSON.parse(new TextDecoder().decode(await decryptPush(sent.payload, a.push))) as PushPayload;
    expect(payload.who).toBe("Maya Chen");
    expect(payload.text).toBe("Around 2pm if you can");
  });

  it("holds a notification through quiet hours and drops it when the request was dealt with meanwhile", async () => {
    const { db, caps, phones, userId, relay } = await setup();
    const svc = await seedService(db);
    const phone = await makePhone();
    const t = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    await phones.registerPush(t.device_id, { token: "fcm", ...phone.pushKeys }, ORIGIN, T0);
    // T0 is 10:00 UTC; quiet from 09:00 to 12:00 UTC.
    await phones.setNotify(t.device_id, { quiet: { on: true, from: "09:00", to: "12:00" }, tz: "UTC" });
    const runner = createRunner({ mailOut: logMailOut(), phones });
    const first = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T13:00:00Z",
        endTime: "2026-10-21T13:45:00Z",
      },
      contact: { name: "A", email: "a@example.com" },
    });
    await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T15:00:00Z",
        endTime: "2026-10-21T15:45:00Z",
      },
      contact: { name: "B", email: "b@example.com" },
    });
    for (const dt of [0, 5_000, 6_000]) await runner.runDue(db, { now: T0 + dt });
    expect(relay.sent).toHaveLength(0);
    const held = await db.orm.select({ runAt: jobs.runAt, kind: jobs.kind, status: jobs.status }).from(jobs);
    expect(
      held
        .filter((j) => j.kind === "phone_push_one" && j.status === "queued")
        .map((j) => new Date(j.runAt).toISOString()),
    ).toEqual(["2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00.000Z"]);
    // The owner confirms the first on the computer meanwhile.
    const owner: Caller = {
      actor: { kind: "owner", id: userId, channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T0 + 60_000,
    };
    await caps.transitionItem(owner, { item_id: first.view.item.id, event: "confirm" });
    await runner.runDue(db, { now: Date.parse("2026-10-20T12:00:01Z") });
    expect(relay.sent).toHaveLength(1);
  });

  it("marks a phone whose app is gone as lost, and refuses to set up push without a secret key", async () => {
    const { db, caps, phones, userId, relay } = await setup();
    const svc = await seedService(db);
    const phone = await makePhone();
    const t = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    await phones.registerPush(t.device_id, { token: "fcm", ...phone.pushKeys }, ORIGIN, T0);
    relay.goneFor("pd_1");
    const runner = createRunner({ mailOut: logMailOut(), phones });
    await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T13:00:00Z",
        endTime: "2026-10-21T13:45:00Z",
      },
      contact: { name: "A", email: "a@example.com" },
    });
    for (const dt of [0, 5_000, 6_000]) await runner.runDue(db, { now: T0 + dt });
    expect((await phones.listPhones())[0]?.push).toBe("lost");
    // Opening the app again registers afresh with the new token.
    expect((await phones.registerPush(t.device_id, { token: "fcm-2", ...phone.pushKeys }, ORIGIN, T0)).push).toBe("on");

    const bare = await setup({ secrets: false });
    const p2 = await makePhone();
    const t2 = await pairWith(bare.phones, p2, (await bare.phones.createPairing(bare.userId, T0)).secret);
    expect(await bare.phones.registerPush(t2.device_id, { token: "fcm", ...p2.pushKeys }, ORIGIN, T0)).toEqual({
      push: "unavailable",
      error: "no_secret_key",
    });
    expect(bare.relay.registered).toEqual([]);
  });

  it("sends a test, and nothing at all while no phone listens", async () => {
    const { db, caps, phones, userId, relay } = await setup();
    const svc = await seedService(db);
    const runner = createRunner({ mailOut: logMailOut(), phones });
    await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Cut & finish" },
        startTime: "2026-10-21T13:00:00Z",
        endTime: "2026-10-21T13:45:00Z",
      },
      contact: { name: "A", email: "a@example.com" },
    });
    for (const dt of [0, 5_000]) await runner.runDue(db, { now: T0 + dt });
    const kinds = (await db.orm.select({ kind: jobs.kind }).from(jobs)).map((j) => j.kind);
    expect(kinds.some((k) => k.startsWith("phone_push"))).toBe(false);
    const phone = await makePhone();
    const t = await pairWith(phones, phone, (await phones.createPairing(userId, T0)).secret);
    await expect(phones.sendTest(t.device_id, T0)).rejects.toMatchObject({ code: "wrong_state" });
    await phones.registerPush(t.device_id, { token: "fcm", ...phone.pushKeys }, ORIGIN, T0);
    expect(await phones.sendTest(t.device_id, T0)).toEqual({ sent: true, note: "sent" });
    const sent = relay.sent.at(-1);
    if (!sent) return;
    const payload = JSON.parse(new TextDecoder().decode(await decryptPush(sent.payload, phone.push))) as PushPayload;
    expect(payload).toMatchObject({ t: "test", title: "Notifications work" });
  });
});

describe("payloads", () => {
  it("keeps a payload within one push, dropping the optional words first", () => {
    const item = {
      id: "01J",
      type: "message",
      state: "open",
      version: 1,
      partyId: "p",
      locationId: null,
      channel: "email",
      subject: null,
      flags: { needsHuman: true, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: "2026-10-20T10:00:00Z",
      updatedAt: "2026-10-20T10:00:00Z",
      closedAt: null,
      payload: { text: "x".repeat(5000) },
    } as const;
    const p = buildPushPayload({
      item: item as never,
      kind: "message",
      event: "create",
      details: true,
      who: "y".repeat(500),
      text: "z".repeat(5000),
      timezone: "UTC",
      now: T0,
    });
    expect(JSON.stringify(p).length).toBeLessThan(2048);
    expect(p.text?.length).toBeLessThanOrEqual(160);
    expect(b64uDecode(b64uEncode(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
