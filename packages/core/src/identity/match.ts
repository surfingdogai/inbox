import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Contact } from "../domain/types";
import { jobStatement } from "../write/common";
import { type ContactValue, contactStatements, contactValues, knownPartyFor, rootParty } from "./contacts";
import type { AgentSeen, Presentation } from "./types";

/**
 * Customers the business already knows (ADR-017 §8.2), decided in the create itself: which party
 * the item joins, how sure the inbox is, and what it writes about it — the contacts, the
 * presentations, the links, the agent — in the same batch as the item.
 *
 * | strong | a pass, key or delegated signature whose person is linked to a party here; an API key's
 *            party; authenticated email or a network-proven email for the known party   | joins it |
 * | weak   | the same email or phone as a party the business knows, nothing more           | a provisional
 *            party of its own, naming the known one as `possible_party_id`                            |
 * | none   | nothing matches                                                                | a new party |
 *
 * A weak match never sees the known party's items: impersonation is refused without refusing the
 * person. A one-time code (codes.ts) turns it strong.
 */
export type Match = "strong" | "weak" | "none";

/** What a door hands the write path about who is asking, beyond the caller. Never hashed, never stored as is. */
export interface IdentityInput {
  readonly agent?: AgentSeen | undefined;
  readonly presentations?: readonly Presentation[] | undefined;
  /** The mail gateway authenticated the sender (DKIM): the address is theirs. */
  readonly authenticatedEmail?: boolean | undefined;
  /**
   * Networks a first contact is about to be asked of (§2.1): their rows and retry jobs are written
   * with the item, so a request that dies mid-call still gets its key later.
   */
  readonly issueAt?: readonly string[] | undefined;
  /** How long the `rules` job waits, so a first contact's answers land before the rules read them. */
  readonly rulesDelayMs?: number | undefined;
}

export interface MatchPlan {
  /** The existing party the item joins; absent for a new (possibly provisional) party. */
  readonly joinPartyId?: string | undefined;
  readonly match: Match;
  readonly possiblePartyId?: string | undefined;
  readonly values: readonly ContactValue[];
}

export const IDENTITY_ISSUE_KIND = "identity_issue";
/** A first contact's retry waits this long, so the answer the request itself got is recorded first. */
export const ISSUE_RETRY_AFTER_MS = 60_000;

export const issueJobKey = (itemId: string, network: string, attempt = 0): string =>
  `${IDENTITY_ISSUE_KIND}:${itemId}:${network}${attempt ? `:${attempt}` : ""}`;

export async function planMatch(
  db: Db,
  input: {
    /** The party an API key names: joined as it always was. */
    readonly callerPartyId?: string | undefined;
    readonly contact?: Contact | undefined;
    readonly identity?: IdentityInput | undefined;
    /** Only a customer's own proof makes a match strong; a business-side creator gets hints at most. */
    readonly customer: boolean;
  },
): Promise<MatchPlan> {
  const values = contactValues(input.contact);
  if (input.callerPartyId) return { joinPartyId: input.callerPartyId, match: "strong", values };
  const presentations = input.identity?.presentations ?? [];

  if (input.customer) {
    // A person this business has met before, by the pairwise id their network gave it.
    for (const p of presentations) {
      const linked = await linkedParty(db, p.network, p.ppid);
      if (linked) return { joinPartyId: linked, match: "strong", values };
    }
  }
  const email = values.find((v) => v.kind === "email");
  const knownByEmail = email ? await knownPartyFor(db, email) : null;
  if (input.customer && knownByEmail) {
    const proven = presentations.some((p) => p.emailMatch === "proven");
    if (proven || input.identity?.authenticatedEmail === true) {
      return { joinPartyId: knownByEmail, match: "strong", values };
    }
  }
  let known = knownByEmail;
  if (!known) {
    const phone = values.find((v) => v.kind === "phone");
    known = phone ? await knownPartyFor(db, phone) : null;
  }
  if (known) return { match: "weak", possiblePartyId: known, values };
  return { match: "none", values };
}

