import { ConnectorError, type OutboundStay, type RunContext } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  CLOUDBEDS_EVENTS,
  CLOUDBEDS_HOOK_HEADER,
  CLOUDBEDS_HOSTS,
  cloudbedsConnector,
} from "../../src/connectors/property/cloudbeds";
import { cardRequests } from "../fakes/property/cards";
import { fakeCloudbeds } from "../fakes/property/cloudbeds";
import {
  API_KEY,
  ATLAS,
  AUTH_CODE,
  CLIENT,
  OWN_KEY,
  PATIO,
  PROPERTY,
  RATE_ATLAS,
  RATE_PATIO,
  webhookBody,
} from "../fixtures/property/cloudbeds";
import { propertyContract, runContext } from "./contract";

/**
 * Cloudbeds (ADR-033 §8.4) against a local Cloudbeds built from its documentation: the property system
 * contract (Cloudbeds documents no refusal of a full night, so the connector checks the nights live and
 * refuses them itself), a booking another channel took between the check and the write found by counting
 * reservations against rooms, the key delivered for a code, webhooks made with a header of ours and
 * checked in constant time, the property's own key behind its switch, and never a card.
 */

const HOOK_SECRET = "fake-cloudbeds-hook-secret-0123456789abcdef";

propertyContract("Cloudbeds (fake built from its documentation)", () => {
  const m = fakeCloudbeds();
  return {
    definition: cloudbedsConnector(CLIENT) as never,
    http: m.platform.http,
    secret: { api_key: API_KEY, hook_secret: HOOK_SECRET },
    propertyId: PROPERTY.propertyID,
    oneUnitRoom: ATLAS.roomTypeID,
    rate: RATE_ATLAS.rateID,
    // It refuses a full night itself, after its live check: a race past it is the read-back's.
    oversells: false,
  };
});

function stayOf(key: string, checkIn: string, checkOut: string, extra: Partial<OutboundStay> = {}): OutboundStay {
  return {
    itemId: `item-${key}`,
    reference: key.slice(-6).toUpperCase(),
    key,
    propertyId: PROPERTY.propertyID,
    checkIn,
    checkOut,
    rooms: [
      {
        roomId: ATLAS.roomTypeID,
        rateId: RATE_ATLAS.rateID,
        adults: 2,
        childrenAges: [],
        price: { value: 190_000, currency: "MAD" },
      },
    ],
    ...extra,
  };
}

function setup() {
  const m = fakeCloudbeds();
  const def = cloudbedsConnector(CLIENT);
  const ctx = (): RunContext => ({
    ...runContext(m.platform.http, { api_key: API_KEY, hook_secret: HOOK_SECRET }),
    extra: { propertyIds: [PROPERTY.propertyID] },
  });
  const writer = def.stayWriter;
  const stays = def.stays;
  if (!writer || !stays) throw new Error("not a property system");
  return { m, def, ctx, writer, stays };
}

describe("Cloudbeds: checked before, counted after", () => {
  it("a room another channel took between the check and the write is found oversold by counting", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-race-1", "2027-03-10", "2027-03-12");
    // The check finds the room free; a booking from another channel lands before ours is written.
    m.beforeWrite = () =>
      m.reservations.set("4199999", {
        reservationID: "4199999",
        status: "confirmed",
        startDate: "2027-03-11",
        endDate: "2027-03-12",
        thirdPartyIdentifier: "",
        dateCreated: "2027-01-01 00:00:00",
        guestFirstName: "Other",
        guestLastName: "Channel",
        rooms: [
          {
            subReservationID: "4199999-1",
            roomTypeID: ATLAS.roomTypeID,
            startDate: "2027-03-11",
            endDate: "2027-03-12",
            adults: 2,
            children: 0,
            rateID: "",
          },
        ],
      });
    const link = await writer.put(ctx(), stay, null, "confirmed");
    // Cloudbeds took ours as well: two bookings for its one room, and its own count shows none left, never below.
    expect(m.taken(ATLAS.roomTypeID, "2027-03-11")).toBe(2);
    // Counting its reservations against its rooms tells: the inbox then takes its own back.
    expect(await writer.oversold?.(ctx(), stay, link)).toBe(true);
    await writer.cancel(ctx(), link);
    expect(await writer.oversold?.(ctx(), stay, link)).toBe(false);
  });

  it("refuses a night with no room before anything is written", async () => {
    const { m, ctx, writer } = setup();
    m.sell(ATLAS.roomTypeID, "2027-04-02");
    await expect(
      writer.put(ctx(), stayOf("sd-full-1", "2027-04-01", "2027-04-03"), null, "confirmed"),
    ).rejects.toMatchObject({
      code: "refused",
    });
    expect(m.forms("postReservation")).toHaveLength(0);
  });
});

