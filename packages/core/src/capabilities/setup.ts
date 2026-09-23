import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db";
import { ulid } from "../ids";
import { describeAction, summarizeRule } from "../rules/describe";
import { buildRuleContext, heldBack } from "../rules/engine";
import { evaluate } from "../rules/evaluate";
import { PRESETS } from "../rules/presets";
import { isNegative, positiveOnlyProblem, skippedSentence } from "../rules/reputation";
import { type RuleDefinition, ruleDefinitionSchema } from "../rules/schema";
import {
  availabilityRules,
  business,
  itemEvents,
  items,
  products,
  rules as rulesTable,
  services,
} from "../schema/tables";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { fromZod, WriteError } from "../write/errors";
import { RULE_SKIPPED_EVENT } from "../write/skipped";
import { rowToItem } from "../write/views";
import { DEFAULT_WEEKLY, type Weekly } from "./availability";
import { type Closure, readClosures } from "./closures";
import type * as S from "./setup-types";

/**
 * The owner's setup: who the business is, what it offers, when it is open and what it lets
 * agents do on their own. This is the part a bike shop cannot build for itself; the inbox
 * makes it a few screens (and a few MCP tools, so the owner's own AI can do it too).
 */
export interface Profile {
  readonly name: string;
  readonly domain: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: readonly string[];
}

export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly version: number;
  readonly definition: RuleDefinition;
  readonly summary: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Availability {
  readonly timezone: string;
  readonly weekly: Weekly;
  readonly overrides: readonly { service_id: string; weekly: Weekly }[];
  readonly closures: readonly Closure[];
}

export const PRESET_NAMES: Record<S.ApplyPresetInput["preset"], string> = {
  appointments: "Appointments",
  trades: "Trades & quotes",
  shop: "Shop",
};

type ServiceRow = typeof services.$inferSelect;
type ProductRow = typeof products.$inferSelect;

export class SetupCapabilities {
  constructor(private readonly db: Db) {}

  // ---- profile ----------------------------------------------------------------

  async getProfile(caller: Caller): Promise<Profile> {
    requireOwner(caller);
    return this.profile();
  }

  async updateProfile(caller: Caller, input: S.ProfileInput): Promise<Profile> {
    requireOwner(caller);
    if (input.timezone !== undefined && !validTimezone(input.timezone)) {
      throw new WriteError("invalid_input", `unknown time zone ${input.timezone}`, {
        fields: [{ path: "timezone", problem: "invalid", message: "use an IANA name like Europe/Lisbon" }],
      });
    }
    const now = nowOf(caller);
    const current = await this.profile();
    const next = {
      name: input.name ?? current.name,
      domain: input.domain === undefined ? current.domain : input.domain,
      timezone: input.timezone ?? current.timezone,
      currency: (input.currency ?? current.currency).toUpperCase(),
      languages: input.languages ?? [...current.languages],
    };
    await this.db.client.query({
      sql: `INSERT INTO business (id, name, domain, timezone, currency, languages, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain, timezone = excluded.timezone, currency = excluded.currency, languages = excluded.languages, updated_at = excluded.updated_at`,
      params: [next.name, next.domain, next.timezone, next.currency, JSON.stringify(next.languages), now, now],
      method: "run",
    });
    return next;
  }

  private async profile(): Promise<Profile> {
    const [row] = await this.db.orm.select().from(business).limit(1);
    const s = await readSettings(this.db);
    return {
      name: row?.name || s.business.name,
      domain: row?.domain ?? null,
      timezone: row?.timezone ?? s.business.timezone,
      currency: row?.currency ?? s.business.currency,
      languages: row?.languages?.length ? row.languages : s.business.languages,
    };
  }

  // ---- services ---------------------------------------------------------------

  async listServices(caller: Caller): Promise<ServiceRow[]> {
    requireOwner(caller);
    return this.db.orm.select().from(services).orderBy(desc(services.active), asc(services.sort), asc(services.name));
  }

  async createService(caller: Caller, input: S.ServiceInput): Promise<ServiceRow> {
    requireOwner(caller);
    const now = nowOf(caller);
    const id = ulid();
    await this.db.orm.insert(services).values({
      id,
      name: input.name,
      description: input.description ?? null,
      durationMin: input.duration_min,
      bufferBeforeMin: input.buffer_before_min,
      bufferAfterMin: input.buffer_after_min,
      capacity: input.capacity,
      granularityMin: input.granularity_min,
      price: (input.price ?? null) as ServiceRow["price"],
      active: input.active ? 1 : 0,
      sort: input.sort,
      createdAt: now,
      updatedAt: now,
    });
    return this.service(id);
  }

