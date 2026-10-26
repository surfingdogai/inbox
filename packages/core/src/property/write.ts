import { eq } from "drizzle-orm";
import type { ConnectorCapabilities } from "../connectors/capability";
import {
  ConnectorError,
  isPropertySystem,
  type LinkState,
  type OutboundStay,
  type RunContext,
  type StayWriter,
} from "../connectors/sdk";
import { registerWriteResolver, type WriteRow, type WrittenRef, writeFirst } from "../connectors/write-first";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, Money, PayloadOf } from "../domain/types";
import type { JobHandler } from "../jobs/runner";
import { items, parties } from "../schema/tables";
import { type PropertySetup, readSetup } from "../stays/store";
import { paidOf, STAY_WRITE_KIND, type StayWriteJob } from "../stays/transition";
import { addDays } from "../util/zoned";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";

/**
 * Stays written to the property's own system first (ADR-037 §4.3, ADR-036 write first): the job between
 * two batches. The stay is `booking` while the write is in flight, and becomes confirmed, or waits for
 * its deposit, only once the system answered with its own booking id; refused, or never found once the
 * resolver has looked, it lapses and nothing is promised. A stay is never written twice: the same key
 * goes with every try, and a write that may have landed is looked for before anything is decided.
 *
 * A change both sides agreed is written the same way before it is applied: the stay keeps its dates
 * until the system took the new ones, and one the system refuses, or takes only to show oversold, is
 * put back as it was — never cancelled. A stay paid for after it was written provisional is written
 * again as confirmed with its guest; a no-show lets the nights after its first go there.
 */

type StayPayload = PayloadOf<"stay">;
type Purpose = NonNullable<StayWriteJob["purpose"]>;

/** The key a stay's write carries: the system's reference for it, the same on every try of that write. */
export function stayKey(
  itemId: string,
  op: StayWriteJob["op"],
  eventId?: string,
  opts: { readonly purpose?: Purpose | undefined; readonly again?: boolean | undefined } = {},
): string {
  if (op === "reserve") return opts.again && eventId ? `sd-${itemId}-r-${eventId}` : `sd-${itemId}`;
  if (op === "cancel") return eventId ? `sd-${itemId}-c-${eventId}` : `sd-${itemId}-c`;
  return `sd-${itemId}-${opts.purpose ?? "change"}-${eventId ?? ""}`;
}

