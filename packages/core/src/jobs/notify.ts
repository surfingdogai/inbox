import type { MailOut, OutboundMail } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { type BusinessFacts, businessFacts } from "../customer/audience";
import { oneLine } from "../customer/format";
import { customerLang } from "../customer/lang";
import { cutLinks, fillLinks, linksForEmail } from "../customer/links";
import { isAutomated, type MailWithdrawal, renderCustomerMail } from "../customer/mail";
import type { OfferTerms } from "../customer/offer";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { machines } from "../machine/tables";
import { lawOf } from "../negotiation/holidays";
import { items, parties } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import { withdrawalOf } from "../write/returns";
import { describe, rowToItem } from "../write/views";
import {
  autoHeaders,
  type ComposedMail,
  causedByPerson,
  customerMailExists,
  mailByJob,
  mailDomain,
  senderOf,
  sendLogged,
  storeMail,
  threadHeaders,
} from "./mail-log";
import type { JobHandler } from "./runner";
import { ensureJob } from "./schedule";

export { senderOf } from "./mail-log";

/**
 * Turns a `notify` job into an email: to the customer at the address they gave, to the owner at the
 * one settings name. Each is rendered once into the mail log (`mail-log.ts`) and sent from there, so
 * a retry sends the same email and the item shows what became of it.
 *
 * The customer most often does not know which software a business runs, or that there is any: they
 * wrote to the business. So every email to them is the business speaking, in its own name, its own
 * words and its customer's language (`customer/mail.ts`), and nothing in it names anyone else. A
 * first-time customer's code for their assistant never rides on these: it goes alone, a day later
 * (`lifecycle.ts`).
 */
export interface NotifyPayload {
  readonly to: "owner" | "customer";
  readonly itemId: string;
  /** What happened: a transition's event, `create`, or `message` for a reply. */
  readonly event: string;
  /** The transition that caused it, when one did. */
  readonly eventId?: string;
  /** The thread entry an outgoing message is, for `event: "message"`. */
  readonly entry?: string;
}

export function notifyHandler(
  mailOut: MailOut,
  opts: { baseUrl?: string; secrets?: SecretBox | null } = {},
): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as NotifyPayload;
    const [row] = await db.orm.select().from(items).where(eq(items.id, p.itemId));
    if (!row) return { note: "item gone" };
    const item = rowToItem(row);
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    // The owner is told at the address they gave, else at the one they sign in with: an owner who
    // never filled the field in still hears of a new request. With neither, the row says so.
    const ownerAddress = p.to === "owner" ? await ownerAddressOf(db, settings) : null;
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut.sender, publicUrl, business: facts.name });
    const contact = p.to === "customer" ? await contactOf(db, item.partyId) : null;

    let logged = await mailByJob(db, job.id);
    if (!logged) {
      const composed =
        p.to === "owner"
          ? await capOwnerAlerts(
              db,
              ownerMail(item, p, settings, await nameOf(db, item.partyId), job.id, sender !== null),
              now,
            )
          : await customerMail(db, item, p, {
              jobKey: job.id,
              contact,
              canSend: sender !== null,
              secrets: opts.secrets ?? null,
              base: publicUrl,
              settings,
              facts,
              now,
            });
      if ("note" in composed) return { note: composed.note };
      logged = await storeMail(db, composed, mailDomain(sender?.from.address, publicUrl), now);
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };

    const address = p.to === "owner" ? ownerAddress : (contact?.email ?? null);
    if (!address || !sender) {
      // The address or the sender went away while the email waited: it is not sent, and says why.
      await db.client.query({
        sql: "UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?",
        params: [address ? "no_sender" : "no_address", now, logged.id],
        method: "run",
      });
      return { note: `not sent: ${address ? "no sender" : "no address"}` };
    }
    // Threading for the customer's mail client; for every mailbox, the headers that say nobody should
    // answer this automatically, and whether anybody at the business wrote it.
    const cause = logged.recipient === "customer" ? await causeOf(db, p) : null;
    const headers = {
      ...(logged.recipient === "customer" ? await threadHeaders(db, item.id, logged.messageRef) : {}),
      ...autoHeaders({
        automatic: cause === null || !causedByPerson(cause.actorKind, cause.channel, cause.writtenBy),
        template: logged.template,
      }),
    };
    const mail: OutboundMail = {
      ...sender,
      to: [address],
      subject: logged.subject,
      // The log keeps the links cut (`cutLinks`); only the email the customer gets carries them whole.
      text:
        logged.recipient === "customer"
          ? await fillLinks(db, opts.secrets ?? null, logged.bodyText, {
              mailKey: logged.jobKey,
              itemId: logged.itemId,
            })
          : logged.bodyText,
      headers,
    };
    await sendLogged(db, mailOut, logged, mail, { final: job.attempts >= job.maxAttempts, now });
    // The job log says who it went to, never their address: the log is not where customers are kept.
    return { note: `sent to the ${p.to}` };
  };
}

