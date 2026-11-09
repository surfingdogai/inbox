import {
  CATALOGUE_ITEMS_MAX,
  CATALOGUE_PAGE_MAX,
  type CatalogueItem,
  type CataloguePage,
  type CataloguePageV2,
  type CatalogueProblem,
  type CatalogueSummary,
  catalogueIdV2Schema,
  catalogueItemV1Of,
  type PingCatalogue,
} from "@surfingdog/spec";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "../db";
import { lawOf } from "../negotiation/holidays";
import type { KeyStore } from "../receipts/keys";
import { b64u, bodySha256, signCatalogue, unb64u } from "../receipts/sign";
import { productGroups, products } from "../schema/tables";
import { readSettings, type Settings } from "../settings/schema";
import { canonicalJson } from "../util/canonical";
import { loadPolicies, type PoliciesState, policiesDocument } from "./policies";
import type { CatalogueContext } from "./publish";
import {
  type BuiltItem,
  type CatalogueV2Context,
  catalogueClockStatements,
  catalogueItemV2,
  catalogueWithdrawalStatements,
  priceHistory,
} from "./v2";

/**
 * The signed catalogue feed (ADR-029, protocol §4.18 as amended for catalogue version 2): what an inbox
 * whose owner lists its products on networks serves to any network that reads it, at
 * `GET /v1/catalogue/changes`, `GET /v1/catalogue/items` and, from version 2, `GET /v1/catalogue/policies`.
 * The network pulls on its own schedule, so the inbox keeps no state per network and any network can read
 * the same feed.
 *
 * Both versions are served, and the manifest says so (`catalogue.versions: [1, 2]`): a reader names the one
 * it reads (`version=N`), and one that names none reads version 1, as every reader did before version 2.
 * Each product is made once, as version 2 has it (`catalogueItemV2`); a version 1 page has each as
 * `catalogueItemV1Of` turns it into version 1, which withdraws what version 1 cannot say truly.
 *
 * Products come in the order the database committed them (`catalogue_seq`, set by every writer), each
 * listed or withdrawn. A page ends at `next_cursor: null`; a reader keeps the `after` it asked that last
 * page with and asks from it next time. A cursor belongs to its version: one given for the other is
 * refused (`422 cursor_invalid`). Neither version's cursors expire. Every page is signed with the receipt
 * key the manifest publishes, over its exact bytes and the address it was asked at.
 */

/** The versions this inbox's feed serves, as its manifest lists them. */
export const SERVED_CATALOGUE_VERSIONS = [1, 2] as const;
type Version = (typeof SERVED_CATALOGUE_VERSIONS)[number];

export interface CatalogueRequest {
  /** The inbox's domain, as it registered with networks: the signature's `iss`. */
  readonly domain: string;
  /** The address the page was asked at, query string included. */
  readonly url: string;
  readonly now: number;
  /** The reader's `If-None-Match`: a page it already has is answered 304. */
  readonly ifNoneMatch?: string | undefined;
}

/** What a reader asked a page with, as it came: each checked here, and refused with the spec's code. */
export interface ChangesQuery {
  readonly after?: string | undefined;
  readonly limit?: string | number | undefined;
  readonly version?: string | undefined;
}

/** A read the feed refuses (protocol §4.18): its status and code, and what to do in words. */
export type CatalogueRefusal = {
  readonly status: 422;
  readonly code: "version_required" | "version_unsupported" | "cursor_invalid" | "limit_invalid";
  readonly detail: string;
};

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
    }
  | CatalogueRefusal;

/** The catalogue as a whole, as a reader compares it, with what `rev` is made from. */
export interface CatalogueState extends CatalogueSummary {
  /** What a version 2 page lists; `count` is what a version 1 page lists. */
  readonly count_v2: number;
  /** The last position in the feed: any write moves it. */
  readonly seq: number;
  /** The policies document's `rev`. */
  readonly policies_rev: string;
}

interface Cursor {
  readonly seq: number;
  readonly id: string;
}

