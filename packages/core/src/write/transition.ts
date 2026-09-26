import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { findSlots, slotOffered } from "../capabilities/availability";
import { audienceFor, businessFacts } from "../customer/audience";
import { copyFor, vars } from "../customer/copy";
import type { Audience } from "../customer/describe";
import { shortRef, whenText } from "../customer/format";
import { bookingRequestTerms, changeTerms, orderRequestTerms, promiseTerms, termsSha } from "../customer/offer";
import type { Db } from "../db";
import {
  type Item,
  type ItemType,
  type Money,
  type OfferPointer,
  type PayloadOf,
  payloadSchemas,
} from "../domain/types";
import { ulid } from "../ids";
import { resolveTransition, type Transition } from "../machine/machine";
import { outcomeOf } from "../machine/outcomes";
import { machines, noteInput } from "../machine/tables";
import { amendmentsLive, changesLeft, promisedDatesOf } from "../negotiation/changes";
import { type Breach, refundWithinLimit } from "../negotiation/limits";
import { insertOfferStatement, type OfferRow, offerRows, openOf, pointerOf } from "../negotiation/offers";
import { paidFor, refundDueOf, SEND_BACK_DAYS } from "../negotiation/refunds";
import { items, resources, services } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { hashJson, hashText } from "../util/canonical";
import {
  actorMeta,
  type Caller,
  holdsMoney,
  isCustomer,
  isOwnerAssistant,
  isPerson,
  nowOf,
  permissionKind,
} from "./caller";
import {
  diagnoseFailure,
  eventStatement,
  findIdempotent,
  hasActiveWebhook,
  idempotencyStatement,
  jobStatement,
  threadEntryStatement,
  webhookFanoutStatement,
} from "./common";
import { CHARGED_BACK_SQL, CORRECTED_SQL, correctionFacts, correctionUntil, deadCorrections } from "./corrections";
import { type FieldProblem, fromZod, WriteError } from "./errors";
import {
  draftStatements,
  judgeAccept,
  judgeOffer,
  namesOtherMoney,
  offeredTerms,
  pricingForItem,
  withBreach,
} from "./limits";
import { inRequestState, isAutomation, legacyRows, NEGOTIATES, planOffers, requestExpiry, sideOf } from "./offers";
import {
  assertBusinessPriced,
  heldForPrice,
  linePricing,
  orderPersonalised,
  type PricingFor,
  sameMoney,
} from "./pricing";
import {
  askedWithinRight,
  chargeBackExcused,
  earlierReturnsOf,
  openReturnOf,
  refundFor,
  refundStatements,
  withdrawalOf,
  withdrawalRefusal,
} from "./returns";
import {
  bucketsFor,
  claimStatements,
  holdsOf,
  planClaims,
  readClaims,
  releaseHoldStatement,
  releaseStatement,
  type SlotSpec,
} from "./slots";
import { defaultSubject, type ItemView, rowToItem, viewFor } from "./views";

export interface TransitionInput {
  readonly itemId: string;
  readonly event: string;
  readonly input?: unknown;
  readonly reason?: string;
  /** Optimistic lock from the caller's last read; the write also checks against the current row. */
  readonly expectedVersion?: number;
  /** For writes caused by another event (rules): keeps the chain and its depth. */
  readonly causation?: { readonly id: string; readonly depth: number } | undefined;
  /** Written in the same batch as the change: a link's `used_at` (the link acts once). Internal only. */
  readonly extraStatements?: readonly Statement[] | undefined;
  /** The inbound email's Message-ID, kept on the thread entry the note becomes. */
  readonly messageId?: string | undefined;
  /** Who wrote the note the customer gets, as the request said (`effectiveWrittenBy`): kept on its entry and the event. */
  readonly writtenBy?: "person" | "automation" | null | undefined;
  /**
   * What the idempotency key's request hash covers, when it is not this input: at a customer's door,
   * the request the customer sent, so a retry is recognised however the item has moved since.
   */
  readonly hashInput?: unknown;
  /**
   * What the event's `meta` also records, from the door that asked for it: the catalogue lines a
   * customer suggested a price of their own for (`priced`), counted against how often they may (ADR-018
   * §4). Internal only.
   */
  readonly meta?: { readonly priced?: readonly string[] } | undefined;
  /**
   * The owner sends a draft automation made (ADR-018 §4): its catalogue lines are priced for the
   * customer as they were for automation, with the notice beside a price the inbox chose for them, and no
   * limit is judged — the owner is the one sending it. Internal only.
   */
  readonly fromDraft?: boolean | undefined;
}

export interface TransitionResult {
  readonly view: ItemView;
  /** Created by this transition, e.g. the order an accepted quote turns into. */
  readonly linked?: ItemView | undefined;
  readonly replayed: boolean;
  /**
   * The customer's request, or the change they asked for, had lapsed when the business took it
   * (ADR-018 §1): late, never refused, it went back to them as our offer on the same terms, which
   * they accept (`propose`, `propose_change`).
   */
  readonly converted?: "request_lapsed" | "change_lapsed" | undefined;
  /**
   * What automation offered was outside the owner's limits (ADR-018 §4): it was kept as a draft for a
   * person, never sent, and the item marked for them. The limits it is outside, as codes.
   */
  readonly drafted?: { readonly id: string; readonly breaches: readonly Breach[] } | undefined;
  /**
   * A reply automation wrote was not sent (ADR-018 §4): it named money we have not offered, so it was
   * kept as an internal note for a person and the item marked for them. The limits it is outside.
   */
  readonly held?: { readonly breaches: readonly Breach[] } | undefined;
}

const MAX_ATTEMPTS = 3;

export async function transitionItem(db: Db, caller: Caller, input: TransitionInput): Promise<TransitionResult> {
  const idem = caller.idempotency;
  const { extraStatements: _extra, hashInput, meta: _meta, ...hashed } = input;
  const requestHash = idem
    ? await hashJson({ op: "transition", scope: idem.scope, input: hashInput ?? hashed })
    : undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attempt_(db, caller, input, requestHash);
    } catch (error) {
      const retryable =
        error instanceof WriteError && (error.code === "version_conflict" || error.code === "slot_taken");
      if (!retryable || attempt >= MAX_ATTEMPTS || input.expectedVersion !== undefined) throw error;
    }
  }
}

