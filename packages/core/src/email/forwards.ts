import type { Db } from "../db";
import { ulid } from "../ids";
import { WriteError } from "../write/errors";
import { baseAddress, newMailToken, plusAddress, splitAddress } from "./tokens";

/**
 * "Forward your existing address" (ADR-026 §2): the business keeps the address its customers know
 * (support@its-domain, its Gmail) and forwards it to the inbox's own address. The inbox keeps each
 * forwarded address with where it stands, shows the owner the confirmation a provider sends (never
 * acting on it), and checks the forward works by sending the business's address an email and
 * watching it come back.
 */

/** The mail providers the owner app has steps for. */
export const MAIL_PROVIDERS = [
  "gmail",
  "google_workspace",
  "outlook",
  "microsoft_365",
  "icloud",
  "ionos",
  "zoho",
  "cpanel",
  "other",
] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export const MAIL_PROVIDER_NAMES: Readonly<Record<MailProvider, string>> = {
  gmail: "Gmail",
  google_workspace: "Google Workspace",
  outlook: "Outlook.com",
  microsoft_365: "Microsoft 365",
  icloud: "iCloud Mail",
  ionos: "IONOS",
  zoho: "Zoho Mail",
  cpanel: "cPanel",
  other: "Another provider",
};

export function isMailProvider(value: unknown): value is MailProvider {
  return typeof value === "string" && (MAIL_PROVIDERS as readonly string[]).includes(value);
}

const PERSONAL: readonly (readonly [RegExp, MailProvider])[] = [
  [/^(gmail|googlemail)\.com$/, "gmail"],
  [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, "outlook"],
  [/^(icloud|me|mac)\.com$/, "icloud"],
  [/^zoho(mail)?\.[a-z.]+$/, "zoho"],
];

const BY_MX: readonly (readonly [RegExp, MailProvider])[] = [
  [/(^|\.)(google|googlemail)\.com$/, "google_workspace"],
  [/(^|\.)mail\.protection\.outlook\.com$/, "microsoft_365"],
  [/(^|\.)outlook\.com$/, "microsoft_365"],
  [/(^|\.)icloud\.com$/, "icloud"],
  [/(^|\.)(ionos\.[a-z.]+|1and1\.[a-z.]+|kundenserver\.de|perfora\.net)$/, "ionos"],
  [/(^|\.)zoho(mail)?\.[a-z.]+$/, "zoho"],
];

/**
 * The provider an address most likely lives at: its domain when it is a personal mailbox's, else
 * what its MX records name. An MX on the address's own domain (`mail.shop.example`) is most often
 * a web host's control panel. `other` when nothing says.
 */
export function detectMailProvider(address: string, mx: readonly string[]): MailProvider {
  const a = splitAddress(address);
  if (!a) return "other";
  for (const [re, p] of PERSONAL) if (re.test(a.domain)) return p;
  const hosts = mx.map((h) => h.trim().replace(/\.$/, "").toLowerCase().split(/\s+/).pop() ?? "");
  for (const host of hosts) for (const [re, p] of BY_MX) if (re.test(host)) return p;
  if (hosts.some((h) => h === a.domain || h.endsWith(`.${a.domain}`))) return "cpanel";
  return "other";
}

export type ForwardState = "setup" | "confirm" | "working" | "not_yet";

export interface Forward {
  readonly id: string;
  readonly address: string;
  readonly provider: MailProvider;
  readonly state: ForwardState;
  /** A check sent to the address's plus form came back: a conversation's address can be the business's own. */
  readonly plusOk: boolean;
  /** What the provider sent to be confirmed, shown to the owner as it came; never acted on. */
  readonly confirmation: {
    readonly from: string;
    readonly code: string | null;
    readonly url: string | null;
    readonly at: number;
  } | null;
  readonly checkSentAt: number | null;
  readonly checkSeenAt: number | null;
  readonly lastSeenAt: number | null;
  readonly createdAt: number;
}

/** At most this many addresses forwarded to one inbox. */
export const MAX_FORWARDS = 10;
/** A check is waited for this long before the plain address is tried, and as long again before "not yet". */
export const CHECK_WAIT_MS = 3 * 60_000;
/** Checks a forward may be sent in a day: each is an email to the business's own address. */
export const CHECKS_PER_DAY = 12;

const COLUMNS =
  "id, address, provider, state, plus_ok, confirm_from, confirm_code, confirm_url, confirm_at, check_sent_at, check_seen_at, last_seen_at, created_at";

