import { eq } from "drizzle-orm";
import type { ConnectorCapabilities } from "../connectors/capability";
import {
  ConnectorError,
  isPropertySystem,
  type LinkState,
  type OutboundStay,
  type RunContext,
  type StayInventory,
} from "../connectors/sdk";
import { registerWriteResolver, type WriteRow, type WrittenRef, writeFirst } from "../connectors/write-first";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import type { JobHandler } from "../jobs/runner";
import { items, parties } from "../schema/tables";
import { type PropertySetup, readSetup } from "../stays/store";
import { STAY_WRITE_KIND, type StayWriteJob } from "../stays/transition";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";

/**
 * Stays written to the property's own system first (ADR-033 §4.3, ADR-032 write first): the job between
 * two batches. The stay is `booking` while the write is in flight, and becomes confirmed, or waits for
 * its deposit, only once the system answered with its own booking id; refused, or never found once the
 * resolver has looked, it lapses and nothing is promised. A stay is never written twice: the same key
 * goes with every try, and a write that may have landed is looked for before anything is decided.
 */

type StayPayload = PayloadOf<"stay">;

/** The key a stay's write carries: the system's reference for it, the same on every try. */
export function stayKey(itemId: string, op: StayWriteJob["op"], eventId?: string): string {
  return op === "reserve" ? `sd-${itemId}` : op === "cancel" ? `sd-${itemId}-c` : `sd-${itemId}-m-${eventId ?? ""}`;
}

