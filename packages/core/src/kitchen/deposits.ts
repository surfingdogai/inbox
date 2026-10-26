import { eq } from "drizzle-orm";
import type { ScheduledItem, ScheduledOutcome, ScheduleSource, WantedLink } from "../connectors/schedules";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { items, parties } from "../schema/tables";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";

/**
 * A table's deposit (ADR-040, ADR-036 §3): one link on the business's own payment platform for the
 * deposit the table rules ask (so much a person, from a party size), made once the booking is confirmed
 * and open until the sitting starts. Paid, it is recorded on the booking; not paid in time, the link
 * closes and a person decides: nothing is cancelled for them. A payment after the booking ended is the
 * business's to refund in its own dashboard. The title is the service's name and the reference.
 *
 * It reads the same `payload.deposit` the salons track's deposit does, and is registered only where no
 * booking schedule source is: the two are one at merge.
 */

type BookingPayload = PayloadOf<"booking">;

async function loadBooking(db: Db, itemId: string): Promise<Item | null> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  return row && row.type === "booking" ? rowToItem(row) : null;
}

const as = (kind: "connector" | "system", id: string, now: number): Caller => ({
  actor: { kind, id, channel: kind === "connector" ? "connector" : "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => now,
});

/** What is still to pay of the deposit, in its currency. */
export function tableDepositLeft(p: BookingPayload): number {
  if (!p.deposit) return 0;
  const paid = p.paidAmount && p.paidAmount.currency === p.deposit.amount.currency ? p.paidAmount.value : 0;
  return Math.max(0, p.deposit.amount.value - paid);
}

export const tableDeposits: ScheduleSource = {
  async wanted(db, itemId, now): Promise<ScheduledItem | null> {
    const item = await loadBooking(db, itemId);
    if (!item) return null;
    const p = item.payload as BookingPayload;
    const [party] = await db.orm.select({ locale: parties.locale }).from(parties).where(eq(parties.id, item.partyId));
    const links: WantedLink[] = [];
    const left = tableDepositLeft(p);
    if (item.state === "confirmed" && p.deposit && left > 0) {
      const due = p.deposit.dueBy ? Date.parse(p.deposit.dueBy) : Date.parse(p.startTime);
      if (Number.isFinite(due) && due > now) {
        links.push({
          scheduleId: "deposit",
          purpose: "deposit",
          amount: { value: left, currency: p.deposit.amount.currency },
          expiresAt: due,
          title: `${p.reservationFor.name} (${shortRef(item.id)})`.slice(0, 200),
        });
      }
    }
    return {
      id: item.id,
      type: "booking",
      sandbox: item.flags.sandbox,
      locale: party?.locale ?? null,
      reference: shortRef(item.id),
      links,
    };
  },

  async paid(db, payment): Promise<ScheduledOutcome> {
    const item = await loadBooking(db, payment.itemId);
    if (!item) return { applied: false, note: "the booking is gone" };
    if (item.state !== "confirmed") {
      await appendThreadEntry(
        db,
        as("system", "table_deposit", payment.now),
        item,
        `A deposit was paid after this booking ended. Refund it in your own payment dashboard${payment.dashboardUrl ? `: ${payment.dashboardUrl}` : "."}`,
        "note",
      );
      await setFlags(db, as("system", "table_deposit", payment.now), { itemId: item.id, flags: { needsHuman: true } });
      return { applied: false, note: "paid after the booking ended: refund owed" };
    }
    try {
      await transitionItem(db, as("connector", `connector:${payment.connectorId}`, payment.now), {
        itemId: item.id,
        event: "record_payment",
        input: {
          paymentRef: payment.paymentId.slice(0, 200),
          amount: payment.amount,
          ...(payment.method ? { method: payment.method.slice(0, 40) } : {}),
        },
      });
      return { applied: true, note: "deposit recorded" };
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      return { applied: false, note: `not recorded: ${error.message}` };
    }
  },

  async closed(db, link): Promise<void> {
    if (link.why !== "expired") return;
    const item = await loadBooking(db, link.itemId);
    if (item?.state !== "confirmed" || tableDepositLeft(item.payload as BookingPayload) === 0) return;
    await appendThreadEntry(
      db,
      as("system", "table_deposit", link.now),
      item,
      "The table's deposit was not paid in time. The booking stands until you change it.",
      "note",
    );
    await setFlags(db, as("system", "table_deposit", link.now), { itemId: item.id, flags: { needsHuman: true } });
  },
};