describe("Cloudbeds: what is written, and what never is", () => {
  it("writes our key, pays in cash at the riad, sends no email and no card; names the guest only once confirmed", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-write-1", "2027-05-01", "2027-05-04", {
      rooms: [
        {
          roomId: PATIO.roomTypeID,
          rateId: RATE_PATIO.rateID,
          adults: 2,
          childrenAges: [6, 9],
          price: { value: 0, currency: "MAD" },
        },
      ],
    });
    const link = await writer.put(ctx(), stay, null, "provisional");
    const [form] = m.forms("postReservation");
    expect(form?.get("thirdPartyIdentifier")).toBe("sd-write-1");
    expect(form?.get("paymentMethod")).toBe("cash");
    expect(form?.get("sendEmailConfirmation")).toBe("false");
    expect(form?.get("guestLastName")).toBe(stay.reference);
    expect(form?.get("guestEmail")).toBeNull();
    expect(form?.get("rooms[0][roomTypeID]")).toBe(PATIO.roomTypeID);
    expect(form?.get("rooms[0][roomRateID]")).toBe(RATE_PATIO.rateID);
    expect(form?.get("children[0][quantity]")).toBe("2");
    expect([...(form?.keys() ?? [])].some((k) => /card|authorization|rate$|price|total/i.test(k))).toBe(false);
    expect(m.reservations.get(link.externalId ?? "")?.status).toBe("not_confirmed");
    // Paid: confirmed in Cloudbeds.
    await writer.put(
      ctx(),
      { ...stay, guest: { name: "Yasmine El Idrissi", email: "yasmine@example.ma" } },
      link,
      "confirmed",
    );
    expect(m.reservations.get(link.externalId ?? "")?.status).toBe("confirmed");
    expect(cardRequests(m.platform.seen)).toEqual([]);
    expect(m.platform.seen.every((r) => CLOUDBEDS_HOSTS.includes(r.url.host))).toBe(true);
  });

  it("a guest written with a confirmed stay goes to Cloudbeds as the guest", async () => {
    const { m, ctx, writer } = setup();
    await writer.put(
      ctx(),
      { ...stayOf("sd-guest-1", "2027-06-01", "2027-06-02"), guest: { name: "Omar Benali", email: "omar@example.ma" } },
      null,
      "confirmed",
    );
    const [form] = m.forms("postReservation");
    expect([form?.get("guestFirstName"), form?.get("guestLastName"), form?.get("guestEmail")]).toEqual([
      "Omar",
      "Benali",
      "omar@example.ma",
    ]);
  });

  it("follows no answer to another host", async () => {
    const { m, ctx, stays } = setup();
    m.platform.fail("GET", "https://api.cloudbeds.com/api/v1.3/getHotels", { redirect: "https://evil.example/steal" });
    await expect(stays.properties(ctx())).rejects.toBeInstanceOf(ConnectorError);
    expect(m.platform.seen.some((r) => r.url.host === "evil.example")).toBe(false);
  });

  it("waits when Cloudbeds asks", async () => {
    const { m, ctx, stays } = setup();
    m.exhaust();
    const error = await stays.properties(ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 5_000 });
  });

  it("reads the property's rooms, their counts, and rates without a promo code", async () => {
    const { ctx, stays } = setup();
    expect(await stays.properties(ctx())).toEqual([
      { id: PROPERTY.propertyID, name: PROPERTY.propertyName, currency: "MAD", timezone: "Africa/Casablanca" },
    ]);
    expect((await stays.rooms(ctx(), PROPERTY.propertyID)).map((r) => [r.id, r.units])).toEqual([
      [ATLAS.roomTypeID, 1],
      [PATIO.roomTypeID, 2],
    ]);
    expect((await stays.ratePlans(ctx(), PROPERTY.propertyID)).map((r) => r.id)).toEqual([
      RATE_ATLAS.rateID,
      RATE_PATIO.rateID,
    ]);
    const price = await stays.price?.(ctx(), {
      propertyId: PROPERTY.propertyID,
      roomId: PATIO.roomTypeID,
      rateId: RATE_PATIO.rateID,
      checkIn: "2027-07-01",
      checkOut: "2027-07-03",
      adults: 2,
      childrenAges: [],
    });
    expect(price).toEqual({ subtotal: { value: 290_100, currency: "MAD" } });
  });
});

