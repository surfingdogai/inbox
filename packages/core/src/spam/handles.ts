import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { SecretBox } from "../secrets/box";
import { SHARED_MAIL_PROVIDERS } from "./data";
import { emailDomain, foldAddress } from "./normalise";
import { sha256Hex } from "./prints";
import { dayOf, type Handle, type HandleKind } from "./types";

/**
 * Who asks, as handles this inbox keeps its own history on (ADR-029 §4.4): an agent's key, a network
 * pass, a mailbox, a mail domain, the code a network carries a request under. Never a client's network
 * address: many people share one. A stranger may start a few conversations a day under each handle;
 * past that their next request waits (`many_new`) and costs no AI check, and past a ceiling an agent is
 * asked to come back later. Rotating keys is caught by the mailbox, rotating mailboxes by the key or the
 * domain, rotating both by the words. A sender who confirmed, or whom a person let in, is no stranger.
 */

export interface Budget {
  /** New conversations a day before `many_new`. */
  readonly day: number;
  /** New conversations a day before an agent door answers 429; null where none applies. */
  readonly ceiling: number | null;
}

export const BUDGETS: Readonly<Record<HandleKind | "vouched_key", Budget>> = {
  agent_key: { day: 5, ceiling: 50 },
  vouched_key: { day: 15, ceiling: 150 },
  pass: { day: 10, ceiling: 50 },
  mailbox: { day: 5, ceiling: 30 },
  mail_domain: { day: 20, ceiling: 100 },
  carried_for: { day: 5, ceiling: null },
};

const encoder = new TextEncoder();

