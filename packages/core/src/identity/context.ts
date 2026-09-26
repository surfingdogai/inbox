import type { Db } from "../db";
import { secretHash } from "../protocol/credentials";
import {
  type AgentContext,
  type CustomerContext,
  NO_AGENT_CONTEXT,
  type PersonContext,
  type Tier,
  tierRank,
} from "../rules/evaluate";
import type { Settings } from "../settings/schema";
import { rootParty } from "./contacts";
import { type CustomerHistory, customerHistory, EMPTY_HISTORY } from "./history";
import { itemStopped } from "./stops";

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
  const [cols, presented, history, stopped] = await Promise.all([
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
    itemStopped(db, item.id),
  ]);
  const row = cols.rows[0] ?? [];
  // A customer who asked us not to use booking networks has no standing here: what a network said of
  // them is not read, so a rule treats them as it treats anyone no network knows — never worse.
  const person = personContextOf(
    stopped ? [] : presented.rows.map((r) => ({ network: String(r[0]), person: parseJson(r[1]) })),
    settings,
  );
  const match = (["strong", "weak", "none"].includes(String(row[0])) ? String(row[0]) : "none") as
    | "strong"
    | "weak"
    | "none";
  const level = (["vouched", "self"].includes(String(row[1])) ? String(row[1]) : "none") as AgentContext["level"];
  return {
    person,
    customer: customerContextOf(match, history),
    // A platform is something a rule may lean on only when a network recognises it (`vouched`).
    agent:
      level === "none" ? NO_AGENT_CONTEXT : { level, platform: level === "vouched" && row[2] ? String(row[2]) : null },
  };
}

/**
 * The person as the networks switched on now presented them: the best tier and score across them,
 * each network's own, and the limit a trusted person earns. Pure: the rules and the owner's rewards
 * read the same shape, from the item's presentations or from what a request is presenting now.
 */
export function personContextOf(
  presented: readonly { readonly network: string; readonly person: unknown }[],
  settings: Settings,
): PersonContext {
  const networks: PersonContext["networks"][number][] = [];
  for (const p of presented) {
    if (!settings.networks[p.network]?.enabled) continue;
    const person = (p.person ?? null) as {
      tier?: unknown;
      score?: unknown;
      kept?: unknown;
      broken?: unknown;
    } | null;
    networks.push({
      network: p.network,
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
  return {
    present: networks.length > 0,
    tier: best,
    score,
    networks,
    limit_minor: best === "trusted" ? TRUSTED_PERSON_LIMIT_MINOR : 0,
  };
}

/** The business's own history with the customer, as the rules and the owner's rewards read it. */
export function customerContextOf(match: "strong" | "weak" | "none", history: CustomerHistory): CustomerContext {
  return {
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

/**
 * The customer's standing as this inbox knows it without asking anyone (ADR-018 §4, Q3): the party an
 * API key names, else the one a pass they carry was last seen with here; that party's own history
 * with the business, and the standing the networks switched on last gave it (none for a customer who
 * stopped them). What a first visit with a pass never seen here would learn from a network counts from
 * the next one. Read before a request is priced, so the summary a customer confirms and the request as
 * written hold the same price, and no network is asked anything for a request that is not confirmed.
 */
export async function localStanding(
  db: Db,
  settings: Settings,
  who: { readonly partyId?: string | undefined; readonly credentials: readonly string[] },
): Promise<{ person: PersonContext; customer: CustomerContext }> {
  let party = who.partyId ?? null;
  if (!party) {
    const passes = who.credentials.filter((c) => c.startsWith("sdpass1_")).slice(0, 8);
    if (passes.length) {
      const hashes = await Promise.all(passes.map((p) => secretHash(p)));
      const { rows } = await db.client.query({
        sql: `SELECT l.party_id FROM person_links l JOIN parties p ON p.id = l.party_id
               WHERE l.pass_hash IN (${hashes.map(() => "?").join(", ")}) AND p.erased_at IS NULL
               ORDER BY l.party_id LIMIT 1`,
        params: hashes,
        method: "all",
      });
      const id = rows[0]?.[0];
      party = typeof id === "string" ? await rootParty(db, id) : null;
    }
  }
  if (!party) return { person: personContextOf([], settings), customer: customerContextOf("none", EMPTY_HISTORY) };
  const [history, links, stopped] = await Promise.all([
    customerHistory(db, party),
    db.client.query({
      sql: "SELECT network, person FROM person_links WHERE party_id = ? AND person IS NOT NULL ORDER BY network",
      params: [party],
      method: "all",
    }),
    db.client.query({ sql: "SELECT networks_off_at FROM parties WHERE id = ?", params: [party], method: "all" }),
  ]);
  const off = stopped.rows[0]?.[0] !== null && stopped.rows[0]?.[0] !== undefined;
  return {
    person: personContextOf(
      off ? [] : links.rows.map((r) => ({ network: String(r[0]), person: parseJson(r[1]) })),
      settings,
    ),
    customer: customerContextOf("strong", history),
  };
}