describe("Cloudbeds: connecting", () => {
  it("exchanges the code Cloudbeds sends back for the property's own key, and makes its webhooks with our header", async () => {
    const m = fakeCloudbeds();
    const def = cloudbedsConnector(CLIENT);
    const url = new URL(
      def.oauth?.authorizeUrl({
        redirectUri: "https://inbox.riad.example/oauth/connect/cloudbeds/callback",
        state: "st4te",
        challenge: "x",
      }) ?? "",
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://api.cloudbeds.com/api/v1.3/oauth");
    expect(url.searchParams.get("state")).toBe("st4te");
    const base = runContext(m.platform.http, {});
    const c = await def.oauth?.exchange(
      {
        http: m.platform.http,
        now: Date.now(),
        inbox: base.inbox,
        hookUrl: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
        hooksLive: true,
      },
      { code: AUTH_CODE, verifier: "", redirectUri: "https://inbox.riad.example/oauth/connect/cloudbeds/callback" },
    );
    expect(c?.secret.api_key).toBe(API_KEY);
    expect(c?.secret.hook_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c?.externalId).toBe(`org:${PROPERTY.organizationID}`);
    expect(m.webhooks).toHaveLength(CLOUDBEDS_EVENTS.length);
    expect(m.webhooks[0]).toMatchObject({
      object: "reservation",
      action: "created",
      endpointUrl: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
      authHeaderName: CLOUDBEDS_HOOK_HEADER,
      authHeaderValue: c?.secret.hook_secret,
    });
  });

  it("refuses a code that lapsed, and keeps nothing", async () => {
    const m = fakeCloudbeds();
    const def = cloudbedsConnector(CLIENT);
    const base = runContext(m.platform.http, {});
    await expect(
      def.oauth?.exchange(
        { http: m.platform.http, now: Date.now(), inbox: base.inbox },
        { code: "old", verifier: "", redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({ code: "auth" });
    expect(m.webhooks).toEqual([]);
  });

  it("is not ready without a partner app; a property's own key stays off unless switched on", async () => {
    const off = cloudbedsConnector(null, { hosted: true });
    expect(off.ready?.()).toMatch(/partner app/);
    expect(off.whenNotReady).toMatchObject({ status: "setup" });
    const m = fakeCloudbeds();
    const base = runContext(m.platform.http, {});
    await expect(
      off.connect?.({ http: m.platform.http, now: Date.now(), inbox: base.inbox }, { api_key: OWN_KEY }),
    ).rejects.toMatchObject({ code: "config" });
    expect(m.platform.seen).toEqual([]);
    const own = cloudbedsConnector(null, { propertyKey: true });
    expect(own.ready?.()).toBe(true);
    const c = await own.connect?.({ http: m.platform.http, now: Date.now(), inbox: base.inbox }, { api_key: OWN_KEY });
    expect(c?.secret.api_key).toBe(OWN_KEY);
  });
});

describe("Cloudbeds: webhooks are hints, checked first", () => {
  const request = (body: string, header: string | null) => ({
    headers: new Headers(header === null ? {} : { [CLOUDBEDS_HOOK_HEADER]: header }),
    body,
    query: new URLSearchParams(),
  });

  it("refuses a delivery without our header, or about another property; reads the reservation back", async () => {
    const { ctx, writer, def } = setup();
    const hooks = def.hooks;
    if (!hooks) throw new Error("no hooks");
    const link = await writer.put(ctx(), stayOf("sd-hook-1", "2027-09-05", "2027-09-08"), null, "confirmed");
    const id = link.externalId ?? "";
    await expect(hooks.verify(ctx(), request(webhookBody(id), null))).rejects.toMatchObject({ code: "refused" });
    await expect(hooks.verify(ctx(), request(webhookBody(id), `${HOOK_SECRET}0`))).rejects.toMatchObject({
      code: "refused",
    });
    await expect(hooks.verify(ctx(), request(webhookBody(id, undefined, "11111"), HOOK_SECRET))).rejects.toMatchObject({
      code: "refused",
    });
    // Its own spelling for dates changed (propertyId, reservationId): the dates it carries are never believed.
    const event = await hooks.verify(ctx(), request(webhookBody(id, "reservation/dates_changed"), HOOK_SECRET));
    expect(event?.refs).toEqual([`${PROPERTY.propertyID}:${id}`]);
    expect(await hooks.read(ctx(), event as never)).toEqual([
      { kind: "stay_nights", roomIds: [ATLAS.roomTypeID], from: "2027-09-05", to: "2027-09-08" },
    ]);
  });

  it("a deleted reservation, which cannot be read, has the months ahead read again", async () => {
    const { ctx, def } = setup();
    const event = await def.hooks?.verify(ctx(), request(webhookBody("4188888", "reservation/deleted"), HOOK_SECRET));
    const facts = await def.hooks?.read(ctx(), event as never);
    expect(facts).toHaveLength(1);
    expect(facts?.[0]).toMatchObject({ kind: "stay_nights" });
    expect(facts?.[0] && "roomIds" in facts[0]).toBe(false);
  });
});
