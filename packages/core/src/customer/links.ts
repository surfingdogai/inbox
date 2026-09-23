import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import type { SecretBox } from "../secrets/box";
import type { CustomerLang } from "./lang";
import { base64Url, openOffer } from "./offer";

/**
 * Links in the business's emails (ADR-018 §5): Accept, Decline, Pick another time, Send the details.
 * Each is signed, names one item and one action, expires, and is used once. Opening one only shows
 * a page — mail scanners fetch links — and only the page's POST acts.
 *
 *   jti   = base64url(HMAC(K, "jti\0" + mailKey + "\0" + action))[0..22]      stable across a job's retries
 *   mac   = base64url(HMAC(K, "act\0" + jti + "\0" + itemId + "\0" + action + "\0" + expiresAt + "\0" + termsSha))[0..22]
 *   token = jti + "." + mac                                                     45 URL-safe characters
 *
 * K is derived from the newest `INBOX_SECRET_KEY` (`box.mac("action-link")`). A token is checked
 * against its row: an unknown jti, a mac that does not match what the row says, or a secret that
 * has been rotated since, and the link is not valid.
 */
export type LinkAction =
  | "accept_time"
  | "decline_time"
  | "other_time"
  | "accept_quote"
  | "decline_quote"
  | "details"
  /** The page about the booking network, from the code email, where the customer can switch it off for themselves. */
  | "networks_off";

export const LINK_ACTIONS: readonly LinkAction[] = [
  "accept_time",
  "decline_time",
  "other_time",
  "accept_quote",
  "decline_quote",
  "details",
  "networks_off",
];

export interface LinkRow {
  readonly jti: string;
  readonly itemId: string;
  readonly action: LinkAction;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  /** The fingerprint of the terms the email carried; for a details link, the question it answers (`detailsSha`). */
  readonly termsSha: string;
  readonly lang: CustomerLang;
  /** The email the link went out in: its siblings share it. */
  readonly mailKey: string | null;
  readonly createdAt: number;
}

/**
 * How long a link lives. An answer link never stops working before the "answer by" date its email
 * shows: it lives until then and a day more (`LINK_GRACE_MS`), after which the page says why it is
 * too late rather than that the link is dead. Without such a date, two weeks; the link to stop the
 * booking network, a year.
 */
export const LINK_MAX_MS: Readonly<Record<"time" | "quote" | "details" | "networks", number>> = {
  time: 14 * 86_400_000,
  quote: 30 * 86_400_000,
  details: 14 * 86_400_000,
  networks: 365 * 86_400_000,
};
export const LINK_GRACE_MS = 86_400_000;

/** Rows are kept this long after they expire, then the hourly housekeeping drops them. */
export const LINK_KEEP_AFTER_EXPIRY_MS = 30 * 86_400_000;

const TOKEN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const encoder = new TextEncoder();

async function hmac22(box: SecretBox, text: string): Promise<string> {
  const key = await box.mac("action-link");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text) as BufferSource));
  return base64Url(sig).slice(0, 22);
}

export function jtiFor(box: SecretBox, mailKey: string, action: LinkAction): Promise<string> {
  return hmac22(box, `jti\0${mailKey}\0${action}`);
}

function macFor(box: SecretBox, row: Pick<LinkRow, "jti" | "itemId" | "action" | "expiresAt" | "termsSha">) {
  return hmac22(box, `act\0${row.jti}\0${row.itemId}\0${row.action}\0${row.expiresAt}\0${row.termsSha}`);
}

/** The token for a stored link, from its row: what an email and a sibling link carry. */
export async function tokenFor(box: SecretBox, row: LinkRow): Promise<string> {
  return `${row.jti}.${await macFor(box, row)}`;
}

