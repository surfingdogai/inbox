import {
  baseAddress,
  type Caller,
  type Capabilities,
  CHECK_HEADER,
  checkArrived,
  confirmationSender,
  type Db,
  findMailToken,
  forwardsSeen,
  inboundOf,
  keepAttachments,
  keepConfirmation,
  LOOP_HEADER,
  lookupForms,
  loopMark,
  mailReturned,
  ownerAddresses,
  plusAddress,
  readSettings,
  recogniseConfirmation,
  schema,
  setFlags,
  signInAddresses,
  splitAddress,
  tokensIn,
  touchMailToken,
  ulid,
  WriteError,
} from "@surfingdog/core";
import { sha256Hex } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import PostalMime, { type Email } from "postal-mime";
import { consume, EVERYONE } from "./limits";

/**
 * The email door (ADR-005, ADR-026). Raw MIME comes from an Email Worker, a provider webhook, a
 * forward, or the hosted gateway; it is parsed and then, in this order:
 *
 * 1. a forwarding check of this inbox's own coming back proves the forward works, and stops there;
 * 2. an email of this inbox's own coming back any other way (its mark, `X-Inbox-Loop`), or one that
 *    has been passed around too often, is dropped: never answered, never kept;
 * 3. a second delivery of an email already kept (its Message-ID) is a duplicate;
 * 4. a mail provider asking to confirm forwarding is kept on the forward for the owner to see;
 * 5. an answer to an owner's alert (`name+o…@`) from the owner's own address becomes the business's
 *    reply to the customer; from anyone else, nothing;
 * 6. an automatic email (an out-of-office, a returned email) is a note on the item it answers;
 * 7. anything else lands on the item it answers — its conversation's address (`name+t…@`), the ids it
 *    names, then the older plus address or subject token — or becomes a new message, put aside as
 *    spam when what it carries says so. What it had attached is kept within limits.
 *
 * Quoted history is stripped from the stored text; the raw message is kept by the caller if wanted.
 */
export interface InboundEmail {
  readonly raw: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>;
  readonly envelopeTo?: string | undefined;
  readonly envelopeFrom?: string | undefined;
  readonly rawBlobKey?: string | undefined;
  /** Set when the receiving MTA verified DKIM/SPF (e.g. Cloudflare Email Routing). */
  readonly authenticated?: boolean | undefined;
  /**
   * What the receiving mail server found, as a gateway this inbox trusts says (`X-Inbox-Email-Auth`):
   * read only from a request the inbound secret let in, or the host's own gateway.
   */
  readonly auth?: MailAuth | undefined;
  /**
   * The receiving server's own authserv-ids, when it is known to put its Authentication-Results on
   * top of every message (an Email Worker set up to say so: `EMAIL_AUTHSERV_ID`). Its verdict is then
   * read from the message itself (`authFromResults`). Absent, nothing in the message is read as one.
   */
  readonly authResultsFrom?: readonly string[] | undefined;
}

/** What the email door is told by the inbox it runs for. */
export interface IngestOptions {
  readonly now?: (() => number) | undefined;
  /** All the attachments this inbox keeps, when its host keeps less than the default. */
  readonly attachmentsMaxBytes?: number | undefined;
}

/** SPF, DKIM and DMARC as the receiving server found them. */
export interface MailAuth {
  readonly spf?: string | undefined;
  /** The domains whose DKIM signatures passed. */
  readonly dkim?: readonly string[] | undefined;
  readonly dmarc?: string | undefined;
}

/**
 * `X-Inbox-Email-Auth` as a gateway writes it: `spf=pass; dkim=pass:gmail.com,example.org;
 * dmarc=pass`. Undefined when it says nothing usable.
 */
