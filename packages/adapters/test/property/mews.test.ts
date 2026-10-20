import { ConnectorError, instantOf, type OutboundStay } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  durationMs,
  MEWS_HOLD_RELEASE_MS,
  MEWS_HOSTS,
  MEWS_PROVISIONAL_RELEASE_MS,
  mewsConnector,
} from "../../src/connectors/property/mews";
import { cardRequests } from "../fakes/property/cards";
import { fakeMews } from "../fakes/property/mews";
import {
  ACCESS_TOKEN,
  CHILDREN,
  CLIENT_TOKEN,
  DORM,
  DOUBLE,
  ENTERPRISE,
  FLEX,
  SERVICE,
  WEBHOOK_TOKEN,
  webhookBody,
} from "../fixtures/property/mews";
import { propertyContract, runContext } from "./contract";

/**
 * Mews (ADR-033 §8.4) against a local Mews built from its documentation: the property system contract,
 * its own hold (`Optional` with `ReleasedUtc`) and that hold let go, a move that would overbook put back,
 * the guest only once confirmed, the limit's wait, the webhook's secret, and never the demo environment.
 */

const partner = { clientToken: CLIENT_TOKEN, webhookToken: WEBHOOK_TOKEN };

propertyContract("Mews (fake built from its documentation)", () => {
  const m = fakeMews();
  return {
    definition: mewsConnector(partner) as never,
    http: m.platform.http,
    secret: { access_token: ACCESS_TOKEN },
    propertyId: SERVICE.Id,
    oneUnitRoom: DOUBLE.Id,
    rate: FLEX.Id,
    oversells: false,
  };
});

function stayOf(key: string, checkIn: string, checkOut: string, extra: Partial<OutboundStay> = {}): OutboundStay {
  return {
    itemId: `item-${key}`,
    reference: key.slice(-6).toUpperCase(),
    key,
    propertyId: SERVICE.Id,
    checkIn,
    checkOut,
    rooms: [
      { roomId: DOUBLE.Id, rateId: FLEX.Id, adults: 2, childrenAges: [], price: { value: 17_900, currency: "EUR" } },
    ],
    ...extra,
  };
}

function setup() {
  const m = fakeMews();
  const def = mewsConnector(partner);
  const ctx = () => ({
    ...runContext(m.platform.http, { access_token: ACCESS_TOKEN }, m.now()),
    marker: "inbox-marker-alpenrose",
  });
  const writer = def.stayWriter;
  const stays = def.stays;
  if (!writer || !stays) throw new Error("not a property system");
  return { m, def, ctx, writer, stays };
}

