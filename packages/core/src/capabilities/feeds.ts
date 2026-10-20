import { and, asc, eq, sql } from "drizzle-orm";
import { deactivateUnseen, upsertCatalogue } from "../connectors/catalogue";
import type { Db } from "../db";
import { type FeedParseResult, type FeedProduct, type FeedSkip, parseFeed } from "../feeds/parse";
import { ulid } from "../ids";
import { connectors, products } from "../schema/tables";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, isOwnerAssistant, nowOf } from "../write/caller";
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
    requireNotAssistant(caller, "connect");
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
    requireNotAssistant(caller, "disconnect");
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
    let summary: FeedImportSummary;
    try {
      summary = await this.apply(connectorId, config.url, parsed, config.deactivateMissing, config.currency, at);
    } catch (error) {
      // The batches already written stay written: without interactive transactions there is
      // nothing to roll back to. What must not happen is the connector reading as if nothing
      // went wrong, because the next import is the only thing that repairs the catalogue.
      const message = `the import stopped part way through and the catalogue may be incomplete: ${
        (error as Error).message ?? String(error)
      }`;
      await this.markError(connectorId, message, at);
      throw error;
    }
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

  /**
   * The feed's products, written by the one catalogue upsert feeds and shops share (ADR-026 §3): the
   * same keys, the same SKU rule, a missing price kept from last time and a product with none never
   * on sale. What the feed no longer carries is deactivated, unless the read was cut short.
   */
  private async apply(
    connectorId: string,
    url: string,
    parsed: FeedParseResult,
    deactivateMissing: boolean,
    currency: string,
    now: number,
  ): Promise<FeedImportSummary> {
    const source = feedSource(url);
    const written = await upsertCatalogue(this.db, {
      source,
      products: parsed.products.map((product: FeedProduct) => ({
        externalId: product.externalId,
        name: product.name,
        description: product.description,
        sku: product.sku,
        price: product.price,
        stock: product.stock,
        available: product.available,
      })),
      now,
      seenAt: now,
      currency,
    });
    // Gone from the feed. A truncated read is not evidence of absence, so a feed that hit the row limit
    // deactivates nothing.
    const deactivated = deactivateMissing && !parsed.truncated ? await deactivateUnseen(this.db, source, now, now) : 0;
    return {
      connector_id: connectorId,
      format: parsed.format,
      read: parsed.products.length,
      created: written.created,
      updated: written.updated,
      unchanged: written.unchanged,
      deactivated,
      skipped: parsed.skipped,
      truncated: parsed.truncated,
      mapped: parsed.mapped,
    };
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

function requireOwner(caller: Caller): void {
  if (isCustomer(caller)) {
    throw new WriteError("not_allowed", "this needs the owner");
  }
}

/**
 * A feed sets the prices of everything it lists, so connecting or disconnecting one is money, and
 * money is the owner's (the founder, 23 September 2026): the owner's AI can read feeds and import a feed
 * the owner connected again, not add or remove one.
 */
function requireNotAssistant(caller: Caller, verb: string): void {
  if (!isOwnerAssistant(caller)) return;
  throw new WriteError(
    "not_allowed",
    `A feed sets prices, and prices are the owner's: you cannot ${verb} one. Tell the owner in a note what you suggest; the owner does it in Settings.`,
    { details: { reason: "owner_money", draft_for_owner: true } },
  );
}
