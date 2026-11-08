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
  LINKS_HEADING,
  LOOP_HEADER,
  lookupForms,
  loopMark,
  mailReturned,
  ownerAddresses,
  plusAddress,
  queueNoticesDay,
  readSettings,
  recogniseConfirmation,
  registrableDomain,
  SHARED_MAIL_PROVIDERS,
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
 *    has been passed around too often, is kept as a notice and never answered;
 * 3. a second delivery of an email already kept (its Message-ID) is a duplicate, whatever it is;
 * 4. a mail provider asking to confirm forwarding is kept on the forward for the owner to see;
 * 5. an answer to an owner's alert (`name+o…@`) from the owner's own address becomes the business's
 *    reply to the customer; from anyone else, a note for the owner, sent to nobody;
 * 6. an automatic email (an out-of-office, a returned email) is a note on the item it answers;
 * 7. anything else lands on the item it answers — its conversation's address (`name+t…@`), the ids it
 *    names, then the older plus address or subject token — or becomes a new message, put aside as
 *    spam when what it carries says so. What it had attached is kept within limits. A code, a sign-in
 *    link or a password reset from a sender that takes no answer, on the domain it names, is the
 *    owner's alone, with its links.
 *
 * Nothing that arrives is ever dropped (the founder, 1 November 2026: "don't throw any e-mail away, we
 * keep everything"). What answers no conversation and no person sent to be answered — a mailing, a
 * receipt, an account's notice, an automatic email, the inbox's own email come back, a forwarding
 * confirmation for no address being set up, one with no sender — is kept as a notice (`flags.notice`):
 * the owner's alone, as an account's mail is, alerting nobody and answered by nothing. Only an email the
 * gateway refuses as larger than the whole system takes (25 MiB, `apps/email-gateway/worker.ts`) is
 * not kept, and its sender is told by a bounce.
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
  /**
   * An email from a system that answers no conversation, kept as a notice (`flags.notice`): the owner
   * reads it under Notices; nobody is alerted and nothing answers it.
   */
  | { readonly outcome: "notice"; readonly itemId: string; readonly reason: string }
  /**
   * Too many from this sender, or for the whole mailbox, right now: nothing kept yet. A temporary
   * failure, so the sending server tries again later (`retryAfterSec`), never a bounce.
   */
  | { readonly outcome: "limited"; readonly reason: string; readonly retryAfterSec: number };

export const SUBJECT_TOKEN = /\[SDI-([0-9A-HJKMNP-TV-Z]{6,26})\]/i;

/** An email that has passed through this many servers is going round in circles: a notice, never answered. */
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
    // Without an envelope sender (a forward, some webhooks), the From is who is counted. With neither,
    // the whole mailbox's bucket alone counts it.
    parsed = await parseEmail(mail.raw);
    const sender = parsed.from?.address?.toLowerCase();
    if (sender) {
      const one = await consume(db, "emailSender", await senderBucket(sender), now());
      if (!one.allowed) return limitedMail(one.retryAfterSec);
    }
  }
  const everyone = await consume(db, "email", EVERYONE, now());
  if (!everyone.allowed) return limitedMail(everyone.retryAfterSec);
  parsed ??= await parseEmail(mail.raw);
  // Who sent it: its From, else its envelope's sender.
  const from = parsed.from?.address?.trim().toLowerCase() || envelope;
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
  const notice = (reason: string, more: { heading?: string; flood?: boolean } = {}) =>
    keepNotice(db, caps, { parsed: parsed as Email, mail, from, auth, reason, now, opts, ...more });
  // 3. The same email again, looked for first: a second delivery of anything already kept, a notice
  // included, adds nothing.
  const messageId = parsed.messageId?.trim() || null;
  if (messageId) {
    const [dup] = await db.orm
      .select({ itemId: schema.threadEntries.itemId })
      .from(schema.threadEntries)
      .where(eq(schema.threadEntries.messageId, messageId));
    if (dup) return { outcome: "duplicate", itemId: dup.itemId };
  }
  // An email that names nobody who sent it is kept all the same: nobody can be answered.
  if (!from) return notice("an email with no sender");

  // 1. A forwarding check coming back through the business's forward (ADR-026 §2).
  const check = await checkOf(db, parsed, recipients);
  if (check) {
    await checkArrived(db, { token: check.token, forwardId: check.forwardId, recipients, now: now() });
    console.info("email: a forwarding check came back");
    return { outcome: "forwarding", forwardId: check.forwardId, what: "check" };
  }
  // 2. Our own email back again, or one passed around until it loops: kept as a notice, never answered.
  if (header(parsed, LOOP_HEADER) === (await loopMark(db, now()))) {
    console.info("email: kept an email this inbox sent, which came back to it, as a notice");
    return notice("this inbox's own email came back", { heading: OWN_NOTE });
  }
  if ((parsed.headers ?? []).filter((h) => h.key === "received").length > MAX_HOPS) {
    console.info("email: kept an email that went through too many servers as a notice");
    return notice("too many hops: a mail loop", { heading: LOOP_NOTE });
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
      return notice("a forwarding confirmation held until its address is added");
    }
    if (kept) {
      console.info("email: a mail provider asks the owner to confirm forwarding");
      return { outcome: "forwarding", forwardId: kept.id, what: "confirmation" };
    }
    return notice("a forwarding confirmation for no address being set up");
  }
  // Mail to an address the business forwards here: its forward works.
  await forwardsSeen(db, recipients, now());

  const words = stripQuotedReply(plain).trim() || "(empty message)";
  const text = cut(words);
  // What the account notices are read by: the text part, or the HTML's words when there is none.
  const read = { headers: parsed.headers, subject: parsed.subject, text: plain };
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

  // A mailing or a notice no person sends to be answered — a newsletter, a shop's or a bank's notice
  // — by its shape alone, or an automatic email. A website form's email, sent from a no-reply address
  // with its answers going to the person who filled it in, is a person's message, as any other.
  const bulk = isBulkMail(read, from) && !answeredElsewhere(parsed, from);
  const automatic = isAutomaticMail(parsed, mail.envelopeFrom);
  // A code, a sign-in link or a password reset from a sender that takes no answer, on the domain it
  // names, is the owner's alone (`flags.account`): kept with the links it carries, since a button's
  // link is often in the HTML part only; no rule answers it, no webhook carries it, no AI reads it, and
  // its owner is alerted. The same words from a sender nothing vouched for are a notice.
  const account = isAccountNotice(read, from, auth);
  // Past a day's worth of notices from one domain the receiving server vouched for (one sender's, for
  // an automatic email or a domain many people share), one is still kept, with the least work: found by
  // its conversation's address and the ids it names only, and given only the spam filter's certain
  // checks. Mail nothing vouched for spends no domain's day, a real sender's included, and is always
  // screened in full.
  const flood =
    !tokenItem &&
    !account &&
    (bulk || automatic) &&
    vouchedFrom(from, auth) &&
    !(await consume(db, "notices", await noticeBucket(from, { byDomain: bulk }), now())).allowed;
  if (flood) {
    console.info("email: a notice past its domain's day of notices, kept with the least work");
    // The owner hears of the day's flood once, the day it starts: nothing else alerts for a notice.
    await queueNoticesDay(db, now());
  }

  // An item whose customer was erased is answered by nothing: a reply to it starts afresh (a new
  // item the business can answer), and nothing is written back onto what was erased.
  const found = tokenItem
    ? { id: tokenItem, via: "token" as const }
    : await findThreadItem(db, parsed, mail.envelopeTo, { idsOnly: flood });
  let itemId = found && !(await erasedItem(db, found.id)) ? found.id : null;
  // The older ways in — the item's id in a plus address or a subject — are only as secret as the id,
  // which an agent or a customer may have seen: they join a thread only from the customer's own address.
  if (itemId && found && (found.via === "plus" || found.via === "subject") && !(await sameCustomer(db, itemId, from))) {
    itemId = null;
  }
  // That answers no conversation: forwarding a whole mailbox here brings these, and none of them is a
  // customer. Kept as a notice, the owner's alone: never an alert, never an answer.
  if (!itemId && bulk && !account) {
    console.info("email: kept a mailing or a notice that answers no conversation as a notice");
    return notice("a mailing or a notice that answers no conversation", { flood });
  }
  // 6. A mailbox answering by itself — an out-of-office, a returned email — never becomes a
  // conversation and never gets an answer, or two mailboxes could write to each other for ever. It
  // is kept as a note on the item it answers, for the business to read; answering none, as a notice
  // (an account's code sent the same way is the account's, below). A returned email also marks the
  // email it returns as not delivered, for a person to see.
  if (automatic && (itemId || !account)) {
    const [row] = itemId
      ? await db.orm.select({ id: schema.items.id }).from(schema.items).where(eq(schema.items.id, itemId))
      : [];
    if (!row) {
      console.info(
        "email: kept an automatic email (an out-of-office or a returned email) that answers no item as a notice",
      );
      return notice("an automatic email that answers no conversation", { heading: AUTOMATIC_NOTICE, flood });
    }
    const at = now();
    await noteOn(db, row.id, { subject, text: `${AUTOMATIC_NOTE}\n\n${text}`, messageId, at });
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
  // it tells nobody, moves no rule and keeps none of its files (it names them); the owner finds it under Spam. A
  // sender the business knows is only ever labelled, even one a server marked.
  const spam = spamVerdict(parsed);
  const files = (parsed.attachments ?? []).filter((a) => !a.related);
  // Its links are kept for the business's people even where the receiving server said nothing of its
  // sender, never where it found the sender forged: only the owner-alone handling above needs its word.
  const keepLinks = account || (auth?.dmarc !== "fail" && looksLikeAccountNotice(read, from));
  const created = await caps.sendMessage(
    caller,
    {
      body: keepLinks ? withLinks(words, linksOf(parsed)) : text,
      ...(subject ? { subject: subject.slice(0, MAX_SUBJECT) } : {}),
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
          // The words before the links block, so a link is not counted twice.
          ...(keepLinks ? { words: text } : {}),
          ...(account ? { account: true } : {}),
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
    // Its files are named on it, never kept: what was attached is known, and none of it opens.
    await attach(db, view.item.id, parsed, messageId, now(), "in", { sender: from, aside: true });
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
 * addresses (ADR-026 §6). An out-of-office from the business's own address is a note on the item, sent
 * to nobody; from anyone else, a notice. Any other answer that fails is kept on the item as a note for
 * the owner (`held`), who is told why and asked to answer in the inbox: nothing is sent to the customer,
 * and nothing is sent back by email (two mailboxes could answer each other for ever). What a stranger
 * attached is kept with a notice, never on the customer's item. An answer about a customer who was
 * erased is kept as a notice.
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
  // Nothing is written back onto what was erased: kept, as a notice.
  if (await erasedItem(db, o.itemId)) {
    return keepNotice(db, caps, { ...o, reason: "an answer to an alert about a customer who was erased" });
  }
  const settings = await readSettings(db);
  const owners = await ownerAddresses(db, settings);
  const sender = baseAddress(o.from);
  // From the business's own address, as its receiving server found (when one said).
  const fromBusiness = !!sender && owners.has(sender) && provenFrom(o.from, o.auth);
  // An out-of-office from the owner's own mailbox answers no customer: a note on the item, sent to
  // nobody. One from anyone else is never written onto the customer's item: a notice, the owner's alone.
  if (isAutomaticMail(o.parsed, o.mail.envelopeFrom)) {
    if (!fromBusiness) {
      return keepNotice(db, caps, {
        ...o,
        reason: "an automatic email to an alert, not from the business's own address",
        heading: AUTOMATIC_NOTICE,
      });
    }
    const plain = o.parsed.text ?? htmlToText(o.parsed.html ?? "");
    await noteOn(db, o.itemId, {
      subject: o.parsed.subject?.trim() || null,
      text: `${OWNER_AUTOMATIC_NOTE}\n\n${cut(stripQuotedReply(plain).trim() || "(empty message)")}`,
      messageId: o.parsed.messageId?.trim() || null,
      at: o.now(),
    });
    return { outcome: "noted", itemId: o.itemId };
  }
  const plain = o.parsed.text ?? htmlToText(o.parsed.html ?? "");
  const words = cut(stripOwnerQuote(plain, await ownAddresses(db, caps, settings, o)).trim());
  const firstName = await customerFirstName(db, o.itemId);
  if (!sender || !owners.has(sender)) {
    console.info("email: held an answer to an alert that was not from the owner's address");
    return hold(db, caps, o, {
      reason: "an answer to an alert from an address that is not the business's",
      note: `Your email answer from ${o.from} was not sent to ${firstName}: it did not come from your sign-in or alert address. Send it from here, or add that address in Settings.`,
      words,
      theirs: false,
    });
  }
  if (!provenFrom(o.from, o.auth)) {
    console.info("email: held an answer to an alert its receiving server did not find to be from the owner");
    return hold(db, caps, o, {
      reason: "an answer to an alert that its sender's domain did not sign",
      note: `Your email answer from ${o.from} was not sent to ${firstName}: its mail server did not show it came from ${splitAddress(o.from)?.domain ?? "your address"}. Send it from here instead.`,
      words,
      theirs: false,
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
      theirs: true,
    });
  }
  if (!words) {
    console.info("email: held an answer to an alert that had no words");
    return hold(db, caps, o, {
      reason: "an answer to an alert with no words",
      note: `Your email answer had no words, so nothing was sent to ${firstName}. Send it from here instead.`,
      words: "",
      theirs: true,
    });
  }
  const { rows: theirs } = await db.client.query({
    sql: "SELECT id, role FROM users WHERE lower(email) = ? AND role IN ('owner', 'staff') LIMIT 1",
    params: [sender],
    method: "all",
  });
  const user = theirs[0] ?? (await firstOwner(db));
  if (!user) {
    return hold(db, caps, o, {
      reason: "an answer to an alert, and nobody signs in here to send it as",
      note: `Your email answer was not sent to ${firstName}: nobody signs in to this inbox to send it as.`,
      words,
      theirs: true,
    });
  }
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
 * An answer to an alert that is not sent: its words, and what it had attached, are kept on the item as
 * a note, with why, and the item asks for a person. Once per email (its Message-ID), so a second
 * delivery adds nothing.
 */
async function hold(
  db: Db,
  caps: Capabilities,
  o: {
    parsed: Email;
    mail: InboundEmail;
    auth: MailAuth | undefined;
    itemId: string;
    from: string;
    now: () => number;
    opts: IngestOptions;
  },
  h: { reason: string; note: string; words: string; theirs: boolean },
): Promise<IngestResult> {
  const messageId = o.parsed.messageId?.trim() || null;
  // What someone other than the business attached is never put on the customer's item, where keys and
  // the owner's AI read: the email is kept whole as a notice, the owner's alone, its files with it.
  const strangersFiles =
    !h.theirs && (o.parsed.attachments ?? []).some((a) => !a.related && !/^message\//i.test(a.mimeType));
  const kept = strangersFiles ? await keepNotice(db, caps, { ...o, reason: h.reason }) : null;
  if (kept?.outcome === "duplicate") return kept;
  const said = !kept
    ? h.note
    : kept.outcome === "spam"
      ? `${h.note} It was put aside as spam, with what it had attached.`
      : `${h.note} What it had attached is kept under Notices, for you alone.`;
  const body = cut(h.words ? `${said}\n\n${h.words}` : said);
  const user = await firstOwner(db);
  if (!user) {
    // Nobody signs in here to write it as: the note is the inbox's own, kept once by its Message-ID.
    await noteOn(db, o.itemId, { subject: null, text: body, messageId, at: o.now() });
  } else {
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
        body,
        ...(messageId ? { idempotency_key: `held:${messageId}` } : {}),
      } as Parameters<Capabilities["reply"]>[1]);
    } catch (error) {
      if (error instanceof WriteError && error.code === "idempotency_mismatch")
        return { outcome: "duplicate", itemId: o.itemId };
      throw error;
    }
  }
  // What the business's own address attached stays with the note, for the owner; it is not sent on.
  if (h.theirs) {
    await attach(db, o.itemId, o.parsed, null, o.now(), "note", {
      sender: o.from,
      maxBytes: o.opts.attachmentsMaxBytes,
    });
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
 * A mailing or a notice nobody sends to be answered, by its shape alone: a list's headers
 * (`List-Unsubscribe`, `List-Id`, `List-Post`), or a sender that says it takes no answer (`noreply@`,
 * `do-not-reply@`, `notifications@`, `mailer@`, `bounces@`). What it says never makes it anything
 * else: a code from a sender nothing vouched for is a notice like any other (`isAccountNotice`).
 */
export function isBulkMail(parsed: Pick<Email, "headers">, from: string): boolean {
  // A mail provider's own email about forwarding (Yahoo's link, say) reaches the owner as it came.
  if (confirmationSender(from)) return false;
  return takesNoAnswer(parsed, from);
}

/** A list's headers: how a mailing is sent. */
function hasListHeaders(parsed: Pick<Email, "headers">): boolean {
  return (parsed.headers ?? []).some(
    (h) => h.key === "list-unsubscribe" || h.key === "list-id" || h.key === "list-post",
  );
}

/** A sender that says it takes no answer, by its address's own name. */
function noReplyAddress(address: string): boolean {
  const local = (address.split("@")[0] ?? "").toLowerCase().split("+")[0] ?? "";
  return (
    /(^|[-_.])(no-?reply|do-?not-?reply|donotreply)([-_.]|$)/.test(local) ||
    /^(notifications?|mailer|bounces?)$/.test(local)
  );
}

/** A list's headers, or a sender that says it takes no answer: how a mailing or a notice is sent. */
function takesNoAnswer(parsed: Pick<Email, "headers">, from: string): boolean {
  return hasListHeaders(parsed) || noReplyAddress(from);
}

/**
 * A website form's email (Webflow's, Typeform's, Wix's): sent from an address that takes no answer, no
 * list's headers, and its answers going to someone else, who does take one (`Reply-To`) — the person who
 * filled the form in. A person's message, kept and screened as any other is, never a notice.
 */
export function answeredElsewhere(parsed: Pick<Email, "headers" | "replyTo">, from: string): boolean {
  if (hasListHeaders(parsed)) return false;
  const to = baseAddress(parsed.replyTo?.[0]?.address?.trim().toLowerCase() ?? "");
  return to !== null && to !== baseAddress(from) && !noReplyAddress(to);
}

/**
 * A code, a sign-in link or a password reset sent the way only an account's notice is: in the words
 * such a notice uses (`ACCOUNT_NOTICE_SUBJECT`, `ACCOUNT_BODY`), from a sender that takes no answer or
 * with a list's headers, and from the domain it names, as the receiving server found (`vouchedFrom`):
 * an account the business holds, writing to it. Anyone can write those words, add those headers or
 * forge a From, so a look-alike is an ordinary email, screened like any other; so is a person's email
 * with the same words ("I can't sign in"), answered like any other.
 */
export function isAccountNotice(
  parsed: Pick<Email, "headers" | "subject" | "text">,
  from: string,
  auth: MailAuth | undefined,
): boolean {
  return looksLikeAccountNotice(parsed, from) && vouchedFrom(from, auth);
}

/** An account's notice by its words and its sender alone, before anything is known of who sent it. */
export function looksLikeAccountNotice(parsed: Pick<Email, "headers" | "subject" | "text">, from: string): boolean {
  const words =
    ACCOUNT_NOTICE_SUBJECT.test(parsed.subject ?? "") || ACCOUNT_BODY.test((parsed.text ?? "").slice(0, 4000));
  return words && takesNoAnswer(parsed, from);
}

/**
 * Whether the receiving server found the From's own domain behind the email: DMARC passed, or a DKIM
 * signature of that domain, with DMARC not failing. Where it said nothing, nothing was found.
 */
function vouchedFrom(from: string, auth: MailAuth | undefined): boolean {
  if (!auth || auth.dmarc === "fail") return false;
  if (auth.dmarc === "pass") return true;
  const domain = splitAddress(from)?.domain ?? "";
  return domain !== "" && (auth.dkim ?? []).some((d) => d === domain || domain.endsWith(`.${d}`));
}

/** The links kept of one email, and the longest one kept: past that it is no address to open. */
const MAX_LINKS = 10;
const MAX_LINK = 2_000;

/**
 * A link in an email's text, found as the owner app finds one in a message's (`linkParts` in
 * apps/inbox/client/src/lib/links.ts; a test holds the two together), so the list under its words
 * leaves out each link they already show: "http(s)://" and all up to a space, a "<", a ">" or a '"',
 * a U+FEFF kept inside (a browser drops it from a host: `https://login\uFEFF.paypal.com/` is one link).
 */
const LINK_IN_TEXT = /https?:\/\/(?:[^\s<>"]|\uFEFF)+/gi;
/** What is never the end of a link, but the sentence's after it: punctuation and closing quotes. */
const AFTER_LINK = new Set("\uFEFF.,;:!?'\"`»”’…。，、）」』】》〉");
/** A closing bracket, and the one that opens it. */
const OPENER = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);
const BRACKETS = new Set("()[]{}");

/**
 * A link as written, without what follows it in the sentence: a full stop, a closing quote, or a closing
 * bracket the link did not open, while one it did open stays (`…/wiki/Foo_(bar)`). One pass back from its
 * end, so a run of punctuation of any length, in an email of any size, takes no longer than its length.
 */
function trimLink(written: string): string {
  const count = new Map<string, number>();
  for (const c of written) if (BRACKETS.has(c)) count.set(c, (count.get(c) ?? 0) + 1);
  let end = written.length;
  while (end > 0) {
    const c = written[end - 1] ?? "";
    const opener = OPENER.get(c);
    if (AFTER_LINK.has(c)) end--;
    else if (opener !== undefined && (count.get(c) ?? 0) > (count.get(opener) ?? 0)) {
      count.set(c, (count.get(c) ?? 0) - 1);
      end--;
    } else break;
  }
  return written.slice(0, end);
}

/**
 * The http(s) links an email carries, each once: where its HTML's anchors go (a sign-in button's link
 * is often only there), then those written in its text. An image's source, a tracking pixel's
 * included, is never one.
 */
export function linksOf(parsed: Pick<Email, "html" | "text">): string[] {
  const found: string[] = [];
  // An anchor's attributes are read a thousand characters deep at most, so no run of tags is slow.
  for (const m of (parsed.html ?? "")
    .slice(0, 200_000)
    .matchAll(/<a\b[^>]{0,1000}?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    found.push(decodeHref(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  for (const m of (parsed.text ?? "").slice(0, 200_000).matchAll(LINK_IN_TEXT)) found.push(trimLink(m[0]));
  const out: string[] = [];
  for (const link of found.map((l) => l.trim())) {
    if (!/^https?:\/\/\S+$/i.test(link) || link.length > MAX_LINK || out.includes(link)) continue;
    out.push(link);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** An href as written in HTML, its character references read (`&amp;` is `&`). */
function decodeHref(href: string): string {
  const char = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return href
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => char(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => char(Number(d)))
    .replace(/&amp;/gi, "&");
}

/**
 * A message's text with the links its email carries under it, one a line. The links take at most half
 * of what an item holds, and the text is cut to leave them room: they are never the part cut.
 */
function withLinks(text: string, links: readonly string[]): string {
  let block = "";
  for (const link of links) {
    if (block.length + link.length + 1 > MAX_TEXT / 2) break;
    block += `\n${link}`;
  }
  if (!block) return cut(text);
  return `${cut(text, MAX_TEXT - block.length - LINKS_HEADING.length - 2)}\n\n${LINKS_HEADING}${block}`;
}

/**
 * Words a subject uses for a code, a sign-in link or a password reset, in the languages the inbox
 * speaks, as only an account's notice uses them: whole words, and a code named for what it is, never a
 * shop's "código de desconto" or "your code SAVE20".
 */
const ACCOUNT_NOTICE_SUBJECT =
  /\b(?:verify|verification|confirm (?:your |the |this )?(?:e-?mail|address|account)|sign[- ]?in|log[- ]?in (?:link|code)|(?:secure|magic|sign[- ]?in|login|access) link|one[- ]time (?:code|password|passcode|link)|passcode|otp|(?:security|access|login|sign[- ]?in|confirmation|authentication|auth|verification) code|password reset|reset (?:your )?password|two[- ]factor|2fa)\b|c[óo]digo de (?:verifica[çc][ãa]o|verificaci[óo]n|acesso|acceso|seguran[çc]a|seguridad|confirma[çc][ãa]o|confirmaci[óo]n)|iniciar sess[ãa]o|inicia(?:r)? sesi[óo]n|redefinir (?:a )?senha|restablecer (?:la )?contraseña|code de (?:vérification|sécurité|connexion|confirmation)|lien de connexion|réinitialis(?:er|ation) (?:de )?(?:votre )?mot de passe|bestätigungscode|sicherheitscode|anmeldecode|passwort zurücksetzen/i;
/** The same, said in the body: phrases a mailing does not use. */
const ACCOUNT_BODY =
  /(?:verification|security|one-time|confirmation|login|sign-in|authentication) code|(?:sign-in|login|magic|secure) link|código de (?:verificação|verificación|acesso|segurança|seguridad|confirmação|confirmación)|code de (?:vérification|sécurité|connexion)|bestätigungscode|sicherheitscode/i;

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

/**
 * Keeps an email's attachments on its newest thread entry of `direction` on the item. On a note (a
 * held answer), only once: a note that holds files already took this email's. An email put aside as
 * spam (`aside`) has its files named on it, none kept.
 */
async function attach(
  db: Db,
  itemId: string,
  parsed: Email,
  messageId: string | null,
  now: number,
  direction: "in" | "out" | "note",
  who: { sender: string; maxBytes?: number | undefined; aside?: boolean | undefined },
): Promise<{ filename: string }[]> {
  const files = (parsed.attachments ?? []).filter((a) => !a.related && !/^message\//i.test(a.mimeType));
  if (files.length === 0) return [];
  const { rows } = await db.client.query({
    sql: messageId
      ? "SELECT id, attachments FROM thread_entries WHERE item_id = ? AND message_id = ? LIMIT 1"
      : "SELECT id, attachments FROM thread_entries WHERE item_id = ? AND direction = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    params: messageId ? [itemId, messageId] : [itemId, direction],
    method: "all",
  });
  if (direction === "note" && rows[0]?.[1] !== null && rows[0]?.[1] !== undefined) return [];
  const entryId = rows[0]?.[0] ? String(rows[0][0]) : null;
  return keepAttachments(db, {
    itemId,
    entryId,
    now,
    sender: baseAddress(who.sender),
    ...(who.maxBytes !== undefined ? { inboxMaxBytes: who.maxBytes } : {}),
    ...(who.aside ? { aside: true } : {}),
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
  opts: { readonly idsOnly?: boolean } = {},
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
  // A flood of notices is found by the ids it names alone (`idsOnly`).
  if (opts.idsOnly) return null;
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

/**
 * The bucket notices are counted under (`notices`), a hash as for a sender: the domain one sender's
 * domain belongs to (`mail.bank.example` counts as `bank.example`), or, for an automatic email or a
 * domain many people share (gmail.com), the sender's own address.
 */
export async function noticeBucket(from: string, o: { readonly byDomain?: boolean } = {}): Promise<string> {
  const domain = splitAddress(from)?.domain?.toLowerCase();
  const registered = domain ? registrableDomain(domain) : "";
  return domain && o.byDomain !== false && !SHARED_MAIL_PROVIDERS.has(domain) && !SHARED_MAIL_PROVIDERS.has(registered)
    ? senderBucket(`@${registered}`)
    : senderBucket(from);
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
function cut(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  const note = "\n\n[The rest of this email was cut: it was too long to keep.]";
  return `${text.slice(0, max - note.length)}${note}`;
}

/** What heads an automatic email kept on its item, for the owner reading it. */
export const AUTOMATIC_NOTE = "An automatic email from the customer's mailbox (an out-of-office or a returned email):";
/** The same, from the owner's own mailbox answering an alert. */
export const OWNER_AUTOMATIC_NOTE =
  "An automatic email from your own mailbox (an out-of-office), answering the alert about this item. Nothing was sent to the customer:";
/** What heads a notice the inbox kept for why it is one, where its own words would not say. */
export const AUTOMATIC_NOTICE =
  "An automatic email (an out-of-office or a returned email) that answers no conversation. Nobody answers it:";
export const OWN_NOTE = "An email this inbox sent, which came back to it. Nobody answers it:";
export const LOOP_NOTE =
  "An email that went through too many servers, as mail going round in circles does. Nobody answers it:";

/** The longest subject an item keeps. */
const MAX_SUBJECT = 500;
/** An address as an item's contact keeps one: something@somewhere, no spaces or angle brackets. */
const CONTACT_EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** A note for the owner on an item, the inbox's own, kept once by the email's Message-ID. */
async function noteOn(
  db: Db,
  itemId: string,
  n: { subject: string | null; text: string; messageId: string | null; at: number },
): Promise<void> {
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, party_id, subject, body_text, body_format, message_id, created_at)
            VALUES (?, ?, 'note', 'email', 'system', NULL, NULL, ?, ?, 'text', ?, ?)`,
      params: [
        ulid(n.at),
        itemId,
        n.subject?.slice(0, MAX_SUBJECT) || null,
        n.text.slice(0, 20_000),
        n.messageId,
        n.at,
      ],
      method: "run",
    },
  ]);
}

/**
 * An email kept as a notice (`flags.notice`): a new message, the owner's alone, that alerts nobody, runs
 * no rule, reaches no webhook, key or AI, and is answered by nothing. Its words are kept with the links
 * it carries (unless the receiving server found its sender forged), and what it had attached within
 * the usual limits. The spam filter reads it here, never with AI, and tells nothing of it to the shared
 * list; past a day's worth from one domain (`flood`) it is not screened, and none of its links are read.
 * Once per email (its Message-ID), so a second delivery adds nothing.
 */
async function keepNotice(
  db: Db,
  caps: Capabilities,
  o: {
    parsed: Email;
    mail: InboundEmail;
    from: string | null;
    auth: MailAuth | undefined;
    reason: string;
    heading?: string | undefined;
    flood?: boolean | undefined;
    now: () => number;
    opts: IngestOptions;
  },
): Promise<IngestResult> {
  const { parsed, from } = o;
  const messageId = parsed.messageId?.trim() || null;
  const plain = parsed.text ?? htmlToText(parsed.html ?? "");
  const words = stripQuotedReply(plain).trim() || "(empty message)";
  const said = o.heading ? `${o.heading}\n\n${words}` : words;
  // Its links are kept, a flood's too (`linksOf` is bounded): never where its sender was found forged.
  const links = o.auth?.dmarc !== "fail" ? linksOf(parsed) : [];
  const subject = (parsed.subject ?? "").trim().slice(0, MAX_SUBJECT);
  const name = parsed.from?.name?.trim().slice(0, 200);
  const email = from && CONTACT_EMAIL.test(from) ? from : null;
  const who = email ?? from ?? "unknown";
  const caller: Caller = {
    actor: { kind: "customer_human", id: `email:${who}`, channel: "email" },
    tier: o.mail.authenticated ? "verified_principal" : "anonymous",
    sandbox: false,
    now: o.now,
    ...(messageId ? { idempotency: { scope: `email:${who}`, key: messageId } } : {}),
  };
  const files = (parsed.attachments ?? []).filter((a) => !a.related);
  const replyTo = parsed.replyTo?.[0]?.address?.toLowerCase();
  const created = await caps.sendMessage(
    caller,
    {
      body: links.length ? withLinks(said, links) : cut(said),
      ...(subject ? { subject } : {}),
      ...(email || name ? { contact: { ...(email ? { email } : {}), ...(name ? { name } : {}) } } : {}),
      ...(messageId ? { idempotency_key: messageId } : {}),
    },
    {
      screen: {
        door: "email",
        email: {
          serverMarked: spamVerdict(parsed) !== null,
          ...(o.auth ? { auth: o.auth } : {}),
          ...(name ? { displayName: name } : {}),
          ...(replyTo && replyTo !== from ? { replyTo } : {}),
          ...(parsed.html && !o.flood ? { html: parsed.html.slice(0, 200_000) } : {}),
          attachments: { count: files.length, types: files.slice(0, 10).map((a) => a.mimeType || "file") },
          ...(links.length ? { words: cut(said) } : {}),
          notice: true,
          ...(o.flood ? { flood: true } : {}),
        },
      },
    },
  );
  const view = (created as { view: { item: { id: string } }; replayed?: boolean }).view;
  // The same email again, kept already (two deliveries at once): nothing more of it.
  if ((created as { replayed?: boolean }).replayed) return { outcome: "duplicate", itemId: view.item.id };
  if (messageId)
    await db.client
      .query({
        sql: "UPDATE thread_entries SET message_id = ?, raw_blob_key = ? WHERE item_id = ? AND message_id IS NULL",
        params: [messageId, o.mail.rawBlobKey ?? null, view.item.id],
        method: "run",
      })
      .catch(() => undefined);
  const { rows: put } = await db.client.query({
    sql: "SELECT state FROM items WHERE id = ?",
    params: [view.item.id],
    method: "all",
  });
  // Put aside by the spam filter's own checks, as any email would be: under Spam, its files named, not kept.
  const aside = put[0]?.[0] === "spam";
  await attach(db, view.item.id, parsed, messageId, o.now(), "in", {
    sender: from ?? "",
    maxBytes: o.opts.attachmentsMaxBytes,
    aside,
  });
  if (aside) return { outcome: "spam", itemId: view.item.id, reason: "Put aside by the spam filter." };
  return { outcome: "notice", itemId: view.item.id, reason: o.reason };
}

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