describe("Mews: its own hold, and its release", () => {
  it("a held stay is Optional with a release, blocks the room, and Mews lets it go by itself", async () => {
    const { m, ctx, writer } = setup();
    const c = ctx();
    await writer.put(c, stayOf("sd-hold-1", "2027-02-10", "2027-02-12"), null, "hold");
    const [r] = [...m.reservations.values()];
    expect(r?.State).toBe("Optional");
    expect(Date.parse(r?.ReleasedUtc ?? "") - c.now).toBe(MEWS_HOLD_RELEASE_MS);
    expect(m.free(DOUBLE.Id, "2027-02-10")).toBe(0);
    expect(m.free(DOUBLE.Id, "2027-02-11")).toBe(0);
    // Nobody confirmed it: Mews releases the room at the time it was told.
    m.advance(MEWS_HOLD_RELEASE_MS + 1_000);
    expect(m.free(DOUBLE.Id, "2027-02-10")).toBe(1);
    expect(r?.State).toBe("Canceled");
  });

  it("a stay waiting for its deposit is held three days at most, then confirmed with its guest", async () => {
    const { m, ctx, writer } = setup();
    const c = ctx();
    const stay = stayOf("sd-prov-1", "2027-03-05", "2027-03-08");
    const link = await writer.put(c, stay, null, "provisional");
    const [r] = [...m.reservations.values()];
    expect(r?.State).toBe("Optional");
    expect(Date.parse(r?.ReleasedUtc ?? "") - c.now).toBe(MEWS_PROVISIONAL_RELEASE_MS);
    // Before it is confirmed, Mews holds no guest's details: the customer is named by the reference.
    const placeholder = m.customers.get(r?.CustomerId ?? "");
    expect(placeholder?.LastName).toBe(stay.reference);
    expect(placeholder?.Email).toBeUndefined();
    // Paid in time: confirmed in Mews, its release gone, the guest on it.
    m.advance(60 * 60_000);
    await writer.put(
      ctx(),
      { ...stay, guest: { name: "Lena Maria Hofer", email: "lena.hofer@example.org" } },
      link,
      "confirmed",
    );
    expect(r?.State).toBe("Confirmed");
    expect(r?.ReleasedUtc).toBeNull();
    const guest = m.customers.get(r?.CustomerId ?? "");
    expect(guest).toMatchObject({ LastName: "Hofer", FirstName: "Lena Maria", Email: "lena.hofer@example.org" });
    expect(m.bodies("reservations/confirm")).toHaveLength(1);
  });

  it("a hold never outlasts the arrival it is for", async () => {
    const { m, ctx, writer } = setup();
    // 13:00 in Innsbruck on the day of arrival: the stay starts at 15:00, two hours on.
    m.advance(instantOf("2027-07-01", "13:00", ENTERPRISE.TimeZoneIdentifier) - m.now());
    const c = ctx();
    await writer.put(c, stayOf("sd-hold-late", "2027-07-01", "2027-07-02"), null, "provisional");
    const [r] = [...m.reservations.values()];
    expect(Date.parse(r?.StartUtc ?? "") - c.now).toBe(2 * 3_600_000);
    expect(Date.parse(r?.ReleasedUtc ?? "")).toBe(Date.parse(r?.StartUtc ?? "") - 60_000);
  });
});