function toForward(r: readonly unknown[]): Forward {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const at = n(r[8]);
  return {
    id: String(r[0]),
    address: String(r[1]),
    provider: isMailProvider(r[2]) ? r[2] : "other",
    state: (["setup", "confirm", "working", "not_yet"].includes(String(r[3])) ? String(r[3]) : "setup") as ForwardState,
    plusOk: Number(r[4]) === 1,
    confirmation: at === null ? null : { from: s(r[5]) ?? "", code: s(r[6]), url: s(r[7]), at },
    checkSentAt: n(r[9]),
    checkSeenAt: n(r[10]),
    lastSeenAt: n(r[11]),
    createdAt: Number(r[12]),
  };
}

export async function listForwards(db: Db): Promise<Forward[]> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM email_forwards ORDER BY created_at, id`,
    params: [],
    method: "all",
  });
  return rows.map(toForward);
}

export async function forwardById(db: Db, id: string): Promise<Forward | null> {
  const { rows } = await db.client.query({
    sql: `SELECT ${COLUMNS} FROM email_forwards WHERE id = ?`,
    params: [id],
    method: "all",
  });
  return rows[0] ? toForward(rows[0]) : null;
}

const invalid = (message: string) =>
  new WriteError("invalid_input", message, { fields: [{ path: "address", problem: "invalid", message }] });

/**
 * Adds an address the business forwards here, or changes the provider of one it has. Refused: what
 * is not an address, the inbox's own address (it would forward to itself), and more than
 * `MAX_FORWARDS`.
 */
export async function addForward(
  db: Db,
  o: { address: string; provider: MailProvider; inbound: string | null; now: number },
): Promise<Forward> {
  const address = baseAddress(o.address);
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))
    throw invalid("an email address, like support@your-shop.com");
  if (o.inbound && baseAddress(o.inbound) === address) {
    throw invalid("that is this inbox's own address: forward your existing address to it instead");
  }
  const { rows } = await db.client.query({ sql: "SELECT count(*) FROM email_forwards", params: [], method: "all" });
  const existing = (await listForwards(db)).find((f) => f.address === address);
  if (!existing && Number(rows[0]?.[0] ?? 0) >= MAX_FORWARDS) throw invalid(`at most ${MAX_FORWARDS} addresses`);
  await db.client.query({
    sql: `INSERT INTO email_forwards (id, address, provider, state, created_at, updated_at) VALUES (?, ?, ?, 'setup', ?, ?)
          ON CONFLICT (address) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at`,
    params: [ulid(o.now), address, o.provider, o.now, o.now],
    method: "run",
  });
  const [made] = (await listForwards(db)).filter((f) => f.address === address);
  if (!made) throw new Error("the address was not kept");
  return made;
}

export async function removeForward(db: Db, id: string): Promise<boolean> {
  const [done] = await db.batch([
    { sql: "DELETE FROM email_forwards WHERE id = ?", params: [id], method: "run" },
    { sql: "DELETE FROM mail_tokens WHERE kind = 'check' AND forward_id = ?", params: [id], method: "run" },
  ]);
  return (done?.changes ?? 0) > 0;
}

/** The owner saw the confirmation and dealt with it in their provider: it is no longer shown. */
export async function clearConfirmation(db: Db, id: string, now: number): Promise<void> {
  await db.client.query({
    sql: `UPDATE email_forwards SET confirm_from = NULL, confirm_code = NULL, confirm_url = NULL, confirm_at = NULL,
            state = CASE WHEN state = 'confirm' THEN 'setup' ELSE state END, updated_at = ? WHERE id = ?`,
    params: [now, id],
    method: "run",
  });
}

/**
 * A check: a token, and the address to send it to. The first goes to the address's plus form
 * (`support+c…@shop.example`): back through the forward, it proves plus addresses arrive too. With
 * `plain`, to the address itself. Null when the forward is gone or had its checks for the day.
 */
export async function startCheck(
  db: Db,
  id: string,
  o: { plain: boolean; now: number },
): Promise<{ token: string; to: string; forward: Forward } | null> {
  const forward = await forwardById(db, id);
  if (!forward) return null;
  const { rows } = await db.client.query({
    sql: "SELECT count(*) FROM mail_tokens WHERE kind = 'check' AND forward_id = ? AND created_at >= ?",
    params: [id, o.now - 86_400_000],
    method: "all",
  });
  if (Number(rows[0]?.[0] ?? 0) >= CHECKS_PER_DAY) return null;
  const token = newMailToken("check");
  const to = o.plain ? forward.address : plusAddress(forward.address, token);
  if (!to) return null;
  await db.batch([
    {
      sql: "INSERT INTO mail_tokens (token, kind, item_id, forward_id, created_at) VALUES (?, 'check', NULL, ?, ?)",
      params: [token, id, o.now],
      method: "run",
    },
    {
      sql: `UPDATE email_forwards SET check_sent_at = ?, check_plain = ?, check_seen_at = NULL, updated_at = ?,
              state = CASE WHEN state = 'not_yet' THEN 'setup' ELSE state END WHERE id = ?`,
      params: [o.now, o.plain ? 1 : 0, o.now, id],
      method: "run",
    },
  ]);
  return { token, to, forward };
}

/**
 * A check came back. Through the plus address: the forward works and plus addresses arrive. Through
 * the plain one: the forward works. A token from an earlier check counts the same: the forward
 * carried it.
 */
export async function checkArrived(db: Db, o: { token: string; forwardId: string; now: number }): Promise<void> {
  const { rows } = await db.client.query({
    sql: "SELECT created_at FROM mail_tokens WHERE token = ? AND kind = 'check' AND forward_id = ?",
    params: [o.token, o.forwardId],
    method: "all",
  });
  if (!rows[0]) return;
  const forward = await forwardById(db, o.forwardId);
  if (!forward) return;
  // Which address the check went to is the forward's at the time; a plain check never says plus works.
  const { rows: plainRows } = await db.client.query({
    sql: "SELECT check_plain FROM email_forwards WHERE id = ?",
    params: [o.forwardId],
    method: "all",
  });
  const plus = Number(plainRows[0]?.[0] ?? 1) === 0;
  await db.batch([
    {
      sql: `UPDATE email_forwards SET state = 'working', check_seen_at = ?, last_seen_at = ?, updated_at = ?,
              plus_ok = CASE WHEN ? = 1 THEN 1 ELSE plus_ok END WHERE id = ?`,
      params: [o.now, o.now, o.now, plus ? 1 : 0, o.forwardId],
      method: "run",
    },
    { sql: "UPDATE mail_tokens SET used_at = ? WHERE token = ?", params: [o.now, o.token], method: "run" },
  ]);
}

/** A check that did not come back in time: the plain address is tried next, then "not yet". */
export async function checkLapsed(db: Db, o: { forwardId: string; now: number }): Promise<"plain" | "not_yet" | null> {
  const forward = await forwardById(db, o.forwardId);
  if (!forward || forward.checkSentAt === null || forward.checkSeenAt !== null) return null;
  if (o.now - forward.checkSentAt < CHECK_WAIT_MS) return null;
  const { rows } = await db.client.query({
    sql: "SELECT check_plain FROM email_forwards WHERE id = ?",
    params: [o.forwardId],
    method: "all",
  });
  if (Number(rows[0]?.[0] ?? 0) === 0) return "plain";
  await db.client.query({
    sql: "UPDATE email_forwards SET state = CASE WHEN state = 'working' THEN state ELSE 'not_yet' END, updated_at = ? WHERE id = ?",
    params: [o.now, o.forwardId],
    method: "run",
  });
  return "not_yet";
}

/**
 * Mail arrived that names a forwarded address among its recipients: the forward works. Returns the
 * forwards it named. Plus addresses count as their address.
 */
export async function forwardsSeen(db: Db, recipients: readonly string[], now: number): Promise<Forward[]> {
  const bases = [...new Set(recipients.map((r) => baseAddress(r)).filter((r): r is string => r !== null))];
  if (bases.length === 0) return [];
  const all = await listForwards(db);
  const hit = all.filter((f) => bases.includes(f.address));
  for (const f of hit) {
    await db.client.query({
      sql: `UPDATE email_forwards SET last_seen_at = ?, updated_at = ?,
              state = CASE WHEN state = 'confirm' THEN state ELSE 'working' END WHERE id = ?`,
      params: [now, now, f.id],
      method: "run",
    });
  }
  return hit;
}

// ---- the provider's confirmation ---------------------------------------------------------------------

/** The domains a provider's confirmation links may be on: a link anywhere else is not shown. */
const LINK_HOSTS: readonly (readonly [RegExp, RegExp])[] = [
  // [sender, link host]
  [/@google\.com$/, /(^|\.)google\.com$/],
  [/@(.+\.)?zoho(mail)?\.[a-z.]+$/, /(^|\.)zoho(mail)?\.[a-z.]+$/],
  [/@(.+\.)?yahoo(inc)?\.[a-z.]+$/, /(^|\.)yahoo\.[a-z.]+$/],
  [/@(.+\.)?(proton\.me|protonmail\.com)$/, /(^|\.)(proton\.me|protonmail\.com)$/],
  [/@(.+\.)?fastmail\.[a-z.]+$/, /(^|\.)fastmail\.[a-z.]+$/],
];

export interface Confirmation {
  /** Who sent it (the provider's address). */
  readonly from: string;
  /** The address it asks to forward, when it names one. */
  readonly forwarding: string | null;
  readonly code: string | null;
  readonly url: string | null;
}

const FORWARD_WORDS =
  /(forward|forwarding|weiterleitung|reenv[ií]o|reencaminhamento|encaminhamento|transfert|inoltro|doorsturen|przekazywanie)/i;
const CONFIRM_WORDS = /(confirm|verif|best[aä]tig|confirma|v[ée]rif|conferma|bevestig|potwierd)/i;

/**
 * Whether an email is a mail provider asking to confirm forwarding to this inbox, and what it says:
 * the code to type, the link to open, the address being forwarded. Gmail's (from
 * forwarding-noreply@google.com) is known by its sender; others by their words. Nothing here opens
 * a link or types a code: the owner does, in their provider.
 */
export function recogniseConfirmation(
  mail: {
    readonly from: string;
    readonly subject: string;
    readonly text: string;
  },
  /** The inbox's own addresses, which a confirmation names too (it is sent to them): never the forwarded one. */
  own: readonly string[] = [],
): Confirmation | null {
  const from = mail.from.trim().toLowerCase();
  const subject = mail.subject.trim();
  const text = mail.text.slice(0, 20_000);
  const google = from === "forwarding-noreply@google.com";
  if (!google && !(FORWARD_WORDS.test(subject) && CONFIRM_WORDS.test(`${subject}\n${text.slice(0, 2_000)}`))) {
    return null;
  }
  const code =
    /\(#\s?(\d{6,12})\)/.exec(subject)?.[1] ??
    /(?:code|código|codice|Bestätigungscode|code de confirmation|verification code)\D{0,24}([0-9]{4,12}|[A-Z0-9]{6,10})\b/i.exec(
      text,
    )?.[1] ??
    null;
  const hostRule = LINK_HOSTS.find(([sender]) => sender.test(from))?.[1];
  const senderDomain = splitAddress(from)?.domain ?? "";
  let url: string | null = null;
  for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    try {
      const u = new URL(m[0]);
      const host = u.hostname.toLowerCase();
      const ok = hostRule
        ? hostRule.test(host)
        : senderDomain !== "" && (host === senderDomain || host.endsWith(`.${senderDomain}`));
      if (ok && u.protocol === "https:") {
        url = u.toString();
        break;
      }
    } catch {
      // not a link
    }
  }
  if (!code && !url) return null;
  const addresses =
    `${subject}\n${text.slice(0, 4_000)}`.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const mine = new Set(own.map((a) => baseAddress(a)).filter((a): a is string => a !== null));
  const forwarding =
    addresses
      .map((a) => a.toLowerCase())
      .find((a) => a !== from && !a.endsWith("@google.com") && !mine.has(baseAddress(a) ?? a)) ?? null;
  return { from, forwarding: forwarding ? baseAddress(forwarding) : null, code, url };
}

/**
 * Keeps a provider's confirmation on the forward it is for: the one it names, else the only forward
 * waiting to be set up. Only a forward the owner is setting up takes one, so nobody can put a link in
 * front of the owner by writing to the inbox: there must be a forward waiting, and the email must name
 * it, or be the only one it can be for. Returns the forward it was kept on.
 */
export async function keepConfirmation(db: Db, c: Confirmation, now: number): Promise<Forward | null> {
  const waiting = (await listForwards(db)).filter((f) => f.state !== "working");
  const forward = c.forwarding
    ? waiting.find((f) => f.address === c.forwarding)
    : waiting.length === 1
      ? waiting[0]
      : undefined;
  if (!forward) return null;
  await db.client.query({
    sql: `UPDATE email_forwards SET state = 'confirm', confirm_from = ?, confirm_code = ?, confirm_url = ?, confirm_at = ?,
            updated_at = ? WHERE id = ?`,
    params: [c.from, c.code, c.url, now, now, forward.id],
    method: "run",
  });
  return forwardById(db, forward.id);
}