export function linkUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/c/${token}`;
}

/**
 * The links one email carries, one row per action, in one batch. The same email minted again — a
 * retried job — finds its rows and gives the same tokens: rows are inserted if absent and the tokens
 * are made from what is stored.
 */
export async function mintLinks(
  db: Db,
  box: SecretBox,
  input: {
    readonly itemId: string;
    readonly mailKey: string;
    readonly lang: CustomerLang;
    readonly termsSha: string;
    readonly expiresAt: number;
    readonly actions: readonly LinkAction[];
  },
  now: number,
): Promise<Map<LinkAction, string>> {
  const jtis = await Promise.all(input.actions.map((a) => jtiFor(box, input.mailKey, a)));
  const statements: Statement[] = input.actions.map((action, i) => ({
    sql: `INSERT OR IGNORE INTO action_links (jti, item_id, action, expires_at, used_at, created_at, terms_sha, lang, mail_key)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    params: [jtis[i], input.itemId, action, input.expiresAt, now, input.termsSha, input.lang, input.mailKey],
    method: "run",
  }));
  if (statements.length) await db.batch(statements);
  const rows = await linkRows(db, "jti", jtis);
  // In the order asked for: the email lists them so.
  const out = new Map<LinkAction, string>();
  for (const action of input.actions) {
    const row = rows.find((r) => r.action === action);
    if (row) out.set(action, await tokenFor(box, row));
  }
  return out;
}

/**
 * What a details link answers: the question the item was last asked (the latest `request_info`).
 * A new question retires the links of the one before; nothing else does.
 */
export async function detailsSha(db: Db, itemId: string): Promise<string> {
  const { rows } = await db.client.query({
    sql: "SELECT MAX(seq) FROM item_events WHERE item_id = ? AND event = 'request_info'",
    params: [itemId],
    method: "all",
  });
  const seq = rows[0]?.[0];
  return `ask:${seq === null || seq === undefined ? 0 : Number(seq)}`;
}

/**
 * The links for one email about `item`, when it waits for the customer's answer: Accept, Decline,
 * Pick another time for a time we proposed; Accept, Decline for a quote; Send the details for a
 * question. Null when there is nothing to answer, or no secret to sign them with, or no public
 * address for them to point at: the email then asks for a reply instead.
 */
export async function linksForEmail(
  db: Db,
  box: SecretBox | null,
  item: Item,
  input: {
    readonly mailKey: string;
    readonly lang: CustomerLang;
    readonly base: string;
    readonly now: number;
    /** A proposed time's links stop working when the notice before it starts. */
    readonly minNoticeMin?: number | undefined;
  },
): Promise<Map<LinkAction, string> | null> {
  if (!box || !input.base) return null;
  const offer = await openOffer(item, { minNoticeMin: input.minNoticeMin ?? 0 });
  let actions: LinkAction[];
  let termsSha: string;
  let until: number;
  if (offer) {
    const max = offer.kind === "time" ? LINK_MAX_MS.time : LINK_MAX_MS.quote;
    actions = offer.kind === "time" ? ["accept_time", "decline_time", "other_time"] : ["accept_quote", "decline_quote"];
    termsSha = offer.termsSha;
    // Until the answer-by date the email shows, and a day more; no date, the usual time.
    const deadline = offer.deadline ? Date.parse(offer.deadline) : Number.NaN;
    until = Number.isFinite(deadline) ? deadline + LINK_GRACE_MS : input.now + max;
  } else if (item.state === "needs_info") {
    actions = ["details"];
    termsSha = await detailsSha(db, item.id);
    until = input.now + LINK_MAX_MS.details;
  } else {
    return null;
  }
  if (!(until > input.now)) return null;
  const tokens = await mintLinks(
    db,
    box,
    { itemId: item.id, mailKey: input.mailKey, lang: input.lang, termsSha, expiresAt: until, actions },
    input.now,
  );
  const out = new Map<LinkAction, string>();
  for (const [action, token] of tokens) out.set(action, linkUrl(input.base, token));
  return out;
}

/**
 * The link in the code email that opens the page about the booking network, where the customer can
 * switch it off for themselves: one per code email (`mailKey`), a year long, in their language.
 * Null without a secret to sign it or a public address.
 */
export async function networksLink(
  db: Db,
  box: SecretBox | null,
  input: {
    readonly itemId: string;
    readonly mailKey: string;
    readonly lang: CustomerLang;
    readonly base: string;
    readonly now: number;
  },
): Promise<string | null> {
  if (!box || !input.base) return null;
  const tokens = await mintLinks(
    db,
    box,
    {
      itemId: input.itemId,
      mailKey: input.mailKey,
      lang: input.lang,
      termsSha: "networks",
      expiresAt: input.now + LINK_MAX_MS.networks,
      actions: ["networks_off"],
    },
    input.now,
  );
  const token = tokens.get("networks_off");
  return token ? linkUrl(input.base, token) : null;
}