/**
 * Where the owner's emails go: `notifications.ownerEmail`, else the first owner's sign-in address.
 * Null when there is neither.
 */
export async function ownerAddressOf(db: Db, settings: Settings): Promise<string | null> {
  if (settings.notifications.ownerEmail) return settings.notifications.ownerEmail;
  const { rows } = await db.client.query({
    sql: "SELECT email FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1",
    method: "all",
  });
  const email = rows[0]?.[0];
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

interface Contact {
  readonly email: string | null;
  readonly name: string | null;
  readonly locale: string | null;
}

/** What the item's customer gave: its party's (a merge moves the item to the known party). */
async function contactOf(db: Db, partyId: string): Promise<Contact | null> {
  const [party] = await db.orm.select({ contact: parties.contact }).from(parties).where(eq(parties.id, partyId));
  const c = (party?.contact ?? null) as { email?: unknown; name?: unknown; locale?: unknown } | null;
  if (!c) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { email: str(c.email), name: str(c.name), locale: str(c.locale) };
}

/** The address the item's customer gave, if any. */
export async function customerEmail(db: Db, partyId: string): Promise<string | null> {
  return (await contactOf(db, partyId))?.email ?? null;
}

async function nameOf(db: Db, partyId: string): Promise<string> {
  const [party] = await db.orm
    .select({ displayName: parties.displayName })
    .from(parties)
    .where(eq(parties.id, partyId));
  return party?.displayName ?? "a customer";
}

async function customerMail(
  db: Db,
  item: Item,
  p: NotifyPayload,
  o: {
    readonly jobKey: string;
    readonly contact: Contact | null;
    readonly canSend: boolean;
    readonly secrets: SecretBox | null;
    readonly base: string;
    readonly settings: Settings;
    readonly facts: BusinessFacts;
    readonly now: number;
  },
): Promise<ComposedMail | { note: string }> {
  // The acknowledgement goes only while nothing has happened since the request: a booking a rule
  // confirmed in the meantime gets its confirmation, not both. A return is acknowledged as it starts,
  // agreed or not: a withdrawal is acknowledged at once (ADR-018 §7).
  if (p.event === "create" && item.type !== "refund") {
    if (item.state !== machines[item.type].initial || (await customerMailExists(db, item.id))) {
      return { note: "no acknowledgement: the customer already heard from us" };
    }
  }
  // Anyone can make a request with any address, and the acknowledgement goes out unasked, in the
  // business's name: a few a day to one address, so nobody can use the business to fill a stranger's
  // mailbox. What the business itself does next is always sent. One held back shows on the item.
  const ackLimited =
    p.event === "create" &&
    item.type !== "refund" &&
    !item.flags.sandbox &&
    Boolean(o.contact?.email) &&
    (await acksToday(db, o.contact?.email ?? "", o.now)) >= ACKS_PER_ADDRESS_PER_DAY;
  const facts = o.facts;
  const lang = customerLang(o.contact?.locale, facts.languages);
  const cause = await causeOf(db, p);
  // What lapsed, and until when it could have been taken. One that lapsed long before anybody noticed
  // (an offer from before offers had a table, reached late) closes quietly: news that old is no news.
  const lapsedAt = p.event === "expire" && p.eventId ? await lapsedAtOf(db, p.eventId) : null;
  if (lapsedAt !== null && o.now - lapsedAt > STALE_EXPIRY_MS) {
    return { note: "no email: what lapsed had lapsed long before" };
  }
  // A test item emails nobody (the founder, 23 September 2026): it is kept, and says so.
  const skip = item.flags.sandbox
    ? ("test_item" as const)
    : !o.contact?.email
      ? ("no_address" as const)
      : ackLimited
        ? ("ack_limit" as const)
        : !o.canSend
          ? ("no_sender" as const)
          : undefined;
  // What waits for the customer's answer carries the links to give it: a page on this inbox, in
  // the customer's language (ADR-018 §5). Without a secret to sign them, or an address for them to
  // point at, the email asks for a reply instead.
  // The right of withdrawal as it stands (ADR-018 §7): the confirmations carry it, and its link.
  const law = lawOf(o.settings.commerce.legal.country);
  const right =
    item.type === "booking" || item.type === "order" ? await withdrawalOf(db, item, o.settings, o.now) : null;
  const withdrawal: MailWithdrawal = {
    available: right?.available === true,
    until: right?.until ? new Date(right.until).toISOString() : null,
    kind: item.type === "booking" ? "service" : "goods",
    exception: right?.exception && right.exception !== "standard" ? right.exception : null,
    law,
    days: o.settings.returns.days,
  };
  const links = skip
    ? null
    : await linksForEmail(db, o.secrets, item, {
        mailKey: o.jobKey,
        lang,
        base: o.base,
        now: o.now,
        minNoticeMin: o.settings.booking.minNoticeMin,
        ...(right?.available && CONFIRMING.has(p.event) ? { withdraw: { until: right.until } } : {}),
      });
  // The return or refund the change made: what the email says of the money.
  const refund = item.type !== "refund" && p.eventId ? await refundMadeBy(db, item.id, p.eventId) : null;
  const [linkedRow] = item.linkedItemId ? await db.orm.select().from(items).where(eq(items.id, item.linkedItemId)) : [];
  const rendered = renderCustomerMail({
    item,
    event: p.event,
    fromState: cause.fromState,
    actorKind: cause.actorKind,
    automated: isAutomated(cause.actorKind, cause.channel, cause.writtenBy),
    words: cause.words,
    lang,
    timezone: facts.timezone,
    business: facts.name,
    name: o.contact?.name ?? null,
    links,
    linked: linkedRow ? rowToItem(linkedRow) : null,
    unpriced: (p.event === "create" || item.state === "proposed") && (await createdUnpriced(db, item.id)),
    cancellationWindowMin: o.settings.booking.cancellationWindowMin,
    minNoticeMin: o.settings.booking.minNoticeMin,
    revised:
      (p.event === "quote" && cause.fromState === "quoted") ||
      (p.event === "propose" && cause.fromState === "proposed"),
    lapsedAt: lapsedAt === null ? null : new Date(lapsedAt).toISOString(),
    closedChange: p.eventId && CLOSES_CHANGE.has(p.event) ? await closedChangeOf(db, p.eventId) : null,
    withdrawal,
    trader: o.settings.commerce.legal,
    refund,
    returns: { respondHours: o.settings.returns.respondHours, postage: o.settings.returns.postage },
    now: o.now,
  });
  return {
    itemId: item.id,
    jobKey: o.jobKey,
    recipient: "customer",
    template: rendered.template,
    lang,
    entryId: cause.entryId,
    eventId: p.eventId ?? null,
    subject: rendered.subject,
    // Kept without the links' macs: what the log shows can never answer for the customer.
    text: cutLinks(rendered.text),
    ...(skip ? { skip } : {}),
  };
}

/**
 * The events whose email confirms a contract the customer may withdraw from, and so carries the link
 * to withdraw (ADR-018 §7; CRD arts. 8(7), 11a).
 */
const CONFIRMING: ReadonlySet<string> = new Set([
  "confirm",
  "accept",
  "accept_change",
  "record_payment",
  "request_payment",
  "fulfil",
]);

/** The return or refund an event of an order or a booking made: created in the same batch, caused by it. */
async function refundMadeBy(db: Db, itemId: string, eventId: string): Promise<Item | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.id FROM items i JOIN item_events e ON e.item_id = i.id AND e.seq = 1
           WHERE i.type = 'refund' AND i.linked_item_id = ? AND e.causation_id = ? LIMIT 1`,
    params: [itemId, eventId],
    method: "all",
  });
  const id = rows[0]?.[0];
  if (id === null || id === undefined) return null;
  const [row] = await db.orm
    .select()
    .from(items)
    .where(eq(items.id, String(id)));
  return row ? rowToItem(row) : null;
}

/** The owner's email: what happened, who it is from, where to open it. In the owner's app's language. */
function ownerMail(
  item: Item,
  p: NotifyPayload,
  settings: Settings,
  who: string,
  jobKey: string,
  canSend: boolean,
): ComposedMail {
  const appUrl = settings.notifications.appUrl ?? "";
  return {
    itemId: item.id,
    jobKey,
    recipient: "owner",
    template: `owner.${p.event}`,
    lang: "en",
    eventId: p.eventId ?? null,
    // One line, whatever the customer typed as their name or subject: a subject with a line break
    // in it is refused by a mail service, and the owner would never hear of the request.
    subject: oneLine(ownerSubject(item, p.event, who)),
    text: [
      describe(item),
      "",
      `From: ${who}`,
      ...(appUrl ? [`Open: ${appUrl}/items/${item.id}`] : []),
      "",
      "Reply in your inbox to answer.",
    ].join("\n"),
    ...(item.flags.sandbox ? { skip: "test_item" as const } : canSend ? {} : { skip: "no_sender" as const }),
  };
}

/**
 * Alerts the owner gets in an hour, at most, one per new request or message. A flood — a script, a
 * mail loop, a busy morning — would bury the owner's mailbox and the mail service's goodwill with
 * it; past this, each alert is kept on its item (`alert_limit`, shown there) and the owner gets one
 * digest at the end of the hour saying how many more came and which, with the link to see them.
 */
export const OWNER_ALERTS_PER_HOUR = 20;

/** The job that sends the hour's digest. */
export const OWNER_DIGEST_KIND = "owner_digest";

const HOUR = 3_600_000;

/**
 * An owner alert as it will be stored: itself while the hour has room, else held back for the
 * hour's digest, which it queues (once per clock hour, at the end of it).
 */
async function capOwnerAlerts(db: Db, mail: ComposedMail, now: number): Promise<ComposedMail> {
  if (mail.skip) return mail;
  const since = now - HOUR;
  const { rows } = await db.client.query({
    sql: `SELECT COUNT(*) FROM outbound_mail
           WHERE status IN ('queued', 'retrying', 'sent') AND updated_at >= ? AND created_at >= ?
             AND recipient = 'owner' AND template LIKE 'owner.%' AND template <> 'owner.digest'`,
    params: [since, since],
    method: "all",
  });
  if (Number(rows[0]?.[0] ?? 0) < OWNER_ALERTS_PER_HOUR) return mail;
  const bucket = Math.floor(now / HOUR);
  await ensureJob(db, OWNER_DIGEST_KIND, `${OWNER_DIGEST_KIND}:${bucket}`, {
    now,
    runAt: (bucket + 1) * HOUR,
    payload: { from: bucket * HOUR, to: (bucket + 1) * HOUR },
  });
  return { ...mail, skip: "alert_limit" };
}

/**
 * The hour's digest: one email to the owner naming the alerts held back in it, newest last, at most
 * thirty by name. It goes through the mail log like every other email, so a retry sends it once.
 */
export function ownerDigestHandler(mailOut: MailOut, opts: { baseUrl?: string } = {}): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as { from: number; to: number };
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut.sender, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    if (!logged) {
      const { rows } = await db.client.query({
        sql: `SELECT item_id, subject FROM outbound_mail
               WHERE status = 'skipped' AND skip_reason = 'alert_limit' AND updated_at >= ? AND updated_at < ?
                 AND recipient = 'owner'
               ORDER BY created_at, id`,
        params: [p.from, p.to],
        method: "all",
      });
      if (rows.length === 0) return { note: "no alert was held back" };
      const appUrl = settings.notifications.appUrl ?? "";
      const shown = rows.slice(-30);
      const text = [
        `${rows.length} more request${rows.length === 1 ? "" : "s"} and message${rows.length === 1 ? "" : "s"} came in this hour than the ${OWNER_ALERTS_PER_HOUR} alerts an hour this inbox sends. Each one is in your inbox; ${rows.length > shown.length ? `the last ${shown.length}` : rows.length === 1 ? "it is" : "they are"}:`,
        "",
        ...shown.map(
          (r) => `- ${oneLine(String(r[1] ?? ""))}${appUrl && r[0] ? ` ${appUrl}/items/${String(r[0])}` : ""}`,
        ),
        "",
        ...(appUrl ? [`Open: ${appUrl}`, ""] : []),
        "So many at once can be a busy hour, or someone sending requests by the hundred. Nothing was lost.",
      ].join("\n");
      logged = await storeMail(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: "owner.digest",
          lang: "en",
          subject: oneLine(`${rows.length} more new request${rows.length === 1 ? "" : "s"} this hour`),
          text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };
    const address = await ownerAddressOf(db, settings);
    if (!address || !sender) {
      await db.client.query({
        sql: "UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?",
        params: [address ? "no_sender" : "no_address", now, logged.id],
        method: "run",
      });
      return { note: `not sent: ${address ? "no sender" : "no address"}` };
    }
    await sendLogged(
      db,
      mailOut,
      logged,
      {
        ...sender,
        to: [address],
        subject: logged.subject,
        text: logged.bodyText,
        headers: autoHeaders({ automatic: true, template: logged.template }),
      },
      { final: job.attempts >= job.maxAttempts, now },
    );
    return { note: "digest sent to the owner" };
  };
}

/** An expiry told this long after the date it passed is not told at all. */
export const STALE_EXPIRY_MS = 7 * 86_400_000;

/** Until when the offer an expiry closed could have been accepted, or null. */
async function lapsedAtOf(db: Db, eventId: string): Promise<number | null> {
  const { rows } = await db.client.query({
    sql: "SELECT valid_through FROM item_offers WHERE closed_event_id = ? AND status = 'expired' AND by = 'business' LIMIT 1",
    params: [eventId],
    method: "all",
  });
  const at = rows[0]?.[0];
  return at === null || at === undefined ? null : Number(at);
}

/** The events that close a change to a promise without making it. */
const CLOSES_CHANGE: ReadonlySet<string> = new Set(["decline_change", "retract_change", "expire_change"]);

/** The change an event closed: who asked for it, and the promise as it would have been. */
async function closedChangeOf(
  db: Db,
  eventId: string,
): Promise<{ by: "business" | "customer"; terms: OfferTerms } | null> {
  const { rows } = await db.client.query({
    sql: "SELECT by, terms FROM item_offers WHERE closed_event_id = ? AND kind = 'change' LIMIT 1",
    params: [eventId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  let terms: OfferTerms = {};
  try {
    terms = (typeof r[1] === "string" ? JSON.parse(r[1]) : r[1]) as OfferTerms;
  } catch {
    terms = {};
  }
  return { by: r[0] === "customer" ? "customer" : "business", terms };
}

/** Acknowledgements one address gets in a day, at most. */
export const ACKS_PER_ADDRESS_PER_DAY = 3;

/** The acknowledgements this address got in the last day, sent or on their way. */
async function acksToday(db: Db, email: string, now: number): Promise<number> {
  const since = now - 86_400_000;
  const { rows } = await db.client.query({
    sql: `SELECT COUNT(*) FROM outbound_mail m
            JOIN items i ON i.id = m.item_id
            JOIN parties p ON p.id = i.party_id
           WHERE m.status IN ('queued', 'retrying', 'sent') AND m.updated_at >= ? AND m.created_at >= ?
             AND m.recipient = 'customer' AND m.template LIKE 'ack.%'
             AND lower(trim(json_extract(p.contact, '$.email'))) = ?`,
    params: [since, since, email.trim().toLowerCase()],
    method: "all",
  });
  return Number(rows[0]?.[0] ?? 0);
}

/** Whether the request held a price the business had not set when it came in (ADR-018 §3.2). */
async function createdUnpriced(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM item_events WHERE item_id = ? AND seq = 1 AND json_extract(meta, '$.unpriced') = 1 LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Who caused the email, and the business's own words with it: the reply an outgoing message is,
 * or the note written with the transition (written in the same batch, at the same instant).
 */
export async function causeOf(
  db: Db,
  p: Pick<NotifyPayload, "entry" | "eventId">,
): Promise<{
  actorKind: string | null;
  channel: string | null;
  words: string | null;
  fromState: string | null;
  entryId: string | null;
  /** Who wrote it, when the request said (`written_by`). */
  writtenBy: string | null;
}> {
  if (p.entry) {
    const { rows } = await db.client.query({
      sql: "SELECT actor_kind, body_text, channel, written_by FROM thread_entries WHERE id = ? AND direction = 'out'",
      params: [p.entry],
      method: "all",
    });
    const r = rows[0];
    return {
      actorKind: r ? String(r[0]) : null,
      channel: r?.[2] ? String(r[2]) : null,
      words: textOf(r?.[1]),
      fromState: null,
      entryId: r ? p.entry : null,
      writtenBy: typeof r?.[3] === "string" ? r[3] : null,
    };
  }
  if (!p.eventId) {
    return { actorKind: null, channel: null, words: null, fromState: null, entryId: null, writtenBy: null };
  }
  const { rows } = await db.client.query({
    sql: `SELECT e.actor_kind, t.body_text, e.from_state, t.id, json_extract(e.meta, '$.channel'),
                 json_extract(e.meta, '$.written_by')
            FROM item_events e
            LEFT JOIN thread_entries t ON t.id = (
              SELECT t2.id FROM thread_entries t2
               WHERE t2.item_id = e.item_id AND t2.direction = 'out' AND t2.created_at = e.created_at
               ORDER BY t2.id DESC LIMIT 1)
           WHERE e.id = ?`,
    params: [p.eventId],
    method: "all",
  });
  const r = rows[0];
  const from = r?.[2];
  return {
    actorKind: r ? String(r[0]) : null,
    channel: typeof r?.[4] === "string" ? r[4] : null,
    words: textOf(r?.[1]),
    fromState: typeof from === "string" ? from : null,
    entryId: r?.[3] ? String(r[3]) : null,
    writtenBy: typeof r?.[5] === "string" ? r[5] : null,
  };
}

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const CHANGE_WORDS: Readonly<Record<string, string>> = {
  propose_change: "asks for a change",
  accept_change: "accepted your change",
  decline_change: "keeps it as agreed",
  retract_change: "withdrew their change",
  // Returns (ADR-018 §3.4, §7): what the customer did, in the owner's words.
  withdraw: "withdrew from the contract",
  request_return: "asks to send it back",
};

const TYPE_WORD: Record<Item["type"], string> = {
  message: "message",
  quote_request: "quote request",
  booking: "booking",
  order: "order",
  refund: "return",
};

function ownerSubject(item: Item, event: string, who: string): string {
  if (event === "create") return `New ${TYPE_WORD[item.type]} from ${who}: ${item.subject ?? ""}`.trim();
  // A refund whose date is near (ADR-018 §7): it is owed by then, and late it is owed twice in Portugal.
  if (event === "refund_due" && item.type === "refund") {
    const due = item.payload.refundDue ? ` by ${item.payload.refundDue.slice(0, 10)}` : "";
    return `Refund due${due}: ${who}, ${item.subject ?? TYPE_WORD[item.type]}`;
  }
  if (event === "message") return `${who} replied: ${item.subject ?? TYPE_WORD[item.type]}`;
  // What automation would have offered outside the owner's limits waits for them (ADR-018 §4).
  if (event === "draft_offer") {
    return `A draft waits for you, outside your limits: ${TYPE_WORD[item.type]} for ${who}, ${item.subject ?? ""}`.trim();
  }
  // A reply automation wrote naming money we have not offered, kept for them as a note (ADR-018 §4).
  if (event === "held_reply") {
    return `A reply waits for you, naming an amount: ${TYPE_WORD[item.type]} for ${who}, ${item.subject ?? ""}`.trim();
  }
  // A change to what was agreed says what happened to it: the state it leaves is the one it had.
  if (event === "cancel" && item.type === "refund") return `${who} dropped their return: ${item.subject ?? ""}`.trim();
  const change = CHANGE_WORDS[event];
  if (change) return `${who} ${change}: ${TYPE_WORD[item.type]} ${item.subject ?? ""}`.trim();
  return `${who}: ${TYPE_WORD[item.type]} ${item.state.replaceAll("_", " ")}`;
}
