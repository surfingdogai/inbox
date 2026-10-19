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
  "yahoo",
  "proton",
  "fastmail",
  "zoho",
  "ionos",
  "godaddy",
  "hostinger",
  "ovh",
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
  yahoo: "Yahoo Mail",
  proton: "Proton Mail",
  fastmail: "Fastmail",
  zoho: "Zoho Mail",
  ionos: "IONOS",
  godaddy: "GoDaddy",
  hostinger: "Hostinger",
  ovh: "OVH",
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
  [/^(yahoo|ymail|rocketmail)\.[a-z.]+$/, "yahoo"],
  [/^(proton\.me|pm\.me|protonmail\.(com|ch))$/, "proton"],
  [/^fastmail\.(com|fm)$/, "fastmail"],
  [/^zoho(mail)?\.[a-z.]+$/, "zoho"],
];

const BY_MX: readonly (readonly [RegExp, MailProvider])[] = [
  [/(^|\.)(google|googlemail)\.com$/, "google_workspace"],
  [/(^|\.)mail\.protection\.outlook\.com$/, "microsoft_365"],
  [/(^|\.)outlook\.com$/, "microsoft_365"],
  [/(^|\.)icloud\.com$/, "icloud"],
  [/(^|\.)(ionos\.[a-z.]+|1and1\.[a-z.]+|kundenserver\.de|perfora\.net)$/, "ionos"],
  [/(^|\.)zoho(mail)?\.[a-z.]+$/, "zoho"],
  [/(^|\.)protonmail\.ch$/, "proton"],
  [/(^|\.)messagingengine\.com$/, "fastmail"],
  [/(^|\.)yahoodns\.net$/, "yahoo"],
  [/(^|\.)secureserver\.net$/, "godaddy"],
  [/(^|\.)hostinger\.[a-z.]+$/, "hostinger"],
  [/(^|\.)ovh\.net$/, "ovh"],
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
  /**
   * `working` only once a check came back through the forward (its secret token): an address named in
   * an email's headers proves nothing, since whoever writes the email writes those too.
   */
  readonly state: ForwardState;
  /** A check sent to the address's plus form came back: a conversation's address can be the business's own. */
  readonly plusOk: boolean;
  /** What the provider sent to be confirmed, shown to the owner as it came; never acted on. */
  readonly confirmation: {
    /** The provider's own sender, as it was proven (`recogniseConfirmation`). */
    readonly from: string;
    /** The provider, named by that sender, never by what the owner picked. */
    readonly provider: string;
    readonly code: string | null;
    /** Only ever on the provider's own confirmation host (Gmail's `mail-settings.google.com`). */
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
/**
 * Check emails one inbox may send in a day, all its addresses together, and checks one address may
 * be sent (its plain retry rides with the check it follows). Each is an email to an address the owner
 * typed: it must never be a way to write to someone else's mailbox. Counted from what was sent, so
 * removing an address and adding it again starts nothing afresh.
 */
export const CHECKS_PER_DAY = 12;
export const CHECKS_PER_ADDRESS_PER_DAY = 3;
/** A provider's confirmation that came before its address was added waits this long for it. */
export const HELD_CONFIRMATION_MS = 24 * 60 * 60_000;

const COLUMNS =
  "id, address, provider, state, plus_ok, confirm_from, confirm_code, confirm_url, confirm_at, check_sent_at, check_seen_at, last_seen_at, created_at";

function toForward(r: readonly unknown[]): Forward {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const at = n(r[8]);
  const from = s(r[5]) ?? "";
  return {
    id: String(r[0]),
    address: String(r[1]),
    provider: isMailProvider(r[2]) ? r[2] : "other",
    state: (["setup", "confirm", "working", "not_yet"].includes(String(r[3])) ? String(r[3]) : "setup") as ForwardState,
    plusOk: Number(r[4]) === 1,
    confirmation:
      at === null ? null : { from, provider: confirmationSender(from)?.name ?? "", code: s(r[6]), url: s(r[7]), at },
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
 * `MAX_FORWARDS`. A provider's confirmation that came for the address before it was added (Gmail
 * sends it the moment the owner adds the forward there) is put on it.
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
  const { rows: held } = await db.client.query({
    sql: "SELECT from_address, code, url, at FROM email_confirmations_held WHERE forwarding = ? AND at >= ?",
    params: [address, o.now - HELD_CONFIRMATION_MS],
    method: "all",
  });
  await db.client.query({
    sql: "DELETE FROM email_confirmations_held WHERE forwarding = ? OR at < ?",
    params: [address, o.now - HELD_CONFIRMATION_MS],
    method: "run",
  });
  const h = held[0];
  if (h && !made.confirmation && made.checkSeenAt === null) {
    await putConfirmation(db, made.id, {
      from: String(h[0]),
      code: h[1] === null ? null : String(h[1]),
      url: h[2] === null ? null : String(h[2]),
      at: Number(h[3]),
    });
    return (await forwardById(db, made.id)) ?? made;
  }
  return made;
}

/** Stops expecting mail from an address. Its checks stay counted for the day (`CHECKS_PER_DAY`). */
export async function removeForward(db: Db, id: string): Promise<boolean> {
  const done = await db.client.query({ sql: "DELETE FROM email_forwards WHERE id = ?", params: [id], method: "run" });
  return (done.changes ?? 0) > 0;
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
 * `plain`, to the address itself. Null when the forward is gone, or the inbox or the address had their
 * checks for the day. Each token keeps where it went, so what comes back says what it proves.
 */
export async function startCheck(
  db: Db,
  id: string,
  o: { plain: boolean; now: number },
): Promise<{ token: string; to: string; forward: Forward } | null> {
  const forward = await forwardById(db, id);
  if (!forward) return null;
  const since = o.now - 86_400_000;
  // Checks older than a week say nothing any more: they go, the day's stay counted.
  await db.client.query({
    sql: "DELETE FROM mail_tokens WHERE kind = 'check' AND created_at < ?",
    params: [o.now - 7 * 86_400_000],
    method: "run",
  });
  const { rows } = await db.client.query({
    sql: `SELECT count(*), COALESCE(SUM(CASE WHEN sent_to = ? AND plain = 0 THEN 1 ELSE 0 END), 0)
            FROM mail_tokens WHERE kind = 'check' AND created_at >= ?`,
    params: [forward.address, since],
    method: "all",
  });
  if (Number(rows[0]?.[0] ?? 0) >= CHECKS_PER_DAY) return null;
  // A plain check follows the plus one it retries; only a new check counts against the address.
  if (!o.plain && Number(rows[0]?.[1] ?? 0) >= CHECKS_PER_ADDRESS_PER_DAY) return null;
  const token = newMailToken("check");
  const to = o.plain ? forward.address : plusAddress(forward.address, token);
  if (!to) return null;
  await db.batch([
    {
      sql: `INSERT INTO mail_tokens (token, kind, item_id, forward_id, sent_to, plain, created_at)
            VALUES (?, 'check', NULL, ?, ?, ?, ?)`,
      params: [token, id, forward.address, o.plain ? 1 : 0, o.now],
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
 * A check came back: the forward works. It proves plus addresses arrive only when that token went
 * to the plus address and the email came for it (`recipients` names `support+c…@shop.example`): what
 * the forward does today is read from the token that came back, never from a later check's. The
 * provider's confirmation, if one was shown, has done its work and goes.
 */
export async function checkArrived(
  db: Db,
  o: { token: string; forwardId: string; recipients: readonly string[]; now: number },
): Promise<void> {
  const { rows } = await db.client.query({
    sql: "SELECT plain, sent_to FROM mail_tokens WHERE token = ? AND kind = 'check' AND forward_id = ?",
    params: [o.token, o.forwardId],
    method: "all",
  });
  const row = rows[0];
  if (!row) return;
  const forward = await forwardById(db, o.forwardId);
  if (!forward) return;
  const plusTo = plusAddress(String(row[1] ?? forward.address), o.token);
  const plus = Number(row[0]) === 0 && plusTo !== null && o.recipients.some((r) => r.trim().toLowerCase() === plusTo);
  await db.batch([
    {
      sql: `UPDATE email_forwards SET state = 'working', check_seen_at = ?, last_seen_at = ?, updated_at = ?,
              plus_ok = CASE WHEN ? = 1 THEN 1 ELSE plus_ok END,
              confirm_from = NULL, confirm_code = NULL, confirm_url = NULL, confirm_at = NULL WHERE id = ?`,
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
 * Mail arrived that names a forwarded address among its recipients: when it was last seen, nothing
 * more (the sender writes those headers; only a check says the forward works). Returns the forwards
 * it named. Plus addresses count as their address.
 */
export async function forwardsSeen(db: Db, recipients: readonly string[], now: number): Promise<Forward[]> {
  const bases = [...new Set(recipients.map((r) => baseAddress(r)).filter((r): r is string => r !== null))];
  if (bases.length === 0) return [];
  const all = await listForwards(db);
  const hit = all.filter((f) => bases.includes(f.address));
  for (const f of hit) {
    await db.client.query({
      sql: "UPDATE email_forwards SET last_seen_at = ?, updated_at = ? WHERE id = ?",
      params: [now, now, f.id],
      method: "run",
    });
  }
  return hit;
}

// ---- the provider's confirmation ---------------------------------------------------------------------

/**
 * The providers whose forwarding confirmations the inbox shows, by their own sender: Google's exact
 * address, and the domains the others send from. Only Gmail's carries a link worth showing, and only
 * on its own confirmation host; for every other provider the code is shown, never a link, so nothing
 * written to the inbox can put a page in front of the owner.
 */
const CONFIRMATION_SENDERS: readonly {
  readonly name: string;
  readonly test: (from: string) => boolean;
  /** The sender's own domain, which a receiving server's DKIM or DMARC pass must be for. */
  readonly domains: readonly string[];
  readonly linkHost?: string;
}[] = [
  {
    name: "Gmail",
    test: (f) => f === "forwarding-noreply@google.com",
    domains: ["google.com"],
    linkHost: "mail-settings.google.com",
  },
  {
    name: "Zoho Mail",
    test: (f) => /@(zoho\.(com|eu|in|com\.au|jp|com\.cn)|zohomail\.(com|eu|in))$/.test(f),
    domains: [
      "zoho.com",
      "zoho.eu",
      "zoho.in",
      "zoho.com.au",
      "zoho.jp",
      "zoho.com.cn",
      "zohomail.com",
      "zohomail.eu",
      "zohomail.in",
    ],
  },
  {
    name: "Yahoo Mail",
    test: (f) => /@(yahoo\.com|yahoo-inc\.com|cc\.yahoo-inc\.com|yahoomail\.com)$/.test(f),
    domains: ["yahoo.com", "yahoo-inc.com", "yahoomail.com"],
  },
  {
    name: "Proton Mail",
    test: (f) => /@(proton\.me|protonmail\.com)$/.test(f),
    domains: ["proton.me", "protonmail.com"],
  },
  { name: "Fastmail", test: (f) => /@fastmail\.(com|fm)$/.test(f), domains: ["fastmail.com", "fastmail.fm"] },
];

/** The provider a confirmation's sender is, or null for any other sender. */
export function confirmationSender(
  from: string,
): { name: string; domains: readonly string[]; linkHost?: string } | null {
  const f = from.trim().toLowerCase();
  return CONFIRMATION_SENDERS.find((s) => s.test(f)) ?? null;
}

export interface Confirmation {
  /** Who sent it (the provider's address). */
  readonly from: string;
  /** The provider, as its sender names it. */
  readonly provider: string;
  /** The address it asks to forward, when it names one. */
  readonly forwarding: string | null;
  readonly code: string | null;
  readonly url: string | null;
}

/** What the receiving server found, as the email door passes it on (`MailAuth` in the adapters). */
export interface ConfirmationAuth {
  readonly dkim?: readonly string[] | undefined;
  readonly dmarc?: string | undefined;
}

const FORWARD_WORDS =
  /(forward|forwarding|weiterleitung|reenv[ií]o|reencaminhamento|encaminhamento|transfert|inoltro|doorsturen|przekazywanie)/i;
const CONFIRM_WORDS = /(confirm|verif|best[aä]tig|confirma|v[ée]rif|conferma|bevestig|potwierd)/i;

/**
 * Whether an email is a mail provider asking to confirm forwarding to this inbox, and what it says:
 * the code to type, the link to open (Gmail's only, on `mail-settings.google.com`), the address being
 * forwarded. Only a known provider's own sender counts (`CONFIRMATION_SENDERS`), and when the
 * receiving server said what it found, only one it found to be from that provider's domain (DMARC
 * pass, or a DKIM signature of it). Anything else is not a confirmation and is taken in as an
 * ordinary email. Nothing here opens a link or types a code: the owner does, in their provider.
 */
export function recogniseConfirmation(
  mail: {
    readonly from: string;
    readonly subject: string;
    readonly text: string;
  },
  /** The inbox's own addresses, which a confirmation names too (it is sent to them): never the forwarded one. */
  own: readonly string[] = [],
  auth?: ConfirmationAuth | undefined,
): Confirmation | null {
  const from = mail.from.trim().toLowerCase();
  const sender = confirmationSender(from);
  if (!sender) return null;
  if (auth && (auth.dkim !== undefined || auth.dmarc !== undefined)) {
    const signed = (auth.dkim ?? []).some((d) => sender.domains.some((s) => d === s || d.endsWith(`.${s}`)));
    if (auth.dmarc !== "pass" && !signed) return null;
  }
  const subject = mail.subject.trim();
  const text = mail.text.slice(0, 20_000);
  const google = sender.linkHost !== undefined;
  if (!google && !(FORWARD_WORDS.test(subject) && CONFIRM_WORDS.test(`${subject}\n${text.slice(0, 2_000)}`))) {
    return null;
  }
  const code =
    /\(#\s?(\d{6,12})\)/.exec(subject)?.[1] ??
    /(?:code|código|codice|Bestätigungscode|code de confirmation|verification code)\D{0,24}([0-9]{4,12}|[A-Z0-9]{6,10})\b/i.exec(
      text,
    )?.[1] ??
    null;
  let url: string | null = null;
  if (sender.linkHost) {
    for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
      try {
        const u = new URL(m[0]);
        if (u.protocol === "https:" && u.hostname.toLowerCase() === sender.linkHost && !u.username && !u.port) {
          url = u.toString();
          break;
        }
      } catch {
        // not a link
      }
    }
  }
  if (!code && !url) return null;
  const addresses =
    `${subject}\n${text.slice(0, 4_000)}`.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const mine = new Set(own.map((a) => baseAddress(a)).filter((a): a is string => a !== null));
  const senderDomain = splitAddress(from)?.domain ?? "";
  const forwarding =
    addresses
      .map((a) => a.toLowerCase())
      .find((a) => a !== from && !a.endsWith(`@${senderDomain}`) && !mine.has(baseAddress(a) ?? a)) ?? null;
  return { from, provider: sender.name, forwarding: forwarding ? baseAddress(forwarding) : null, code, url };
}

/**
 * Keeps a provider's confirmation on the forward it is for: the one it names, else the only forward
 * still to be proven. Only an address whose check never came back takes one, and one already shown
 * is never written over (the owner clears it by checking forwarding). One for an address not added
 * yet is held for a day and put on it when the owner adds it. Returns the forward it was kept on, or
 * `held`.
 */
export async function keepConfirmation(db: Db, c: Confirmation, now: number): Promise<Forward | "held" | null> {
  const waiting = (await listForwards(db)).filter((f) => f.checkSeenAt === null);
  const forward = c.forwarding
    ? waiting.find((f) => f.address === c.forwarding)
    : waiting.length === 1
      ? waiting[0]
      : undefined;
  if (!forward) {
    if (!c.forwarding) return null;
    const all = await listForwards(db);
    // A forward that was proven needs no confirmation: nothing to hold.
    if (all.some((f) => f.address === c.forwarding)) return null;
    await db.client.query({
      sql: `INSERT INTO email_confirmations_held (forwarding, from_address, code, url, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (forwarding) DO NOTHING`,
      params: [c.forwarding, c.from, c.code, c.url, now],
      method: "run",
    });
    return "held";
  }
  if (forward.confirmation) return forward;
  await putConfirmation(db, forward.id, { from: c.from, code: c.code, url: c.url, at: now });
  return forwardById(db, forward.id);
}

async function putConfirmation(
  db: Db,
  id: string,
  c: { from: string; code: string | null; url: string | null; at: number },
): Promise<void> {
  await db.client.query({
    sql: `UPDATE email_forwards SET state = CASE WHEN state = 'working' THEN state ELSE 'confirm' END, confirm_from = ?,
            confirm_code = ?, confirm_url = ?, confirm_at = ?, updated_at = ? WHERE id = ?`,
    params: [c.from, c.code, c.url, c.at, c.at, id],
    method: "run",
  });
}
