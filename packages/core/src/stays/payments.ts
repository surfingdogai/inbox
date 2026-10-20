import { eq } from "drizzle-orm";
import { connectorCaller } from "../connectors/payments";
import type { ScheduledItem, ScheduledOutcome, ScheduleSource, WantedLink } from "../connectors/schedules";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { Item, PayloadOf } from "../domain/types";
import { items } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { formatMinor } from "../util/money";
import { hasEventListeners } from "../write/common";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { refundStatements } from "../write/returns";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { stayCopy } from "./copy";
import { guestLang, partyLocale } from "./lang";
import { nightsOf } from "./nights";
import { localeOf } from "./price";
import { readProperty } from "./store";

/**
 * Stays' pay links (ADR-033 §5.4, ADR-032 schedules): a link per entry due now (the deposit, the
 * difference a change added), the balance's own link in the days before it is due, a card saved to
 * hold the stay, and what the platform says was paid. A payment that lands after the stay lapsed takes
 * its nights again when they are still free; otherwise it is owed back, for the property to refund in its
 * own dashboard — nothing is ever refunded here. Every link's title is built from the property's own
 * words and the reference, never from anything a guest's assistant typed.
 */

type StayPayload = PayloadOf<"stay">;

/** The balance's link is made this long before it is due. */
export const BALANCE_LINK_AHEAD_MS = 3 * 86_400_000;

async function loadStay(db: Db, itemId: string): Promise<Item | null> {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  return row && row.type === "stay" ? rowToItem(row) : null;
}

function purposeOf(id: string): WantedLink["purpose"] {
  if (id.startsWith("difference")) return "difference";
  if (id === "balance") return "balance";
  return "deposit";
}

export const staySchedules: ScheduleSource = {
  async wanted(db, itemId, now): Promise<ScheduledItem | null> {
    const item = await loadStay(db, itemId);
    if (!item) return null;
    const p = item.payload as StayPayload;
    const property = await readProperty(db, p.propertyId);
    const settings = await readSettings(db);
    const locale = await partyLocale(db, item.partyId);
    const lang = await guestLang(db, { locale, settings });
    const c = stayCopy(lang);
    const ref = shortRef(item.id);
    const nights = nightsOf(p.checkIn, p.checkOut).length;
    const date = (() => {
      try {
        return new Intl.DateTimeFormat(localeOf(lang), { day: "numeric", month: "short", timeZone: "UTC" }).format(
          new Date(`${p.checkIn}T12:00:00Z`),
        );
      } catch {
        return p.checkIn;
      }
    })();
    const head = `${property?.name ?? ""} · ${c.from(c.nights(nights), date)} (${ref})`;
    const links: WantedLink[] = [];
    const open = item.state === "awaiting_payment" || item.state === "confirmed" || item.state === "checked_in";
    for (const s of open ? (p.payments?.schedules ?? []) : []) {
      if (s.status !== "due") continue;
      const left = s.amount.value - (s.paidAmount?.currency === s.amount.currency ? s.paidAmount.value : 0);
      if (left <= 0) continue;
      const purpose = purposeOf(s.id);
      let expiresAt: number | null = null;
      if (s.type === "immediate") {
        expiresAt = p.payments?.dueBy ? Date.parse(p.payments.dueBy) : s.dueAt ? Date.parse(s.dueAt) : null;
        // Once confirmed, what was due now waits only for a difference a change added.
        if (item.state !== "awaiting_payment" && purpose !== "difference") continue;
      } else if (s.type === "deferred") {
        const due = s.dueAt ? Date.parse(s.dueAt) : null;
        if (item.state === "awaiting_payment" || due === null || now < due - BALANCE_LINK_AHEAD_MS) continue;
        expiresAt = due;
      } else continue;
      links.push({
        scheduleId: s.id,
        purpose,
        amount: { value: left, currency: s.amount.currency },
        expiresAt,
        title:
          `${head} · ${c.purpose[purpose === "difference" ? "difference" : purpose === "balance" ? "balance" : "deposit"]}`.slice(
            0,
            200,
          ),
      });
    }
    return { id: item.id, type: "stay", sandbox: item.flags.sandbox, locale, reference: ref, links };
  },

  async paid(db, payment): Promise<ScheduledOutcome> {
    const item = await loadStay(db, payment.itemId);
    if (!item) return { applied: false, note: "the stay is gone" };
    const caller = connectorCaller(payment.connectorId, payment.now);
    try {
      await transitionItem(db, caller, {
        itemId: item.id,
        event: "record_payment",
        input: {
          paymentRef: payment.paymentId.slice(0, 200),
          scheduleId: payment.scheduleId,
          ...(payment.purpose === "guarantee" ? {} : { amount: payment.amount }),
          ...(payment.method ? { method: payment.method.slice(0, 40) } : {}),
        },
      });
      return { applied: true, note: `${payment.scheduleId} recorded` };
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      // A card saved after the stay ended another way holds nothing: nothing was paid.
      if (payment.purpose === "guarantee")
        return { applied: false, note: `card saved on a stay that is ${item.state}` };
      const note = await owedBack(db, item, payment.amount, payment.connectorId, payment.now, error.message);
      return { applied: false, note };
    }
  },

  async closed(db, link) {
    if (link.why !== "failed") return;
    const item = await loadStay(db, link.itemId);
    if (item?.state !== "awaiting_payment") return;
    try {
      await transitionItem(db, connectorCaller("payments", link.now), { itemId: item.id, event: "payment_failed" });
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
    }
  },
};

/**
 * A payment the stay can no longer take: owed back, as a refund linked to the stay (ADR-018 §3.4), and
 * the owner told where to make it. The guest hears it from the property, in its words.
 */
async function owedBack(
  db: Db,
  item: Item,
  amount: { value: number; currency: string },
  connectorId: string,
  now: number,
  why: string,
): Promise<string> {
  const settings = await readSettings(db);
  const caller = connectorCaller(connectorId, now);
  const made = refundStatements({
    caller,
    item,
    plan: {
      kind: "cancellation",
      state: "approved",
      acknowledge: false,
      payload: {
        orderItemId: item.id,
        amount,
        kind: "cancellation",
        reason: "Paid after the stay could no longer take it.",
        noticeAt: new Date(now).toISOString(),
        goodsBack: false,
        refundDue: new Date(now + settings.returns.refundDays * 86_400_000).toISOString(),
      },
    },
    causationId: item.id,
    now,
    webhooks: await hasEventListeners(db),
  });
  await db.batch(made.statements);
  const { rows } = await db.client.query({
    sql: "SELECT name FROM connectors WHERE id = ?",
    params: [connectorId],
    method: "all",
  });
  const where = rows[0]?.[0] ? String(rows[0][0]) : "your payment platform";
  const money = formatMinor(amount, "en-GB");
  await appendThreadEntry(
    db,
    caller,
    item,
    `Refund ${money} in ${where}: it was paid after this stay could no longer take it (${why}). Nothing is refunded automatically.`,
    "note",
  );
  try {
    await setFlags(db, caller, { itemId: item.id, flags: { needsHuman: true }, reason: "refund_owed" });
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
  }
  return `owed back as refund ${made.id}`;
}