export function parseMailAuth(header: string | null | undefined): MailAuth | undefined {
  if (!header) return undefined;
  const out: { spf?: string; dkim?: string[]; dmarc?: string } = {};
  for (const part of header.split(";")) {
    const [k, v] = part.split("=").map((x) => x.trim().toLowerCase());
    if (!k || !v) continue;
    if (k === "spf" && /^[a-z]{2,10}$/.test(v)) out.spf = v;
    if (k === "dmarc" && /^[a-z]{2,10}$/.test(v)) out.dmarc = v;
    if (k === "dkim") {
      const [verdict, domains] = v.split(":");
      out.dkim =
        verdict === "pass"
          ? (domains ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter((d) => /^[a-z0-9.-]{1,253}$/.test(d))
              .slice(0, 8)
          : [];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * What the receiving server found, read from its own Authentication-Results (RFC 8601), from the
 * message's headers in the order they came (topmost first): only the topmost Authentication-Results
 * field, which the receiving server adds last, and only when its authserv-id is `trusted`. A sender
 * can write such a field into its own message, so none is read when the topmost is not trusted, or
 * when another field below it claims a trusted id (one of them is the sender's), and ARC's own
 * results are never read (nothing here checks an ARC chain).
 */
export function authFromResults(headers: Iterable<[string, string]>, trusted: readonly string[]): MailAuth | undefined {
  const ids = trusted.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0) return undefined;
  const fields: string[] = [];
  for (const [name, raw] of headers) if (name.toLowerCase() === "authentication-results") fields.push(raw);
  const authserv = (raw: string) =>
    raw
      .replace(/\([^)]*\)/g, " ")
      .split(";")[0]
      ?.trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  const [top, ...below] = fields;
  if (top === undefined || !ids.includes(authserv(top))) return undefined;
  if (below.some((f) => ids.includes(authserv(f)))) return undefined;
  const parts = top
    .replace(/\([^)]*\)/g, " ")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  parts.shift();
  const out: { spf?: string; dkim?: string[]; dmarc?: string } = {};
  for (const p of parts) {
    const method = p.split("=")[0]?.trim().toLowerCase();
    const rest = p.slice(p.indexOf("=") + 1);
    const verdict = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (method === "spf" && /^[a-z]+$/.test(verdict)) out.spf ??= verdict;
    if (method === "dmarc" && /^[a-z]+$/.test(verdict)) out.dmarc ??= verdict;
    if (method === "dkim") {
      out.dkim ??= [];
      const d = /header\.d=([a-z0-9.-]+)/i.exec(rest)?.[1]?.toLowerCase();
      if (verdict === "pass" && d && !out.dkim.includes(d)) out.dkim.push(d);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export type IngestResult =
  | { readonly outcome: "created"; readonly itemId: string; readonly accessToken?: string | undefined }
  | { readonly outcome: "replied"; readonly itemId: string }
  /** The owner answered an alert by email: their words went to the customer as the business's reply. */
  | { readonly outcome: "owner_replied"; readonly itemId: string }
  /**
   * An answer to the owner's alert that was not sent to the customer (it came from another address,
   * its mail server did not show it was the owner's, or it still quoted the owner's own address): kept
   * on the item as a note for the owner, who is asked to answer in the inbox.
   */
  | { readonly outcome: "held"; readonly itemId: string; readonly reason: string }
  /** A new email put aside as spam as it arrived: kept, nobody told, nothing answered. */
  | { readonly outcome: "spam"; readonly itemId: string; readonly reason: string }
  /** About forwarding the business's own address here: a check that came back, or a provider's confirmation. */
  | { readonly outcome: "forwarding"; readonly forwardId: string; readonly what: "check" | "confirmation" }
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

/** An email that has passed through this many servers is going round in circles: it is dropped. */
export const MAX_HOPS = 40;

export async function parseEmail(raw: InboundEmail["raw"]): Promise<Email> {
  return PostalMime.parse(raw, { attachmentEncoding: "base64" });
}

export async function ingestEmail(
  db: Db,
  caps: Capabilities,
  mail: InboundEmail,
  opts: IngestOptions = {},
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
  const settings = await readSettings(db);
  const recipients = recipientsOf(parsed, mail.envelopeTo);
  const subject = (parsed.subject ?? "").trim();
  // What the receiving server found: from the message itself only where that server is known to put
  // its own results on top (`authResultsFrom`), else as a gateway the inbound secret let in said.
  const auth = mail.authResultsFrom?.length
    ? authFromResults(
        (parsed.headers ?? []).map((h) => [h.key, h.value] as [string, string]),
        mail.authResultsFrom,
      )
    : mail.auth;

  // 1. A forwarding check coming back through the business's forward (ADR-026 §2).
  const check = await checkOf(db, parsed, recipients);
  if (check) {
    await checkArrived(db, { token: check.token, forwardId: check.forwardId, recipients, now: now() });
    console.info("email: a forwarding check came back");
    return { outcome: "forwarding", forwardId: check.forwardId, what: "check" };
  }
  // 2. Our own email back again, or one passed around until it loops: never kept, never answered.
  if (header(parsed, LOOP_HEADER) === (await loopMark(db, now()))) {
    console.info("email: dropped an email this inbox sent, which came back to it");
    return { outcome: "dropped", reason: "this inbox's own email came back" };
  }
  if ((parsed.headers ?? []).filter((h) => h.key === "received").length > MAX_HOPS) {
    console.info("email: dropped an email that went through too many servers");
    return { outcome: "dropped", reason: "too many hops: a mail loop" };
  }
  // 3. The same email again.
  const messageId = parsed.messageId?.trim() || null;
  if (messageId) {
    const [dup] = await db.orm
      .select({ itemId: schema.threadEntries.itemId })
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.messageId, messageId));
    if (dup) return { outcome: "duplicate", itemId: dup.itemId };
  }
  const plain = parsed.text ?? htmlToText(parsed.html ?? "");
  // 4. A provider asking to confirm forwarding to this inbox: shown to the owner, never acted on.
  // Only a known provider's own sender, proven so when the receiving server said; anything else
  // that looks like one is an ordinary email, and never puts a link in front of the owner.
  const inbound = inboundOf(settings);
  const confirmation = recogniseConfirmation({ from, subject, text: plain }, inbound ? [inbound] : [], auth);
  if (confirmation) {
    const kept = await keepConfirmation(db, confirmation, now());
    if (kept === "held") {
      console.info("email: a mail provider's forwarding confirmation is held for the address it names");
      return { outcome: "dropped", reason: "a forwarding confirmation held until its address is added" };
    }
    if (kept) {
      console.info("email: a mail provider asks the owner to confirm forwarding");
      return { outcome: "forwarding", forwardId: kept.id, what: "confirmation" };
    }
    return { outcome: "dropped", reason: "a forwarding confirmation for no address being set up" };
  }
  // Mail to an address the business forwards here: its forward works.
  await forwardsSeen(db, recipients, now());

  const text = cut(stripQuotedReply(plain).trim() || "(empty message)");
  // 5. and 7. The conversation's own address, or the alert's.
  let tokenItem: string | null = null;
  for (const token of tokensIn(recipients)) {
    const row = await findMailToken(db, token);
    if (!row?.itemId) continue;
    if (row.kind === "owner") {
      return ownerAnswer(db, caps, { parsed, mail, auth, from, itemId: row.itemId, token, now, opts });
    }
    if (row.kind === "thread") {
      await touchMailToken(db, token, now());
      tokenItem = row.itemId;
      break;
    }
  }

  // An item whose customer was erased is answered by nothing: a reply to it starts afresh (a new
  // item the business can answer), and nothing is written back onto what was erased.
  const found = tokenItem
    ? { id: tokenItem, via: "token" as const }
    : await findThreadItem(db, parsed, mail.envelopeTo);
  let itemId = found && !(await erasedItem(db, found.id)) ? found.id : null;
  // The older ways in — the item's id in a plus address or a subject — are only as secret as the id,
  // which an agent or a customer may have seen: they join a thread only from the customer's own address.
  if (itemId && found && (found.via === "plus" || found.via === "subject") && !(await sameCustomer(db, itemId, from))) {
    itemId = null;
  }
  // A mailing or a notice no person sends to be answered — a newsletter, a shop's or a bank's notice
  // — that answers no conversation: forwarding a whole mailbox here brings these, and none of them is
  // a customer. Never a message, never an alert, never an answer.
  if (!itemId && isBulkMail(parsed, from)) {
    console.info("email: dropped a mailing or a notice that answers no conversation");
    return { outcome: "dropped", reason: "a mailing or a notice, not a customer" };
  }
  // 6. A mailbox answering by itself — an out-of-office, a returned email — never becomes a
  // conversation and never gets an answer, or two mailboxes could write to each other for ever. It
  // is kept as a note on the item it answers, for the business to read; answering none, it goes. A
  // returned email also marks the email it returns as not delivered, for a person to see.
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
    const returned = returnedReason(parsed);
    if (returned) await mailReturned(db, row.id, returned, at);
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
      await attach(db, row.id, parsed, messageId, now(), "in", { sender: from, maxBytes: opts.attachmentsMaxBytes });
      return { outcome: "replied", itemId: row.id };
    }
  }

  // A new message from someone the business has not dealt with is screened as it arrives (ADR-041
  // §4.3): what a server it passed through said of it, what the receiving server found of its sender,
  // its display name, where answers would go, its links. Put aside, it is made in the spam state, so
  // it tells nobody, moves no rule and keeps none of its files; the owner finds it under Spam. A
  // sender the business knows is only ever labelled, even one a server marked.
  const spam = spamVerdict(parsed);
  const files = (parsed.attachments ?? []).filter((a) => !a.related);
  const created = await caps.sendMessage(
    caller,
    {
      body: text,
      ...(subject ? { subject } : {}),
      contact: { email: from, ...(parsed.from?.name ? { name: parsed.from.name } : {}) },
      ...(messageId ? { idempotency_key: messageId } : {}),
    },
    {
      screen: {
        door: "email",
        email: {
          serverMarked: spam !== null,
          ...(auth ? { auth } : {}),
          ...(parsed.from?.name ? { displayName: parsed.from.name } : {}),
          ...(parsed.replyTo?.[0]?.address && parsed.replyTo[0].address.toLowerCase() !== from
            ? { replyTo: parsed.replyTo[0].address.toLowerCase() }
            : {}),
          ...(parsed.html ? { html: parsed.html.slice(0, 200_000) } : {}),
          attachments: { count: files.length, types: files.slice(0, 10).map((a) => a.mimeType || "file") },
        },
      },
    },
  );
  const view = (created as { view: { item: { id: string } }; accessToken?: string }).view;
  if (messageId)
    await db.client
      .query({
        sql: "UPDATE thread_entries SET message_id = ?, raw_blob_key = ? WHERE item_id = ? AND message_id IS NULL",
        params: [messageId, mail.rawBlobKey ?? null, view.item.id],
        method: "run",
      })
      .catch(() => undefined);
  const { rows: put } = await db.client.query({
    sql: "SELECT state FROM items WHERE id = ?",
    params: [view.item.id],
    method: "all",
  });
  if (put[0]?.[0] === "spam") {
    console.info("email: put a new email aside as spam as it arrived");
    return { outcome: "spam", itemId: view.item.id, reason: spam ?? "Put aside by the spam filter." };
  }
  await attach(db, view.item.id, parsed, messageId, now(), "in", { sender: from, maxBytes: opts.attachmentsMaxBytes });
  return { outcome: "created", itemId: view.item.id, accessToken: (created as { accessToken?: string }).accessToken };
}

/** Every address an email was for, as its envelope and its headers name them: where tokens are found. */
function recipientsOf(parsed: Email, envelopeTo: string | undefined): string[] {
  const list = (as: Email["to"]) =>
    (as ?? []).flatMap((a) => (a.address ? [a.address] : (a.group ?? []).map((g) => g.address)));
  return [
    envelopeTo,
    ...list(parsed.to),
    ...list(parsed.cc),
    parsed.deliveredTo,
    header(parsed, "x-original-to"),
    header(parsed, "x-forwarded-to"),
    // Gmail's own: "X-Forwarded-For: support@shop.example inbox@…", the address it forwards and where to.
    ...(header(parsed, "x-forwarded-for")?.split(/[\s,]+/) ?? []),
  ].filter((r): r is string => typeof r === "string" && r.includes("@"));
}

/** The first value of a header, trimmed, or undefined. */
function header(parsed: Email, name: string): string | undefined {
  const key = name.toLowerCase();
  return parsed.headers?.find((h) => h.key === key)?.value.trim();
}

/** A forwarding check of this inbox's coming back: its token, in its header, its address or its subject. */
async function checkOf(
  db: Db,
  parsed: Email,
  recipients: readonly string[],
): Promise<{ token: string; forwardId: string } | null> {
  const candidates = [
    header(parsed, CHECK_HEADER)?.toLowerCase(),
    ...tokensIn(recipients),
    /\b(c[a-z2-7]{16})\b/.exec(parsed.subject ?? "")?.[1],
  ].filter((t): t is string => typeof t === "string" && /^c[a-z2-7]{16}$/.test(t));
  for (const token of [...new Set(candidates)]) {
    const row = await findMailToken(db, token);
    if (row?.kind === "check" && row.forwardId) return { token, forwardId: row.forwardId };
  }
  return null;
}

/**
 * The owner answered an alert by email (ADR-026 §5). Their words become the business's reply to the
 * customer only when all of this holds: the address is the alert's own (`name+o…@`, a secret only the
 * alert carried), the email is from an address the business's people sign in with or are alerted at,
 * no receiving server found it forged (when one said), a person wrote it (an out-of-office never
 * answers a customer), and what is left once the quoted alert is cut names none of the owner's own
 * addresses (ADR-026 §6). An out-of-office is dropped. Any other answer that fails is kept on the item
 * as a note for the owner (`held`), who is told why and asked to answer in the inbox: nothing is sent
 * to the customer, and nothing is sent back by email (two mailboxes could answer each other for ever).
 */
async function ownerAnswer(
  db: Db,
  caps: Capabilities,
  o: {
    parsed: Email;
    mail: InboundEmail;
    auth: MailAuth | undefined;
    from: string;
    itemId: string;
    token: string;
    now: () => number;
    opts: IngestOptions;
  },
): Promise<IngestResult> {
  if (isAutomaticMail(o.parsed, o.mail.envelopeFrom)) {
    return { outcome: "dropped", reason: "an automatic reply to an alert" };
  }
  if (await erasedItem(db, o.itemId)) return { outcome: "dropped", reason: "the customer was erased" };
  const settings = await readSettings(db);
  const owners = await ownerAddresses(db, settings);
  const sender = baseAddress(o.from);
  const plain = o.parsed.text ?? htmlToText(o.parsed.html ?? "");
  const words = cut(stripOwnerQuote(plain, await ownAddresses(db, caps, settings, o)).trim());
  const firstName = await customerFirstName(db, o.itemId);
  if (!sender || !owners.has(sender)) {
    console.info("email: held an answer to an alert that was not from the owner's address");
    return hold(db, caps, o, {
      reason: "an answer to an alert from an address that is not the business's",
      note: `Your email answer from ${o.from} was not sent to ${firstName}: it did not come from your sign-in or alert address. Send it from here, or add that address in Settings.`,
      words,
    });
  }
  if (!provenFrom(o.from, o.auth)) {
    console.info("email: held an answer to an alert its receiving server did not find to be from the owner");
    return hold(db, caps, o, {
      reason: "an answer to an alert that its sender's domain did not sign",
      note: `Your email answer from ${o.from} was not sent to ${firstName}: its mail server did not show it came from ${splitAddress(o.from)?.domain ?? "your address"}. Send it from here instead.`,
      words,
    });
  }
  // Whatever quoting the owner's mail program did that was not cut, a customer never sees the
  // addresses the business's people sign in with or are alerted at: an answer whose own words name one
  // (cut away to nothing above) is held, never sent.
  const leaks = [...(await signInAddresses(db)), ...owners];
  const written = cut(stripQuotedReply(plain).trim());
  if ((!words && written) || leaks.some((a) => words.toLowerCase().includes(a))) {
    console.info("email: held an answer to an alert that still quoted the owner's own address");
    return hold(db, caps, o, {
      reason: "an answer to an alert that names the owner's own address",
      note: `Your email answer was not sent to ${firstName}: it still had your own email address in it, which customers never see. Send it from here instead.`,
      words: words || written,
    });
  }
  if (!words) return { outcome: "dropped", reason: "an empty answer" };
  const { rows: theirs } = await db.client.query({
    sql: "SELECT id, role FROM users WHERE lower(email) = ? AND role IN ('owner', 'staff') LIMIT 1",
    params: [sender],
    method: "all",
  });
  const user = theirs[0] ?? (await firstOwner(db));
  if (!user) return { outcome: "dropped", reason: "nobody signs in here" };
  const messageId = o.parsed.messageId?.trim() || null;
  const kind = String(user[1]) === "staff" ? ("staff" as const) : ("owner" as const);
  const caller: Caller = {
    actor: { kind, id: String(user[0]), channel: "email" },
    tier: "verified_principal",
    sandbox: false,
    now: o.now,
    ...(messageId ? { idempotency: { scope: `email:owner:${String(user[0])}`, key: messageId } } : {}),
  };
  try {
    await caps.reply(caller, {
      item_id: o.itemId,
      body: words,
      written_by: "person",
      ...(messageId ? { idempotency_key: messageId } : {}),
    } as Parameters<Capabilities["reply"]>[1]);
  } catch (error) {
    // The same email again, after the item moved on: its key names the first answer.
    if (error instanceof WriteError && error.code === "idempotency_mismatch")
      return { outcome: "duplicate", itemId: o.itemId };
    throw error;
  }
  // The owner's Message-ID on the answer, so a second delivery of the same email is known (step 3).
  if (messageId) {
    await db.client.query({
      sql: `UPDATE thread_entries SET message_id = ? WHERE message_id IS NULL AND id = (
              SELECT id FROM thread_entries WHERE item_id = ? AND direction = 'out' ORDER BY created_at DESC, id DESC LIMIT 1)`,
      params: [messageId, o.itemId],
      method: "run",
    });
  }
  // What the owner attached stays on the item for them; it is not sent on (the inbox sends words only).
  const kept = await attach(db, o.itemId, o.parsed, null, o.now(), "out", {
    sender: o.from,
    maxBytes: o.opts.attachmentsMaxBytes,
  });
  if (kept.length) {
    await caps.reply(caller, {
      item_id: o.itemId,
      internal: true,
      body: `The files attached to your email answer are kept here and were not sent to the customer: ${kept
        .map((k) => k.filename)
        .join(", ")}.`,
    } as Parameters<Capabilities["reply"]>[1]);
  }
  return { outcome: "owner_replied", itemId: o.itemId };
}

/** The first owner who signs in: who an answer from the alerts' address is written as. */
async function firstOwner(db: Db): Promise<readonly unknown[] | undefined> {
  const { rows } = await db.client.query({
    sql: "SELECT id, role FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1",
    params: [],
    method: "all",
  });
  return rows[0];
}

/**
 * An answer to an alert that is not sent: its words are kept on the item as a note, with why, and
 * the item asks for a person. Once per email (its Message-ID), so a second delivery adds nothing.
 */
async function hold(
  db: Db,
  caps: Capabilities,
  o: { parsed: Email; itemId: string; now: () => number },
  h: { reason: string; note: string; words: string },
): Promise<IngestResult> {
  const messageId = o.parsed.messageId?.trim() || null;
  const user = await firstOwner(db);
  if (!user) return { outcome: "dropped", reason: h.reason };
  const caller: Caller = {
    actor: { kind: "owner", id: String(user[0]), channel: "email" },
    tier: "verified_principal",
    sandbox: false,
    now: o.now,
    ...(messageId ? { idempotency: { scope: "email:owner:held", key: messageId } } : {}),
  };
  try {
    await caps.reply(caller, {
      item_id: o.itemId,
      internal: true,
      body: cut(h.words ? `${h.note}\n\n${h.words}` : h.note),
      ...(messageId ? { idempotency_key: `held:${messageId}` } : {}),
    } as Parameters<Capabilities["reply"]>[1]);
  } catch (error) {
    if (error instanceof WriteError && error.code === "idempotency_mismatch")
      return { outcome: "duplicate", itemId: o.itemId };
    throw error;
  }
  const system: Caller = {
    actor: { kind: "system", id: "email", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: o.now,
  };
  await setFlags(db, system, {
    itemId: o.itemId,
    flags: { needsHuman: true },
    reason: "An answer by email was not sent",
  }).catch(() => undefined);
  return { outcome: "held", itemId: o.itemId, reason: h.reason };
}

/** How a held answer names the customer: their first name, else "the customer". */
async function customerFirstName(db: Db, itemId: string): Promise<string> {
  const { rows } = await db.client.query({
    sql: "SELECT p.display_name FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ?",
    params: [itemId],
    method: "all",
  });
  const name =
    String(rows[0]?.[0] ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return name.length >= 2 && !name.includes("@") ? name : "the customer";
}

/**
 * The addresses an owner's answer quotes when it quotes the alert: who the alert was from, the alert's
 * own address, the inbox's addresses, and every address the business's people sign in with or are
 * alerted at. A line naming one is where the quoted alert starts.
 */
async function ownAddresses(
  db: Db,
  caps: Capabilities,
  settings: Awaited<ReturnType<typeof readSettings>>,
  o: { token: string; mail: InboundEmail },
): Promise<string[]> {
  const inbound = inboundOf(settings);
  const out = new Set<string>([...(await ownerAddresses(db, settings)), ...(await signInAddresses(db))]);
  if (inbound) {
    out.add(inbound.toLowerCase());
    const alert = plusAddress(inbound, o.token);
    if (alert) out.add(alert);
  }
  for (const a of [settings.email.fromAddress, settings.email.replyTo, o.mail.envelopeTo]) {
    if (a) out.add(a.trim().toLowerCase());
  }
  // Who the alert was from: the address this inbox sends from.
  for (const a of await caps.email.sendingAddresses()) out.add(a.toLowerCase());
  return [...out].filter((a) => a.includes("@"));
}

/** A line that heads a quoted email, in the languages mail programs write it in (`De :` in French Outlook). */
const QUOTE_HEADER =
  /^\s*\**\s*(From|De|Da|Van|Von|Od|Från|Fra|Frá|Fyrir|Від|От|Kimden|Lähettäjä|Feladó|Od|发件人|差出人|보낸 사람)\s?[:：]/i;
/** An attribution line ("On … wrote:") in the languages mail programs write it in. */
const ATTRIBUTION =
  /^(On .{3,200} wrote:|Em .{3,200} escreveu:|Le .{3,200} a écrit ?:|Am .{3,200} schrieb .*:|El .{3,200} escribió:|Il .{3,200} ha scritto:|Op .{3,200} schreef .*:|W dniu .{3,200} pisze:|Den .{3,200} skrev .*:|.{3,200} <[^>]+@[^>]+> (wrote|escreveu|a écrit|schrieb|escribió|ha scritto|schreef|napisał|skrev):)$/i;

/**
 * An owner's answer without the alert it quotes. Cut at the first line that names any of `own` (the
 * quoted header block, an attribution line), a line of underscores (Outlook's separator), a quoted
 * header in any language, an attribution line (also when a mail program wrapped it over two lines),
 * a `>` line and a signature; what comes before is the answer.
 */
export function stripOwnerQuote(text: string, own: readonly string[]): string {
  const addresses = own.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    const lower = t.toLowerCase();
    const next = (lines[i + 1] ?? "").trim();
    const joined = `${t} ${next}`.trim();
    if (
      /^_{10,}$/.test(t) ||
      /^-{2,}\s*(Original Message|Mensagem original|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Oorspronkelijk bericht|Wiadomość oryginalna|Ursprungligt meddelande)\s*-{2,}$/i.test(
        t,
      ) ||
      QUOTE_HEADER.test(t) ||
      ATTRIBUTION.test(t) ||
      (/^(On|Em|Le|Am|El|Il|Op|W dniu|Den)\s/.test(t) && !/:$/.test(t) && ATTRIBUTION.test(joined)) ||
      addresses.some((a) => lower.includes(a))
    ) {
      break;
    }
    if (/^\s*>/.test(line)) continue;
    if (t === "--") break;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether the receiving server found the email to be from its From's domain: DMARC passed, or a
 * DKIM signature of that domain (or the domain it belongs to) passed. Without a word from the
 * receiving server, the alert's secret address and the owner's own address are the proof.
 */
function provenFrom(from: string, auth: MailAuth | undefined): boolean {
  if (!auth) return true;
  if (auth.dmarc === "fail") return false;
  if (auth.dmarc === "pass") return true;
  const domain = splitAddress(from)?.domain ?? "";
  if (auth.dkim?.some((d) => d === domain || domain.endsWith(`.${d}`))) return true;
  return auth.dkim === undefined && auth.dmarc === undefined;
}

/**
 * Why an email is spam: a server it passed through marked it so (`X-Spam-Flag`, `X-Spam-Status`,
 * Microsoft's spam level). Null when nothing says. A failed DMARC check is not enough: the business's
 * own forward breaks SPF for many honest senders, and the receiving server already refuses mail whose
 * sender asks for that. The words themselves are never judged: a customer's odd message is theirs.
 */
export function spamVerdict(parsed: Pick<Email, "headers">): string | null {
  for (const h of parsed.headers ?? []) {
    const v = h.value.trim().toLowerCase();
    if (h.key === "x-spam-flag" && /^yes\b/.test(v)) return "A server it passed through marked it as spam.";
    if (h.key === "x-spam-status" && /^yes\b/.test(v)) return "A server it passed through marked it as spam.";
    if (h.key === "x-spam" && /^(yes|true|spam)\b/.test(v)) return "A server it passed through marked it as spam.";
    if (h.key === "x-ms-exchange-organization-scl" && Number(v) >= 5) {
      return "A server it passed through marked it as spam.";
    }
  }
  return null;
}

/**
 * A mailing or a notice nobody sends to be answered: a list's headers (`List-Unsubscribe`, `List-Id`,
 * `List-Post`), or a sender that says it takes no answer (`noreply@`, `do-not-reply@`,
 * `notifications@`, `mailer@`, `bounces@`).
 */
export function isBulkMail(parsed: Pick<Email, "headers">, from: string): boolean {
  // A mail provider's own email about forwarding (Yahoo's link, say) reaches the owner as it came.
  if (confirmationSender(from)) return false;
  for (const h of parsed.headers ?? []) {
    if (h.key === "list-unsubscribe" || h.key === "list-id" || h.key === "list-post") return true;
  }
  const local = (from.split("@")[0] ?? "").toLowerCase().split("+")[0] ?? "";
  return (
    /(^|[-_.])(no-?reply|do-?not-?reply|donotreply)([-_.]|$)/.test(local) ||
    /^(notifications?|mailer|bounces?)$/.test(local)
  );
}

/**
 * Why a returned email says it was not delivered: its delivery status (RFC 3464) `Status: 5.x.x`, or
 * a mailer daemon's words. Null for an out-of-office, which returns nothing.
 */
export function returnedReason(parsed: Pick<Email, "headers" | "from" | "attachments" | "text">): string | null {
  const report = (parsed.headers ?? []).some(
    (h) => h.key === "content-type" && h.value.trim().toLowerCase().startsWith("multipart/report"),
  );
  const daemon = /^(mailer-daemon|postmaster)@/i.test(parsed.from?.address ?? "");
  const failed = (parsed.headers ?? []).find((h) => h.key === "x-failed-recipients");
  if (!report && !daemon && !failed) return null;
  const parts = [
    parsed.text ?? "",
    ...(parsed.attachments ?? [])
      .filter((a) => /^(message\/delivery-status|text\/plain)/i.test(a.mimeType))
      .map((a) => (typeof a.content === "string" ? decodeMaybe(a.content) : new TextDecoder().decode(a.content))),
  ].join("\n");
  const status = /^\s*Status:\s*(5\.\d{1,3}\.\d{1,3})/im.exec(parts)?.[1];
  const diagnostic = /^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.{1,160})$/im.exec(parts)?.[1]?.trim();
  if (status) return `Returned by the customer's mail server (${status}${diagnostic ? `: ${diagnostic}` : ""}).`;
  if (failed || daemon) return "Returned by the customer's mail server as not delivered.";
  return null;
}

function decodeMaybe(base64: string): string {
  try {
    const bin = atob(base64.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return base64;
  }
}

/** Keeps an email's attachments on its newest thread entry of `direction` on the item. */
async function attach(
  db: Db,
  itemId: string,
  parsed: Email,
  messageId: string | null,
  now: number,
  direction: "in" | "out",
  who: { sender: string; maxBytes?: number | undefined },
): Promise<{ filename: string }[]> {
  const files = (parsed.attachments ?? []).filter((a) => !a.related && !/^message\//i.test(a.mimeType));
  if (files.length === 0) return [];
  const { rows } = await db.client.query({
    sql: messageId
      ? "SELECT id FROM thread_entries WHERE item_id = ? AND message_id = ? LIMIT 1"
      : "SELECT id FROM thread_entries WHERE item_id = ? AND direction = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    params: messageId ? [itemId, messageId] : [itemId, direction],
    method: "all",
  });
  const entryId = rows[0]?.[0] ? String(rows[0][0]) : null;
  return keepAttachments(db, {
    itemId,
    entryId,
    now,
    sender: baseAddress(who.sender),
    ...(who.maxBytes !== undefined ? { inboxMaxBytes: who.maxBytes } : {}),
    attachments: files.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      content: a.content,
      related: a.related,
    })),
  });
}

/**
 * Which item this email belongs to, and how it was found: the ids it names in In-Reply-To and
 * References first — ours (every email we send carries the item's anchor, `mail_refs`) or the
 * customer's own earlier ones — then a plus address with the item's id, then a subject token. At most
 * twenty ids are looked at, In-Reply-To and the first and last of References, since a long thread's
 * middle adds nothing a reply needs.
 */
async function findThreadItem(
  db: Db,
  parsed: Email,
  envelopeTo: string | undefined,
): Promise<{ id: string; via: "refs" | "plus" | "subject" } | null> {
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
        if (hit) return { id: hit, via: "refs" };
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
      if (hit) return { id: hit, via: "refs" };
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
      if (hit) return { id: hit.id, via: "plus" };
    }
  }
  const token = SUBJECT_TOKEN.exec(parsed.subject ?? "")?.[1];
  if (token) {
    const [hit] = await db.orm
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.id, token.toUpperCase()));
    if (hit) return { id: hit.id, via: "subject" };
  }
  return null;
}

/** Whether `from` is the address the item's customer gave (or one of theirs on record). */
async function sameCustomer(db: Db, itemId: string, from: string): Promise<boolean> {
  const sender = baseAddress(from);
  const { rows } = await db.client.query({
    sql: `SELECT json_extract(p.contact, '$.email'), (SELECT group_concat(c.value, ' ') FROM party_contacts c
                  WHERE c.party_id = p.id AND c.kind = 'email')
            FROM items i JOIN parties p ON p.id = i.party_id WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return false;
  const known = [String(r[0] ?? ""), ...String(r[1] ?? "").split(" ")]
    .map((a) => baseAddress(a))
    .filter((a): a is string => a !== null);
  return sender !== null && known.includes(sender);
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
      /^(On .{3,120} wrote:|Em .{3,120} escreveu:|Le .{3,120} a écrit ?:|Am .{3,120} schrieb .*:|El .{3,120} escribió:|-----Original Message-----|From: .+|De: .+|Von: .+)$/i.test(
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