/** The live party a network's person is linked to here, if any. */
export async function linkedParty(db: Db, network: string, ppid: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT party_id FROM person_links WHERE network = ? AND ppid = ?",
    params: [network, ppid],
    method: "all",
  });
  const id = rows[0]?.[0];
  if (id === undefined || id === null) return null;
  const root = await rootParty(db, String(id));
  const { rows: alive } = await db.client.query({
    sql: "SELECT 1 FROM parties WHERE id = ? AND erased_at IS NULL",
    params: [root],
    method: "all",
  });
  return alive.length ? root : null;
}

/**
 * A person's link to a party, and the standing it last had: the pass hash and standing are brought
 * up to date wherever the ppid is linked, and a ppid not linked anywhere yet is linked to `partyId`
 * (a party holds one person per network, a person one party).
 */
export function linkStatements(partyId: string, p: Presentation, now: number): Statement[] {
  return [
    {
      sql: `UPDATE person_links SET pass_hash = COALESCE(?, pass_hash), person = ?, updated_at = ?
             WHERE network = ? AND ppid = ?`,
      params: [p.passHash ?? null, JSON.stringify(p.person), now, p.network, p.ppid],
      method: "run",
    },
    {
      sql: `INSERT OR IGNORE INTO person_links (party_id, network, ppid, pass_hash, person, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [partyId, p.network, p.ppid, p.passHash ?? null, JSON.stringify(p.person), now, now],
      method: "run",
    },
  ];
}

/** The presentation a network made for this item's customer, named by the item's receipts as `per`. */
export function itemPresentationStatement(itemId: string, p: Presentation, now: number): Statement {
  return {
    sql: `INSERT OR IGNORE INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [itemId, p.network, p.presentationId, p.ppid, JSON.stringify(p.person), now],
    method: "run",
  };
}

/**
 * Everything the create batch writes about who is asking: the contacts (the email verified when
 * the mail was authenticated), the presentations and links, the signed agent, and a first
 * contact's pending rows and their retry jobs.
 */
export function identityStatements(
  itemId: string,
  partyId: string,
  plan: MatchPlan,
  identity: IdentityInput | undefined,
  now: number,
): Statement[] {
  const out: Statement[] = contactStatements(partyId, plan.values, now, {
    verifiedEmail: identity?.authenticatedEmail === true,
  });
  const seen = new Set<string>();
  for (const p of identity?.presentations ?? []) {
    if (seen.has(p.network)) continue;
    seen.add(p.network);
    out.push(itemPresentationStatement(itemId, p, now));
    // A person is linked to the party on a strong match, or to a new party that is theirs alone;
    // a weak match waits for a code (which links the item's people to the known party) (§8.2).
    if (plan.match !== "weak") out.push(...linkStatements(partyId, p, now));
  }
  const agent = identity?.agent;
  if (agent && agent.level !== "none" && agent.thumbprint) {
    out.push({
      sql: `INSERT INTO carrying_agents (thumbprint, level, platform, label, items, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT (thumbprint) DO UPDATE SET level = excluded.level, platform = excluded.platform,
              label = COALESCE(excluded.label, carrying_agents.label), items = carrying_agents.items + 1,
              last_seen_at = excluded.last_seen_at`,
      params: [agent.thumbprint, agent.level, agent.platform ?? null, agent.label ?? null, now, now],
      method: "run",
    });
  }
  for (const network of identity?.issueAt ?? []) {
    out.push({
      sql: `INSERT OR IGNORE INTO pending_identity (item_id, network, state, attempts, created_at, updated_at)
            VALUES (?, ?, 'asking', 0, ?, ?)`,
      params: [itemId, network, now, now],
      method: "run",
    });
    out.push(
      jobStatement(IDENTITY_ISSUE_KIND, { itemId, network }, now, {
        dedupeKey: issueJobKey(itemId, network),
        runAt: now + ISSUE_RETRY_AFTER_MS,
      }),
    );
  }
  return out;
}

/** The identity columns of an item, as the create writes them. */
export function identityColumns(
  plan: MatchPlan,
  identity: IdentityInput | undefined,
): {
  agentThumbprint: string | null;
  agentLevel: string | null;
  agentDirectory: string | null;
  customerMatch: Match;
  possiblePartyId: string | null;
} {
  const agent = identity?.agent;
  return {
    agentThumbprint: agent?.thumbprint ?? null,
    agentLevel: agent ? agent.level : null,
    agentDirectory: agent?.platform ?? null,
    customerMatch: plan.match,
    possiblePartyId: plan.possiblePartyId ?? null,
  };
}
