import { normaliseGtin } from "@surfingdog/spec";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { assertNoLeak, PUBLISHED, stringsIn } from "../access/leaks";
import { isOwnerOrSystem } from "../access/outbound";
import { NEXT_CATALOGUE_SEQ, storedLink } from "../catalogue/identity";
import { businessFacts } from "../customer/audience";
import { customerLang } from "../customer/lang";
import type { Db } from "../db";
import type { Item, ItemType } from "../domain/types";
import { ulid } from "../ids";
import { amountsIn, discountIn, speltAmountIn } from "../negotiation/amounts";
import { allFloors, type FloorView, floorStatement } from "../negotiation/catalogue";
import { describeAction, summarizeRule } from "../rules/describe";
import { buildRuleContext, heldBack } from "../rules/engine";
import { evaluate } from "../rules/evaluate";
import { PRESET_NAMES, PRESETS, type PresetConfirm, presetFor } from "../rules/presets/index";
import { geoTermsProblem, isNegative, positiveOnlyProblem, skippedSentence } from "../rules/reputation";
import { type Action, type RuleDefinition, ruleDefinitionSchema } from "../rules/schema";
import {
  availabilityRules,
  business,
  itemEvents,
  items,
  products,
  rules as rulesTable,
  services,
} from "../schema/tables";
import { type HostHome, type HostPolicy, SET_BY_HOST } from "../settings/policy";
import { readSettings } from "../settings/schema";
import { canonicalLanguages } from "../util/locale";
import { type Caller, holdsMoney, isCustomer, isOwnerAssistant, isPerson, nowOf } from "../write/caller";
import { fromZod, WriteError } from "../write/errors";
import { heldForPrice, heldForStock, type StockLine } from "../write/pricing";
import { RULE_SKIPPED_EVENT } from "../write/skipped";
import { rowToItem } from "../write/views";
import { NO_HOURS, type Weekly } from "./availability";
import { type Closure, readClosures } from "./closures";
import { offeredItemTypes } from "./directory";
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
  /** Whether the host holds the domain (`HostPolicy.profileDomain`): nobody changes it here, the owner included. */
  readonly domain_held: boolean;
  /**
   * Where the business joined from, when a host set the inbox up (`HostPolicy.home`): its own domain,
   * whether the site links to the inbox yet, and where the owner connects the two. Absent otherwise.
   */
  readonly home?: { readonly domain: string; readonly linked: boolean; readonly connect_url: string | null };
  /**
   * What agents can do here now: the item types the manifest lists (`offeredItemTypes`), for the
   * owner to see while the public doors are still closed (an inbox not yet connected answers no agent).
   */
  readonly item_types: readonly ItemType[];
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
  /**
   * The business's weekly hours: none (`{}`, `weekly_set` false) until the owner saves some. Nothing
   * is offered, published or booked in hours nobody set.
   */
  readonly weekly: Weekly;
  readonly weekly_set: boolean;
  readonly overrides: readonly { service_id: string; weekly: Weekly }[];
  readonly closures: readonly Closure[];
}

export { PRESET_NAMES };

type ServiceRow = typeof services.$inferSelect;
type ProductRow = typeof products.$inferSelect;

