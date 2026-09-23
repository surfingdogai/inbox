import type { Db } from "../db";
import {
  type AgentContext,
  type CustomerContext,
  NO_AGENT_CONTEXT,
  type PersonContext,
  type Tier,
  tierRank,
} from "../rules/evaluate";
import type { Settings } from "../settings/schema";
import { customerHistory } from "./history";

/**
 * What the rules may read about who is asking (ADR-017 §8.3), from local rows only: the item's
 * presentations at the networks switched on now, the business's own history with the customer,
 * and how the agent signed. Rules never call a network.
 */
export const TRUSTED_PERSON_LIMIT_MINOR = 40_000;

export async function identityContext(
  db: Db,
  item: { readonly id: string; readonly partyId: string },
  settings: Settings,
): Promise<{ person: PersonContext; customer: CustomerContext; agent: AgentContext }> {
  const [cols, presented, history] = await Promise.all([
    db.client.query({
      sql: "SELECT customer_match, agent_level, agent_directory FROM items WHERE id = ?",
      params: [item.id],
      method: "all",
    }),
    db.client.query({
      sql: "SELECT network, person FROM item_presentations WHERE item_id = ? ORDER BY network",
      params: [item.id],
      method: "all",
    }),
    customerHistory(db, item.partyId, item.id),
  ]);
  const row = cols.rows[0] ?? [];
  const networks: PersonContext["networks"][number][] = [];
  for (const r of presented.rows) {
    const network = String(r[0]);
    if (!settings.networks[network]?.enabled) continue;
    const person = parseJson(r[1]) as {
      tier?: unknown;
      score?: unknown;
      kept?: unknown;
      broken?: unknown;
    } | null;
    networks.push({
      network,
      tier: (["new", "building", "trusted"].includes(String(person?.tier)) ? String(person?.tier) : "new") as Tier,
      score: typeof person?.score === "number" ? person.score : 0,
      kept: typeof person?.kept === "number" ? person.kept : 0,
      broken: typeof person?.broken === "number" ? person.broken : 0,
    });
  }
  let best: Tier = "new";
  let score = 0;
  for (const n of networks) {
    if (tierRank(n.tier) > tierRank(best)) best = n.tier;
    score = Math.max(score, n.score);
  }
  const match = (["strong", "weak", "none"].includes(String(row[0])) ? String(row[0]) : "none") as
    | "strong"
    | "weak"
    | "none";
  const level = (["vouched", "self"].includes(String(row[1])) ? String(row[1]) : "none") as AgentContext["level"];
  return {
    person: {
      present: networks.length > 0,
      tier: best,
      score,
      networks,
      limit_minor: best === "trusted" ? TRUSTED_PERSON_LIMIT_MINOR : 0,
    },
    customer: {
      match,
      known: match === "strong" && history.items > 0,
      completed: history.completed,
      paid: history.paid,
      no_shows: history.no_shows,
      late_cancellations: history.late_cancellations,
      payment_failed: history.payment_failed,
      charged_back: history.charged_back,
      largest_paid: history.largest_paid,
      limit_minor: 2 * history.largest_paid,
      first_seen: history.first_seen,
      open_bookings: history.open_bookings,
    },
    // A platform is something a rule may lean on only when a network recognises it (`vouched`).
    agent:
      level === "none" ? NO_AGENT_CONTEXT : { level, platform: level === "vouched" && row[2] ? String(row[2]) : null },
  };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