/** Version 2's cursors begin so: version 1's are bare base64url, which never holds a full stop. */
const V2_CURSOR = "v2.";

function encodeCursor(c: Cursor, version: Version): string {
  const bare = b64u(new TextEncoder().encode(`${c.seq}.${c.id}`));
  return version === 2 ? `${V2_CURSOR}${bare}` : bare;
}

function decodeCursor(text: string, version: Version): Cursor | null {
  const v2 = text.startsWith(V2_CURSOR);
  if (v2 !== (version === 2)) return null;
  const bare = v2 ? text.slice(V2_CURSOR.length) : text;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(bare)) return null;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(unb64u(bare));
  } catch {
    return null;
  }
  const m = /^(\d{1,15})\.([0-9A-Za-z_-]{1,64})$/.exec(decoded);
  return m ? { seq: Number(m[1]), id: m[2] as string } : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

const refuse = (code: CatalogueRefusal["code"], detail: string): CatalogueRefusal => ({ status: 422, code, detail });

/** The version a read names: 1 when it names none, as every reader did before version 2. */
function versionOf(raw: string | undefined): Version | CatalogueRefusal {
  if (raw === undefined || raw === "") return 1;
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return refuse("version_unsupported", "This feed serves catalogue versions 1 and 2: ask version=2, or version=1.");
}

function limitOf(raw: string | number | undefined): number | CatalogueRefusal {
  if (raw === undefined || raw === "") return CATALOGUE_PAGE_MAX;
  const n = typeof raw === "number" ? raw : /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > CATALOGUE_PAGE_MAX) {
    return refuse("limit_invalid", `limit is 1 to ${CATALOGUE_PAGE_MAX}; ask ${CATALOGUE_PAGE_MAX}.`);
  }
  return n;
}

/** Where the counts of the catalogue as last built are kept (`instance_meta`), with what they were built from. */
const COUNTS_KEY = "catalogue_counts";

/**
 * Whether the items say the legal right to withdraw: only where the inbox applies one, by the business's
 * own country (`lawOf` is not `other`, ADR-018 Amendment 7), never by the buyer's or where the goods go.
 */
function saysWithdrawal(settings: Settings): boolean {
  return lawOf(settings.commerce.legal.country) !== "other";
}

