import {
  CATALOGUE_ITEMS_MAX,
  CATALOGUE_PAGE_MAX,
  type CatalogueItem,
  type CataloguePage,
  type CatalogueSummary,
  type PingCatalogue,
  PLACEHOLDER_TITLES,
} from "@surfingdog/spec";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "../db";
import type { KeyStore } from "../receipts/keys";
import { b64u, bodySha256, signCatalogue, unb64u } from "../receipts/sign";
import { products } from "../schema/tables";
import { readSettings, type Settings } from "../settings/schema";
import { canonicalJson } from "../util/canonical";
import { WriteError } from "../write/errors";
import { type CatalogueContext, catalogueItem, listableSql } from "./publish";

/**
 * The signed catalogue feed (ADR-029, protocol §4.18): what an inbox whose owner lists its products on
 * networks serves to any network that reads it, at `GET /v1/catalogue/changes` and
 * `GET /v1/catalogue/items`. The network pulls on its own schedule, so the inbox keeps no state per
 * network and any network can read the same feed.
 *
 * Products come in the order the database committed them (`catalogue_seq`, set by every writer), each
 * listed (`catalogueItem`) or withdrawn. A page ends at `next_cursor: null`; a reader keeps the `after`
 * it asked that last page with and asks from it next time, reading that page again, which changes
 * nothing it holds. Every page is signed with the receipt key the manifest publishes, over its exact
 * bytes and the address it was asked at.
 */

const DEFAULT_LIMIT = CATALOGUE_PAGE_MAX;

export interface CatalogueRequest {
  /** The inbox's domain, as it registered with networks: the signature's `iss`. */
  readonly domain: string;
  /** The address the page was asked at, query string included. */
  readonly url: string;
  readonly now: number;
  /** The reader's `If-None-Match`: a page it already has is answered 304. */
  readonly ifNoneMatch?: string | undefined;
}

export type CatalogueResponse =
  | {
      readonly status: 200;
      readonly body: string;
      readonly etag: string;
      readonly signature: string;
      readonly cacheControl: string;
    }
  | { readonly status: 304; readonly etag: string }
  | {
      readonly status: 404;
      /** Kept off networks by the owner, out of the directories, or no key to sign with. */
      readonly why: "not_listed" | "cannot_sign";
    };

/** The catalogue as a whole, as a reader compares it, with what `rev` is made from. */
export interface CatalogueState extends CatalogueSummary {
  /** The last position in the feed: any write moves it. */
  readonly seq: number;
}

interface Cursor {
  readonly seq: number;
  readonly id: string;
}

function encodeCursor(c: Cursor): string {
  return b64u(new TextEncoder().encode(`${c.seq}.${c.id}`));
}

function decodeCursor(text: string): Cursor {
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(unb64u(text));
  } catch {
    decoded = "";
  }
  const m = /^(\d{1,15})\.([0-9A-Za-z_-]{1,64})$/.exec(decoded);
  if (!m) {
    throw new WriteError("invalid_input", "after: not a cursor this feed gave; start again without it", {
      fields: [{ path: "after", problem: "invalid", message: "not a cursor this feed gave" }],
    });
  }
  return { seq: Number(m[1]), id: m[2] as string };
}

const iso = (ms: number) => new Date(ms).toISOString();

export class CatalogueCapabilities {
  constructor(
    private readonly db: Db,
    /** The receipt keys, or null for an inbox without INBOX_SECRET_KEY, which cannot sign a page. */
    private readonly keys: KeyStore | null,
    private readonly context: () => Promise<CatalogueContext>,
  ) {}

  /** Whether the feed is served: the owner lists the products, and the business is in the directories. */
  served(settings: Settings): boolean {
    return settings.catalogue.listed && settings.directory.listed;
  }

  /** Whether this inbox can sign its pages: what the owner's switch needs besides itself. */
  canSign(): boolean {
    return this.keys !== null;
  }

