import { ISO_4217_MINOR_UNITS, isMoneyCurrency, PRESET_KEYS } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { describeService, lengthWords, serviceDraft, serviceWrite } from "../client/src/lib/catalogue";
import { cardState, cardsFor } from "../client/src/lib/connect";
import { countryName, countryOptions, ISO_3166_1 } from "../client/src/lib/countries";
import {
  COMMON_CURRENCIES,
  currencyGroups,
  currencyLabel,
  currencyNote,
  guessCurrency,
  knownCurrencies,
  MINOR_UNITS,
  offeredCurrency,
} from "../client/src/lib/currencies";
import { doorSwitchDoc, doorViews, needsWords, waitWords } from "../client/src/lib/doors";
import { bestUnit, DURATION_PRESETS, durationWords, isPreset } from "../client/src/lib/durations";
import { countryOfZone, currencyOfCountry, emailLangOfCountry, zonesOfCountry } from "../client/src/lib/geo";
import {
  ALL_DAY,
  checkDraft,
  copyToAll,
  dayWords,
  describeWeekly,
  everyDaySame,
  HOURS_PRESETS,
  isAllDay,
  laterThan,
  presetOf,
  timeLabel,
  timeSteps,
  toDraft,
  withValue,
} from "../client/src/lib/hours";
import { ISO_639_1, languagesToSave, matchLanguages } from "../client/src/lib/languages";
import { KINDS, kindOf, offerBodies, wizardDoorsDoc, wizardPreset } from "../client/src/lib/setup";
import { clearSources, sourceNote } from "../client/src/lib/sources";
import type { GalleryCard, ServiceRow, Settings } from "../client/src/lib/types";
import { matchZones, placeOf, zoneChoices, zoneName } from "../client/src/lib/zones";

// What the owner picks in Settings instead of typing it: hours from the clock (open all the time
// included), a time zone by place, a currency by name, languages by name, a country by name, a
// service's length and price, and the switches for what agents can do.

describe("opening hours", () => {
  const always = HOURS_PRESETS.find((p) => p.key === "always")?.draft;

  it("close at 24:00, never open then, and say a day open 24 hours as such", () => {
    expect(checkDraft(toDraft({ mon: [ALL_DAY], tue: [["18:00", "24:00"]] }))).toBeNull();
    expect(checkDraft(toDraft({ mon: [["24:00", "24:00"]] }))).toContain("not HH:MM");
    expect(checkDraft(toDraft({ mon: [["09:00", "24:01"]] }))).toContain("not HH:MM");
    expect(isAllDay([ALL_DAY])).toBe(true);
    expect(isAllDay([["00:00", "23:59"]])).toBe(false);
    expect(describeWeekly({ mon: [ALL_DAY], tue: [ALL_DAY], sat: [["10:00", "24:00"]] })).toBe(
      "Mon, Tue open 24 hours · Sat 10:00–24:00",
    );
  });

  it("start from three presets, the last one open all the time, and know which one a week is", () => {
    expect(HOURS_PRESETS.map((p) => p.label)).toEqual([
      "Weekdays 9–6",
      "Weekdays + Saturday morning",
      "Open all the time",
    ]);
    expect(always && describeWeekly(Object.fromEntries(Object.entries(always)))).toBe("Open all the time");
    for (const p of HOURS_PRESETS) expect(presetOf(p.draft)).toBe(p.key);
    expect(presetOf(toDraft({ mon: [["09:00", "18:00"]] }))).toBeNull();
  });

  it("copy one day to every day, closed and open all day included", () => {
    const draft = toDraft({
      mon: [
        ["09:00", "13:00"],
        ["14:00", "18:00"],
      ],
      sat: [ALL_DAY],
    });
    const fromMonday = copyToAll(draft, "mon");
    expect(Object.values(fromMonday).every((w) => JSON.stringify(w) === JSON.stringify(draft.mon))).toBe(true);
    expect(presetOf(copyToAll(draft, "sat"))).toBe("always");
    expect(Object.values(copyToAll(draft, "sun")).every((w) => w.length === 0)).toBe(true);
  });

  it("read as one line when every day is the same, and close only after they open", () => {
    const always = HOURS_PRESETS.find((p) => p.key === "always")?.draft;
    expect(always && everyDaySame(always)).toEqual([ALL_DAY]);
    expect(always && dayWords(everyDaySame(always) ?? [], true)).toBe("Open 24 hours");
    expect(everyDaySame(toDraft({ mon: [["09:00", "18:00"]] }))).toBeNull();
    expect(laterThan(timeSteps(15).closes, "09:00")[0]).toBe("09:15");
    expect(laterThan(timeSteps(15).closes, "23:45")).toEqual(["24:00"]);
  });

  it("are picked from the clock every quarter of an hour, a time set before kept in its place", () => {
    const { opens, closes } = timeSteps(15);
    expect(opens).toHaveLength(96);
    expect(opens[0]).toBe("00:00");
    expect(opens.at(-1)).toBe("23:45");
    expect(closes[0]).toBe("00:15");
    expect(closes.at(-1)).toBe("24:00");
    expect(withValue(opens, "09:10")).toContain("09:10");
    expect(withValue(opens, "09:10").indexOf("09:10")).toBe(opens.indexOf("09:00") + 1);
    expect(timeLabel("09:30", false)).toBe("09:30");
    expect(timeLabel("09:30", true)).toBe("9:30 AM");
    expect(timeLabel("00:00", true)).toBe("12:00 AM");
    expect(timeLabel("13:15", true)).toBe("1:15 PM");
    expect(timeLabel("24:00", true)).toBe("Midnight");
    expect(timeLabel("24:00", false)).toBe("24:00");
  });
});

