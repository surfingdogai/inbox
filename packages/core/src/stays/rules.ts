import type { StayQuote } from "@surfingdog/spec";
import { payCollection } from "../connectors/pay-queue";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { freeUntil } from "../policy/index";
import { ariCovers, ariVerdict } from "../property/ari";
import { hintedNights } from "../property/hints";
import type { StayFacts } from "../rules/evaluate";
import { readSettings } from "../settings/schema";
import { closedNights, insideAllotment, nightsFree } from "./claims";
import { guestLang } from "./lang";
import { nightsOf } from "./nights";
import { quoteFromRates } from "./price";
import { type PropertySetup, readSetup } from "./store";
import { wantOf } from "./transition";

/**
 * What the stays rules read (ADR-037 §7), worked out once before they run: whether the rates price the
 * stay, whether its nights are free where nothing can be sold twice, whether the property is full or
 * closed on them by its own word or its system's (never a calendar hint alone), whether another calendar
 * shows them taken, and for a change, whether cancelling is still free and the new nights are free.
 */

type StayPayload = PayloadOf<"stay">;

/** The rooms of a stay with a room type each: the one named, else the only room type that sleeps them. */
function roomsOf(setup: PropertySetup, p: StayPayload) {
  return p.rooms.map((r) => {
    const fits = setup.rooms.filter(
      (t) =>
        t.active &&
        t.offered &&
        r.adults <= t.capacity.adults &&
        r.childrenAges.length <= t.capacity.children &&
        r.adults + r.childrenAges.length <= t.capacity.total,
    );
    return { ...r, roomTypeId: r.roomTypeId ?? (fits.length === 1 ? fits[0]?.id : undefined) };
  });
}

/** The rates' quote for a stay as it stands, or null when they do not price every night. */
export async function ratesQuote(
  db: Db,
  setup: PropertySetup,
  p: StayPayload,
  now: number,
  partyId?: string,
): Promise<StayQuote | null> {
  const rooms = roomsOf(setup, p);
  if (rooms.some((r) => !r.roomTypeId)) return null;
  const settings = await readSettings(db);
  const priced = quoteFromRates(setup, {
    collect: await payCollection(db),
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    rooms: rooms.map((r) => ({
      roomTypeId: r.roomTypeId as string,
      ratePlanId: r.ratePlanId,
      adults: r.adults,
      childrenAges: r.childrenAges,
      extras: r.extras,
    })),
    lang: await guestLang(db, { partyId, settings }),
    now,
    source: "rates",
  });
  return priced.ok ? priced.quote : null;
}

export async function stayFacts(db: Db, item: Item, now: number): Promise<StayFacts | undefined> {
  if (item.type !== "stay") return undefined;
  const p = item.payload as StayPayload;
  const setup = await readSetup(db, p.propertyId);
  if (!setup) return undefined;
  const rooms = roomsOf(setup, p);
  const named = rooms.every((r) => r.roomTypeId);
  const want = wantOf({ rooms, checkIn: p.checkIn, checkOut: p.checkOut });
  const ratesCover = named && (await ratesQuote(db, setup, p, now, item.partyId)) !== null;
  const free = named && (await nightsFree(db, setup, item.id, want, now)).ok;
  let nightsFreeAtOnce = false;
  if (free && setup.property.mode === "allotment")
    nightsFreeAtOnce = await insideAllotment(db, setup, item.id, want, now);
  if (free && setup.property.mode === "connected" && setup.property.instant)
    nightsFreeAtOnce = await ariCovers(db, setup, want, now);
  // Full or closed: every room type that could take the stay is closed by the owner, fully claimed, or
  // read as full from a fresh look at the property's own system. A calendar hint alone never is.
  const nights = nightsOf(p.checkIn, p.checkOut);
  const candidates = named ? [...want.rooms.keys()] : setup.rooms.filter((t) => t.active && t.offered).map((t) => t.id);
  let nightsClosed = candidates.length > 0;
  for (const roomTypeId of candidates) {
    const one = { rooms: new Map([[roomTypeId, want.rooms.get(roomTypeId) ?? 1]]), nights };
    const closed = closedNights(setup, roomTypeId, nights).length > 0;
    const claimed = !(await nightsFree(db, setup, item.id, one, now)).ok;
    const systemFull =
      setup.property.mode === "connected" &&
      [...(await ariVerdict(db, setup, one, now)).values()].some((v) => v === "full");
    if (!closed && !claimed && !systemFull) {
      nightsClosed = false;
      break;
    }
  }
  let icalHint = false;
  for (const roomTypeId of candidates) {
    if ((await hintedNights(db, roomTypeId, nights, setup.property.timezone)).length > 0) icalHint = true;
  }
  const until = p.quote ? freeUntil(p.quote.policy) : null;
  const freeCancellation = item.state === "confirmed" && until !== null && Date.parse(until) >= now;
  let changeNightsFree = false;
  if (p.change) {
    const changed = wantOf({
      rooms: p.change.rooms ?? p.rooms,
      checkIn: p.change.checkIn,
      checkOut: p.change.checkOut,
    });
    changeNightsFree =
      changed.rooms.size > 0 &&
      [...changed.rooms.keys()].every((id) => closedNights(setup, id, changed.nights).length === 0) &&
      (await nightsFree(db, setup, item.id, changed, now)).ok;
  }
  return { ratesCover, nightsFree: nightsFreeAtOnce, nightsClosed, icalHint, freeCancellation, changeNightsFree };
}

/** The terms a drafted quote shows the owner: its total and lines, as the draft's view carries them. */
export async function draftTerms(db: Db, item: Item, now: number): Promise<Record<string, unknown> | null> {
  if (item.type !== "stay") return null;
  const p = item.payload as StayPayload;
  const setup = await readSetup(db, p.propertyId);
  if (!setup) return null;
  const q = await ratesQuote(db, setup, p, now, item.partyId);
  return q ? { totalPrice: q.total, lines: q.lines, schedule: q.schedule, validThrough: q.validThrough } : null;
}
