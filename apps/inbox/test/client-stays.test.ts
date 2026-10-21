import { describe, expect, it } from "vitest";
import lodging from "../../../packages/spec/vocab/lodging.json";
import { stayActions } from "../client/src/lib/actions";
import { ownerLocale } from "../client/src/lib/geo";
import {
  AMENITY_WORDS,
  addDays,
  allotmentReady,
  BED_WORDS,
  cellOf,
  EXTRA_WORDS,
  KIND_WORDS,
  MEAL_WORDS,
  paymentWords,
  policyChoiceOf,
  policyWords,
  quoteSums,
  RULE_WORDS,
  type StayQuoteView,
  seasonWords,
  weekdayWords,
} from "../client/src/lib/property";
import { KINDS, kindOf, wizardPreset, wizardRoomBodies } from "../client/src/lib/setup";
import { stayDates, stayTitle } from "../client/src/lib/stays";

/**
 * The owner app's words and sums for a place to stay (S1–S16): every choice a chooser, each word for
 * the vocabulary's every token, the policy and the payments said back in one sentence each, the
 * Nights grid's cells, the sheet that keeps rooms only once they are closed elsewhere, a quote's sums,
 * and the wizard's "A place to stay".
 */
/** The spec's lodging vocabulary, as it is published. */
const VOCAB = lodging as unknown as Record<
  "kinds" | "beds" | "amenities" | "meals" | "house_rules" | "extras",
  Record<string, unknown>
>;

