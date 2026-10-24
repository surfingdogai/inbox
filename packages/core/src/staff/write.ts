import { eq } from "drizzle-orm";
import type { ConnectorCapabilities } from "../connectors/capability";
import { registerWriteResolver, type WriteResolver } from "../connectors/write-first";
import type { Db } from "../db";
import { items } from "../schema/tables";
import { readSettings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { heldForPrice } from "../write/pricing";
import { appendThreadEntry } from "../write/thread";
import { slotClaimable, transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { heldForCheck } from "./requires";
import { awaitingSystem, systemFirstRefusal, systemHold } from "./system";

/**
 * A salon's booking system written first (ADR-035, ADR-032 §4): a booking for a service the salon's own
 * system holds (Phorest) is written there before the inbox confirms anything. The system took it: the
 * booking is confirmed, as that system confirmed it. It would not: the request waits for a person, and
 * nothing was promised. No answer came: it is looked for by the inbox's own marker, and a job settles it
 * within minutes; meanwhile it is a request, never a promise.
 */

export type FirstOutcome = "confirmed" | "waits" | "pending" | "none";

/**
 * Who confirms a booking the salon's own system took first: the inbox's automation on the business's
 * side, named after the connection, so the history says what confirmed it. As automation, it never
 * confirms a price the business did not set, nor what a person must check first.
 */
function writtenFirstCaller(connectorId: string, now: number): Caller {
  return {
    actor: { kind: "rule", id: `write_first:${connectorId}`, channel: "connector" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

function systemCaller(now: number): Caller {
  return {
    actor: { kind: "system", id: "booking_write_first", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

async function waitForPerson(db: Db, itemId: string, note: string, now: number): Promise<void> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  if (!row) return;
  const item = rowToItem(row);
  await appendThreadEntry(db, systemCaller(now), item, note, "note");
  await setFlags(db, systemCaller(now), { itemId, flags: { needsHuman: true } });
}

async function confirmWritten(
  db: Db,
  connectors: ConnectorCapabilities,
  connectorId: string,
  itemId: string,
  title: string,
  now: number,
): Promise<boolean> {
  try {
    await transitionItem(db, writtenFirstCaller(connectorId, now), {
      itemId,
      event: "confirm",
      reason: `${title} took the booking first`,
    });
    return true;
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    // Never promised here, so not held there either: taken back out of the system when it can be.
    const back = await connectors.takeBackFirstWrite(connectorId, itemId, now);
    await waitForPerson(
      db,
      itemId,
      back
        ? `${title} took this booking, but it could not be confirmed here (${error.message}), so it was taken back out of ${title}. Nothing was promised: propose another time, or decline it.`
        : `${title} took this booking, but it could not be confirmed here (${error.message}). Cancel it in ${title}, or confirm it here once the time is free.`,
      now,
    );
    return false;
  }
}

/** Writes a new booking request to the salon's own system first, and confirms it once the system took it. */
export async function bookFirstInSystem(
  db: Db,
  connectors: ConnectorCapabilities,
  itemId: string,
  now: number,
): Promise<FirstOutcome> {
  // What the inbox could not confirm on its own anyway is never written first: a price a person sets,
  // what a person checks first, a time inside the minimum notice. A person answers those, as always.
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  if (row?.type !== "booking") return "none";
  const item = rowToItem(row);
  if ((await heldForPrice(db, item, "confirm")) || (await heldForCheck(db, item, "confirm"))) return "none";
  const start = Date.parse((item.payload as { startTime?: string }).startTime ?? "");
  const notice = (await readSettings(db)).booking.minNoticeMin * 60_000;
  if (!Number.isFinite(start) || start - now < notice) return "none";
  // Taken here already (its places, a calendar's busy time): never written there, a person answers.
  if ((await systemHold(db, item)) && !(await slotClaimable(db, item))) {
    await waitForPerson(
      db,
      itemId,
      "That time is taken here, so this booking was not written to your booking system. Nothing was promised: propose another time, or decline it.",
      now,
    );
    return "waits";
  }
  let result: Awaited<ReturnType<ConnectorCapabilities["writeFirstBooking"]>>;
  try {
    result = await connectors.writeFirstBooking(itemId, now);
  } catch (error) {
    // Our own bug, or a refusal we could not read: nothing was promised, and a person answers.
    await waitForPerson(
      db,
      itemId,
      `This booking could not be written to your booking system (${String((error as Error)?.message ?? error).slice(0, 200)}). Nothing was promised: answer it here.`,
      now,
    );
    return "waits";
  }
  if (!result) return "none";
  const { title, connectorId } = await systemOf(db, "journalId" in result ? result : { status: result.status }, itemId);
  switch (result.status) {
    case "written":
      return (await confirmWritten(db, connectors, connectorId, itemId, title, now)) ? "confirmed" : "waits";
    case "refused":
      await waitForPerson(
        db,
        itemId,
        `${title} would not take this booking: ${result.reason.slice(0, 300)} Nothing was promised: propose another time, or decline it.`,
        now,
      );
      return "waits";
    case "conflict":
      await waitForPerson(
        db,
        itemId,
        `${title} was full at that time, so the booking was taken back there. Nothing was promised.`,
        now,
      );
      return "waits";
    case "pending":
      return "pending";
    case "busy":
      return "pending";
  }
}

/**
 * A person confirms a booking the salon's own system holds (ADR-035): it is written there first, and
 * their confirm stands on the system's answer. Refused, or not answered yet: nothing is confirmed, and
 * they read why. A booking the system cannot be given (a member of staff it does not list) is theirs to
 * confirm as always. Answers whether this call wrote it, so a confirm that then fails takes it back.
 */
export async function writeFirstForPerson(
  db: Db,
  connectors: ConnectorCapabilities,
  itemId: string,
  now: number,
): Promise<{ readonly wrote: string | null }> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  if (row?.type !== "booking") return { wrote: null };
  const item = rowToItem(row);
  const hold = await systemHold(db, item);
  if (!hold || hold.outcome === "written") return { wrote: null };
  if (awaitingSystem(hold)) throw systemFirstRefusal(hold, { forOwner: true });
  // Taken here already: refused as the confirm would refuse it, and nothing is written there, so the
  // salon's diary never shows a booking that was cancelled the moment it was made. A time we proposed is
  // the one confirmed and written (`writeFirstBooking`), so that time is the one checked.
  const written = timeToWrite(item);
  if (!(await slotClaimable(db, { id: item.id, payload: written as typeof item.payload }))) {
    throw new WriteError(
      "slot_taken",
      `that time is fully booked here, so nothing was written to ${hold.title}. Propose another time, or decline it.`,
      { details: { guard: "slot_available", system: hold.connectorId } },
    );
  }
  let result: Awaited<ReturnType<ConnectorCapabilities["writeFirstBooking"]>>;
  try {
    result = await connectors.writeFirstBooking(itemId, now);
  } catch (error) {
    throw new WriteError(
      "guard_failed",
      `This booking could not be written to ${hold.title} (${String((error as Error)?.message ?? error).slice(0, 200)}). Nothing was confirmed.`,
      { details: { guard: "system_first" } },
    );
  }
  if (!result) {
    // With someone the system lists, it can always be given it: nothing written there is never a
    // confirm here, for its diary would not hold what the customer is told. A test booking never is.
    if (!item.flags.sandbox && (await listedBy(db, hold.connectorId, written.resourceId))) {
      throw new WriteError(
        "guard_failed",
        `This booking could not be written to ${hold.title}, so nothing was confirmed. Try again in a minute, or propose another time.`,
        { details: { guard: "system_first", outcome: "not_written" } },
      );
    }
    return { wrote: null };
  }
  switch (result.status) {
    case "written":
      return { wrote: result.replayed ? null : hold.connectorId };
    case "refused":
      throw new WriteError(
        "guard_failed",
        `${hold.title} would not take this booking: ${result.reason.slice(0, 300)} Nothing was confirmed: propose another time, or decline it.`,
        { details: { guard: "system_first", outcome: "refused" } },
      );
    case "conflict":
      throw new WriteError(
        "guard_failed",
        `${hold.title} was full at that time, so the booking was taken back there. Nothing was confirmed.`,
        { details: { guard: "system_first", outcome: "conflict" } },
      );
    case "pending":
    case "busy":
      throw systemFirstRefusal({ ...hold, outcome: "pending" }, { forOwner: true });
  }
}

/**
 * The booking as it will be confirmed: at the time we proposed, when the customer was offered one, with
 * whoever that time was held for (ADR-035), as the write to the system takes it.
 */
function timeToWrite(item: { readonly state: string; readonly payload: unknown }): Record<string, unknown> {
  const payload = item.payload as Record<string, unknown>;
  const proposed = payload.proposed as
    | { startTime?: unknown; endTime?: unknown; resourceId?: unknown; staffName?: unknown }
    | undefined;
  if (item.state !== "proposed" || typeof proposed?.startTime !== "string" || typeof proposed.endTime !== "string")
    return payload;
  return {
    ...payload,
    startTime: proposed.startTime,
    endTime: proposed.endTime,
    ...(typeof proposed.resourceId === "string" ? { resourceId: proposed.resourceId } : {}),
    ...(typeof proposed.staffName === "string" ? { staffName: proposed.staffName } : {}),
  };
}

/** Whether the salon's own system lists this member of staff, under its own id for them. */
async function listedBy(db: Db, connectorId: string, resourceId: unknown): Promise<boolean> {
  if (typeof resourceId !== "string") return false;
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM resources r JOIN connectors c ON c.kind = r.source
           WHERE r.id = ? AND c.id = ? AND r.external_id IS NOT NULL LIMIT 1`,
    params: [resourceId, connectorId],
    method: "all",
  });
  return rows.length > 0;
}

async function systemOf(
  db: Db,
  result: { readonly status: string } & Partial<{ readonly journalId: string }>,
  itemId: string,
): Promise<{ title: string; connectorId: string }> {
  const { rows } = await db.client.query({
    sql: `SELECT c.id, c.name FROM connector_writes w JOIN connectors c ON c.id = w.connector_id
           WHERE w.item_id = ? ${result.journalId ? "AND w.id = ?" : ""} ORDER BY w.attempt DESC LIMIT 1`,
    params: result.journalId ? [itemId, result.journalId] : [itemId],
    method: "all",
  });
  return { connectorId: String(rows[0]?.[0] ?? ""), title: String(rows[0]?.[1] ?? "Your booking system") };
}

/** Settles bookings written first whose answer never came: found, confirmed; never found, a person answers. */
export function bookingWriteResolver(connectors: ConnectorCapabilities): WriteResolver {
  return {
    find: (_db, row, now) => connectors.findFirstWrite(row.connectorId, row.itemId, now),
    async settled(db, row, outcome, _ref, now) {
      const [c] = (
        await db.client.query({
          sql: "SELECT name FROM connectors WHERE id = ?",
          params: [row.connectorId],
          method: "all",
        })
      ).rows;
      const title = String(c?.[0] ?? "Your booking system");
      if (outcome === "written") {
        await confirmWritten(db, connectors, row.connectorId, row.itemId, title, now);
        return;
      }
      await waitForPerson(
        db,
        row.itemId,
        `${title} never answered for this booking, and it is not there. Nothing was promised: answer it here.`,
        now,
      );
    },
  };
}

export function registerBookingResolver(connectors: ConnectorCapabilities): void {
  registerWriteResolver("bookings", bookingWriteResolver(connectors));
}