describe("Mews: what is written", () => {
  it("asks Mews to refuse an overbooking, prices nothing itself, sends no email, and notes our key", async () => {
    const { m, ctx, writer } = setup();
    const c = ctx();
    await writer.put(c, stayOf("sd-write-1", "2027-04-01", "2027-04-03"), null, "confirmed");
    const [add] = m.bodies("reservations/add");
    expect(add).toMatchObject({ CheckOverbooking: true, SendConfirmationEmail: false, ServiceId: SERVICE.Id });
    const text = JSON.stringify(add);
    expect(text).not.toContain("TimeUnitPrices");
    expect(text).not.toContain("TimeUnitAmount");
    expect(text).not.toContain("CreditCardId");
    // The note carries our key and a tag only this inbox can make, never the marker itself.
    expect(m.notes[0]?.Text).toMatch(/^Inbox stay [A-Z0-9-]+ · sd-write-1#[0-9a-f]{16}$/);
    expect(text).not.toContain(c.marker);
    // A stay starts at 15:00 and ends at 11:00, Innsbruck time.
    const [r] = [...m.reservations.values()];
    expect(r?.StartUtc).toBe("2027-04-01T13:00:00Z");
    expect(r?.EndUtc).toBe("2027-04-03T09:00:00Z");
  });

  it("counts a child by the age category Mews keeps for that age", async () => {
    const { m, ctx, writer } = setup();
    await writer.put(
      ctx(),
      stayOf("sd-kids-1", "2027-04-10", "2027-04-11", {
        rooms: [
          { roomId: DOUBLE.Id, rateId: FLEX.Id, adults: 1, childrenAges: [9], price: { value: 0, currency: "EUR" } },
        ],
      }),
      null,
      "confirmed",
    );
    const [add] = m.bodies("reservations/add");
    const people = (add?.Reservations as { PersonCounts: unknown }[] | undefined)?.[0]?.PersonCounts;
    expect(people).toContainEqual({ AgeCategoryId: CHILDREN.Id, Count: 1 });
  });

  it("a move onto a night Mews has no room for is put back, and refused", async () => {
    const { m, ctx, writer } = setup();
    const c = ctx();
    const mine = stayOf("sd-move-1", "2027-05-01", "2027-05-03");
    const link = await writer.put(c, mine, null, "confirmed");
    m.sell(DOUBLE.Id, "2027-05-03");
    const r = [...m.reservations.values()][0];
    const before = { start: r?.StartUtc, end: r?.EndUtc };
    await expect(writer.put(ctx(), { ...mine, checkOut: "2027-05-04" }, link, "confirmed")).rejects.toMatchObject({
      code: "refused",
    });
    expect({ start: r?.StartUtc, end: r?.EndUtc }).toEqual(before);
    expect(m.free(DOUBLE.Id, "2027-05-03")).toBe(0);
    expect(m.bodies("reservations/update")).toHaveLength(2);
  });

  it("reads the system's own price for a stay", async () => {
    const { ctx, stays } = setup();
    const price = await stays.price?.(ctx(), {
      propertyId: SERVICE.Id,
      roomId: DORM.Id,
      rateId: FLEX.Id,
      checkIn: "2027-06-01",
      checkOut: "2027-06-04",
      adults: 1,
      childrenAges: [],
    });
    expect(price).toEqual({ subtotal: { value: 9_600, currency: "EUR" } });
  });

  it("lists the bookable service as the property, and only public rates", async () => {
    const { ctx, stays } = setup();
    const props = await stays.properties(ctx());
    expect(props).toEqual([
      { id: SERVICE.Id, name: ENTERPRISE.Name, currency: "EUR", timezone: ENTERPRISE.TimeZoneIdentifier },
    ]);
    const rooms = await stays.rooms(ctx(), SERVICE.Id);
    expect(rooms.map((r) => [r.name, r.units])).toEqual([
      [DORM.Name, 6],
      [DOUBLE.Name, 1],
    ]);
    expect((await stays.ratePlans(ctx(), SERVICE.Id)).map((r) => r.id)).toEqual([FLEX.Id]);
    const ari = await stays.ari(ctx(), SERVICE.Id, { from: "2027-03-27", to: "2027-03-30" });
    const rows = Array.isArray(ari) ? ari : ari.rows;
    // Across the spring change of clocks, a night is still the date it starts on, in Innsbruck.
    expect(rows.filter((r) => r.roomId === DORM.Id).map((r) => [r.night, r.units, r.prices?.[FLEX.Id]])).toEqual([
      ["2027-03-27", 6, 3_200],
      ["2027-03-28", 6, 3_200],
      ["2027-03-29", 6, 3_200],
    ]);
  });
});

describe("Mews: limits, hosts and secrets", () => {
  it("waits as long as Mews says when its 200 requests are spent", async () => {
    const { m, ctx, stays } = setup();
    m.exhaust();
    const error = await stays.rooms(ctx(), SERVICE.Id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("rate_limited");
    expect((error as ConnectorError).retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });

  it("calls production only, never the public demo environment", async () => {
    const { m, ctx, writer, stays } = setup();
    await stays.properties(ctx());
    await writer.put(ctx(), stayOf("sd-host-1", "2027-08-01", "2027-08-02"), null, "confirmed");
    expect(MEWS_HOSTS).toEqual(["api.mews.com"]);
    expect(m.platform.seen.length).toBeGreaterThan(0);
    expect(m.platform.seen.every((r) => r.url.host === "api.mews.com")).toBe(true);
    expect(JSON.stringify(m.platform.seen.map((r) => r.url.href))).not.toContain("mews-demo");
  });

  it("never sends a card, or anything that would carry one", async () => {
    const { m, ctx, writer } = setup();
    const stay = stayOf("sd-card-1", "2027-09-01", "2027-09-03");
    const link = await writer.put(ctx(), stay, null, "provisional");
    await writer.put(ctx(), { ...stay, guest: { name: "Aiko Tanaka", email: "aiko@example.jp" } }, link, "confirmed");
    await writer.cancel(ctx(), link);
    expect(cardRequests(m.platform.seen)).toEqual([]);
  });

  it("is not ready without the partner's token, and connects nothing", async () => {
    const off = mewsConnector(null, { hosted: true });
    expect(off.ready?.()).toMatch(/partner token/);
    expect(off.whenNotReady).toMatchObject({ status: "setup" });
    expect(off.whenNotReady?.hint).toMatch(/partner account/);
    const m = fakeMews();
    await expect(
      off.connect?.(
        { http: m.platform.http, now: Date.now(), inbox: runContext(m.platform.http, {}).inbox },
        { access_token: ACCESS_TOKEN },
      ),
    ).rejects.toMatchObject({ code: "config" });
    expect(m.platform.seen).toEqual([]);
  });

  it("connects one property by its access token, and keeps its zone and currency", async () => {
    const m = fakeMews();
    const def = mewsConnector(partner);
    const c = await def.connect?.(
      { http: m.platform.http, now: Date.now(), inbox: runContext(m.platform.http, {}).inbox },
      { access_token: ACCESS_TOKEN },
    );
    expect(c).toMatchObject({
      account: ENTERPRISE.Name,
      externalId: ENTERPRISE.Id,
      secret: { access_token: ACCESS_TOKEN },
      extra: { enterpriseId: ENTERPRISE.Id, timezone: "Europe/Vienna", currency: "EUR" },
    });
  });
});

describe("Mews: webhooks are hints, checked first", () => {
  async function prepared() {
    const s = setup();
    const ctx = { ...s.ctx(), extra: { enterpriseId: ENTERPRISE.Id, timezone: ENTERPRISE.TimeZoneIdentifier } };
    const link = await s.writer.put(ctx, stayOf("sd-hook-1", "2027-10-02", "2027-10-05"), null, "confirmed");
    const r = [...s.m.reservations.values()].find((x) => x.GroupId === link.externalId);
    if (!r || !s.def.hooks) throw new Error("not written");
    return { ...s, ctx, r, hooks: s.def.hooks };
  }
  const request = (body: string, token: string | null) => ({
    headers: new Headers({ "content-type": "application/json" }),
    body,
    query: new URLSearchParams(token === null ? {} : { token }),
  });

  it("refuses a delivery without Mews's shared secret, or with another", async () => {
    const { ctx, r, hooks } = await prepared();
    await expect(hooks.verify(ctx, request(webhookBody([r.Id]), null))).rejects.toMatchObject({ code: "refused" });
    await expect(hooks.verify(ctx, request(webhookBody([r.Id]), `${WEBHOOK_TOKEN}x`))).rejects.toMatchObject({
      code: "refused",
    });
    // Not configured on this server: nothing is believed.
    const plain = mewsConnector({ clientToken: CLIENT_TOKEN });
    await expect(plain.hooks?.verify(ctx, request(webhookBody([r.Id]), WEBHOOK_TOKEN))).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("refuses a delivery about another property", async () => {
    const { ctx, r, hooks } = await prepared();
    const other = webhookBody([r.Id], "00000000-0000-4000-8000-000000000000");
    await expect(hooks.verify(ctx, request(other, WEBHOOK_TOKEN))).rejects.toMatchObject({ code: "refused" });
  });

  it("names reservations by id only, and reads them back from Mews", async () => {
    const { ctx, r, hooks } = await prepared();
    const body = webhookBody([r.Id]);
    const event = await hooks.verify(ctx, request(body, WEBHOOK_TOKEN));
    expect(event?.refs).toEqual([r.Id]);
    // The same delivery again is the same event: kept once.
    expect((await hooks.verify(ctx, request(body, WEBHOOK_TOKEN)))?.eventId).toBe(event?.eventId);
    expect(await hooks.read(ctx, event as never)).toEqual([
      { kind: "stay_nights", roomIds: [DOUBLE.Id], from: "2027-10-02", to: "2027-10-05" },
    ]);
  });

  it("reads ISO 8601 durations as Mews writes them", () => {
    expect(durationMs("PT15H")).toBe(15 * 3_600_000);
    expect(durationMs("P0M0DT11H0M0S")).toBe(11 * 3_600_000);
    expect(durationMs("-PT2H30M")).toBe(-(2 * 3_600_000 + 30 * 60_000));
    expect(durationMs("P1M")).toBeNull();
    expect(durationMs("nonsense")).toBeNull();
  });
});
