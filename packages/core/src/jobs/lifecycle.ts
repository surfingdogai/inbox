import type { MailOut, SqlInput } from "@surfingdog/platform";
import type { Db } from "../db";
import { keyLine, keysDeliveredStatement, keysDueAlone, keysFor, prunePending } from "../identity/pending";
import { receiptSha } from "../receipts/sign";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { senderOf } from "./notify";
import type { JobHandler } from "./runner";
import { ensureJob } from "./schedule";

/**
 * The lifecycle sweep (ADR-017 §3.1): what happens to an item because time passed, not because
 * anybody did anything. Every fifteen minutes, from the Worker's cron and the Node loop alike:
 *
 * - a confirmed booking that ended `booking.autoCompleteHours` ago and was not marked a no-show is
 *   completed by the system (`aut: 1`, so the network presumes it until the customer's agent
 *   acknowledges it);
 * - an order whose payment was requested `orders.payDays` ago and never arrived lapses: a neutral
 *   close for the networks, while the order stays open for a late payment;
 * - receipts issued before receipts had a `sha` get one;
 * - a first contact's key that no email to the customer carried within a day goes in an email of
 *   its own, one line (ADR-017 §2.1), while the business keeps `customers.emailKey` on; seven days
 *   on nothing of a first contact is left.
 *
 * A booking or an order promised before outcomes were recorded (`legacy_promise`, set by the
 * outcomes migration) is never completed or lapsed here: its customer made it under the rules of
 * the day, and its owner closes it by hand, as before.
 *
 * Each goes through the ordinary write path as the `system` actor, so it is an event, a webhook and
 * an outcome receipt like any other transition. At most `SWEEP_BATCH` items of each a run; a full
 * run queues the next one straight away.
 */
export const LIFECYCLE_SWEEP_KIND = "lifecycle_sweep";
export const SWEEP_PERIOD_MS = 15 * 60_000;
export const SWEEP_BATCH = 50;
const SHA_BATCH = 200;

/** One sweep per quarter hour: `lifecycle_sweep:<quarter-hour number>`. */
export const sweepKey = (now: number): string => `${LIFECYCLE_SWEEP_KIND}:${Math.floor(now / SWEEP_PERIOD_MS)}`;

/** Makes sure this quarter hour's sweep is queued; safe on every boot and every cron tick. */
export async function ensureLifecycleSweep(db: Db, now = Date.now()): Promise<void> {
  await ensureJob(db, LIFECYCLE_SWEEP_KIND, sweepKey(now), { now });
}

interface SweepPayload {
  readonly link?: number;
}

export function lifecycleSweepHandler(
  opts: { batch?: number; mailOut?: MailOut | undefined; secrets?: SecretBox | null | undefined } = {},
): JobHandler {
  const batch = opts.batch ?? SWEEP_BATCH;
  return async (job, { db, now }) => {
    const link = (job.payload as SweepPayload | null)?.link ?? 0;
    if (link === 0) {
      const next = (Math.floor(now / SWEEP_PERIOD_MS) + 1) * SWEEP_PERIOD_MS;
      await ensureJob(db, LIFECYCLE_SWEEP_KIND, sweepKey(next), { now, runAt: next });
    }
    const settings = await readSettings(db);
    const system: Caller = {
      actor: { kind: "system", id: LIFECYCLE_SWEEP_KIND, channel: "system" },
      tier: "verified_principal",
      sandbox: false,
      now: () => now,
    };

    const endedBy = Math.floor(now / 1000) - settings.booking.autoCompleteHours * 3_600;
    const ended = await ids(db, {
      sql: `SELECT id FROM items WHERE type = 'booking' AND state = 'confirmed' AND end_at <= ? AND legacy_promise = 0
             ORDER BY end_at, id LIMIT ?`,
      params: [endedBy, batch],
    });
    const completed = await fire(db, system, ended, "complete", "the booking ended and nobody marked a no-show");

    const requestedBy = now - settings.orders.payDays * 86_400_000;
    const unpaid = await ids(db, {
      sql: `SELECT i.id FROM items i
             WHERE i.type = 'order' AND i.state IN ('awaiting_payment', 'payment_failed') AND i.legacy_promise = 0
               AND NOT EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event = 'lapse')
               AND (SELECT MAX(e.created_at) FROM item_events e WHERE e.item_id = i.id AND e.event = 'request_payment') <= ?
             ORDER BY i.id LIMIT ?`,
      params: [requestedBy, batch],
    });
    const lapsed = await fire(db, system, unpaid, "lapse", "payment was requested and never arrived");

    const hashed = await backfillShas(db);

    const keyed =
      opts.mailOut && settings.customers.emailKey
        ? await sendKeysAlone(db, opts.mailOut, opts.secrets ?? null, settings, now, batch)
        : 0;
    await prunePending(db, now);

    const full = (ended.length === batch && completed.done > 0) || (unpaid.length === batch && lapsed.done > 0);
    if (full || hashed === SHA_BATCH) {
      await ensureJob(db, LIFECYCLE_SWEEP_KIND, `${sweepKey(now)}:${link + 1}`, {
        now,
        payload: { link: link + 1 } satisfies SweepPayload,
      });
    }
    const skipped = [...completed.skipped, ...lapsed.skipped];
    return {
      note: `${completed.done} completed, ${lapsed.done} lapsed, ${hashed} receipt sha(s)${keyed ? `, ${keyed} key email(s)` : ""}${full || hashed === SHA_BATCH ? ", more to do" : ""}${skipped.length ? `; skipped ${skipped.join(" | ")}` : ""}`,
    };
  };
}