  /**
   * What a reader compares (one indexed pass over `products`): how many are listed, the latest change,
   * whether prices include tax, and `rev`, which moves with any of them, with any write at all, and
   * with the business's site, which decides the product pages the items name.
   */
  async summary(settings?: Settings, ctx?: CatalogueContext): Promise<CatalogueState> {
    const [s, c] = await Promise.all([settings ?? readSettings(this.db), ctx ?? this.context()]);
    const where = listableSql(PLACEHOLDER_TITLES);
    const { rows } = await this.db.client.query({
      sql: `SELECT COALESCE(SUM(CASE WHEN ${where.sql} THEN 1 ELSE 0 END), 0), MAX(updated_at), COALESCE(MAX(catalogue_seq), 0), COUNT(*)
              FROM products`,
      params: where.params,
      method: "all",
    });
    const r = rows[0] ?? [0, null, 0, 0];
    const count = Number(r[0] ?? 0);
    const updated = r[1] === null || r[1] === undefined ? null : Number(r[1]);
    const seq = Number(r[2] ?? 0);
    const tax = s.catalogue.taxIncluded;
    const rev = (
      await bodySha256(
        canonicalJson({ count, updated_at: updated, seq, rows: Number(r[3] ?? 0), tax_included: tax, sites: c.sites }),
      )
    ).slice(0, 16);
    return { count, updated_at: updated === null ? null : iso(updated), tax_included: tax, rev, seq };
  }

  /** What the hourly signed ping says of the products: listed, with what a reader compares. */
  async pingMember(settings: Settings): Promise<PingCatalogue> {
    const s = await this.summary(settings);
    return { listed: true, count: s.count, updated_at: s.updated_at, rev: s.rev };
  }

  /** `GET /v1/catalogue/changes`: one page, from the start or from `after`. */
  async changes(
    input: { readonly after?: string | undefined; readonly limit?: number | undefined },
    req: CatalogueRequest,
  ): Promise<CatalogueResponse> {
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), CATALOGUE_PAGE_MAX);
    const cursor = input.after ? decodeCursor(input.after) : null;
    const settings = await readSettings(this.db);
    if (!this.served(settings)) return { status: 404, why: "not_listed" };
    if (!this.keys) return { status: 404, why: "cannot_sign" };
    const ctx = await this.context();
    const summary = await this.summary(settings, ctx);
    const etag = `"${summary.rev}-${input.after ?? "0"}-${limit}"`;
    if (req.ifNoneMatch?.split(",").some((t) => t.trim() === etag)) return { status: 304, etag };

    const rows = await this.db.orm
      .select()
      .from(products)
      .where(
        cursor
          ? or(
              gt(products.catalogueSeq, cursor.seq),
              and(eq(products.catalogueSeq, cursor.seq), gt(products.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(asc(products.catalogueSeq), asc(products.id))
      .limit(limit + 1);
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items: CatalogueItem[] = [];
    for (const row of pageRows) items.push(await catalogueItem(row, ctx));
    const last = pageRows.at(-1);
    const page: CataloguePage = {
      version: 1,
      domain: req.domain,
      as_of: iso(req.now),
      catalogue: {
        count: summary.count,
        updated_at: summary.updated_at,
        tax_included: summary.tax_included,
        rev: summary.rev,
      },
      items,
      next_cursor: more && last ? encodeCursor({ seq: last.catalogueSeq, id: last.id }) : null,
    };
    return this.signed(JSON.stringify(page), summary.rev, req, { etag, cacheControl: "public, max-age=60" });
  }

  /** `GET /v1/catalogue/items`: these products as the feed has them, and the ids it has none for. */
  async items(ids: readonly string[], req: CatalogueRequest): Promise<CatalogueResponse> {
    const wanted = [...new Set(ids)].slice(0, CATALOGUE_ITEMS_MAX);
    const settings = await readSettings(this.db);
    if (!this.served(settings)) return { status: 404, why: "not_listed" };
    if (!this.keys) return { status: 404, why: "cannot_sign" };
    const ctx = await this.context();
    const summary = await this.summary(settings, ctx);
    const rows = wanted.length ? await this.db.orm.select().from(products).where(inArray(products.id, wanted)) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: CatalogueItem[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row) items.push(await catalogueItem(row, ctx));
      else missing.push(id);
    }
    return this.signed(JSON.stringify({ items, missing }), summary.rev, req, {
      etag: `"${summary.rev}-items"`,
      cacheControl: "no-store",
    });
  }

  private async signed(
    body: string,
    rev: string,
    req: CatalogueRequest,
    opts: { etag: string; cacheControl: string },
  ): Promise<CatalogueResponse> {
    const key = await (this.keys as KeyStore).active();
    const signature = await signCatalogue(
      { iss: req.domain, url: req.url, body_sha256: await bodySha256(body), as_of: iso(req.now), rev },
      key,
    );
    return { status: 200, body, etag: opts.etag, signature, cacheControl: opts.cacheControl };
  }
}