async function attempt_(
  db: Db,
  caller: Caller,
  input: TransitionInput,
  requestHash: string | undefined,
): Promise<TransitionResult> {
  const now = nowOf(caller);
  const idem = caller.idempotency;
  if (idem) {
    const hit = await findIdempotent(db, idem);
    if (hit) return replay(hit, requestHash);
  }

  const [row] = await db.orm.select().from(items).where(eq(items.id, input.itemId));
  if (!row) throw new WriteError("not_found", "no such item");
  const item = rowToItem(row);
  if (input.expectedVersion !== undefined && item.version !== input.expectedVersion) {
    throw new WriteError("version_conflict", "the item changed since you read it", {
      details: { currentVersion: item.version },
    });
  }
  if (isCustomer(caller)) await assertOwnership(caller, row.partyId, row.accessTokenHash);

  const settings = await readSettings(db);
  // The item's offers (ADR-018 §1); an item from before offers had a table gets the one it holds.
  const stored = NEGOTIATES.has(item.type) ? await offerRows(db, item.id) : [];
  const legacy = stored.length === 0 ? await legacyRows(db, item, row.requestExpiresAt, settings) : [];
  const rows: readonly OfferRow[] = legacy.length ? legacy : stored;
  // A request the business takes after it lapsed goes back to the customer as our offer on the same
  // terms (ADR-018 §1): late, never refused.
  const late =
    lateTake(item, row.requestExpiresAt, input, caller, now) ?? lateChange(item, openOf(rows), input, caller, now);
  // A paid contract's cancellation the business records, asked while the customer could withdraw: their
  // withdrawal (ADR-018 §7, §8), never late and never a refund left to our say.
  const instead = late ? null : await withdrawalInstead(db, item, input, settings, now);
  const eventName = late?.event ?? instead ?? input.event;
  const eventInput = late ? late.input : input.input;

  const machine = machines[item.type];
  const resolved = resolveTransition(machine, item.state, eventName, permissionKind(caller));
  if (!resolved.ok) {
    switch (resolved.error.code) {
      case "unknown_event":
        throw new WriteError("unknown_event", `${item.type} has no event "${eventName}"`, {
          details: { events: [...new Set(machine.transitions.map((t) => t.event))] },
        });
      case "wrong_state":
        throw new WriteError("wrong_state", `"${eventName}" is not possible while the ${item.type} is ${item.state}`, {
          details: { state: item.state, allowedFrom: resolved.error.from },
        });
      case "not_allowed":
        throw new WriteError("not_allowed", `${permissionKind(caller)} may not "${eventName}" this ${item.type}`, {
          details: { allowedFor: resolved.error.by },
        });
    }
  }
  const t = resolved.transition;
  // A yes the customer gave a person is recorded by a person (ADR-018 N13): not the owner's AI, not a
  // rule, not a key handed to another system.
  if (t.byPerson && !isPerson(caller)) {
    // Refusing a return, disputing what came back, cancelling what a customer paid for: a person's
    // decision about money and a customer's rights (ADR-018 §3.4, §4), never automation's.
    if (
      t.event === "reject" ||
      t.event === "dispute_goods" ||
      t.event === "cancel" ||
      (item.type === "refund" && t.event === "record_cancel")
    ) {
      throw new WriteError(
        "not_allowed",
        `Only a person at the business can do this (${t.label}). Tell the owner in a note (reply with internal: true) what you would do.`,
        { details: { reason: "person_only", draft_for_owner: true } },
      );
    }
    const what = item.type === "order" ? "the changes we suggested" : "the time we proposed";
    throw new WriteError(
      "not_allowed",
      `Only a person can record that the customer agreed to ${what}. They can accept it from our email or their assistant; the owner can confirm it in the app.`,
      { details: { reason: "person_only" } },
    );
  }
  // A booking paid for is cancelled by a person, as a paid order is: what was paid is then owed back.
  if (
    item.type === "booking" &&
    t.event === "cancel_by_business" &&
    item.state === "confirmed" &&
    paidFor(item.payload) &&
    !isPerson(caller)
  ) {
    throw new WriteError(
      "not_allowed",
      `Only a person at the business can do this (${t.label}): it was paid for, so what was paid is owed back. Tell the owner in a note (reply with internal: true) what you would do.`,
      { details: { reason: "person_only", draft_for_owner: true } },
    );
  }
  // A rule never makes the promise on a price the business did not set (ADR-018 §3.2), and neither
  // does the owner's AI or another system's key without `money:write`: time yes, money no (23 September
  // 2026). They draft for the owner.
  const assistant = isOwnerAssistant(caller);
  const automation = isAutomation(caller);
  // Judged on what the caller asked for: a yes to a request that lapsed goes back to the customer as
  // our offer, on the customer's terms, so it is held exactly as the yes would have been.
  if (caller.actor.kind === "rule") await assertBusinessPriced(db, item, input.event);
  if (automation && caller.actor.kind !== "rule" && (await heldForPrice(db, item, input.event))) {
    throw new WriteError(
      "guard_failed",
      "The customer's request holds a price we did not set, so only the owner can confirm or accept it. Tell the owner in a note (reply with internal: true) what you would do.",
      { details: { guard: "business_priced", draft_for_owner: true } },
    );
  }
  if (isAutomation(caller)) {
    const open = openOf(rows);
    // What we proposed binds us until the customer answers or it lapses (ADR-018 §1, §2): the owner's
    // AI and rules never take it back, by withdrawing it, declining, cancelling or letting it expire.
    // Recording the customer's own no is theirs, whoever types it.
    const closes = t.offer === "withdraw" || (t.offer === "end" && !t.event.startsWith("record_cancel"));
    if (closes && open?.by === "business" && open.binding && (open.validThrough === null || open.validThrough > now)) {
      throw new WriteError(
        "guard_failed",
        "What we proposed binds us until the customer answers or it lapses, so only the owner may take it back. Tell the owner in a note (reply with internal: true) what you would do.",
        { details: { guard: "offer_binding", draft_for_owner: true } },
      );
    }
    // A customer's answer holding a line the catalogue does not price (a person priced it for them) is
    // the owner's to take: automation takes the catalogue's lines, at prices within the owner's limits
    // (ADR-018 §3.2, §4, Q2), judged below.
    if (
      item.type === "order" &&
      input.event === "accept" &&
      item.state !== "proposed" &&
      rows.some((r) => r.by === "business") &&
      (await unknownProductLine(db, (item.payload as PayloadOf<"order">).orderedItem)) !== -1
    ) {
      throw new WriteError(
        "guard_failed",
        "The customer's order holds a price that is not our catalogue's, so only the owner can accept it. Tell the owner in a note (reply with internal: true) what you would do.",
        { details: { guard: "business_priced", draft_for_owner: true } },
      );
    }
  }
  // Every transition takes an optional note; some take more.
  const parsedInput = (t.input ?? noteInput).safeParse(eventInput ?? {});
  if (!parsedInput.success) throw fromZod(parsedInput.error, "input");
  const data = parsedInput.data as Record<string, unknown>;
  // A customer's own price is their answer only while the owner takes price counters (ADR-018 Q1); the
  // door sends one only then, and passes it to a person otherwise.
  if (isCustomer(caller) && t.event === "counter" && !settings.negotiation.priceCounters) {
    const lines = (data.lines ?? []) as { unitPrice?: unknown }[];
    if (data.totalPrice !== undefined || lines.some((l) => l.unitPrice !== undefined)) {
      throw new WriteError("guard_failed", "we set our prices: a person will answer", {
        details: { guard: "price_counters" },
      });
    }
  }
  // Money that moved is recorded by the payment provider, the owner, or a system the owner gave
  // `money:write`: never the owner's AI (Q2), never another system's key without it (C9).
  if (assistant || !holdsMoney(caller)) assertNoMoney(t.event, data, assistant);
  // Changes to an order are made whole: one currency, a total worked out here, a validity to come.
  // Their prices, when automation sets them, are judged against the owner's limits below.
  if (item.type === "order" && t.event === "propose") proposeOrder(data, now);
  // What we send lasts until the date it gives, else `offerValidHours`; what automation sends lasts
  // at most that long, and says so, so the date the customer reads is the date it holds (ADR-018 §1).
  if ((item.type === "quote_request" && t.event === "quote") || (item.type === "order" && t.event === "propose")) {
    const most = now + settings.negotiation.offerValidHours * 3_600_000;
    const given = typeof data.validThrough === "string" ? Date.parse(data.validThrough) : Number.NaN;
    if (item.type === "quote_request" && data.validThrough === undefined)
      data.validThrough = new Date(most).toISOString();
    else if (isAutomation(caller) && given > most) data.validThrough = new Date(most).toISOString();
  }

  // A customer hears refusals and reads their item in the business's words and language.
  const audience = isCustomer(caller)
    ? await audienceFor(db, {
        locale: caller.locale,
        partyId: item.partyId,
        closedByCustomer: true,
        settings,
      })
    : undefined;
  const payload = structuredClone(item.payload) as Record<string, unknown>;
  applyInput(item.type, t.event, payload, data);
  applyReturnInput(item, t.event, payload, data, settings, now);
  const effects = new Set(t.effects ?? []);
  if (effects.has("apply_offer") && item.type === "order") applyOrderOffer(payload);
  if (effects.has("apply_counter") && item.type === "order") applyOrderCounter(payload, data);
  if (effects.has("apply_counter") && item.type === "quote_request") applyQuoteCounter(payload, data, now);
  if (effects.has("apply_proposal")) {
    const proposed = payload.proposed as { startTime: string; endTime: string; totalPrice?: unknown } | undefined;
    if (!proposed)
      throw new WriteError("guard_failed", "there is no proposed time to accept", {
        details: { guard: "proposal_present" },
      });
    payload.startTime = proposed.startTime;
    payload.endTime = proposed.endTime;
    if (proposed.totalPrice) {
      payload.totalPrice = proposed.totalPrice;
      // The notice goes with a price we chose for them, and no further than it.
      const personalised = (proposed as { personalised?: unknown }).personalised;
      if (personalised) payload.personalised = personalised;
      else delete payload.personalised;
    }
    delete payload.proposed;
  }
  if (effects.has("apply_counter") && item.type === "booking") {
    await applyCounter(db, payload, data, audience, now);
  }
  // A change to the promise: what one side asks for becomes the payload's `change`; accepted, it
  // becomes the promise; not made, it goes and the promise stays as it was.
  if (t.change && t.event === "propose_change") {
    await planChange(db, item, payload, data, sideOf(caller) ?? "business", audience, now);
  }
  if (effects.has("apply_change")) applyChange(item.type, payload);
  if (t.change && t.offer === "keep") delete payload.change;
  // What automation offers, as it would go to the customer, against the owner's limits (ADR-018 §4):
  // its catalogue lines at this customer's price on the way. Outside them it is a draft for a person,
  // written once the checks every offer passes have passed.
  let judged =
    (automation || input.fromDraft === true) && t.offer === "make" && sideOf(caller) === "business"
      ? await judgeOffer({
          db,
          item,
          rows,
          t,
          payload,
          data,
          settings,
          customerPriced: item.type === "booking" && (await heldForPrice(db, item, "confirm")),
        })
      : undefined;
  // A draft the owner sends is theirs to send: priced and marked as automation's was, judged by nobody.
  if (judged && !automation) judged = { ...judged, breaches: [] };
  // The words automation sends with it name only money we offer (ADR-018 §4; DL 7/2004 art. 32(1)): an
  // offer whose note names more is a draft for a person, and anything else is refused for one. A rule's
  // note is the owner's own words.
  const words =
    automation && caller.actor.kind !== "rule" && !t.internalNote && input.writtenBy !== "person"
      ? [data.note, data.notes, ...(judged?.words ?? [])]
          .filter((w): w is string => typeof w === "string" && w.trim() !== "")
          .join("\n")
      : "";
  if (
    words &&
    (await namesOtherMoney(
      db,
      item,
      rows,
      words,
      t.offer === "make" ? offeredTerms(item, t, payload) : t.offer === "take" ? payload : undefined,
    ))
  ) {
    if (judged) judged = { ...judged, breaches: withBreach(judged.breaches, "amount_named") };
    else {
      throw new WriteError(
        "outside_limits",
        "Your note names an amount of money we have not offered, so a person decides. Leave amounts out of the note, or tell the owner in a note (reply with internal: true) what you would do.",
        { details: { breaches: ["amount_named"], draft_for_owner: true } },
      );
    }
  }
  /** The places a time we propose holds for the customer until they answer (`booking.holdOnPropose`). */
  let hold: { resourceKey: string; claims: [number, number][] } | undefined;
  if (item.type === "booking" && t.event === "propose_change" && sideOf(caller) === "business") {
    hold = await holdForChange(db, item, payload, row.agentThumbprint, settings);
  }
  // A time we propose is one the customer can say yes to: it ends after it starts, and is no longer
  // than one booking can hold. Otherwise their yes would be refused, in words that are not ours.
  if (item.type === "booking" && t.event === "propose") {
    const p = payload.proposed as { startTime: string; endTime: string };
    const spec = await slotSpecFor(db, payload);
    let buckets: number[];
    try {
      buckets = bucketsFor(spec, p.startTime, p.endTime);
    } catch (error) {
      if (!(error instanceof WriteError) || error.code !== "invalid_input") throw error;
      const message = /after/.test(error.message) ? "must be after startTime" : error.message;
      throw new WriteError("invalid_input", `The time is not one we can book: input.endTime ${message}`, {
        fields: [{ path: "input.endTime", problem: "invalid", message }],
      });
    }
    // …and one that is free as we propose it (ADR-018 N7): nothing is held, so it may still go before
    // they answer, but never before we ask.
    const plan = planClaims(spec, buckets, await readClaims(db, spec.resourceKey, buckets, item.id));
    if (!plan.ok) {
      throw new WriteError("slot_taken", "that time is fully booked", {
        details: { guard: "slot_available", bucket: plan.fullBucket, capacity: spec.capacity },
      });
    }
    // Held while the customer answers, when the owner holds times and this customer holds fewer than
    // `booking.maxHolds` already: nobody parks places by asking (ADR-018 §3.1).
    if (
      settings.booking.holdOnPropose &&
      (await holdsOf(db, { itemId: item.id, partyId: item.partyId, agent: row.agentThumbprint })) <
        settings.booking.maxHolds
    ) {
      hold = { resourceKey: spec.resourceKey, claims: plan.claims };
    }
  }

  /** When the customer told us: now, or, for a withdrawal the business records, when they said it. */
  let noticeAt = now;
  // Guards read, never write; what they read is prefetched here.
  let claimPlan: { resourceKey: string; claims: [number, number][] } | undefined;
  /** The booking an accepted quote becomes: its time, and the places it claims. */
  let linkedBooking: LinkedBooking | undefined;
  for (const guard of t.guards ?? []) {
    switch (guard) {
      case "customer_owns_item":
        break; // asserted above for every customer write
      case "not_too_soon": {
        const start = await bookedStart(db, item, t.event, payload);
        if (start === null) break;
        // The minimum notice binds everyone but a person at the business, who may still book a
        // customer standing in front of them; a time that has started binds everyone. A time we
        // propose is an offer the customer answers, and inside the notice they could not: it binds
        // a person too.
        const minutes = settings.booking.minNoticeMin;
        const offers = t.event === "propose" || t.event === "propose_change";
        const notice = isPerson(caller) && !offers ? 0 : minutes * 60_000;
        if (start <= now || start - now < notice) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).problems.notTooSoon
              : start <= now
                ? "that time has already started or passed; pick a later time"
                : offers
                  ? `that time is inside your minimum notice of ${minutes} minutes, so the customer could not accept it; propose a later time`
                  : `that time is inside your minimum notice of ${minutes} minutes; only a person at the business can book it now`,
            { details: { guard, startTime: new Date(start).toISOString(), minNoticeMin: minutes } },
          );
        }
        break;
      }
      case "offer_open": {
        const open = openOf(rows);
        const a = audience ?? (await audienceFor(db, { partyId: item.partyId }));
        if (open?.by !== "business") {
          throw new WriteError("no_offer", copyFor(a.lang).problems.noOffer, { details: { guard } });
        }
        // Checked here, in the write that accepts it: the sweep that closes it may not have run yet.
        if (open.validThrough !== null && now > open.validThrough) {
          const until = new Date(open.validThrough).toISOString();
          const words = copyFor(a.lang).problems;
          const say = vars({
            validThrough: whenText(until, a.timezone, a.lang),
            deadline: whenText(until, a.timezone, a.lang),
          });
          throw new WriteError(
            "offer_expired",
            item.type === "quote_request"
              ? words.offerExpired(say)
              : item.type === "order"
                ? words.changesLapsed(say)
                : words.timeLapsed(say),
            { details: { guard, validThrough: until } },
          );
        }
        break;
      }
      case "request_lapsed": {
        if (row.requestExpiresAt === null || row.requestExpiresAt > now) {
          throw new WriteError("guard_failed", "the request has not lapsed yet", {
            details: {
              guard,
              requestExpiresAt: row.requestExpiresAt === null ? null : new Date(row.requestExpiresAt).toISOString(),
            },
          });
        }
        break;
      }
      case "offer_lapsed": {
        const open = openOf(rows);
        if (open?.by !== "business" || open.validThrough === null || open.validThrough > now) {
          throw new WriteError("guard_failed", "what we proposed has not lapsed yet", {
            details: {
              guard,
              validThrough: open?.validThrough ? new Date(open.validThrough).toISOString() : null,
            },
          });
        }
        break;
      }
      case "offer_non_binding": {
        const open = openOf(rows);
        if (open?.by !== "business" || open.binding) {
          throw new WriteError(
            "guard_failed",
            "what we proposed binds us until the customer answers or it lapses, so it cannot be withdrawn: propose something else, or wait for their answer",
            { details: { guard } },
          );
        }
        break;
      }
      case "quote_complete":
        await completeQuote(db, payload, now, settings.booking.minNoticeMin);
        break;
      case "change_open":
      case "change_theirs":
      case "change_mine":
      case "change_lapsed": {
        const open = openOf(rows);
        const side = sideOf(caller);
        const words = audience ? copyFor(audience.lang).problems : undefined;
        if (guard === "change_lapsed") {
          if (open?.kind !== "change" || open.validThrough === null || open.validThrough > now) {
            throw new WriteError("guard_failed", "the change has not lapsed yet", { details: { guard } });
          }
          break;
        }
        const mine = guard === "change_mine";
        // Our own change, accepted by us: the customer said yes to a person, and only a person records it.
        const heard = guard === "change_open" && side === "business" && open?.kind === "change" && open.by === side;
        if (heard && !isPerson(caller)) {
          throw new WriteError(
            "not_allowed",
            "Only a person can record that the customer agreed to the change we asked for. They can accept it from our email or their assistant; the owner can record it in the app.",
            { details: { reason: "person_only" } },
          );
        }
        if (open?.kind !== "change" || (!heard && (mine ? open.by !== side : open.by === side))) {
          throw new WriteError(
            "no_offer",
            words
              ? mine
                ? words.nothingToAnswer
                : words.noChange
              : mine
                ? "there is no change of yours open on this item"
                : "there is no change from the customer to answer on this item",
            { details: { guard } },
          );
        }
        // Checked here, in the write that accepts it: the sweep that closes it may not have run yet.
        if (guard === "change_open" && open.validThrough !== null && now > open.validThrough) {
          const until = new Date(open.validThrough).toISOString();
          const a = audience ?? (await audienceFor(db, { partyId: item.partyId, settings }));
          throw new WriteError(
            "offer_expired",
            words
              ? words.changeLapsed(vars({ deadline: whenText(until, a.timezone, a.lang) }))
              : `the change could be accepted until ${until}; ask for it again if it still suits you`,
            { details: { guard, validThrough: until } },
          );
        }
        // …and so is the total: payment asked for or made since the change was asked for fixes it,
        // whoever accepts the change (ADR-018 §3.2). More is a second order, less a refund.
        if (
          guard === "change_open" &&
          item.type === "order" &&
          item.payload.change &&
          totalFixed(item) &&
          !sameMoney(item.payload.change.totalPrice, item.payload.totalPrice)
        ) {
          throw totalFixedError(words);
        }
        break;
      }
      case "changes_left": {
        const current = promiseTerms(item);
        const next = changeTerms({ ...item, payload } as Item);
        if (!current || !next) break;
        const left = changesLeft(item.type, rows, current, next, settings, now, await promisedDatesOf(db, item.id));
        if (!left.ok) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).problems.changesExhausted
              : left.why === "count"
                ? `this ${item.type} has had the ${Math.min(settings.negotiation.changes.maxPerItem, 3)} changes it may have; to change it again, record the customer's cancellation (if they asked) and take a new ${item.type}`
                : `a change may move a ${item.type} at most 90 days from what was first agreed; for more, record the customer's cancellation (if they asked) and take a new ${item.type}`,
            { details: { guard, reason: left.why } },
          );
        }
        break;
      }
      case "amendments_live": {
        if (!(await amendmentsLive(db, settings, item))) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).problems.changeByPerson
              : `A network you report to holds this ${item.type}'s promise under rules that do not take changes yet, so a change cannot be recorded. If the customer asked for it, record their cancellation (Customer cancelled) and take a new ${item.type}; otherwise keep it as it is.`,
            { details: { guard } },
          );
        }
        break;
      }
      case "promise_ahead": {
        if (item.type === "booking" && Date.parse(item.payload.startTime) <= now) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).problems.pastStart
              : "the booking has started, so it can no longer change",
            { details: { guard } },
          );
        }
        break;
      }
      case "change_allowed":
        await changeAllowed(db, item, t.event, caller, settings, now);
        break;
      case "asked_within_window":
      case "asked_outside_window": {
        if (item.type !== "booking") break;
        // A time typed to the minute may fall just before the booking was made: that is when it was made.
        const created = Date.parse(item.createdAt);
        const typed = typeof data.askedAt === "string" ? Date.parse(data.askedAt) : now;
        if (typed > now + 60_000 || typed < created - 60_000) {
          throw new WriteError(
            "invalid_input",
            "when the customer asked must be after the booking was made and not in the future",
            {
              fields: [
                { path: "input.askedAt", problem: "invalid", message: "between the booking's creation and now" },
              ],
            },
          );
        }
        const askedAt = Math.max(typed, created);
        const windowMs = settings.booking.cancellationWindowMin * 60_000;
        const inWindow = Date.parse(item.payload.startTime) - askedAt >= windowMs;
        const records = settings.booking.lateCancellation === "record";
        // Judged as the customer's own door would have judged it when they asked (ADR-017 §3.1): a
        // late one counts as late only where the owner records late cancellations.
        if (guard === "asked_within_window" ? !inWindow && records : inWindow || !records) {
          throw new WriteError(
            "guard_failed",
            guard === "asked_within_window"
              ? `the customer asked less than ${settings.booking.cancellationWindowMin} minutes before the start: record it as a late cancellation`
              : "the customer asked in time: record it as a cancellation",
            {
              details: {
                guard,
                cancellationWindowMin: settings.booking.cancellationWindowMin,
                lateCancellation: settings.booking.lateCancellation,
              },
            },
          );
        }
        break;
      }
      case "proposal_present":
        if (!item.payload || !("proposed" in item.payload) || !item.payload.proposed) {
          throw new WriteError("guard_failed", "there is no proposed time to accept", { details: { guard } });
        }
        break;
      case "has_quote":
        if (!(item.payload as { quote?: unknown }).quote)
          throw new WriteError("guard_failed", "we have not sent a quote yet", { details: { guard } });
        break;
      case "within_cancellation_window": {
        if (item.type === "booking" && item.state === "confirmed") {
          const start = Date.parse(item.payload.startTime);
          const windowMs = settings.booking.cancellationWindowMin * 60_000;
          if (start - now < windowMs) {
            throw new WriteError(
              "guard_failed",
              `confirmed bookings can be cancelled up to ${settings.booking.cancellationWindowMin} minutes before the start`,
              {
                details: {
                  guard,
                  cancellationWindowMin: settings.booking.cancellationWindowMin,
                  lateCancellation: settings.booking.lateCancellation,
                },
              },
            );
          }
        }
        break;
      }
      case "outside_cancellation_window": {
        // The door fires this once `cancel` found the window closed (ADR-017 §3.1): recorded as a
        // late cancellation where the owner chose to record them, refused where they did not.
        if (item.type !== "booking") break;
        const windowMs = settings.booking.cancellationWindowMin * 60_000;
        if (Date.parse(item.payload.startTime) - now >= windowMs) {
          throw new WriteError("guard_failed", "the cancellation window is still open; cancel as usual", {
            details: { guard, cancellationWindowMin: settings.booking.cancellationWindowMin },
          });
        }
        if (settings.booking.lateCancellation !== "record") {
          throw new WriteError(
            "guard_failed",
            `confirmed bookings can be cancelled up to ${settings.booking.cancellationWindowMin} minutes before the start; after that, please contact us`,
            { details: { guard, lateCancellation: settings.booking.lateCancellation } },
          );
        }
        break;
      }
      case "within_correction_window": {
        if (item.type !== "booking") break;
        // Made before outcomes were recorded, it has none to correct: closed by hand, it stays so.
        if (row.legacyPromise === 1) {
          throw new WriteError(
            "guard_failed",
            "this booking was made before outcomes were recorded, so it has no outcome to correct",
            { details: { guard, legacy: true } },
          );
        }
        const hours = settings.booking.autoCompleteHours;
        const until = correctionUntil(item.payload.endTime, settings);
        if (now > until) {
          throw new WriteError(
            "guard_failed",
            `a booking's outcome can be corrected until ${hours} hours after it ended`,
            { details: { guard, autoCompleteHours: hours, until: new Date(until).toISOString() } },
          );
        }
        if (await hasEvent(db, item.id, CORRECTED_SQL)) {
          throw new WriteError("guard_failed", "this booking's outcome was corrected already", { details: { guard } });
        }
        break;
      }
      case "payment_overdue": {
        const requested = await lastEventAt(db, item.id, "request_payment");
        const due = requested === null ? null : requested + settings.orders.payDays * 86_400_000;
        if (due === null || now < due) {
          throw new WriteError("guard_failed", `payment was requested less than ${settings.orders.payDays} days ago`, {
            details: { guard, payDays: settings.orders.payDays },
          });
        }
        if (await hasEvent(db, item.id, "event = 'lapse'")) {
          throw new WriteError("guard_failed", "this order has lapsed already", { details: { guard } });
        }
        break;
      }
      case "not_charged_back": {
        if (await hasEvent(db, item.id, CHARGED_BACK_SQL)) {
          throw new WriteError("guard_failed", "a charge-back is recorded on this order already", {
            details: { guard },
          });
        }
        break;
      }
      case "withdrawal_open": {
        noticeAt = await noticeOf(db, item, t, data, caller, now);
        const right = await withdrawalOf(db, item, settings, noticeAt);
        if (!right.available) {
          throw new WriteError("guard_failed", withdrawalRefusal(right, item.type, audience), {
            details: {
              guard,
              why: right.why,
              ...(right.until !== null ? { until: new Date(right.until).toISOString() } : {}),
              ...(right.exception ? { exception: right.exception } : {}),
            },
          });
        }
        break;
      }
      case "not_withdrawal": {
        if (item.type === "refund" && item.payload.kind === "withdrawal") {
          throw new WriteError(
            "guard_failed",
            "A withdrawal within the legal period cannot be refused: refund it, once the goods are back when they have to come back. If what came back is not what you sold, record that (dispute_goods).",
            { details: { guard } },
          );
        }
        // Asked while they could still withdraw: whatever reason they gave, the goods may come back.
        if (item.type === "refund" && (await askedWithinRight(db, item, settings))) {
          throw new WriteError(
            "guard_failed",
            "The customer asked while they could still withdraw from the contract, so the goods may come back whatever the reason: agree the return and refund once they are back. If it is not faulty, a person settles the return postage with them as the policy says; if what came back is not what you sold, record that (dispute_goods).",
            { details: { guard, kind: item.payload.kind ?? null } },
          );
        }
        break;
      }
      case "refund_amount":
        await refundAmount(db, item, data);
        break;
      case "return_allowed":
        await returnAllowed(db, item, data, caller, settings, now);
        break;
      case "goods_expected": {
        if (item.type === "refund" && item.payload.goodsBack !== true) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).returns.problems.nothingToKeep
              : "Nothing has to come back on this refund: it is money owed as it is, by its date. A person records it if the customer waives it.",
            { details: { guard } },
          );
        }
        break;
      }
      case "no_open_return": {
        const open = await openReturnOf(db, item.id);
        if (open) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).returns.problems.returnOpen(vars({ ref: shortRef(open.id) }))
              : `a return of this ${item.type} is open already (${open.id}): deal with it there`,
            { details: { guard, refund: open.id } },
          );
        }
        break;
      }
      case "slot_available": {
        if (item.type === "quote_request") {
          linkedBooking = await linkedBookingOf(db, payload);
          if (!linkedBooking) break;
          const spec = await slotSpecFor(db, linkedBooking.payload);
          const buckets = bucketsFor(spec, linkedBooking.startTime, linkedBooking.endTime);
          const plan = planClaims(spec, buckets, await readClaims(db, spec.resourceKey, buckets, ""));
          if (!plan.ok) {
            throw new WriteError(
              "slot_taken",
              audience ? copyFor(audience.lang).problems.slotTaken : "that time is fully booked",
              {
                details: { guard, bucket: plan.fullBucket, capacity: spec.capacity },
              },
            );
          }
          linkedBooking = { ...linkedBooking, claims: { resourceKey: spec.resourceKey, claims: plan.claims } };
          break;
        }
        if (item.type !== "booking") break;
        const spec = await slotSpecFor(db, payload);
        const buckets = bucketsFor(spec, String(payload.startTime), String(payload.endTime));
        const taken = await readClaims(db, spec.resourceKey, buckets, item.id);
        const plan = planClaims(spec, buckets, taken);
        if (!plan.ok) {
          throw new WriteError(
            "slot_taken",
            audience ? copyFor(audience.lang).problems.slotTaken : "that time is fully booked",
            {
              details: { guard, bucket: plan.fullBucket, capacity: spec.capacity },
            },
          );
        }
        claimPlan = { resourceKey: spec.resourceKey, claims: plan.claims };
        break;
      }
    }
  }

  // Outside the owner's limits, what automation offered is kept for a person: never sent, never refused.
  if (judged && judged.breaches.length > 0) {
    const plan = await draftStatements({
      db,
      caller,
      item,
      t,
      input: data,
      terms: offeredTerms(item, t, payload),
      breaches: judged.breaches,
      now,
      idem,
      requestHash,
      causation: input.causation,
      viewOf: (u) => viewFor(u, permissionKind(caller), undefined, undefined, audience),
    });
    try {
      await db.batch(plan.statements);
    } catch (error) {
      const hit = await diagnoseFailure(db, error, {
        idem,
        requestHash,
        itemId: item.id,
        expectedVersion: item.version,
      });
      return replay(hit, requestHash);
    }
    return { view: plan.view, replayed: false, drafted: plan.drafted };
  }
  // What automation takes of the customer's request: a price of theirs at or above the owner's floor,
  // an order within the value the owner accepts in person (ADR-018 §4). Refused otherwise, for a person.
  if (
    automation &&
    ((item.type === "booking" && t.event === "confirm") ||
      (item.type === "order" && t.event === "accept" && item.state !== "proposed"))
  ) {
    const breaches = await judgeAccept({ db, item, rows, payload, settings });
    if (breaches.length > 0) {
      throw new WriteError(
        "outside_limits",
        "This is outside the limits the owner set for you, so a person decides. Tell the owner in a note (reply with internal: true) what you would do; tell the customer only that a person will reply.",
        { details: { breaches, draft_for_owner: true } },
      );
    }
  }
  const seq = item.version + 1;
  const eventId = ulid();
  // The request's clock (ADR-018 §1): wound again whenever it goes back to the business, or we ask
  // the customer something. One without a clock — a request from before this clock existed, or one
  // the business wrote down itself (the owner, a shop's system) — gets one only once the customer
  // next acts: our own question never closes an order a shop already took.
  const requestExpiresAt =
    NEGOTIATES.has(item.type) && inRequestState(t.to) && (row.requestExpiresAt !== null || isCustomer(caller))
      ? requestExpiry(item.type, payload, settings, now)
      : undefined;
  const offerPlan = await planOffers({
    db,
    item,
    rows,
    t,
    caller,
    payload,
    data,
    settings,
    now,
    eventId,
    requestExpiresAt: requestExpiresAt ?? null,
    held: hold !== undefined,
    audience,
  });
  if (offerPlan.pointer === null) delete payload.offer;
  else if (offerPlan.pointer) payload.offer = offerPlan.pointer;
  if (offerPlan.endedChange) delete payload.change;
  // The customer's request, still open while its clock is wound again (we asked them something, or
  // they answered): its offer lapses when the item's clock says, and says so, to the owner's systems too.
  const waiting = openOf(rows);
  const rewound =
    requestExpiresAt !== undefined && offerPlan.pointer === undefined && waiting?.by === "customer"
      ? { ...waiting, validThrough: requestExpiresAt, updatedAt: now }
      : undefined;
  if (rewound) payload.offer = pointerOf(rewound);
  const closedAt = effects.has("close") ? now : row.closedAt;
  const updated: Item = {
    ...item,
    state: t.to,
    version: seq,
    payload,
    updatedAt: new Date(now).toISOString(),
    closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
  } as Item;

  const statements: Statement[] = [];
  let linkedView: ItemView | undefined;
  let linkedId: string | null = row.linkedItemId;
  /** The order or booking an accepted quote became is its own event; developers subscribe to it. */
  let linkedEvent: { id: string; type: string; itemId: string } | undefined;

  if (effects.has("link_item") && item.type === "quote_request") {
    const linked = await planLinkedItem(
      db,
      caller,
      item,
      payload,
      eventId,
      now,
      linkedBooking,
      audience,
      offerPlan.taken,
    );
    linkedId = linked.id;
    statements.push(...linked.statements);
    linkedView = linked.view;
    linkedEvent = { id: linked.eventId, type: `${linked.type}.create`, itemId: linked.id };
  }
  // The return or refund this makes, in the same batch, as the order's or booking's customer's.
  const refundMade: Statement[] = [];
  if (effects.has("link_refund")) {
    // A return the business writes down is judged when the customer asked for it, as a withdrawal is.
    if (t.event === "open_return") noticeAt = await noticeOf(db, item, t, data, caller, now);
    const plan = await refundFor({ db, item, t, data, settings, now, noticeAt, audience });
    if (plan) {
      const made = refundStatements({
        caller,
        item,
        plan,
        causationId: eventId,
        now,
        webhooks: await hasActiveWebhook(db),
      });
      refundMade.push(...made.statements);
      // Owed at once, with nothing to come back: its date is fixed as it is made, and so is its promise.
      if (typeof plan.payload.refundDue === "string") {
        refundMade.push(
          jobStatement("issue_receipt", { itemId: made.id, kind: "accepted", eventId: made.eventId }, now, {
            dedupeKey: `receipt:${made.id}:accepted`,
          }),
        );
      }
      const refundItem = {
        id: made.id,
        type: "refund",
        state: plan.state,
        version: 1,
        partyId: item.partyId,
        locationId: item.locationId,
        channel: caller.actor.channel,
        subject: item.subject ?? "Refund request",
        flags: { ...item.flags, needsHuman: plan.state === "requested" },
        linkedItemId: item.id,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        closedAt: null,
        payload: payloadSchemas.refund.parse(plan.payload),
      } as Item;
      linkedView ??= viewFor(refundItem, permissionKind(caller), undefined, undefined, audience);
    }
  }
  updated.linkedItemId = linkedId;
  // The corrections the item is left with: what its history said before this, and this.
  const facts = (await correctionFacts(db, [{ ...row, state: t.to }])).get(item.id);
  const hidden = facts
    ? deadCorrections(
        updated,
        {
          legacy: facts.legacy,
          corrected: facts.corrected || (t.amends === true && item.type === "booking"),
          chargedBack: facts.chargedBack || t.event === "charge_back" || t.event === "record_charge_back",
        },
        settings,
        now,
      )
    : undefined;
  const view = viewFor(updated, permissionKind(caller), undefined, hidden, audience);
  const response = { view, linked: linkedView };

  if (idem && requestHash) statements.unshift(idempotencyStatement(idem, requestHash, 200, response, item.id, now));
  statements.push(
    eventStatement({
      id: eventId,
      itemId: item.id,
      seq,
      event: t.event,
      fromState: item.state,
      toState: t.to,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: input.reason ?? null,
      diff: { state: [item.state, t.to], payload: changedKeys(item.payload as Record<string, unknown>, payload) },
      meta: {
        channel: caller.actor.channel,
        tier: caller.tier,
        input: data,
        ...actorMeta(caller),
        ...(input.writtenBy ? { written_by: input.writtenBy } : {}),
        ...(input.meta?.priced?.length ? { priced: [...input.meta.priced] } : {}),
      },
      causationId: input.causation?.id ?? null,
      depth: input.causation?.depth ?? 0,
      now,
    }),
  );
  statements.push(
    requestExpiresAt === undefined
      ? {
          sql: "UPDATE items SET state = ?, version = ?, payload = ?, linked_item_id = ?, updated_at = ?, closed_at = ? WHERE id = ? AND version = ?",
          params: [t.to, seq, JSON.stringify(payload), linkedId, now, closedAt, item.id, item.version],
          method: "run",
        }
      : {
          sql: "UPDATE items SET state = ?, version = ?, payload = ?, linked_item_id = ?, updated_at = ?, closed_at = ?, request_expires_at = ? WHERE id = ? AND version = ?",
          params: [
            t.to,
            seq,
            JSON.stringify(payload),
            linkedId,
            now,
            closedAt,
            requestExpiresAt,
            item.id,
            item.version,
          ],
          method: "run",
        },
  );
  // The offers: a legacy item's own first (the same row from every writer), then what this verb closes
  // and opens, closes first — one open offer per item at any moment.
  for (const r of legacy) statements.push(insertOfferStatement(r, { orIgnore: true }));
  statements.push(...offerPlan.statements);
  if (rewound) {
    statements.push({
      sql: "UPDATE item_offers SET valid_through = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      params: [rewound.validThrough, now, rewound.id],
      method: "run",
    });
  }
  statements.push(...refundMade);
  if (effects.has("release_slot")) statements.push(releaseStatement(item.id));
  if (effects.has("release_hold")) statements.push(releaseHoldStatement(item.id));
  if (hold && offerPlan.made) {
    // A time proposed again moves its hold: the old one goes, the new one is held for the new offer.
    statements.push(releaseHoldStatement(item.id));
    statements.push(...claimStatements(hold.resourceKey, item.id, hold.claims, offerPlan.made.id));
  } else if (item.type === "booking" && (t.event === "propose" || t.event === "propose_change")) {
    statements.push(releaseHoldStatement(item.id));
  }
  // A change that was open when the promise ended another way lets go of its time too.
  if (offerPlan.endedChange) statements.push(releaseHoldStatement(item.id));
  if (effects.has("claim_slot") && claimPlan) {
    statements.push(releaseStatement(item.id));
    statements.push(...claimStatements(claimPlan.resourceKey, item.id, claimPlan.claims));
  }
  const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
  /** A person records the customer's yes to our own change: how they agreed is the business's own record. */
  const yesHeard = t.event === "accept_change" && !isCustomer(caller) && openOf(rows)?.by === "business";
  if (note) {
    statements.push(
      threadEntryStatement({
        id: ulid(),
        itemId: item.id,
        // What the customer said when they cancelled, how they agreed: the business's own record,
        // never sent to the customer as the business's words.
        direction: isCustomer(caller) ? "in" : t.internalNote || yesHeard ? "note" : "out",
        channel: caller.actor.channel,
        actorKind: caller.actor.kind,
        actorId: caller.actor.id,
        partyId: isCustomer(caller) ? item.partyId : null,
        body: note,
        messageId: input.messageId ?? null,
        writtenBy: input.writtenBy ?? null,
        now,
      }),
    );
  }
  /** A refund's date, once fixed (Unix ms): its promise is made then (ADR-018 §8), and its outcome reads it. */
  const refundDueAt = (p: Record<string, unknown>): number | null => {
    const due = typeof p.refundDue === "string" ? Date.parse(p.refundDue) : Number.NaN;
    return Number.isFinite(due) ? due : null;
  };
  for (const effect of effects) {
    if (
      effect === "issue_receipt:confirmed" ||
      effect === "issue_receipt:paid" ||
      effect === "issue_receipt:accepted"
    ) {
      // A refund promises only once the date it must be paid by is fixed: an approval with goods still
      // to come back makes none yet.
      if (item.type === "refund" && refundDueAt(payload) === null) continue;
      const kind = effect.slice("issue_receipt:".length);
      statements.push(
        jobStatement("issue_receipt", { itemId: item.id, kind, eventId }, now, {
          dedupeKey: `receipt:${item.id}:${kind}`,
        }),
      );
    } else if (effect === "issue_receipt:amended") {
      // A change both sides agreed (rules version 6): its own receipt, one per change, naming the terms.
      const taken = offerPlan.taken;
      if (taken?.kind === "change" && row.legacyPromise !== 1) {
        statements.push(
          jobStatement("issue_receipt", { itemId: item.id, kind: "amended", offerId: taken.id, eventId }, now, {
            dedupeKey: `receipt:${item.id}:amended:${taken.id}`,
          }),
        );
      }
    } else if (effect === "issue_receipt:outcome") {
      // One pure function names the outcome (ADR-017 §3.1); the machines and it are checked
      // against each other over every path, so a transition with this effect always has one. A
      // promise made before outcomes were recorded closes without one (R18): its owner closes it.
      // A charge-back while a return is open, or after a refund we paid late, is the customer taking
      // their money back the only way we left them: it records nothing against them (ADR-018 §8).
      const excused =
        item.type === "order" &&
        (t.event === "charge_back" || t.event === "record_charge_back") &&
        (await chargeBackExcused(db, item.id));
      const ctx = item.type === "refund" ? { due: refundDueAt(item.payload as Record<string, unknown>), now } : {};
      const outcome =
        row.legacyPromise === 1 || excused
          ? null
          : outcomeOf(item.type, t.event, item.state, permissionKind(caller), ctx);
      if (outcome) {
        statements.push(
          jobStatement(
            "issue_receipt",
            { itemId: item.id, kind: "outcome", outcome: outcome.code, aut: outcome.aut ?? 0, eventId },
            now,
            { dedupeKey: `receipt:${item.id}:outcome:${outcome.code}` },
          ),
        );
      }
    } else if (effect === "review_fact") {
      statements.push(
        jobStatement("review_fact", { itemId: item.id, event: t.event, eventId }, now, {
          dedupeKey: `review_fact:${eventId}`,
        }),
      );
    } else if (effect === "notify_customer" || effect === "notify_owner") {
      const to = effect === "notify_customer" ? "customer" : "owner";
      statements.push(
        jobStatement("notify", { to, itemId: item.id, event: t.event, eventId }, now, {
          dedupeKey: `notify:${eventId}:${to}`,
        }),
      );
    }
  }
  statements.push(
    jobStatement("rules", { itemId: item.id, eventId, trigger: `item.transitioned:${t.event}` }, now, {
      dedupeKey: `rules:${eventId}`,
    }),
  );
  if (await hasActiveWebhook(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${item.type}.${t.event}`, itemId: item.id }, now));
    if (linkedEvent) statements.push(webhookFanoutStatement(linkedEvent, now));
  }
  if (input.extraStatements) statements.push(...input.extraStatements);

  try {
    await db.batch(statements);
  } catch (error) {
    const hit = await diagnoseFailure(db, error, {
      idem,
      requestHash,
      itemId: item.id,
      expectedVersion: item.version,
      claims: claimPlan ?? linkedBooking?.claims ?? hold,
    });
    return replay(hit, requestHash);
  }
  return { view, linked: linkedView, replayed: false, ...(late ? { converted: late.converted } : {}) };
}

/** Whether the item has an event matching `where` (a fixed SQL condition on `item_events`). */
async function hasEvent(db: Db, itemId: string, where: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM item_events WHERE item_id = ? AND ${where} LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/** When the item last had `event`, or null. */
async function lastEventAt(db: Db, itemId: string, event: string): Promise<number | null> {
  const { rows } = await db.client.query({
    sql: "SELECT MAX(created_at) FROM item_events WHERE item_id = ? AND event = ?",
    params: [itemId, event],
    method: "all",
  });
  const at = rows[0]?.[0];
  return at === null || at === undefined ? null : Number(at);
}

async function assertOwnership(caller: Caller, partyId: string, accessTokenHash: string | null): Promise<void> {
  if (caller.actor.partyId && caller.actor.partyId === partyId) return;
  if (caller.accessToken && accessTokenHash && (await hashText(caller.accessToken)) === accessTokenHash) return;
  throw new WriteError("not_allowed", "this item belongs to someone else");
}

function applyInput(
  type: ItemType,
  event: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  if (type === "booking" && event === "propose")
    payload.proposed = { startTime: data.startTime, endTime: data.endTime, totalPrice: data.totalPrice };
  // A question instead of waiting for the answer withdraws the time we proposed: it can no longer be
  // accepted, and left in the payload it would read as booked (the event keeps what it was). So does
  // withdrawing it, and so for an order's changes and a quote.
  if ((type === "booking" || type === "order") && (event === "request_info" || event === "retract")) {
    delete payload.proposed;
  }
  if (type === "quote_request" && event === "retract") delete payload.quote;
  if (type === "order" && event === "propose") {
    payload.proposed = {
      orderedItem: data.orderedItem,
      totalPrice: data.totalPrice,
      ...(data.delivery ? { delivery: data.delivery } : payload.delivery ? { delivery: payload.delivery } : {}),
    };
  }
  if (type === "quote_request" && event === "quote") {
    // A new quote replaces the one before; its notes stay with it, and so does the time it is for.
    payload.quote = data;
  }
  if (type === "order" && event === "record_payment") {
    payload.paymentRef = data.paymentRef;
    if (data.amount) payload.paidAmount = data.amount;
  }
  if (type === "order" && event === "request_payment" && data.paymentUrl) payload.paymentUrl = data.paymentUrl;
}

/**
 * What a transition writes about money and goods beyond its input's own fields (ADR-018 §3.4, §7):
 * a booking's payment, when an order was sent and reached the customer, and a return's way through —
 * agreed with or without goods to send back, the goods back, disputed, refunded — with the date the
 * refund is due once nothing more has to come back.
 */
function applyReturnInput(
  item: Item,
  event: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  settings: Awaited<ReturnType<typeof readSettings>>,
  now: number,
): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A time the business gives for something that happened: not in the future, nor before the item was made. */
  const past = (value: unknown, path: string): number => {
    if (typeof value !== "string") return now;
    const at = Date.parse(value);
    if (!Number.isFinite(at) || at > now + 5 * 60_000 || at < Date.parse(item.createdAt) - 60_000) {
      throw new WriteError(
        "invalid_input",
        `${path} must be a time since the ${item.type} was made, and not in the future`,
        {
          fields: [{ path, problem: "invalid", message: "since it was made, not in the future" }],
        },
      );
    }
    return Math.min(at, now);
  };
  if (item.type === "booking" && event === "record_payment") {
    // A booking may be paid in parts (a deposit, then the rest): what was paid is their sum, all of it
    // owed back on withdrawal. The same payment told twice counts once; one that names no amount is
    // the whole price (`paidFor`).
    const before = item.payload.paidAmount;
    const told = item.payload.paymentRef;
    const amount = data.amount as Money | undefined;
    // The payment recorded last, told again (a provider's retry): nothing more was paid.
    if (told === data.paymentRef && (before !== undefined || amount === undefined)) return;
    payload.paymentRef = data.paymentRef;
    if (amount && told !== undefined && before && before.currency.toUpperCase() === amount.currency.toUpperCase()) {
      payload.paidAmount = { value: before.value + amount.value, currency: before.currency };
    } else if (amount) payload.paidAmount = amount;
    else if (told !== undefined) delete payload.paidAmount;
    return;
  }
  if (item.type === "order" && event === "fulfil") {
    payload.fulfilledAt = iso(now);
    if (data.deliveredAt !== undefined) payload.deliveredAt = iso(past(data.deliveredAt, "input.deliveredAt"));
    return;
  }
  if (item.type === "order" && event === "record_delivery") {
    payload.deliveredAt = iso(past(data.deliveredAt, "input.deliveredAt"));
    return;
  }
  if (item.type !== "refund") return;
  const r = item.payload;
  const kind = r.kind ?? "policy";
  const noticeAt = r.noticeAt ? Date.parse(r.noticeAt) : undefined;
  switch (event) {
    case "approve": {
      const goodsBack = (data.goodsBack as boolean | undefined) ?? r.goodsBack ?? false;
      payload.goodsBack = goodsBack;
      if (goodsBack) {
        const by = typeof data.returnBy === "string" ? Date.parse(data.returnBy) : now + SEND_BACK_DAYS * 86_400_000;
        if (!(by > now)) {
          throw new WriteError("invalid_input", "input.returnBy must be in the future", {
            fields: [{ path: "input.returnBy", problem: "invalid", message: "must be in the future" }],
          });
        }
        payload.returnBy = iso(by);
        if (data.instructions) payload.instructions = data.instructions;
      } else {
        delete payload.returnBy;
        const due = refundDueOf({ kind, noticeAt, settledAt: now, refundDays: settings.returns.refundDays });
        if (due !== null) payload.refundDue = iso(due);
      }
      return;
    }
    case "goods_back": {
      const at = past(data.receivedAt, "input.receivedAt");
      payload.evidenceAt = iso(at);
      const due = refundDueOf({ kind, noticeAt, evidenceAt: at, refundDays: settings.returns.refundDays });
      if (due !== null) payload.refundDue = iso(due);
      return;
    }
    case "dispute_goods":
      payload.disputed = { note: String(data.note).trim(), at: iso(now) };
      return;
    case "refund":
      payload.paymentRef = data.paymentRef;
      payload.paidAmount = (data.amount as Money | undefined) ?? r.amount;
      return;
  }
}

/**
 * When the customer withdrew: now, for their own door; for one the business records, when they said
 * it — the arrival of their message (`entryId`), else the moment typed, else now. The owner's AI and
 * a key must name the message: the thread alone is what proves they said it.
 */
async function noticeOf(
  db: Db,
  item: Item,
  t: Transition,
  data: Record<string, unknown>,
  caller: Caller,
  now: number,
): Promise<number> {
  if (t.event !== "record_withdrawal" && t.event !== "open_return") return now;
  if (typeof data.entryId === "string") {
    const { rows } = await db.client.query({
      sql: "SELECT created_at FROM thread_entries WHERE id = ? AND item_id = ? AND direction = 'in'",
      params: [data.entryId, item.id],
      method: "all",
    });
    const at = rows[0]?.[0];
    if (at === null || at === undefined) {
      throw new WriteError("invalid_input", "input.entryId must name a message the customer sent about this item", {
        fields: [{ path: "input.entryId", problem: "invalid", message: "a message from the customer on this item" }],
      });
    }
    return Number(at);
  }
  if (!isPerson(caller)) {
    // A return the owner's AI opens without naming the message is dated now, as it always was.
    if (t.event === "open_return") return now;
    throw new WriteError(
      "invalid_input",
      "Name the customer's message in which they withdrew (input.entryId, from get_item's thread): a withdrawal is dated by it. If they said it by phone, the owner records it.",
      { fields: [{ path: "input.entryId", problem: "missing", message: "the customer's message" }] },
    );
  }
  if (typeof data.askedAt !== "string") return now;
  const at = Date.parse(data.askedAt);
  const created = Date.parse(item.createdAt);
  if (!Number.isFinite(at) || at > now + 60_000 || at < created - 60_000) {
    throw new WriteError(
      "invalid_input",
      "when the customer told you must be after the item was made and not in the future",
      {
        fields: [{ path: "input.askedAt", problem: "invalid", message: "between the item's creation and now" }],
      },
    );
  }
  return Math.min(Math.max(at, created), now);
}

/**
 * A refund pays what is owed, or more up to what was paid: less needs the customer's agreement to a
 * settlement, which a person makes with them (ADR-018 §3.4). The amount left out is what is owed.
 */
async function refundAmount(db: Db, item: Item, data: Record<string, unknown>): Promise<void> {
  if (item.type !== "refund") return;
  const owed = item.payload.amount;
  const amount = (data.amount as Money | undefined) ?? owed;
  if (amount.currency.toUpperCase() !== owed.currency.toUpperCase()) {
    throw new WriteError("invalid_input", `input.amount.currency must be ${owed.currency}, the refund's`, {
      fields: [{ path: "input.amount.currency", problem: "invalid", message: `must be ${owed.currency}` }],
    });
  }
  if (amount.value < owed.value) {
    throw new WriteError(
      "guard_failed",
      `This refund owes ${owed.value} (${owed.currency} minor units). Refunding less needs the customer's agreement: agree it with them first, then refund what they agreed to as a new amount on the refund.`,
      { details: { guard: "refund_amount", owed } },
    );
  }
  const [linked] = await db.orm
    .select({ payload: items.payload, type: items.type })
    .from(items)
    .where(eq(items.id, item.payload.orderItemId));
  const p = (linked?.payload ?? {}) as { paidAmount?: Money; totalPrice?: Money; paymentRef?: string };
  const paid = paidFor(p) ?? p.totalPrice ?? owed;
  // What the order's other returns owe or paid back comes out of what was paid: never refunded twice.
  const others = (await earlierReturnsOf(db, item.payload.orderItemId, item.id)).reduce(
    (sum, r) => sum + (r.money.currency.toUpperCase() === paid.currency.toUpperCase() ? r.money.value : 0),
    0,
  );
  const cap = { value: Math.max(0, paid.value - others), currency: paid.currency };
  if (amount.value > Math.max(cap.value, owed.value)) {
    throw new WriteError(
      "invalid_input",
      `input.amount is more than is left of what was paid (${cap.value} ${cap.currency} minor units)`,
      {
        fields: [{ path: "input.amount.value", problem: "invalid", message: "no more than was paid" }],
      },
    );
  }
  data.amount = { value: amount.value, currency: owed.currency };
}

