import type { CustomerMailKind, MailAbout, MailHold, MailOut, OutboundMail, Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { LOOP_HEADER, loopMark } from "../email/channel";
import { ulid } from "../ids";
import { shortError } from "../network/index";
import type { Settings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { setFlags } from "../write/flags";

/**
 * The mail log (`outbound_mail`): every email the inbox sends, what it said and what became of it.
 * An email is rendered once and stored, then sent from the stored row: a retry sends the same words
 * and the same links, and the item shows whether it went out, is still being tried, or failed —
 * never "sent" before the service took it, and never "sent" by a transport that only logs. The row
 * keeps each answer link without its mac (`cutLinks`), so reading the log answers nothing for the
 * customer; the send makes the links whole again (`fillLinks`).
 *
 * Threading without a Message-ID of our own (Cloudflare writes that header itself and refuses a
 * message that sets it): every email about an item carries the item's random anchor first in its
 * References, and a customer's reply carries it back. `mail_refs` maps the anchor, each email's own
 * ref and the id the service returned to the item, and the email door looks a reply up there.
 */
export type MailStatus = "queued" | "sent" | "retrying" | "failed" | "skipped";
/**
 * `no_address`: the customer gave none; `no_sender`: nothing to send from; `no_service`: the instance
 * has no mail service, and its log took the email instead; `test_item`: a test item; `ack_limit`: the
 * address already had its acknowledgements for the day (`ACKS_PER_ADDRESS_PER_DAY`); `alert_limit`:
 * the owner already had the hour's alerts, and this one is in the hour's digest (`OWNER_ALERTS_PER_HOUR`);
 * `host_policy`: the transport does not send this kind of email to customers (`allowCustomerMail`);
 * and what the transport's `beforeSend` held it back for (`MailHold`).
 */
export type SkipReason =
  | "no_address"
  | "no_sender"
  | "no_service"
  | "test_item"
  | "ack_limit"
  | "alert_limit"
  | "host_policy"
  | MailHold;

export interface MailRow {
  readonly id: string;
  readonly itemId: string | null;
  readonly jobKey: string;
  readonly recipient: "customer" | "owner";
  readonly template: string;
  readonly lang: string;
  readonly entryId: string | null;
  readonly eventId: string | null;
  readonly subject: string;
  readonly bodyText: string;
  readonly messageRef: string;
  readonly providerId: string | null;
  readonly status: MailStatus;
  readonly skipReason: SkipReason | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sentAt: number | null;
}

/** What an email says, before it is stored. */
export interface ComposedMail {
  readonly itemId: string | null;
  readonly jobKey: string;
  readonly recipient: "customer" | "owner";
  readonly template: string;
  readonly lang: string;
  readonly entryId?: string | null | undefined;
  readonly eventId?: string | null | undefined;
  readonly subject: string;
  readonly text: string;
  /** Why it will not be sent, when that is already known. */
  readonly skip?: SkipReason | undefined;
}

const COLUMNS =
  "id, item_id, job_key, recipient, template, lang, entry_id, event_id, subject, body_text, message_ref, provider_id, status, skip_reason, attempts, last_error, created_at, updated_at, sent_at";

export async function mailByJob(db: Db, jobKey: string): Promise<MailRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM outbound_mail WHERE job_key = ?`,
    params: [jobKey],
    method: "all",
  });
  return rows[0] ? toRow(rows[0]) : null;
}

/** An item's emails, oldest first: what the owner's app shows under "Emails". */
export async function mailForItem(db: Db, itemId: string): Promise<MailRow[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM outbound_mail WHERE item_id = ? ORDER BY created_at, id`,
    params: [itemId],
    method: "all",
  });
  return rows.map(toRow);
}

