import type { MailOut, SqlInput } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import { keyMail, privacyUrl } from "../customer/disclosure";
import { customerLang } from "../customer/lang";
import { cutLinks, networksLink } from "../customer/links";
import type { Db } from "../db";
import type { ItemType } from "../domain/types";
import { keysDeliveredStatement, keysDueAlone, keysFor, prunePending } from "../identity/pending";
import { itemStopped } from "../identity/stops";
import { receiptSha } from "../receipts/sign";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { autoHeaders, mailByJob, mailDomain, senderOf, sendLogged, storeMail, threadHeaders } from "./mail-log";
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
 * - a first contact's key goes to the customer a day after they first booked or ordered, in an
 *   email of its own with a line about the booking network (ADR-017 §2.1), while the business keeps
 *   `customers.emailKey` on; seven days on nothing of a first contact is left.
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
  opts: {
    batch?: number;
    mailOut?: MailOut | undefined;
    secrets?: SecretBox | null | undefined;
    /** This instance's public address, for the link in the code email. */
    baseUrl?: string | undefined;
  } = {},
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
        ? await sendKeysAlone(db, opts.mailOut, opts.secrets ?? null, settings, now, batch, opts.baseUrl)
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
 * A first contact's code for their assistant (ADR-017 §2.1, as decided on 23 September 2026): a day
 * after the booking or order, in an email of its own and never on another, with one line in the
 * business's words about the booking network and a link to the page that explains it. No public
 * address for that page, no email: a code without its explanation is not sent. The email goes
 * through the mail log (`key:<item>`) like every other, but the code itself is never stored there:
 * the row keeps the email with the code cut, and each try opens the sealed code again. A code that
 * cannot be opened or sent stays until the next run; seven days on, the row is pruned whatever
 * happened.
 */
async function sendKeysAlone(
  db: Db,
  mailOut: MailOut,
  secrets: SecretBox | null,
  settings: Settings,
  now: number,
  batch: number,
  baseUrl: string | undefined,
): Promise<number> {
  const publicUrl = baseUrl || settings.notifications.appUrl || "";
  if (!secrets || !publicUrl) return 0;
  const facts = await businessFacts(db, settings);
  const sender = senderOf(settings, { transport: mailOut.sender, publicUrl, business: facts.name });
  let sent = 0;
  for (const itemId of await keysDueAlone(db, now, batch)) {
    const { rows } = await db.client.query({
      sql: `SELECT json_extract(p.contact, '$.email'), json_extract(p.contact, '$.name'), json_extract(p.contact, '$.locale'),
                   i.subject, i.type, i.payload, COALESCE(i.sandbox, 0)
              FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ?`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    const email = r?.[0];
    // The customer asked us not to use booking networks since: their code is never sent, and goes.
    if (await itemStopped(db, itemId)) {
      await db.client.query({ sql: "DELETE FROM pending_identity WHERE item_id = ?", params: [itemId], method: "run" });
      continue;
    }
    const keys = await keysFor(db, secrets, itemId);
    // A test item emails nobody, its code included; seven days on the row is pruned like any other.
    if (!r || typeof email !== "string" || !email || keys.length === 0 || Number(r[6]) === 1) continue;
    const jobKey = `key:${itemId}`;
    const delivered = keysDeliveredStatement(
      itemId,
      keys.map((k) => k.network),
      now,
    );
    let row = await mailByJob(db, jobKey);
    // Sent before the code was marked delivered (a crash between the two): mark it now, never send twice.
    if (row?.status === "sent") {
      await db.client.query(delivered);
      continue;
    }
    if (row?.status === "failed") continue;
    // Already written to a log that delivers nothing: once is enough; a mail service sends it later.
    if (row?.status === "skipped" && row.skipReason === "no_service" && mailOut.delivers === false) continue;
    const lang = customerLang(typeof r[2] === "string" ? r[2] : null, facts.languages);
    // The page about the network, for this customer: where they can switch it off for themselves.
    const pageUrl =
      (await networksLink(db, secrets, { itemId, mailKey: jobKey, lang, base: publicUrl, now })) ??
      privacyUrl(publicUrl, lang);
    const render = (codes: readonly string[]) =>
      keyMail({
        lang,
        name: typeof r[1] === "string" ? r[1] : null,
        business: facts.name,
        item: { type: String(r[4]) as ItemType, subject: r[3] === null ? null : String(r[3]), payload: parsed(r[5]) },
        keys: codes,
        privacyUrl: pageUrl,
      });
    if (!row) {
      // Kept with the code cut and the link without its mac: the log answers nothing for them.
      const cut = render(keys.map((k) => cutKey(k.key)));
      const shown = { ...cut, text: cutLinks(cut.text) };
      row = await storeMail(
        db,
        {
          itemId,
          jobKey,
          recipient: "customer",
          template: shown.template,
          lang,
          subject: shown.subject,
          text: shown.text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    }
    // No address to send from: kept as not sent, and sent on a later run once there is one.
    if (!sender) continue;
    const mail = render(keys.map((k) => k.key));
    try {
      await sendLogged(
        db,
        mailOut,
        row,
        {
          ...sender,
          to: [email],
          subject: mail.subject,
          text: mail.text,
          headers: {
            ...(await threadHeaders(db, itemId, row.messageRef)),
            ...autoHeaders({ automatic: true, template: "key" }),
          },
        },
        { final: row.attempts + 1 >= KEY_MAIL_ATTEMPTS, now, onSent: [delivered], raise: false },
      );
      if (mailOut.delivers !== false) sent++;
    } catch {
      // Recorded on the row; the next run tries again until the row is pruned.
    }
  }
  return sent;
}

/** A JSON column as a value, or nothing when it is not JSON. */
function parsed(v: unknown): unknown {
  if (typeof v !== "string") return v ?? undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** Tries at the code email before it counts as failed. */
const KEY_MAIL_ATTEMPTS = 8;

/** A code as the mail log keeps it: its network and the start, never the secret. */
function cutKey(key: string): string {
  const m = /^(sdkey1_[a-z0-9.-]+_[a-z2-7]{16}_)[a-z2-7]{32}$/.exec(key);
  return m ? `${m[1]}…` : "…";
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
