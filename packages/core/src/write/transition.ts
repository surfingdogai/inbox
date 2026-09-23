import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { findSlots } from "../capabilities/availability";
import { audienceFor, businessFacts } from "../customer/audience";
import { copyFor, vars } from "../customer/copy";
import type { Audience } from "../customer/describe";
import { whenText } from "../customer/format";
import type { Db } from "../db";
import { type Item, type ItemType, type Money, payloadSchemas } from "../domain/types";
import { ulid } from "../ids";
import { resolveTransition, type Transition } from "../machine/machine";
import { outcomeOf } from "../machine/outcomes";
import { machines, noteInput } from "../machine/tables";
import { items, resources, services } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { hashJson, hashText } from "../util/canonical";
import { actorMeta, type Caller, isCustomer, isOwnerAssistant, isPerson, nowOf, permissionKind } from "./caller";
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
import { assertBusinessPriced, cataloguePriceOf, heldForPrice, sameMoney } from "./pricing";
import { bucketsFor, claimStatements, planClaims, readClaims, releaseStatement, type SlotSpec } from "./slots";
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
}

export interface TransitionResult {
  readonly view: ItemView;
  /** Created by this transition, e.g. the order an accepted quote turns into. */
  readonly linked?: ItemView | undefined;
  readonly replayed: boolean;
}

const MAX_ATTEMPTS = 3;

