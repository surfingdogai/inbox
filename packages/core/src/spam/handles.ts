import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { SecretBox } from "../secrets/box";
import { SHARED_MAIL_PROVIDERS } from "./data";
import { emailDomain, foldAddress } from "./normalise";
import { sha256Hex } from "./prints";
import { dayOf, type Handle, type HandleKind } from "./types";

/**
 * Who asks, as handles this inbox keeps its own history on (ADR-029 §4.4): an agent's own key, a
 * network pass, a mailbox, a mail domain, the code a network carries a request under. Never a client's
 * network address: many people share one. Nor a platform's key (Web Bot Auth's `Signature-Agent`): a
 * platform signs every one of its users' requests with the same key, so it is only a flood bucket,
 * never a sender, whether a network recognises it (`vouched`) or not; one nobody recognises has the
 * lower ceiling, and copies sent under it still make waves, counted per request as unsigned ones are. A
 * stranger may start a few conversations a day under each handle; past that their next request waits
 * (`many_new`) and costs no AI check, and past a ceiling an agent is asked to come back later. Rotating
 * keys is caught by the mailbox, rotating mailboxes by the key or the domain, rotating both by the
 * words. A sender whom a person let in is no stranger; one who confirmed it's them gets wider budgets,
 * and is screened all the same.
 */

export interface Budget {
  /** New conversations a day before `many_new`; null where the handle never puts anything aside alone. */
  readonly day: number | null;
  /** New conversations a day before an agent door answers 429; null where none applies. */
  readonly ceiling: number | null;
}

export const BUDGETS: Readonly<Record<HandleKind | "vouched_platform", Budget>> = {
  agent_key: { day: 5, ceiling: 50 },
  // A platform's key speaks for all its users: different people, different words. Only a flood stops
  // it, sooner for a platform no network recognises.
  platform_key: { day: null, ceiling: 500 },
  vouched_platform: { day: null, ceiling: 1_500 },
  pass: { day: 10, ceiling: 50 },
  mailbox: { day: 5, ceiling: 30 },
  mail_domain: { day: 20, ceiling: 100 },
  carried_for: { day: 5, ceiling: null },
};

/** How much wider a sender's budgets are once they confirmed it's them (the confirm link). */
export const PROVEN_WIDEN = 3;

/** The handles that stand for one sender: what trust, proof and a party attach to. */
export const PERSONAL: ReadonlySet<HandleKind> = new Set(["agent_key", "pass", "mailbox"]);

const encoder = new TextEncoder();

