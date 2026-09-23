import type { Db } from "../db";
import { ulid } from "../ids";

/** The history event for a rule's action held back (ADR-017 §8.3). */
export const RULE_SKIPPED_EVENT = "rule_skipped";

/**
 * A rule's action held back by "positive only" (ADR-017 §8.3), written into the item's history so
 * the owner sees it on the item's timeline: an event that changes nothing but the version, its
 * plain-words reason in `reason`, by the rule. Once per rule and reason on an item, however often
 * the rule runs; the developer stream and webhooks leave it out (0009), as it happened to nobody.
 * Compare-and-set on the version, tried three times; losing every race only loses the note.
 */
export async function recordRuleSkipped(
  db: Db,
  input: {
    readonly itemId: string;
    readonly ruleId: string;
    readonly reason: string;
    readonly causation: { readonly id: string; readonly depth: number };
    readonly now: number;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows } = await db.client.query({
      sql: `SELECT i.state, i.version,
                   EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event = ? AND e.actor_kind = 'rule'
                            AND e.actor_id = ? AND e.reason = ?)
              FROM items i WHERE i.id = ?`,
      params: [RULE_SKIPPED_EVENT, input.ruleId, input.reason, input.itemId],
      method: "all",
    });
    const row = rows[0];
    if (!row || Number(row[2]) === 1) return false;
    const state = String(row[0]);
    const version = Number(row[1]);
    // Both halves only while the version is the one read: an item someone moved meanwhile is read again.
    const [inserted] = await db.batch([
      {
        sql: `INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, reason, diff, meta, causation_id, depth, created_at)
              SELECT ?, ?, ?, ?, ?, ?, 'rule', ?, ?, NULL, ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND version = ?)`,
        params: [
          ulid(input.now),
          input.itemId,
          version + 1,
          RULE_SKIPPED_EVENT,
          state,
          state,
          input.ruleId,
          input.reason,
          JSON.stringify({ channel: "system" }),
          input.causation.id,
          input.causation.depth,
          input.now,
          input.itemId,
          version,
        ],
        method: "run",
      },
      {
        sql: "UPDATE items SET version = version + 1 WHERE id = ? AND version = ?",
        params: [input.itemId, version],
        method: "run",
      },
    ]);
    if ((inserted?.changes ?? 0) > 0) return true;
  }
  return false;
}