function connectorCaller(connectorId: string, now: number): Caller {
  return {
    actor: { kind: "connector", id: `connector:${connectorId}`, channel: "connector" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

function systemCaller(now: number): Caller {
  return {
    actor: { kind: "system", id: STAY_WRITE_KIND, channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

/** The stay as the property's system is given it: its rooms by the system's ids, at the inbox's price. */
export async function outboundOf(
  db: Db,
  setup: PropertySetup,
  item: Item,
  key: string,
  withGuest: boolean,
): Promise<OutboundStay> {
  const p = item.payload as StayPayload;
  const total = p.quote?.total ?? p.totalPrice ?? { value: 0, currency: setup.property.currency };
  const share = Math.floor(total.value / p.rooms.length);
  const rest = total.value - share * p.rooms.length;
  let guest: OutboundStay["guest"];
  if (withGuest) {
    const [party] = await db.orm
      .select({ contact: parties.contact, name: parties.displayName })
      .from(parties)
      .where(eq(parties.id, item.partyId));
    const contact = (party?.contact ?? {}) as { name?: string; email?: string; phone?: string };
    const name = p.guests?.lead.name ?? contact.name ?? party?.name ?? "";
    if (name)
      guest = {
        name,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
      };
  }
  return {
    itemId: item.id,
    reference: shortRef(item.id),
    key,
    propertyId: setup.property.externalId ?? "",
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    rooms: p.rooms.map((r, i) => {
      const room = setup.rooms.find((x) => x.id === r.roomTypeId);
      const plan = setup.plans.find((x) => x.id === r.ratePlanId);
      return {
        roomId: room?.externalId ?? "",
        ...(plan?.externalId ? { rateId: plan.externalId } : {}),
        adults: r.adults,
        childrenAges: r.childrenAges,
        price: { value: share + (i === 0 ? rest : 0), currency: total.currency },
      };
    }),
    ...(guest ? { guest } : {}),
    ...(p.requests ? { notes: p.requests } : {}),
  };
}

async function linkOf(db: Db, connectorId: string, itemId: string): Promise<LinkState | null> {
  const { rows } = await db.client.query({
    sql: "SELECT external_id FROM connector_links WHERE connector_id = ? AND item_id = ?",
    params: [connectorId, itemId],
    method: "all",
  });
  const ext = rows[0]?.[0];
  return typeof ext === "string" ? { externalId: ext, etag: null, calendar: null } : null;
}

/** A note to the owner on the stay, and the stay marked for a person. */
async function tellOwner(db: Db, item: Item, text: string, now: number): Promise<void> {
  const system = systemCaller(now);
  await appendThreadEntry(db, system, item, text, "note");
  try {
    await setFlags(db, system, { itemId: item.id, flags: { needsHuman: true }, reason: "property_system" });
  } catch (error) {
    if (!(error instanceof WriteError && error.code === "version_conflict")) throw error;
  }
}

async function loadStay(db: Db, itemId: string): Promise<Item | null> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  return row && row.type === "stay" ? rowToItem(row) : null;
}

/** What the write's outcome does to the stay: confirmed (or waiting for its deposit), or lapsed. */
async function settleStay(
  db: Db,
  item: Item,
  connectorId: string,
  outcome: "written" | "refused",
  ref: WrittenRef | null,
  now: number,
  why?: string,
): Promise<string> {
  if (item.state !== "booking") return `the stay is ${item.state} now`;
  try {
    if (outcome === "written" && ref) {
      await transitionItem(db, connectorCaller(connectorId, now), {
        itemId: item.id,
        event: "written",
        input: { connectorId, externalId: ref.externalId.slice(0, 200) },
      });
      return `written: ${ref.externalId}`;
    }
    await transitionItem(db, connectorCaller(connectorId, now), {
      itemId: item.id,
      event: "write_refused",
      input: { note: (why ?? "The property's system did not take it.").slice(0, 2_000) },
    });
    return `not written: ${why ?? "refused"}`;
  } catch (error) {
    if (error instanceof WriteError && (error.code === "wrong_state" || error.code === "version_conflict"))
      return error.message;
    throw error;
  }
}

/**
 * Reads back what the system says of the stay's nights after our write: a system that takes writes it
 * cannot honour (an oversold night) shows fewer than none free, and ours is taken back.
 */
async function readBack(
  ctx: RunContext,
  def: { readonly stays: StayInventory },
  stay: OutboundStay,
): Promise<"ok" | "conflict"> {
  try {
    const read = await def.stays.ari(ctx, stay.propertyId, { from: stay.checkIn, to: stay.checkOut });
    const rows = Array.isArray(read) ? read : read.rows;
    const ours = new Set(stay.rooms.map((r) => r.roomId));
    return rows.some((r) => ours.has(r.roomId) && r.units < 0) ? "conflict" : "ok";
  } catch {
    return "ok";
  }
}

/** Runs one stay write. Answers what happened, for the job's note. */
export async function runStayWrite(
  db: Db,
  connectors: ConnectorCapabilities,
  job: StayWriteJob,
  now: number,
): Promise<string> {
  const item = await loadStay(db, job.itemId);
  if (!item) return "no such stay";
  const p = item.payload as StayPayload;
  const setup = await readSetup(db, p.propertyId);
  const connectorId = setup?.property.connectorId;
  if (!setup || !connectorId) {
    if (job.op === "reserve")
      return settleStay(db, item, "", "refused", null, now, "The property is not connected to its system any more.");
    return "not connected";
  }
  const conn = await connectors.contextFor(connectorId, now);
  const writer = conn?.definition.stayWriter;
  if (!conn || !writer || !isPropertySystem(conn.definition)) {
    if (job.op === "reserve") {
      return settleStay(
        db,
        item,
        connectorId,
        "refused",
        null,
        now,
        "The property's system could not be reached: the stay was not written.",
      );
    }
    await tellOwner(
      db,
      item,
      `Your system could not be reached to ${job.op === "cancel" ? "cancel" : "change"} stay ${shortRef(item.id)}: do it there.`,
      now,
    );
    return "not reachable";
  }
  const def = conn.definition;
  const key = stayKey(item.id, job.op, job.eventId);
  const confirmed = job.status === "confirmed";
  const stay = await outboundOf(db, setup, item, key, confirmed && job.op !== "cancel");
  const link = await linkOf(db, connectorId, item.id);
  const { guest: _guest, ...request } = stay;
  if (job.op === "cancel") {
    if (!link?.externalId) return "nothing written to cancel";
    const r = await writeFirst(db, {
      connectorId,
      itemId: item.id,
      op: "cancel",
      owner: "stays",
      key,
      request,
      now,
      async write() {
        await writer.cancel(conn.ctx, link);
        return { externalId: link.externalId as string };
      },
      async find() {
        return null;
      },
    });
    if (r.status === "refused") {
      await tellOwner(
        db,
        item,
        `Your system did not take the cancellation of ${shortRef(item.id)}: cancel it there. (${r.reason})`,
        now,
      );
    }
    if (r.status === "busy") throw new ConnectorError("unreachable", "another write for this stay is running");
    return `cancel: ${r.status}`;
  }
  const r = await writeFirst(db, {
    connectorId,
    itemId: item.id,
    op: job.op,
    owner: "stays",
    key,
    request,
    now,
    async write() {
      const written = await writer.put(conn.ctx, stay, job.op === "modify" ? link : null, job.status);
      if (!written.externalId) throw new ConnectorError("bad_response", "the system answered without its booking id");
      return { externalId: written.externalId };
    },
    async find() {
      const found = await writer.find(conn.ctx, stay);
      return found?.externalId ? { externalId: found.externalId } : null;
    },
    readBack: () => readBack(conn.ctx, def, stay),
    async rollback(ref) {
      await writer.cancel(conn.ctx, { externalId: ref.externalId, etag: null, calendar: null });
    },
  });
  if (job.op === "modify") {
    if (r.status === "refused" || r.status === "conflict") {
      await tellOwner(db, item, `Your system did not take the change to ${shortRef(item.id)}: change it there.`, now);
    }
    if (r.status === "busy") throw new ConnectorError("unreachable", "another write for this stay is running");
    return `modify: ${r.status}`;
  }
  switch (r.status) {
    case "written":
      return settleStay(db, item, connectorId, "written", r.ref, now);
    case "refused":
      return settleStay(db, item, connectorId, "refused", null, now, r.reason);
    case "conflict":
      return settleStay(
        db,
        item,
        connectorId,
        "refused",
        null,
        now,
        "The room was taken in the property's system a moment ago.",
      );
    case "pending":
      return "no answer yet: looked for again shortly";
    case "busy":
      throw new ConnectorError("unreachable", "another write for this stay is running");
  }
}

/** The job that writes stays to the property's system. */
export function stayWriteHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as StayWriteJob;
    return { note: await runStayWrite(db, connectors, p, now) };
  };
}

/**
 * Settles a stay write whose answer never came: looked for by its key, the stay confirmed when found,
 * lapsed when it is never found in the few minutes the resolver looks.
 */
export function registerStayResolver(connectors: ConnectorCapabilities): void {
  registerWriteResolver("stays", {
    async find(db: Db, row: WriteRow, now: number) {
      const item = await loadStay(db, row.itemId);
      if (!item) return null;
      const setup = await readSetup(db, (item.payload as StayPayload).propertyId);
      const conn = await connectors.contextFor(row.connectorId, now);
      if (!setup || !conn?.definition.stayWriter) return null;
      const found = await conn.definition.stayWriter.find(
        conn.ctx,
        await outboundOf(db, setup, item, row.idemKey, false),
      );
      return found?.externalId ? { externalId: found.externalId } : null;
    },
    async settled(db: Db, row: WriteRow, outcome, ref, now) {
      if (row.op !== "reserve") return;
      const item = await loadStay(db, row.itemId);
      if (!item) return;
      await settleStay(
        db,
        item,
        row.connectorId,
        outcome,
        ref,
        now,
        outcome === "refused" ? "The property's system never showed the stay: it was not written." : undefined,
      );
    },
  });
}
