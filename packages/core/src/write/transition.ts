import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { type Item, type ItemType, payloadSchemas } from "../domain/types";
import { ulid } from "../ids";
import { resolveTransition, type Transition } from "../machine/machine";
import { outcomeOf } from "../machine/outcomes";
import { machines, noteInput } from "../machine/tables";
import { items, resources, services } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { hashJson, hashText } from "../util/canonical";
import { actorMeta, type Caller, isCustomer, nowOf, permissionKind } from "./caller";
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
import { fromZod, WriteError } from "./errors";
import { assertBusinessPriced } from "./pricing";
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
  const requestHash = idem ? await hashJson({ op: "transition", scope: idem.scope, input }) : undefined;
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
  // A rule never makes the promise on a price the business did not set (ADR-018 §3.2).
  if (caller.actor.kind === "rule") await assertBusinessPriced(db, item, t.event);
  // Every transition takes an optional note; some take more.
  const parsedInput = (t.input ?? noteInput).safeParse(input.input ?? {});
  if (!parsedInput.success) throw fromZod(parsedInput.error, "input");
  const data = parsedInput.data as Record<string, unknown>;

  const settings = await readSettings(db);
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

  // Guards read, never write; what they read is prefetched here.
  let claimPlan: { resourceKey: string; claims: [number, number][] } | undefined;
  for (const guard of t.guards ?? []) {
    switch (guard) {
      case "customer_owns_item":
        break; // asserted above for every customer write
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
        if (item.type !== "booking") break;
        const spec = await slotSpecFor(db, payload);
        const buckets = bucketsFor(spec, String(payload.startTime), String(payload.endTime));
        const taken = await readClaims(db, spec.resourceKey, buckets, item.id);
        const plan = planClaims(spec, buckets, taken);
        if (!plan.ok) {
          throw new WriteError("slot_taken", "that time is fully booked", {
            details: { guard, bucket: plan.fullBucket, capacity: spec.capacity },
          });
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
    const linked = await planLinkedItem(db, caller, item, payload, eventId, now);
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
  const view = viewFor(updated, permissionKind(caller), undefined, hidden);
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
      meta: { channel: caller.actor.channel, tier: caller.tier, input: data, ...actorMeta(caller) },
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
        direction: isCustomer(caller) ? "in" : "out",
        channel: caller.actor.channel,
        actorKind: caller.actor.kind,
        actorId: caller.actor.id,
        partyId: isCustomer(caller) ? item.partyId : null,
        body: note,
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

  try {
    await db.batch(statements);
  } catch (error) {
    const hit = await diagnoseFailure(db, error, {
      idem,
      requestHash,
      itemId: item.id,
      expectedVersion: item.version,
      claims: claimPlan,
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
  if (type === "quote_request" && event === "quote") payload.quote = data;
  if (type === "order" && event === "record_payment") {
    payload.paymentRef = data.paymentRef;
    if (data.amount) payload.paidAmount = data.amount;
  }
  if (type === "order" && event === "request_payment" && data.paymentUrl) payload.paymentUrl = data.paymentUrl;
  if (type === "refund" && event === "refund") payload.paymentRef = data.paymentRef;
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

/** An accepted quote becomes an order (or a booking when it names a service and a time), in the same batch. */
async function planLinkedItem(
  db: Db,
  caller: Caller,
  quote: Item,
  payload: Record<string, unknown>,
  causationId: string,
  now: number,
) {
  const q = payload.quote as {
    totalPrice: { value: number; currency: string };
    lines: { name: string; quantity: number; price: unknown }[];
    notes?: string;
    creates: "booking" | "order";
  };
  const offered = payload.itemOffered as { name: string; serviceId?: string; productId?: string; sku?: string };
  const id = ulid();
  let type: ItemType = "order";
  let linkedPayload: Record<string, unknown>;
  const requestedFor = payload.requestedFor as string | undefined;
  if (q.creates === "booking" && offered.serviceId && requestedFor) {
    const [service] = await db.orm
      .select({ durationMin: services.durationMin })
      .from(services)
      .where(eq(services.id, offered.serviceId));
    if (service) {
      type = "booking";
      const start = Date.parse(requestedFor);
      linkedPayload = {
        reservationFor: { serviceId: offered.serviceId, name: offered.name },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + service.durationMin * 60_000).toISOString(),
        totalPrice: q.totalPrice,
        notes: q.notes,
      };
    } else {
      linkedPayload = orderFromQuote(q, offered, payload);
    }
  } else {
    linkedPayload = orderFromQuote(q, offered, payload);
  }
  const parsed = payloadSchemas[type].parse(linkedPayload) as Record<string, unknown>;
  const machine = machines[type];
  const subject = defaultSubject(type, parsed);
  const item = {
    id,
    type,
    state: machine.initial,
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
        machine.initial,
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
      toState: machine.initial,
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
    // The customer each network presented for the quote is the customer of what it became
    // (ADR-017 §3.1): its receipts name the same presentations.
    {
      sql: `INSERT OR IGNORE INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at)
            SELECT ?, network, presentation_id, ppid, person, created_at FROM item_presentations WHERE item_id = ?`,
      params: [id, quote.id],
      method: "run",
    },
  ];
  return { id, type, eventId: linkedEventId, statements, view: viewFor(item, permissionKind(caller)) };
}

function orderFromQuote(
  q: {
    totalPrice: { value: number; currency: string };
    lines: { name: string; quantity: number; price: unknown }[];
    notes?: string;
  },
  offered: { name: string; productId?: string; sku?: string },
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const lines = q.lines.length
    ? q.lines
    : [{ name: offered.name, quantity: Number(payload.quantity ?? 1), price: q.totalPrice }];
  return {
    orderedItem: lines.map((l) => ({ ...l, productId: offered.productId, sku: offered.sku })),
    totalPrice: q.totalPrice,
    shippingAddress: payload.deliveryAddress,
    notes: q.notes,
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