async function ids(db: Db, q: { sql: string; params: SqlInput[] }): Promise<string[]> {
  const { rows } = await db.client.query({ ...q, method: "all" });
  return rows.map((r) => String(r[0]));
}

/**
 * Fires one event on each item. An item someone else moved in the meantime (a no-show marked a
 * second ago, a payment that just arrived) refuses it, and that is the right answer: it is skipped.
 */
async function fire(
  db: Db,
  caller: Caller,
  itemIds: readonly string[],
  event: string,
  reason: string,
): Promise<{ done: number; skipped: string[] }> {
  let done = 0;
  const skipped: string[] = [];
  for (const itemId of itemIds) {
    try {
      await transitionItem(db, caller, { itemId, event, reason });
      done++;
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      skipped.push(`${event} ${itemId}: ${error.code}`);
    }
  }
  return { done, skipped };
}

/**
 * Keys no email carried within a day: one line to the address the customer gave, then gone
 * (ADR-017 §2.1). The email is the business's, about the booking or order the customer made with
 * it, and says only that. A key that cannot be opened or sent stays until the next run, and seven
 * days on the row is pruned whatever happened.
 */
async function sendKeysAlone(
  db: Db,
  mailOut: MailOut,
  secrets: SecretBox | null,
  settings: Settings,
  now: number,
  batch: number,
): Promise<number> {
  if (!secrets) return 0;
  let sent = 0;
  for (const itemId of await keysDueAlone(db, now, batch)) {
    const { rows } = await db.client.query({
      sql: "SELECT json_extract(p.contact, '$.email'), i.subject, i.type FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ?",
      params: [itemId],
      method: "all",
    });
    const email = rows[0]?.[0];
    const keys = await keysFor(db, secrets, itemId);
    if (typeof email !== "string" || !email || keys.length === 0) continue;
    const about = rows[0]?.[1] ? String(rows[0][1]) : rows[0]?.[2] === "order" ? "your order" : "your booking";
    try {
      await mailOut.send({
        ...senderOf(settings),
        to: [email],
        subject: `For next time: ${about}`,
        text: keyLine(keys.map((k) => k.key)),
      });
    } catch {
      continue;
    }
    await db.client.query(
      keysDeliveredStatement(
        itemId,
        keys.map((k) => k.network),
        now,
      ),
    );
    sent++;
  }
  return sent;
}

/** Receipts written before `sha` existed (0008) get it, a slice per run. */
async function backfillShas(db: Db): Promise<number> {
  const { rows } = await db.client.query({
    sql: "SELECT id, jws FROM receipts WHERE sha IS NULL ORDER BY id LIMIT ?",
    params: [SHA_BATCH],
    method: "all",
  });
  if (rows.length === 0) return 0;
  const statements = await Promise.all(
    rows.map(async (r) => ({
      sql: "UPDATE receipts SET sha = ? WHERE id = ? AND sha IS NULL",
      params: [await receiptSha(String(r[1])), String(r[0])],
      method: "run" as const,
    })),
  );
  await db.batch(statements);
  return rows.length;
}
