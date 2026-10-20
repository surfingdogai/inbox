import { ConnectorError, type OutboundStay, type RunContext } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { APALEO_HOSTS, APALEO_SCOPES, apaleoConnector, apaleoNight } from "../../src/connectors/property/apaleo";
import { fakeApaleo } from "../fakes/property/apaleo";
import { cardRequests } from "../fakes/property/cards";
import {
  ACCOUNT,
  AUTH_CODE,
  BUNK,
  CARD_LAKE,
  CLIENT,
  FLEX_BUNK,
  FLEX_LAKE,
  LAKE,
  OWN_CLIENT,
  PROPERTY,
  webhookBody,
} from "../fixtures/property/apaleo";
import { propertyContract, runContext } from "./contract";

/**
 * apaleo (ADR-033 §8.4) against a local apaleo built from its OpenAPI files: the property system
 * contract, the idempotency key replayed, the externalCode found after the key has lapsed, the date line,
 * the token refreshed, the sign-in asking for nothing it should not, never `$force` or a payment, and the
 * webhook's account checked before anything is read back.
 */

function connection(m: ReturnType<typeof fakeApaleo>) {
  const secret: Record<string, string> = {
    access_token: m.issue(),
    refresh_token: "fake-apaleo-refresh-1",
    access_expires_at: String(m.now() + 3_600_000),
  };
  return secret;
}

propertyContract("apaleo (fake built from its OpenAPI files)", () => {
  const m = fakeApaleo();
  return {
    definition: apaleoConnector(CLIENT) as never,
    http: m.platform.http,
    secret: connection(m),
    propertyId: PROPERTY.id,
    oneUnitRoom: LAKE.id,
    rate: FLEX_LAKE.id,
    oversells: false,
  };
});

function stayOf(key: string, checkIn: string, checkOut: string, extra: Partial<OutboundStay> = {}): OutboundStay {
  return {
    itemId: `item-${key}`,
    reference: key.slice(-6).toUpperCase(),
    key,
    propertyId: PROPERTY.id,
    checkIn,
    checkOut,
    rooms: [
      { roomId: LAKE.id, rateId: FLEX_LAKE.id, adults: 2, childrenAges: [], price: { value: 49_000, currency: "NZD" } },
    ],
    ...extra,
  };
}

function setup() {
  const m = fakeApaleo();
  const def = apaleoConnector(CLIENT);
  let secret = connection(m);
  const saved: Record<string, string>[] = [];
  const ctx = (): RunContext => ({
    ...runContext(m.platform.http, secret, m.now()),
    extra: { accountId: ACCOUNT.code },
    async saveSecret(next) {
      secret = { ...next };
      saved.push(secret);
    },
  });
  const writer = def.stayWriter;
  const stays = def.stays;
  if (!writer || !stays) throw new Error("not a property system");
  return { m, def, ctx, writer, stays, saved, secret: () => secret };
}

describe("apaleo: one booking per key", () => {
  it("replays the same request with the same Idempotency-Key, and gets the same booking", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-idem-1", "2027-02-14", "2027-02-16");
    const a = await writer.put(ctx(), stay, null, "confirmed");
    const b = await writer.put(ctx(), stay, null, "confirmed");
    expect(b.externalId).toBe(a.externalId);
    expect(m.bookings.size).toBe(1);
    const posts = m.platform.requests("POST", "https://api.apaleo.com/booking/v1/bookings");
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.headers.get("idempotency-key"))).toEqual(["sd-idem-1", "sd-idem-1"]);
    expect(posts[0]?.body).toBe(posts[1]?.body);
  });

  it("refuses the same key with other parameters, rather than booking twice", async () => {
    const { m, ctx, writer } = setup();
    await writer.put(ctx(), stayOf("sd-idem-2", "2027-02-20", "2027-02-22"), null, "confirmed");
    await expect(
      writer.put(ctx(), stayOf("sd-idem-2", "2027-02-20", "2027-02-23"), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
    });
    expect(m.bookings.size).toBe(1);
  });

  it("finds a stay by its externalCode once the key has lapsed, and never an earlier key's longer code", async () => {
    const { m, ctx, writer } = setup();
    const first = stayOf("sd-01JC0DEX", "2027-03-01", "2027-03-02");
    const link = await writer.put(ctx(), first, null, "confirmed");
    // Written again after a late payment, under a key of its own that starts with the first.
    await writer.put(ctx(), stayOf("sd-01JC0DEX-r-01JC0LATE", "2027-03-05", "2027-03-06"), null, "confirmed");
    m.advance(25 * 3_600_000);
    expect((await writer.find(ctx(), first))?.externalId).toBe(link.externalId);
    expect(await writer.find(ctx(), stayOf("sd-01JC0NONE", "2027-03-01", "2027-03-02"))).toBeNull();
  });
});

