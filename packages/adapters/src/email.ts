import { type Caller, type Capabilities, type Db, lookupForms, schema, ulid } from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import PostalMime, { type Email } from "postal-mime";
import { consume, EVERYONE } from "./limits";

/**
 * The email door. Raw MIME comes from an Email Worker, a provider webhook or a forward; it is
 * parsed, deduplicated on Message-ID, threaded onto the item it answers (In-Reply-To/References,
 * a plus address, or a subject token), and otherwise becomes a new message item from a new party.
 * Quoted history is stripped from the stored text; the raw message is kept by the caller if wanted.
 */
export interface InboundEmail {
  readonly raw: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>;
  readonly envelopeTo?: string | undefined;
  readonly envelopeFrom?: string | undefined;
  readonly rawBlobKey?: string | undefined;
  /** Set when the receiving MTA verified DKIM/SPF (e.g. Cloudflare Email Routing). */
  readonly authenticated?: boolean | undefined;
}

export type IngestResult =
  | { readonly outcome: "created"; readonly itemId: string; readonly accessToken?: string | undefined }
  | { readonly outcome: "replied"; readonly itemId: string }
  | { readonly outcome: "duplicate"; readonly itemId: string | null }
  /** An automatic email (an out-of-office, a returned email) kept as a note on the item it answers. */
  | { readonly outcome: "noted"; readonly itemId: string }
  /** An automatic email that answers no item: not kept, never answered, never refused (a refusal would bounce). */
  | { readonly outcome: "dropped"; readonly reason: string }
  /**
   * Too many from this sender, or for the whole mailbox, right now: nothing kept. A temporary
   * failure, so the sending server tries again later (`retryAfterSec`), never a bounce.
   */
  | { readonly outcome: "limited"; readonly reason: string; readonly retryAfterSec: number }
  | { readonly outcome: "rejected"; readonly reason: string };

export const SUBJECT_TOKEN = /\[SDI-([0-9A-HJKMNP-TV-Z]{6,26})\]/i;

export async function parseEmail(raw: InboundEmail["raw"]): Promise<Email> {
  return PostalMime.parse(raw, { attachmentEncoding: "base64" });
}

