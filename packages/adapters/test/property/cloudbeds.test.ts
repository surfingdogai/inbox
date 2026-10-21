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
  DORM,
  OWN_KEY,
  PATIO,
  PROPERTY,
  RATE_ATLAS,
  RATE_DORM,
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
    m.beforeWrite = () => {
      m.add({ status: "confirmed", roomTypeID: ATLAS.roomTypeID, startDate: "2027-03-11", endDate: "2027-03-12" });
    };
    const link = await writer.put(ctx(), stay, null, "confirmed");
    // Cloudbeds took ours as well: two bookings for its one room, and its own count shows none left, never below.
    expect(m.taken(ATLAS.roomTypeID, "2027-03-11")).toBe(2);
    // Counting its reservations against its rooms tells: the inbox then takes its own back.
    expect(await writer.oversold?.(ctx(), stay, link)).toBe(true);
    // Taken back: the other channel's booking alone holds the room.
    await writer.cancel(ctx(), link);
    expect(m.taken(ATLAS.roomTypeID, "2027-03-11")).toBe(1);
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

  it("counts every page: a hundred cancelled reservations first never hide a night sold twice", async () => {
    const { m, ctx, writer } = setup();
    // A busy calendar: a hundred cancelled stays on those nights, listed before anything live.
    for (let i = 0; i < 100; i++) {
      m.add({ status: "canceled", roomTypeID: ATLAS.roomTypeID, startDate: "2027-03-20", endDate: "2027-03-23" });
    }
    const stay = stayOf("sd-pages-1", "2027-03-20", "2027-03-22");
    m.beforeWrite = () => {
      m.add({ status: "confirmed", roomTypeID: ATLAS.roomTypeID, startDate: "2027-03-21", endDate: "2027-03-22" });
    };
    const link = await writer.put(ctx(), stay, null, "confirmed");
    expect(m.taken(ATLAS.roomTypeID, "2027-03-21")).toBe(2);
    const before = m.platform.seen.length;
    expect(await writer.oversold?.(ctx(), stay, link)).toBe(true);
    // Every page, each reservation with its rooms: never one reservation at a time.
    const asked = m.platform.seen.slice(before);
    const pages = asked.filter((r) => r.url.pathname.endsWith("/getReservations"));
    expect(pages.map((r) => r.url.searchParams.get("pageNumber"))).toEqual(["1", "2"]);
    expect(pages.every((r) => r.url.searchParams.get("includeAllRooms") === "true")).toBe(true);
    expect(asked.some((r) => r.url.pathname.endsWith("/getReservation"))).toBe(false);
  });

  it("cannot tell before the list shows the reservation just written, and says so", async () => {
    const { ctx, writer } = setup();
    const stay = stayOf("sd-lag-1", "2027-03-25", "2027-03-26");
    // A reservation the list does not show (yet): no word on it is taken as fine.
    await expect(
      writer.oversold?.(ctx(), stay, { externalId: "4999999", etag: null, calendar: null }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("Cloudbeds: once written, never refused", () => {
  it("keeps the reservation it made when Cloudbeds does not take its status after it", async () => {
    const { m, ctx, writer } = setup();
    m.refuseNext.add("putReservation");
    const link = await writer.put(ctx(), stayOf("sd-status-1", "2027-04-20", "2027-04-22"), null, "provisional");
    // Written: the inbox knows it, and Cloudbeds holds the room as it made it.
    expect(link.externalId).toBeTruthy();
    expect(m.reservations.get(link.externalId ?? "")?.status).toBe("confirmed");
    expect(m.taken(ATLAS.roomTypeID, "2027-04-20")).toBe(1);
    // Found again by its key: never written twice.
    expect((await writer.find(ctx(), stayOf("sd-status-1", "2027-04-20", "2027-04-22")))?.externalId).toBe(
      link.externalId,
    );
  });

  it("never answers a stay cancelled in Cloudbeds since as written", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-gone-1", "2027-04-25", "2027-04-26");
    const link = await writer.put(ctx(), stay, null, "confirmed");
    await writer.cancel(ctx(), link);
    await expect(writer.put(ctx(), stay, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
    expect(m.forms("postReservation")).toHaveLength(1);
  });
});

describe("Cloudbeds: a stay of two rooms, given back in Cloudbeds' own order", () => {
  const two = (key: string): OutboundStay =>
    stayOf(key, "2027-06-10", "2027-06-12", {
      rooms: [
        {
          roomId: ATLAS.roomTypeID,
          rateId: RATE_ATLAS.rateID,
          adults: 2,
          childrenAges: [],
          price: { value: 190_000, currency: "MAD" },
        },
        {
          roomId: PATIO.roomTypeID,
          rateId: RATE_PATIO.rateID,
          adults: 3,
          childrenAges: [],
          price: { value: 290_100, currency: "MAD" },
        },
      ],
    });

  it("confirms it as it is when the hotel assigned the second room first: nothing swapped, nothing repriced", async () => {
    const { m, ctx, writer } = setup();
    const stay = two("sd-two-1");
    const link = await writer.put(ctx(), stay, null, "provisional");
    const r = m.reservations.get(link.externalId ?? "");
    // The suite is assigned at the desk: Cloudbeds now lists it first.
    m.assign(link.externalId ?? "", r?.rooms[1]?.subReservationID ?? "");
    await writer.put(ctx(), { ...stay, guest: { name: "Nadia Amrani", email: "nadia@example.ma" } }, link, "confirmed");
    const rooms = m.forms("putReservation").filter((f) => f.has("rooms[0][roomTypeID]"));
    expect(rooms).toEqual([]);
    expect(r?.rooms.map((x) => [x.roomTypeID, x.adults])).toEqual([
      [ATLAS.roomTypeID, 2],
      [PATIO.roomTypeID, 3],
    ]);
    expect(r?.status).toBe("confirmed");
  });

  it("moves each room by its own kind when the dates change", async () => {
    const { m, ctx, writer } = setup();
    const stay = two("sd-two-2");
    const link = await writer.put(ctx(), stay, null, "confirmed");
    const r = m.reservations.get(link.externalId ?? "");
    m.assign(link.externalId ?? "", r?.rooms[1]?.subReservationID ?? "");
    await writer.put(ctx(), { ...stay, checkOut: "2027-06-13" }, link, "confirmed");
    expect(r?.rooms.map((x) => [x.roomTypeID, x.adults, x.endDate])).toEqual([
      [ATLAS.roomTypeID, 2, "2027-06-13"],
      [PATIO.roomTypeID, 3, "2027-06-13"],
    ]);
  });
});

describe("Cloudbeds: the guest, the note and the total", () => {
  it("names the guest on the reservation once paid, so the desk has them at check-in", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-name-1", "2027-07-10", "2027-07-12");
    const link = await writer.put(ctx(), stay, null, "provisional");
    const r = m.reservations.get(link.externalId ?? "");
    expect([r?.guestFirstName, r?.guestLastName]).toEqual(["Guest", stay.reference]);
    await writer.put(
      ctx(),
      { ...stay, guest: { name: "Youssef Alaoui", email: "youssef@example.ma", phone: "+212600000000" } },
      link,
      "confirmed",
    );
    expect([r?.guestFirstName, r?.guestLastName, r?.guestEmail, r?.guestPhone]).toEqual([
      "Youssef",
      "Alaoui",
      "youssef@example.ma",
      "+212600000000",
    ]);
    expect(m.forms("putGuest")).toHaveLength(1);
  });

  it("notes the stay's reference and what the guest agreed, and reads back Cloudbeds' own total", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-note-1", "2027-07-20", "2027-07-22");
    const link = await writer.put(ctx(), stay, null, "confirmed");
    expect(m.reservations.get(link.externalId ?? "")?.notes).toEqual([
      `Inbox stay ${stay.reference} · agreed with the guest: MAD 1900.00`,
    ]);
    expect(link.total).toEqual({ value: 190_000, currency: "MAD" });
  });

  it("quotes nothing from a rate that leaves out the property's own taxes, and reads the total with them", async () => {
    const { m, ctx, writer, stays } = setup();
    m.taxes.push({
      type: "tax",
      name: "TVA",
      amount: 10,
      amountType: "percentage",
      inclusiveOrExclusive: "exclusive",
      availableFor: ["rate"],
    });
    const read = await stays.ari(ctx(), PROPERTY.propertyID, { from: "2027-08-01", to: "2027-08-03" });
    const rows = Array.isArray(read) ? read : read.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Object.keys(r.prices ?? {}).length === 0)).toBe(true);
    expect(
      await stays.price?.(ctx(), {
        propertyId: PROPERTY.propertyID,
        roomId: ATLAS.roomTypeID,
        rateId: RATE_ATLAS.rateID,
        checkIn: "2027-08-01",
        checkOut: "2027-08-03",
        adults: 2,
        childrenAges: [],
      }),
    ).toBeNull();
    // The owner priced it at the rate: Cloudbeds' own total, with its tax, says otherwise.
    const link = await writer.put(ctx(), stayOf("sd-tax-1", "2027-08-01", "2027-08-03"), null, "confirmed");
    expect(link.total).toEqual({ value: 209_000, currency: "MAD" });
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
    // A hostel's beds in a shared room are rooms too: never read as having nothing free.
    expect((await stays.rooms(ctx(), PROPERTY.propertyID)).map((r) => [r.id, r.units])).toEqual([
      [ATLAS.roomTypeID, 1],
      [PATIO.roomTypeID, 2],
      [DORM.roomTypeID, 6],
    ]);
    expect((await stays.ratePlans(ctx(), PROPERTY.propertyID)).map((r) => r.id)).toEqual([
      RATE_ATLAS.rateID,
      RATE_PATIO.rateID,
      RATE_DORM.rateID,
    ]);
    const dorm = await stays.ari(ctx(), PROPERTY.propertyID, { from: "2027-07-01", to: "2027-07-02" });
    expect((Array.isArray(dorm) ? dorm : dorm.rows).find((r) => r.roomId === DORM.roomTypeID)).toMatchObject({
      units: 6,
      prices: { [RATE_DORM.rateID]: 18_000 },
    });
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
  it("exchanges the code Cloudbeds sends back for the property's own key; its webhooks, once kept, carry our header", async () => {
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
    // Nothing is made on Cloudbeds before the connection is kept: its first sync makes the webhooks.
    expect(m.webhooks).toEqual([]);
    const kept: RunContext = {
      ...runContext(m.platform.http, c?.secret ?? {}),
      hookUrl: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
      extra: c?.extra ?? {},
    };
    expect(def.stale?.(kept)).toBe(true);
    const fresh = await def.refresh?.(kept);
    expect(m.webhooks).toHaveLength(CLOUDBEDS_EVENTS.length);
    expect(m.webhooks[0]).toMatchObject({
      object: "reservation",
      action: "created",
      endpointUrl: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
      authHeaderName: CLOUDBEDS_HOOK_HEADER,
      authHeaderValue: c?.secret.hook_secret,
    });
    expect(fresh?.extra).toMatchObject({
      webhook: "added",
      hook_url: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
    });
    // Made: not again, until the inbox's address moves.
    const after: RunContext = { ...kept, extra: fresh?.extra ?? {} };
    expect(def.stale?.(after)).toBe(false);
    expect(def.stale?.({ ...after, hookUrl: "https://inbox.riad-zellige.example/v1/hooks/cloudbeds/tok" })).toBe(true);
  });

  it("makes no webhook while a hosted inbox cannot be reached yet", async () => {
    const m = fakeCloudbeds();
    const def = cloudbedsConnector(CLIENT);
    const waiting: RunContext = {
      ...runContext(m.platform.http, { api_key: API_KEY, hook_secret: HOOK_SECRET }),
      hookUrl: "https://inbox.riad.example/v1/hooks/cloudbeds/tok",
      hooksLive: false,
      extra: { propertyIds: [PROPERTY.propertyID], webhook: "pending" },
    };
    expect(def.stale?.(waiting)).toBe(false);
    await def.refresh?.(waiting);
    expect(m.webhooks).toEqual([]);
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
    // Hosted: nothing for an owner to do, so Soon; on one's own server, what its operator sets.
    expect(off.whenNotReady).toEqual({ status: "soon" });
    expect(cloudbedsConnector(null).whenNotReady).toMatchObject({
      status: "setup",
      hint: /partner app on this server/,
    });
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