/**
 * What the owner's AI and rules may approve (ADR-018 §4, Q2: returns inside the policy, never a
 * refund payment): faulty goods, or a return inside the owner's policy — nothing excepted, within
 * `returns.days` — and either way with the goods coming back; refunding with nothing to return is
 * money, and the owner's. Only while the owner lets them (`negotiation.ai.mayAuthorizeReturnsInPolicy`).
 */
async function returnAllowed(
  db: Db,
  item: Item,
  data: Record<string, unknown>,
  caller: Caller,
  settings: Awaited<ReturnType<typeof readSettings>>,
  now: number,
): Promise<void> {
  if (!isAutomation(caller) || item.type !== "refund") return;
  const refuse = (message: string, guard = "return_allowed") =>
    new WriteError(
      "guard_failed",
      `${message} Tell the owner in a note (reply with internal: true) what you would do.`,
      {
        details: { guard, draft_for_owner: true },
      },
    );
  const r = item.payload;
  if (!settings.negotiation.ai.mayAuthorizeReturnsInPolicy) {
    throw refuse("The owner has not let you approve returns: a person does.");
  }
  // With nothing to send back a refund is money owed as it is: automation agrees one only up to what the
  // owner lets it (`negotiation.ai.maxRefundMinor`, none out of the box) — for the order, counting what
  // it already agreed with nothing back, so a claim split line by line never goes past it.
  if (
    (data.goodsBack === false || r.goodsBack !== true) &&
    !refundWithinLimit(r.amount.value + (await givenWithNothingBack(db, r.orderItemId, item.id)), settings.negotiation)
  ) {
    throw refuse(
      "Refunding with nothing to send back is a payment, which is the owner's to agree.",
      settings.negotiation.ai.maxRefundMinor > 0 ? "refund_over_max" : "owner_money",
    );
  }
  if (r.kind === "faulty") return;
  const [row] = await db.orm.select().from(items).where(eq(items.id, r.orderItemId));
  const right = row
    ? await withdrawalOf(db, rowToItem(row), settings, r.noticeAt ? Date.parse(r.noticeAt) : now, { policy: true })
    : null;
  if (!right?.available) {
    throw refuse("This return is outside the owner's return policy, so a person decides.", "return_outside_policy");
  }
}