export async function ingestEmail(
  db: Db,
  caps: Capabilities,
  mail: InboundEmail,
  opts: { now?: (() => number) | undefined } = {},
): Promise<IngestResult> {
  const now = opts.now ?? (() => Date.now());
  // The sender's own bucket first, then one for the whole mailbox (limits.ts), both before the
  // message is kept. In that order, a sender over its own limit — a mail loop, one script — takes
  // nothing from the mailbox's: were it the other way round, its refused mail would still spend the
  // mailbox's tokens, and one looping address would hold every customer's email back. A flood from
  // addresses that change with every message is bounded by the mailbox's bucket all the same.
  const envelope = mail.envelopeFrom?.trim().replace(/^<|>$/g, "").toLowerCase() || null;
  if (envelope) {
    const one = await consume(db, "emailSender", await senderBucket(envelope), now());
    if (!one.allowed) return limitedMail(one.retryAfterSec);
  }
  let parsed: Email | null = null;
  if (!envelope) {
    // Without an envelope sender (a forward, some webhooks), the From is who is counted.
    parsed = await parseEmail(mail.raw);
    const sender = parsed.from?.address?.toLowerCase();
    if (!sender) return { outcome: "rejected", reason: "no sender" };
    const one = await consume(db, "emailSender", await senderBucket(sender), now());
    if (!one.allowed) return limitedMail(one.retryAfterSec);
  }
  const everyone = await consume(db, "email", EVERYONE, now());
  if (!everyone.allowed) return limitedMail(everyone.retryAfterSec);
  parsed ??= await parseEmail(mail.raw);
  const from = parsed.from?.address?.toLowerCase();
  if (!from) return { outcome: "rejected", reason: "no sender" };
  const messageId = parsed.messageId?.trim() || null;
  if (messageId) {
    const [dup] = await db.orm
      .select({ itemId: schema.threadEntries.itemId })
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.messageId, messageId));
    if (dup) return { outcome: "duplicate", itemId: dup.itemId };
  }
  const text = cut(stripQuotedReply(parsed.text ?? htmlToText(parsed.html ?? "")).trim() || "(empty message)");
  const subject = (parsed.subject ?? "").trim();

  // An item whose customer was erased is answered by nothing: a reply to it starts afresh (a new
  // item the business can answer), and nothing is written back onto what was erased.
  const found = await findThreadItem(db, parsed, mail.envelopeTo);
  const itemId = found && !(await erasedItem(db, found)) ? found : null;
  // A mailbox answering by itself — an out-of-office, a returned email — never becomes a
  // conversation and never gets an answer, or two mailboxes could write to each other for ever. It
  // is kept as a note on the item it answers, for the business to read; answering none, it goes.
  if (isAutomaticMail(parsed, mail.envelopeFrom)) {
    const [row] = itemId
      ? await db.orm.select({ id: schema.items.id }).from(schema.items).where(eq(schema.items.id, itemId))
      : [];
    if (!row) {
      console.info("email: dropped an automatic email (an out-of-office or a returned email) that answers no item");
      return { outcome: "dropped", reason: "automatic email that answers no item" };
    }
    const at = now();
    await db.batch([
      {
        sql: `INSERT OR IGNORE INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, party_id, subject, body_text, body_format, message_id, created_at)
              VALUES (?, ?, 'note', 'email', 'system', NULL, NULL, ?, ?, 'text', ?, ?)`,
        params: [ulid(at), row.id, subject || null, `${AUTOMATIC_NOTE}\n\n${text}`.slice(0, 20_000), messageId, at],
        method: "run",
      },
    ]);
    return { outcome: "noted", itemId: row.id };
  }
  const caller: Caller = {
    actor: { kind: "customer_human", id: `email:${from}`, channel: "email" },
    tier: mail.authenticated ? "verified_principal" : "anonymous",
    sandbox: false,
    now,
    ...(messageId ? { idempotency: { scope: `email:${from}`, key: messageId } } : {}),
  };

  if (itemId) {
    const [row] = await db.orm
      .select({ id: schema.items.id, partyId: schema.items.partyId, accessTokenHash: schema.items.accessTokenHash })
      .from(schema.items)
      .where(eq(schema.items.id, itemId));
    if (row) {
      // The sender proves nothing but the thread; speak as the item's own party through the capability path.
      const asParty: Caller = { ...caller, actor: { ...caller.actor, partyId: row.partyId } };
      // The Message-ID rides with the reply onto its thread entry, so a second delivery of the same
      // email is known for what it is; an answer to what we asked moves the item on (ADR-018 N14).
      await caps.sendMessage(asParty, {
        item_id: row.id,
        body: text,
        ...(messageId ? { idempotency_key: messageId, message_id: messageId } : {}),
      });
      return { outcome: "replied", itemId: row.id };
    }
  }

  const created = await caps.sendMessage(caller, {
    body: text,
    ...(subject ? { subject } : {}),
    contact: { email: from, ...(parsed.from?.name ? { name: parsed.from.name } : {}) },
    ...(messageId ? { idempotency_key: messageId } : {}),
  });
  const view = (created as { view: { item: { id: string } }; accessToken?: string }).view;
  if (messageId)
    await db.client
      .query({
        sql: "UPDATE thread_entries SET message_id = ?, raw_blob_key = ? WHERE item_id = ? AND message_id IS NULL",
        params: [messageId, mail.rawBlobKey ?? null, view.item.id],
        method: "run",
      })
      .catch(() => undefined);
  return { outcome: "created", itemId: view.item.id, accessToken: (created as { accessToken?: string }).accessToken };
}

/**
 * Which item this email belongs to: the ids it names in In-Reply-To and References first — ours
 * (every email we send carries the item's anchor, `mail_refs`) or the customer's own earlier ones —
 * then a plus address, then a subject token. At most twenty ids are looked at, In-Reply-To and the
 * first and last of References, since a long thread's middle adds nothing a reply needs.
 */
async function findThreadItem(db: Db, parsed: Email, envelopeTo: string | undefined): Promise<string | null> {
  const references = (parsed.references ?? "").split(/\s+/).filter(Boolean);
  const named = [parsed.inReplyTo, ...(references.length > 20 ? [references[0], ...references.slice(-19)] : references)]
    .map((r) => r?.trim())
    .filter((r): r is string => Boolean(r))
    .slice(0, 20);
  if (named.length) {
    // Each id in the forms it may be stored in: bracketed or not, and a service's id as a local part.
    const forms = named.map((r) => lookupForms(r));
    const keys = [...new Set(forms.flat())].slice(0, 90);
    const { rows } = await db.client.query({
      sql: `SELECT ref, item_id FROM mail_refs WHERE ref IN (${keys.map(() => "?").join(", ")})`,
      params: keys,
      method: "all",
    });
    const byRef = new Map(rows.map((r) => [String(r[0]), String(r[1])]));
    for (const list of forms) {
      for (const key of list) {
        const hit = byRef.get(key);
        if (hit) return hit;
      }
    }
    const theirs = [...new Set(named)].slice(0, 90);
    const { rows: entries } = await db.client.query({
      sql: `SELECT message_id, item_id FROM thread_entries WHERE message_id IN (${theirs.map(() => "?").join(", ")})`,
      params: theirs,
      method: "all",
    });
    const byId = new Map(entries.map((r) => [String(r[0]), String(r[1])]));
    for (const ref of named) {
      const hit = byId.get(ref);
      if (hit) return hit;
    }
  }
  const recipients = [
    envelopeTo,
    ...(parsed.to ?? []).map((t) => t.address),
    ...(parsed.deliveredTo ? [parsed.deliveredTo] : []),
  ].filter((r): r is string => Boolean(r));
  for (const r of recipients) {
    const plus = /\+([0-9A-HJKMNP-TV-Z]{26})@/i.exec(r)?.[1];
    if (plus) {
      const [hit] = await db.orm
        .select({ id: schema.items.id })
        .from(schema.items)
        .where(eq(schema.items.id, plus.toUpperCase()));
      if (hit) return hit.id;
    }
  }
  const token = SUBJECT_TOKEN.exec(parsed.subject ?? "")?.[1];
  if (token) {
    const [hit] = await db.orm
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.id, token.toUpperCase()));
    if (hit) return hit.id;
  }
  return null;
}