/** A keyed hash of a mailbox or a domain: the same here every time, meaningless anywhere else. */
export async function handleRef(secrets: SecretBox | null, kind: HandleKind, value: string): Promise<string> {
  const text = `${kind}\0${value}`;
  if (!secrets) return `h:${(await sha256Hex(`surfingdog-inbox/spam-handle\0${text}`)).slice(0, 40)}`;
  const key = await secrets.mac("spam-handle");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text) as BufferSource));
  return `k:${Array.from(sig.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface SenderHandles {
  readonly handles: readonly Handle[];
  /** The handle repeats are counted by: the mailbox, else the key, else the pass. */
  readonly first: Handle | null;
  /** Whether the key is a vouched platform's. */
  readonly vouched: boolean;
}

/** The handles of one request, as the door and the caller give them. */
export async function handlesOf(
  secrets: SecretBox | null,
  input: {
    readonly email?: string | undefined;
    readonly agent?:
      | { readonly level: string; readonly thumbprint?: string | undefined; readonly platform?: string | undefined }
      | undefined;
    readonly passes?: readonly { readonly network: string; readonly ppid: string }[] | undefined;
    readonly carriedFor?: string | undefined;
  },
): Promise<SenderHandles> {
  const handles: Handle[] = [];
  let mailbox: Handle | null = null;
  if (input.email) {
    const address = foldAddress(input.email);
    mailbox = { kind: "mailbox", ref: await handleRef(secrets, "mailbox", address) };
    handles.push(mailbox);
    const domain = emailDomain(address);
    if (domain && !SHARED_MAIL_PROVIDERS.has(domain)) {
      handles.push({ kind: "mail_domain", ref: await handleRef(secrets, "mail_domain", domain) });
    }
  }
  let key: Handle | null = null;
  if (input.agent && input.agent.level !== "none" && input.agent.thumbprint) {
    key = { kind: "agent_key", ref: input.agent.thumbprint };
    handles.push(key);
  }
  let pass: Handle | null = null;
  for (const p of (input.passes ?? []).slice(0, 4)) {
    const h: Handle = { kind: "pass", ref: `${p.network} ${p.ppid}`.slice(0, 300) };
    pass ??= h;
    handles.push(h);
  }
  if (input.carriedFor && /^[A-Za-z0-9_-]{4,128}$/.test(input.carriedFor)) {
    handles.push({ kind: "carried_for", ref: input.carriedFor });
  }
  return { handles, first: mailbox ?? key ?? pass, vouched: input.agent?.level === "vouched" };
}

/** What this inbox knows of a sender's handles. */
export interface HandleStanding {
  /** A handle the sender proved (the confirm link) or a person trusted, with no spam mark since. */
  readonly trusted: boolean;
  /** Per handle, the new conversations it started today. */
  readonly today: ReadonlyMap<string, number>;
}

const keyOf = (h: Handle) => `${h.kind} ${h.ref}`;

export async function standingOf(db: Db, handles: readonly Handle[], now: number): Promise<HandleStanding> {
  const today = new Map<string, number>();
  let trusted = false;
  if (handles.length === 0) return { trusted, today };
  const { rows } = await db.client.query({
    sql: `SELECT kind, ref, day, firsts, proven_at, trusted_at, marked_at FROM spam_handles
           WHERE ${handles.map(() => "(kind = ? AND ref = ?)").join(" OR ")}`,
    params: handles.flatMap((h) => [h.kind, h.ref]),
    method: "all",
  });
  const day = dayOf(now);
  for (const r of rows) {
    const k = `${String(r[0])} ${String(r[1])}`;
    today.set(k, r[2] === day ? Number(r[3] ?? 0) : 0);
    const good = Math.max(Number(r[4] ?? 0), Number(r[5] ?? 0));
    const marked = Number(r[6] ?? 0);
    // Only the handles a sender cannot share with strangers trust them: a mailbox, a key, a pass.
    if (good > 0 && good > marked && String(r[0]) !== "mail_domain" && String(r[0]) !== "carried_for") trusted = true;
  }
  return { trusted, today };
}

export interface BudgetCheck {
  /** Over a day's budget: the request waits (`many_new`), with how many it is today. */
  readonly over: { readonly kind: HandleKind; readonly count: number } | null;
  /** Over a ceiling: an agent door answers 429. */
  readonly ceiling: boolean;
}

/**
 * The budgets a stranger's new conversation is held to, with what lifts them: a vouched platform's
 * key three times the self-held one's, a network pass presented twice the mailbox's and the domain's.
 * Lifts only widen.
 */
export function checkBudgets(
  s: SenderHandles,
  standing: HandleStanding,
  lifts: { readonly pass: boolean },
): BudgetCheck {
  let over: BudgetCheck["over"] = null;
  let ceiling = false;
  for (const h of s.handles) {
    const base = h.kind === "agent_key" && s.vouched ? BUDGETS.vouched_key : BUDGETS[h.kind];
    const widen = lifts.pass && (h.kind === "mailbox" || h.kind === "mail_domain") ? 2 : 1;
    const count = (standing.today.get(keyOf(h)) ?? 0) + 1;
    if (base.ceiling !== null && count > base.ceiling * widen) ceiling = true;
    if (count > base.day * widen && (over === null || count > over.count)) over = { kind: h.kind, count };
  }
  return { over, ceiling };
}

/** One more new conversation under each handle today, in the item's batch. */
export function countFirstStatements(handles: readonly Handle[], now: number): Statement[] {
  const day = dayOf(now);
  return handles.map((h) => ({
    sql: `INSERT INTO spam_handles (kind, ref, day, firsts, last_seen_at) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (kind, ref) DO UPDATE SET
            firsts = CASE WHEN spam_handles.day = excluded.day THEN spam_handles.firsts + 1 ELSE 1 END,
            day = excluded.day, last_seen_at = excluded.last_seen_at`,
    params: [h.kind, h.ref, day, now],
    method: "run" as const,
  }));
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
    .filter((h) => h.kind !== "mail_domain" && h.kind !== "carried_for")
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
  return handles.map((h) => ({
    sql: "UPDATE spam_handles SET marked_at = ? WHERE kind = ? AND ref = ?",
    params: [now, h.kind, h.ref],
    method: "run" as const,
  }));
}

/** The handles a stored item was screened under, from its row: its contact and its agent. */
export async function itemHandles(db: Db, secrets: SecretBox | null, itemId: string): Promise<SenderHandles> {
  const { rows } = await db.client.query({
    sql: `SELECT i.agent_thumbprint, i.agent_level,
                 (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1)
            FROM items i WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return { handles: [], first: null, vouched: false };
  const thumbprint = r[0] === null || r[0] === undefined ? undefined : String(r[0]);
  const level = r[1] === null || r[1] === undefined ? "none" : String(r[1]);
  const email = r[2] === null || r[2] === undefined ? undefined : String(r[2]);
  return handlesOf(secrets, { email, agent: thumbprint ? { level, thumbprint } : undefined });
}
