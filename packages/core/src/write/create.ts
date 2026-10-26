import type { Statement } from "@surfingdog/platform";
import { audienceFor } from "../customer/audience";
import { copyFor } from "../customer/copy";
import type { Db } from "../db";
import {
  type Contact,
  type Item,
  type ItemFlags,
  type ItemType,
  itemFlagsSchema,
  payloadSchemas,
} from "../domain/types";
import { type IdentityInput, identityColumns, identityStatements, planMatch } from "../identity/match";
import { networksStopped, stopFollowsStatements, stopViaOf } from "../identity/stops";
import type { IdentityAnswer } from "../identity/types";
import { randomToken, ulid } from "../ids";
import { machines } from "../machine/tables";
import { insertOfferStatement, pointerOf } from "../negotiation/offers";
import { secretHash } from "../protocol/credentials";
import { readSettings } from "../settings/schema";
import { prepareStay } from "../stays/create";
import { hashJson, hashText } from "../util/canonical";
import { actorMeta, type Caller, isCustomer, isOwnerAssistant, nowOf, permissionKind } from "./caller";
import {
  diagnoseFailure,
  eventStatement,
  findIdempotent,
  hasEventListeners,
  idempotencyStatement,
  jobStatement,
  threadEntryStatement,
  webhookFanoutStatement,
} from "./common";
import { fromZod, WriteError } from "./errors";
import { NEGOTIATES, requestExpiry, requestRow } from "./offers";
import { planParty } from "./party";
import { type PricingFor, priceFromCatalogue } from "./pricing";
import { defaultSubject, type ItemView, viewFor } from "./views";

export interface CreateInput {
  readonly type: ItemType;
  readonly payload: unknown;
  readonly subject?: string | undefined;
  readonly locationId?: string | undefined;
  /** Who is asking, for human doors. Authenticated principals carry a party on the caller instead. */
  readonly contact?: Contact | undefined;
  /** A first message from the customer (form notes, the email body). */
  readonly message?: string | undefined;
  /** Dedupe key for the first message, e.g. an email Message-ID. */
  readonly messageId?: string | undefined;
  /**
   * A message that arrives already put aside as spam (ADR-026 §7), with why: it is made in the spam
   * state, closed, and tells nobody — no alert, no rule, no webhook. Only for a message.
   */
  readonly spam?: string | undefined;
  readonly flags?: Partial<ItemFlags> | undefined;
  /**
   * Who is asking, beyond the caller (ADR-017 §8.1): the signed agent, what the networks presented,
   * authenticated mail, a first contact about to be asked. It decides which party the item joins
   * and is written in the same batch; it is never part of the idempotency hash.
   */
  readonly identity?: IdentityInput | undefined;
  /**
   * The customer confirmed the request's summary before sending it (the confirm step, ADR-018 §5):
   * their request binds them, as their offer.
   */
  readonly confirmed?: boolean | undefined;
  /**
   * Who a customer's request is priced for (ADR-018 §4, Q3): the owner's rewards and the customer's
   * standing as this inbox knows it, worked out once by the door so the confirm step's summary and the
   * request as written hold the same price. Absent, catalogue lines are at the list price. Never part
   * of the idempotency hash.
   */
  readonly pricing?: PricingFor | undefined;
  /**
   * What the inbox itself adds to a stay it makes (an estimate from the property's rates, ADR-033):
   * written after everything the request carried of the kind is dropped. Internal only; never hashed.
   */
  readonly stayExtra?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The payload fields only the business writes: what was paid, when the goods went out and arrived, a
 * change to what was agreed. A customer's request never arrives holding them (ADR-018 §3.4, §7).
 */
const BUSINESS_FIELDS = ["paymentRef", "paidAmount", "paymentUrl", "fulfilledAt", "deliveredAt", "change"] as const;

export interface CreateResult {
  readonly view: ItemView;
  /**
   * Capability secret for anonymous creators: lets them read and cancel this item. Shown once: a
   * retry's answer carries it again only when the retry is signed by the key the item was made with.
   */
  readonly accessToken?: string | undefined;
  /**
   * On a retry: the first answer carried an access token, and this one does not, since the retry was
   * not signed by the key the item was made with. Said, so an assistant that lost the first answer
   * knows the token is gone rather than that there never was one.
   */
  readonly accessTokenWithheld?: true | undefined;
  readonly replayed: boolean;
  /** Who the inbox takes the customer for (ADR-017 §8.4); the public doors add it. */
  readonly identity?: IdentityAnswer | undefined;
}

/** How long a request's acknowledgement waits, so a rule that confirms it at once sends one email, not two. */
export const ACK_DELAY_MS = 90_000;
const ACKNOWLEDGED: ReadonlySet<string> = new Set(["booking", "order", "quote_request", "stay"]);

export async function createItem(db: Db, caller: Caller, input: CreateInput): Promise<CreateResult> {
  const now = nowOf(caller);
  const schema = payloadSchemas[input.type];
  if (!schema) throw new WriteError("invalid_input", `unknown item type ${String(input.type)}`);
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) throw fromZod(parsed.error, "payload");

