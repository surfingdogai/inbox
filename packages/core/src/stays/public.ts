import { decimalOf, type PropertyPublic, type StayAvailability, type StayQuote, shareOf } from "@surfingdog/spec";
import { payCollection } from "../connectors/pay-queue";
import { base64Url } from "../customer/offer";
import type { Db } from "../db";
import { policySentence } from "../policy/index";
import { ariCells, ariVerdict, cachedNights } from "../property/ari";
import { hintedNights } from "../property/hints";
import type { SecretBox } from "../secrets/box";
import type { Settings } from "../settings/schema";
import { canonicalJson } from "../util/canonical";
import { formatMinor } from "../util/money";
import { closedNights, insideAllotment, nightsFree, type WantedNights } from "./claims";
import { type StayLang, stayLang } from "./copy";
import { nightsOf } from "./nights";
import { propertyLocale, quoteFromRates } from "./price";
import { listProperties, type PropertySetup, type RatePlanRow, type RoomTypeRow, readSetup } from "./store";
import { stayTermsSha, whenWords } from "./terms";

/**
 * What a guest's assistant reads of a place to stay (ADR-037 §6.1): the property as it presents itself,
 * what is free for some dates and guests, and at what price. Every answer speaks as the property, gives
 * the full price with every tax and fee in it, and never names another travel service. An instant room
 * comes with an offer the inbox made and can recognise again; a room on request comes with an estimate
 * that binds nobody.
 */

/** How long an instant offer can be held or booked before it is worked out again. */
export const OFFER_VALID_MS = 15 * 60_000;

/** The property's own sentence on how it confirms stays (§4.1): the owner's promise, in its words. */
export function confirmationSentence(setup: PropertySetup, systemName: string | null): string {
  const p = setup.property;
  const hours = `${p.answerHours} hour${p.answerHours === 1 ? "" : "s"}`;
  const priced = setup.rates.length > 0;
  if (p.mode === "connected" && systemName) {
    return p.instant
      ? `Stays confirm at once from my ${systemName} availability. Anything ${systemName} can't confirm is on request.`
      : `My ${systemName} availability shows what's free; I confirm each stay within ${hours}.`;
  }
  if (p.mode === "allotment") {
    const a = setup.allotments[0];
    const room = a ? setup.rooms.find((r) => r.id === a.roomTypeId) : undefined;
    if (a && room) {
      return `I keep ${a.units} ${room.name} ${a.units === 1 ? "room" : "rooms"} a night for direct guests, closed on my other channels. Those confirm at once; the rest is on request.`;
    }
  }
  return priced
    ? `My rates give the price; I confirm the room within ${hours}.`
    : `Every stay is on request. I answer within ${hours}.`;
}

/** How a property confirms, as a profile says it: each on request, some at once, or all at once. */
export function confirmationKind(setup: PropertySetup): "request" | "instant_some" | "instant" {
  const p = setup.property;
  if (p.mode === "allotment" && setup.allotments.length > 0) return "instant_some";
  if (p.mode === "connected" && p.instant) return "instant";
  return "request";
}

/** How a rate plan's stays are secured, in one word for agents. */
function secureOf(plan: RatePlanRow): "at_property" | "deposit" | "card" {
  if (plan.guarantee === "card") return "card";
  return plan.deposit.kind === "none" ? "at_property" : "deposit";
}

/**
 * A policy before any dates, in words for agents: "Free cancellation until 3 days before arrival; after
 * that: the first night." A fixed fee is money in the property's currency, as its guests write it.
 */
