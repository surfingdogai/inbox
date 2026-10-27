import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { SecretBox } from "../secrets/box";
import { hasEventListeners, jobStatement, WEBHOOK_FANOUT_KIND } from "../write/common";
import { itemHandles, markHandleStatements, trustHandleStatements } from "./handles";
import { addToListStatements } from "./lists";
import { countStatement } from "./meter";
import { emailDomain, foldAddress } from "./normalise";
import { markPrintStatement } from "./prints";

/**
 * Letting something in, and what a person teaches by it (ADR-029 §3.1, §8). A release runs each
 * effect the screening held back once — the rules, the webhooks, and the owner's alert when it was the
 * sender who confirmed — with dedupe keys of their own, so a second release, or a release racing
 * another, runs nothing twice. Only a person at the business teaches: what the owner's AI, a rule or
 * a key does moves items, and changes no list.
 */

/** The id of an item's create event: what its deferred effects were, and are, keyed by. */
export async function createEventOf(db: Db, itemId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT id FROM item_events WHERE item_id = ? AND event = 'create' ORDER BY seq LIMIT 1",
    params: [itemId],
    method: "all",
  });
  const id = rows[0]?.[0];
  return id === undefined || id === null ? null : String(id);
}

/** The effects of a create, run now because it was let in. The owner's alert only when someone else let it in. */
export async function releasedEffects(
  db: Db,
  input: {
    readonly itemId: string;
    readonly type: string;
    readonly eventId: string;
    readonly alertOwner: boolean;
    readonly now: number;
  },
): Promise<Statement[]> {
  const { itemId, eventId, now } = input;
  const out: Statement[] = [];
  if (input.alertOwner) {
    out.push(
      jobStatement("notify", { to: "owner", itemId, event: "create", eventId }, now, {
        dedupeKey: `notify:${eventId}:owner:released`,
      }),
    );
  }
  out.push(
    jobStatement("rules", { itemId, eventId, trigger: "item.created" }, now, {
      dedupeKey: `rules:${eventId}:released`,
    }),
  );
  if (await hasEventListeners(db)) {
    out.push(
      jobStatement(WEBHOOK_FANOUT_KIND, { eventId, eventType: `${input.type}.create`, itemId }, now, {
        dedupeKey: `fanout:${eventId}:released`,
      }),
    );
  }
  return out;
}

/** The screen moved from what it was to `released`, compare-and-set: only one release wins. */
export function releaseScreenStatement(itemId: string, from: readonly string[], now: number): Statement {
  return {
    sql: `UPDATE items SET screen = 'released', screen_at = ? WHERE id = ? AND screen IN (${from.map(() => "?").join(", ")})`,
    params: [now, itemId, ...from],
    method: "run",
  };
}

export type OwnerVerdict = "not_spam" | "let_in" | "looks_fine" | "spam";

/**
 * What a person teaches with Not spam, Let it in or Looks fine: the sender on Let through (their
 * address, or their app's key), the print kept, their handles trusted. With Spam: the print marked
 * and the handles' trust gone; never a list on its own (the owner chooses "Always put aside").
 */
export async function teachStatements(
  db: Db,
  secrets: SecretBox | null,
  input: {
    readonly itemId: string;
    readonly verdict: OwnerVerdict;
    readonly byUser: string;
    readonly releasedBy: "owner" | "staff" | null;
    readonly now: number;
  },
): Promise<Statement[]> {
  const { itemId, now } = input;
  const { rows } = await db.client.query({
    sql: `SELECT i.party_id, i.agent_thumbprint,
                 (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1)
            FROM items i WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return [];
  const partyId = String(r[0]);
  const thumbprint = r[1] === null || r[1] === undefined ? null : String(r[1]);
  const email = r[2] === null || r[2] === undefined ? null : String(r[2]);
  const handles = (await itemHandles(db, secrets, itemId)).handles;
  const out: Statement[] = [
    {
      sql: `INSERT INTO spam_verdicts (item_id, door, verdict, cause, certain, score, signals, ai, learning, owner_verdict, owner_at, released_by, created_at)
            VALUES (?, 'owner', 'deliver', NULL, 0, 0, '[]', 'none', 0, ?, ?, ?, ?)
            ON CONFLICT (item_id) DO UPDATE SET owner_verdict = excluded.owner_verdict, owner_at = excluded.owner_at,
              released_by = COALESCE(excluded.released_by, spam_verdicts.released_by)`,
      params: [itemId, input.verdict, now, input.releasedBy, now],
      method: "run",
    },
  ];
  if (input.verdict === "spam") {
    out.push(markPrintStatement(itemId, 1), ...markHandleStatements(handles, now), countStatement("marked", now));
    return out;
  }
  out.push(markPrintStatement(itemId, -1), ...trustHandleStatements(handles, "trusted", now, partyId));
  if (email) {
    out.push(
      ...addToListStatements({
        list: "allow",
        kind: "address",
        value: foldAddress(email),
        partyId,
        itemId,
        byUser: input.byUser,
        now,
      }),
    );
  } else if (thumbprint) {
    out.push(
      ...addToListStatements({
        list: "allow",
        kind: "agent_key",
        value: thumbprint,
        partyId,
        itemId,
        byUser: input.byUser,
        now,
      }),
    );
  }
  return out;
}

/** What the owner may add to Always put aside from an item: its address, else its app's key. */
export async function blockChoiceOf(
  db: Db,
  itemId: string,
): Promise<{ kind: "address" | "agent_key"; value: string } | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.agent_thumbprint,
                 (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1)
            FROM items i WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  if (r[1] !== null && r[1] !== undefined) return { kind: "address", value: foldAddress(String(r[1])) };
  if (r[0] !== null && r[0] !== undefined) return { kind: "agent_key", value: String(r[0]) };
  return null;
}

/** "Let everyone at {domain} through": offered for a company's domain, never a provider many share. */
export function domainOf(address: string): string | null {
  return emailDomain(address);
}
