import type { Statement } from "@surfingdog/platform";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type FeedParseResult, type FeedProduct, type FeedSkip, parseFeed } from "../feeds/parse";
import { ulid } from "../ids";
import { connectors, products } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import type * as S from "./setup-types";
import { isPublicHost } from "./webhooks";

/**
 * Feed import (ADR-015 §7.3): the cheapest way to make a catalogue real.
 *
 * A shop that sells anything already publishes a product feed, because Google asks for one. It
 * needs no credentials, no OAuth screen and no app review, so it is the one integration a business
 * can finish in the minute after it reads about it. Point an inbox at that URL and its agents can
 * answer "do you have it, and what does it cost" from the same numbers the shop shows everyone
 * else.
 *
 * Two rules shape everything here. **The feed is the source of truth for what it carries, and
 * nothing else**: an import never touches a product somebody typed in, only the ones it created.
 * And **a product that leaves the feed is deactivated, never deleted**, because an order may point
 * at it and a deleted row takes that order's history with it.
 */

export const FEED_IMPORT_KIND = "feed_import";

/** How long an import may take to arrive before a scheduled one gives up and the next one runs. */
export const FEED_SYNC_INTERVAL_MS = 6 * 3_600_000;

/** What we refuse to download, measured before parsing. A product feed is text, and text is small. */
export const FEED_MAX_BYTES = 12 * 1024 * 1024;

export interface FeedConnector {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
  readonly currency: string;
  readonly deactivate_missing: boolean;
  readonly last_sync_at: number | null;
  readonly last_error: string | null;
  readonly last_error_at: number | null;
  readonly product_count: number;
}

export interface FeedImportSummary {
  readonly connector_id: string;
  readonly format: "csv" | "xml";
  readonly read: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deactivated: number;
  readonly skipped: readonly FeedSkip[];
  readonly truncated: boolean;
  /** Which feed column became which field, so an owner can see what we made of their header row. */
  readonly mapped: Readonly<Record<string, string>>;
}

interface FeedConfig {
  readonly url: string;
  readonly currency?: string;
  readonly deactivateMissing?: boolean;
}

export class FeedCapabilities {
  constructor(private readonly db: Db) {}

  async list(caller: Caller): Promise<FeedConnector[]> {
    requireOwner(caller);
    const rows = await this.db.orm
      .select()
      .from(connectors)
      .where(eq(connectors.kind, "feed"))
      .orderBy(asc(connectors.name));
    const out: FeedConnector[] = [];
    for (const row of rows) out.push(this.view(row, await this.activeCount(urlOf(row))));
    return out;
  }