function policyWords(plan: RatePlanRow, currency: string, locale: string): string {
  const p = plan.policy;
  const fee = (f: (typeof p)["after"]) =>
    f.kind === "none"
      ? "nothing"
      : f.kind === "full"
        ? "the full stay"
        : f.kind === "units"
          ? f.value === 1
            ? "the first night"
            : `the first ${f.value} nights`
          : f.kind === "percent"
            ? `${f.value}% of the stay`
            : formatMinor({ value: f.value ?? 0, currency }, locale);
  if (p.steps.length === 0 && p.after.kind === "full") return "Non-refundable: the full stay from booking.";
  const free = p.steps.find((s) => s.fee.kind === "none");
  const days = free && "days" in free.before ? free.before.days : null;
  const head =
    days !== null ? `Free cancellation until ${days} day${days === 1 ? "" : "s"} before arrival` : "Cancellation";
  return `${head}; after that: ${fee(p.after)}. No-show: ${fee(p.noShow)}.`;
}

/** The property as `get_property` shows it: never its private arrival details. */
export function propertyPublic(
  setup: PropertySetup,
  settings: Settings,
  systemName: string | null,
  lang: StayLang = "en",
): PropertyPublic {
  const p = setup.property;
  const rooms = setup.rooms.filter((r) => r.active && r.offered);
  const plans = setup.plans.filter((x) => x.active && x.offered);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    currency: p.currency,
    timezone: p.timezone,
    check_in_from: p.checkInFrom,
    check_in_until: p.checkInUntil,
    check_out_until: p.checkOutUntil,
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      capacity: r.capacity,
      beds: r.beds.filter((b) => b.count >= 1) as PropertyPublic["rooms"][number]["beds"],
      size_m2: r.sizeM2,
      amenities: [...r.amenities],
      accessible: r.accessible,
      photos: r.photos.slice(0, 8),
    })),
    rate_plans: plans.map((x) => ({
      id: x.id,
      name: x.name,
      meal: x.meal as PropertyPublic["rate_plans"][number]["meal"],
      refundable: x.policy.steps.some((s) => s.fee.kind === "none"),
      secure: secureOf(x),
      policy: policyWords(x, p.currency, propertyLocale(lang, p)),
      min_nights: x.minNights,
    })),
    extras: setup.extras
      .filter((e) => e.active)
      .map((e) => ({
        id: e.id,
        item: e.item as PropertyPublic["extras"][number]["item"],
        name: e.name,
        price: { value: e.price, currency: p.currency },
        basis: e.basis,
      })),
    taxes_and_fees: setup.fees
      .filter((f) => f.active)
      .map((f) => ({ name: f.name, kind: f.kind, basis: f.basis, collected: f.collected })),
    children: {
      welcome: p.children.welcome,
      ...(p.children.fromAge !== undefined ? { from_age: p.children.fromAge } : {}),
      ...(p.children.freeUnder !== undefined ? { free_under: p.children.freeUnder } : {}),
      ...(p.children.cots !== undefined ? { cots: p.children.cots } : {}),
    },
    pets: p.pets.allowed,
    house_rules: {
      chips: [...p.houseRules.chips],
      ...(p.houseRules.quiet ? { quiet: [...p.houseRules.quiet] as [string, string] } : {}),
      ...(p.houseRules.text ? { text: p.houseRules.text } : {}),
    },
    how_to_find_us: p.arrivalPublic,
    payments: [...((settings as { payments?: { accepted?: readonly string[] } }).payments?.accepted ?? [])],
    confirmation: confirmationSentence(setup, systemName),
    answers_within_h: p.answerHours,
    registration: p.registration?.number ?? null,
  };
}

/** Guests shared between rooms: adults as evenly as can be (one at least in each), children in turn. */
export function shareGuests(
  adults: number,
  childrenAges: readonly number[],
  rooms: number,
): { adults: number; childrenAges: number[] }[] {
  const n = Math.max(1, Math.min(rooms, adults));
  const out = Array.from({ length: n }, (_, i) => ({
    adults: Math.floor(adults / n) + (i < adults % n ? 1 : 0),
    childrenAges: [] as number[],
  }));
  childrenAges.forEach((age, i) => {
    out[i % n]?.childrenAges.push(age);
  });
  return out;
}