  async updateService(caller: Caller, input: S.UpdateServiceInput): Promise<ServiceRow> {
    requireOwner(caller);
    const { service_id, ...patch } = input;
    await this.patchRow(
      "services",
      service_id,
      {
        name: patch.name,
        description: patch.description,
        duration_min: patch.duration_min,
        buffer_before_min: patch.buffer_before_min,
        buffer_after_min: patch.buffer_after_min,
        capacity: patch.capacity,
        granularity_min: patch.granularity_min,
        price: patch.price === undefined ? undefined : JSON.stringify(patch.price),
        active: patch.active === undefined ? undefined : patch.active ? 1 : 0,
        sort: patch.sort,
      },
      nowOf(caller),
      "service_id",
    );
    return this.service(service_id);
  }

  async archiveService(caller: Caller, input: { service_id: string }): Promise<ServiceRow> {
    return this.updateService(caller, { service_id: input.service_id, active: false });
  }

  private async service(id: string): Promise<ServiceRow> {
    const [row] = await this.db.orm.select().from(services).where(eq(services.id, id));
    if (!row) throw unknown("service_id", "unknown service");
    return row;
  }

  // ---- products ---------------------------------------------------------------

  async listProducts(caller: Caller): Promise<ProductRow[]> {
    requireOwner(caller);
    return this.db.orm.select().from(products).orderBy(desc(products.active), asc(products.name));
  }

  async createProduct(caller: Caller, input: S.ProductInput): Promise<ProductRow> {
    requireOwner(caller);
    const now = nowOf(caller);
    const id = ulid();
    try {
      await this.db.orm.insert(products).values({
        id,
        sku: input.sku ?? null,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        stock: input.stock ?? null,
        active: input.active ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      throw skuTaken(error);
    }
    return this.product(id);
  }

  async updateProduct(caller: Caller, input: S.UpdateProductInput): Promise<ProductRow> {
    requireOwner(caller);
    const { product_id, ...patch } = input;
    try {
      await this.patchRow(
        "products",
        product_id,
        {
          sku: patch.sku,
          name: patch.name,
          description: patch.description,
          price: patch.price === undefined ? undefined : JSON.stringify(patch.price),
          stock: patch.stock,
          active: patch.active === undefined ? undefined : patch.active ? 1 : 0,
        },
        nowOf(caller),
        "product_id",
      );
    } catch (error) {
      throw skuTaken(error);
    }
    return this.product(product_id);
  }

  async archiveProduct(caller: Caller, input: { product_id: string }): Promise<ProductRow> {
    return this.updateProduct(caller, { product_id: input.product_id, active: false });
  }

  private async product(id: string): Promise<ProductRow> {
    const [row] = await this.db.orm.select().from(products).where(eq(products.id, id));
    if (!row) throw unknown("product_id", "unknown product");
    return row;
  }

  // ---- availability -------------------------------------------------------------

  async getAvailability(caller: Caller): Promise<Availability> {
    requireOwner(caller);
    return this.availability();
  }

  async setWeekly(caller: Caller, input: S.SetWeeklyInput): Promise<Availability> {
    requireOwner(caller);
    if (input.service_id) await this.service(input.service_id);
    const now = nowOf(caller);
    const scope = input.service_id ? "service_id = ?" : "service_id IS NULL";
    const scopeParams = input.service_id ? [input.service_id] : [];
    await this.db.batch([
      { sql: `DELETE FROM availability_rules WHERE kind = 'open' AND ${scope}`, params: scopeParams, method: "run" },
      {
        sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, ?, 'open', ?, ?)",
        params: [ulid(), input.service_id ?? null, JSON.stringify(input.weekly), now],
        method: "run",
      },
    ]);
    return this.availability();
  }

  /** Removes a service's own hours so it follows the business hours again. */
  async clearWeeklyOverride(caller: Caller, input: { service_id: string }): Promise<Availability> {
    requireOwner(caller);
    await this.db.client.query({
      sql: "DELETE FROM availability_rules WHERE kind = 'open' AND service_id = ?",
      params: [input.service_id],
      method: "run",
    });
    return this.availability();
  }

  async setClosures(caller: Caller, input: S.SetClosuresInput): Promise<Availability> {
    requireOwner(caller);
    const now = nowOf(caller);
    await this.db.batch([
      { sql: "DELETE FROM availability_rules WHERE kind = 'closed' AND service_id IS NULL", method: "run" },
      ...input.closures.map((c) => ({
        sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'closed', ?, ?)",
        params: [ulid(), JSON.stringify(c), now],
        method: "run" as const,
      })),
    ]);
    return this.availability();
  }