/** What the order's other refunds agreed with nothing to send back come to, in minor units: approved or paid. */
async function givenWithNothingBack(db: Db, orderId: string, exceptId: string): Promise<number> {
  const { rows } = await db.client.query({
    sql: `SELECT COALESCE(SUM(CASE WHEN state = 'refunded' AND json_extract(payload, '$.paidAmount.value') IS NOT NULL
                                  THEN json_extract(payload, '$.paidAmount.value')
                                  ELSE json_extract(payload, '$.amount.value') END), 0)
            FROM items
           WHERE type = 'refund' AND linked_item_id = ? AND id <> ?
             AND state IN ('approved', 'goods_received', 'refunded')
             AND COALESCE(json_extract(payload, '$.goodsBack'), 0) <> 1`,
    params: [orderId, exceptId],
    method: "all",
  });
  const n = Number(rows[0]?.[0] ?? 0);
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * A customer's cancellation the business records (`record_cancel`, or `record_cancel_late`) of a booking
 * or an order they paid for, asked while they could still withdraw from it (ADR-018 §7, §8): that is
 * their withdrawal, whatever the business calls it — never late, owed back within 14 days of when they
 * asked, and refused by nobody. It is recorded as `record_withdrawal`, dated as they said it, which the
 * owner's AI makes only from the customer's own message. Before a payment a cancel stays a cancel.
 */
async function withdrawalInstead(
  db: Db,
  item: Item,
  input: TransitionInput,
  settings: Awaited<ReturnType<typeof readSettings>>,
  now: number,
): Promise<"record_withdrawal" | null> {
  if (input.event !== "record_cancel" && input.event !== "record_cancel_late") return null;
  const agreed =
    item.type === "booking"
      ? item.state === "confirmed"
      : item.type === "order" && (item.state === "paid" || item.state === "fulfilling");
  if (!agreed || !paidFor(item.payload as { paidAmount?: Money; totalPrice?: Money; paymentRef?: string })) return null;
  const said = (input.input ?? {}) as { askedAt?: unknown; entryId?: unknown };
  let when = now;
  if (typeof said.entryId === "string") {
    const { rows } = await db.client.query({
      sql: "SELECT created_at FROM thread_entries WHERE id = ? AND item_id = ? AND direction = 'in'",
      params: [said.entryId, item.id],
      method: "all",
    });
    if (rows[0]?.[0] !== null && rows[0]?.[0] !== undefined) when = Number(rows[0][0]);
  } else if (typeof said.askedAt === "string") {
    const at = Date.parse(said.askedAt);
    if (Number.isFinite(at) && at <= now) when = at;
  }
  return (await withdrawalOf(db, item, settings, when)).available ? "record_withdrawal" : null;
}

/**
 * A request the business takes after it lapsed (ADR-018 §1): the business's `confirm` or `accept` of
 * a customer's request whose clock ran out before the sweep reached it becomes our offer on the same
 * terms, which the customer accepts. Late, never refused; the answer says so (`converted`).
 */
function lateTake(
  item: Item,
  requestExpiresAt: number | null,
  input: TransitionInput,
  caller: Caller,
  now: number,
): { event: string; input: Record<string, unknown>; converted: "request_lapsed" } | null {
  if (isCustomer(caller) || caller.actor.kind === "system") return null;
  if (requestExpiresAt === null || requestExpiresAt > now) return null;
  if (item.state !== "requested" && item.state !== "received" && item.state !== "needs_info") return null;
  const said = (input.input ?? {}) as { note?: unknown };
  const note = typeof said.note === "string" && said.note.trim() ? { note: said.note } : {};
  if (item.type === "booking" && input.event === "confirm") {
    const p = item.payload;
    return {
      event: "propose",
      input: {
        startTime: p.startTime,
        endTime: p.endTime,
        ...(p.totalPrice ? { totalPrice: p.totalPrice } : {}),
        ...note,
      },
      converted: "request_lapsed",
    };
  }
  if (item.type === "order" && input.event === "accept") {
    const p = item.payload;
    return {
      event: "propose",
      input: {
        orderedItem: p.orderedItem.map(({ customerStatedPrice: _stated, ...line }) => line),
        ...(p.delivery ? { delivery: p.delivery } : {}),
        ...note,
      },
      converted: "request_lapsed",
    };
  }
  return null;
}

/**
 * A change the customer asked for that the business takes after it lapsed (ADR-018 §1): late, never
 * refused, it goes back to them as our change on the same terms, which they accept.
 */
function lateChange(
  item: Item,
  open: OfferRow | undefined,
  input: TransitionInput,
  caller: Caller,
  now: number,
): { event: string; input: Record<string, unknown>; converted: "change_lapsed" } | null {
  if (isCustomer(caller) || caller.actor.kind === "system" || input.event !== "accept_change") return null;
  if (open?.kind !== "change" || open.by !== "customer" || open.validThrough === null || open.validThrough >= now)
    return null;
  const said = (input.input ?? {}) as { note?: unknown };
  const note = typeof said.note === "string" && said.note.trim() ? { note: said.note } : {};
  if (item.type === "booking" && item.payload.change) {
    const c = item.payload.change;
    return {
      event: "propose_change",
      input: {
        startTime: c.startTime,
        endTime: c.endTime,
        ...(c.totalPrice ? { totalPrice: c.totalPrice } : {}),
        ...note,
      },
      converted: "change_lapsed",
    };
  }
  if (item.type === "order" && item.payload.change) {
    const c = item.payload.change;
    return {
      event: "propose_change",
      input: {
        orderedItem: c.orderedItem.map(({ customerStatedPrice: _stated, ...line }) => line),
        ...(c.delivery ? { delivery: c.delivery } : {}),
        ...note,
      },
      converted: "change_lapsed",
    };
  }
  return null;
}

/**
 * The changes the business suggests to an order, made whole (ADR-018 §3.2): the lines in one
 * currency, their total worked out here, a validity still to come. What automation prices is judged
 * against the owner's limits (`write/limits.ts`), not here.
 */
function proposeOrder(data: Record<string, unknown>, now: number): void {
  const lines = data.orderedItem as {
    productId?: string;
    sku?: string;
    name: string;
    quantity: number;
    price: Money;
  }[];
  const currency = lines[0]?.price.currency.toUpperCase() ?? "";
  const problems: FieldProblem[] = [];
  let total = 0;
  lines.forEach((l, i) => {
    if (l.price.currency.toUpperCase() !== currency) {
      problems.push({
        path: `input.orderedItem.${i}.price.currency`,
        problem: "invalid",
        message: `must be ${currency}`,
      });
    }
    total += l.price.value * l.quantity;
  });
  if (!Number.isSafeInteger(total)) {
    problems.push({ path: "input.orderedItem", problem: "invalid", message: "the total is too large" });
  }
  if (typeof data.validThrough === "string" && Date.parse(data.validThrough) <= now) {
    problems.push({ path: "input.validThrough", problem: "invalid", message: "must be in the future" });
  }
  if (problems.length) {
    throw new WriteError(
      "invalid_input",
      `The changes are not complete: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`,
      {
        fields: problems,
      },
    );
  }
  data.totalPrice = { value: total, currency };
}

/**
 * The first order line that names no product of the catalogue, or -1: a price a person set for the
 * customer, which automation never takes (time yes, money no).
 */
async function unknownProductLine(
  db: Db,
  lines: readonly { productId?: string | undefined; sku?: string | undefined; price: Money }[],
): Promise<number> {
  return (await linePricing(db, lines)).indexOf(null);
}

/**
 * The first order line that is not one of our products at its catalogue price for this customer (the
 * list price, or the owner's reward for them), or -1: what a change automation takes may not hold
 * (ADR-018 §3.2).
 */
async function offCatalogueLine(
  db: Db,
  lines: readonly { productId?: string | undefined; sku?: string | undefined; price: Money }[],
  pricing?: PricingFor,
): Promise<number> {
  const priced = await linePricing(db, lines, pricing);
  return lines.findIndex((l, i) => {
    const p = priced[i];
    return !p || !(sameMoney(p.list, l.price) || sameMoney(p.customer, l.price));
  });
}

/** The changes we suggested to an order become the order, as the customer (or a person for them) accepted them. */
function applyOrderOffer(payload: Record<string, unknown>): void {
  const p = payload.proposed as
    | { orderedItem: unknown[]; totalPrice: Money; delivery?: Record<string, unknown> }
    | undefined;
  if (!p)
    throw new WriteError("guard_failed", "there are no changes to accept", { details: { guard: "proposal_present" } });
  payload.orderedItem = p.orderedItem;
  payload.totalPrice = p.totalPrice;
  if (p.delivery) payload.delivery = p.delivery;
  // The notice goes with a price we chose for them, and no further than it.
  const personalised = (p as { personalised?: unknown }).personalised;
  if (personalised) payload.personalised = personalised;
  else delete payload.personalised;
  delete payload.proposed;
  // What the customer's first request stated is moot once both agreed on other terms.
  delete payload.customerStatedPrice;
}

/**
 * The customer's answer to the changes we suggested (ADR-018 §3.2): our lines at our prices with
 * their quantities (0 drops a line), or another delivery date. It becomes their request, back with us.
 */
function applyOrderCounter(payload: Record<string, unknown>, data: Record<string, unknown>): void {
  const p = payload.proposed as
    | {
        orderedItem: { quantity: number; price: Money }[];
        totalPrice: Money;
        delivery?: { method: string; when?: string };
      }
    | undefined;
  if (!p)
    throw new WriteError("guard_failed", "there are no changes to answer", { details: { guard: "proposal_present" } });
  const changes = (data.lines ?? []) as { index: number; quantity: number; unitPrice?: Money }[];
  const when = typeof data.deliveryWhen === "string" ? data.deliveryWhen : undefined;
  if (changes.length === 0 && !when) {
    throw new WriteError(
      "invalid_input",
      "Say what you would change: other quantities (lines) or another delivery date (deliveryWhen).",
      {
        fields: [{ path: "input.lines", problem: "missing", message: "a quantity or a delivery date" }],
      },
    );
  }
  const lines = p.orderedItem.map((l) => ({ ...l })) as { quantity: number; price: Money; listPrice?: Money }[];
  const problems: FieldProblem[] = [];
  changes.forEach((c, i) => {
    const line = lines[c.index];
    if (!line)
      problems.push({ path: `input.lines.${i}.index`, problem: "invalid", message: `there are ${lines.length} lines` });
    else {
      line.quantity = c.quantity;
      // A unit price of their own (price counters on, ADR-018 Q1), in our currency: theirs, not ours.
      if (c.unitPrice) {
        if (c.unitPrice.currency.toUpperCase() !== p.totalPrice.currency.toUpperCase()) {
          problems.push({
            path: `input.lines.${i}.unitPrice.currency`,
            problem: "invalid",
            message: `must be ${p.totalPrice.currency}`,
          });
        } else {
          line.price = c.unitPrice;
          delete line.listPrice;
        }
      }
    }
  });
  const kept = lines.filter((l) => l.quantity > 0);
  if (!problems.length && kept.length === 0) {
    problems.push({
      path: "input.lines",
      problem: "invalid",
      message: "keep at least one line; to say no, decline instead",
    });
  }
  const total = kept.reduce((sum, l) => sum + l.price.value * l.quantity, 0);
  if (!Number.isSafeInteger(total)) problems.push({ path: "input.lines", problem: "invalid", message: "too large" });
  if (problems.length) {
    throw new WriteError(
      "invalid_input",
      `That change is not one we can take: ${problems.map((x) => `${x.path} ${x.message}`).join("; ")}`,
      {
        fields: problems,
      },
    );
  }
  payload.orderedItem = kept;
  payload.totalPrice = { value: total, currency: p.totalPrice.currency };
  // What stays a price we chose for them keeps its notice; a price of their own carries none.
  const personalised = orderPersonalised(kept, (p as { personalised?: { says?: string } }).personalised?.says);
  if (personalised) payload.personalised = personalised;
  else delete payload.personalised;
  const delivery = p.delivery ?? (payload.delivery as { method: string; when?: string } | undefined);
  if (when) payload.delivery = { method: delivery?.method ?? "delivery", when };
  else if (delivery) payload.delivery = delivery;
  delete payload.proposed;
  delete payload.customerStatedPrice;
}

/** The customer asks for the quote again for another quantity or time: their request, as it now stands. */
function applyQuoteCounter(payload: Record<string, unknown>, data: Record<string, unknown>, now: number): void {
  if (data.quantity === undefined && data.startTime === undefined) {
    throw new WriteError("invalid_input", "Say what you would change: how many (quantity) or for when (startTime).", {
      fields: [{ path: "input.quantity", problem: "missing", message: "a quantity or a time" }],
    });
  }
  if (typeof data.startTime === "string") {
    if (Date.parse(data.startTime) <= now) {
      throw new WriteError("invalid_input", "That time has passed.", {
        fields: [{ path: "input.startTime", problem: "invalid", message: "must be in the future" }],
      });
    }
    payload.requestedFor = new Date(Date.parse(data.startTime)).toISOString();
  }
  if (typeof data.quantity === "number") payload.quantity = data.quantity;
  delete payload.quote;
}

/**
 * Money that moved, or did not: a payment, a failed one, a charge-back, a refund. Recording one is the
 * payment provider's or the owner's in person (ADR-018 §4 `money_recorded`), never the owner's AI,
 * which acts with the owner's rights on the machines; a failed payment and a charge-back also close
 * a promise as broken against the customer.
 */
const MONEY_RECORDED: ReadonlySet<string> = new Set([
  "record_payment",
  "payment_failed",
  "charge_back",
  "record_charge_back",
  "refund",
]);

/**
 * Money that moved is recorded by the payment provider, the owner, or a system the owner gave
 * `money:write` (ADR-018 §4 `money_recorded`): never the owner's AI, which acts with the owner's rights
 * on the machines (Q2), and never another system's key without it (C9). Nor do they name the link the
 * customer pays at: that is where the customer's money goes. What they offer is judged against the
 * owner's limits (`write/limits.ts`), not here.
 */
function assertNoMoney(event: string, data: Record<string, unknown>, assistant: boolean): void {
  const refusal = assistant
    ? { reason: "owner_money", draft_for_owner: true }
    : { reason: "money_recorded", scope: "money:write" };
  if (MONEY_RECORDED.has(event)) {
    throw new WriteError(
      "not_allowed",
      assistant
        ? "Payments, failed payments, charge-backs and refunds are recorded by the owner or the payment provider, not by you. Tell the owner in a note (reply with internal: true) what you know."
        : "Recording a payment, a failed payment, a charge-back or a refund needs a key with money:write, as a shop or a till has. Ask the owner for one.",
      { details: refusal },
    );
  }
  if (event === "request_payment" && data.paymentUrl !== undefined) {
    throw new WriteError(
      "not_allowed",
      assistant
        ? "The link the customer pays at is the owner's to give: ask for payment without one. Tell the owner in a note (reply with internal: true) if a link is needed."
        : "The link the customer pays at needs a key with money:write: ask for payment without one.",
      {
        fields: [{ path: "input.paymentUrl", problem: "invalid", message: "only the owner sets a payment link" }],
        details: refusal,
      },
    );
  }
}

async function slotSpecFor(db: Db, payload: Record<string, unknown>): Promise<SlotSpec> {
  const reservationFor = payload.reservationFor as { serviceId: string };
  const [service] = await db.orm
    .select({
      capacity: services.capacity,
      granularityMin: services.granularityMin,
      bufferBeforeMin: services.bufferBeforeMin,
      bufferAfterMin: services.bufferAfterMin,
    })
    .from(services)
    .where(eq(services.id, reservationFor.serviceId));
  if (!service) {
    throw new WriteError("invalid_input", `unknown service ${reservationFor.serviceId}`, {
      fields: [{ path: "payload.reservationFor.serviceId", problem: "invalid", message: "unknown service" }],
    });
  }
  const resourceId = payload.resourceId as string | undefined;
  if (resourceId) {
    const [resource] = await db.orm
      .select({ capacity: resources.capacity })
      .from(resources)
      .where(eq(resources.id, resourceId));
    if (!resource)
      throw new WriteError("invalid_input", `unknown resource ${resourceId}`, {
        fields: [{ path: "payload.resourceId", problem: "invalid", message: "unknown resource" }],
      });
    return { ...service, capacity: resource.capacity, resourceKey: `resource:${resourceId}` };
  }
  return { ...service, resourceKey: `service:${reservationFor.serviceId}` };
}

/** The start a transition books or proposes, when it has one. */
async function bookedStart(
  db: Db,
  item: Item,
  event: string,
  payload: Record<string, unknown>,
): Promise<number | null> {
  if (item.type === "booking") {
    const at =
      event === "propose"
        ? (payload.proposed as { startTime?: string } | undefined)?.startTime
        : event === "propose_change"
          ? (payload.change as { startTime?: string } | undefined)?.startTime
          : payload.startTime;
    const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === "quote_request") {
    const linked = await linkedBookingOf(db, payload);
    return linked ? Date.parse(linked.startTime) : null;
  }
  return null;
}

/**
 * The customer's other time (`counter`): the service's own length from the start they chose, which
 * must be a time we would offer them — open, not closed, free. What we proposed is gone, and the
 * price stays the catalogue's.
 */
async function applyCounter(
  db: Db,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  audience: Audience | undefined,
  now: number,
): Promise<void> {
  const startTime = String(data.startTime);
  const serviceId = (payload.reservationFor as { serviceId: string }).serviceId;
  const proposed = payload.proposed as { startTime: string; totalPrice?: Money } | undefined;
  const [service] = await db.orm
    .select({ durationMin: services.durationMin })
    .from(services)
    .where(eq(services.id, serviceId));
  const start = Date.parse(startTime);
  if (!service || !Number.isFinite(start)) {
    throw new WriteError("invalid_input", "that is not a time we can book", {
      fields: [{ path: "input.startTime", problem: "invalid", message: "a start time from the free times" }],
    });
  }
  const end = start + service.durationMin * 60_000;
  const facts = await businessFacts(db);
  // The time we proposed, answered with a price of their own: ours to give, whatever holds it now.
  let offered = proposed !== undefined && start === Date.parse(proposed.startTime);
  if (start > now && !offered) {
    try {
      const r = await findSlots(db, {
        serviceId,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        timezone: facts.timezone,
        limit: 1,
        // Too soon is the notice guard's to say, in its own words; here only "is it free".
        now,
        minNoticeMin: 0,
      });
      offered = r.slots.some((slot) => Date.parse(slot.startTime) === start);
    } catch {
      offered = false;
    }
    if (!offered) {
      throw new WriteError(
        "slot_taken",
        audience
          ? copyFor(audience.lang).problems.timeNotFree(
              vars({ when: whenText(new Date(start).toISOString(), audience.timezone, audience.lang) }),
            )
          : "that time is not free",
        { details: { guard: "slot_free", startTime: new Date(start).toISOString() } },
      );
    }
  }
  payload.startTime = new Date(start).toISOString();
  payload.endTime = new Date(end).toISOString();
  // A price of their own (price counters on, ADR-018 Q1): the price of their request now, theirs and not
  // ours, in our currency; a person takes it, or automation at or above the owner's floor.
  const theirs = data.totalPrice as Money | undefined;
  if (theirs) {
    const ours = proposed?.totalPrice ?? (payload.totalPrice as Money | undefined);
    if (ours && ours.currency.toUpperCase() !== theirs.currency.toUpperCase()) {
      throw new WriteError(
        "invalid_input",
        `A price is in ${ours.currency.toUpperCase()}, the currency of our prices.`,
        {
          fields: [{ path: "input.totalPrice.currency", problem: "invalid", message: `must be ${ours.currency}` }],
        },
      );
    }
    payload.totalPrice = theirs;
    delete payload.personalised;
    delete payload.customerStatedPrice;
  }
  delete payload.proposed;
}

/**
 * A change one side asks for to the promise (ADR-018 §3.1, §3.2), made whole as `payload.change`: the
 * booking or the order as it would be. A booking keeps its length and its price unless the business
 * names others; the customer's time must be one we would offer (open, on the grid, free but for their
 * own booking). An order keeps its lines unless the business names others; the customer changes
 * quantities (0 drops a line) or the delivery date, never a price. Once payment was asked for or made,
 * a change keeps the order's total. A change that changes nothing is none.
 */
async function planChange(
  db: Db,
  item: Item,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  by: "business" | "customer",
  audience: Audience | undefined,
  now: number,
): Promise<void> {
  if (typeof data.validThrough === "string" && Date.parse(data.validThrough) <= now) {
    throw new WriteError("invalid_input", "The change is not complete: input.validThrough must be in the future", {
      fields: [{ path: "input.validThrough", problem: "invalid", message: "must be in the future" }],
    });
  }
  const unchanged = () =>
    new WriteError(
      "invalid_input",
      audience
        ? copyFor(audience.lang).problems.sameAsAgreed
        : "that is what was agreed already: change the time, the lines or the delivery date",
      { fields: [{ path: "input", problem: "invalid", message: "changes nothing" }] },
    );
  if (item.type === "booking") {
    const p = item.payload;
    const length = Date.parse(p.endTime) - Date.parse(p.startTime);
    const start = Date.parse(String(data.startTime));
    const end = by === "business" && typeof data.endTime === "string" ? Date.parse(data.endTime) : start + length;
    const totalPrice = (by === "business" ? (data.totalPrice as Money | undefined) : undefined) ?? p.totalPrice;
    // In the booking's own currency: another would read as more or less than it is, to us and to the customer.
    if (totalPrice && p.totalPrice && totalPrice.currency.toUpperCase() !== p.totalPrice.currency.toUpperCase()) {
      throw new WriteError(
        "invalid_input",
        `The change is not complete: input.totalPrice.currency must be ${p.totalPrice.currency.toUpperCase()}`,
        {
          fields: [
            {
              path: "input.totalPrice.currency",
              problem: "invalid",
              message: `must be ${p.totalPrice.currency.toUpperCase()}`,
            },
          ],
        },
      );
    }
    if (!(end > start)) {
      throw new WriteError("invalid_input", "The time is not one we can book: input.endTime must be after startTime", {
        fields: [{ path: "input.endTime", problem: "invalid", message: "must be after startTime" }],
      });
    }
    const change = {
      by,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      ...(totalPrice ? { totalPrice } : {}),
    };
    const samePrice =
      (totalPrice === undefined && p.totalPrice === undefined) ||
      (totalPrice !== undefined && p.totalPrice !== undefined && sameMoney(totalPrice, p.totalPrice));
    if (start === Date.parse(p.startTime) && end === Date.parse(p.endTime) && samePrice) throw unchanged();
    if (by === "customer") {
      // A time we would offer them: open, on our grid, free for its whole length but for their own booking.
      const facts = await businessFacts(db);
      const offered =
        start > now &&
        (await slotOffered(db, {
          serviceId: p.reservationFor.serviceId,
          start,
          end,
          timezone: facts.timezone,
          exceptItemId: item.id,
        }));
      if (!offered && start > now) {
        throw new WriteError(
          "slot_taken",
          audience
            ? copyFor(audience.lang).problems.timeNotFree(
                vars({ when: whenText(change.startTime, audience.timezone, audience.lang) }),
              )
            : "that time is not free",
          { details: { guard: "slot_free", startTime: change.startTime } },
        );
      }
    } else {
      // One the customer can say yes to: bookable in one go, and free as we ask (their own places aside).
      const spec = await slotSpecFor(db, payload);
      let buckets: number[];
      try {
        buckets = bucketsFor(spec, change.startTime, change.endTime);
      } catch (error) {
        if (!(error instanceof WriteError) || error.code !== "invalid_input") throw error;
        throw new WriteError("invalid_input", `The time is not one we can book: ${error.message}`, {
          fields: [{ path: "input.endTime", problem: "invalid", message: error.message }],
        });
      }
      const plan = planClaims(spec, buckets, await readClaims(db, spec.resourceKey, buckets, item.id));
      if (!plan.ok) {
        throw new WriteError("slot_taken", "that time is fully booked", {
          details: { guard: "slot_available", bucket: plan.fullBucket, capacity: spec.capacity },
        });
      }
    }
    payload.change = change;
    return;
  }
  if (item.type !== "order") return;
  const p = item.payload;
  const current = p.orderedItem.map(({ customerStatedPrice: _stated, ...line }) => line);
  let lines: {
    productId?: string | undefined;
    sku?: string | undefined;
    name: string;
    quantity: number;
    price: Money;
  }[];
  let delivery = p.delivery;
  if (by === "business") {
    lines = (data.orderedItem as typeof lines | undefined) ?? current;
    if (data.delivery) delivery = data.delivery as typeof delivery;
    // A date the customer could say yes to: one still to come.
    if (data.delivery && delivery?.when !== undefined && Date.parse(delivery.when) <= now) {
      throw new WriteError("invalid_input", "The change is not complete: input.delivery.when must be in the future", {
        fields: [{ path: "input.delivery.when", problem: "invalid", message: "must be in the future" }],
      });
    }
  } else {
    const changes = (data.lines ?? []) as { index: number; quantity: number }[];
    const when = typeof data.deliveryWhen === "string" ? data.deliveryWhen : undefined;
    if (changes.length === 0 && !when) {
      throw new WriteError(
        "invalid_input",
        "Say what you would change: other quantities (lines) or another delivery date (deliveryWhen).",
        { fields: [{ path: "input.lines", problem: "missing", message: "a quantity or a delivery date" }] },
      );
    }
    const next = current.map((l) => ({ ...l }));
    const problems: FieldProblem[] = [];
    changes.forEach((c, i) => {
      const line = next[c.index];
      if (!line) {
        problems.push({
          path: `input.lines.${i}.index`,
          problem: "invalid",
          message: `there are ${next.length} lines`,
        });
      } else line.quantity = c.quantity;
    });
    lines = next.filter((l) => l.quantity > 0);
    if (!problems.length && lines.length === 0) {
      problems.push({ path: "input.lines", problem: "invalid", message: "keep at least one line; to cancel, cancel" });
    }
    if (when && Date.parse(when) <= now) {
      problems.push({ path: "input.deliveryWhen", problem: "invalid", message: "must be in the future" });
    }
    if (problems.length) {
      throw new WriteError(
        "invalid_input",
        `That change is not one we can take: ${problems.map((x) => `${x.path} ${x.message}`).join("; ")}`,
        { fields: problems },
      );
    }
    if (when) delivery = { method: delivery?.method ?? "delivery", when };
  }
  const currency = p.totalPrice.currency.toUpperCase();
  const problems: FieldProblem[] = [];
  let total = 0;
  lines.forEach((l, i) => {
    if (l.price.currency.toUpperCase() !== currency) {
      problems.push({
        path: `input.orderedItem.${i}.price.currency`,
        problem: "invalid",
        message: `must be ${currency}`,
      });
    }
    total += l.price.value * l.quantity;
  });
  if (!Number.isSafeInteger(total))
    problems.push({ path: "input.orderedItem", problem: "invalid", message: "too large" });
  if (problems.length) {
    throw new WriteError(
      "invalid_input",
      `The change is not complete: ${problems.map((x) => `${x.path} ${x.message}`).join("; ")}`,
      { fields: problems },
    );
  }
  const change = {
    by,
    orderedItem: lines,
    totalPrice: { value: total, currency },
    ...(delivery ? { delivery } : {}),
  };
  if (
    JSON.stringify(
      orderRequestTerms({
        ...p,
        orderedItem: change.orderedItem,
        totalPrice: change.totalPrice,
        ...(delivery ? { delivery } : {}),
      }),
    ) === JSON.stringify(orderRequestTerms(p))
  ) {
    throw unchanged();
  }
  // Once payment was asked for, or made, the total stays: more is a second order, less a refund.
  if (totalFixed(item) && total !== p.totalPrice.value) {
    throw totalFixedError(audience ? copyFor(audience.lang).problems : undefined);
  }
  payload.change = change;
}

/** A change that would move an order's total once payment was asked for or made: a person handles it. */
function totalFixedError(words: { readonly changeByPerson: string } | undefined): WriteError {
  return new WriteError(
    "guard_failed",
    words
      ? words.changeByPerson
      : "Payment for this order was asked for or made at its total, so a change must keep that total: take a second order for more, or refund what comes off.",
    { details: { guard: "total_fixed" } },
  );
}

/** Whether an order's total is settled: payment was asked for or made. */
function totalFixed(item: Extract<Item, { type: "order" }>): boolean {
  const p = item.payload;
  return (
    item.state === "awaiting_payment" ||
    item.state === "payment_failed" ||
    item.state === "paid" ||
    p.paymentRef !== undefined ||
    p.paidAmount !== undefined
  );
}

/** The change both sides accepted becomes the promise; what it replaced is in the event. */
function applyChange(type: ItemType, payload: Record<string, unknown>): void {
  const c = payload.change as Record<string, unknown> | undefined;
  if (!c) throw new WriteError("guard_failed", "there is no change to accept", { details: { guard: "change_open" } });
  if (type === "booking") {
    payload.startTime = c.startTime;
    payload.endTime = c.endTime;
    if (c.totalPrice) payload.totalPrice = c.totalPrice;
  } else {
    payload.orderedItem = c.orderedItem;
    payload.totalPrice = c.totalPrice;
    if (c.delivery) payload.delivery = c.delivery;
    // What the customer's first request stated is moot once both agreed on other terms.
    delete payload.customerStatedPrice;
  }
  delete payload.change;
}

/**
 * The places a change we ask for holds while the customer answers, as a time we propose does
 * (`booking.holdOnPropose`, `booking.maxHolds`): counting the booking's own places as taken, since
 * they stay its own until the change is accepted. A move onto its own time that capacity cannot hold
 * twice goes out unheld.
 */
async function holdForChange(
  db: Db,
  item: Item,
  payload: Record<string, unknown>,
  agent: string | null,
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<{ resourceKey: string; claims: [number, number][] } | undefined> {
  const c = payload.change as { startTime: string; endTime: string } | undefined;
  if (!c || !settings.booking.holdOnPropose) return undefined;
  if ((await holdsOf(db, { itemId: item.id, partyId: item.partyId, agent })) >= settings.booking.maxHolds)
    return undefined;
  const spec = await slotSpecFor(db, payload);
  const buckets = bucketsFor(spec, c.startTime, c.endTime);
  const plan = planClaims(spec, buckets, await readClaims(db, spec.resourceKey, buckets, ""));
  return plan.ok ? { resourceKey: spec.resourceKey, claims: plan.claims } : undefined;
}

/**
 * What the owner's AI and rules may do with a change (ADR-018 §4, Q2: time yes, money no). They ask
 * for one only when the owner lets them (`negotiation.ai.mayProposeChanges`), moving the time or the
 * quantities and delivery, never a price or a longer booking; they take a customer's only when the
 * owner lets them (`mayAcceptChanges`), before the cutoff (`negotiation.changes.customerCutoffMin`,
 * else the cancellation window), and an order's only at our catalogue's prices. Otherwise a person
 * does, and they are told to leave the owner a note.
 */
async function changeAllowed(
  db: Db,
  item: Item,
  event: string,
  caller: Caller,
  settings: Awaited<ReturnType<typeof readSettings>>,
  now: number,
): Promise<void> {
  if (!isAutomation(caller)) return;
  const refuse = (message: string, guard = "change_allowed") =>
    new WriteError(
      "guard_failed",
      `${message} Tell the owner in a note (reply with internal: true) what you would do.`,
      {
        details: { guard, draft_for_owner: true },
      },
    );
  const ai = settings.negotiation.ai;
  // What automation asks to change is an offer, judged against the owner's limits (`write/limits.ts`):
  // outside them, a draft for a person.
  if (event !== "accept_change") return;
  if (!ai.mayAcceptChanges) throw refuse("The owner has not let you accept customers' changes: a person answers them.");
  if (item.type === "booking") {
    const cutoff = (settings.negotiation.changes.customerCutoffMin ?? settings.booking.cancellationWindowMin) * 60_000;
    if (Date.parse(item.payload.startTime) - now < cutoff) {
      throw refuse("It is too close to the booking for you to take a change to it: a person does.");
    }
  }
  if (item.type === "order" && item.payload.change) {
    const pricing = await pricingForItem(db, item, settings);
    if ((await offCatalogueLine(db, item.payload.change.orderedItem, pricing)) !== -1) {
      throw refuse(
        "The change holds a price that is not our catalogue's, so only the owner can accept it.",
        "business_priced",
      );
    }
  }
}

interface QuoteTerms {
  totalPrice: Money;
  validThrough: string;
  lines: { name: string; quantity: number; price: Money }[];
  notes?: string;
  creates: "booking" | "order";
  startTime?: string;
  endTime?: string;
}

/**
 * A quote the customer can say yes to (ADR-018 §3.3): valid for a while yet, its lines adding up to
 * its total in one currency, and — when it creates a booking — for one of the business's services at
 * a time to come, whose end defaults to the service's length. No silent fall back to an order (N12).
 */
async function completeQuote(
  db: Db,
  payload: Record<string, unknown>,
  now: number,
  minNoticeMin: number,
): Promise<void> {
  const q = payload.quote as QuoteTerms;
  const problems: FieldProblem[] = [];
  if (Date.parse(q.validThrough) <= now) {
    problems.push({ path: "input.validThrough", problem: "invalid", message: "must be in the future" });
  }
  if (q.lines.length) {
    let sum = 0;
    q.lines.forEach((l, i) => {
      if (l.price.currency.toUpperCase() !== q.totalPrice.currency.toUpperCase()) {
        problems.push({
          path: `input.lines.${i}.price.currency`,
          problem: "invalid",
          message: `must be ${q.totalPrice.currency}, the total's currency`,
        });
      }
      sum += l.price.value * l.quantity;
    });
    if (!problems.some((p) => p.path.endsWith(".currency")) && sum !== q.totalPrice.value) {
      problems.push({
        path: "input.totalPrice.value",
        problem: "invalid",
        message: `the lines add up to ${sum}; send that total, or change the lines`,
      });
    }
  }
  if (q.creates === "booking") {
    const offered = payload.itemOffered as { serviceId?: string };
    const [service] = offered.serviceId
      ? await db.orm
          .select({ durationMin: services.durationMin })
          .from(services)
          .where(eq(services.id, offered.serviceId))
      : [];
    const startIso = q.startTime ?? (payload.requestedFor as string | undefined);
    const start = startIso ? Date.parse(startIso) : Number.NaN;
    if (!service) {
      problems.push({
        path: "input.creates",
        problem: "invalid",
        message:
          "a quote that creates a booking is for one of your services, and this request names none: send it as an order",
      });
    } else if (!Number.isFinite(start)) {
      problems.push({ path: "input.startTime", problem: "missing", message: "the time the booking is for" });
    } else if (start <= now) {
      problems.push({ path: "input.startTime", problem: "invalid", message: "must be in the future" });
    } else if (start - now < minNoticeMin * 60_000) {
      // The customer accepts it by the notice before it starts: a time inside it they never could.
      problems.push({
        path: "input.startTime",
        problem: "invalid",
        message: `must be at least ${minNoticeMin} minutes away, your minimum notice, or the customer could not accept it`,
      });
    } else {
      const end = q.endTime ? Date.parse(q.endTime) : start + service.durationMin * 60_000;
      if (!(end > start)) {
        problems.push({ path: "input.endTime", problem: "invalid", message: "must be after startTime" });
      } else {
        q.startTime = new Date(start).toISOString();
        q.endTime = new Date(end).toISOString();
        // A booking the customer could never accept is no quote: longer than the business can hold
        // at once, it would be refused only at their yes.
        const spec = await slotSpecFor(db, { reservationFor: { serviceId: offered.serviceId } });
        try {
          bucketsFor(spec, q.startTime, q.endTime);
        } catch (error) {
          if (!(error instanceof WriteError)) throw error;
          problems.push({ path: "input.endTime", problem: "invalid", message: error.message });
        }
      }
    }
  }
  if (problems.length) {
    throw new WriteError(
      "invalid_input",
      `The quote is not complete: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`,
      {
        fields: problems,
      },
    );
  }
}

/** The booking an accepted quote becomes: its service, its time, and later the places it claims. */
interface LinkedBooking {
  readonly startTime: string;
  readonly endTime: string;
  readonly payload: Record<string, unknown>;
  readonly claims?: { resourceKey: string; claims: [number, number][] } | undefined;
}

async function linkedBookingOf(db: Db, payload: Record<string, unknown>): Promise<LinkedBooking | undefined> {
  const q = payload.quote as QuoteTerms | undefined;
  if (q?.creates !== "booking") return undefined;
  const offered = payload.itemOffered as { name: string; serviceId?: string };
  const [service] = offered.serviceId
    ? await db.orm
        .select({ durationMin: services.durationMin })
        .from(services)
        .where(eq(services.id, offered.serviceId))
    : [];
  const startIso = q.startTime ?? (payload.requestedFor as string | undefined);
  if (!service || !offered.serviceId || !startIso) {
    throw new WriteError("invalid_input", "this quote creates a booking but names no service or time we have", {
      fields: [{ path: "payload.quote", problem: "invalid", message: "the business sends a new quote" }],
    });
  }
  const start = Date.parse(startIso);
  const end = q.endTime ? Date.parse(q.endTime) : start + service.durationMin * 60_000;
  const startTime = new Date(start).toISOString();
  const endTime = new Date(end).toISOString();
  return {
    startTime,
    endTime,
    payload: {
      reservationFor: { serviceId: offered.serviceId, name: offered.name },
      startTime,
      endTime,
      totalPrice: q.totalPrice,
      ...(q.notes ? { notes: q.notes } : {}),
    },
  };
}

/**
 * An accepted quote becomes the promise, in the same batch (ADR-018 §3.3): a booking already
 * confirmed, its places claimed and its receipt queued, or an order already accepted. The business
 * confirms nothing twice, and the customer's one email is the acceptance's.
 */
async function planLinkedItem(
  db: Db,
  caller: Caller,
  quote: Item,
  payload: Record<string, unknown>,
  causationId: string,
  now: number,
  booking: LinkedBooking | undefined,
  audience: Audience | undefined,
  /** The quote the customer accepted: the promise's own agreed offer answers it. */
  accepted: OfferRow | undefined,
) {
  const q = payload.quote as QuoteTerms;
  const offered = payload.itemOffered as { name: string; serviceId?: string; productId?: string; sku?: string };
  const id = ulid();
  const type: ItemType = q.creates === "booking" ? "booking" : "order";
  const b = type === "booking" ? (booking ?? (await linkedBookingOf(db, payload))) : undefined;
  const linkedPayload = b ? b.payload : orderFromQuote(q, offered, payload);
  const parsed = payloadSchemas[type].parse(linkedPayload) as Record<string, unknown>;
  const state = type === "booking" ? "confirmed" : "accepted";
  // The promise's agreed offer (ADR-018 §3.3): its terms as the promise holds them, answering the
  // quote the customer accepted, so a change to it later has what was agreed to start from.
  const form = type === "booking" ? "time" : "order";
  const terms =
    type === "booking"
      ? bookingRequestTerms(parsed as PayloadOf<"booking">)
      : orderRequestTerms(parsed as PayloadOf<"order">);
  const agreed: OfferRow = {
    id: ulid(),
    itemId: id,
    rev: 1,
    parentId: accepted?.id ?? null,
    kind: "offer",
    form,
    by: "business",
    actorKind: accepted?.actorKind ?? "owner",
    actorId: accepted?.actorId ?? "unknown",
    round: 1,
    status: "accepted",
    validThrough: null,
    terms,
    termsSha: await termsSha(form, terms),
    changes: null,
    shown: null,
    authored: accepted?.authored ?? "person",
    binding: true,
    reasonCode: null,
    note: null,
    eventId: null,
    closedEventId: null,
    createdAt: now,
    updatedAt: now,
  };
  parsed.offer = pointerOf(agreed) satisfies OfferPointer;
  const subject = defaultSubject(type, parsed);
  const item = {
    id,
    type,
    state,
    version: 1,
    partyId: quote.partyId,
    locationId: quote.locationId,
    channel: caller.actor.channel,
    subject,
    flags: quote.flags,
    linkedItemId: quote.id,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    closedAt: null,
    payload: parsed,
  } as Item;
  const linkedEventId = ulid();
  const statements: Statement[] = [
    insertOfferStatement({ ...agreed, eventId: linkedEventId, closedEventId: linkedEventId }),
    {
      // The quote's customer, as the create established it (ADR-017 §3.1): the access token, and the
      // identity columns — the agent that signed, the match, the possible known party.
      sql: `INSERT INTO items (id, type, state, version, party_id, location_id, channel, subject, linked_item_id, access_token_hash, payload, flags,
              agent_thumbprint, agent_level, agent_directory, customer_match, possible_party_id, created_at, updated_at, closed_at)
            SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, q.access_token_hash, ?, ?,
                   q.agent_thumbprint, q.agent_level, q.agent_directory, q.customer_match, q.possible_party_id, ?, ?, NULL
              FROM items q WHERE q.id = ?`,
      params: [
        id,
        type,
        state,
        quote.partyId,
        quote.locationId,
        caller.actor.channel,
        subject,
        quote.id,
        JSON.stringify(parsed),
        JSON.stringify(quote.flags),
        now,
        now,
        quote.id,
      ],
      method: "run",
    },
    eventStatement({
      id: linkedEventId,
      itemId: id,
      seq: 1,
      event: "create",
      fromState: null,
      toState: state,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      reason: `from quote ${quote.id}`,
      meta: { channel: caller.actor.channel, tier: caller.tier, ...actorMeta(caller) },
      causationId,
      depth: 1,
      now,
    }),
    jobStatement("notify", { to: "owner", itemId: id, event: "create" }, now, {
      dedupeKey: `notify:create:${id}:owner`,
    }),
    // The promise is made here: the receipt the confirmation or acceptance earns (ADR-016).
    jobStatement("issue_receipt", { itemId: id, kind: state, eventId: linkedEventId }, now, {
      dedupeKey: `receipt:${id}:${state}`,
    }),
    // The customer each network presented for the quote is the customer of what it became
    // (ADR-017 §3.1): its receipts name the same presentations.
    {
      sql: `INSERT OR IGNORE INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at)
            SELECT ?, network, presentation_id, ppid, person, created_at FROM item_presentations WHERE item_id = ?`,
      params: [id, quote.id],
      method: "run",
    },
  ];
  if (b?.claims) statements.push(...claimStatements(b.claims.resourceKey, id, b.claims.claims));
  return {
    id,
    type,
    eventId: linkedEventId,
    statements,
    view: viewFor(item, permissionKind(caller), undefined, undefined, audience),
  };
}

/**
 * The order an accepted quote becomes: the quote's own lines at the quoted unit prices, or one line
 * at the quoted total. Its lines name no catalogue product: the quoted price is not the catalogue's.
 */
function orderFromQuote(
  q: QuoteTerms,
  offered: { name: string },
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const quantity = Number(payload.quantity ?? 1);
  const lines = q.lines.length
    ? q.lines.map((l) => ({ name: l.name, quantity: l.quantity, price: l.price }))
    : [{ name: quantity > 1 ? `${quantity} × ${offered.name}` : offered.name, quantity: 1, price: q.totalPrice }];
  return {
    orderedItem: lines,
    totalPrice: q.totalPrice,
    ...(payload.deliveryAddress ? { shippingAddress: payload.deliveryAddress } : {}),
    ...(q.notes ? { notes: q.notes } : {}),
  };
}

function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(after[key]);
    if (a !== b) out[key] = [before[key] ?? null, after[key] ?? null];
  }
  return out;
}

function replay(hit: { requestHash: string; response: unknown }, requestHash: string | undefined): TransitionResult {
  if (hit.requestHash !== requestHash) {
    throw new WriteError("idempotency_mismatch", "this idempotency key was already used with a different request");
  }
  const stored = hit.response as { view: ItemView; linked?: ItemView; drafted?: TransitionResult["drafted"] };
  return {
    view: stored.view,
    linked: stored.linked,
    replayed: true,
    ...(stored.drafted ? { drafted: stored.drafted } : {}),
  };
}

export type { Transition };