describe("time zones", () => {
  it("are places by country and city, with the time there, the stored one always among them", () => {
    expect(placeOf("Europe/Lisbon")).toBe("Lisbon");
    expect(placeOf("America/Argentina/Buenos_Aires")).toBe("Buenos Aires, Argentina");
    expect(zoneName("Europe/Lisbon")).toBe("Portugal — Lisbon");
    expect(zoneName("America/New_York")).toBe("United States — New York");
    expect(zoneName("UTC")).toBe("UTC");
    const now = Date.parse("2026-10-15T13:05:00Z");
    const { all } = zoneChoices(now, { keep: "Asia/Calcutta", locale: "en-GB" });
    expect(all.find((z) => z.zone === "Europe/Lisbon")).toMatchObject({ name: "Portugal — Lisbon", clock: "14:05" });
    expect(all.some((z) => z.zone === "Asia/Calcutta")).toBe(true);
    expect(all.some((z) => z.zone === "UTC")).toBe(true);
    // Nobody runs a business at a research station or on a fixed offset.
    expect(all.some((z) => /^(Antarctica|Arctic|Etc)\//.test(z.zone))).toBe(false);
    const names = all.map((z) => z.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en-GB")));
  });

  it("suggest where the browser is, then the business's country's own, and are found by city or country", () => {
    const now = Date.parse("2026-10-15T13:05:00Z");
    const { suggested, all } = zoneChoices(now, { keep: "Europe/Lisbon", browser: "America/New_York" });
    expect(suggested.map((z) => z.zone)).toEqual([
      "America/New_York",
      "Europe/Lisbon",
      "Atlantic/Azores",
      "Atlantic/Madeira",
    ]);
    expect(matchZones("lisb", all)[0]?.zone).toBe("Europe/Lisbon");
    expect(matchZones("portugal", all).map((z) => z.zone)).toEqual(
      expect.arrayContaining(["Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"]),
    );
    expect(matchZones("new york", all)[0]?.zone).toBe("America/New_York");
    expect(matchZones("sao paulo", all)[0]?.zone).toBe("America/Sao_Paulo");
    expect(matchZones("", all)).toEqual([]);
  });

  it("know their country, its money and the language its emails start in", () => {
    expect(countryOfZone("Europe/Lisbon")).toBe("PT");
    expect(countryOfZone("Asia/Calcutta")).toBe("IN");
    expect(countryOfZone("UTC")).toBeNull();
    expect(zonesOfCountry("PT")).toEqual(["Atlantic/Azores", "Atlantic/Madeira", "Europe/Lisbon"]);
    expect(currencyOfCountry("BG")).toBe("EUR");
    expect(currencyOfCountry("PT")).toBe("EUR");
    expect(emailLangOfCountry("BR")).toBe("pt");
    expect(emailLangOfCountry("ES")).toBe("en");
    expect(emailLangOfCountry(null)).toBeNull();
  });
});

describe("lengths of time", () => {
  it("are said in words, in the unit that reads best", () => {
    expect(durationWords(0)).toBe("None");
    expect(durationWords(30)).toBe("30 minutes");
    expect(durationWords(90)).toBe("1 hour 30 minutes");
    expect(durationWords(1440)).toBe("1 day");
    expect(durationWords(2880)).toBe("2 days");
    expect(durationWords(10080)).toBe("1 week");
    expect(durationWords(1500)).toBe("1 day 1 hour");
    expect(bestUnit(1440, ["min", "h", "days"])).toBe("days");
    expect(bestUnit(90, ["min", "h", "days"])).toBe("min");
    expect(bestUnit(120, ["h", "days"])).toBe("h");
  });

  it("are picked from presets in each setting's own unit, an empty optional one included", () => {
    expect(DURATION_PRESETS.cancellation.map((p) => p.label)).toEqual(["None", "2 h", "12 h", "24 h", "48 h"]);
    expect(isPreset("1440", DURATION_PRESETS.cancellation)).toBe(true);
    expect(isPreset("1500", DURATION_PRESETS.cancellation)).toBe(false);
    expect(isPreset("", DURATION_PRESETS.cutoff)).toBe(true);
    expect(isPreset("", DURATION_PRESETS.cancellation)).toBe(false);
    expect(isPreset("72", DURATION_PRESETS.holdHours)).toBe(true);
  });
});

describe("currencies", () => {
  it("offer exactly what the server takes, each in its own minor unit (ADR-032)", () => {
    for (const code of new Set([
      ...knownCurrencies(),
      ...Object.keys(ISO_4217_MINOR_UNITS),
      ...COMMON_CURRENCIES,
      "XAU",
      "XXX",
      "ABC",
    ])) {
      expect(offeredCurrency(code), code).toBe(isMoneyCurrency(code));
    }
    // The owner app's table is the server's, row for row.
    expect(MINOR_UNITS).toEqual(ISO_4217_MINOR_UNITS);
    const { common, all } = currencyGroups();
    expect(common.slice(0, 3)).toEqual(["EUR", "USD", "GBP"]);
    expect(all).toContain("JPY");
    expect(all).toContain("KWD");
    expect(all).not.toContain("CLF");
    expect(all).not.toContain("EUR");
  });

  it("read with their symbol and name", () => {
    expect(currencyLabel("EUR", "en-GB")).toBe("€ EUR — Euro");
    expect(currencyLabel("GBP", "en-GB")).toBe("£ GBP — British Pound");
    expect(currencyLabel("CHF", "en-GB")).toBe("CHF — Swiss Franc");
  });

  it("say when prices are in another one, and that a change converts nothing", () => {
    expect(currencyNote("GBP", "GBP", [{ currency: "EUR" }, { currency: "EUR" }, { currency: "GBP" }])).toBe(
      "2 prices are in EUR: changing the currency converts nothing.",
    );
    expect(currencyNote("GBP", "EUR", [{ currency: undefined }])).toBe(
      "Changing the currency converts nothing: each amount stays as it is.",
    );
    expect(currencyNote("EUR", "EUR", [{ currency: "EUR" }])).toBeNull();
    expect(currencyNote("GBP", "EUR", [])).toBeNull();
  });

  it("are guessed from the time zone's country first, then the browser's region", () => {
    // The browser's English does not beat the zone the business is in.
    expect(guessCurrency(["en-GB"], "Europe/Lisbon")).toBe("EUR");
    expect(guessCurrency(["pt-PT"], "America/New_York")).toBe("USD");
    expect(guessCurrency(["en-GB"], "Europe/Sofia")).toBe("EUR");
    // Every currency is counted in its own minor unit now: a business in Tokyo prices in yen.
    expect(guessCurrency(["en-GB"], "Asia/Tokyo")).toBe("JPY");
    expect(guessCurrency(["en-GB"], "UTC")).toBe("GBP");
    expect(guessCurrency(["pt-PT"])).toBe("EUR");
    expect(guessCurrency(["en-GB"])).toBe("GBP");
    expect(guessCurrency(["en-US"])).toBe("USD");
    expect(guessCurrency(["de-CH"])).toBe("CHF");
    expect(guessCurrency(["xx", "es"])).toBe("EUR");
    expect(guessCurrency([])).toBe("EUR");
  });
});

describe("languages", () => {
  it("are found by name, in English or their own, common ones first, never twice", () => {
    expect(matchLanguages("spa", [])[0]).toBe("es");
    expect(matchLanguages("port", [])[0]).toBe("pt");
    expect(matchLanguages("deutsch", [])[0]).toBe("de");
    expect(matchLanguages("pt", [])[0]).toBe("pt");
    expect(matchLanguages("", ["en"])).not.toContain("en");
    expect(matchLanguages("", [])[0]).toBe("en");
    expect(matchLanguages("zzzz", [])).toEqual([]);
    expect(ISO_639_1).toHaveLength(183);
  });

  it("keep the business's own order unless the email language changed, and never send none", () => {
    // The bug: a Spanish-only business saved without touching anything stays Spanish-only.
    expect(languagesToSave(["es"], "en", false)).toEqual(["es"]);
    expect(languagesToSave(["es", "en"], "pt", true)).toEqual(["pt", "es", "en"]);
    expect(languagesToSave(["en", "pt-BR"], "pt", true)).toEqual(["pt-BR", "en"]);
    expect(languagesToSave([], "pt", false)).toEqual(["pt"]);
  });
});

describe("countries", () => {
  it("are every ISO 3166 code by name, the stored one kept", () => {
    expect(ISO_3166_1).toHaveLength(249);
    expect(countryName("PT")).toBe("Portugal");
    const options = countryOptions("PT");
    expect(options).toHaveLength(249);
    expect(options.map((o) => o.name)).toEqual(
      [...options.map((o) => o.name)].sort((a, b) => a.localeCompare(b, "en")),
    );
    expect(countryOptions("XK").some((o) => o.code === "XK")).toBe(true);
  });
});

describe("what agents can do", () => {
  const facts = {
    doors: {} as Settings["doors"],
    itemTypes: ["message"],
    hasService: false,
    hasHours: false,
    doorsElsewhere: [] as Settings["doorsElsewhere"],
  };

  it("shows each switch where it stands, and what a booking switched on still needs", () => {
    const [booking, quote, message] = doorViews(facts);
    expect(booking).toMatchObject({ label: "Agents can book time", on: true, open: false, needs: "service_and_hours" });
    expect(quote).toMatchObject({ label: "Agents can ask for a price", on: false, open: false });
    expect(message).toMatchObject({ label: "Agents can send a message", on: true, open: true });
    expect(needsWords(booking?.needs ?? null)).toBe("Needs a service and opening hours.");
    expect(waitWords(booking?.needs ?? null)).toBe("once you add a service and your hours");
    expect(waitWords("service")).toBe("once you add a service");
    expect(waitWords("hours")).toBe("once you set your hours");
    expect(waitWords(null)).toBe("");
    expect(doorViews({ ...facts, hasService: true })[0]?.needs).toBe("hours");
    expect(doorViews({ ...facts, hasHours: true })[0]?.needs).toBe("service");
    expect(doorViews({ ...facts, itemTypes: ["message", "quote_request", "booking"] })[0]).toMatchObject({
      on: true,
      open: true,
      needs: null,
    });
  });

  it("asking for a price follows the catalogue until switched; off is off; bookings elsewhere say where", () => {
    expect(doorViews({ ...facts, itemTypes: ["message", "quote_request"] })[1]?.on).toBe(true);
    expect(doorViews({ ...facts, doors: { quoteRequest: true } })[1]?.on).toBe(true);
    expect(doorViews({ ...facts, doors: { booking: false } })[0]).toMatchObject({ on: false, needs: null });
    expect(
      doorViews({ ...facts, doorsElsewhere: [{ itemType: "booking", url: "https://www.fresha.com/a/ana" }] })[0],
    ).toMatchObject({ on: false, needs: null, elsewhere: "fresha.com" });
    expect(doorSwitchDoc("quoteRequest", true)).toEqual({ doors: { quoteRequest: true } });
    expect(doorSwitchDoc("booking", false)).toEqual({ doors: { booking: false } });
  });
});

describe("where a detail was read", () => {
  const sources = {
    hours: {
      source_url: "https://www.salon.example/contact",
      checked_at: "2026-10-12T10:00:00Z",
      confidence: "declared",
    },
    services: { source_url: "https://salon.example/", checked_at: "2026-10-12T10:00:00Z", confidence: "read" },
  } as Settings["setup"]["sources"];

  it("asks to be checked only when a page's words said it, and goes once the owner saves", () => {
    expect(sourceNote(sources, "services")).toEqual({ host: "salon.example", check: true });
    expect(sourceNote(sources, "hours")).toEqual({ host: "salon.example", check: false });
    expect(sourceNote(sources, "profile.name")).toBeNull();
    expect(clearSources(sources, "services", "profile.name")).toEqual({ setup: { sources: { services: null } } });
    expect(clearSources(sources, "profile.name")).toBeNull();
  });
});

describe("a service", () => {
  const row: ServiceRow = {
    id: "s1",
    name: "Colour",
    description: null,
    durationMin: 90,
    bufferBeforeMin: 0,
    bufferAfterMin: 15,
    capacity: 1,
    granularityMin: 15,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    active: 1,
    sort: 0,
    negotiable: 1,
    createdAt: 0,
    updatedAt: 0,
  };

  it("reads in a list by its length and price, the unusual only when set", () => {
    expect(lengthWords(30)).toBe("30 min");
    expect(lengthWords(60)).toBe("1 h");
    expect(lengthWords(90)).toBe("1 h 30");
    expect(describeService(row, "EUR")).toBe("1 h 30 · €45.00 · 15 min after");
    expect(describeService({ ...row, price: null, bufferAfterMin: 0 }, "GBP")).toBe("1 h 30 · price on request");
    expect(describeService({ ...row, price: { model: "quote" } }, "EUR")).toBe("Asked for a price");
  });

  it("saves an empty price as on request: none for a new one, taken off one that had it", () => {
    const fresh = serviceWrite(
      { ...serviceDraft(undefined, null), name: "Cut", duration: "30" },
      {
        currency: "EUR",
        isNew: true,
        floor: null,
      },
    );
    expect("body" in fresh && fresh.body).toMatchObject({ name: "Cut", duration_min: 30 });
    expect("body" in fresh && "price" in fresh.body).toBe(false);
    const cleared = serviceWrite(
      { ...serviceDraft(row, 4000), price: "" },
      { currency: "EUR", isNew: false, floor: 4000 },
    );
    expect("body" in cleared && cleared.body.price).toBeNull();
    // Its lowest price goes with it.
    expect("body" in cleared && cleared.floor).toBeNull();
  });

  it("is priced in the business's currency, exact or starting at, per booking or per person", () => {
    const out = serviceWrite(
      { ...serviceDraft(undefined, null), name: "Class", price: "12,50", model: "from", per: "person" },
      { currency: "GBP", isNew: true, floor: null },
    );
    expect("body" in out && out.body.price).toEqual({ model: "from", value: 1250, currency: "GBP", per: "person" });
  });

  it("asked about is priced by quote, with no length sent", () => {
    const out = serviceWrite(
      { ...serviceDraft(undefined, null), name: "Kitchen", taken: "ask", price: "99" },
      { currency: "EUR", isNew: true, floor: null },
    );
    expect("body" in out && out.body.price).toEqual({ model: "quote" });
    expect("body" in out && "duration_min" in out.body).toBe(false);
    expect(serviceDraft({ ...row, price: { model: "quote" } }, null).taken).toBe("ask");
  });

  it("says what is wrong instead of saving it", () => {
    const opts = { currency: "EUR", isNew: true, floor: null };
    expect(serviceWrite({ ...serviceDraft(undefined, null), name: " " }, opts)).toEqual({
      problem: "Give the service a name.",
    });
    expect(serviceWrite({ ...serviceDraft(undefined, null), name: "x", duration: "2" }, opts)).toMatchObject({
      problem: expect.stringContaining("length"),
    });
    expect(serviceWrite({ ...serviceDraft(undefined, null), name: "x", price: "abc" }, opts)).toMatchObject({
      problem: expect.stringContaining("on request"),
    });
  });
});

describe("the setup wizard's doors", () => {
  it("are the three switches, more than one at once, and pick the rules to start from", () => {
    const all = { booking: true, quoteRequest: true, message: true };
    expect(wizardDoorsDoc(all)).toEqual({ doors: { booking: null, quoteRequest: true, message: null } });
    expect(wizardDoorsDoc({ booking: false, quoteRequest: true, message: false })).toEqual({
      doors: { booking: false, quoteRequest: true, message: false },
    });
    expect(wizardPreset(all)).toBe("appointments");
    expect(wizardPreset({ booking: false, quoteRequest: true, message: true })).toBe("trades");
    expect(wizardPreset({ booking: false, quoteRequest: false, message: true })).toBeNull();
  });

  it("start from what the business runs: each kind's rules are a server preset, and its doors follow", () => {
    // Each says what the business is, not a feature: "What do you run?"
    expect(KINDS.map((k) => k.label)).toEqual([
      "A salon, clinic or studio",
      "A trade",
      "A shop, bakery or kitchen",
      "A place to stay",
    ]);
    for (const k of KINDS) {
      expect(PRESET_KEYS as readonly string[]).toContain(k.preset);
      expect(kindOf(k.key)).toBe(k);
      // The kind's rules win over the doors' guess.
      expect(wizardPreset({ booking: true, quoteRequest: true, message: true }, k)).toBe(k.preset);
      expect(k.connect.length).toBeGreaterThan(0);
    }
    expect(kindOf("trades")?.doors).toEqual({ booking: false, quoteRequest: true, message: true });
    expect(kindOf("spaceport")).toBeUndefined();
  });

  it("show the systems a kind runs its days in first, and say plainly which need setup", () => {
    const way = (status: "ready" | "soon" | "setup", hint?: string) =>
      ({
        kind: "x",
        preset: null,
        label: "x",
        status,
        auth: "form",
        form: [],
        action: "Connect",
        ...(hint ? { hint } : {}),
      }) as const;
    const card = (id: string, group: GalleryCard["group"], status: "ready" | "soon", ways: GalleryCard["ways"]) =>
      ({ id, title: id, line: `${id} line`, group, industries: [], status, ways }) as GalleryCard;
    const cards = [
      card("stripe", "payments", "ready", [way("ready")]),
      card("calendar", "calendars", "ready", [way("ready")]),
      card("gated", "lodging", "soon", [way("setup", "Needs a partner key on this server.")]),
      card("later", "lodging", "soon", [way("soon")]),
    ];
    expect(cardsFor(cards, ["lodging", "calendars"]).map((c) => c.id)).toEqual(["gated", "later", "calendar"]);
    expect(cardState(cards[0] as GalleryCard)).toEqual({ tag: null, hint: null });
    expect(cardState(cards[2] as GalleryCard)).toEqual({
      tag: "Needs setup",
      hint: "Needs a partner key on this server.",
    });
    expect(cardState(cards[3] as GalleryCard)).toEqual({ tag: "Soon", hint: null });
  });

  it("make what is offered asked about for a price when agents cannot book", () => {
    const out = offerBodies([{ name: "Kitchen", minutes: "60", price: "99" }], "services", "EUR", true);
    expect(out).toEqual({ kind: "services", bodies: [{ name: "Kitchen", active: true, price: { model: "quote" } }] });
  });
});