  async add(caller: Caller, input: S.AddFeedInput): Promise<FeedConnector> {
    requireOwner(caller);
    const now = nowOf(caller);
    const url = normaliseFeedUrl(input.url);
    const settings = await readSettings(this.db);
    const config: FeedConfig = {
      url,
      currency: (input.currency ?? settings.business.currency ?? "EUR").toUpperCase(),
      deactivateMissing: input.deactivate_missing ?? true,
    };
    const id = ulid(now);
    const name = (input.name ?? "").trim() || hostOf(url);
    try {
      await this.db.batch([
        {
          sql: `INSERT INTO connectors (id, kind, name, external_id, config_public, status, created_at, updated_at)
                VALUES (?, 'feed', ?, ?, ?, 'configured', ?, ?)`,
          params: [id, name, url, JSON.stringify(config), now, now],
          method: "run",
        },
        // Import straight away. An owner who has just pasted a URL is watching the screen.
        jobStatement(FEED_IMPORT_KIND, { connectorId: id }, now, { dedupeKey: `feed:${id}:${now}` }),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new WriteError("wrong_state", "this feed is already connected", { details: { url } });
      }
      throw error;
    }
    return this.get(caller, id);
  }

  async get(caller: Caller, connectorId: string): Promise<FeedConnector> {
    requireOwner(caller);
    const row = await this.row(connectorId);
    return this.view(row, await this.activeCount(urlOf(row)));
  }

  /** Queues an import now. The handler in `@surfingdog/adapters` does the fetching. */
  async importNow(caller: Caller, connectorId: string): Promise<{ queued: true; connector_id: string }> {
    requireOwner(caller);
    const row = await this.row(connectorId);
    const now = nowOf(caller);
    await this.db.batch([
      jobStatement(FEED_IMPORT_KIND, { connectorId: row.id }, now, { dedupeKey: `feed:${row.id}:${now}` }),
    ]);
    return { queued: true, connector_id: row.id };
  }

  /**
   * Disconnects a feed. Its products are deactivated rather than deleted, and they keep their
   * source, so reconnecting the same URL adopts them again instead of making a second copy of
   * every product.
   */
  async remove(caller: Caller, connectorId: string): Promise<{ removed: true; deactivated: number }> {
    requireOwner(caller);
    const row = await this.row(connectorId);
    const now = nowOf(caller);
    const url = urlOf(row);
    const deactivated = await this.activeCount(url);
    await this.db.batch([
      {
        sql: "UPDATE products SET active = 0, updated_at = ? WHERE source = ? AND active = 1",
        params: [now, feedSource(url)],
        method: "run",
      },
      { sql: "DELETE FROM connectors WHERE id = ?", params: [row.id], method: "run" },
    ]);
    return { removed: true, deactivated };
  }

  /** The configuration a job handler needs to go and fetch. */
  async configFor(
    connectorId: string,
  ): Promise<{ id: string; url: string; currency: string; deactivateMissing: boolean }> {
    const row = await this.row(connectorId);
    const config = (row.configPublic ?? {}) as FeedConfig;
    return {
      id: row.id,
      url: config.url ?? row.externalId ?? "",
      currency: (config.currency ?? "EUR").toUpperCase(),
      deactivateMissing: config.deactivateMissing !== false,
    };
  }

  /**
   * Parses a feed body and writes it. Pure enough to test without a network: the caller has already
   * done the fetching, and everything that can go wrong with the *content* goes wrong here.
   */
  async importBody(connectorId: string, body: string, at: number): Promise<FeedImportSummary> {
    const config = await this.configFor(connectorId);
    let parsed: FeedParseResult;
    try {
      parsed = parseFeed(body, { defaultCurrency: config.currency });
    } catch (error) {
      await this.markError(connectorId, String((error as Error).message ?? error), at);
      throw error;
    }
    const summary = await this.apply(connectorId, config.url, parsed, config.deactivateMissing, at);
    await this.db.client.query({
      sql: "UPDATE connectors SET status = 'active', last_sync_at = ?, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?",
      params: [at, at, connectorId],
      method: "run",
    });
    return summary;
  }

  async markError(connectorId: string, message: string, at: number): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE connectors SET status = 'error', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
      params: [message.slice(0, 500), at, at, connectorId],
      method: "run",
    });
  }

  /* --- writing the catalogue ------------------------------------------- */

  private async apply(
    connectorId: string,
    url: string,
    parsed: FeedParseResult,
    deactivateMissing: boolean,
    now: number,
  ): Promise<FeedImportSummary> {
    const source = feedSource(url);
    const existing = await this.db.orm
      .select({
        id: products.id,
        externalId: products.externalId,
        name: products.name,
        description: products.description,
        price: products.price,
        stock: products.stock,
        active: products.active,
      })
      .from(products)
      .where(eq(products.source, source));

    const byExternal = new Map<string, (typeof existing)[number]>();
    for (const row of existing) if (row.externalId) byExternal.set(row.externalId, row);

    // A sku is unique across the whole catalogue, so one already spoken for by a product this feed
    // does not own is simply not written. The product still imports; it just carries no sku.
    const takenSku = new Map<string, string>();
    const skuRows = await this.db.orm
      .select({ id: products.id, sku: products.sku })
      .from(products)
      .where(isNotNull(products.sku));
    for (const row of skuRows) if (row.sku) takenSku.set(row.sku, row.id);

    const statements: Statement[] = [];
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const product of parsed.products) {
      seen.add(product.externalId);
      const current = byExternal.get(product.externalId);
      const id = current?.id ?? ulid(now);
      const sku = this.skuFor(product, id, takenSku);
      const price = product.price ?? current?.price ?? null;
      const active = product.available === false ? 0 : 1;

      if (!current) {
        statements.push({
          sql: `INSERT INTO products (id, sku, name, description, price, stock, source, external_id, active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            id,
            sku,
            product.name,
            product.description,
            JSON.stringify(price ?? { value: 0, currency: "EUR" }),
            product.stock,
            source,
            product.externalId,
            active,
            now,
            now,
          ],
          method: "run",
        });
        if (sku) takenSku.set(sku, id);
        created++;
        continue;
      }

      if (!changed(current, product, price, active)) {
        unchanged++;
        continue;
      }
      statements.push({
        sql: `UPDATE products SET sku = ?, name = ?, description = ?, price = ?, stock = ?, active = ?, updated_at = ? WHERE id = ?`,
        params: [
          sku,
          product.name,
          product.description,
          JSON.stringify(price ?? { value: 0, currency: "EUR" }),
          product.stock,
          active,
          now,
          id,
        ],
        method: "run",
      });
      if (sku) takenSku.set(sku, id);
      updated++;
    }

    // Gone from the feed. Deactivated, never deleted: an order may point at it, and a deleted row
    // takes that order's history with it. A truncated read is not evidence of absence, so a feed
    // that hit the row limit deactivates nothing.
    let deactivated = 0;
    if (deactivateMissing && !parsed.truncated) {
      const missing = existing.filter((row) => row.active === 1 && (!row.externalId || !seen.has(row.externalId)));
      for (const chunk of chunks(
        missing.map((row) => row.id),
        50,
      )) {
        statements.push({
          sql: `UPDATE products SET active = 0, updated_at = ? WHERE id IN (${chunk.map(() => "?").join(", ")})`,
          params: [now, ...chunk],
          method: "run",
        });
      }
      deactivated = missing.length;
    }

    // D1 counts every statement in a batch against one invocation's query budget, so the writes go
    // in slices rather than one batch of five thousand.
    for (const slice of chunks(statements, 40)) await this.db.batch(slice);

    return {
      connector_id: connectorId,
      format: parsed.format,
      read: parsed.products.length,
      created,
      updated,
      unchanged,
      deactivated,
      skipped: parsed.skipped,
      truncated: parsed.truncated,
      mapped: parsed.mapped,
    };
  }

  private skuFor(product: FeedProduct, id: string, taken: Map<string, string>): string | null {
    if (!product.sku) return null;
    const owner = taken.get(product.sku);
    return owner === undefined || owner === id ? product.sku : null;
  }

  private view(row: typeof connectors.$inferSelect, productCount: number): FeedConnector {
    const config = (row.configPublic ?? {}) as FeedConfig;
    return {
      id: row.id,
      name: row.name,
      url: config.url ?? row.externalId ?? "",
      status: row.status,
      currency: (config.currency ?? "EUR").toUpperCase(),
      deactivate_missing: config.deactivateMissing !== false,
      last_sync_at: row.lastSyncAt ?? null,
      last_error: row.lastError ?? null,
      last_error_at: row.lastErrorAt ?? null,
      product_count: productCount,
    };
  }

  /** Active products this feed owns. Through the ORM, so the count comes back as a number. */
  private async activeCount(url: string): Promise<number> {
    if (url === "") return 0;
    const [row] = await this.db.orm
      .select({ n: sql<number>`count(*)` })
      .from(products)
      .where(and(eq(products.source, feedSource(url)), eq(products.active, 1)));
    const n = Number(row?.n ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private async row(connectorId: string): Promise<typeof connectors.$inferSelect> {
    const [row] = await this.db.orm.select().from(connectors).where(eq(connectors.id, connectorId));
    if (row?.kind !== "feed") {
      throw new WriteError("not_found", "no feed with that id", { details: { connector_id: connectorId } });
    }
    return row;
  }
}

/**
 * Products this feed owns, keyed on the feed's URL rather than the connector row's id.
 *
 * The URL is already a feed's identity — `connectors` is UNIQUE on (kind, external_id) — and it
 * is the only key that survives a disconnect. Keying on the connector id instead meant that
 * reconnecting the same feed minted a new id, adopted nothing, and imported a second copy of
 * every product beside the deactivated first copy, which still held the sku. Two feeds cannot
 * collide here because two connectors cannot hold one URL.
 */
export function feedSource(url: string): string {
  return `feed:${url}`;
}

/**
 * An owner pastes what their platform showed them, which may be missing a scheme or wrapped in
 * spaces. http is allowed but upgraded: a feed is public data, and there is no reason to read a
 * price list over a connection anyone on the path can rewrite.
 */
export function normaliseFeedUrl(raw: string): string {
  const text = raw.trim();
  if (text === "")
    throw new WriteError("invalid_input", "a feed needs a URL", {
      fields: [{ path: "url", problem: "missing", message: "a feed needs a URL" }],
    });
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WriteError("invalid_input", `this is not a URL: ${text}`, {
      fields: [{ path: "url", problem: "invalid", message: `this is not a URL: ${text}` }],
    });
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") {
    throw new WriteError("invalid_input", `a feed is fetched over https, not ${url.protocol}`, {
      fields: [{ path: "url", problem: "invalid", message: "a feed is fetched over https" }],
    });
  }
  // The same host rule a webhook endpoint has to pass, applied here so an owner who pastes a LAN
  // address is told now rather than after the first import quietly fails.
  if (!isPublicHost(url.hostname)) {
    throw new WriteError("invalid_input", `${url.hostname} is not a public address`, {
      fields: [{ path: "url", problem: "invalid", message: `${url.hostname} is not a public address` }],
    });
  }
  url.hash = "";
  return url.toString();
}

/** A connector row's feed URL, from its config with the unique external id as the fallback. */
function urlOf(row: typeof connectors.$inferSelect): string {
  const config = (row.configPublic ?? {}) as FeedConfig;
  return config.url ?? row.externalId ?? "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Feed";
  }
}

function changed(
  current: { name: string; description: string | null; price: unknown; stock: number | null; active: number },
  product: FeedProduct,
  price: unknown,
  active: number,
): boolean {
  return (
    current.name !== product.name ||
    (current.description ?? null) !== product.description ||
    JSON.stringify(current.price ?? null) !== JSON.stringify(price ?? null) ||
    (current.stock ?? null) !== product.stock ||
    current.active !== active
  );
}

function* chunks<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) {
    throw new WriteError("not_allowed", "this needs the owner");
  }
}