/** The counts of the catalogue as built, and the basis they hold for. */
interface Counts {
  readonly basis: string;
  readonly count: number;
  readonly count_v2: number;
}

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
   * What a reader compares: how many each version lists, the latest change, whether prices include tax,
   * and `rev`, which moves with any of them, with any write at all, with the policies document, and with
   * the business's site, which decides the product pages the items name. One `rev` for both versions.
   * Time moves the feed first (`catalogueClockStatements`), and so does whether the items say the legal
   * right to withdraw (`catalogueWithdrawalStatements`).
   *
   * The counts are what the pages list, counted from the items as they are built (`countsOf`), never
   * from a SQL twin of the reader's rules: a network holds a source whose page `count` differs from what
   * it read, and every rule a reader holds an item for would need its twin kept in step.
   */
  async summary(
    settings?: Settings,
    ctx?: CatalogueContext,
    policies?: PoliciesState,
    now = Date.now(),
  ): Promise<CatalogueState> {
    const [s, c] = await Promise.all([settings ?? readSettings(this.db), ctx ?? this.context()]);
    await this.db.batch([
      ...catalogueClockStatements(now),
      ...(await catalogueWithdrawalStatements(this.db, saysWithdrawal(s), now)),
    ]);
    const p = policies ?? (await loadPolicies(this.db, s, { published: true }));
    const basis = await this.basis(c, p);
    const counts = await this.countsOf(basis, c, p, now, saysWithdrawal(s));
    const tax = s.catalogue.taxIncluded;
    const rev = (
      await bodySha256(
        canonicalJson({
          count: counts.count,
          count_v2: counts.count_v2,
          basis: basis.key,
          tax_included: tax,
        }),
      )
    ).slice(0, 16);
    return {
      count: counts.count,
      count_v2: counts.count_v2,
      updated_at: basis.updated === null ? null : iso(basis.updated),
      tax_included: tax,
      rev,
      seq: basis.seq,
      policies_rev: p.rev,
    };
  }

  /**
   * What the items are built from, as one key (an indexed pass over `products`): the latest change and
   * position, how many rows, the sum of their moments (so a write that moves neither still moves it),
   * the policies document and the business's site. The counts of the items as built hold while it does.
   */
  private async basis(
    ctx: CatalogueContext,
    policies: PoliciesState,
  ): Promise<{ key: string; updated: number | null; seq: number }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT MAX(updated_at), COALESCE(MAX(catalogue_seq), 0), COUNT(*), CAST(COALESCE(SUM(updated_at), 0) AS TEXT)
              FROM products`,
      method: "all",
    });
    const r = rows[0] ?? [null, 0, 0, "0"];
    const updated = r[0] === null || r[0] === undefined ? null : Number(r[0]);
    const seq = Number(r[1] ?? 0);
    const key = canonicalJson({
      updated_at: updated,
      seq,
      rows: Number(r[2] ?? 0),
      moments: String(r[3] ?? "0"),
      sites: ctx.sites,
      policies_rev: policies.rev,
    });
    return { key, updated, seq };
  }

  /**
   * How many items each version's pages list, counted from the items as built, the very pass a page
   * makes (`catalogueItemV2`, then `catalogueItemV1Of`): exact whatever a reader holds an item for. Kept
   * with the basis it was built from, so a full pass is made only when something changed.
   */
  private async countsOf(
    basis: { readonly key: string },
    ctx: CatalogueContext,
    policies: PoliciesState,
    now: number,
    withdrawal: boolean,
  ): Promise<Counts> {
    const { rows } = await this.db.client.query({
      sql: "SELECT value FROM instance_meta WHERE key = ?",
      params: [COUNTS_KEY],
      method: "all",
    });
    const kept = parseCounts(rows[0]?.[0]);
    if (kept && kept.basis === basis.key) return kept;
    const as_of = iso(now);
    let count = 0;
    let countV2 = 0;
    for await (const page of this.everyItem(ctx, policies, now, withdrawal)) {
      for (const b of page) {
        if (b.item.state !== "listed") continue;
        countV2++;
        if ((await catalogueItemV1Of(b.item, { as_of }))?.state === "listed") count++;
      }
    }
    const counts: Counts = { basis: basis.key, count, count_v2: countV2 };
    // Kept only while nothing changed during the pass: else the next read counts again.
    if ((await this.basis(ctx, policies)).key === basis.key) {
      await this.db.client.query({
        sql: `INSERT INTO instance_meta (key, value, created_at) VALUES (?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        params: [COUNTS_KEY, JSON.stringify(counts), now],
        method: "run",
      });
    }
    return counts;
  }

  /** What the hourly signed ping says of the products: listed, with what a reader compares (version 2's count). */
  async pingMember(settings: Settings): Promise<PingCatalogue> {
    const s = await this.summary(settings);
    return { listed: true, count: s.count_v2, updated_at: s.updated_at, rev: s.rev };
  }

  /** `GET /v1/catalogue/changes`: one page of the version asked, from the start or from `after`. */
  async changes(input: ChangesQuery, req: CatalogueRequest): Promise<CatalogueResponse> {
    const version = versionOf(input.version);
    if (typeof version !== "number") return version;
    const limit = limitOf(input.limit);
    if (typeof limit !== "number") return limit;
    const cursor = input.after ? decodeCursor(input.after, version) : null;
    if (input.after && !cursor) {
      return refuse(
        "cursor_invalid",
        `after: not a cursor this feed gave for version ${version}; start again without it.`,
      );
    }
    const settings = await readSettings(this.db);
    if (!this.served(settings)) return { status: 404, why: "not_listed" };
    if (!this.keys) return { status: 404, why: "cannot_sign" };
    const ctx = await this.context();
    const policies = await loadPolicies(this.db, settings, { published: true });
    const summary = await this.summary(settings, ctx, policies, req.now);
    const etag = `"${summary.rev}-v${version}-${input.after ?? "0"}-${limit}"`;
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
    const built = await this.build(pageRows, ctx, policies, req.now, saysWithdrawal(settings));
    const last = pageRows.at(-1);
    const next_cursor = more && last ? encodeCursor({ seq: last.catalogueSeq, id: last.id }, version) : null;
    const as_of = iso(req.now);
    let body: string;
    if (version === 2) {
      const page: CataloguePageV2 = {
        version: 2,
        domain: req.domain,
        as_of,
        catalogue: {
          count: summary.count_v2,
          updated_at: summary.updated_at,
          tax_included: summary.tax_included,
          rev: summary.rev,
          policies_rev: summary.policies_rev,
        },
        items: built.map((b) => b.item),
        next_cursor,
      };
      body = JSON.stringify(page);
    } else {
      const page: CataloguePage = {
        version: 1,
        domain: req.domain,
        as_of,
        catalogue: {
          count: summary.count,
          updated_at: summary.updated_at,
          tax_included: summary.tax_included,
          rev: summary.rev,
        },
        items: await v1Items(built, as_of),
        next_cursor,
      };
      body = JSON.stringify(page);
    }
    return this.signed(body, summary.rev, as_of, req, { etag, cacheControl: "public, max-age=60" });
  }

  /** `GET /v1/catalogue/items`: these products, in the version asked, and the ids it has none for. */
  async items(
    ids: readonly string[],
    req: CatalogueRequest,
    input: { readonly version?: string | undefined } = {},
  ): Promise<CatalogueResponse> {
    const version = versionOf(input.version);
    if (typeof version !== "number") return version;
    // An id longer than the version's ids may be is left out of `missing`, not echoed.
    const fits = (id: string) => (version === 1 ? id.length <= 64 : catalogueIdV2Schema.safeParse(id).success);
    const wanted = [...new Set(ids)].filter(fits).slice(0, CATALOGUE_ITEMS_MAX);
    const settings = await readSettings(this.db);
    if (!this.served(settings)) return { status: 404, why: "not_listed" };
    if (!this.keys) return { status: 404, why: "cannot_sign" };
    const ctx = await this.context();
    const policies = await loadPolicies(this.db, settings, { published: true });
    const summary = await this.summary(settings, ctx, policies, req.now);
    const rows = wanted.length ? await this.db.orm.select().from(products).where(inArray(products.id, wanted)) : [];
    const built = new Map(
      (await this.build(rows, ctx, policies, req.now, saysWithdrawal(settings))).map((b) => [b.item.id, b] as const),
    );
    const found: BuiltItem[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
      const b = built.get(id);
      if (b) found.push(b);
      else missing.push(id);
    }
    const as_of = iso(req.now);
    const body =
      version === 2
        ? JSON.stringify({ version: 2, items: found.map((b) => b.item), missing })
        : JSON.stringify({ items: await v1Items(found, as_of), missing });
    return this.signed(body, summary.rev, as_of, req, {
      etag: `"${summary.rev}-v${version}-items"`,
      cacheControl: "no-store",
    });
  }

  /** `GET /v1/catalogue/policies`: the shipping profiles and return policies version 2 items name, signed. */
  async policies(req: CatalogueRequest): Promise<CatalogueResponse> {
    const settings = await readSettings(this.db);
    if (!this.served(settings)) return { status: 404, why: "not_listed" };
    if (!this.keys) return { status: 404, why: "cannot_sign" };
    const state = await loadPolicies(this.db, settings, { published: true });
    const etag = `"${state.rev}-policies"`;
    if (req.ifNoneMatch?.split(",").some((t) => t.trim() === etag)) return { status: 304, etag };
    const as_of = iso(req.now);
    const body = JSON.stringify(policiesDocument(state, req.domain, as_of));
    return this.signed(body, state.rev, as_of, req, { etag, cacheControl: "public, max-age=300" });
  }

  /**
   * Each product as version 2 has it, and why any on sale and listed is withdrawn or has members left out:
   * for the owner's page (`catalogueStatus`), in the codes and words a network would use.
   */
  async problems(now = Date.now()): Promise<Map<string, readonly CatalogueProblem[]>> {
    const settings = await readSettings(this.db);
    const [ctx, policies] = await Promise.all([this.context(), loadPolicies(this.db, settings, { published: true })]);
    const out = new Map<string, readonly CatalogueProblem[]>();
    for await (const page of this.everyItem(ctx, policies, now, saysWithdrawal(settings))) {
      for (const b of page) if (b.problems.length) out.set(b.item.id, b.problems);
    }
    return out;
  }

  /** Every product as version 2 builds it, a page of the feed's order at a time. */
  private async *everyItem(
    ctx: CatalogueContext,
    policies: PoliciesState,
    now: number,
    withdrawal: boolean,
  ): AsyncGenerator<readonly BuiltItem[]> {
    let after: Cursor | null = null;
    for (;;) {
      const rows = await this.db.orm
        .select()
        .from(products)
        .where(
          after
            ? or(
                gt(products.catalogueSeq, after.seq),
                and(eq(products.catalogueSeq, after.seq), gt(products.id, after.id)),
              )
            : undefined,
        )
        .orderBy(asc(products.catalogueSeq), asc(products.id))
        .limit(CATALOGUE_PAGE_MAX);
      yield await this.build(rows, ctx, policies, now, withdrawal);
      const last = rows.at(-1);
      if (!last || rows.length < CATALOGUE_PAGE_MAX) return;
      after = { seq: last.catalogueSeq, id: last.id };
    }
  }

  private async build(
    rows: readonly (typeof products.$inferSelect)[],
    ctx: CatalogueContext,
    policies: PoliciesState,
    now: number,
    /** Whether the items say the legal right to withdraw (`saysWithdrawal`). */
    withdrawal: boolean,
  ): Promise<BuiltItem[]> {
    const groupIds = [...new Set(rows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
    const groups = new Map<string, { title: string }>();
    for (let i = 0; i < groupIds.length; i += 90) {
      const found = await this.db.orm
        .select({ id: productGroups.id, title: productGroups.title })
        .from(productGroups)
        .where(inArray(productGroups.id, groupIds.slice(i, i + 90)));
      for (const g of found) groups.set(g.id, { title: g.title });
    }
    const history = await priceHistory(
      this.db,
      rows.filter((r) => r.listPrice !== null).map((r) => r.id),
    );
    const v2: CatalogueV2Context = {
      sites: ctx.sites,
      now,
      policies,
      groups,
      history,
      withdrawal,
    };
    const out: BuiltItem[] = [];
    for (const row of rows) out.push(await catalogueItemV2(row, v2));
    return out;
  }

  private async signed(
    body: string,
    rev: string,
    asOf: string,
    req: CatalogueRequest,
    opts: { etag: string; cacheControl: string },
  ): Promise<CatalogueResponse> {
    const key = await (this.keys as KeyStore).active();
    const signature = await signCatalogue(
      { iss: req.domain, url: req.url, body_sha256: await bodySha256(body), as_of: asOf, rev },
      key,
    );
    return { status: 200, body, etag: opts.etag, signature, cacheControl: opts.cacheControl };
  }
}

function parseCounts(raw: unknown): Counts | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Counts>;
    return typeof v.basis === "string" && Number.isInteger(v.count) && Number.isInteger(v.count_v2)
      ? { basis: v.basis, count: v.count as number, count_v2: v.count_v2 as number }
      : null;
  } catch {
    return null;
  }
}

/** The version 1 items of a page: each version 2 item as version 1 says it (`catalogueItemV1Of`). */
async function v1Items(built: readonly BuiltItem[], asOf: string): Promise<CatalogueItem[]> {
  const out: CatalogueItem[] = [];
  for (const b of built) {
    const v1 = await catalogueItemV1Of(b.item, { as_of: asOf });
    if (v1) out.push(v1);
  }
  return out;
}