  const idem = caller.idempotency;
  // Who is asking (the agent, the presentations) is not the request: a retry carrying a fresh
  // signature or a pass presented again is the same request.
  const { identity: _identity, confirmed: _confirmed, pricing: _pricing, stayExtra: _extra, ...hashed } = input;
  const requestHash = idem ? await hashJson({ op: "create", scope: idem.scope, input: hashed }) : undefined;
  if (idem) {
    const hit = await findIdempotent(db, idem);
    if (hit) return replay(db, caller, hit, requestHash);
  }
  // A customer is answered in the business's words: its language (theirs, when they gave one) and
  // its time zone.
  const audience = isCustomer(caller)
    ? await audienceFor(db, { locale: input.contact?.locale ?? caller.locale ?? null })
    : undefined;
  // Nobody books a time that has started: a request for one is refused, in the customer's words.
  // One inside the minimum notice is taken, and waits for a person (no rule confirms it).
  if (audience && input.type === "booking") {
    const start = Date.parse((parsed.data as { startTime: string }).startTime);
    if (start <= now) {
      const message = copyFor(audience.lang).problems.pastStart;
      throw new WriteError("invalid_input", message, {
        fields: [{ path: "payload.startTime", problem: "invalid", message }],
      });
    }
  }
  // The business sets its prices (ADR-018 §3.1, §3.2): what a customer's request says a catalogue
  // product or a fixed-price service costs is kept beside the price, never as it. The owner's AI
  // making a request itself is priced the same way: time yes, money no (the founder, 23 September 2026),
  // so a figure of its own is never the price, and one the catalogue does not give waits for a person.
  // The price is the customer's own: the owner's reward for their record, when they earned one (Q3).
  const priced =
    isCustomer(caller) || isOwnerAssistant(caller)
      ? await priceFromCatalogue(
          db,
          input.type,
          parsed.data as Record<string, unknown>,
          isCustomer(caller) ? input.pricing : undefined,
        )
      : { payload: parsed.data as Record<string, unknown>, unpriced: false };
  // What is stored is read back through the same schema: a priced payload it would refuse (a total
  // too large to write down exactly) is refused here, never written for every later read to fail on.
  const checked = schema.safeParse(priced.payload);
  if (!checked.success) throw fromZod(checked.error, "payload");
  const payload = checked.data as Record<string, unknown>;
  // Only the inbox says where a negotiation stands, and what the business proposed or quoted: a
  // request never arrives holding the business's answer.
  delete payload.offer;
  delete payload.proposed;
  delete payload.quote;
  // Nor what only the business records: a payment, the goods' delivery, a change to a promise. (A price
  // chosen for them is the pricing's alone: it drops one the request carried.)
  if (isCustomer(caller)) for (const field of BUSINESS_FIELDS) delete payload[field];
  // A stay is checked against its property and written with its times (ADR-033), whoever makes it.
  const stay =
    input.type === "stay"
      ? await prepareStay(db, payload, input.stayExtra, {
          now,
          person: !isCustomer(caller) && !isOwnerAssistant(caller),
        })
      : undefined;