function fits(room: RoomTypeRow, guests: { adults: number; childrenAges: readonly number[] }): boolean {
  const c = guests.childrenAges.length;
  return (
    guests.adults <= room.capacity.adults && c <= room.capacity.children && guests.adults + c <= room.capacity.total
  );
}

export interface OfferMaker {
  /** An offer id only this inbox can make: the terms' MAC, so an agent cannot pass off its own. */
  offerId(quote: StayQuote, stay: OfferSubject): Promise<string>;
}

export interface OfferSubject {
  readonly propertyId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: readonly {
    readonly roomTypeId?: string | undefined;
    readonly ratePlanId?: string | undefined;
    readonly adults: number;
    readonly childrenAges: readonly number[];
  }[];
}

/** Offer ids under the inbox's own key (`stay-offer`); a plain fingerprint where it has none. */
export function offerMaker(secrets: SecretBox | null): OfferMaker {
  return {
    async offerId(quote, stay) {
      const body = new TextEncoder().encode(
        canonicalJson({
          p: stay.propertyId,
          ci: stay.checkIn,
          co: stay.checkOut,
          r: stay.rooms.map((r) => [r.roomTypeId ?? null, r.ratePlanId ?? null, r.adults, [...r.childrenAges]]),
          t: quote.total,
          s: quote.schedule.map((x) => [x.id, x.type, x.amount.value]),
          pol: quote.policy,
        }),
      );
      const mac = secrets
        ? new Uint8Array(await crypto.subtle.sign("HMAC", await secrets.mac("stay-offer"), body))
        : new Uint8Array(await crypto.subtle.digest("SHA-256", body));
      return `off_${base64Url(mac).slice(0, 32)}`;
    },
  };
}

/** What a room's nights cost on the property's own system, from its fresh cache, when it gives prices. */
async function systemSubtotals(
  db: Db,
  setup: PropertySetup,
  rooms: readonly { roomTypeId: string; ratePlanId?: string | undefined }[],
  nights: readonly string[],
): Promise<({ nights: { night: string; amount: number }[] } | null)[] | undefined> {
  const connectorId = setup.property.connectorId;
  if (setup.property.mode !== "connected" || !connectorId) return undefined;
  const ext = rooms.map((r) => setup.rooms.find((x) => x.id === r.roomTypeId)?.externalId ?? null);
  const cells = await ariCells(
    db,
    connectorId,
    ext.filter((e): e is string => e !== null),
    nights,
  );
  return rooms.map((r, i) => {
    const e = ext[i];
    if (!e) return null;
    const plan = setup.plans.find((p) => p.id === r.ratePlanId);
    const priced = cachedNights(cells, e, plan?.externalId ?? null, nights);
    return priced ? { nights: priced } : null;
  });
}

export interface PriceOutcome {
  readonly status: "instant" | "on_request" | "unavailable";
  readonly reason?: string | undefined;
  readonly likelyTaken: boolean;
  readonly quote: StayQuote | null;
}

/**
 * One way to stay (rooms of types on plans) judged for some dates: whether it is closed, taken, free
 * at once or on request, what another calendar shows, and its price. Writes nothing.
 */
