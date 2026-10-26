import type { PropertyPublic, StayAvailability, StayQuote } from "@surfingdog/spec";
import { fillStayTemplate } from "@surfingdog/spec";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AccessCapabilities } from "../access/keys";
import type { CarriedInput, IdentityCapabilities } from "../capabilities/identity";
import type { ConnectorCapabilities } from "../connectors/capability";
import { payCollection } from "../connectors/pay-queue";
import { isPropertySystem } from "../connectors/sdk";
import type { Db } from "../db";
import { type Item, type PayloadOf, payloadSchemas } from "../domain/types";
import { ariStatements } from "../property/ari";
import { hintedNights, mapCalendar } from "../property/hints";
import { syncAri } from "../property/sync";
import { items } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import { addDays, dateIn, knownZone } from "../util/zoned";
import { type Caller, isCustomer, nowOf, withIdempotencyKey } from "../write/caller";
import type { CreateInput, CreateResult } from "../write/create";
import { fromZod, WriteError } from "../write/errors";
import { type TransitionResult, transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { allotmentsFor } from "./claims";
import type { StayLang } from "./copy";
import * as I from "./inputs";
import { businessZoneAndCurrency, guestLang } from "./lang";
import { nightsOf, stayTimes } from "./nights";
import { localeOf, quoteFromPrice, quoteFromRates } from "./price";
import {
  availability,
  confirmationSentence,
  ESTIMATE_WORDS,
  judgeStay,
  lodgingJsonLd,
  type OfferMaker,
  offerMaker,
  propertyPublic,
  shareGuests,
  termsSummary,
} from "./public";
import * as Setup from "./setup";
import { listProperties, type PropertySetup, propertyFor, readSetup } from "./store";
import { cancellationTerms, dueNow, feeSha, stayTermsSha } from "./terms";
import { checkGuestPlan, paidOf } from "./transition";

type StayPayload = PayloadOf<"stay">;

/** The most open holds one guest may have at once. */
const MAX_HOLDS = 2;

/**
 * The most open holds one platform's agents may have here at once, all its users together. A platform's
 * key (Web Bot Auth: a key its directory lists) signs for every user it has and tells none of them apart,
 * so it is not one guest: each of its guests is counted by their address, and the platform on its own.
 */
const MAX_PLATFORM_HOLDS = 10;

/** The hold refused over a limit: the guest's own two, or the platform's ten. */
function holdsRefused(reason: "holds" | "platform_holds"): WriteError {
  return new WriteError(
    "guard_failed",
    reason === "holds"
      ? "You hold two stays already: book or let one go first."
      : `Your platform holds ${MAX_PLATFORM_HOLDS} stays here already: book or let one go first.`,
    { details: { guard: "holds", reason } },
  );
}

/** Room types and rate plans named by id or by a few words of their name (an agent's "double"). */
function _roomByWords(setup: PropertySetup, words: string | undefined): string | undefined {
  if (!words) return undefined;
  const w = words.trim().toLowerCase();
  return (
    setup.rooms.find((r) => r.id === words)?.id ??
    setup.rooms.find((r) => r.active && r.offered && r.name.toLowerCase() === w)?.id ??
    setup.rooms.find((r) => r.active && r.offered && r.name.toLowerCase().includes(w))?.id
  );
}

/** A place to stay's doors (ADR-037 §6): the guest's assistant's, and the owner's. */
export class StayCapabilities {
  private readonly offers: OfferMaker;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
    private readonly deps: {
      readonly connectors: ConnectorCapabilities;
      readonly access: AccessCapabilities;
      readonly people: IdentityCapabilities;
    },
  ) {
    this.offers = offerMaker(secrets);
  }

  // ---- reading the property --------------------------------------------------

  /** The property a guest's assistant asks about: the one named, else the only one; refused when there is none. */
  private async setupFor(propertyId: string | undefined): Promise<PropertySetup> {
    const p = await propertyFor(this.db, propertyId);
    const setup = p?.active ? await readSetup(this.db, p.id) : null;
    if (!setup) {
      throw new WriteError(
        "not_found",
        propertyId
          ? "There is no such place to stay here."
          : "This inbox takes no stays, or takes them at more than one place: name the property (property_id).",
        {
          details: {
            properties: (await listProperties(this.db, { active: true })).map((x) => ({ id: x.id, name: x.name })),
          },
        },
      );
    }
    return setup;
  }

  /** The name of the property's system, for its sentence: "Beds24". */
  private async systemName(setup: PropertySetup): Promise<string | null> {
    return (await this.systemOf(setup))?.title ?? null;
  }

  /** The property's system: its name, and where the prices this inbox reads are set there. */
  private async systemOf(setup: PropertySetup): Promise<{ title: string; prices_at: string | null } | null> {
    const id = setup.property.connectorId;
    if (!id) return null;
    const { rows } = await this.db.client.query({
      sql: "SELECT kind, name FROM connectors WHERE id = ?",
      params: [id],
      method: "all",
    });
    if (!rows[0]) return null;
    const def = this.deps.connectors.definition(String(rows[0][0]));
    return { title: def?.title ?? String(rows[0][1]), prices_at: def?.stays?.pricesAt ?? null };
  }

  private langOf(caller: Caller, settings: Settings): Promise<StayLang> {
    return guestLang(this.db, { locale: caller.locale, settings });
  }

  /** Where the property takes stays instead of here, filled in for these dates; null when it takes them here. */
  private async elsewhere(
    settings: Settings,
    q?: { checkIn: string; checkOut: string; adults: number; children: number; rooms: number },
  ): Promise<string | null> {
    const door = settings.doorsElsewhere.find((d) => d.itemType === "stay");
    if (!door) return null;
    const template = door.urlTemplate;
    if (template && q) {
      const filled = fillStayTemplate(template, {
        check_in: q.checkIn,
        check_out: q.checkOut,
        adults: q.adults,
        children: q.children,
        rooms: q.rooms,
      });
      if (filled) return filled;
    }
    return door.url;
  }

  /** An agent's stay where the property takes stays elsewhere, or has the stays door shut: refused, saying where. */
  private async refuseShut(
    caller: Caller,
    settings: Settings,
    q?: Parameters<StayCapabilities["elsewhere"]>[1],
  ): Promise<void> {
    if (!isCustomer(caller)) return;
    const there = await this.elsewhere(settings, q);
    if (there) {
      throw new WriteError("not_allowed", `This property takes stays on its own booking page: ${there}`, {
        details: { reason: "elsewhere", url: there },
      });
    }
    if (caller.actor.kind === "customer_agent" && settings.doors.stay === false) {
      throw new WriteError(
        "not_allowed",
        "This property does not take stays through assistants. Send a message instead.",
        {
          details: { reason: "door_shut", type: "stay" },
        },
      );
    }
  }

  async property(caller: Caller, raw: unknown): Promise<PropertyPublic> {
    const input = parse(I.getPropertyInput, raw);
    const settings = await readSettings(this.db);
    const setup = await this.setupFor(input.property_id);
    return propertyPublic(setup, settings, await this.langOf(caller, settings));
  }

  /** What is free for some dates and guests (`check_stay_availability`). Never stores anything. */
  async availability(
    caller: Caller,
    raw: unknown,
  ): Promise<StayAvailability & { readonly words: string; readonly elsewhere?: string }> {
    const input = parse(I.checkStayAvailabilityInput, raw);
    const settings = await readSettings(this.db);
    const setup = await this.setupFor(input.property_id);
    this.checkDates(setup, input.check_in, input.check_out, nowOf(caller));
    const there = await this.elsewhere(settings, {
      checkIn: input.check_in,
      checkOut: input.check_out,
      adults: input.adults,
      children: input.children_ages.length,
      rooms: input.rooms,
    });
    const answer = await availability(
      this.db,
      setup,
      this.offers,
      {
        checkIn: input.check_in,
        checkOut: input.check_out,
        adults: input.adults,
        childrenAges: input.children_ages,
        rooms: input.rooms,
        roomTypeId: input.room_type_id,
      },
      await this.langOf(caller, settings),
      nowOf(caller),
    );
    const instant = answer.options.some((o) => o.status === "instant");
    return {
      ...answer,
      words: instant
        ? "Instant rooms come with an offer you can hold and book after your person confirms the terms. Prices include every tax and fee."
        : `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours. ${ESTIMATE_WORDS}`,
      ...(there ? { elsewhere: there } : {}),
    };
  }

  /** A firm offer when the rooms can be confirmed at once, else the estimate and when the property answers (`quote_stay`). */
  async quote(
    caller: Caller,
    raw: unknown,
  ): Promise<{
    readonly status: "instant" | "on_request" | "unavailable";
    readonly reason?: string;
    readonly offer?: { offer_id: string; valid_through: string; quote: StayQuote; terms_sha: string; summary: string };
    readonly estimate?: StayQuote & { binding: false };
    readonly totals_changed?: boolean;
    readonly likely_taken?: boolean;
    readonly answers_within_h: number;
    readonly words: string;
  }> {
    const input = parse(I.quoteStayInput, raw);
    const settings = await readSettings(this.db);
    const setup = await this.setupFor(input.property_id);
    const now = nowOf(caller);
    this.checkDates(setup, input.check_in, input.check_out, now);
    const rooms = this.roomsOf(setup, input.rooms, caller);
    const lang = await this.langOf(caller, settings);
    const judged = await judgeStay(
      this.db,
      setup,
      { checkIn: input.check_in, checkOut: input.check_out, rooms },
      lang,
      now,
    );
    const base = {
      answers_within_h: setup.property.answerHours,
      ...(judged.likelyTaken ? { likely_taken: true } : {}),
    };
    if (judged.status === "unavailable" || !judged.quote) {
      return {
        ...base,
        status: judged.status === "unavailable" ? "unavailable" : "on_request",
        ...(judged.reason ? { reason: judged.reason } : {}),
        words:
          judged.status === "unavailable"
            ? (judged.reason ?? "Those nights are no longer free.")
            : `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours.`,
      };
    }
    const subject = { propertyId: setup.property.id, checkIn: input.check_in, checkOut: input.check_out, rooms };
    if (judged.status === "on_request") {
      return {
        ...base,
        status: "on_request",
        estimate: { ...judged.quote, binding: false },
        words: `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours. ${ESTIMATE_WORDS}`,
      };
    }
    const offerId = await this.offers.offerId(judged.quote, subject);
    const terms = await termsSummary(setup, subject, judged.quote, lang);
    return {
      ...base,
      status: "instant",
      offer: { offer_id: offerId, valid_through: judged.quote.validThrough, quote: judged.quote, ...terms },
      ...(input.offer_id ? { totals_changed: input.offer_id !== offerId } : {}),
      words: "Hold it, then book it once your person confirms the terms. Prices include every tax and fee.",
    };
  }

  private checkDates(setup: PropertySetup, checkIn: string, checkOut: string, now: number): void {
    const nights = nightsOf(checkIn, checkOut).length;
    const bad = (path: string, message: string) =>
      new WriteError("invalid_input", message, { fields: [{ path, problem: "invalid", message }] });
    if (nights < 1) throw bad("check_out", "the departure must be after the arrival");
    if (nights > setup.property.maxNights)
      throw bad("check_out", `stays here are at most ${setup.property.maxNights} nights`);
    if (checkIn < dateIn(now, setup.property.timezone)) throw bad("check_in", "the arrival date has passed");
  }

  /**
   * The guest's rooms as the inbox keeps them, every room type named one of the property's, and every rate
   * plan a guest names one the property offers to guests (a person at the property may name any of its own).
   */
  private roomsOf(setup: PropertySetup, rooms: readonly I.GuestRoom[], caller: Caller) {
    return rooms.map((r, i) => {
      const room = r.room_type_id
        ? setup.rooms.find((x) => x.id === r.room_type_id && x.active && x.offered)
        : undefined;
      if (!room) {
        throw new WriteError("invalid_input", "Name a room type from get_property for each room.", {
          fields: [
            {
              path: `rooms.${i}.room_type_id`,
              problem: r.room_type_id ? "invalid" : "missing",
              message: "a room type of this property",
            },
          ],
        });
      }
      if (isCustomer(caller)) checkGuestPlan(setup, { roomTypeId: room.id, ratePlanId: r.rate_plan_id }, `rooms.${i}`);
      return {
        roomTypeId: room.id,
        ...(r.rate_plan_id ? { ratePlanId: r.rate_plan_id } : {}),
        adults: r.adults,
        childrenAges: r.children_ages,
        extras: r.extras.map((e) => ({ extraId: e.extra_id, quantity: e.quantity })),
      };
    });
  }

  // ---- the guest's requests ------------------------------------------------

  /** A request for a stay: the property answers it with its own quote (`request_stay`). */
  async request(caller: Caller, raw: unknown): Promise<CreateResult & { readonly words: string }> {
    const input = parse(I.requestStayInput, raw);
    const settings = await readSettings(this.db);
    const setup = await this.setupFor(input.property_id);
    const adults = input.rooms.reduce((a, r) => a + r.adults, 0);
    const children = input.rooms.reduce((a, r) => a + r.children_ages.length, 0);
    await this.refuseShut(caller, settings, {
      checkIn: input.check_in,
      checkOut: input.check_out,
      adults,
      children,
      rooms: input.rooms.length,
    });
    const lang = await this.langOf(caller, settings);
    const now = nowOf(caller);
    // The estimate the property's rates give, for the owner's draft and the guest's page: never binding.
    let estimate: StayQuote | undefined;
    if (input.rooms.every((r) => r.room_type_id)) {
      const judged = await judgeStay(
        this.db,
        setup,
        { checkIn: input.check_in, checkOut: input.check_out, rooms: this.roomsOf(setup, input.rooms, caller) },
        lang,
        now,
      );
      if (judged.quote) estimate = judged.quote;
    }
    // A request is a person's to answer, whatever the rules say: it waits for them from the start.
    const created = await this.create(caller, input, setup, estimate, { needsHuman: true });
    return { ...created, words: `Sent. ${setup.property.name} answers within ${setup.property.answerHours} hours.` };
  }

  private async create(
    caller: Caller,
    input: z.infer<typeof I.requestStayInput>,
    setup: PropertySetup,
    estimate: StayQuote | undefined,
    flags?: { readonly needsHuman: boolean },
  ): Promise<CreateResult> {
    const c = withIdempotencyKey(caller, input.idempotency_key);
    const payload = {
      propertyId: setup.property.id,
      checkIn: input.check_in,
      checkOut: input.check_out,
      rooms: input.rooms.map((r) => ({
        ...(r.room_type_id ? { roomTypeId: r.room_type_id } : {}),
        ...(r.rate_plan_id ? { ratePlanId: r.rate_plan_id } : {}),
        roomTypeName: setup.rooms.find((x) => x.id === r.room_type_id)?.name ?? "",
        adults: r.adults,
        childrenAges: r.children_ages,
        extras: r.extras.map((e) => ({ extraId: e.extra_id, quantity: e.quantity })),
      })),
      ...(input.guests ? { guests: input.guests } : {}),
      ...(input.arrival ? { arrival: input.arrival } : {}),
      ...(input.requests ? { requests: input.requests } : {}),
    };
    const create: CreateInput = {
      type: "stay",
      payload,
      contact: input.contact,
      ...(input.message ? { message: input.message } : {}),
      ...(estimate ? { stayExtra: { estimate } } : {}),
      ...(flags ? { flags } : {}),
    };
    return this.deps.people.create(c, create, { pass: input.pass, key: input.key } satisfies CarriedInput);
  }

  /**
   * An agent's hold on an instant room (`hold_stay`): the rooms checked live where the property's own
   * system is the authority, then held for `hold_minutes` at the inbox's own offer. A room that cannot be
   * confirmed at once is refused here, before anything is written.
   */
  async hold(
    caller: Caller,
    raw: unknown,
  ): Promise<
    CreateResult & {
      readonly hold_until?: string;
      readonly terms_sha?: string;
      readonly summary?: string;
      readonly words: string;
    }
  > {
    const input = parse(I.holdStayInput, raw);
    const settings = await readSettings(this.db);
    const setup = await this.setupFor(input.property_id);
    const now = nowOf(caller);
    const adults = input.rooms.reduce((a, r) => a + r.adults, 0);
    const children = input.rooms.reduce((a, r) => a + r.children_ages.length, 0);
    await this.refuseShut(caller, settings, {
      checkIn: input.check_in,
      checkOut: input.check_out,
      adults,
      children,
      rooms: input.rooms.length,
    });
    this.checkDates(setup, input.check_in, input.check_out, now);
    const rooms = this.roomsOf(setup, input.rooms, caller);
    const email = input.contact.email;
    await this.limitHolds(caller, email);
    // In connected mode the property's system is asked now, live: a hold is never made on a cache alone.
    // A system that does not answer leaves the stay on request.
    if (setup.property.mode === "connected" && !(await this.liveCheck(setup, input.check_in, input.check_out, now))) {
      throw new WriteError(
        "guard_failed",
        `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours. Use request_stay.`,
        { details: { guard: "instant_safe", status: "on_request", reason: "system_unanswered" } },
      );
    }
    const lang = await this.langOf(caller, settings);
    const judged = await judgeStay(
      this.db,
      setup,
      { checkIn: input.check_in, checkOut: input.check_out, rooms },
      lang,
      now,
    );
    if (judged.status !== "instant" || !judged.quote) {
      throw new WriteError(
        "guard_failed",
        judged.status === "unavailable"
          ? (judged.reason ?? "Those nights are no longer free.")
          : `On request. ${setup.property.name} answers within ${setup.property.answerHours} hours. Use request_stay.`,
        { details: { guard: "instant_safe", status: judged.status } },
      );
    }
    const subject = { propertyId: setup.property.id, checkIn: input.check_in, checkOut: input.check_out, rooms };
    if (input.offer_id && input.offer_id !== (await this.offers.offerId(judged.quote, subject))) {
      throw new WriteError("offer_changed", "The terms changed since that offer: read them again.", {
        details: { totals_changed: true, quote: judged.quote },
      });
    }
    const created = await this.create(caller, input, setup, judged.quote);
    if (created.replayed) return { ...created, words: "This hold was made already." };
    const itemId = created.view.item.id;
    const system: Caller = {
      actor: { kind: "system", id: "stays:hold", channel: "system" },
      tier: "verified_principal",
      sandbox: caller.sandbox,
      now: () => now,
    };
    let held: TransitionResult;
    try {
      held = await transitionItem(this.db, system, { itemId, event: "hold" });
    } catch (error) {
      // Taken a moment ago: the request stays with the property, which answers it.
      if (error instanceof WriteError && (error.code === "slot_taken" || error.code === "guard_failed")) {
        return {
          ...created,
          words: `Those nights went a moment ago. The request went to ${setup.property.name}, which answers within ${setup.property.answerHours} hours.`,
        };
      }
      throw error;
    }
    // Two asking at once may both have passed the count before either held: counted again, and a hold
    // over the limit let go at once.
    const after = await this.holdsOf(caller, email);
    if (after.own > MAX_HOLDS || after.platform > MAX_PLATFORM_HOLDS) {
      await transitionItem(this.db, withToken(caller, created.accessToken), { itemId, event: "release" }).catch(
        () => undefined,
      );
      throw holdsRefused(after.own > MAX_HOLDS ? "holds" : "platform_holds");
    }
    const p = held.view.item.payload as StayPayload;
    const terms = p.quote ? await termsSummary(setup, { ...subject }, p.quote, lang) : undefined;
    return {
      ...created,
      view: held.view,
      ...(p.hold ? { hold_until: p.hold.until } : {}),
      ...(terms ? { terms_sha: terms.terms_sha, summary: terms.summary } : {}),
      // A connected property's room is kept by the inbox's offer, not on its own system: it is confirmed
      // only once the system takes the booking, which book_stay writes there first.
      words:
        setup.property.mode === "connected"
          ? `Offer kept until ${p.hold?.until ?? "soon"}. Book before then, after your person confirms the terms: the room is confirmed once ${setup.property.name}'s own system takes the booking.`
          : `Held until ${p.hold?.until ?? "soon"}. Book before then, after your person confirms the terms.`,
    };
  }

  /**
   * The open holds of whoever asks: by their party, their agent's own signature, and the guest's address
   * (an assistant that signs nothing is still one guest at one address); and, apart, those of the
   * platform whose key signed, all its users together.
   */
  private async holdsOf(caller: Caller, email: string | undefined): Promise<{ own: number; platform: number }> {
    const party = caller.actor.partyId;
    const platform = caller.agent?.platform;
    const agent = platform ? undefined : caller.agent?.thumbprint;
    const mail = email?.trim().toLowerCase();
    const where: string[] = [];
    const params: string[] = [];
    if (party) {
      where.push("party_id = ?");
      params.push(party);
    }
    if (agent) {
      where.push("agent_thumbprint = ?");
      params.push(agent);
    }
    if (mail) {
      where.push("party_id IN (SELECT id FROM parties WHERE lower(trim(json_extract(contact, '$.email'))) = ?)");
      params.push(mail);
    }
    const count = async (sql: string, args: readonly string[]) =>
      Number((await this.db.client.query({ sql, params: [...args], method: "all" })).rows[0]?.[0] ?? 0);
    const held = "SELECT COUNT(*) FROM items WHERE type = 'stay' AND state = 'held'";
    return {
      own: where.length ? await count(`${held} AND (${where.join(" OR ")})`, params) : 0,
      platform: platform ? await count(`${held} AND agent_directory = ?`, [platform]) : 0,
    };
  }

  /**
   * At most two open holds per person, agent and address, and ten per platform: nobody parks rooms by
   * asking (§6.1, ADR-038 §5).
   */
  private async limitHolds(caller: Caller, email: string | undefined): Promise<void> {
    const n = await this.holdsOf(caller, email);
    if (n.own >= MAX_HOLDS) throw holdsRefused("holds");
    if (n.platform >= MAX_PLATFORM_HOLDS) throw holdsRefused("platform_holds");
  }

  /**
   * The property's system asked now for these nights; its answer goes in the cache as `live`. Answers
   * whether it answered: a hold is never made when it did not.
   */
  async liveCheck(setup: PropertySetup, checkIn: string, checkOut: string, now: number): Promise<boolean> {
    const id = setup.property.connectorId;
    const ext = setup.property.externalId;
    if (!id || !ext) return false;
    const conn = await this.deps.connectors.contextFor(id, now);
    if (!conn || !isPropertySystem(conn.definition)) return false;
    try {
      const read = await conn.definition.stays.ari(conn.ctx, ext, { from: checkIn, to: checkOut });
      const rows = Array.isArray(read) ? read : read.rows;
      if (!Array.isArray(read) && read.until < checkOut) return false;
      await this.db.batch(ariStatements(id, rows, "live", now));
      return true;
    } catch {
      return false;
    }
  }

  /** Books a held stay once the guest confirmed its terms (`book_stay`): written to the property's system first where it has one. */
  async book(caller: Caller, raw: unknown): Promise<TransitionResult & { readonly words: string }> {
    const input = parse(I.bookStayInput, raw);
    const c = withToken(withIdempotencyKey(caller, input.idempotency_key), input.access_token);
    const r = await transitionItem(this.db, c, {
      itemId: input.item_id,
      event: "book",
      input: { ...(input.terms_sha ? { terms_sha: input.terms_sha } : {}) },
    });
    const state = r.view.item.state;
    return {
      ...r,
      words:
        state === "confirmed"
          ? "Booked."
          : state === "awaiting_payment"
            ? "Booked once the deposit or the card is in: see payments for the link and its deadline."
            : "Being written to the property's own system; the answer follows in a moment.",
    };
  }

  /** A change of dates or rooms (`change_stay`): the new terms first, then the request to the property. */
  async change(caller: Caller, raw: unknown): Promise<TransitionResult> {
    const input = parse(I.changeStayInput, raw);
    const c = withToken(withIdempotencyKey(caller, input.idempotency_key), input.access_token);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (row?.type !== "stay") throw new WriteError("not_found", "no such stay");
    const item = rowToItem(row);
    const p = item.payload as StayPayload;
    const setup = await readSetup(this.db, p.propertyId);
    if (!setup) throw new WriteError("not_found", "no such stay");
    const rooms = input.rooms ? this.roomsOf(setup, input.rooms, c) : p.rooms;
    // The new terms the guest sees before they ask: the rates' new total and what it means to pay or get back.
    if (isCustomer(c) && rooms.every((r) => r.roomTypeId)) {
      const settings = await readSettings(this.db);
      const lang = await this.langOf(c, settings);
      const priced = quoteFromRates(setup, {
        collect: await payCollection(this.db),
        checkIn: input.check_in,
        checkOut: input.check_out,
        rooms: rooms.map((r) => ({
          roomTypeId: r.roomTypeId as string,
          ratePlanId: r.ratePlanId,
          adults: r.adults,
          childrenAges: r.childrenAges,
          extras: r.extras ?? [],
        })),
        lang,
        now: nowOf(c),
        source: "rates",
      });
      if (priced.ok) {
        const subject = { propertyId: setup.property.id, checkIn: input.check_in, checkOut: input.check_out, rooms };
        const sha = await stayTermsSha(subject, priced.quote);
        if (input.terms_sha !== sha) {
          const paid = paidOf(p).value;
          const withBooking = priced.quote.schedule
            .filter((s) => s.type !== "at_property")
            .reduce((a, s) => a + s.amount.value, 0);
          throw new WriteError(input.terms_sha ? "offer_changed" : "confirm_terms", "Confirm the new total first.", {
            details: {
              terms_sha: sha,
              total: priced.quote.total,
              difference: { value: withBooking - paid, currency: priced.quote.currency },
              quote: priced.quote,
            },
          });
        }
      }
    }
    return transitionItem(this.db, c, {
      itemId: input.item_id,
      event: "propose_change",
      input: {
        checkIn: input.check_in,
        checkOut: input.check_out,
        ...(input.rooms
          ? {
              rooms: rooms.map((r) => ({
                ...r,
                roomTypeName: setup.rooms.find((x) => x.id === r.roomTypeId)?.name ?? "",
              })),
            }
          : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
  }

  // ---- what a stay's guest reads -----------------------------------------------

  /**
   * A stay's terms as its guest reads them (`get_item_status`, the `/c/` page): the quote in force and
   * its fingerprint, the schedule with each open link and its deadline, the policy in words, what
   * cancelling costs now (with its fingerprint), and the hold or the change open.
   */
  async terms(item: Item, lang: StayLang, now: number): Promise<StayTerms | null> {
    if (item.type !== "stay") return null;
    const p = item.payload as StayPayload;
    const setup = await readSetup(this.db, p.propertyId);
    if (!setup) return null;
    const { rows: links } = await this.db.client.query({
      sql: `SELECT schedule_id, url, expires_at FROM connector_payments WHERE item_id = ? AND state IN ('creating', 'open') AND url IS NOT NULL`,
      params: [item.id],
      method: "all",
    });
    const linkOf = (id: string) => links.find((l) => String(l[0]) === id);
    const quote = p.quote ?? null;
    const subject = { propertyId: p.propertyId, checkIn: p.checkIn, checkOut: p.checkOut, rooms: p.rooms };
    const summary = quote ? await termsSummary(setup, subject, quote, lang) : null;
    const cancel =
      item.state === "confirmed" && quote
        ? await (async () => {
            const t = cancellationTerms(quote, paidOf(p), now);
            return { fee: t.fee, refund: t.refund, fee_sha: await feeSha(item.id, t) };
          })()
        : null;
    const { startTime, endTime } = stayTimes(setup.property, p.checkIn, p.checkOut);
    return {
      property: { id: setup.property.id, name: setup.property.name, how_to_find_us: setup.property.arrivalPublic },
      check_in: p.checkIn,
      check_out: p.checkOut,
      starts: startTime,
      ends: endTime,
      nights: nightsOf(p.checkIn, p.checkOut).length,
      quote,
      summary: summary?.summary ?? null,
      terms_sha: summary?.terms_sha ?? null,
      due_now: quote ? dueNow(quote) : false,
      payments: (p.payments?.schedules ?? []).map((s) => {
        const link = linkOf(s.id);
        return {
          id: s.id,
          type: s.type,
          amount: s.amount,
          status: s.status,
          ...(s.dueAt ? { due_at: s.dueAt } : {}),
          ...(link && s.status === "due" ? { pay_url: String(link[1]) } : {}),
        };
      }),
      pay_by: p.payments?.dueBy ?? null,
      card: p.payments?.guarantee.status ?? "none",
      hold_until: item.state === "held" ? (p.hold?.until ?? null) : null,
      cancel,
      change: p.change ?? null,
      cancellation: p.cancellation ?? null,
      registration: p.registration ?? null,
      estimate: !quote && p.estimate ? { ...p.estimate, binding: false as const } : null,
    };
  }

  /**
   * The page where a guest saves a card to hold their stay (§5.4), made on the property's own payment
   * platform when they open the link, for at most the time they have to do it.
   */
  async openCard(
    item: Item,
    lang: StayLang,
    returnUrl: string,
    now: number,
  ): Promise<{ url: string } | { refused: string }> {
    if (item.type !== "stay") return { refused: "not a stay" };
    const p = item.payload as StayPayload;
    const currency = p.quote?.currency;
    if (!currency) return { refused: "no terms" };
    const until = p.payments?.dueBy ? Date.parse(p.payments.dueBy) : now + 24 * 3_600_000;
    const r = await this.deps.connectors.payments.openGuarantee(
      {
        itemId: item.id,
        sandbox: item.flags.sandbox,
        currency,
        reference: item.id.slice(-6).toUpperCase(),
        language: lang,
        returnUrl,
        cancelUrl: returnUrl,
        ttlMs: Math.max(30 * 60_000, until - now),
      },
      now,
    );
    return "url" in r ? { url: r.url } : r;
  }

  /** Whether the guest saved the card, read back from the platform; the stay hears it as a payment would. */
  checkCard(item: Item, now: number): Promise<boolean> {
    return this.deps.connectors.payments.checkGuarantee(item.id, now);
  }

  // ---- the owner's ---------------------------------------------------------------

  async setup(caller: Caller, propertyId?: string): Promise<OwnerSetup> {
    Setup.requireOwner(caller);
    const all = await listProperties(this.db);
    const chosen = propertyId ? all.find((p) => p.id === propertyId) : all[0];
    const setup = chosen ? await readSetup(this.db, chosen.id) : null;
    const settings = await readSettings(this.db);
    const { rows: calendars } = await this.db.client.query({
      sql: `SELECT id, COALESCE(json_extract(config_public, '$.account'), name), json_extract(config_public, '$.stayRoomTypeId')
              FROM connectors WHERE kind = 'ics' AND status <> 'disabled' ORDER BY created_at`,
      params: [],
      method: "all",
    });
    return {
      properties: all.map((p) => ({ id: p.id, name: p.name, active: p.active })),
      setup: setup
        ? {
            ...setup,
            property: { ...setup.property },
            sentence: confirmationSentence(setup, await this.systemName(setup)),
            instant_unlocked: setup.property.connectorId
              ? await Setup.systemProven(this.db, setup.property.connectorId)
              : false,
            system: await this.systemOf(setup),
          }
        : null,
      calendars: calendars.map((r) => ({
        id: String(r[0]),
        name: String(r[1] ?? ""),
        room_type_id: r[2] === null ? null : String(r[2]),
      })),
      stays: settings.stays,
      // What the owner's screens need to say what is possible: taking money before arrival, saving a
      // card, sealing door codes on this server.
      collect: await payCollection(this.db),
      can_seal: this.secrets !== null,
    };
  }

  async upsertProperty(caller: Caller, raw: unknown): Promise<{ id: string }> {
    const { charges_covered, ...input } = parse(I.upsertPropertyInput, raw);
    if (input.instant === true && input.id && charges_covered !== true) await this.chargesCovered(caller, input.id);
    return { id: await Setup.upsertProperty(this.db, this.secrets, caller, input) };
  }

  /**
   * Before stays confirm at once from a property's own system: the charges that system adds to the
   * rooms matched here besides their price (a cleaning fee, a tax, an obligatory extra), which the
   * inbox's quote leaves out unless they are in Taxes & fees. While the system says it adds some, the
   * owner says they are covered first (`charges_covered`); until then every stay is theirs to confirm.
   */
  private async chargesCovered(caller: Caller, propertyId: string): Promise<void> {
    const setup = await readSetup(this.db, propertyId);
    const connectorId = setup?.property.connectorId;
    const externalId = setup?.property.externalId;
    if (!setup || !connectorId || !externalId) return;
    const conn = await this.deps.connectors.contextFor(connectorId, nowOf(caller));
    if (!conn || !isPropertySystem(conn.definition)) return;
    const mapped = new Set(setup.rooms.filter((r) => r.active && r.offered && r.externalId).map((r) => r.externalId));
    const charged = (await conn.definition.stays.rooms(conn.ctx, externalId)).filter(
      (r) => mapped.has(r.id) && (r.charges ?? []).some((c) => c !== "deposit"),
    );
    if (charged.length === 0) return;
    const kinds = [...new Set(charged.flatMap((r) => (r.charges ?? []).filter((c) => c !== "deposit")))];
    const words = listWords(kinds.map((k) => CHARGE_WORDS[k]));
    const title = conn.definition.title;
    throw new WriteError(
      "guard_failed",
      `${title} adds ${words} to ${listWords(charged.map((r) => r.name))} on its other channels. Add ${kinds.length === 1 ? "it" : "them"} in Taxes & fees, so guests are quoted the same total, then switch this on.`,
      { details: { reason: "system_charges", rooms: charged.map((r) => r.name), charges: kinds } },
    );
  }

  async upsertRoomType(caller: Caller, raw: unknown): Promise<{ id: string }> {
    return { id: await Setup.upsertRoomType(this.db, caller, parse(I.upsertRoomTypeInput, raw)) };
  }

  async archiveRoomType(caller: Caller, raw: unknown): Promise<{ archived: true }> {
    const { id } = parse(z.object({ id: z.string().min(1) }), raw);
    await Setup.archiveRoomType(this.db, caller, id);
    return { archived: true };
  }

  async upsertRatePlan(caller: Caller, raw: unknown): Promise<{ id: string }> {
    return { id: await Setup.upsertRatePlan(this.db, caller, parse(I.upsertRatePlanInput, raw)) };
  }

  async setRates(caller: Caller, raw: unknown): Promise<{ saved: true }> {
    const input = Array.isArray(raw) ? raw : [raw];
    for (const r of input) await Setup.setRates(this.db, caller, parse(I.setRatesInput, r));
    return { saved: true };
  }

  async setFees(caller: Caller, raw: unknown): Promise<{ saved: true }> {
    await Setup.setFees(this.db, caller, parse(I.setStayFeesInput, raw));
    return { saved: true };
  }

  async upsertExtra(caller: Caller, raw: unknown): Promise<{ id: string }> {
    return { id: await Setup.upsertExtra(this.db, caller, parse(I.upsertStayExtraInput, raw)) };
  }

  async setAllotment(caller: Caller, raw: unknown): Promise<{ saved: true }> {
    await Setup.setAllotment(this.db, caller, parse(I.setAllotmentInput, raw));
    return { saved: true };
  }

  async closeNights(caller: Caller, raw: unknown): Promise<{ saved: true }> {
    await Setup.closeNights(this.db, caller, parse(I.closeNightsInput, raw));
    return { saved: true };
  }

  /** The place to stay as schema.org reads it, for the business's own page (`lodgingJsonLd`); null when none. */
  async frontJsonLd(url: string | null, now: number = Date.now()): Promise<Record<string, unknown> | null> {
    const p = (await listProperties(this.db)).find((x) => x.active);
    const setup = p ? await readSetup(this.db, p.id) : null;
    return setup ? lodgingJsonLd(setup, { url, today: dateIn(now, setup.property.timezone) }) : null;
  }

  /** A calendar link as the nights another channel took for one room type (or none). */
  async mapCalendar(caller: Caller, raw: unknown): Promise<{ saved: boolean }> {
    Setup.requireOwner(caller);
    const input = parse(
      z.object({
        connector_id: z.string().min(1),
        room_type_id: z.string().min(1).nullable(),
        units: z.int().min(1).max(500).default(1),
      }),
      raw,
    );
    return { saved: await mapCalendar(this.db, input.connector_id, input.room_type_id, input.units, nowOf(caller)) };
  }

  /**
   * The owner's Nights grid (S10): room types by days, each cell a stay, a hold, rooms kept for direct
   * guests, another calendar's hint, a closure, or what the property's system says is free.
   */
  async nights(caller: Caller, raw: unknown): Promise<NightsGrid> {
    Setup.requireOwner(caller);
    const input = parse(I.nightsInput, raw);
    const p = await propertyFor(this.db, input.property_id);
    const setup = p ? await readSetup(this.db, p.id) : null;
    if (!setup) throw new WriteError("not_found", "There is no property yet.");
    const now = nowOf(caller);
    const from = input.from ?? dateIn(now, setup.property.timezone);
    const days = Array.from({ length: input.days }, (_, i) => addDays(from, i));
    const roomIds = setup.rooms.filter((r) => r.active).map((r) => r.id);
    const { rows: claims } = roomIds.length
      ? await this.db.client.query({
          sql: `SELECT c.room_type_id, c.night, c.item_id, c.hold_until FROM night_claims c
                 WHERE c.room_type_id IN (${roomIds.map(() => "?").join(", ")}) AND c.night >= ? AND c.night <= ?`,
          params: [...roomIds, from, days[days.length - 1] as string],
          method: "all",
        })
      : { rows: [] };
    const rooms: NightsGrid["rooms"][number][] = [];
    for (const room of setup.rooms.filter((r) => r.active)) {
      const hints = await hintedNights(this.db, room.id, days, setup.property.timezone);
      rooms.push({
        id: room.id,
        name: room.name,
        units: room.units,
        cells: days.map((night) => {
          const mine = claims.filter((c) => String(c[0]) === room.id && String(c[1]) === night);
          const live = mine.filter((c) => c[3] === null || Number(c[3]) > now);
          return {
            night,
            stays: live
              .filter((c) => c[3] === null)
              .map((c) => ({ item_id: String(c[2]), reference: String(c[2]).slice(-6).toUpperCase() })),
            holds: live
              .filter((c) => c[3] !== null)
              .map((c) => ({
                item_id: String(c[2]),
                minutes_left: Math.max(0, Math.round((Number(c[3]) - now) / 60_000)),
              })),
            kept: allotmentsFor(setup.allotments, room.id, night)[0]?.units ?? 0,
            hint: hints.find((h) => h.night === night)?.source ?? null,
            closed: setup.closures.some(
              (c) =>
                (c.roomTypeId === "" || c.roomTypeId === room.id) &&
                c.fromDate <= night &&
                night <= (c.toDate || c.fromDate),
            ),
          };
        }),
      });
    }
    return { property: { id: setup.property.id, name: setup.property.name }, days, rooms };
  }

  /** A quote from the rates for a request, worked out and shown, never sent (`draft_stay_quote`). */
  async draftQuote(
    caller: Caller,
    raw: unknown,
  ): Promise<{ quote: StayQuote | null; reason?: string; lang: StayLang }> {
    Setup.requireOwner(caller);
    const input = parse(I.draftQuoteInput, raw);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (row?.type !== "stay") throw new WriteError("not_found", "no such stay");
    const p = rowToItem(row).payload as StayPayload;
    const setup = await readSetup(this.db, p.propertyId);
    if (!setup) throw new WriteError("not_found", "no such property");
    const rooms = p.rooms.map((r, i) => {
      const pick = input.rooms?.find((x) => x.index === i);
      return {
        roomTypeId: pick?.room_type_id ?? r.roomTypeId ?? setup.rooms.find((x) => x.active && x.offered)?.id ?? "",
        ratePlanId: pick?.rate_plan_id ?? r.ratePlanId,
        adults: r.adults,
        childrenAges: r.childrenAges,
        extras: r.extras,
      };
    });
    const settings = await readSettings(this.db);
    const lang = await guestLang(this.db, { partyId: row.partyId, settings });
    const req = {
      collect: await payCollection(this.db),
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      rooms,
      lang,
      now: nowOf(caller),
      source: "rates" as const,
    };
    const priced = input.price ? quoteFromPrice(setup, req, input.price) : quoteFromRates(setup, req);
    // The lines are in the guest's language: the owner is told which.
    return priced.ok ? { quote: priced.quote, lang } : { quote: null, reason: priced.reason, lang };
  }

  /**
   * Today at the property (S14): who arrives, who leaves, who is in, with what is still to pay there.
   */
  async today(caller: Caller, raw: unknown): Promise<TodayView> {
    Setup.requireOwner(caller);
    const input = parse(z.object({ property_id: z.string().optional(), date: z.iso.date().optional() }), raw ?? {});
    const p = await propertyFor(this.db, input.property_id);
    if (!p) return { date: "", arriving: [], leaving: [], in_house: [] };
    const date = input.date ?? dateIn(nowOf(caller), p.timezone);
    const { rows } = await this.db.client.query({
      sql: `SELECT i.id, i.state, i.payload, json_extract(p.contact, '$.name') FROM items i LEFT JOIN parties p ON p.id = i.party_id
             WHERE i.type = 'stay' AND i.state IN ('confirmed', 'checked_in', 'awaiting_payment')
             AND json_extract(i.payload, '$.propertyId') = ? AND json_extract(i.payload, '$.checkIn') <= ? AND json_extract(i.payload, '$.checkOut') >= ?`,
      params: [p.id, date, date],
      method: "all",
    });
    const rowsOf = rows.map((r) => {
      const payload = payloadSchemas.stay.parse(JSON.parse(String(r[2])));
      const there = (payload.payments?.schedules ?? [])
        .filter((s) => s.status === "at_property" || s.status === "due")
        .reduce((a, s) => a + s.amount.value - (s.paidAmount?.value ?? 0), 0);
      return {
        item_id: String(r[0]),
        state: String(r[1]),
        reference: String(r[0]).slice(-6).toUpperCase(),
        guest: payload.guests?.lead.name || (r[3] === null || r[3] === undefined ? null : String(r[3])),
        rooms: payload.rooms.map((x) => x.roomTypeName).filter(Boolean),
        check_in: payload.checkIn,
        check_out: payload.checkOut,
        arrival: payload.arrival ?? null,
        to_pay: { value: Math.max(0, there), currency: payload.quote?.currency ?? p.currency },
      };
    });
    return {
      date,
      arriving: rowsOf.filter((r) => r.check_in === date && r.state !== "checked_in"),
      leaving: rowsOf.filter((r) => r.check_out === date),
      in_house: rowsOf.filter((r) => r.state === "checked_in" && r.check_out !== date),
    };
  }

  /** The properties and rooms a property system shows, to choose which is this one (S2). */
  async systemProperties(
    caller: Caller,
    raw: unknown,
  ): Promise<{
    /** Where the system's prices are set, in its own words ("Prices → Daily Price Rules"); null when not said. */
    prices_at: string | null;
    properties: {
      id: string;
      name: string;
      rooms: {
        id: string;
        name: string;
        units: number;
        unpriced?: true | "rules";
        charges?: readonly ("cleaning" | "tax" | "deposit" | "extra")[];
      }[];
    }[];
  }> {
    Setup.requireInPerson(caller, "connect the property's system");
    const { connector_id } = parse(z.object({ connector_id: z.string().min(1) }), raw);
    const conn = await this.deps.connectors.contextFor(connector_id, nowOf(caller));
    if (!conn || !isPropertySystem(conn.definition))
      throw new WriteError("not_found", "That connection is not a property system.");
    const props = await conn.definition.stays.properties(conn.ctx);
    const out = [];
    for (const p of props.slice(0, 20)) {
      const rooms = await conn.definition.stays.rooms(conn.ctx, p.id);
      out.push({
        id: p.id,
        name: p.name,
        // A room with no price there is never offered from here; charges besides the price are the owner's to check.
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          units: r.units,
          ...(r.unpriced === "rules" ? { unpriced: "rules" as const } : r.unpriced ? { unpriced: true as const } : {}),
          ...(r.charges?.length ? { charges: [...r.charges] } : {}),
        })),
      });
    }
    return { prices_at: conn.definition.stays.pricesAt ?? null, properties: out };
  }

  /**
   * This property is that one in the system, and its rooms these (S2 mapping): room types made for the
   * ones marked new, named and counted as the system has them, and the rooms here that are none of the
   * system's no longer offered (`stop_offering`). From then on each stay is written to the system first
   * (mode `connected`); nothing confirms at once until the owner says so, and only after a first stay
   * was written and read back.
   */
  async mapSystem(caller: Caller, raw: unknown): Promise<{ property_id: string; rooms: number }> {
    Setup.requireInPerson(caller, "connect the property's system");
    const input = parse(I.mapSystemInput, raw);
    const now = nowOf(caller);
    const conn = await this.deps.connectors.contextFor(input.connector_id, now);
    if (!conn || !isPropertySystem(conn.definition))
      throw new WriteError("not_found", "That connection is not a property system.");
    const props = await conn.definition.stays.properties(conn.ctx);
    const ext = props.find((p) => p.id === input.external_property_id);
    if (!ext)
      throw new WriteError("invalid_input", "The system does not show that property.", {
        fields: [{ path: "external_property_id", problem: "invalid", message: "one the system shows" }],
      });
    const existing = input.property_id ? await readSetup(this.db, input.property_id) : null;
    const settings = await readSettings(this.db);
    // The system's prices are in its currency and its nights in its zone: a property in another currency
    // would read them as the wrong money, and one in another zone would count the wrong nights.
    if (existing && ext.currency && ext.currency.toUpperCase() !== existing.property.currency) {
      throw new WriteError(
        "invalid_input",
        `Your system keeps this property in ${ext.currency.toUpperCase()}, and here it is in ${existing.property.currency}. Make them the same first.`,
        { fields: [{ path: "external_property_id", problem: "invalid", message: "a property in the same currency" }] },
      );
    }
    if (existing && ext.timezone && knownZone(ext.timezone) !== existing.property.timezone) {
      throw new WriteError(
        "invalid_input",
        `Your system keeps this property in the ${ext.timezone} time zone, and here it is in ${existing.property.timezone}. Set the property's time zone to match first.`,
        { fields: [{ path: "external_property_id", problem: "invalid", message: "a property in the same time zone" }] },
      );
    }
    const firstMatch =
      !existing || existing.property.connectorId !== input.connector_id || existing.property.externalId !== ext.id;
    const propertyId = await Setup.upsertProperty(this.db, this.secrets, caller, {
      ...(existing
        ? { id: existing.property.id }
        : {
            name: ext.name,
            currency: ext.currency?.toUpperCase() ?? (await businessZoneAndCurrency(this.db, settings)).currency,
            ...(ext.timezone && knownZone(ext.timezone) === ext.timezone ? { timezone: ext.timezone } : {}),
          }),
      connector_id: input.connector_id,
      external_id: ext.id,
      // Matched for the first time: its stays go into the system first, confirming at once still off
      // (`instant`). Matched again (its rooms saved), how it confirms stays as the owner left it.
      ...(firstMatch && existing?.property.mode !== "connected" ? { mode: "connected" as const } : {}),
    });
    const extRooms = await conn.definition.stays.rooms(conn.ctx, ext.id);
    let made = 0;
    for (const m of input.rooms) {
      const r = extRooms.find((x) => x.id === m.external_id);
      if (!r) continue;
      if (m.room_type_id === "new") {
        await Setup.upsertRoomType(this.db, caller, {
          property_id: propertyId,
          name: r.name,
          units: Math.max(1, r.units),
          capacity: r.capacity ?? { adults: 2, children: 0, total: 2 },
          beds: (r.beds ?? []).filter((b) =>
            ["double", "single", "queen", "king", "bunk", "sofa_bed", "futon", "cot"].includes(b.type),
          ) as never,
          amenities: [],
          accessible: false,
          photos: [],
          external_id: r.id,
          offered: true,
          sort: made,
        });
      } else {
        await this.db.client.query({
          sql: "UPDATE room_types SET external_id = ?, updated_at = ? WHERE id = ? AND property_id = ?",
          params: [r.id, now, m.room_type_id, propertyId],
          method: "run",
        });
      }
      made++;
    }
    // A room here with no match there: never offered from now on, as no stay of it could go into the system.
    const matched = new Set(input.rooms.filter((m) => m.room_type_id !== "new").map((m) => m.room_type_id));
    for (const roomTypeId of input.stop_offering ?? []) {
      if (matched.has(roomTypeId)) continue;
      await this.db.client.query({
        sql: "UPDATE room_types SET offered = 0, updated_at = ? WHERE id = ? AND property_id = ?",
        params: [now, roomTypeId, propertyId],
        method: "run",
      });
    }
    return { property_id: propertyId, rooms: made };
  }

  /** Reads the property's system again now (the owner's "sync now"). */
  async syncNow(caller: Caller, raw: unknown): Promise<{ rows: number }> {
    Setup.requireOwner(caller);
    const { property_id } = parse(z.object({ property_id: z.string().optional() }), raw ?? {});
    const p = await propertyFor(this.db, property_id);
    const setup = p ? await readSetup(this.db, p.id) : null;
    if (!setup?.property.connectorId) return { rows: 0 };
    return { rows: await syncAri(this.db, this.deps.connectors, setup, nowOf(caller), { days: 60 }) };
  }
}

function withToken(caller: Caller, token: string | undefined): Caller {
  return token ? { ...caller, accessToken: token } : caller;
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw fromZod(r.error, "");
  return r.data;
}

export interface StayTerms {
  readonly property: { readonly id: string; readonly name: string; readonly how_to_find_us: string | null };
  readonly check_in: string;
  readonly check_out: string;
  readonly starts: string;
  readonly ends: string;
  readonly nights: number;
  readonly quote: StayQuote | null;
  readonly summary: string | null;
  readonly terms_sha: string | null;
  readonly due_now: boolean;
  readonly payments: readonly {
    readonly id: string;
    readonly type: string;
    readonly amount: { readonly value: number; readonly currency: string };
    readonly status: string;
    readonly due_at?: string;
    readonly pay_url?: string;
  }[];
  readonly pay_by: string | null;
  readonly card: string;
  readonly hold_until: string | null;
  readonly cancel: {
    readonly fee: { value: number; currency: string };
    readonly refund: { value: number; currency: string };
    readonly fee_sha: string;
  } | null;
  readonly change: StayPayload["change"] | null;
  readonly cancellation: StayPayload["cancellation"] | null;
  readonly registration: string | null;
  readonly estimate: (StayQuote & { binding: false }) | null;
}

export interface NightsGrid {
  readonly property: { readonly id: string; readonly name: string };
  readonly days: readonly string[];
  readonly rooms: readonly {
    readonly id: string;
    readonly name: string;
    readonly units: number;
    readonly cells: readonly {
      readonly night: string;
      readonly stays: readonly { item_id: string; reference: string }[];
      readonly holds: readonly { item_id: string; minutes_left: number }[];
      readonly kept: number;
      readonly hint: string | null;
      readonly closed: boolean;
    }[];
  }[];
}

export interface TodayView {
  readonly date: string;
  readonly arriving: readonly TodayRow[];
  readonly leaving: readonly TodayRow[];
  readonly in_house: readonly TodayRow[];
}

export interface TodayRow {
  readonly item_id: string;
  readonly state: string;
  readonly reference: string;
  readonly guest: string | null;
  readonly rooms: readonly string[];
  readonly check_in: string;
  readonly check_out: string;
  readonly arrival: { from: string; to: string } | null;
  readonly to_pay: { value: number; currency: string };
}

/** The charges a system adds besides a room's price, in the owner's words. */
const CHARGE_WORDS = {
  cleaning: "a cleaning fee",
  tax: "tax",
  deposit: "a security deposit",
  extra: "an extra",
} as const;

/** "a, b and c". */
function listWords(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
}

export interface OwnerSetup {
  readonly properties: readonly { id: string; name: string; active: boolean }[];
  readonly setup:
    | (PropertySetup & {
        sentence: string;
        instant_unlocked: boolean;
        /** The property's own system, when one is connected: its name, and where its prices are set there. */
        system: { readonly title: string; readonly prices_at: string | null } | null;
      })
    | null;
  readonly calendars: readonly { id: string; name: string; room_type_id: string | null }[];
  readonly stays: Settings["stays"];
  /** Whether a payment platform takes money before arrival (links) and saves cards to hold a stay. */
  readonly collect: { readonly links: boolean; readonly cards: boolean };
  /** Whether this server can seal private arrival details (it has a secret key). */
  readonly can_seal: boolean;
}

export { localeOf, shareGuests };
