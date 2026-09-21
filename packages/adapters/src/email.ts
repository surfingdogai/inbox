import { type Caller, type Capabilities, type Db, schema } from "@surfingdog/core";
import { eq } from "drizzle-orm";
import PostalMime, { type Email } from "postal-mime";

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
  const parsed = await parseEmail(mail.raw);
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
  const text = stripQuotedReply(parsed.text ?? htmlToText(parsed.html ?? "")).trim() || "(empty message)";
  const subject = (parsed.subject ?? "").trim();

  const itemId = await findThreadItem(db, parsed, mail.envelopeTo);
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
      await caps.sendMessage(asParty, {
        item_id: row.id,
        body: text,
        ...(messageId ? { idempotency_key: messageId } : {}),
      });
      if (messageId)
        await db.client
          .query({
            sql: "UPDATE thread_entries SET message_id = ? WHERE item_id = ? AND message_id IS NULL AND direction = 'in' ORDER BY created_at DESC LIMIT 1",
            params: [messageId, row.id],
            method: "run",
          })
          .catch(() => undefined);
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

/** Which item this email belongs to: reply headers first, then a plus address, then a subject token. */
async function findThreadItem(db: Db, parsed: Email, envelopeTo: string | undefined): Promise<string | null> {
  const refs = [parsed.inReplyTo, ...(parsed.references ?? "").split(/\s+/)]
    .map((r) => r?.trim())
    .filter((r): r is string => Boolean(r));
  for (const ref of refs) {
    const [hit] = await db.orm
      .select({ itemId: schema.threadEntries.itemId })
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.messageId, ref));
    if (hit) return hit.itemId;
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