export async function judgeStay(
  db: Db,
  setup: PropertySetup,
  stay: {
    readonly checkIn: string;
    readonly checkOut: string;
    readonly rooms: readonly {
      readonly roomTypeId: string;
      readonly ratePlanId?: string | undefined;
      readonly adults: number;
      readonly childrenAges: readonly number[];
      readonly extras?: readonly { readonly extraId: string; readonly quantity: number }[];
    }[];
  },
  lang: StayLang,
  now: number,
): Promise<PriceOutcome> {
  const nights = nightsOf(stay.checkIn, stay.checkOut);
  const counted = new Map<string, number>();
  for (const r of stay.rooms) counted.set(r.roomTypeId, (counted.get(r.roomTypeId) ?? 0) + 1);
  const want: WantedNights = { rooms: counted, nights };
  for (const id of want.rooms.keys()) {
    if (closedNights(setup, id, nights).length > 0) {
      return {
        status: "unavailable",
        reason: "The property is closed on some of those nights.",
        likelyTaken: false,
        quote: null,
      };
    }
  }
  if (!(await nightsFree(db, setup, "", want, now)).ok) {
    return { status: "unavailable", reason: "Those nights are no longer free.", likelyTaken: false, quote: null };
  }
  let instant = false;
  if (setup.property.mode === "allotment") instant = await insideAllotment(db, setup, "", want, now);
  if (setup.property.mode === "connected") {
    const verdict = await ariVerdict(db, setup, want, now);
    if ([...verdict.values()].some((v) => v === "full")) {
      return { status: "unavailable", reason: "Those nights are no longer free.", likelyTaken: false, quote: null };
    }
    instant = setup.property.instant && [...verdict.values()].every((v) => v === "free");
  }
  let likelyTaken = false;
  for (const id of want.rooms.keys()) {
    if ((await hintedNights(db, id, nights, setup.property.timezone)).length > 0) likelyTaken = true;
  }
  const rooms = stay.rooms.map((r) => ({
    roomTypeId: r.roomTypeId,
    ratePlanId: r.ratePlanId,
    adults: r.adults,
    childrenAges: r.childrenAges,
    extras: r.extras ?? [],
  }));
  const subtotals = await systemSubtotals(db, setup, rooms, nights);
  const collect = await payCollection(db);
  const priced = quoteFromRates(setup, {
    collect,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms,
    lang,
    now,
    source: instant ? (setup.property.mode === "allotment" ? "allotment" : "connected") : "rates",
    ...(subtotals ? { systemSubtotals: subtotals } : {}),
    ...(instant ? { validHours: OFFER_VALID_MS / 3_600_000 } : {}),
  });
  const quote = priced.ok ? priced.quote : null;
  // An instant room with no price the inbox can give is on request: nothing is promised at a price unknown.
  if (instant && !quote) instant = false;
  return {
    status: instant ? "instant" : "on_request",
    likelyTaken,
    quote:
      instant && quote
        ? {
            ...quote,
            validThrough: new Date(Math.min(Date.parse(quote.validThrough), now + OFFER_VALID_MS)).toISOString(),
          }
        : quote,
    ...(likelyTaken ? { reason: "Another calendar shows these nights as taken." } : {}),
  };
}