  // Customers the business already knows (ADR-017 §8.2): a strong match joins its party, a weak one
  // gets a party of its own that names the known one; either way the create does it, in its batch.
  const match = await planMatch(db, {
    callerPartyId: caller.actor.partyId,
    contact: input.contact,
    identity: input.identity,
    customer: isCustomer(caller),
  });
  const party = await planParty(
    db,
    {
      partyId: match.joinPartyId,
      contact: input.contact,
      kind:
        caller.actor.kind === "customer_agent" ? "agent" : caller.actor.kind === "customer_human" ? "human" : "unknown",
    },
    now,
  );
  // A customer who asked the business not to use booking networks (the founder, 23 September 2026): the
  // party this request joins or starts is stopped too, and nothing a network said is written on it —
  // its receipts then go to no network. Checked here as well as at the door, so every creator
  // (a shop's connector, the owner) keeps the stop.
  // Not by a weak match: "may be" a stopped customer, by a phone a family shares, stops nobody.
  const stopped = await networksStopped(db, { partyIds: [match.joinPartyId], contact: input.contact });
  const identity: IdentityInput | undefined =
    stopped && input.identity ? { ...input.identity, presentations: [], issueAt: [], rulesDelayMs: 0 } : input.identity;
  const who = identityColumns(match, identity);
  const machine = machines[input.type];
  const spam = input.type === "message" && input.spam ? input.spam : null;
  const initial = spam ? "spam" : machine.initial;
  const id = ulid();
  const flags = itemFlagsSchema.parse({
    ...input.flags,
    sandbox: caller.sandbox || input.flags?.sandbox === true,
    ...(caller.viaNetwork ? { carried: true } : {}),
  });
  const anonymous = isCustomer(caller) && !caller.actor.partyId;
  const accessToken = anonymous ? randomToken(24) : undefined;
  const accessTokenHash = accessToken ? await hashText(accessToken) : null;
  const subject = input.subject ?? defaultSubject(input.type, payload);
  const item = {
    id,
    type: input.type,
    state: initial,
    version: 1,
    partyId: party.partyId,
    locationId: input.locationId ?? stay?.locationId ?? null,
    channel: caller.actor.channel,
    subject,
    flags,
    linkedItemId: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    closedAt: null,
    payload,
  } as Item;
  const eventId = ulid();
  // The request is the customer's first offer (ADR-018 §1). One a customer sent lapses by its clock,
  // so nobody is bound by a request left unanswered; one the business wrote down itself (the owner,
  // a shop's system, a connector) waits for it with none, until the customer next answers.
  const settings = NEGOTIATES.has(input.type) ? await readSettings(db) : undefined;
  const requestExpiresAt = settings && isCustomer(caller) ? requestExpiry(input.type, payload, settings, now) : null;
  const request = settings
    ? await requestRow({
        itemId: id,
        type: input.type,
        payload,
        caller,
        validThrough: requestExpiresAt,
        eventId,
        now,
        confirmed: input.confirmed === true,
      })
    : undefined;
  if (request) payload.offer = pointerOf(request);
  const view = viewFor(item, permissionKind(caller), undefined, undefined, audience);
  const response = { view, accessToken };