/**
 * The links in an email as the mail log keeps them: each keeps its jti and loses its mac. What the
 * log shows — the owner's app, `get_item`, a copy of the database — can open no page and answer
 * nothing for the customer; only the email the customer got can. `fillLinks` puts the macs back
 * from `action_links`, with the instance's secret, when the email is sent.
 */
const WHOLE_LINK = /\/c\/([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g;
const CUT_LINK = /\/c\/([A-Za-z0-9_-]{22})\.…/g;

export function cutLinks(text: string): string {
  return text.replace(WHOLE_LINK, "/c/$1.…");
}

/**
 * A logged email's cut links made whole again, for the send: only the links minted for this very
 * email (`mailKey`) about this item. A cut link from another email — pasted into a reply, say — stays
 * cut, so no reply can carry one customer's answer to another. A link whose row is gone stays cut.
 */
export async function fillLinks(
  db: Db,
  box: SecretBox | null,
  text: string,
  own: { readonly mailKey: string; readonly itemId: string | null },
): Promise<string> {
  // At most the links one email carries, and well within D1's hundred bound values.
  const jtis = [...new Set([...text.matchAll(CUT_LINK)].map((m) => m[1] as string))].slice(0, 20);
  if (!box || jtis.length === 0 || !own.itemId) return text;
  const tokens = new Map<string, string>();
  for (const row of await linkRows(db, "jti", jtis)) {
    if (row.mailKey !== own.mailKey || row.itemId !== own.itemId) continue;
    tokens.set(row.jti, await tokenFor(box, row));
  }
  return text.replace(CUT_LINK, (cut, jti: string) => {
    const token = tokens.get(jti);
    return token ? `/c/${token}` : cut;
  });
}

/** The stored link a token names, when the token is one of ours; null for anything else. */
export async function verifyLink(db: Db, box: SecretBox | null, token: string): Promise<LinkRow | null> {
  const m = TOKEN.exec(token);
  if (!m || !box) return null;
  const [, jti, mac] = m as unknown as [string, string, string];
  const [row] = await linkRows(db, "jti", [jti]);
  if (!row) return null;
  return equal(await macFor(box, row), mac) ? row : null;
}

/** The other links of the same email, for the page to offer beside its own button. */
export async function siblingsOf(db: Db, box: SecretBox, row: LinkRow): Promise<Map<LinkAction, string>> {
  const out = new Map<LinkAction, string>();
  if (!row.mailKey) return out;
  for (const sibling of await linkRows(db, "mail_key", [row.mailKey])) {
    if (sibling.jti === row.jti || sibling.itemId !== row.itemId) continue;
    out.set(sibling.action, await tokenFor(box, sibling));
  }
  return out;
}

/** Marks a link used, in the batch of the change it made. Never fails: the item's version makes it act once. */
export function linkUsedStatement(jti: string, now: number): Statement {
  return {
    sql: "UPDATE action_links SET used_at = ? WHERE jti = ? AND used_at IS NULL",
    params: [now, jti],
    method: "run",
  };
}

/** Drops links thirty days after they expired. */
export async function pruneActionLinks(db: Db, now: number): Promise<void> {
  await db.client.query({
    sql: "DELETE FROM action_links WHERE expires_at < ?",
    params: [now - LINK_KEEP_AFTER_EXPIRY_MS],
    method: "run",
  });
}

async function linkRows(db: Db, column: "jti" | "mail_key", values: readonly string[]): Promise<LinkRow[]> {
  if (values.length === 0) return [];
  const { rows } = await db.client.query({
    sql: `SELECT jti, item_id, action, expires_at, used_at, terms_sha, lang, mail_key, created_at
            FROM action_links WHERE ${column} IN (${values.map(() => "?").join(", ")})`,
    params: [...values],
    method: "all",
  });
  return rows.map((r) => ({
    jti: String(r[0]),
    itemId: String(r[1]),
    action: String(r[2]) as LinkAction,
    expiresAt: Number(r[3]),
    usedAt: r[4] === null || r[4] === undefined ? null : Number(r[4]),
    termsSha: String(r[5] ?? ""),
    lang: r[6] === "pt" ? "pt" : "en",
    mailKey: r[7] === null || r[7] === undefined ? null : String(r[7]),
    createdAt: Number(r[8]),
  }));
}

/** Compares two strings in time that depends only on their length. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