/** What a modify's key says it was for. */
function purposeOfKey(key: string): Purpose {
  const m = /^sd-[0-9A-Za-z]+-(change|confirm|release)-/.exec(key);
  return (m?.[1] as Purpose | undefined) ?? "change";
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

/** The stay as it is written, when it differs from the stay as it stands: a change's dates and rooms. */
export interface StayShape {
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: StayPayload["rooms"];
  readonly total: Money;
}

/** The stay as the property's system is given it: its rooms by the system's ids, at the inbox's price. */
export async function outboundOf(
  db: Db,
  setup: PropertySetup,
  item: Item,
  key: string,
  withGuest: boolean,
  shape?: StayShape,
): Promise<OutboundStay> {
  const p = item.payload as StayPayload;
  const rooms = shape?.rooms ?? p.rooms;
  const total = shape?.total ?? p.quote?.total ?? p.totalPrice ?? { value: 0, currency: setup.property.currency };
  const share = Math.floor(total.value / rooms.length);
  const rest = total.value - share * rooms.length;
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
  // What is paid and what is left for the property, said only with the guest: amounts, never a card.
  const paid = paidOf(p);
  const atProperty = (p.payments?.schedules ?? [])
    .filter((s) => s.status === "at_property" && s.amount.currency === total.currency)
    .reduce((a, s) => a + s.amount.value, 0);
  return {
    itemId: item.id,
    reference: shortRef(item.id),
    key,
    propertyId: setup.property.externalId ?? "",
    checkIn: shape?.checkIn ?? p.checkIn,
    checkOut: shape?.checkOut ?? p.checkOut,
    rooms: rooms.map((r, i) => {
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
    ...(guest && paid.currency === total.currency
      ? { amounts: { paid, atProperty: { value: atProperty, currency: total.currency } } }
      : {}),
  };
}

/**
 * Puts a change taken back as it was: the system's own way of restoring a stay where it has one, its
 * nights a moment ago counted as its own. Answers whether those nights read back oversold now (another
 * channel took one meanwhile), for the owner to be told; null when it could not say.
 */
async function putBack(ctx: RunContext, writer: StayWriter, previous: OutboundStay, link: LinkState) {
  const back = writer.restore
    ? await writer.restore(ctx, previous, link)
    : await writer.put(ctx, previous, link, "confirmed");
  if (!writer.oversold) return false;
  try {
    return await writer.oversold(ctx, previous, back.externalId ? back : link);
  } catch {
    return null;
  }
}

/** The stay as an agreed change would make it, while the change waits to be written. */
function changeShape(p: StayPayload): StayShape | null {
  const c = p.change;
  if (!c) return null;
  const total = c.quote?.total ?? p.quote?.total ?? p.totalPrice;
  if (!total) return null;
  return { checkIn: c.checkIn, checkOut: c.checkOut, rooms: c.rooms ?? p.rooms, total };
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

/** What a change's write does to the stay: the change applied once the system took it, else dropped. */
async function settleChange(
  db: Db,
  item: Item,
  connectorId: string,
  outcome: "written" | "refused",
  now: number,
  ownerNote: string | null,
): Promise<string> {
  const p = item.payload as StayPayload;
  if (item.state !== "confirmed" || !p.change?.writing) return `no change waits on ${shortRef(item.id)} now`;
  try {
    // The owner's note goes on the stay for them alone, after: never in the guest's email.
    await transitionItem(db, connectorCaller(connectorId, now), {
      itemId: item.id,
      event: outcome === "written" ? "change_written" : "change_refused",
    });
  } catch (error) {
    if (
      error instanceof WriteError &&
      (error.code === "wrong_state" || error.code === "version_conflict" || error.code === "guard_failed")
    ) {
      return error.message;
    }
    throw error;
  }
  if (outcome === "refused" && ownerNote) {
    const fresh = await loadStay(db, item.id);
    if (fresh) await tellOwner(db, fresh, ownerNote, now);
  }
  return outcome === "written" ? "change written" : "change not written";
}

/**
 * Reads back, from the system's own word, whether our write left any of the stay's nights oversold: its
 * overbooking flag, or its count of bookings against its rooms (`StayWriter.oversold`). Unknown when it
 * could not say: never taken as fine.
 */
async function readBack(
  ctx: RunContext,
  writer: StayWriter,
  stay: OutboundStay,
  ref: WrittenRef,
): Promise<"ok" | "conflict" | "unknown"> {
  if (!writer.oversold) return "ok";
  try {
    return (await writer.oversold(ctx, stay, { externalId: ref.externalId, etag: null, calendar: null }))
      ? "conflict"
      : "ok";
  } catch {
    return "unknown";
  }
}

/** Which modifies are about the nights, and so read back: a change. A status (confirm) or a release is not. */
const readsBack = (job: StayWriteJob): boolean =>
  job.op === "reserve" || (job.op === "modify" && (job.purpose ?? "change") === "change");

/** The states a modify still applies to, by what it is for. */
const MODIFY_STATES: Readonly<Record<Purpose, readonly string[]>> = {
  change: ["confirmed"],
  confirm: ["confirmed", "checked_in"],
  release: ["no_show"],
};

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
  const ref = shortRef(item.id);
  const purpose: Purpose | null = job.op === "modify" ? (job.purpose ?? "change") : null;
  // A modify for a stay that has moved on since (cancelled, a change dropped) writes nothing: a cancelled
  // stay is never brought back on the system by a change that came after.
  if (purpose && !MODIFY_STATES[purpose].includes(item.state)) return `the stay is ${item.state} now`;
  if (purpose === "change" && !p.change?.writing) return "no change waits to be written";
  const setup = await readSetup(db, p.propertyId);
  const connectorId = setup?.property.connectorId;
  const unreachable = async (why: string): Promise<string> => {
    if (job.op === "reserve") return settleStay(db, item, connectorId ?? "", "refused", null, now, why);
    if (purpose === "change") {
      return settleChange(db, item, connectorId ?? "", "refused", now, `${why} The change to ${ref} was not made.`);
    }
    if (job.op === "cancel" || purpose === "confirm" || purpose === "release") {
      const what =
        job.op === "cancel"
          ? "cancel"
          : purpose === "confirm"
            ? "confirm, with the guest's details,"
            : "let the nights after the first go for";
      await tellOwner(db, item, `${why} Do it there: ${what} stay ${ref}.`, now);
    }
    return "not reachable";
  };
  if (!setup || !connectorId) return unreachable("The property is not connected to its system any more.");
  const conn = await connectors.contextFor(connectorId, now);
  const writer = conn?.definition.stayWriter;
  if (!conn || !writer || !isPropertySystem(conn.definition)) {
    return unreachable("The property's system could not be reached.");
  }
  const key = stayKey(item.id, job.op, job.eventId, { purpose: purpose ?? undefined, again: job.again });
  const confirmed = job.status === "confirmed";
  const link = await linkOf(db, connectorId, item.id);
  if (job.op === "cancel") {
    if (!link?.externalId) return "nothing written to cancel";
    const stay = await outboundOf(db, setup, item, key, false);
    const { guest: _g, ...request } = stay;
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
        `Your system did not take the cancellation of ${ref}: cancel it there. (${r.reason})`,
        now,
      );
    }
    if (r.status === "busy") throw new ConnectorError("unreachable", "another write for this stay is running");
    return `cancel: ${r.status}`;
  }
  // What is written: the stay as it stands, as a change would make it, or with only its first night.
  const shape: StayShape | undefined =
    purpose === "change"
      ? (changeShape(p) ?? undefined)
      : purpose === "release"
        ? {
            checkIn: p.checkIn,
            checkOut: addDays(p.checkIn, 1),
            rooms: p.rooms,
            total: p.quote?.total ?? p.totalPrice ?? { value: 0, currency: setup.property.currency },
          }
        : undefined;
  if (job.op === "modify" && !link?.externalId) {
    if (purpose === "change") {
      return settleChange(
        db,
        item,
        connectorId,
        "refused",
        now,
        `The stay ${ref} is not on your system: change it there.`,
      );
    }
    return "nothing written to change";
  }
  const stay = await outboundOf(db, setup, item, key, confirmed, shape);
  // A change taken back is put back as it was: the stay as it stands, never cancelled.
  const previous = purpose === "change" ? await outboundOf(db, setup, item, key, true) : null;
  const { guest: _guest, amounts: _amounts, ...request } = stay;
  // Set when a change taken back leaves its old nights oversold, or unknown: the owner is told.
  const back: { oversold: boolean | null } = { oversold: false };
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
      // A reserve is found by our key; a modify leaves the booking's own key as it was, so it is not.
      if (job.op !== "reserve") return null;
      const found = await writer.find(conn.ctx, stay);
      return found?.externalId ? { externalId: found.externalId } : null;
    },
    ...(readsBack(job) && writer.oversold
      ? { readBack: (written: WrittenRef) => readBack(conn.ctx, writer, stay, written) }
      : {}),
    async rollback(written) {
      if (job.op === "reserve") {
        await writer.cancel(conn.ctx, { externalId: written.externalId, etag: null, calendar: null });
      } else if (previous && link) {
        back.oversold = await putBack(conn.ctx, writer, previous, link);
      }
    },
  });
  if (job.op === "modify") {
    if (r.status === "busy") throw new ConnectorError("unreachable", "another write for this stay is running");
    if (r.status === "pending") return `modify (${purpose}): no answer yet, looked for again shortly`;
    if (purpose === "change") {
      if (r.status === "written") return settleChange(db, item, connectorId, "written", now, null);
      if (r.status === "conflict" && back.oversold !== false) {
        return settleChange(
          db,
          item,
          connectorId,
          "refused",
          now,
          back.oversold
            ? `Your system took the new dates only to show them oversold, so stay ${ref} was put back on its own dates. Another booking took some of those nights meanwhile, so they are oversold now: fix it in your system.`
            : `Your system took the new dates only to show them oversold, so stay ${ref} was put back on its own dates, but your system did not say whether those are still free: check it there.`,
        );
      }
      const why =
        r.status === "conflict"
          ? "Your system took the new dates only to show them oversold, so they were put back."
          : `Your system did not take the new dates (${r.reason}).`;
      return settleChange(db, item, connectorId, "refused", now, `${why} Stay ${ref} keeps its dates, here and there.`);
    }
    if (r.status === "refused" || r.status === "conflict") {
      const why = r.status === "refused" ? ` (${r.reason})` : "";
      await tellOwner(
        db,
        item,
        purpose === "confirm"
          ? `Your system did not take stay ${ref} as confirmed with the guest's details${why}. The guest has paid: confirm it there.`
          : `Your system did not let the nights after the first go for ${ref}${why}: do it there.`,
        now,
      );
    }
    return `modify (${purpose}): ${r.status}`;
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
 * Settles a stay write whose answer never came, or whose read-back could not be made: looked for by its
 * key, the stay confirmed when found and read back fine, lapsed when it is never found in the few minutes
 * the resolver looks — and a reserve that lands late is looked for once more then, and cancelled. A
 * change, a confirmation or a cancellation whose answer never came is the owner's to check, and they are told.
 */
export function registerStayResolver(connectors: ConnectorCapabilities): void {
  const writerOf = async (db: Db, row: WriteRow, now: number) => {
    const item = await loadStay(db, row.itemId);
    if (!item) return null;
    const setup = await readSetup(db, (item.payload as StayPayload).propertyId);
    const conn = await connectors.contextFor(row.connectorId, now);
    const writer = conn?.definition.stayWriter;
    if (!setup || !conn || !writer) return null;
    const purpose = row.op === "modify" ? purposeOfKey(row.idemKey) : null;
    const shape = purpose === "change" ? (changeShape(item.payload as StayPayload) ?? undefined) : undefined;
    const stay = await outboundOf(db, setup, item, row.idemKey, false, shape);
    return { item, setup, conn, writer, stay, purpose };
  };
  registerWriteResolver("stays", {
    async find(db: Db, row: WriteRow, now: number) {
      if (row.op !== "reserve") return null;
      const w = await writerOf(db, row, now);
      if (!w) return null;
      const found = await w.writer.find(w.conn.ctx, w.stay);
      return found?.externalId ? { externalId: found.externalId } : null;
    },
    async readBack(db: Db, row: WriteRow, ref: WrittenRef, now: number) {
      const w = await writerOf(db, row, now);
      if (!w) return "unknown";
      if (row.op !== "reserve" && w.purpose !== "change") return "ok";
      return readBack(w.conn.ctx, w.writer, w.stay, ref);
    },
    async rollback(db: Db, row: WriteRow, ref: WrittenRef, now: number) {
      const w = await writerOf(db, row, now);
      if (!w) return;
      if (row.op === "reserve") {
        await w.writer.cancel(w.conn.ctx, { externalId: ref.externalId, etag: null, calendar: null });
      } else if (w.purpose === "change") {
        const previous = await outboundOf(db, w.setup, w.item, row.idemKey, true);
        const oversold = await putBack(w.conn.ctx, w.writer, previous, {
          externalId: ref.externalId,
          etag: null,
          calendar: null,
        });
        if (oversold !== false) {
          await tellOwner(
            db,
            w.item,
            oversold
              ? `Stay ${shortRef(w.item.id)} was put back on its own dates in your system, and another booking took some of those nights meanwhile: they are oversold now. Fix it there.`
              : `Stay ${shortRef(w.item.id)} was put back on its own dates in your system, which did not say whether those are still free: check it there.`,
            now,
          );
        }
      }
    },
    async settled(db: Db, row: WriteRow, outcome, ref, now) {
      const item = await loadStay(db, row.itemId);
      if (!item) return;
      const short = shortRef(item.id);
      if (row.op === "reserve") {
        if (outcome === "refused") {
          // Not found while it was looked for: one look more, and a write that landed late is taken back.
          const w = await writerOf(db, row, now);
          try {
            const late = w ? await w.writer.find(w.conn.ctx, w.stay) : null;
            if (w && late?.externalId) await w.writer.cancel(w.conn.ctx, late);
          } catch (error) {
            if (!(error instanceof ConnectorError)) throw error;
            await tellOwner(
              db,
              item,
              `Your system never answered about stay ${short}. If it shows a booking under ${row.idemKey}, cancel it there: the guest was told it did not go through.`,
              now,
            );
          }
        }
        await settleStay(
          db,
          item,
          row.connectorId,
          outcome,
          ref,
          now,
          outcome === "refused" ? "The property's system never showed the stay: it was not written." : undefined,
        );
        return;
      }
      const purpose = row.op === "modify" ? purposeOfKey(row.idemKey) : null;
      if (purpose === "change") {
        await settleChange(
          db,
          item,
          row.connectorId,
          outcome,
          now,
          outcome === "refused"
            ? `Your system never answered about the change to ${short}: it may hold the new dates. Check it there; here the stay keeps its dates.`
            : null,
        );
        return;
      }
      if (outcome === "refused") {
        const what =
          row.op === "cancel"
            ? "the cancellation of"
            : purpose === "confirm"
              ? "confirming, with the guest's details,"
              : "letting the nights after the first go for";
        await tellOwner(db, item, `Your system never answered about ${what} stay ${short}: check it there.`, now);
      }
    },
  });
}