  const statements: Statement[] = [];
  if (idem && requestHash) statements.push(idempotencyStatement(idem, requestHash, 201, response, id, now));
  statements.push(...party.statements);
  statements.push({
    sql: `INSERT INTO items (id, type, state, version, party_id, location_id, channel, subject, linked_item_id, access_token_hash, payload, flags,
            agent_thumbprint, agent_level, agent_directory, customer_match, possible_party_id, created_at, updated_at, closed_at, request_expires_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${spam ? "?" : "NULL"}, ?)`,
    params: [
      id,
      input.type,
      initial,
      party.partyId,
      input.locationId ?? stay?.locationId ?? null,
      caller.actor.channel,
      subject,
      accessTokenHash,
      JSON.stringify(payload),
      JSON.stringify(flags),
      who.agentThumbprint,
      who.agentLevel,
      who.agentDirectory,
      who.customerMatch,
      who.possiblePartyId,
      now,
      now,
      ...(spam ? [now] : []),
      requestExpiresAt,
    ],
    method: "run",
  });
  if (request) statements.push(insertOfferStatement(request));
  if (stay) statements.push(...stay.statements);
  if (stopped) {
    // The party stopped, and the address this request gave fingerprinted: a request from it alone
    // later is stopped at the door, even if it is an address of theirs the inbox had not seen.
    statements.push(
      ...(await stopFollowsStatements(
        {
          partyId: party.partyId,
          contact: input.contact,
          via: await stopViaOf(db, [match.joinPartyId], input.contact),
        },
        now,
      )),
    );
  }
  // A pass the network had to be asked about, found to be a stopped customer's: its hash is kept on
  // their link, so it is recognised here next time without asking; what the network said is not.
  if (stopped && match.joinPartyId) {
    for (const p of input.identity?.presentations ?? []) {
      const passHash = p.passHash ?? (p.pass ? await secretHash(p.pass) : null);
      if (!passHash) continue;
      statements.push({
        sql: `UPDATE person_links SET pass_hash = ?, person = NULL, updated_at = ?
               WHERE network = ? AND ppid = ? AND party_id = ?`,
        params: [passHash, now, p.network, p.ppid, match.joinPartyId],
        method: "run",
      });
    }
  }
  statements.push(...identityStatements(id, party.partyId, match, identity, now));
  statements.push(
    eventStatement({
      id: eventId,
      itemId: id,
      seq: 1,
      event: "create",
      fromState: null,
      toState: initial,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      meta: {
        channel: caller.actor.channel,
        tier: caller.tier,
        sandbox: flags.sandbox,
        // A price the business did not set: no rule confirms or accepts it (ADR-018 §3.2).
        ...(priced.unpriced ? { unpriced: true } : {}),
        // A price the owner's reward gave this customer (ADR-018 §4): for the owner's history.
        ...(payload.personalised ? { personalised: true } : {}),
        // Put aside as it arrived (ADR-026 §7): why, for the owner who looks under Spam.
        ...(spam ? { spam } : {}),
        ...actorMeta(caller),
      },
      now,
    }),
  );
  if (input.message) {
    statements.push(
      threadEntryStatement({
        id: ulid(),
        itemId: id,
        direction: isCustomer(caller) ? "in" : "note",
        channel: caller.actor.channel,
        actorKind: caller.actor.kind,
        actorId: caller.actor.id,
        partyId: party.partyId,
        subject,
        body: input.message,
        messageId: input.messageId ?? null,
        now,
      }),
    );
  }
  // A message put aside as spam as it arrived tells nobody and moves nothing: no alert, no rule, no
  // webhook. It waits under Spam for the owner.
  if (spam) {
    try {
      await db.batch(statements);
    } catch (error) {
      const hit = await diagnoseFailure(db, error, { idem, requestHash });
      return replay(db, caller, hit, requestHash);
    }
    return { view, accessToken, replayed: false };
  }
  statements.push(
    jobStatement("notify", { to: "owner", itemId: id, event: "create", eventId }, now, {
      dedupeKey: `notify:${eventId}:owner`,
    }),
  );
  // The customer hears that their request arrived, a moment later: a rule that answers it at once
  // sends its answer instead of both. Never for a message: an automatic reply to a mail could loop.
  if (isCustomer(caller) && ACKNOWLEDGED.has(input.type)) {
    statements.push(
      jobStatement("notify", { to: "customer", itemId: id, event: "create", eventId }, now, {
        dedupeKey: `notify:${eventId}:customer`,
        runAt: now + ACK_DELAY_MS,
      }),
    );
  }
  // A first contact's answers land in a second batch; the rules wait a moment for them (§8.1).
  const rulesDelay = Math.max(0, Math.min(identity?.rulesDelayMs ?? 0, 60_000));
  statements.push(
    jobStatement("rules", { itemId: id, eventId, trigger: "item.created" }, now, {
      dedupeKey: `rules:${eventId}`,
      ...(rulesDelay ? { runAt: now + rulesDelay } : {}),
    }),
  );
  if (await hasEventListeners(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${input.type}.create`, itemId: id }, now));
  }

  try {
    await db.batch(statements);
  } catch (error) {
    const hit = await diagnoseFailure(db, error, { idem, requestHash });
    return replay(db, caller, hit, requestHash);
  }
  return { view, accessToken, replayed: false };
}

/**
 * A retry of a create, answered from what was stored. The access token goes back only to a retry
 * signed by the agent's own key the item was made with. Nothing else tells two anonymous callers
 * apart: the scope a retry is looked up in is a fingerprint of the request's address and user agent,
 * which many people share (one address behind a carrier's NAT, an assistant platform's servers) and a
 * caller can choose, so anyone who sent the same key and body from it would otherwise get the token,
 * and with it the item's whole thread. Any other retry gets the answer without it, and is told so
 * (`accessTokenWithheld`): the token is shown once.
 */
async function replay(
  db: Db,
  caller: Caller,
  hit: { requestHash: string; response: unknown },
  requestHash: string | undefined,
): Promise<CreateResult> {
  if (hit.requestHash !== requestHash) {
    throw new WriteError("idempotency_mismatch", "this idempotency key was already used with a different request");
  }
  const stored = hit.response as { view: ItemView; accessToken?: string };
  if (!stored.accessToken) return { view: stored.view, replayed: true };
  if (await sameSigner(db, caller, stored.view.item.id)) {
    return { view: stored.view, accessToken: stored.accessToken, replayed: true };
  }
  return { view: stored.view, accessTokenWithheld: true, replayed: true };
}

/**
 * Whether the caller's verified signature is by the key the item was made with, and that key is the
 * agent's own. A platform's key (Web Bot Auth: a key its directory lists) signs for every user of the
 * platform, who also share its addresses and its user agent, so it tells none of them apart.
 */
async function sameSigner(db: Db, caller: Caller, itemId: string): Promise<boolean> {
  const agent = caller.agent;
  if (!agent || agent.level === "none" || !agent.thumbprint || agent.platform) return false;
  const { rows } = await db.client.query({
    sql: "SELECT agent_thumbprint FROM items WHERE id = ?",
    params: [itemId],
    method: "all",
  });
  const made = rows[0]?.[0];
  return typeof made === "string" && made === agent.thumbprint;
}