/** What is free for some dates and guests, room type by room type and rate by rate (`check_stay_availability`). */
export async function availability(
  db: Db,
  setup: PropertySetup,
  maker: OfferMaker,
  q: {
    readonly checkIn: string;
    readonly checkOut: string;
    readonly adults: number;
    readonly childrenAges: readonly number[];
    readonly rooms: number;
    readonly roomTypeId?: string | undefined;
  },
  lang: StayLang,
  now: number,
): Promise<StayAvailability> {
  const nights = nightsOf(q.checkIn, q.checkOut);
  const guests = shareGuests(q.adults, q.childrenAges, q.rooms);
  const options: StayAvailability["options"] = [];
  const kinds = new Set<string>();
  for (const room of setup.rooms.filter((r) => r.active && r.offered && (!q.roomTypeId || r.id === q.roomTypeId))) {
    const head = { room_type: { id: room.id, name: room.name, capacity: room.capacity } };
    if (!guests.every((g) => fits(room, g)) || guests.length > room.units) {
      options.push({ ...head, status: "unavailable", reason: `${room.name} does not sleep these guests.` });
      continue;
    }
    if (q.childrenAges.length > 0 && !setup.property.children.welcome) {
      options.push({ ...head, status: "unavailable", reason: "This place takes adults only." });
      continue;
    }
    const plans = setup.plans.filter(
      (p) =>
        p.active &&
        p.offered &&
        (p.roomTypeIds === null || p.roomTypeIds.includes(room.id)) &&
        p.minNights <= nights.length &&
        (p.maxNights === null || nights.length <= p.maxNights),
    );
    if (plans.length === 0) {
      const judged = await judgeStay(
        db,
        setup,
        { checkIn: q.checkIn, checkOut: q.checkOut, rooms: guests.map((g) => ({ ...g, roomTypeId: room.id })) },
        lang,
        now,
      );
      const status = judged.status === "unavailable" ? "unavailable" : "on_request";
      kinds.add(status);
      options.push({
        ...head,
        status,
        ...(judged.reason ? { reason: judged.reason } : {}),
        ...(judged.likelyTaken ? { likely_taken: true } : {}),
      });
      continue;
    }
    for (const plan of plans) {
      const stay = {
        checkIn: q.checkIn,
        checkOut: q.checkOut,
        rooms: guests.map((g) => ({ ...g, roomTypeId: room.id, ratePlanId: plan.id })),
      };
      const judged = await judgeStay(db, setup, stay, lang, now);
      kinds.add(judged.status);
      const rate = {
        id: plan.id,
        name: plan.name,
        meal: plan.meal as never,
        refundable: plan.policy.steps.some((s) => s.fee.kind === "none"),
      };
      const base = {
        ...head,
        rate_plan: rate,
        status: judged.status,
        ...(judged.reason ? { reason: judged.reason } : {}),
        ...(judged.likelyTaken ? { likely_taken: true } : {}),
      };
      if (judged.status === "instant" && judged.quote) {
        const offerId = await maker.offerId(judged.quote, { propertyId: setup.property.id, ...stay });
        options.push({
          ...base,
          offer: { offer_id: offerId, valid_through: judged.quote.validThrough, quote: judged.quote },
        });
      } else if (judged.status === "on_request" && judged.quote) {
        options.push({ ...base, estimate: { ...judged.quote, binding: false } });
      } else {
        options.push(base);
      }
    }
  }
  return {
    property: { id: setup.property.id, name: setup.property.name },
    check_in: q.checkIn,
    check_out: q.checkOut,
    nights: nights.length,
    currency: setup.property.currency,
    options: options.slice(0, 60),
    answers_within_h: setup.property.answerHours,
    confirmation: confirmationKind(setup),
  };
}

/** The words an estimate is given with: it binds nobody. */
export const ESTIMATE_WORDS = "The property's price for these dates. It confirms the room and the price in its answer.";

/** A quote in words for an agent's person to confirm: the total, what is paid now and there, the policy. */
export async function termsSummary(
  setup: PropertySetup,
  stay: OfferSubject,
  quote: StayQuote,
  lang: StayLang,
): Promise<{ readonly summary: string; readonly terms_sha: string }> {
  const locale = propertyLocale(lang, setup.property);
  const money = (v: number) => formatMinor({ value: v, currency: quote.currency }, locale);
  const now = quote.schedule.filter((s) => s.type === "immediate").reduce((a, s) => a + s.amount.value, 0);
  const there = quote.schedule.filter((s) => s.type === "at_property").reduce((a, s) => a + s.amount.value, 0);
  const nights = nightsOf(stay.checkIn, stay.checkOut).length;
  // Every payment the guest's person agrees to, with when: what is paid later is said too, by its date
  // and time where the property is.
  const later = quote.schedule
    .filter((s) => s.type === "deferred" && s.amount.value > 0)
    .map((s) => `Then ${money(s.amount.value)} by ${s.dueAt ? whenWords(setup, s.dueAt, lang) : "before arrival"}.`);
  const parts = [
    `${setup.property.name}: ${nights} night${nights === 1 ? "" : "s"}, ${stay.checkIn} to ${stay.checkOut}, ${money(quote.total.value)} in all.`,
    now > 0 ? `Pay now: ${money(now)}.` : "Nothing to pay now.",
    ...later,
    there > 0 ? `At the property: ${money(there)}.` : "",
    quote.guarantee === "card" ? "A card holds the booking; nothing is charged now." : "",
    policySentence(quote.policy, { lang, locale, total: quote.total, what: "stay" }),
  ].filter(Boolean);
  return { summary: parts.join(" "), terms_sha: await stayTermsSha(stay, quote) };
}

