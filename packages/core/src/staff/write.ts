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
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { heldForCheck } from "./requires";

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
    await waitForPerson(
      db,
      itemId,
      `${title} took this booking, but it could not be confirmed here (${error.message}). Check it in ${title}, then confirm or decline it here.`,
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
      return (await confirmWritten(db, connectorId, itemId, title, now)) ? "confirmed" : "waits";
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
        await confirmWritten(db, row.connectorId, row.itemId, title, now);
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
