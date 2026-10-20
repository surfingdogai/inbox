import { describe, expect, it } from "vitest";
import { lodgingJsonLd } from "../src/stays/public";
import { readSetup } from "../src/stays/store";
import type { WriteError } from "../src/write/index";
import { clock, contact, guest, kijaniHouse, mapleHollow, owner } from "./stay-fixtures";

/**
 * The stays doors as a guest's assistant meets them (ADR-033 §6): at most two holds open per assistant;
 * a change and a cancellation each answered with what they cost first, and taken only with that
 * fingerprint; a property that takes stays at its own booking engine sending assistants there with
 * the dates filled in; and schema.org's reading of the place, with an offer only where a stay is
 * booked at once.
 */
async function bookedMaple(nights: { in: string; out: string } = { in: "2026-12-04", out: "2026-12-06" }) {
  clock.now = Date.parse("2026-11-02T13:00:00Z");
  const m = await mapleHollow();
  const held = await m.caps.stays.hold(guest(), {
    check_in: nights.in,
    check_out: nights.out,
    rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
    contact,
    consent: true,
  });
  const token = held.accessToken as string;
  const booked = await m.caps.stays.book(guest({ accessToken: token }), {
    item_id: held.view.item.id,
    terms_sha: held.terms_sha,
  });
  expect(booked.view.item.state).toBe("confirmed");
  return { m, id: held.view.item.id, token };
}

describe("the stays doors", () => {
  it("lets one assistant hold two stays at most", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    await m.caps.stays.setAllotment(owner, {
      room_type_id: m.rooms.harbour,
      from_date: "2026-11-01",
      to_date: "2027-03-31",
      units: 3,
      closed_elsewhere: true,
    });
    const agent = () => ({ ...guest(), agent: { level: "self" as const, thumbprint: "tp-maple-1" } });
    const hold = (checkIn: string, checkOut: string) =>
      m.caps.stays.hold(agent(), {
        check_in: checkIn,
        check_out: checkOut,
        rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
        contact,
        consent: true,
      });
    expect((await hold("2026-12-04", "2026-12-06")).view.item.state).toBe("held");
    expect((await hold("2026-12-10", "2026-12-12")).view.item.state).toBe("held");
    const third = await hold("2026-12-18", "2026-12-20").catch((e: WriteError) => e);
    expect(third).toMatchObject({ code: "guard_failed", details: { guard: "holds" } });
    // Another assistant is not held back by this one's.
    const other = await m.caps.stays.hold(
      { ...guest(), agent: { level: "self", thumbprint: "tp-maple-2" } },
      {
        check_in: "2026-12-18",
        check_out: "2026-12-20",
        rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
        contact,
        consent: true,
      },
    );
    expect(other.view.item.state).toBe("held");
  });

  it("answers a change with its new total first, and asks the property only with that fingerprint", async () => {
    const { m, id, token } = await bookedMaple();
    const asked = await m.caps.stays
      .change(guest({ accessToken: token }), { item_id: id, check_in: "2026-12-04", check_out: "2026-12-07" })
      .catch((e: WriteError) => e);
    expect(asked).toMatchObject({
      code: "confirm_terms",
      details: { total: { value: 3 * 18_900 + Math.round(3 * 18_900 * 0.15), currency: "CAD" } },
    });
    const sha = ((asked as WriteError).details as { terms_sha: string }).terms_sha;
    const stale = await m.caps.stays
      .change(guest({ accessToken: token }), {
        item_id: id,
        check_in: "2026-12-04",
        check_out: "2026-12-07",
        terms_sha: "x".repeat(43),
      })
      .catch((e: WriteError) => e);
    expect((stale as WriteError).code).toBe("offer_changed");
    const sent = await m.caps.stays.change(guest({ accessToken: token }), {
      item_id: id,
      check_in: "2026-12-04",
      check_out: "2026-12-07",
      terms_sha: sha,
    });
    expect(sent.view.item.payload).toMatchObject({ change: { checkIn: "2026-12-04", checkOut: "2026-12-07" } });
  });

  it("names the guest arriving today, as they gave their name", async () => {
    const { m } = await bookedMaple();
    const today = await m.caps.stays.today(owner, { date: "2026-12-04" });
    expect(today.arriving.map((r) => r.guest)).toEqual([contact.name]);
  });

  it("answers a cancellation with its fee first (fee_sha), then cancels", async () => {
    const { m, id, token } = await bookedMaple({ in: "2026-11-05", out: "2026-11-07" });
    // Inside the week before arrival: the first night is the fee.
    const asked = await m.caps.cancelItem(guest({ accessToken: token }), { item_id: id }).catch((e: WriteError) => e);
    expect(asked).toMatchObject({ code: "confirm_terms", details: { fee: { value: 18_900, currency: "CAD" } } });
    const feeSha = ((asked as WriteError).details as { fee_sha: string }).fee_sha;
    const done = await m.caps.cancelItem(guest({ accessToken: token }), { item_id: id, fee_sha: feeSha });
    expect(done.view.item.state).toBe("cancelled_by_guest");
  });

  it("sends assistants to the property's own booking engine, with the dates filled in", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    await m.caps.updateSettings(owner, {
      doc: {
        doorsElsewhere: [
          {
            itemType: "stay",
            url: "https://engine.example.net/maple",
            urlTemplate: "https://engine.example.net/maple?in={check_in}&out={check_out}&adults={adults}",
          },
        ],
      },
    });
    const there = "https://engine.example.net/maple?in=2026-12-04&out=2026-12-06&adults=2";
    const avail = await m.caps.stays.availability(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      adults: 2,
    });
    expect(avail.elsewhere).toBe(there);
    const asked = await m.caps.stays
      .request(guest(), {
        check_in: "2026-12-04",
        check_out: "2026-12-06",
        rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
        contact,
        consent: true,
      })
      .catch((e: WriteError) => e);
    expect(asked).toMatchObject({ code: "not_allowed", details: { reason: "elsewhere", url: there } });
  });

  it("reads as schema.org: the place, its rooms, and an offer only where a stay is booked at once", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    const kijani = lodgingJsonLd(
      (await readSetup(k.db, k.property)) as NonNullable<Awaited<ReturnType<typeof readSetup>>>,
    );
    expect(kijani).toMatchObject({
      "@context": "https://schema.org",
      "@type": "LodgingBusiness",
      name: "Kijani House",
      containsPlace: [{ "@type": "HotelRoom", occupancy: { maxValue: 3 }, bed: [{ typeOfBed: "Double" }] }],
    });
    expect(kijani).not.toHaveProperty("makesOffer");
    const m = await mapleHollow();
    const maple = lodgingJsonLd(
      (await readSetup(m.db, m.property)) as NonNullable<Awaited<ReturnType<typeof readSetup>>>,
      {
        today: "2026-11-02",
      },
    );
    expect(maple).toMatchObject({
      "@type": "BedAndBreakfast",
      checkinTime: "16:00",
      checkoutTime: "11:00",
      makesOffer: [
        {
          "@type": "Offer",
          itemOffered: { "@type": "HotelRoom", name: "Harbour room" },
          priceSpecification: { minPrice: "189.00", priceCurrency: "CAD", unitText: "night" },
        },
      ],
    });
    // Past the last night kept for direct guests: no offer any more, only the place and its rooms.
    const later = lodgingJsonLd(
      (await readSetup(m.db, m.property)) as NonNullable<Awaited<ReturnType<typeof readSetup>>>,
      {
        today: "2027-04-01",
      },
    );
    expect(later).not.toHaveProperty("makesOffer");
  });
});