/** A keyed hash of a mailbox, a domain or a link's account: the same here every time, meaningless anywhere else. */
export async function handleRef(secrets: SecretBox | null, kind: HandleKind | "link", value: string): Promise<string> {
  const text = `${kind}\0${value}`;
  if (!secrets) return `h:${(await sha256Hex(`surfingdog-inbox/spam-handle\0${text}`)).slice(0, 40)}`;
  const key = await secrets.mac("spam-handle");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text) as BufferSource));
  return `k:${Array.from(sig.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Where an address's or a domain's count is kept for mail no server vouched for: apart from the
 * signed-in mail of the same address, so forgeries under someone's address never spend their budget.
 */
const UNSIGNED = "unsigned\0";

/** The refs a mailbox's handles may be kept under: its own, and its unsigned mail's (erasure removes both). */
export async function mailboxRefs(secrets: SecretBox | null, address: string): Promise<string[]> {
  const folded = foldAddress(address);
  return [await handleRef(secrets, "mailbox", folded), await handleRef(secrets, "mailbox", `${UNSIGNED}${folded}`)];
}

export interface SenderHandles {
  /** Who the sender is: what trust, proof, marks and the lists read. */
  readonly handles: readonly Handle[];
  /** What a day's budgets are counted under: the same, with unsigned mail kept apart. */
  readonly counted: readonly Handle[];
  /** The handle repeats are counted by: the mailbox, else the agent's own key, else the pass; else none. */
  readonly first: Handle | null;
  /** Whether the key is a vouched platform's. */
  readonly vouched: boolean;
  /** Whether the key is a platform's, shared by all its users, rather than the agent's own. */
  readonly platform: boolean;
  /**
   * Whether the address it names is one nothing vouched for (mail no server authenticated, a form, an
   * assistant no pass proves it for): its counts are kept apart, never refuse anyone, and a person's
   * trust in that mailbox does not make the request theirs.
   */
  readonly unsigned: boolean;
}

/**
 * Whether an agent's key is a platform's (a `Signature-Agent` directory lists it, recognised by a
 * network or not), not the agent's own (`Sdi-Agent-Key`).
 */
export function isPlatformKey(agent: { readonly level?: string; readonly platform?: string | undefined } | undefined) {
  return agent?.level === "vouched" || (agent?.level === "self" && Boolean(agent.platform));
}

/** The handles of one request, as the door and the caller give them. */
export async function handlesOf(
  secrets: SecretBox | null,
  input: {
    readonly email?: string | undefined;
    /**
     * Whether something vouched for the address: an email's sender authenticated (DMARC, or a DKIM
     * signature of its own domain), or a pass that proved it. Undefined where it is not asked (a stored
     * item's handles, for what a person teaches).
     */
    readonly authenticated?: boolean | undefined;
    readonly agent?:
      | { readonly level: string; readonly thumbprint?: string | undefined; readonly platform?: string | undefined }
      | undefined;
    readonly passes?: readonly { readonly network: string; readonly ppid: string }[] | undefined;
    readonly carriedFor?: string | undefined;
  },
): Promise<SenderHandles> {
  const handles: Handle[] = [];
  const counted: Handle[] = [];
  const unsigned = input.authenticated === false;
  let mailbox: Handle | null = null;
  if (input.email) {
    const address = foldAddress(input.email);
    mailbox = { kind: "mailbox", ref: await handleRef(secrets, "mailbox", address) };
    handles.push(mailbox);
    counted.push(
      unsigned ? { kind: "mailbox", ref: await handleRef(secrets, "mailbox", `${UNSIGNED}${address}`) } : mailbox,
    );
    const domain = emailDomain(address);
    if (domain && !SHARED_MAIL_PROVIDERS.has(domain)) {
      const own: Handle = { kind: "mail_domain", ref: await handleRef(secrets, "mail_domain", domain) };
      handles.push(own);
      counted.push(
        unsigned ? { kind: "mail_domain", ref: await handleRef(secrets, "mail_domain", `${UNSIGNED}${domain}`) } : own,
      );
    }
  }
  const platform = isPlatformKey(input.agent);
  let key: Handle | null = null;
  if (input.agent && input.agent.level !== "none" && input.agent.thumbprint) {
    const h: Handle = { kind: platform ? "platform_key" : "agent_key", ref: input.agent.thumbprint };
    if (!platform) key = h;
    handles.push(h);
    counted.push(h);
  }
  let pass: Handle | null = null;
  for (const p of (input.passes ?? []).slice(0, 4)) {
    const h: Handle = { kind: "pass", ref: `${p.network} ${p.ppid}`.slice(0, 300) };
    pass ??= h;
    handles.push(h);
    counted.push(h);
  }
  if (input.carriedFor && /^[A-Za-z0-9_-]{4,128}$/.test(input.carriedFor)) {
    const h: Handle = { kind: "carried_for", ref: input.carriedFor };
    handles.push(h);
    counted.push(h);
  }
  return {
    handles,
    counted,
    first: mailbox ?? key ?? pass,
    vouched: input.agent?.level === "vouched",
    platform,
    unsigned: unsigned && mailbox !== null,
  };
}

/** What this inbox knows of a sender's handles. */
export interface HandleStanding {
  /** A handle a person trusted (Let it in, Not spam, Looks fine) with no spam mark since. */
  readonly trusted: boolean;
  /** A handle the sender proved (the confirm link), never marked as spam: their budgets are wider. */
  readonly proven: boolean;
  /** Per handle, the new conversations it started today. */
  readonly today: ReadonlyMap<string, number>;
}

const keyOf = (h: Handle) => `${h.kind} ${h.ref}`;

export async function standingOf(db: Db, sender: SenderHandles, now: number): Promise<HandleStanding> {
  const today = new Map<string, number>();
  let trusted = false;
  let proven = false;
  const all = [...new Map([...sender.handles, ...sender.counted].map((h) => [keyOf(h), h])).values()];
  if (all.length === 0) return { trusted, proven, today };
  const { rows } = await db.client.query({
    sql: `SELECT kind, ref, day, firsts, proven_at, trusted_at, marked_at FROM spam_handles
           WHERE ${all.map(() => "(kind = ? AND ref = ?)").join(" OR ")}`,
    params: all.flatMap((h) => [h.kind, h.ref]),
    method: "all",
  });
  const day = dayOf(now);
  const who = new Set(sender.handles.map(keyOf));
  for (const r of rows) {
    const k = `${String(r[0])} ${String(r[1])}`;
    today.set(k, r[2] === day ? Number(r[3] ?? 0) : 0);
    // Only the handles a sender cannot share with strangers speak for them: a mailbox, a key, a pass.
    if (!who.has(k) || !PERSONAL.has(String(r[0]) as HandleKind)) continue;
    const marked = Number(r[6] ?? 0);
    // A person's trust holds until a spam mark after it, and a mailbox's only where something vouched
    // for the address; a sender's own proof, only while nothing they sent was ever marked as spam: a
    // pitcher's real mailbox proves nothing about the next pitch.
    if (Number(r[5] ?? 0) > marked && !(sender.unsigned && r[0] === "mailbox")) trusted = true;
    if (Number(r[4] ?? 0) > 0 && marked === 0) proven = true;
  }
  return { trusted, proven, today };
}

export interface BudgetCheck {
  /** Over a day's budget: the request waits (`many_new`), with how many it is today. */
  readonly over: { readonly kind: HandleKind; readonly count: number } | null;
  /** Over a ceiling: an agent door answers 429. */
  readonly ceiling: boolean;
}

/**
 * The budgets a stranger's new conversation is held to, with what lifts them: a network pass presented
 * twice the mailbox's and the domain's, a sender who confirmed it's them three times every one. A
 * platform's key only ever has a ceiling. Lifts only widen.
 */
export function checkBudgets(
  s: SenderHandles,
  standing: HandleStanding,
  lifts: { readonly pass: boolean },
): BudgetCheck {
  let over: BudgetCheck["over"] = null;
  let ceiling = false;
  for (const h of s.counted) {
    const base = h.kind === "platform_key" && s.vouched ? BUDGETS.vouched_platform : BUDGETS[h.kind];
    const widen =
      (lifts.pass && (h.kind === "mailbox" || h.kind === "mail_domain") ? 2 : 1) * (standing.proven ? PROVEN_WIDEN : 1);
    const count = (standing.today.get(keyOf(h)) ?? 0) + 1;
    // What anyone can run up by typing an address refuses nobody: it only ever makes a request wait.
    const forgeable = s.unsigned && (h.kind === "mailbox" || h.kind === "mail_domain");
    if (base.ceiling !== null && !forgeable && count > base.ceiling * widen) ceiling = true;
    if (base.day !== null && count > base.day * widen && (over === null || count > over.count))
      over = { kind: h.kind, count };
  }
  return { over, ceiling };
}

/**
 * One more new conversation under each handle today, in the item's batch. The party is written on the
 * handles that stand for one sender, so erasing them erases these too.
 */
export function countFirstStatements(
  handles: readonly Handle[],
  now: number,
  partyId: string | null = null,
): Statement[] {
  const day = dayOf(now);
  return handles.map((h) => {
    const party = PERSONAL.has(h.kind) ? partyId : null;
    return {
      sql: `INSERT INTO spam_handles (kind, ref, day, firsts, party_id, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT (kind, ref) DO UPDATE SET
              firsts = CASE WHEN spam_handles.day = excluded.day THEN spam_handles.firsts + 1 ELSE 1 END,
              day = excluded.day, party_id = COALESCE(excluded.party_id, spam_handles.party_id),
              last_seen_at = excluded.last_seen_at`,
      params: [h.kind, h.ref, day, party, now],
      method: "run" as const,
    };
  });
}

/** A person trusted these handles (Not spam, Let it in), or the sender proved them (Confirm it's me). */
export function trustHandleStatements(
  handles: readonly Handle[],
  how: "trusted" | "proven",
  now: number,
  partyId: string | null,
): Statement[] {
  const column = how === "trusted" ? "trusted_at" : "proven_at";
  return handles
    .filter((h) => PERSONAL.has(h.kind))
    .map((h) => ({
      sql: `INSERT INTO spam_handles (kind, ref, day, firsts, ${column}, party_id, last_seen_at) VALUES (?, ?, NULL, 0, ?, ?, ?)
            ON CONFLICT (kind, ref) DO UPDATE SET ${column} = excluded.${column},
              party_id = COALESCE(excluded.party_id, spam_handles.party_id), last_seen_at = excluded.last_seen_at`,
      params: [h.kind, h.ref, now, partyId, now],
      method: "run" as const,
    }));
}

/** A person marked something these handles sent as spam: a trust given before no longer holds. */
export function markHandleStatements(handles: readonly Handle[], now: number): Statement[] {
  return handles
    .filter((h) => PERSONAL.has(h.kind))
    .map((h) => ({
      sql: `INSERT INTO spam_handles (kind, ref, day, firsts, marked_at, last_seen_at) VALUES (?, ?, NULL, 0, ?, ?)
            ON CONFLICT (kind, ref) DO UPDATE SET marked_at = excluded.marked_at`,
      params: [h.kind, h.ref, now, now],
      method: "run" as const,
    }));
}

/** Handles nobody vouched for and nobody has seen for a month: what a day's count needs is long gone. */
export const HANDLE_KEEP_MS = 30 * 86_400_000;
/** A spam mark is remembered half a year, as a marked print is. */
export const HANDLE_MARK_KEEP_MS = 180 * 86_400_000;

export function pruneHandlesStatement(now: number): Statement {
  return {
    sql: `DELETE FROM spam_handles WHERE proven_at IS NULL AND trusted_at IS NULL
            AND (marked_at IS NULL OR marked_at < ?) AND last_seen_at < ?`,
    params: [now - HANDLE_MARK_KEEP_MS, now - HANDLE_KEEP_MS],
    method: "run",
  };
}

/** The handles a stored item was screened under, from its row: its contact and its agent. */
export async function itemHandles(db: Db, secrets: SecretBox | null, itemId: string): Promise<SenderHandles> {
  const { rows } = await db.client.query({
    sql: `SELECT i.agent_thumbprint, i.agent_level, i.agent_directory,
                 (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1)
            FROM items i WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return { handles: [], counted: [], first: null, vouched: false, platform: false, unsigned: false };
  const thumbprint = r[0] === null || r[0] === undefined ? undefined : String(r[0]);
  const level = r[1] === null || r[1] === undefined ? "none" : String(r[1]);
  const platform = r[2] === null || r[2] === undefined || r[2] === "" ? undefined : String(r[2]);
  const email = r[3] === null || r[3] === undefined ? undefined : String(r[3]);
  return handlesOf(secrets, {
    email,
    agent: thumbprint ? { level, thumbprint, ...(platform ? { platform } : {}) } : undefined,
  });
}