/** A place to stay's manifest door (ADR-037 §6.3): how it confirms, how soon it answers, how a stay is secured. */
export function stayDoor(setup: PropertySetup): {
  mode: "request" | "instant_with_connector";
  answers_within_h: number;
  secure: ("at_property" | "deposit" | "card")[];
  currencies: string[];
} {
  const secure = [...new Set(setup.plans.filter((p) => p.active && p.offered).map(secureOf))];
  return {
    mode: setup.property.mode === "connected" && setup.property.instant ? "instant_with_connector" : "request",
    answers_within_h: setup.property.answerHours,
    secure: secure.length ? secure : ["at_property"],
    currencies: [setup.property.currency],
  };
}

/** The manifest's stay door for this inbox's place to stay, when it has one. */
export async function stayDoorOf(db: Db): Promise<ReturnType<typeof stayDoor> | undefined> {
  const property = (await listProperties(db, { active: true }))[0];
  const setup = property ? await readSetup(db, property.id) : null;
  return setup ? stayDoor(setup) : undefined;
}

/** A place to stay's profile `lodging` (spec 0.11): what a network may show of it. */
export function lodgingProfile(setup: PropertySetup): {
  kind: string;
  rooms?: number;
  check_in_from: string;
  check_out_until: string;
  confirmation: "request" | "instant_some" | "instant";
  answer_hours: number;
  registration?: string;
} {
  const rooms = setup.rooms.filter((r) => r.active && r.offered).reduce((a, r) => a + r.units, 0);
  return {
    kind: setup.property.kind,
    ...(rooms > 0 ? { rooms: Math.min(rooms, 5_000) } : {}),
    check_in_from: setup.property.checkInFrom,
    check_out_until: setup.property.checkOutUntil,
    confirmation: confirmationKind(setup),
    answer_hours: setup.property.answerHours,
    ...(setup.property.registration?.number ? { registration: setup.property.registration.number } : {}),
  };
}

export { stayLang };

const LODGING_TYPE: Readonly<Record<string, string>> = {
  hotel: "Hotel",
  hostel: "Hostel",
  bnb: "BedAndBreakfast",
  campsite: "Campground",
  rental: "VacationRental",
  apartment: "VacationRental",
};
const ROOM_TYPE: Readonly<Record<string, string>> = { rental: "Accommodation", apartment: "Apartment" };
const BED_WORDS: Readonly<Record<string, string>> = {
  double: "Double",
  single: "Single",
  queen: "Queen",
  king: "King",
  bunk: "Bunk bed",
  sofa_bed: "Sofa bed",
  futon: "Futon",
  cot: "Cot",
};
const AMENITY_WORDS: Readonly<Record<string, string>> = {
  private_bathroom: "Private bathroom",
  air_conditioning: "Air conditioning",
  heating: "Heating",
  kitchen: "Kitchen",
  balcony: "Balcony",
  sea_view: "Sea view",
  desk: "Desk",
  wifi: "Wi-Fi",
  washer: "Washer",
  parking: "Parking",
  step_free: "Step-free access",
  onsen: "Onsen",
};

/**
 * The place to stay as schema.org reads it, for the business's own page (ADR-037 §6.4): a
 * LodgingBusiness of its kind with its check-in and check-out times and each room offered as a
 * HotelRoom (an Apartment or an Accommodation for a rental), with its beds, occupancy and amenities.
 * An Offer with a price only where a stay is booked at once — rooms kept for direct guests, or a
 * connected system confirming on its own — since anywhere else the price is the property's answer to
 * a request, not an offer anyone can take. Its price is the lowest a night costs on a plan guests are
 * offered, for the guests the rate is for, with every tax and fee a night carries in it, whoever collects
 * it (a one-night stay's, so a fee per stay is in it too): never a bare room rate. A room whose taxes
 * depend on the price per guest in tiers shows no price at all. Null with no room to offer. The page it
 * goes on is not indexed: the block is for agents and the property's own site to read.
 */