/** Whether the item's customer was erased (`customers.erase`). */
async function erasedItem(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ? AND p.erased_at IS NOT NULL",
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * The bucket a sender is counted under: a hash of the address, never the address, so the limits
 * table holds nobody's email (an erased customer's included) for the day a bucket lives.
 */
async function senderBucket(address: string): Promise<string> {
  return `h:${(await sha256Hex(new TextEncoder().encode(address.slice(0, 320)))).slice(0, 32)}`;
}

function limitedMail(retryAfterSec: number): IngestResult {
  console.info("email: too many emails right now; answered with a temporary failure");
  return {
    outcome: "limited",
    reason: "too many emails right now; try again later",
    retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)),
  };
}

/**
 * A message's text as an item holds it: at most 20,000 characters (the schema's bound), the rest
 * cut with a line that says so. A longer email is still a request someone made; refusing it would
 * only have the sending server retry it for days.
 */
const MAX_TEXT = 20_000;
function cut(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const note = "\n\n[The rest of this email was cut: it was too long to keep.]";
  return `${text.slice(0, MAX_TEXT - note.length)}${note}`;
}

/** What heads an automatic email kept on its item, for the owner reading it. */
export const AUTOMATIC_NOTE = "An automatic email from the customer's mailbox (an out-of-office or a returned email):";

/**
 * An email no person wrote: an automatic reply (`isAutomaticReply`), or a returned email — a
 * delivery report (`multipart/report`), one naming `X-Failed-Recipients`, one from a mailer daemon or
 * a postmaster, or one with an empty return path.
 */
export function isAutomaticMail(parsed: Pick<Email, "headers" | "from">, envelopeFrom?: string | undefined): boolean {
  if (isAutomaticReply(parsed)) return true;
  if (envelopeFrom !== undefined && /^<?\s*>?$/.test(envelopeFrom.trim())) return true;
  const local = (parsed.from?.address ?? "").toLowerCase().split("@")[0] ?? "";
  if (local === "mailer-daemon" || local === "postmaster") return true;
  for (const h of parsed.headers ?? []) {
    const key = h.key.toLowerCase();
    const value = h.value.trim().toLowerCase();
    if (key === "content-type" && value.startsWith("multipart/report")) return true;
    if (key === "x-failed-recipients") return true;
    if (key === "return-path" && /^<\s*>$/.test(value)) return true;
  }
  return false;
}

/**
 * An email a mailbox sent by itself: an out-of-office, a vacation notice, an autoresponder (RFC 3834
 * `Auto-Submitted` other than `no`, the older `X-Autoreply`/`X-Autorespond`, or `Precedence:
 * auto_reply`, `bulk`, `junk`). Nobody wrote it, so it answers nothing.
 */
export function isAutomaticReply(parsed: Pick<Email, "headers">): boolean {
  for (const h of parsed.headers ?? []) {
    const key = h.key.toLowerCase();
    const value = h.value.trim().toLowerCase();
    if (key === "auto-submitted" && value && !value.startsWith("no")) return true;
    if (key === "x-autoreply" || key === "x-autorespond" || key === "x-autoresponder") return true;
    if (key === "precedence" && /^(auto_reply|bulk|junk)\b/.test(value)) return true;
  }
  return false;
}

/** Drops quoted history and signatures: the part after "On … wrote:", lines starting with ">", and a trailing "-- " signature. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (
      /^(On .{3,120} wrote:|Em .{3,120} escreveu:|Le .{3,120} a écrit ?:|Am .{3,120} schrieb .*:|-----Original Message-----|From: .+|De: .+)$/i.test(
        line.trim(),
      ) &&
      out.length > 0
    )
      break;
    if (line.trim() === "--") break;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
