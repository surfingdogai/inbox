import { and, asc, desc, eq } from "drizzle-orm";
import { DEFAULT_WEEKLY, localiser, type Weekly, withinOpening } from "../capabilities/availability";
import { dateLocaliser, isClosed, readClosures } from "../capabilities/closures";
import type { Db } from "../db";
import type { Item, ItemType } from "../domain/types";
import { identityContext } from "../identity/context";
import {
  availabilityRules,
  itemEvents,
  items,
  parties,
  rules as rulesTable,
  services,
  threadEntries,
} from "../schema/tables";
import { readSettings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { setFlags } from "../write/flags";
import { withoutStatedPrices } from "../write/pricing";
import { recordRuleSkipped } from "../write/skipped";
import { bucketsFor, planClaims, readClaims } from "../write/slots";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { evaluate, type RuleContext, renderTemplate } from "./evaluate";
import { isNegative, readsFlags, readsReputation, skippedSentence } from "./reputation";
import { MAX_DEPTH, MAX_RULES_PER_EVENT, type Rule, ruleDefinitionSchema } from "./schema";

/**
 * Runs the rules that match one committed event. Called from the `rules` job so it never sits in
 * a request. Actions go through the same write path as everyone else, as actor `rule:<id>`,
 * with the causing event recorded and a depth cap so rules cannot chain forever.
 */
export interface RuleRunReport {
  readonly evaluated: number;
  readonly matched: string[];
  readonly actions: number;
  readonly errors: string[];
}

export async function runRulesForEvent(
  db: Db,
  input: { itemId: string; eventId: string; trigger: string; now?: number },
): Promise<RuleRunReport> {
  const now = input.now ?? Date.now();
  const report = { evaluated: 0, matched: [] as string[], actions: 0, errors: [] as string[] };
  const [row] = await db.orm.select().from(items).where(eq(items.id, input.itemId));
  if (!row) return report;
  const [eventRow] = await db.orm.select().from(itemEvents).where(eq(itemEvents.id, input.eventId));
  if (!eventRow) return report;
  if (eventRow.depth >= MAX_DEPTH) return { ...report, errors: ["depth limit reached"] };

  const { candidates, reputationRuleIds } = await loadRules(db, input.trigger);
  if (candidates.length === 0) return report;
  const item = rowToItem(row);
  const ctx = await buildRuleContext(db, item, eventRow, now);
  // Flags a reputation rule set (in an earlier run, or in this one) may not be turned into a
  // refusal by a rule that reads them: best-effort, but it closes the obvious chain (R25).
  let flagsFromReputation = await flagsSetBy(db, item.id, reputationRuleIds);
  // Likewise a state a reputation rule moved the item into: the rules that run on that transition
  // (or on one it caused in turn) may not refuse, cancel or expire because of it.
  const chainedFromReputation = await causedByReputation(db, eventRow, reputationRuleIds);
  const actor: Caller = {
    actor: { kind: "rule", id: "rule", channel: "system" },
    tier: "verified_principal",
    sandbox: item.flags.sandbox,
    now: () => now,
  };

  let current = item;
  for (const rule of candidates.slice(0, MAX_RULES_PER_EVENT)) {
    report.evaluated++;
    const runs = await countRuns(db, current.id, rule.id);
    if (runs >= rule.maxRunsPerItem) continue;
    let matched: boolean;
    try {
      matched = evaluate(rule.if, { ...ctx, item: forRules(current) });
    } catch (error) {
      report.errors.push(`${rule.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!matched) continue;
    report.matched.push(rule.id);
    const ruleActor: Caller = { ...actor, actor: { ...actor.actor, id: rule.id } };
    const causation = { id: eventRow.id, depth: eventRow.depth + 1 };
    let stop = rule.stop;
    const reputation = readsReputation(rule.if);
    const throughFlags = flagsFromReputation && readsFlags(rule.if);
    const guarded = reputation || throughFlags || chainedFromReputation;
    for (const action of rule.actions) {
      // Positive only (ADR-017 §8.3): saved rules cannot do this any more; one saved before can,
      // and its refusing action is skipped, with the reason where the owner reads the rule's run
      // and, in plain words, in the item's history, where the owner reads the item.
      if (guarded && isNegative(action)) {
        report.errors.push(
          `${rule.name}: positive_only: skipped ${action.action === "transition" ? action.event : action.action}, because the rule reads a customer's standing${reputation ? "" : throughFlags ? " (through flags a reputation rule set)" : " (through a change a reputation rule made)"}`,
        );
        try {
          await recordRuleSkipped(db, {
            itemId: current.id,
            ruleId: rule.id,
            reason: skippedSentence(rule.name, action, reputation ? "reads" : "follows"),
            causation,
            now,
          });
        } catch (error) {
          report.errors.push(
            `${rule.name}: the skipped action could not be noted on the item: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      try {
        switch (action.action) {
          case "transition": {
            const r = await transitionItem(db, ruleActor, {
              itemId: current.id,
              event: action.event,
              ...(action.input ? { input: action.input } : {}),
              reason: action.reason ?? rule.name,
              causation,
            });
            current = r.view.item;
            break;
          }
          case "set_flags": {
            const v = await setFlags(db, ruleActor, {
              itemId: current.id,
              flags: {
                ...(action.needsHuman !== undefined ? { needsHuman: action.needsHuman } : {}),
                ...(action.priority !== undefined ? { priority: action.priority } : {}),
              },
              reason: rule.name,
              causation,
            });
            current = v.item;
            if (reputation) flagsFromReputation = true;
            break;
          }
          case "reply":
            await appendThreadEntry(
              db,
              ruleActor,
              current,
              renderTemplate(action.template, { ...ctx, item: forRules(current) }),
              action.internal ? "note" : "out",
            );
            break;
          case "enqueue":
            await db.batch([
              jobStatement(action.job, { ...action.payload, itemId: current.id, ruleId: rule.id }, now, {
                runAt: now + (action.delayMin ?? 0) * 60_000,
              }),
            ]);
            break;
          case "stop":
            stop = true;
            break;
        }
        report.actions++;
      } catch (error) {
        // A refused write is information, not a failure of the engine.
        const message =
          error instanceof WriteError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
        report.errors.push(`${rule.name}: ${message}`);
        // The promise waits for a person to price it (ADR-018 §3.2): the rule asks one instead.
        if (error instanceof WriteError && error.details?.guard === "business_priced") {
          try {
            current = (
              await setFlags(db, ruleActor, {
                itemId: current.id,
                flags: { needsHuman: true },
                reason: `${rule.name}: a person prices this first, because the request holds a price that is not in your catalogue`,
                causation,
              })
            ).item;
          } catch (flagError) {
            report.errors.push(`${rule.name}: ${flagError instanceof Error ? flagError.message : String(flagError)}`);
          }
        }
        break;
      }
    }
    if (stop) break;
  }
  return report;
}

/**
 * Why a rule's refusing actions would be held back on this item now (ADR-017 §8.3), as the engine
 * decides it: the rule reads a customer's record (`reads`); or it reads flags a rule that did set,
 * or runs on a change such a rule made (`follows`); null when nothing holds it back. For "test
 * this rule", so the test says what the run would.
 */
export async function heldBack(
  db: Db,
  itemId: string,
  eventRow: typeof itemEvents.$inferSelect,
  condition: Rule["if"],
): Promise<"reads" | "follows" | null> {
  if (readsReputation(condition)) return "reads";
  const { reputationRuleIds } = await loadRules(db, "");
  if (readsFlags(condition) && (await flagsSetBy(db, itemId, reputationRuleIds))) return "follows";
  return (await causedByReputation(db, eventRow, reputationRuleIds)) ? "follows" : null;
}

async function loadRules(db: Db, trigger: string): Promise<{ candidates: Rule[]; reputationRuleIds: string[] }> {
  const rows = await db.orm
    .select()
    .from(rulesTable)
    .where(eq(rulesTable.enabled, 1))
    .orderBy(desc(rulesTable.priority), asc(rulesTable.id));
  const generic = trigger.startsWith("item.transitioned:") ? "item.transitioned" : null;
  const out: Rule[] = [];
  const reputationRuleIds: string[] = [];
  for (const r of rows) {
    const parsed = ruleDefinitionSchema.safeParse(r.definition);
    if (!parsed.success) continue;
    if (readsReputation(parsed.data.if)) reputationRuleIds.push(r.id);
    if (!parsed.data.on.includes(trigger) && !(generic && parsed.data.on.includes(generic))) continue;
    out.push({ ...parsed.data, id: r.id, name: r.name, priority: r.priority, enabled: r.enabled === 1 });
  }
  return { candidates: out, reputationRuleIds };
}

/** Whether this event, or one that caused it (at most `MAX_DEPTH` back), was fired by one of these rules. */
async function causedByReputation(
  db: Db,
  eventRow: typeof itemEvents.$inferSelect,
  ruleIds: readonly string[],
): Promise<boolean> {
  if (ruleIds.length === 0) return false;
  const ids = new Set(ruleIds);
  let e: typeof itemEvents.$inferSelect | undefined = eventRow;
  for (let i = 0; e && i <= MAX_DEPTH; i++) {
    if (e.actorKind === "rule" && ids.has(e.actorId)) return true;
    if (!e.causationId) return false;
    [e] = await db.orm.select().from(itemEvents).where(eq(itemEvents.id, e.causationId));
  }
  return false;
}

/** Whether one of these rules ever set the item's flags. */
async function flagsSetBy(db: Db, itemId: string, ruleIds: readonly string[]): Promise<boolean> {
  if (ruleIds.length === 0) return false;
  const ids = ruleIds.slice(0, 90);
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM item_events WHERE item_id = ? AND event = 'flags' AND actor_kind = 'rule'
            AND actor_id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`,
    params: [itemId, ...ids],
    method: "all",
  });
  return rows.length > 0;
}

async function countRuns(db: Db, itemId: string, ruleId: string): Promise<number> {
  const rows = await db.orm
    .select({ id: itemEvents.id })
    .from(itemEvents)
    .where(and(eq(itemEvents.itemId, itemId), eq(itemEvents.actorKind, "rule"), eq(itemEvents.actorId, ruleId)));
  return rows.length;
}

/** Everything a condition may read, fetched once and frozen; also what "test this rule" evaluates against. */
export async function buildRuleContext(
  db: Db,
  item: Item,
  eventRow: typeof itemEvents.$inferSelect,
  now: number,
): Promise<RuleContext> {
  const settings = await readSettings(db);
  const [party] = await db.orm.select({ kind: parties.kind }).from(parties).where(eq(parties.id, item.partyId));
  const meta = (eventRow.meta ?? {}) as { tier?: string; acts_as?: string };
  const thread = await db.orm
    .select({ body: threadEntries.bodyText })
    .from(threadEntries)
    .where(eq(threadEntries.itemId, item.id))
    .orderBy(threadEntries.createdAt)
    .limit(5);
  const text = [item.subject ?? "", ...payloadText(item), ...thread.map((t) => t.body)].join("\n");
  const facts = await bookingFacts(db, item, settings.business.timezone);
  const who = await identityContext(db, item, settings);
  return {
    item: forRules(item),
    event: {
      event: eventRow.event,
      from: eventRow.fromState,
      to: eventRow.toState,
      // Rules judge an actor the way the state machines do: the owner's AI and an integration key
      // act as the owner (`acts_as`), so a rule the owner wrote for their own decisions still fires
      // on the ones made for them. The history, the event stream and the webhooks say who it was.
      actorKind: typeof meta.acts_as === "string" ? meta.acts_as : eventRow.actorKind,
      tier: meta.tier,
      depth: eventRow.depth,
    },
    party: { kind: party?.kind ?? "unknown", tier: meta.tier ?? "anonymous" },
    person: who.person,
    customer: who.customer,
    agent: who.agent,
    settings: settings as unknown as Record<string, unknown>,
    now,
    text,
    facts,
  };
}

/**
 * The item a condition reads: the business's price is `totalPrice`, and the price the customer's
 * request stated is not there at all (ADR-018 §3.2), so no rule confirms or accepts on it.
 */
function forRules(item: Item): Record<string, unknown> {
  return withoutStatedPrices(item) as unknown as Record<string, unknown>;
}

function payloadText(item: Item): string[] {
  const p = item.payload as Record<string, unknown>;
  const keys: Record<ItemType, string[]> = {
    message: ["text"],
    quote_request: ["description"],
    booking: ["notes"],
    order: ["notes"],
    refund: ["reason"],
  };
  return keys[item.type].map((k) => (typeof p[k] === "string" ? (p[k] as string) : "")).filter(Boolean);
}

async function bookingFacts(db: Db, item: Item, timezone: string): Promise<RuleContext["facts"]> {
  if (item.type !== "booking") return { slotIsFree: null, withinBusinessHours: null };
  const [service] = await db.orm.select().from(services).where(eq(services.id, item.payload.reservationFor.serviceId));
  if (!service) return { slotIsFree: false, withinBusinessHours: false };
  const spec = {
    ...service,
    resourceKey: item.payload.resourceId ? `resource:${item.payload.resourceId}` : `service:${service.id}`,
  };
  let slotIsFree = false;
  try {
    const buckets = bucketsFor(spec, item.payload.startTime, item.payload.endTime);
    const taken = await readClaims(db, spec.resourceKey, buckets, item.id);
    slotIsFree = planClaims(spec, buckets, taken).ok;
  } catch {
    slotIsFree = false;
  }
  const rows = await db.orm.select().from(availabilityRules).where(eq(availabilityRules.kind, "open"));
  const weekly = (rows.find((r) => r.serviceId === service.id)?.weekly ??
    rows.find((r) => !r.serviceId)?.weekly ??
    DEFAULT_WEEKLY) as Weekly;
  const closures = await readClosures(db, service.id);
  const withinBusinessHours =
    withinOpening(localiser(timezone), weekly, Date.parse(item.payload.startTime), Date.parse(item.payload.endTime)) &&
    !isClosed(closures, dateLocaliser(timezone)(Date.parse(item.payload.startTime)));
  return { slotIsFree, withinBusinessHours };
}