/** Whether a customer email about the item exists already (the acknowledgement waits on it). */
export async function customerMailExists(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM outbound_mail WHERE item_id = ? AND recipient = 'customer' LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * Stores a composed email, in one batch with its own ref and, the first time the item has one, the
 * item's anchor. A second store of the same job (a retry after a crash) keeps the first row.
 */
export async function storeMail(db: Db, mail: ComposedMail, domain: string, now: number): Promise<MailRow> {
  const messageRef = msgId("m", domain);
  const statements: Statement[] = [
    {
      sql: `INSERT OR IGNORE INTO outbound_mail (${COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, ?, NULL)`,
      params: [
        ulid(),
        mail.itemId,
        mail.jobKey,
        mail.recipient,
        mail.template,
        mail.lang,
        mail.entryId ?? null,
        mail.eventId ?? null,
        mail.subject,
        mail.text,
        messageRef,
        mail.skip ? "skipped" : "queued",
        mail.skip ?? null,
        now,
        now,
      ],
      method: "run",
    },
  ];
  if (mail.itemId && mail.recipient === "customer" && !mail.skip) {
    statements.push(
      {
        sql: `INSERT OR IGNORE INTO mail_refs (ref, item_id, kind, created_at)
              SELECT ?, ?, 'anchor', ? WHERE NOT EXISTS (SELECT 1 FROM mail_refs WHERE item_id = ? AND kind = 'anchor')`,
        params: [msgId("a", domain), mail.itemId, now, mail.itemId],
        method: "run",
      },
      {
        sql: "INSERT OR IGNORE INTO mail_refs (ref, item_id, kind, created_at) VALUES (?, ?, 'sent', ?)",
        params: [messageRef, mail.itemId, now],
        method: "run",
      },
    );
  }
  await db.batch(statements);
  const row = await mailByJob(db, mail.jobKey);
  if (!row) throw new Error("the email was not stored");
  return row;
}

/**
 * The threading headers for an email about an item: `References` starts with the item's anchor,
 * then the customer's first and last own Message-IDs on it and the last two emails we sent;
 * `In-Reply-To` is the customer's last Message-ID, else the anchor.
 */
export async function threadHeaders(db: Db, itemId: string, own: string): Promise<Record<string, string>> {
  const [anchor, inbound, sent] = await Promise.all([
    db.client.query({
      sql: "SELECT ref FROM mail_refs WHERE item_id = ? AND kind = 'anchor' ORDER BY created_at, ref LIMIT 1",
      params: [itemId],
      method: "all",
    }),
    db.client.query({
      sql: `SELECT (SELECT message_id FROM thread_entries WHERE item_id = ? AND direction = 'in' AND message_id IS NOT NULL
                     ORDER BY created_at, id LIMIT 1),
                   (SELECT message_id FROM thread_entries WHERE item_id = ? AND direction = 'in' AND message_id IS NOT NULL
                     ORDER BY created_at DESC, id DESC LIMIT 1)`,
      params: [itemId, itemId],
      method: "all",
    }),
    db.client.query({
      sql: `SELECT message_ref FROM outbound_mail WHERE item_id = ? AND recipient = 'customer' AND status = 'sent'
              AND message_ref <> ? ORDER BY created_at DESC, id DESC LIMIT 2`,
      params: [itemId, own],
      method: "all",
    }),
  ]);
  const a = anchor.rows[0]?.[0] ? String(anchor.rows[0][0]) : null;
  const [first, last] = [inbound.rows[0]?.[0], inbound.rows[0]?.[1]].map((v) =>
    typeof v === "string" && isMsgId(v) ? v : undefined,
  );
  const ours = sent.rows.map((r) => String(r[0])).reverse();
  const refs = [...new Set([a, first, last, ...ours].filter((r): r is string => typeof r === "string" && isMsgId(r)))];
  const headers: Record<string, string> = {};
  const replyTo = last ?? a;
  if (replyTo) headers["In-Reply-To"] = replyTo;
  // At most six ids, and within the 2,048 bytes a header may hold.
  const kept: string[] = [];
  for (const r of refs.slice(0, 6)) {
    if ([...kept, r].join(" ").length > 2000) break;
    kept.push(r);
  }
  if (kept.length) headers.References = kept.join(" ");
  return headers;
}

/**
 * The headers that keep mailboxes from answering mailboxes (RFC 3834, and Microsoft's own):
 * `X-Auto-Response-Suppress` on every email, so an out-of-office does not answer it, and
 * `Auto-Submitted` on every email no person at the business caused — `auto-replied` when it answers
 * the customer (a reply, the acknowledgement), `auto-generated` otherwise. Cloudflare's sender does
 * not accept `Auto-Submitted` and leaves it out (`platform/src/mail.ts`); the `X-` header goes
 * everywhere.
 */
export function autoHeaders(opts: { readonly automatic: boolean; readonly template: string }): Record<string, string> {
  const reply = opts.template === "reply" || opts.template.startsWith("message.") || opts.template.startsWith("ack.");
  return {
    "X-Auto-Response-Suppress": "OOF, AutoReply",
    ...(opts.automatic ? { "Auto-Submitted": reply ? "auto-replied" : "auto-generated" } : {}),
  };
}

/**
 * Whether a person at the business caused an email: the owner or staff in the app or with their own
 * key (not through the owner's MCP), or a system the owner connected whose request said a person
 * wrote it. Everything else — a rule, the owner's AI, another system, the customer's own answer,
 * the inbox itself — is automatic.
 */
export function causedByPerson(actorKind: string | null, channel: string | null, writtenBy: string | null): boolean {
  if (writtenBy === "automation" || channel === "mcp_owner") return false;
  if (actorKind === "owner" || actorKind === "staff") return true;
  return actorKind === "integration" && writtenBy === "person";
}

/**
 * Sends a stored email and records what happened. The service took it: `sent`, with its id, which
 * also goes into `mail_refs` so a reply that names it lands on the item. It did not: `retrying`, or
 * at the job's last attempt `failed` — and a customer email that failed for good raises "needs a
 * person" on the item, so nobody takes it for sent. The error is thrown on, for the runner's backoff.
 */
export async function sendLogged(
  db: Db,
  mailOut: MailOut,
  row: MailRow,
  mail: OutboundMail,
  opts: {
    /** This is the last try: a failure is final. */
    readonly final: boolean;
    readonly now: number;
    /** Written with the success, in its batch. */
    readonly onSent?: readonly Statement[] | undefined;
    /** A failure for good asks for a person on the item (every customer email but the code email). */
    readonly raise?: boolean | undefined;
    /** For an email to a customer, what kind it is (`customerMailKind`); one without is `automatic`. */
    readonly kind?: CustomerMailKind | undefined;
  },
): Promise<string | null> {
  const { final, now } = opts;
  try {
    // What the transport lets go (`allowCustomerMail`, `beforeSend`): one held back is kept as not
    // sent, with the reason, and never retried as an error. Null says so to the caller.
    const held = await mailHeldBack(mailOut, mail, {
      recipient: row.recipient,
      template: row.template,
      ...(row.recipient === "customer" ? { kind: opts.kind ?? "automatic" } : {}),
    });
    if (held) {
      await db.client.query({
        sql: `UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        params: [held, now, row.id],
        method: "run",
      });
      return null;
    }
    // Every email carries this inbox's mark, so one that comes back is known for its own (ADR-026 §7).
    const { messageId } = await mailOut.send({
      ...mail,
      headers: { ...mail.headers, [LOOP_HEADER]: await loopMark(db, now) },
    });
    if (mailOut.delivers === false) {
      // A log took it, not a mail service: nobody got it, and the item must never say it was sent.
      await db.client.query({
        sql: `UPDATE outbound_mail SET status = 'skipped', skip_reason = 'no_service', attempts = attempts + 1,
                     last_error = NULL, updated_at = ? WHERE id = ?`,
        params: [now, row.id],
        method: "run",
      });
      return "";
    }
    const id = messageId?.trim() ?? "";
    const statements: Statement[] = [
      {
        sql: `UPDATE outbound_mail SET status = 'sent', provider_id = ?, sent_at = ?, attempts = attempts + 1,
                     last_error = NULL, updated_at = ? WHERE id = ?`,
        params: [id || null, now, now, row.id],
        method: "run",
      },
    ];
    if (id && row.itemId && row.recipient === "customer") {
      for (const ref of refForms(id)) {
        statements.push({
          sql: "INSERT OR IGNORE INTO mail_refs (ref, item_id, kind, created_at) VALUES (?, ?, 'provider', ?)",
          params: [ref, row.itemId, now],
          method: "run",
        });
      }
    }
    if (opts.onSent) statements.push(...opts.onSent);
    await db.batch(statements);
    return id;
  } catch (error) {
    const message = shortError(error instanceof Error ? error.message : String(error));
    await db.client.query({
      sql: `UPDATE outbound_mail SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      params: [final ? "failed" : "retrying", message, now, row.id],
      method: "run",
    });
    if (final && (opts.raise ?? true) && row.recipient === "customer" && row.itemId) {
      await raiseNotSent(db, row.itemId, now);
    }
    throw error;
  }
}

/**
 * Why the transport holds an email back, or null when it may go: a kind of customer email it does
 * not send (`host_policy`), or what its `beforeSend` said. An email to a customer always has a kind:
 * one that names none is asked about as `automatic`, the kind a transport is least likely to allow.
 */
export async function mailHeldBack(mailOut: MailOut, mail: OutboundMail, about: MailAbout): Promise<SkipReason | null> {
  const kind = about.recipient === "customer" ? (about.kind ?? "automatic") : undefined;
  if (kind && mailOut.allowCustomerMail && !(await mailOut.allowCustomerMail(kind))) return "host_policy";
  if (!mailOut.beforeSend) return null;
  return (await mailOut.beforeSend(mail, { ...about, ...(kind ? { kind } : {}) })) ?? null;
}

/**
 * The customer's mail server returned an email about this item as not delivered (a delivery report,
 * ADR-026 §7): the latest email the item sent them is marked failed, with why, and the item asks for
 * a person, as one that failed to go does. Nothing when no email to the customer was sent.
 */
export async function mailReturned(db: Db, itemId: string, reason: string, now: number): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT id FROM outbound_mail WHERE item_id = ? AND recipient = 'customer' AND status = 'sent'
           ORDER BY sent_at DESC, id DESC LIMIT 1`,
    params: [itemId],
    method: "all",
  });
  const id = rows[0]?.[0];
  if (id === undefined || id === null) return false;
  await db.client.query({
    sql: "UPDATE outbound_mail SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
    params: [shortError(reason), now, String(id)],
    method: "run",
  });
  await raiseNotSent(db, itemId, now);
  return true;
}

/** A customer email that will not go out: the item asks for a person, as the system. */
async function raiseNotSent(db: Db, itemId: string, now: number): Promise<void> {
  const system: Caller = {
    actor: { kind: "system", id: "mail", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await setFlags(db, system, { itemId, flags: { needsHuman: true }, reason: "We could not email the customer" });
      return;
    } catch {
      // Someone moved the item at the same moment: read it again once, then leave it to the log.
    }
  }
}

/**
 * The sender every customer email is from, and where a reply goes; null when there is no address to
 * send from. A pinned transport (`pinnedMailOut`) is who the email is from whatever Settings say:
 * its address, its name when it has one, and no Reply-To from Settings (it sets its own).
 */
export function senderOf(
  settings: Settings,
  opts: {
    /** How email goes out: its own address (MAIL_FROM), and whether every message goes from it. */
    readonly transport?: Pick<MailOut, "sender" | "pinned"> | null | undefined;
    readonly publicUrl?: string | undefined;
    /** The business's name as its profile gives it (`businessFacts`), which the setup wizard writes. */
    readonly business?: string | undefined;
  } = {},
): Pick<OutboundMail, "from" | "replyTo"> | null {
  const own = opts.transport?.sender;
  const pinned = opts.transport?.pinned === true ? own : undefined;
  const address = pinned ? pinned.address : (settings.email.fromAddress ?? own?.address);
  if (!address) return null;
  // The business's name, never the software's: its own, else the address its customers use.
  const name = pinned
    ? pinned.name || opts.business?.trim() || settings.business.name.trim() || hostOf(opts.publicUrl)
    : settings.email.fromName ||
      opts.business?.trim() ||
      settings.business.name.trim() ||
      own?.name ||
      hostOf(opts.publicUrl);
  return {
    from: { address, ...(name ? { name } : {}) },
    ...(!pinned && settings.email.replyTo ? { replyTo: settings.email.replyTo } : {}),
  };
}

/** The domain our msg-ids carry: the sender's. */
export function mailDomain(address: string | undefined, publicUrl?: string | undefined): string {
  const at = address?.lastIndexOf("@") ?? -1;
  if (address && at > 0) return address.slice(at + 1).toLowerCase();
  return hostOf(publicUrl) || "localhost";
}

/**
 * The forms a provider's id can come back in a reply: as given, in angle brackets, and — since a
 * service may write its id as a Message-ID's local part — that is matched too (`lookupForms`).
 */
function refForms(id: string): string[] {
  const bare = id.replace(/^<|>$/g, "");
  return [...new Set([id, bare, `<${bare}>`])];
}

/** The keys a ref a reply names is looked up by: itself, bracketed and not, and its local part. */
export function lookupForms(ref: string): string[] {
  const bare = ref.trim().replace(/^<|>$/g, "");
  if (!bare) return [];
  const at = bare.lastIndexOf("@");
  return [...new Set([`<${bare}>`, bare, ...(at > 0 ? [bare.slice(0, at)] : [])])];
}

function msgId(kind: "a" | "m", domain: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(36).padStart(2, "0");
  return `<${kind}.${s.slice(0, 22)}@${domain}>`;
}

const isMsgId = (s: string): boolean => /^<[^<>\s]{1,250}@[^<>\s]{1,250}>$/.test(s);

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function toRow(r: readonly unknown[]): MailRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r[0]),
    itemId: s(r[1]),
    jobKey: String(r[2]),
    recipient: r[3] === "owner" ? "owner" : "customer",
    template: String(r[4]),
    lang: String(r[5]),
    entryId: s(r[6]),
    eventId: s(r[7]),
    subject: String(r[8]),
    bodyText: String(r[9]),
    messageRef: String(r[10]),
    providerId: s(r[11]),
    status: String(r[12]) as MailStatus,
    skipReason: s(r[13]) as SkipReason | null,
    attempts: Number(r[14] ?? 0),
    lastError: s(r[15]),
    createdAt: Number(r[16]),
    updatedAt: Number(r[17]),
    sentAt: n(r[18]),
  };
}