export class SetupCapabilities {
  constructor(
    private readonly db: Db,
    /** The host's policy, as it is attached now (`settings/policy.ts`): it may hold the profile's domain. */
    private readonly policy: () => HostPolicy | null = () => null,
  ) {}

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
    // The domain the profile names is published as the business's: where a host holds it, nobody
    // names another here, the owner included. Sending it back as it is changes nothing.
    const held = this.policy()?.profileDomain;
    if (held !== undefined && input.domain !== undefined && (input.domain?.toLowerCase() ?? null) !== held) {
      throw new WriteError(
        "not_allowed",
        `domain is ${SET_BY_HOST}: nobody can change it here, the owner included. Nothing was changed.`,
        {
          details: { reason: "set_by_host" },
          fields: [{ path: "domain", problem: "invalid", message: SET_BY_HOST }],
        },
      );
    }
    const now = nowOf(caller);
    const current = await this.profile();
    // Every price without a currency of its own is in this one: changing it is changing money.
    if (
      isOwnerAssistant(caller) &&
      input.currency !== undefined &&
      input.currency.toUpperCase() !== current.currency.toUpperCase()
    ) {
      throw ownerMoney("currency", "The currency is money, and money is the owner's: leave it as it is.");
    }
    // The name signs every email and heads the public profile: every customer reads it.
    await this.published(caller, [input.name, input.domain]);
    const next = {
      name: input.name ?? current.name,
      domain: input.domain === undefined ? current.domain : input.domain,
      timezone: input.timezone ?? current.timezone,
      currency: (input.currency ?? current.currency).toUpperCase(),
      // Canonical and once each (`pt-br` is pt-BR): the schema has checked each is a language tag.
      languages: input.languages
        ? (canonicalLanguages(input.languages) ?? [...input.languages])
        : [...current.languages],
      domain_held: current.domain_held,
      ...(current.home ? { home: current.home } : {}),
      item_types: current.item_types,
    };
    await this.db.client.query({
      sql: `INSERT INTO business (id, name, domain, timezone, currency, languages, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain, timezone = excluded.timezone, currency = excluded.currency, languages = excluded.languages, updated_at = excluded.updated_at`,
      params: [next.name, next.domain, next.timezone, next.currency, JSON.stringify(next.languages), now, now],
      method: "run",
    });
    return next;
  }

  /**
   * Writes the domain a host's policy holds over the profile, when it names another; true when it
   * wrote. Only the domain: a profile never saved keeps reading its name and languages from the
   * settings, and is given the time zone and currency it reads now.
   */
  async holdDomain(domain: string | null, now: number): Promise<boolean> {
    const current = await this.profile();
    if ((current.domain?.toLowerCase() ?? null) === domain) return false;
    await this.db.client.query({
      sql: `INSERT INTO business (id, name, domain, timezone, currency, languages, created_at, updated_at) VALUES ('self', '', ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, updated_at = excluded.updated_at`,
      params: [domain, current.timezone, current.currency, now, now],
      method: "run",
    });
    return true;
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
      domain_held: this.policy()?.profileDomain !== undefined,
      ...home(this.policy()?.home),
      item_types: await offeredItemTypes(
        this.db,
        s.doorsElsewhere.map((d) => d.itemType),
        s.doors,
      ),
    };
  }

  /**
   * Words from the owner's AI that every customer can read — the catalogue, the business's name, a
   * rule's reply — carry no customer's email address or phone number and no secret (`access/leaks.ts`):
   * a customer's message could have asked the AI to publish them.
   */
  private async published(caller: Caller, texts: readonly (string | null | undefined)[]): Promise<void> {
    await assertNoLeak(
      this.db,
      caller,
      PUBLISHED,
      texts.filter((t): t is string => typeof t === "string"),
    );
  }

  // ---- services ---------------------------------------------------------------

  async listServices(caller: Caller): Promise<ServiceRow[]> {
    requireOwner(caller);
    return this.db.orm.select().from(services).orderBy(desc(services.active), asc(services.sort), asc(services.name));
  }

  /**
   * A new service. One the owner's AI adds with an amount is saved unpublished, whatever it asked:
   * the owner checks the price and publishes it (the founder, 23 September 2026, "time yes, money no").
   */
  async createService(caller: Caller, input: S.ServiceInput): Promise<ServiceRow> {
    requireOwner(caller);
    await this.published(caller, [input.name, input.description]);
    const now = nowOf(caller);
    const id = ulid();
    const held = isOwnerAssistant(caller) && hasAmount(input.price);
    if (input.withdrawal !== undefined && input.withdrawal !== "standard" && !isPerson(caller))
      throw withdrawalOwners();
    if (input.negotiable === false && !isPerson(caller)) throw negotiableOwners();
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
      active: input.active && !held ? 1 : 0,
      sort: input.sort,
      ...(input.withdrawal ? { withdrawal: input.withdrawal } : {}),
      ...(input.negotiable === false ? { negotiable: 0 } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return this.service(id);
  }

  async updateService(caller: Caller, input: S.UpdateServiceInput): Promise<ServiceRow> {
    requireOwner(caller);
    const { service_id, ...patch } = input;
    await this.published(caller, [patch.name, patch.description]);
    if (patch.withdrawal !== undefined && !isPerson(caller)) {
      if ((await this.service(service_id)).withdrawal !== patch.withdrawal) throw withdrawalOwners();
    }
    if (patch.negotiable !== undefined && !isPerson(caller)) {
      if ((await this.service(service_id)).negotiable !== (patch.negotiable ? 1 : 0)) throw negotiableOwners();
    }
    if (isOwnerAssistant(caller) && (patch.price !== undefined || patch.active === true)) {
      const stored = await this.service(service_id);
      const currency = (await this.profile()).currency;
      if (
        patch.price !== undefined &&
        servicePriceKey(patch.price, currency) !== servicePriceKey(stored.price, currency)
      ) {
        throw ownerMoney("price", "Prices are the owner's to set. Leave the price as it is.");
      }
      if (patch.active === true && stored.active === 0 && hasAmount(stored.price)) {
        throw ownerMoney("active", "Publishing something with a price is the owner's to do, in the app.");
      }
    }
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
        // null takes the price off (priced on request); left out, it stays as it is.
        price: patch.price === undefined ? undefined : patch.price === null ? null : JSON.stringify(patch.price),
        active: patch.active === undefined ? undefined : patch.active ? 1 : 0,
        sort: patch.sort,
        withdrawal: patch.withdrawal,
        negotiable: patch.negotiable === undefined ? undefined : patch.negotiable ? 1 : 0,
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

  /** A new product. One the owner's AI adds is saved unpublished: a product always has a price. */
  async createProduct(caller: Caller, input: S.ProductInput): Promise<ProductRow> {
    requireOwner(caller);
    await this.published(caller, [input.sku, input.name, input.description, input.brand, input.mpn]);
    const now = nowOf(caller);
    const id = ulid();
    const held = isOwnerAssistant(caller);
    if (input.withdrawal !== undefined && input.withdrawal !== "standard" && !isPerson(caller))
      throw withdrawalOwners();
    if (input.negotiable === false && !isPerson(caller)) throw negotiableOwners();
    if ((input.listed === false || input.no_gtin === true) && !isPerson(caller)) {
      throw listingOwners(input.listed === false ? "listed" : "no_gtin");
    }
    const ident = productIdentity(caller, input, null);
    try {
      await this.db.orm.insert(products).values({
        id,
        sku: input.sku ?? null,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        stock: input.stock ?? null,
        active: input.active && !held ? 1 : 0,
        ...(input.withdrawal ? { withdrawal: input.withdrawal } : {}),
        ...(input.negotiable === false ? { negotiable: 0 } : {}),
        ...identityRow(ident),
        // Who makes it and its condition, as `updateProduct` writes them: the feed and every door name them.
        ...(input.brand ? { brand: input.brand } : {}),
        ...(input.condition ? { condition: input.condition } : {}),
        ...(input.no_gtin === true ? { noGtin: 1 } : {}),
        ...(input.listed === false ? { listed: 0 } : {}),
        catalogueSeq: sql.raw(NEXT_CATALOGUE_SEQ),
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
    await this.published(caller, [patch.sku, patch.name, patch.description, patch.brand, patch.mpn]);
    let ident: Partial<IdentityPatch> = {};
    if (
      patch.listed !== undefined ||
      patch.no_gtin !== undefined ||
      patch.gtin !== undefined ||
      patch.mpn !== undefined ||
      patch.url !== undefined ||
      patch.image_url !== undefined
    ) {
      const stored = await this.product(product_id);
      for (const [key, was] of [
        ["listed", stored.listed],
        ["no_gtin", stored.noGtin],
      ] as const) {
        const want = patch[key];
        if (want !== undefined && (want ? 1 : 0) !== was && !isPerson(caller)) throw listingOwners(key);
      }
      ident = productIdentity(caller, patch, stored);
    }
    if (patch.withdrawal !== undefined && !isPerson(caller)) {
      if ((await this.product(product_id)).withdrawal !== patch.withdrawal) throw withdrawalOwners();
    }
    if (patch.negotiable !== undefined && !isPerson(caller)) {
      if ((await this.product(product_id)).negotiable !== (patch.negotiable ? 1 : 0)) throw negotiableOwners();
    }
    if (isOwnerAssistant(caller) && (patch.price !== undefined || patch.active === true)) {
      const stored = await this.product(product_id);
      const same =
        patch.price === undefined ||
        (patch.price.value === stored.price.value &&
          patch.price.currency.toUpperCase() === stored.price.currency.toUpperCase());
      if (!same) throw ownerMoney("price", "Prices are the owner's to set. Leave the price as it is.");
      if (patch.active === true && stored.active === 0) {
        throw ownerMoney("active", "Publishing something with a price is the owner's to do, in the app.");
      }
    }
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
          withdrawal: patch.withdrawal,
          negotiable: patch.negotiable === undefined ? undefined : patch.negotiable ? 1 : 0,
          gtin: ident.gtin,
          gtin_given: ident.gtinGiven,
          brand: patch.brand,
          mpn: ident.mpn,
          condition: patch.condition,
          url: ident.url,
          image_url: ident.imageUrl,
          no_gtin: patch.no_gtin === undefined ? undefined : patch.no_gtin ? 1 : 0,
          listed: patch.listed === undefined ? undefined : patch.listed ? 1 : 0,
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

  /**
   * The owner's one tap on a barcode their AI proposed (ADR-029): it becomes the product's barcode.
   * The owner in person only, since what a model read or wrote never says what a product is by itself.
   */
  async confirmBarcode(caller: Caller, input: { product_id: string }): Promise<ProductRow> {
    requireOwner(caller);
    if (!isPerson(caller)) throw listingOwners("gtin");
    const stored = await this.product(input.product_id);
    const r = stored.gtinGiven ? normaliseGtin(stored.gtinGiven, "barcode") : null;
    if (!r || !("ok" in r)) {
      throw new WriteError("wrong_state", "there is no proposed barcode on this product to confirm", {
        fields: [{ path: "product_id", problem: "invalid", message: "no proposed barcode" }],
      });
    }
    await this.patchRow("products", stored.id, { gtin: r.ok.gtin14, gtin_given: null }, nowOf(caller), "product_id");
    return this.product(stored.id);
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
      weekly: (base?.weekly as Weekly | null) ?? NO_HOURS,
      weekly_set: base !== undefined,
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
    // A rule acts on its own for as long as it is on, and its words go out as the owner's own: one that
    // prices, or says an amount or something off a price, is the owner's to write — not the AI's, nor a
    // key's without money:write (ADR-018 §4).
    if (!holdsMoney(caller) && ownersMoneyRule(input.definition)) throw ruleMoney();
    // What a rule replies or notes goes to whoever it fires for: words any customer may read.
    await this.published(caller, stringsIn(input.definition.actions));
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
    if (patch.definition) {
      requirePositive(patch.definition);
      await this.published(caller, stringsIn(patch.definition.actions));
    }
    if (!holdsMoney(caller) && (patch.definition !== undefined || patch.enabled === true)) {
      // The owner's pricing rule stays as the owner wrote it: the AI may rename it or switch it off,
      // never rewrite it, switch it on, or turn a rule of its own into one.
      const stored = await this.rule(rule_id);
      const next = patch.definition ?? stored.definition;
      const rewritten = patch.definition !== undefined && JSON.stringify(next) !== JSON.stringify(stored.definition);
      const switchedOn = patch.enabled === true && !stored.enabled;
      if (ownersMoneyRule(next) && (rewritten || switchedOn)) throw ruleMoney();
    }
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

  async applyPreset(
    caller: Caller,
    input: Omit<S.ApplyPresetInput, "confirm"> & { readonly confirm?: PresetConfirm | undefined },
  ): Promise<RuleView[]> {
    requireOwner(caller);
    const now = nowOf(caller);
    // Rules are saved with their words: a reply goes out in the business's first language.
    const preset = presetFor(
      input.preset,
      customerLang(null, (await businessFacts(this.db)).languages),
      input.confirm ?? "rules",
    );
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
    // A promise on a price the business did not set waits for a person (ADR-018 §3.2), and so does an
    // order for what is off sale or past the stock: the run asks one instead, and stops there.
    const actions = parsed.data.actions.filter((a) => !skippedActions.includes(a));
    let unpriced: Action[] = [];
    let why: "price" | "stock" = "price";
    for (const [i, a] of actions.entries()) {
      if (!matched || a.action !== "transition") continue;
      if (await heldForPrice(this.db, item, a.event)) why = "price";
      else if (await heldForStock(this.db, item, a.event, offeredLines(item, a))) why = "stock";
      else continue;
      unpriced = actions.slice(i);
      break;
    }
    const skipped = [
      ...(held ? skippedActions.map((a) => skippedSentence(input.name, a, held)) : []),
      ...(unpriced[0] ? [priceSentence(input.name, unpriced[0], why)] : []),
    ];
    return {
      matched,
      summary: summarizeRule(parsed.data),
      would: matched
        ? [
            ...actions.filter((a) => !unpriced.includes(a)).map(describeAction),
            ...(unpriced.length ? [ASK_A_PERSON] : []),
          ]
        : [],
      ...(skipped.length ? { skipped } : {}),
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

  // ---- floors: the lowest price automation may go to (the owner's alone) ------------------

  /**
   * The owner's floors (ADR-018 §4): the lowest price the owner's AI, rules and another system's key
   * may go to for each product or service. Only the owner in person reads them — never the AI, never a
   * key, never a public door — so no customer's message can get anyone to recite one.
   */
  async listFloors(caller: Caller): Promise<{ floors: FloorView[] }> {
    requireOwnerInPerson(caller, "see the lowest prices");
    return { floors: await allFloors(this.db) };
  }

  /** Sets or clears floors, each for a product or service of the catalogue. The owner in person only. */
  async setFloors(caller: Caller, input: S.SetFloorsInput): Promise<{ floors: FloorView[] }> {
    requireOwnerInPerson(caller, "set the lowest prices");
    const problems: { path: string; problem: "invalid"; message: string }[] = [];
    for (const [i, f] of input.floors.entries()) {
      const table = f.kind === "product" ? products : services;
      const [row] = await this.db.orm
        .select({ id: table.id, price: table.price })
        .from(table)
        .where(eq(table.id, f.ref_id));
      if (!row) {
        problems.push({ path: `floors.${i}.ref_id`, problem: "invalid", message: `no such ${f.kind}` });
        continue;
      }
      // On the price's own basis, and never above it: a lowest price above the price is no price at all.
      const price = row.price as { model?: string; value?: number } | null;
      const list = f.kind === "product" || price?.model === "fixed" ? (price?.value ?? null) : null;
      if (f.floor_minor !== null && list !== null && f.floor_minor > list) {
        problems.push({
          path: `floors.${i}.floor_minor`,
          problem: "invalid",
          message: "above its price: the lowest price is at most the price itself",
        });
      }
    }
    if (problems.length) {
      throw new WriteError(
        "invalid_input",
        `Invalid input: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`,
        {
          fields: problems,
        },
      );
    }
    const now = nowOf(caller);
    await this.db.batch(input.floors.map((f) => floorStatement(f.kind, f.ref_id, f.floor_minor, now)));
    return { floors: await allFloors(this.db) };
  }

  private async patchRow(
    table: "services" | "products",
    id: string,
    cols: Record<string, unknown>,
    now: number,
    field: string,
  ): Promise<void> {
    // A product moves to the end of the signed catalogue feed with any change (ADR-029).
    const sets: string[] =
      table === "products" ? ["updated_at = ?", `catalogue_seq = ${NEXT_CATALOGUE_SEQ}`] : ["updated_at = ?"];
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

/**
 * ADR-017 §8.3: a rule that reads a customer's standing may only speed things up or ask a person.
 * ADR-018 §4: one that reads where they live or come from may not set a price or terms.
 */
function requirePositive(definition: RuleDefinition): void {
  const problem = positiveOnlyProblem(definition);
  if (problem) {
    throw new WriteError("positive_only", problem, {
      fields: [{ path: "definition.actions", problem: "invalid", message: problem }],
    });
  }
  const geo = geoTermsProblem(definition);
  if (geo) {
    throw new WriteError("geo_terms", geo, {
      fields: [{ path: "definition.if", problem: "invalid", message: geo }],
    });
  }
}

function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "setup needs an owner or staff principal");
}

/**
 * The owner in person (ADR-018 §4): signed in to the owner app, or a full owner key from the command
 * line — never the owner's AI, never a key handed to another system. What bounds automation is theirs.
 */
function requireOwnerInPerson(caller: Caller, what: string): void {
  if (isOwnerOrSystem(caller)) return;
  throw new WriteError(
    "not_allowed",
    `Only the owner can ${what}, signed in to the owner app: they bound what automation may agree to. Nothing was changed.`,
    { details: { reason: "owner_in_person", ask_owner: true } },
  );
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

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A service price that names an amount: what only the owner publishes. */
export function hasAmount(price: { value?: number | undefined } | null | undefined): boolean {
  return typeof price?.value === "number";
}

/** A service price, compared as it prices: its model, amount, currency (the business's when unsaid) and basis. */
export function servicePriceKey(
  price: { model: string; value?: number | undefined; currency?: string | undefined; per?: string | undefined } | null,
  currency: string,
): string {
  if (!price) return "none";
  return [price.model, price.value ?? "", (price.currency ?? currency).toUpperCase(), price.per ?? "booking"].join("|");
}

/**
 * The owner's AI reached for money (the founder, 23 September 2026): the refusal it reads, which tells it
 * to leave the owner a note instead.
 */
/**
 * Whether customers may withdraw from what the business sells is the law's, read by a person (ADR-018
 * §7): the owner or staff set the exception, never the owner's AI or another system's key.
 */
function negotiableOwners(): WriteError {
  return new WriteError(
    "not_allowed",
    "Whether customers may suggest their own price for this is the owner's to set, in the app. Tell the owner in a note (reply with internal: true) what you suggest.",
    {
      fields: [{ path: "negotiable", problem: "invalid", message: "only the owner changes this" }],
      details: { reason: "owner_only", draft_for_owner: true },
    },
  );
}

function withdrawalOwners(): WriteError {
  return new WriteError(
    "not_allowed",
    "Whether customers may withdraw from this, and why not, is the owner's to set, in the app. Tell the owner in a note (reply with internal: true) what you know.",
    {
      fields: [{ path: "withdrawal", problem: "invalid", message: "only the owner changes this" }],
      details: { reason: "owner_only", draft_for_owner: true },
    },
  );
}

/** The refusal for keeping a product off networks, or saying it has no barcode, from anyone but the owner. */
function listingOwners(path: string): WriteError {
  return new WriteError(
    "not_allowed",
    "Listing on networks is yours to switch, in the app. Only the owner changes whether a product is on networks, which barcode it has, or that it has none, signed in to the owner app. Tell the owner in a note what you suggest.",
    {
      fields: [{ path, problem: "invalid", message: "only the owner in person changes this" }],
      details: { reason: "owner_in_person", ask_owner: true, where: "Products" },
    },
  );
}

/** The identity columns a product write sets: undefined leaves one as it is. */
interface IdentityPatch {
  readonly gtin: string | null | undefined;
  readonly gtinGiven: string | null | undefined;
  readonly mpn: string | null | undefined;
  readonly url: string | null | undefined;
  readonly imageUrl: string | null | undefined;
}

/**
 * What a product write does with its barcode, part number and links (ADR-029). A barcode is checked
 * (`normaliseGtin`) and kept as 14 digits, or refused with the reason; from the owner's AI it is only
 * proposed (`gtin_given`), for the owner to confirm with one tap. The owner's AI may not set the part
 * number, which says what the product is as much as a barcode does. Links are kept only on public https
 * hosts.
 */
function productIdentity(
  caller: Caller,
  input: Pick<S.UpdateProductInput, "gtin" | "mpn" | "url" | "image_url">,
  stored: ProductRow | null,
): IdentityPatch {
  let gtin: string | null | undefined;
  let gtinGiven: string | null | undefined;
  if (input.gtin === null) {
    if (isOwnerAssistant(caller) && stored?.gtin) throw listingOwners("gtin");
    gtin = null;
    gtinGiven = null;
  } else if (input.gtin !== undefined) {
    const r = normaliseGtin(input.gtin, "barcode");
    if (!("ok" in r)) {
      const why = r.problem === "check_digit" ? `its last digit should be ${r.expected}` : r.problem.replace("_", " ");
      throw new WriteError("invalid_input", `gtin: ${input.gtin} does not read as a product's barcode (${why})`, {
        fields: [{ path: "gtin", problem: "invalid", message: `not a product's barcode: ${r.problem}` }],
      });
    }
    if (isOwnerAssistant(caller)) {
      if (r.ok.gtin14 !== stored?.gtin) gtinGiven = r.ok.gtin14;
    } else {
      gtin = r.ok.gtin14;
      gtinGiven = null;
    }
  }
  if (input.mpn !== undefined && isOwnerAssistant(caller) && (input.mpn || null) !== (stored?.mpn ?? null)) {
    throw new WriteError(
      "not_allowed",
      "A product's part number is the owner's to set, in the app: it says which product it is. Tell the owner in a note what you suggest.",
      {
        fields: [{ path: "mpn", problem: "invalid", message: "only the owner changes this" }],
        details: { reason: "owner_in_person", draft_for_owner: true },
      },
    );
  }
  const link = (path: string, value: string | null | undefined) => {
    if (value === undefined || value === null) return value;
    const kept = storedLink(value);
    if (!kept) throw unknown(path, "an https address on a public host");
    return kept;
  };
  return {
    gtin,
    gtinGiven,
    mpn: input.mpn === undefined ? undefined : input.mpn || null,
    url: link("url", input.url),
    imageUrl: link("image_url", input.image_url),
  };
}

/** The identity columns of a new row, as `productIdentity` decided them. */
function identityRow(i: IdentityPatch): Partial<typeof products.$inferInsert> {
  return {
    ...(i.gtin !== undefined ? { gtin: i.gtin } : {}),
    ...(i.gtinGiven !== undefined ? { gtinGiven: i.gtinGiven } : {}),
    ...(i.mpn !== undefined ? { mpn: i.mpn } : {}),
    ...(i.url !== undefined ? { url: i.url } : {}),
    ...(i.imageUrl !== undefined ? { imageUrl: i.imageUrl } : {}),
  };
}

function ownerMoney(path: string, what: string): WriteError {
  return new WriteError(
    "not_allowed",
    `${what} Tell the owner in a note (reply with internal: true) what you suggest; the owner changes it in the app.`,
    {
      fields: [{ path, problem: "invalid", message: "only the owner changes this" }],
      details: { reason: "owner_money", draft_for_owner: true },
    },
  );
}

/** Keys of a transition's input that carry an amount: a quote's total and lines, a time's price, a payment. */
const MONEY_INPUT = new Set(["totalPrice", "lines", "amount", "price"]);

/** Whether a rule's actions put a price on anything: a quote, or a transition naming an amount. */
function pricesSomething(definition: RuleDefinition | null | undefined): boolean {
  // A stored rule that no longer parses is read as it is: anything but a list of actions prices nothing.
  const actions: unknown = definition?.actions;
  if (!Array.isArray(actions)) return false;
  return actions.some((a: { action?: unknown; event?: unknown; input?: unknown } | null) => {
    if (a?.action !== "transition") return false;
    const input = a.input;
    return (
      a.event === "quote" ||
      (typeof input === "object" && input !== null && Object.keys(input).some((k) => MONEY_INPUT.has(k)))
    );
  });
}

/**
 * Whether a rule's words name an amount of money or something off a price (ADR-018 §4): a rule's reply
 * or note goes to the customer as the owner's own words, unjudged, so only the owner writes one that does.
 */
function wordsNameMoney(definition: RuleDefinition | null | undefined): boolean {
  const actions: unknown = definition?.actions;
  if (!Array.isArray(actions)) return false;
  return stringsIn(actions).some((t) => amountsIn(t).length > 0 || discountIn(t) || speltAmountIn(t));
}

/** A rule only the owner writes: one that prices, or whose words name money. */
function ownersMoneyRule(definition: RuleDefinition | null | undefined): boolean {
  return pricesSomething(definition) || wordsNameMoney(definition);
}

function ruleMoney(): WriteError {
  return ownerMoney(
    "definition.actions",
    "A rule that sends a quote, or whose words name an amount or something off a price, prices things on its own, and prices are the owner's.",
  );
}

/** What a rule does instead of a promise on a price the business did not set (ADR-018 §3.2). */
const ASK_A_PERSON = "flag it for a person";

/**
 * The lines a rule's offer on an order would put to the customer, as its run would send them: those
 * it names, else, for a change, the order's own.
 */
function offeredLines(item: Item, action: Action & { action: "transition" }): StockLine[] | undefined {
  if (item.type !== "order") return undefined;
  const named = action.input?.orderedItem;
  if (Array.isArray(named)) return named as StockLine[];
  return action.event === "propose_change" ? item.payload.orderedItem : undefined;
}

/** Why a rule's promise waits for a person, in the owner's words, for a rule's test. */
function priceSentence(ruleName: string | undefined, action: Action, why: "price" | "stock"): string {
  const rule = ruleName?.trim() ? `Rule '${ruleName.trim()}'` : "This rule";
  const offers = action.action === "transition" && (action.event === "propose" || action.event === "propose_change");
  const what = offers ? "it would offer" : "the order is for";
  return why === "stock"
    ? `${rule} wanted to ${describeAction(action)}, but ${what} a product off sale or more than you have in stock, so it asks a person to decide`
    : `${rule} wanted to ${describeAction(action)}, but the request holds a price that is not in your catalogue, so it asks a person to price it first`;
}

/** The profile's view of where a hosted business joined from, when its host said. */
function home(h: HostHome | undefined): Pick<Profile, "home"> {
  return h ? { home: { domain: h.domain, linked: h.linked, connect_url: h.connectUrl } } : {};
}