export function lodgingJsonLd(
  setup: PropertySetup,
  opts: { readonly url?: string | null | undefined; readonly today?: string | undefined } = {},
): Record<string, unknown> | null {
  const p = setup.property;
  const rooms = setup.rooms.filter((r) => r.active && r.offered);
  if (!p.active || rooms.length === 0) return null;
  const plans = new Set(setup.plans.filter((x) => x.active && x.offered).map((x) => x.id));
  const kind = confirmationKind(setup);
  const today = opts.today ?? "";
  const kept = (roomId: string) =>
    kind === "instant" ||
    (kind === "instant_some" &&
      setup.allotments.some((a) => a.roomTypeId === roomId && a.units > 0 && (!today || a.toDate >= today)));
  const roomLd = (r: RoomTypeRow) => ({
    "@type": ROOM_TYPE[p.kind] ?? "HotelRoom",
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    occupancy: { "@type": "QuantitativeValue", maxValue: r.capacity.total },
    ...(r.beds.length
      ? {
          bed: r.beds.map((b) => ({
            "@type": "BedDetails",
            numberOfBeds: b.count,
            typeOfBed: BED_WORDS[b.type] ?? b.type,
          })),
        }
      : {}),
    ...(r.sizeM2 ? { floorSize: { "@type": "QuantitativeValue", value: r.sizeM2, unitCode: "MTK" } } : {}),
    ...(r.amenities.length || r.accessible
      ? {
          amenityFeature: [...r.amenities, ...(r.accessible && !r.amenities.includes("step_free") ? ["step_free"] : [])]
            .filter((a) => AMENITY_WORDS[a])
            .map((a) => ({ "@type": "LocationFeatureSpecification", name: AMENITY_WORDS[a], value: true })),
        }
      : {}),
  });
  const fees = setup.fees.filter((f) => f.active);
  /** A night at this rate with every tax and fee in it, or null where the fees cannot be said for one night. */
  const allIn = (rate: (typeof setup.rates)[number]): number | null => {
    let total = rate.nightly;
    for (const f of fees) {
      if (f.tiers?.length) return null;
      switch (f.basis) {
        case "per_stay":
        case "per_night":
        case "per_room_night":
          total += f.amount ?? 0;
          break;
        case "per_person_night":
          total += (f.amount ?? 0) * rate.baseGuests;
          break;
        case "percent_of_room":
          total += shareOf(rate.nightly, f.rateBp ?? 0);
          break;
      }
    }
    return total;
  };
  const offers = rooms.flatMap((r) => {
    if (!kept(r.id)) return [];
    const nightly = setup.rates
      .filter((x) => x.roomTypeId === r.id && plans.has(x.ratePlanId) && x.fromDate === "")
      .map(allIn);
    if (nightly.length === 0 || nightly.some((n) => n === null)) return [];
    const price = decimalOf(Math.min(...(nightly as number[])), p.currency);
    if (price === null) return [];
    return [
      {
        "@type": "Offer",
        itemOffered: roomLd(r),
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          minPrice: price,
          priceCurrency: p.currency,
          unitText: "night",
          valueAddedTaxIncluded: true,
        },
        description: "From, a night, with every tax and fee in it.",
      },
    ];
  });
  return {
    "@context": "https://schema.org",
    "@type": LODGING_TYPE[p.kind] ?? "LodgingBusiness",
    name: p.name,
    ...(opts.url ? { url: opts.url } : {}),
    ...(p.locality ? { address: { "@type": "PostalAddress", addressLocality: p.locality } } : {}),
    checkinTime: p.checkInFrom,
    checkoutTime: p.checkOutUntil,
    currenciesAccepted: p.currency,
    petsAllowed: p.pets.allowed === "yes",
    containsPlace: rooms.map(roomLd),
    ...(offers.length ? { makesOffer: offers } : {}),
  };
}
