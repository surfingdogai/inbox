import type { Statement } from "@surfingdog/platform";
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
import type { IdentityAnswer } from "../identity/types";
import { randomToken, ulid } from "../ids";
import { machines } from "../machine/tables";
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
import { fromZod, WriteError } from "./errors";
import { planParty } from "./party";
import { priceFromCatalogue } from "./pricing";
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
  readonly flags?: Partial<ItemFlags> | undefined;
  /**
   * Who is asking, beyond the caller (ADR-017 §8.1): the signed agent, what the networks presented,
   * authenticated mail, a first contact about to be asked. It decides which party the item joins
   * and is written in the same batch; it is never part of the idempotency hash.
   */
  readonly identity?: IdentityInput | undefined;
}

export interface CreateResult {
  readonly view: ItemView;
  /** Capability secret for anonymous creators: lets them read and cancel this item. Shown once. */
  readonly accessToken?: string | undefined;
  readonly replayed: boolean;
  /** Who the inbox takes the customer for (ADR-017 §8.4); the public doors add it. */
  readonly identity?: IdentityAnswer | undefined;
}

export async function createItem(db: Db, caller: Caller, input: CreateInput): Promise<CreateResult> {
  const now = nowOf(caller);
  const schema = payloadSchemas[input.type];
  if (!schema) throw new WriteError("invalid_input", `unknown item type ${String(input.type)}`);
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) throw fromZod(parsed.error, "payload");

  const idem = caller.idempotency;
  // Who is asking (the agent, the presentations) is not the request: a retry carrying a fresh
  // signature or a pass presented again is the same request.
  const { identity: _identity, ...hashed } = input;
  const requestHash = idem ? await hashJson({ op: "create", scope: idem.scope, input: hashed }) : undefined;
  if (idem) {
    const hit = await findIdempotent(db, idem);
    if (hit) return replay(hit, requestHash);
  }
  // The business sets its prices (ADR-018 §3.1, §3.2): what a customer's request says a catalogue
  // product or a fixed-price service costs is kept beside the price, never as it.
  const priced = isCustomer(caller)
    ? await priceFromCatalogue(db, input.type, parsed.data as Record<string, unknown>)
    : { payload: parsed.data as Record<string, unknown>, unpriced: false };
  // What is stored is read back through the same schema: a priced payload it would refuse (a total
  // too large to write down exactly) is refused here, never written for every later read to fail on.
  const checked = schema.safeParse(priced.payload);
  if (!checked.success) throw fromZod(checked.error, "payload");
  const payload = checked.data as Record<string, unknown>;

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
  const who = identityColumns(match, input.identity);
  const machine = machines[input.type];
  const id = ulid();
  const flags = itemFlagsSchema.parse({ ...input.flags, sandbox: caller.sandbox || input.flags?.sandbox === true });
  const anonymous = isCustomer(caller) && !caller.actor.partyId;
  const accessToken = anonymous ? randomToken(24) : undefined;
  const accessTokenHash = accessToken ? await hashText(accessToken) : null;
  const subject = input.subject ?? defaultSubject(input.type, payload);
  const item = {
    id,
    type: input.type,
    state: machine.initial,
    version: 1,
    partyId: party.partyId,
    locationId: input.locationId ?? null,
    channel: caller.actor.channel,
    subject,
    flags,
    linkedItemId: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    closedAt: null,
    payload,
  } as Item;
  const view = viewFor(item, permissionKind(caller));
  const response = { view, accessToken };
  const eventId = ulid();

  const statements: Statement[] = [];
  if (idem && requestHash) statements.push(idempotencyStatement(idem, requestHash, 201, response, id, now));
  statements.push(...party.statements);
  statements.push({
    sql: `INSERT INTO items (id, type, state, version, party_id, location_id, channel, subject, linked_item_id, access_token_hash, payload, flags,
            agent_thumbprint, agent_level, agent_directory, customer_match, possible_party_id, created_at, updated_at, closed_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      id,
      input.type,
      machine.initial,
      party.partyId,
      input.locationId ?? null,
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
    ],
    method: "run",
  });
  statements.push(...identityStatements(id, party.partyId, match, input.identity, now));
  statements.push(
    eventStatement({
      id: eventId,
      itemId: id,
      seq: 1,
      event: "create",
      fromState: null,
      toState: machine.initial,
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      meta: {
        channel: caller.actor.channel,
        tier: caller.tier,
        sandbox: flags.sandbox,
        // A price the business did not set: no rule confirms or accepts it (ADR-018 §3.2).
        ...(priced.unpriced ? { unpriced: true } : {}),
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
  statements.push(
    jobStatement("notify", { to: "owner", itemId: id, event: "create", eventId }, now, {
      dedupeKey: `notify:${eventId}:owner`,
    }),
  );
  // A first contact's answers land in a second batch; the rules wait a moment for them (§8.1).
  const rulesDelay = Math.max(0, Math.min(input.identity?.rulesDelayMs ?? 0, 60_000));
  statements.push(
    jobStatement("rules", { itemId: id, eventId, trigger: "item.created" }, now, {
      dedupeKey: `rules:${eventId}`,
      ...(rulesDelay ? { runAt: now + rulesDelay } : {}),
    }),
  );
  if (await hasActiveWebhook(db)) {
    statements.push(webhookFanoutStatement({ id: eventId, type: `${input.type}.create`, itemId: id }, now));
  }

  try {
    await db.batch(statements);
  } catch (error) {
    const hit = await diagnoseFailure(db, error, { idem, requestHash });
    return replay(hit, requestHash);
  }
  return { view, accessToken, replayed: false };
}

function replay(hit: { requestHash: string; response: unknown }, requestHash: string | undefined): CreateResult {
  if (hit.requestHash !== requestHash) {
    throw new WriteError("idempotency_mismatch", "this idempotency key was already used with a different request");
  }
  const stored = hit.response as { view: ItemView; accessToken?: string };
  return { view: stored.view, accessToken: stored.accessToken, replayed: true };
}