export async function transitionItem(db: Db, caller: Caller, input: TransitionInput): Promise<TransitionResult> {
  const idem = caller.idempotency;
  const { extraStatements: _extra, hashInput, ...hashed } = input;
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

  const machine = machines[item.type];
  const resolved = resolveTransition(machine, item.state, input.event, permissionKind(caller));
  if (!resolved.ok) {
    switch (resolved.error.code) {
      case "unknown_event":
        throw new WriteError("unknown_event", `${item.type} has no event "${input.event}"`, {
          details: { events: [...new Set(machine.transitions.map((t) => t.event))] },
        });
      case "wrong_state":
        throw new WriteError(
          "wrong_state",
          `"${input.event}" is not possible while the ${item.type} is ${item.state}`,
          {
            details: { state: item.state, allowedFrom: resolved.error.from },
          },
        );
      case "not_allowed":
        throw new WriteError("not_allowed", `${permissionKind(caller)} may not "${input.event}" this ${item.type}`, {
          details: { allowedFor: resolved.error.by },
        });
    }
  }
  const t = resolved.transition;
  // A yes the customer gave a person is recorded by a person (ADR-018 N13): not the owner's AI, not a
  // rule, not a key handed to another system.
  if (t.byPerson && !isPerson(caller)) {
    throw new WriteError(
      "not_allowed",
      "Only a person can record that the customer agreed to the time we proposed. They can accept it from our email or their assistant; the owner can confirm it in the app.",
      { details: { reason: "person_only" } },
    );
  }
  // A rule never makes the promise on a price the business did not set (ADR-018 §3.2), and neither
  // does the owner's AI: time yes, money no (Tiago, 23 September 2026). The AI drafts for the owner.
  const assistant = isOwnerAssistant(caller);
  if (caller.actor.kind === "rule") await assertBusinessPriced(db, item, t.event);
  if (assistant && (await heldForPrice(db, item, t.event))) {
    throw new WriteError(
      "guard_failed",
      "The customer's request holds a price we did not set, so only the owner can confirm or accept it. Tell the owner in a note (reply with internal: true) what you would do.",
      { details: { guard: "business_priced", draft_for_owner: true } },
    );
  }
  // Every transition takes an optional note; some take more.
  const parsedInput = (t.input ?? noteInput).safeParse(input.input ?? {});
  if (!parsedInput.success) throw fromZod(parsedInput.error, "input");
  const data = parsedInput.data as Record<string, unknown>;
  if (assistant) await assertNoMoney(db, item, t.event, data);

  const settings = await readSettings(db);
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
  const effects = new Set(t.effects ?? []);
  if (effects.has("apply_proposal")) {
    const proposed = payload.proposed as { startTime: string; endTime: string; totalPrice?: unknown } | undefined;
    if (!proposed)
      throw new WriteError("guard_failed", "there is no proposed time to accept", {
        details: { guard: "proposal_present" },
      });
    payload.startTime = proposed.startTime;
    payload.endTime = proposed.endTime;
    if (proposed.totalPrice) payload.totalPrice = proposed.totalPrice;
    delete payload.proposed;
  }
  if (effects.has("apply_counter") && item.type === "booking") {
    await applyCounter(db, payload, String(data.startTime), audience, now);
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
  }

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
        const notice = isPerson(caller) && t.event !== "propose" ? 0 : minutes * 60_000;
        if (start <= now || start - now < notice) {
          throw new WriteError(
            "guard_failed",
            audience
              ? copyFor(audience.lang).problems.notTooSoon
              : start <= now
                ? "that time has already started or passed; pick a later time"
                : t.event === "propose"
                  ? `that time is inside your minimum notice of ${minutes} minutes, so the customer could not accept it; propose a later time`
                  : `that time is inside your minimum notice of ${minutes} minutes; only a person at the business can book it now`,
            { details: { guard, startTime: new Date(start).toISOString(), minNoticeMin: minutes } },
          );
        }
        break;
      }
      case "quote_valid": {
        const q = payload.quote as { validThrough: string } | undefined;
        if (q && now > Date.parse(q.validThrough)) {
          const a = audience ?? (await audienceFor(db, { partyId: item.partyId }));
          throw new WriteError(
            "offer_expired",
            copyFor(a.lang).problems.offerExpired(vars({ validThrough: whenText(q.validThrough, a.timezone, a.lang) })),
            { details: { validThrough: q.validThrough } },
          );
        }
        break;
      }
      case "quote_complete":
        await completeQuote(db, payload, now, settings.booking.minNoticeMin);
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
        if (!payload.quote)
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

  const seq = item.version + 1;
  const eventId = ulid();
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
    const linked = await planLinkedItem(db, caller, item, payload, eventId, now, linkedBooking, audience);
    linkedId = linked.id;
    statements.push(...linked.statements);
    linkedView = linked.view;
    linkedEvent = { id: linked.eventId, type: `${linked.type}.create`, itemId: linked.id };
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
      },
      causationId: input.causation?.id ?? null,
      depth: input.causation?.depth ?? 0,
      now,
    }),
  );
  statements.push({
    sql: "UPDATE items SET state = ?, version = ?, payload = ?, linked_item_id = ?, updated_at = ?, closed_at = ? WHERE id = ? AND version = ?",
    params: [t.to, seq, JSON.stringify(payload), linkedId, now, closedAt, item.id, item.version],
    method: "run",
  });
  if (effects.has("release_slot")) statements.push(releaseStatement(item.id));
  if (effects.has("claim_slot") && claimPlan) {
    statements.push(releaseStatement(item.id));
    statements.push(...claimStatements(claimPlan.resourceKey, item.id, claimPlan.claims));
  }
  const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
  if (note) {
    statements.push(
      threadEntryStatement({
        id: ulid(),
        itemId: item.id,
        // What the customer said when they cancelled, how they agreed: the business's own record,
        // never sent to the customer as the business's words.
        direction: isCustomer(caller) ? "in" : t.internalNote ? "note" : "out",
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
  for (const effect of effects) {
    if (
      effect === "issue_receipt:confirmed" ||
      effect === "issue_receipt:paid" ||
      effect === "issue_receipt:accepted"
    ) {
      const kind = effect.slice("issue_receipt:".length);
      statements.push(
        jobStatement("issue_receipt", { itemId: item.id, kind, eventId }, now, {
          dedupeKey: `receipt:${item.id}:${kind}`,
        }),
      );
    } else if (effect === "issue_receipt:outcome") {
      // One pure function names the outcome (ADR-017 §3.1); the machines and it are checked
      // against each other over every path, so a transition with this effect always has one. A
      // promise made before outcomes were recorded closes without one (R18): its owner closes it.
      const outcome =
        row.legacyPromise === 1 ? null : outcomeOf(item.type, t.event, item.state, permissionKind(caller));
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
      claims: claimPlan ?? linkedBooking?.claims,
    });
    return replay(hit, requestHash);
  }
  return { view, linked: linkedView, replayed: false };
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
  // accepted, and left in the payload it would read as booked (the event keeps what it was).
  if (type === "booking" && event === "request_info") delete payload.proposed;
  if (type === "quote_request" && event === "quote") {
    // A new quote replaces the one before; its notes stay with it, and so does the time it is for.
    payload.quote = data;
  }
  if (type === "order" && event === "record_payment") {
    payload.paymentRef = data.paymentRef;
    if (data.amount) payload.paidAmount = data.amount;
  }
  if (type === "order" && event === "request_payment" && data.paymentUrl) payload.paymentUrl = data.paymentUrl;
  if (type === "refund" && event === "refund") payload.paymentRef = data.paymentRef;
}

/**
 * What the owner's AI may not do with money (Tiago, 23 September 2026): send a quote, or propose a
 * time at a price other than the catalogue's — named, or kept by leaving the price out when the
 * price the booking holds is the customer's — or for longer than the service, which the list
 * price does not cover (ADR-018 §3.2). It proposes times; prices are the owner's.
 */
async function assertNoMoney(db: Db, item: Item, event: string, data: Record<string, unknown>): Promise<void> {
  if (item.type === "quote_request" && event === "quote") {
    throw new WriteError(
      "not_allowed",
      "A quote is a price, and prices are the owner's: you cannot send one. Tell the owner in a note (reply with internal: true) the quote you suggest.",
      { details: { reason: "owner_money", draft_for_owner: true } },
    );
  }
  if (item.type !== "booking" || event !== "propose") return;
  const { serviceId } = item.payload.reservationFor;
  const [service] = await db.orm
    .select({ durationMin: services.durationMin })
    .from(services)
    .where(eq(services.id, serviceId));
  const length = Date.parse(String(data.endTime)) - Date.parse(String(data.startTime));
  if (service && length > service.durationMin * 60_000) {
    throw new WriteError(
      "not_allowed",
      `You can propose a time as long as the service (${service.durationMin} minutes), not longer: a longer booking is the owner's to price. Tell the owner in a note (reply with internal: true) what you suggest.`,
      {
        fields: [{ path: "input.endTime", problem: "invalid", message: "no longer than the service" }],
        details: { reason: "owner_money", draft_for_owner: true },
      },
    );
  }
  const named = data.totalPrice as Money | undefined;
  // Left out, the price is the one the booking holds: the business's, unless the customer set it.
  const kept = named ?? item.payload.totalPrice;
  if (kept === undefined) return;
  if (named === undefined && !(await heldForPrice(db, item, "confirm"))) return;
  const ours = await cataloguePriceOf(db, serviceId, item.payload.partySize);
  if (ours && sameMoney(ours, kept)) return;
  throw new WriteError(
    "not_allowed",
    named === undefined
      ? "The customer's request holds a price we did not set, so only the owner can propose a time on it. Tell the owner in a note (reply with internal: true) the time and price you suggest."
      : "You can propose another time, not another price: leave totalPrice out to keep the price. Tell the owner in a note (reply with internal: true) the price you suggest.",
    {
      fields: [
        {
          path: "input.totalPrice",
          problem: named === undefined ? "missing" : "invalid",
          message: "only the owner sets a price",
        },
      ],
      details: { reason: "owner_money", draft_for_owner: true },
    },
  );
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
      event === "propose" ? (payload.proposed as { startTime?: string } | undefined)?.startTime : payload.startTime;
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
  startTime: string,
  audience: Audience | undefined,
  now: number,
): Promise<void> {
  const serviceId = (payload.reservationFor as { serviceId: string }).serviceId;
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
  let offered = false;
  if (start > now) {
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
  delete payload.proposed;
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
) {
  const q = payload.quote as QuoteTerms;
  const offered = payload.itemOffered as { name: string; serviceId?: string; productId?: string; sku?: string };
  const id = ulid();
  const type: ItemType = q.creates === "booking" ? "booking" : "order";
  const b = type === "booking" ? (booking ?? (await linkedBookingOf(db, payload))) : undefined;
  const linkedPayload = b ? b.payload : orderFromQuote(q, offered, payload);
  const parsed = payloadSchemas[type].parse(linkedPayload) as Record<string, unknown>;
  const state = type === "booking" ? "confirmed" : "accepted";
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
  const stored = hit.response as { view: ItemView; linked?: ItemView };
  return { view: stored.view, linked: stored.linked, replayed: true };
}

export type { Transition };