  private async availability(): Promise<Availability> {
    const profile = await this.profile();
    const open = await this.db.orm.select().from(availabilityRules).where(eq(availabilityRules.kind, "open"));
    const base = open.find((r) => !r.serviceId);
    return {
      timezone: profile.timezone,
      weekly: (base?.weekly as Weekly | null) ?? DEFAULT_WEEKLY,
      overrides: open
        .filter((r) => r.serviceId)
        .map((r) => ({ service_id: r.serviceId as string, weekly: r.weekly as Weekly })),
      closures: await readClosures(this.db),
    };
  }

  // ---- rules ------------------------------------------------------------------

  async listRules(caller: Caller): Promise<RuleView[]> {
    requireOwner(caller);
    const rows = await this.db.orm
      .select()
      .from(rulesTable)
      .orderBy(desc(rulesTable.priority), asc(rulesTable.createdAt), asc(rulesTable.id));
    return rows.map(ruleView);
  }

  async createRule(caller: Caller, input: S.RuleInput): Promise<RuleView> {
    requireOwner(caller);
    requirePositive(input.definition);
    const now = nowOf(caller);
    const id = ulid();
    await this.db.orm.insert(rulesTable).values({
      id,
      name: input.name,
      priority: input.priority,
      enabled: input.enabled ? 1 : 0,
      definition: input.definition,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return this.rule(id);
  }

  async updateRule(caller: Caller, input: S.UpdateRuleInput): Promise<RuleView> {
    requireOwner(caller);
    const { rule_id, expected_version, ...patch } = input;
    if (patch.definition) requirePositive(patch.definition);
    const now = nowOf(caller);
    const sets: string[] = ["version = version + 1", "updated_at = ?"];
    const params: (string | number | null)[] = [now];
    const cols: Record<string, unknown> = {
      name: patch.name,
      priority: patch.priority,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      definition: patch.definition === undefined ? undefined : JSON.stringify(patch.definition),
    };
    for (const [col, value] of Object.entries(cols)) {
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(value as string | number | null);
    }
    params.push(rule_id);
    let sql = `UPDATE rules SET ${sets.join(", ")} WHERE id = ?`;
    if (expected_version !== undefined) {
      sql += " AND version = ?";
      params.push(expected_version);
    }
    const res = await this.db.client.query({ sql, params, method: "run" });
    if (res.changes !== 1) {
      const current = await this.rule(rule_id);
      throw new WriteError("version_conflict", "the rule changed since you read it", {
        details: { currentVersion: current.version },
      });
    }
    return this.rule(rule_id);
  }

  async deleteRule(caller: Caller, input: { rule_id: string }): Promise<{ deleted: true }> {
    requireOwner(caller);
    const res = await this.db.client.query({
      sql: "DELETE FROM rules WHERE id = ?",
      params: [input.rule_id],
      method: "run",
    });
    if (res.changes !== 1) throw unknown("rule_id", "unknown rule");
    return { deleted: true };
  }

  listPresets(caller: Caller): {
    key: S.ApplyPresetInput["preset"];
    name: string;
    rules: { name: string; priority: number; summary: string; definition: RuleDefinition }[];
  }[] {
    requireOwner(caller);
    return (Object.keys(PRESET_NAMES) as S.ApplyPresetInput["preset"][]).map((key) => ({
      key,
      name: PRESET_NAMES[key],
      rules: (PRESETS[key] ?? []).map((r) => ({
        name: r.name,
        priority: r.priority,
        summary: summarizeRule(r.definition),
        definition: r.definition,
      })),
    }));
  }

  async applyPreset(caller: Caller, input: S.ApplyPresetInput): Promise<RuleView[]> {
    requireOwner(caller);
    const now = nowOf(caller);
    const preset = PRESETS[input.preset] ?? [];
    await this.db.batch([
      ...(input.replace ? [{ sql: "DELETE FROM rules", method: "run" as const }] : []),
      ...preset.map((r) => ({
        sql: "INSERT INTO rules (id, name, priority, enabled, definition, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)",
        params: [ulid(), r.name, r.priority, JSON.stringify(r.definition), now, now],
        method: "run" as const,
      })),
    ]);
    return this.listRules(caller);
  }

  /** Evaluates a rule's conditions against a real item without changing anything. */
  async testRule(
    caller: Caller,
    input: S.TestRuleInput,
  ): Promise<{
    matched: boolean;
    summary: string;
    would: string[];
    item: { id: string; type: string; state: string };
    facts: Record<string, unknown>;
    who: Record<string, unknown>;
    positive_only?: string;
    /** The actions a run would hold back on this item (ADR-017 §8.3), in plain words. */
    skipped?: string[];
  }> {
    requireOwner(caller);
    const parsed = ruleDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) throw fromZod(parsed.error, "definition");
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw unknown("item_id", "unknown item");
    // The item's last event a rule could run on: a note that a rule was held back is not one.
    const [eventRow] = await this.db.orm
      .select()
      .from(itemEvents)
      .where(and(eq(itemEvents.itemId, row.id), ne(itemEvents.event, RULE_SKIPPED_EVENT)))
      .orderBy(desc(itemEvents.seq))
      .limit(1);
    if (!eventRow) throw unknown("item_id", "item has no events");
    const item = rowToItem(row);
    const ctx = await buildRuleContext(this.db, item, eventRow, nowOf(caller));
    const matched = evaluate(parsed.data.if, ctx);
    const positive = positiveOnlyProblem(parsed.data);
    // What a run would hold back here, as the engine decides it, and so what it would really do.
    const held = matched ? await heldBack(this.db, item.id, eventRow, parsed.data.if) : null;
    const skippedActions = held ? parsed.data.actions.filter(isNegative) : [];
    return {
      matched,
      summary: summarizeRule(parsed.data),
      would: matched ? parsed.data.actions.filter((a) => !skippedActions.includes(a)).map(describeAction) : [],
      ...(skippedActions.length && held
        ? { skipped: skippedActions.map((a) => skippedSentence(input.name, a, held)) }
        : {}),
      item: { id: item.id, type: item.type, state: item.state },
      facts: ctx.facts as unknown as Record<string, unknown>,
      // What the reputation conditions read (ADR-017 §8.3), from local rows only.
      who: { person: ctx.person, customer: ctx.customer, agent: ctx.agent, tier: ctx.party.tier },
      ...(positive ? { positive_only: positive } : {}),
    };
  }

  private async rule(id: string): Promise<RuleView> {
    const [row] = await this.db.orm.select().from(rulesTable).where(eq(rulesTable.id, id));
    if (!row) throw unknown("rule_id", "unknown rule");
    return ruleView(row);
  }

  // ---- helpers ----------------------------------------------------------------

  private async patchRow(
    table: "services" | "products",
    id: string,
    cols: Record<string, unknown>,
    now: number,
    field: string,
  ): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];
    for (const [col, value] of Object.entries(cols)) {
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(value as string | number | null);
    }
    params.push(id);
    const res = await this.db.client.query({
      sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`,
      params,
      method: "run",
    });
    if (res.changes !== 1) throw unknown(field, `unknown ${table.slice(0, -1)}`);
  }
}

function ruleView(row: typeof rulesTable.$inferSelect): RuleView {
  const parsed = ruleDefinitionSchema.safeParse(row.definition);
  const definition = parsed.success ? parsed.data : (row.definition as RuleDefinition);
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled === 1,
    version: row.version,
    definition,
    summary: parsed.success ? summarizeRule(parsed.data) : "This rule does not parse; edit it.",
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

/** ADR-017 §8.3: a rule that reads a customer's standing may only speed things up or ask a person. */
function requirePositive(definition: RuleDefinition): void {
  const problem = positiveOnlyProblem(definition);
  if (problem) {
    throw new WriteError("positive_only", problem, {
      fields: [{ path: "definition.actions", problem: "invalid", message: problem }],
    });
  }
}

function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "setup needs an owner or staff principal");
}

function unknown(path: string, message: string): WriteError {
  return new WriteError("invalid_input", message, { fields: [{ path, problem: "invalid", message }] });
}

function skuTaken(error: unknown): unknown {
  let e = error as { code?: string; cause?: unknown };
  for (let i = 0; i < 3 && e && e.code !== "unique" && e.cause; i++) e = e.cause as { code?: string; cause?: unknown };
  if (e?.code === "unique") {
    return new WriteError("invalid_input", "that SKU is already used", {
      fields: [{ path: "sku", problem: "invalid", message: "already used by another product" }],
    });
  }
  return error;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