describe("apaleo: what is written, and what never is", () => {
  it("writes direct, with a 6 pm hold, our code, no price and no card; names the guest only once confirmed", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-write-1", "2027-04-10", "2027-04-13");
    const link = await writer.put(ctx(), stay, null, "provisional");
    const [post] = m.platform.requests("POST", "https://api.apaleo.com/booking/v1/bookings");
    const body = JSON.parse(post?.body ?? "{}") as { booker: unknown; reservations: Record<string, unknown>[] };
    expect(body.booker).toEqual({ lastName: stay.reference });
    expect(body.reservations[0]).toMatchObject({
      arrival: "2027-04-10",
      departure: "2027-04-13",
      channelCode: "Direct",
      guaranteeType: "PM6Hold",
      externalCode: "sd-write-1",
    });
    expect(body.reservations[0]?.timeSlices).toEqual([
      { ratePlanId: FLEX_LAKE.id },
      { ratePlanId: FLEX_LAKE.id },
      { ratePlanId: FLEX_LAKE.id },
    ]);
    expect(post?.body).not.toMatch(/totalAmount|totalGrossAmount|prePayment|commission|paymentAccount|registeredCard/);
    expect(body.reservations[0]?.primaryGuest).toBeUndefined();
    // Paid: confirmed, with the guest as the primary guest.
    await writer.put(ctx(), { ...stay, guest: { name: "Aroha Ngata", email: "aroha@example.nz" } }, link, "confirmed");
    const [r] = [...m.reservations.values()];
    expect(r?.primaryGuest).toEqual({ firstName: "Aroha", lastName: "Ngata", email: "aroha@example.nz" });
    expect(cardRequests(m.platform.seen)).toEqual([]);
  });

  it("never calls $force, payment accounts or authorizations, and never asks for them", async () => {
    const { m, ctx, writer, stays } = setup();
    const stay = stayOf("sd-force-1", "2027-05-01", "2027-05-03");
    await writer.put(ctx(), stay, null, "confirmed");
    // Full: refused, not forced.
    await expect(
      writer.put(ctx(), stayOf("sd-force-2", "2027-05-02", "2027-05-04"), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
    });
    await stays.ari(ctx(), PROPERTY.id, { from: "2027-05-01", to: "2027-05-05" });
    expect(m.forbidden).toEqual([]);
    expect(m.platform.seen.some((r) => /\$force|payment-accounts|authorizations/.test(r.url.pathname))).toBe(false);
    expect(APALEO_SCOPES.some((s) => /force|payment|authori/i.test(s))).toBe(false);
    expect(m.platform.seen.every((r) => APALEO_HOSTS.includes(r.url.host))).toBe(true);
  });

  it("leaves out rates that need a card as their guarantee, and rates not sold direct", async () => {
    const { ctx, stays } = setup();
    const plans = await stays.ratePlans(ctx(), PROPERTY.id);
    expect(plans.map((p) => p.id).sort()).toEqual([FLEX_BUNK.id, FLEX_LAKE.id].sort());
    expect(plans.map((p) => p.id)).not.toContain(CARD_LAKE.id);
  });

  it("a stay of two rooms whose second is refused is put back as it was", async () => {
    const { m, ctx, writer } = setup();
    const two = stayOf("sd-two-1", "2027-06-01", "2027-06-03", {
      rooms: [
        { roomId: LAKE.id, rateId: FLEX_LAKE.id, adults: 2, childrenAges: [], price: { value: 0, currency: "NZD" } },
        { roomId: BUNK.id, rateId: FLEX_BUNK.id, adults: 3, childrenAges: [7], price: { value: 0, currency: "NZD" } },
      ],
    });
    const link = await writer.put(ctx(), two, null, "confirmed");
    m.sell(BUNK.id, "2027-06-03", 3);
    await expect(writer.put(ctx(), { ...two, checkOut: "2027-06-04" }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    const lake = [...m.reservations.values()].find((r) => r.unitGroup === LAKE.id);
    expect(lake?.departure).toBe("2027-06-03");
    expect(m.free(LAKE.id, "2027-06-03")).toBe(1);
  });
});

describe("apaleo: east of the date line", () => {
  it("reads every night as the lodge's own date, whatever UTC date apaleo's time carries", async () => {
    const { ctx, stays } = setup();
    // In March Queenstown is UTC+13: a night that starts at noon there starts the day before in UTC.
    expect(apaleoNight("2027-02-28T23:00:00Z", PROPERTY.timeZone)).toBe("2027-03-01");
    const ari = await stays.ari(ctx(), PROPERTY.id, { from: "2027-03-01", to: "2027-03-04" });
    const rows = Array.isArray(ari) ? ari : ari.rows;
    expect(rows.filter((r) => r.roomId === LAKE.id).map((r) => [r.night, r.units, r.prices?.[FLEX_LAKE.id]])).toEqual([
      ["2027-03-01", 1, 24_500],
      ["2027-03-02", 1, 24_500],
      ["2027-03-03", 1, 24_500],
    ]);
    // In July it is UTC+12, and still the lodge's own date.
    const winter = await stays.ari(ctx(), PROPERTY.id, { from: "2027-07-01", to: "2027-07-02" });
    expect((Array.isArray(winter) ? winter : winter.rows).map((r) => r.night)).toEqual(["2027-07-01", "2027-07-01"]);
  });

  it("prices a stay from apaleo's own offer, night by night", async () => {
    const { ctx, stays } = setup();
    const price = await stays.price?.(ctx(), {
      propertyId: PROPERTY.id,
      roomId: BUNK.id,
      rateId: FLEX_BUNK.id,
      checkIn: "2027-03-01",
      checkOut: "2027-03-03",
      adults: 2,
      childrenAges: [4],
    });
    expect(price).toEqual({
      subtotal: { value: 24_100, currency: "NZD" },
      nights: [
        { night: "2027-03-01", amount: 12_050 },
        { night: "2027-03-02", amount: 12_050 },
      ],
    });
  });
});

describe("apaleo: signing in", () => {
  it("asks apaleo for exactly what it needs, with a state and a PKCE challenge", () => {
    const def = apaleoConnector(CLIENT);
    const url = new URL(
      def.oauth?.authorizeUrl({
        redirectUri: "https://inbox.whio.example/oauth/connect/apaleo/callback",
        state: "st4te",
        challenge: "ch4llenge",
      }) ?? "",
    );
    expect(url.origin).toBe("https://identity.apaleo.com");
    expect(url.pathname).toBe("/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT.clientId,
      state: "st4te",
      code_challenge: "ch4llenge",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("scope")?.split(" ")).toContain("offline_access");
  });

  it("exchanges the code with the verifier, keeps a refresh token, and subscribes to reservations", async () => {
    const m = fakeApaleo();
    const def = apaleoConnector(CLIENT);
    const base = runContext(m.platform.http, {});
    const c = await def.oauth?.exchange(
      {
        http: m.platform.http,
        now: m.now(),
        inbox: base.inbox,
        hookUrl: "https://inbox.whio.example/v1/hooks/apaleo/tok",
        hooksLive: true,
      },
      {
        code: AUTH_CODE,
        verifier: "v3rifier",
        redirectUri: "https://inbox.whio.example/oauth/connect/apaleo/callback",
      },
    );
    expect(c?.externalId).toBe(ACCOUNT.code);
    expect(c?.secret.refresh_token).toBe("fake-apaleo-refresh-1");
    expect(m.exchanges[0]).toMatchObject({ code_verifier: "v3rifier", grant_type: "authorization_code" });
    expect([...m.subscriptions.values()]).toEqual([
      { endpointUrl: "https://inbox.whio.example/v1/hooks/apaleo/tok", topics: ["Reservation"], propertyIds: [] },
    ]);
  });

  it("refreshes an access token that has run out, and keeps the new one sealed", async () => {
    const { m, ctx, stays, saved } = setup();
    m.advance(2 * 3_600_000);
    await stays.properties(ctx());
    expect(saved).toHaveLength(1);
    expect(saved[0]?.refresh_token).toBe("fake-apaleo-refresh-1");
    expect(Number(saved[0]?.access_expires_at)).toBeGreaterThan(m.now());
  });

  it("is not ready without a connect client; a hotel's own client stays off unless switched on", async () => {
    const off = apaleoConnector(null, { hosted: true });
    expect(off.ready?.()).toMatch(/connect client/);
    expect(off.whenNotReady?.status).toBe("setup");
    expect(off.whenNotReady?.hint).toMatch(/partner app/);
    const m = fakeApaleo();
    const base = runContext(m.platform.http, {});
    await expect(
      off.connect?.({ http: m.platform.http, now: m.now(), inbox: base.inbox }, OWN_CLIENT),
    ).rejects.toMatchObject({ code: "config" });
    expect(m.platform.seen).toEqual([]);
    expect(off.presets?.find((p) => p.id === "own_client")?.ready?.()).toMatch(/off on this server/);
    // Switched on by the operator: a hotel's own simple client connects.
    const own = apaleoConnector(null, { ownClient: true });
    expect(own.ready?.()).toBe(true);
    expect(own.auth).toBe("form");
    const c = await own.connect?.({ http: m.platform.http, now: m.now(), inbox: base.inbox }, OWN_CLIENT);
    expect(c?.externalId).toBe(ACCOUNT.code);
  });
});

describe("apaleo: webhooks are hints, checked first", () => {
  const request = (body: string) => ({ headers: new Headers(), body, query: new URLSearchParams() });

  it("refuses a delivery for another account, answers a health check, and reads a reservation back", async () => {
    const { ctx, writer, def, m } = setup();
    const hooks = def.hooks;
    if (!hooks) throw new Error("no hooks");
    await writer.put(ctx(), stayOf("sd-hook-1", "2027-08-10", "2027-08-12"), null, "confirmed");
    const [r] = [...m.reservations.values()];
    await expect(hooks.verify(ctx(), request(webhookBody(r?.id ?? "", { accountId: "OTHER" })))).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(await hooks.verify(ctx(), request(webhookBody("", { topic: "System", type: "healthcheck" })))).toBeNull();
    const event = await hooks.verify(ctx(), request(webhookBody(r?.id ?? "")));
    expect(event?.refs).toEqual([r?.id]);
    expect(await hooks.read(ctx(), event as never)).toEqual([
      { kind: "stay_nights", roomIds: [LAKE.id], from: "2027-08-10", to: "2027-08-12" },
    ]);
  });
});