describe("the owner app for a place to stay", () => {
  it("has a word for every token of the lodging vocabulary", () => {
    const has = (words: Readonly<Record<string, string>>, group: keyof typeof VOCAB) =>
      expect(Object.keys(words).sort(), group).toEqual(Object.keys(VOCAB[group]).sort());
    has(KIND_WORDS, "kinds");
    has(BED_WORDS, "beds");
    has(AMENITY_WORDS, "amenities");
    has(MEAL_WORDS, "meals");
    has(RULE_WORDS, "house_rules");
    has(EXTRA_WORDS, "extras");
  });

  it("says a policy and its payments back in a sentence", () => {
    const flexible = policyChoiceOf("free_until:7:first_night:full");
    expect(flexible).toEqual({ preset: "free_until", days: 7, after: "first_night", no_show: "full" });
    expect(policyWords(flexible)).toBe(
      "Free to cancel until 7 days before arrival; after that, the first night. A no-show costs the whole stay.",
    );
    expect(policyWords(policyChoiceOf("non_refundable"))).toBe("Non-refundable: cancelling costs the whole stay.");
    expect(policyChoiceOf("custom")).toEqual({ preset: "custom" });
    expect(paymentWords({ kind: "percent", value: 20 }, { when: "days_before", days: 14 }, "none")).toBe(
      "20% now, the rest 14 days before arrival",
    );
    expect(paymentWords({ kind: "none" }, { when: "at_property" }, "card")).toBe(
      "A card to hold the stay, nothing taken now, the rest at the property",
    );
    expect(paymentWords({ kind: "full" }, { when: "at_property" }, "none")).toBe("Everything now");
  });

  it("reads each night of the grid: closed first, a hint never fills a room", () => {
    const cell = (o: Partial<Parameters<typeof cellOf>[0]>) => ({
      night: "2026-12-12",
      stays: [],
      holds: [],
      kept: 0,
      hint: null,
      closed: false,
      ...o,
    });
    expect(cellOf(cell({ closed: true, stays: [{ item_id: "a", reference: "A" }] }), 2).tone).toBe("closed");
    expect(cellOf(cell({ hint: "Airbnb" }), 1)).toEqual({ tone: "free", words: "Airbnb shows it taken", mark: "" });
    expect(cellOf(cell({ stays: [{ item_id: "a", reference: "A" }] }), 1).tone).toBe("full");
    expect(cellOf(cell({ holds: [{ item_id: "b", minutes_left: 12 }] }), 1).tone).toBe("held");
    // The number a cell shows is the rooms still free for direct guests: those kept, less those taken.
    expect(cellOf(cell({ stays: [{ item_id: "a", reference: "A" }], kept: 2 }), 3)).toEqual({
      tone: "some",
      words: "1 booked · 1 of 2 kept still free for direct guests · 2 free",
      mark: "1",
    });
    expect(cellOf(cell({ kept: 2 }), 3).mark).toBe("2");
    expect(cellOf(cell({ closed: true }), 3).mark).toBe("×");
    expect(
      seasonWords(
        { fromDate: "2026-11-19", toDate: "2026-12-04", weekdays: 48, nightly: 110_000 },
        "Chambre Jasmin",
        "MAD",
        "en-MA",
      ).replace(/\s/g, " "),
    ).toMatch(
      /^Chambre Jasmin · (19 Nov – 4 Dec|Nov 19 – Dec 4) · Friday and Saturday nights · .*1,100\.00.* a night$/,
    );
    expect(weekdayWords(127)).toBe("every night");
    expect(weekdayWords(48)).toBe("Friday and Saturday nights");
    expect(weekdayWords(1 | 4)).toBe("Mon, Wed");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    // A stay's dates as the reader's locale writes a range, never shifted by a zone.
    expect(stayDates("2026-12-12", "2026-12-15", "es")).toBe("12–15 dic");
    expect(stayDates("2026-11-03", "2026-11-06", "en-US").replace(/\s/g, " ")).toBe("Nov 3 – 6");
  });

  it("offers a stay's owner only what fits where it stands, in the business's own way of writing", () => {
    const t = (...events: string[]) => events.map((event) => ({ event, label: event }));
    // A request: quoted from the composer, asked about or declined; nothing booked to cancel.
    expect(
      stayActions("requested", t("quote", "request_info", "decline", "record_cancel", "cancel_by_property")).map(
        (x) => x.event,
      ),
    ).toEqual(["request_info", "decline"]);
    // Agreed: cancellations, never the generic quote form.
    expect(
      stayActions("confirmed", t("quote", "propose_change", "record_cancel", "cancel_by_property")).map((x) => x.event),
    ).toEqual(["propose_change", "record_cancel", "cancel_by_property"]);
    // One locale for the owner app: English as the business's country writes it.
    expect(ownerLocale("America/Mexico_City")).toBe("en-MX");
    expect(ownerLocale("Asia/Tokyo")).toBe("en-JP");
    expect(ownerLocale("UTC")).toBeUndefined();
    // A stay's title from what it is, never a stored string with ISO dates.
    const title = stayTitle(
      {
        propertyId: "p",
        checkIn: "2026-11-03",
        checkOut: "2026-11-06",
        rooms: [{ roomTypeName: "Suite Atlas", adults: 2, childrenAges: [], extras: [] }],
      } as never,
      "en-GB",
    ).replace(/\s/g, " ");
    expect(title).toMatch(/^Suite Atlas · 3 ?– ?6 Nov · 3 nights$/);
  });

  it("keeps rooms for direct guests only once they are closed on the other channels", () => {
    const ready = { units: 1, from: "2026-12-01", to: "2026-12-20", closedElsewhere: true };
    expect(allotmentReady(ready)).toBeNull();
    expect(allotmentReady({ ...ready, closedElsewhere: false })).toMatch(/^Close these rooms/);
    expect(allotmentReady({ ...ready, to: "2026-11-30" })).toBe("The last night comes after the first.");
    expect(allotmentReady({ ...ready, from: "" })).toBe("Choose the first and last night.");
  });

  it("sums a quote for the composer: now, later, at the property", () => {
    const q = {
      currency: "KES",
      lines: [
        { type: "subtotal", label: "Garden room, 2 nights", amount: 1_800_000, collected: "with_booking" },
        { type: "tax", label: "Tourism levy", amount: 40_000, collected: "at_property" },
      ],
      total: { value: 1_840_000, currency: "KES" },
      ratePlan: { name: "Bed and breakfast", meal: "breakfast", refundable: true },
      policy: { steps: [], after: { value: 0, currency: "KES" }, noShow: { value: 0, currency: "KES" } },
      schedule: [
        { id: "deposit", type: "immediate", amount: { value: 900_000, currency: "KES" }, label: "Now" },
        { id: "balance", type: "at_property", amount: { value: 940_000, currency: "KES" }, label: "There" },
      ],
      guarantee: "none",
      includes: [],
      validThrough: "2026-11-03T06:00:00+03:00",
      source: "rates",
    } as unknown as StayQuoteView;
    const sums = quoteSums(q);
    expect(sums.later).toBeNull();
    expect(sums.total).toMatch(/18,400/);
    expect(sums.now).toMatch(/9,000/);
    expect(sums.atProperty).toMatch(/9,400/);
  });

  it("offers 'A place to stay' in the wizard: its rules, its systems, its rooms", () => {
    const stays = kindOf("stays");
    expect(stays).toMatchObject({ label: "A place to stay", preset: "stays", connect: ["lodging", "calendars"] });
    expect(KINDS.map((k) => k.key)).toContain("stays");
    expect(wizardPreset({ booking: false, quoteRequest: false, message: true }, stays)).toBe("stays");
    expect(wizardRoomBodies([{ id: 1, name: " ", units: "1", sleeps: "2" }], "p1")).toEqual({
      problem: "Name at least one kind of room.",
    });
    expect(
      wizardRoomBodies(
        [
          { id: 1, name: "Garden room", units: "3", sleeps: "2" },
          { id: 2, name: "", units: "1", sleeps: "4" },
          { id: 3, name: "Family room", units: "1", sleeps: "4" },
        ],
        "p1",
      ),
    ).toEqual({
      bodies: [
        { property_id: "p1", name: "Garden room", units: 3, capacity: { adults: 2, children: 0, total: 2 }, sort: 0 },
        { property_id: "p1", name: "Family room", units: 1, capacity: { adults: 4, children: 0, total: 4 }, sort: 1 },
      ],
      prices: [null, null],
    });
    // A price a night on a room, in its currency's own unit: the first request is quoted in one press.
    expect(
      wizardRoomBodies(
        [
          { id: 1, name: "Washitsu, garden side", units: "2", sleeps: "2", price: "18,500" },
          { id: 2, name: "Hanare", units: "1", sleeps: "3", price: "" },
        ],
        "p1",
        "JPY",
      ),
    ).toMatchObject({ prices: [18_500, null] });
    expect(
      wizardRoomBodies([{ id: 1, name: "Riad room", units: "1", sleeps: "2", price: "abc" }], "p1", "MAD"),
    ).toEqual({ problem: '"abc" is not a price a night for Riad room.' });
  });
});
