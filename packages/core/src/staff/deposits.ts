import { eq } from "drizzle-orm";
import type { ScheduledItem, ScheduledOutcome, ScheduleSource, WantedLink } from "../connectors/schedules";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { paidFor } from "../negotiation/refunds";
import { items, parties } from "../schema/tables";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";

/**
 * A booking's deposit (ADR-035, ADR-032 §3): one link on the business's own payment platform, for the
 * amount the service asks, made once the booking is confirmed and open until the deposit's time is up
 * (a day, or the start when that is sooner). Paid, it is recorded on the booking as a payment; not paid
 * in time, the link closes and the owner decides — nothing is cancelled for them. A payment that lands
 * once the booking has ended is the business's to refund in its own dashboard: nothing is refunded here.
 * The link's title is the business's own service name and the reference, never anything a customer typed.
 */

type BookingPayload = PayloadOf<"booking">;

async function loadBooking(db: Db, itemId: string): Promise<Item | null> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  return row && row.type === "booking" ? rowToItem(row) : null;
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
    actor: { kind: "system", id: "booking_deposit", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
}

/**
 * What is still to pay of the deposit: its amount less what was paid, in its currency, read as the
 * fee and the refund read it (`paidFor`): a payment the owner recorded with no amount pays the deposit
 * still to pay, and once it is paid, the whole price, so nothing more is asked for. A reference with no
 * amount and no price to read covers it too.
 */
export function depositLeft(p: BookingPayload): number {
  if (!p.deposit) return 0;
  const paid = paidFor(p);
  if (!paid && p.paymentRef) return 0;
  const value = paid && paid.currency === p.deposit.amount.currency ? paid.value : 0;
  return Math.max(0, p.deposit.amount.value - value);
}

export const bookingSchedules: ScheduleSource = {
  async wanted(db, itemId, now): Promise<ScheduledItem | null> {
    const item = await loadBooking(db, itemId);
    if (!item) return null;
    const p = item.payload as BookingPayload;
    const [party] = await db.orm.select({ locale: parties.locale }).from(parties).where(eq(parties.id, item.partyId));
    const links: WantedLink[] = [];
    const left = depositLeft(p);
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
      // Too late to hold anything: the owner refunds it in their own dashboard, and is told so.
      await appendThreadEntry(
        db,
        systemCaller(payment.now),
        item,
        `A deposit was paid after this booking ended. Refund it in your own payment dashboard${payment.dashboardUrl ? `: ${payment.dashboardUrl}` : "."}`,
        "note",
      );
      await setFlags(db, systemCaller(payment.now), { itemId: item.id, flags: { needsHuman: true } });
      return { applied: false, note: "paid after the booking ended: refund owed" };
    }
    try {
      await transitionItem(db, connectorCaller(payment.connectorId, payment.now), {
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
    if (item?.state !== "confirmed" || depositLeft(item.payload as BookingPayload) === 0) return;
    // Not paid in time: the owner decides, and is told once.
    await appendThreadEntry(
      db,
      systemCaller(link.now),
      item,
      "The deposit was not paid in time. The booking stands until you change it.",
      "note",
    );
    await setFlags(db, systemCaller(link.now), { itemId: item.id, flags: { needsHuman: true } });
  },
};
