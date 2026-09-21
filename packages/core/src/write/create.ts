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
import { randomToken, ulid } from "../ids";
import { machines } from "../machine/tables";
import { hashJson, hashText } from "../util/canonical";
import { type Caller, isCustomer, nowOf } from "./caller";
import {
  diagnoseFailure,
  eventStatement,
  findIdempotent,
  idempotencyStatement,
  jobStatement,
  threadEntryStatement,
} from "./common";
import { fromZod, WriteError } from "./errors";
import { planParty } from "./party";
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
}

export interface CreateResult {
  readonly view: ItemView;
  /** Capability secret for anonymous creators: lets them read and cancel this item. Shown once. */
  readonly accessToken?: string | undefined;
  readonly replayed: boolean;
}

export async function createItem(db: Db, caller: Caller, input: CreateInput): Promise<CreateResult> {
  const now = nowOf(caller);
  const schema = payloadSchemas[input.type];
  if (!schema) throw new WriteError("invalid_input", `unknown item type ${String(input.type)}`);
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) throw fromZod(parsed.error, "payload");
  const payload = parsed.data as Record<string, unknown>;

  const idem = caller.idempotency;
  const requestHash = idem ? await hashJson({ op: "create", scope: idem.scope, input }) : undefined;
  if (idem) {
    const hit = await findIdempotent(db, idem);
    if (hit) return replay(hit, requestHash);
  }

  const party = await planParty(
    db,
    {
      partyId: caller.actor.partyId,
      contact: input.contact,
      kind:
        caller.actor.kind === "customer_agent" ? "agent" : caller.actor.kind === "customer_human" ? "human" : "unknown",
    },
    now,
  );
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
  const view = viewFor(item, caller.actor.kind);
  const response = { view, accessToken };
  const eventId = ulid();

  const statements: Statement[] = [];
  if (idem && requestHash) statements.push(idempotencyStatement(idem, requestHash, 201, response, id, now));
  statements.push(...party.statements);
  statements.push({
    sql: "INSERT INTO items (id, type, state, version, party_id, location_id, channel, subject, linked_item_id, access_token_hash, payload, flags, created_at, updated_at, closed_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)",
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
      now,
      now,
    ],
    method: "run",
  });
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
      meta: { channel: caller.actor.channel, tier: caller.tier, sandbox: flags.sandbox },
      now,
    }),
  );
  if (input.message) {
    statements.push(
      threadEntryStatement({
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
  statements.push(
    jobStatement("rules", { itemId: id, eventId, trigger: "item.created" }, now, { dedupeKey: `rules:${eventId}` }),
  );

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
