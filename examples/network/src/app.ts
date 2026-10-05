import {
  InstanceSignatureError,
  instanceDomainOf,
  ReceiptVerificationError,
  receiptSha,
  verifyInstanceRequest,
  verifyReceipt,
} from "@surfingdog/sdk";
import {
  getBusinessInputSchema,
  listCategoriesInputSchema,
  parseReceiptClaims,
  pingRequestSchema,
  searchBusinessesInputSchema,
} from "@surfingdog/spec";
import categories from "@surfingdog/spec/vocab/categories.json" with { type: "json" };
import { type Context, Hono } from "hono";
import { z } from "zod";
import { fold, httpManifestFetcher, type ManifestFetcher, shownOf, validDomain } from "./manifest.js";
import { type Business, Store } from "./store.js";

/**
 * A network at the directory level of the Surfing Dog network protocol (§10.1): it verifies an
 * inbox by its manifest, takes its pings, lists it unless it leaves, keeps the receipts it
 * publishes, and serves the directory, newest verified first. It gives customers no keys, so every
 * call of §5 is `404 not_found`, and it says all of this in its rules' `protocol`.
 *
 *   const network = createNetwork({ origin: "https://network.example.org" });
 *   serve({ fetch: network.app.fetch, port: 8080 });
 *
 * Run behind a proxy that terminates TLS on the origin's host: signatures name that host
 * (`@authority`), never the port this listens on.
 */

export interface NetworkOptions {
  /** This network's origin, `https://<host>`: the host every signature must name. */
  readonly origin: string;
  /** The SQLite file; in memory by default. */
  readonly database?: string | undefined;
  /** How manifests are read; `httpManifestFetcher()` by default. */
  readonly fetchManifest?: ManifestFetcher | undefined;
  /** Milliseconds; the clock by default. */
  readonly now?: (() => number) | undefined;
}

/** The rules: version 1 of this network's own, and what it offers (§10). */
export const RULES_EFFECTIVE_AT = "2026-10-06T00:00:00Z";
export const RULES = {
  version: 1,
  status: "in_force",
  published_at: RULES_EFFECTIVE_AT,
  effective_at: RULES_EFFECTIVE_AT,
  summary:
    "Businesses are listed newest verified first. Nothing else orders the directory: no score, no payment, and nothing a business says about itself. A business may leave the directory and come back whenever it likes.",
  next: null,
  protocol: { level: "directory", claims: 2 },
  never_used: ["advertising", "payment", "receipts", "anything a profile says", "who is searching"],
} as const;

/** The claims this network takes: 2, so it reads them as rules version 5 does (no refunds, no amendments). */
const CLAIMS_RULES = 5;
const MAX_BODY = 64 * 1024;
const ANSWERING_MS = 24 * 3_600_000;

export function createNetwork(options: NetworkOptions): { app: Hono; store: Store; refresh: () => Promise<void> } {
  const origin = new URL(options.origin).origin;
  const host = new URL(origin).host;
  const store = new Store(options.database);
  const fetchManifest = options.fetchManifest ?? httpManifestFetcher();
  const now = options.now ?? (() => Date.now());
  const app = new Hono();

  const problem = (c: Context, status: number, code: string, detail: string) =>
    c.body(
      JSON.stringify({ type: "about:blank", title: code.replace(/_/g, " "), status, code, detail }),
      status as 400,
      {
        "Content-Type": "application/problem+json",
      },
    );

  /** Reads a body of at most 64 KB as JSON; a problem answer when it is too large or not JSON. */
  const bodyOf = async (c: Context): Promise<{ text: string; json: unknown } | Response> => {
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY)
      return problem(c, 413, "too_large", "A body is at most 64 KB.");
    try {
      return { text, json: JSON.parse(text) as unknown };
    } catch {
      return problem(c, 400, "malformed", "The body is not JSON.");
    }
  };

  /** Fetches a domain's manifest and records what it said, or why it could not be read. */
  const verify = async (domain: string): Promise<void> => {
    const got = await fetchManifest(domain);
    if (got.ok) store.verified(domain, got.manifest, got.keys, now());
    else store.failed(domain, got.error, now());
  };

  /**
   * Checks an sdi-instance/1 signature and records it as used. The verdict, or a problem answer:
   * `401` with the code §3 names, `replayed_signature` for one already seen.
   */
  const signedBy = async (c: Context, body: string): Promise<{ domain: string } | Response> => {
    try {
      const v = await verifyInstanceRequest({
        method: c.req.method,
        url: c.req.url,
        headers: c.req.raw.headers,
        body,
        authorities: [host],
        now: now(),
        keysFor: async (domain) => {
          const b = store.business(domain);
          return b?.verifiedAt ? (b.keys as never) : null;
        },
      });
      if (!store.useSignature(v.replayKey, v.replayUntil, now())) {
        return problem(c, 401, "replayed_signature", "This signature was already used: sign each request afresh.");
      }
      return { domain: v.domain };
    } catch (e) {
      if (e instanceof InstanceSignatureError) return problem(c, 401, e.code, e.message);
      throw e;
    }
  };

  /* --- instances (§4.1, §4.5) --- */

  app.post("/v1/instances", async (c) => {
    const body = await bodyOf(c);
    if (body instanceof Response) return body;
    const domain = (body.json as { domain?: unknown } | null)?.domain;
    if (!validDomain(domain))
      return problem(c, 400, "bad_payload", "domain is a lowercase host name, like inbox.example.com.");
    store.register(domain);
    await verify(domain);
    const b = store.business(domain) as Business;
    return c.json(
      {
        domain,
        status: b.status,
        status_url: `${origin}/v1/instances/${domain}/status`,
        manifest_url: `https://${domain}/.well-known/agent-inbox.json`,
        message:
          b.status === "verified"
            ? "Verified: the manifest names this domain. Ping hourly."
            : `Not verified yet: ${b.lastError ?? "the manifest could not be read"}. Registering again tries again.`,
      },
      202,
    );
  });

  app.get("/v1/instances/:domain/status", (c) => {
    const b = store.business(c.req.param("domain"));
    if (!b) return problem(c, 404, "not_found", "No instance with that domain is registered here.");
    return c.json({
      domain: b.domain,
      status: b.status,
      listed: b.listed && b.verifiedAt !== null,
      delisted_at: iso(b.delistedAt),
      dormant_since: null,
      verified_at: iso(b.verifiedAt),
      last_checked_at: iso(b.lastCheckedAt),
      last_ping_at: iso(b.lastPingAt),
      fail_count: b.failCount,
      manifest_url: `https://${b.domain}/.well-known/agent-inbox.json`,
    });
  });

  app.post("/v1/instances/:domain/ping", async (c) => {
    const domain = c.req.param("domain");
    const b = store.business(domain);
    if (!b) return problem(c, 404, "not_found", "Register first: POST /v1/instances.");
    const body = await bodyOf(c);
    if (body instanceof Response) return body;
    const ping = pingRequestSchema.safeParse(body.json);
    if (!ping.success)
      return problem(c, 400, "bad_payload", "A ping is {version, runtime, counts?, manifest_sha256?}.");
    if (!c.req.header("signature-input")) {
      store.pinged(domain, { version: ping.data.version, runtime: ping.data.runtime }, now());
      return c.body(null, 204);
    }
    const signed = await signedBy(c, body.text);
    const reason = signed instanceof Response ? ((await signed.clone().json()) as { code: string }).code : null;
    // A signature used before is refused on every call, a ping included (§3).
    if (signed instanceof Response && reason === "replayed_signature") return signed;
    // A signature that fails, or one by another domain, is a ping all the same (§4.1).
    store.pinged(domain, { version: ping.data.version, runtime: ping.data.runtime }, now());
    if (signed instanceof Response || signed.domain !== domain) {
      return c.body(null, 204, { "Sdi-Signature": `invalid; reason="${reason ?? "unknown_instance"}"` });
    }
    const fresh = store.business(domain) as Business;
    return c.json({
      ok: true,
      rules: { version: RULES.version, effective_at: RULES.effective_at },
      next_rules: null,
      reports: [],
      contests: [],
      listing: { listed: fresh.listed, delisted_at: iso(fresh.delistedAt), dormant_since: null },
    });
  });

  app.post("/v1/instances/:domain/listing", async (c) => {
    const domain = c.req.param("domain");
    const body = await bodyOf(c);
    if (body instanceof Response) return body;
    const signed = await signedBy(c, body.text);
    if (signed instanceof Response) return signed;
    if (signed.domain !== domain)
      return problem(c, 401, "unknown_instance", "Only the domain's own key changes its listing.");
    const listed = (body.json as { listed?: unknown } | null)?.listed;
    if (typeof listed !== "boolean") return problem(c, 400, "bad_payload", "The body is {listed: true | false}.");
    if (!store.setListed(domain, listed, now())) return problem(c, 429, "rate_limited", "At most 10 changes a day.");
    const b = store.business(domain) as Business;
    return c.json({
      domain,
      listed: b.listed,
      delisted_at: iso(b.delistedAt),
      dormant_since: null,
      shown_from: b.listed ? iso(now()) : null,
    });
  });

  /* --- receipts (§4.2) --- */

  app.post("/v1/receipts", async (c) => {
    const body = await bodyOf(c);
    if (body instanceof Response) return body;
    const { receipt, ack } = (body.json ?? {}) as { receipt?: unknown; ack?: unknown };
    if (typeof receipt !== "string") return problem(c, 422, "malformed", "receipt is a compact JWS.");
    const payload = payloadOf(receipt);
    if (!payload) return problem(c, 422, "malformed", "receipt is not a compact JWS with a JSON payload.");
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    const domain = instanceDomainOf(iss);
    const b = domain ? store.business(domain) : null;
    if (!domain || !b?.verifiedAt)
      return problem(c, 404, "unknown_issuer", "The issuer is not a member of this network.");
    const verifyAgainst = async (keys: readonly unknown[]) => verifyReceipt(receipt, keys as never, { now: now() });
    try {
      try {
        await verifyAgainst(b.keys);
      } catch (e) {
        // An unknown kid: the inbox may have a new key. Read its manifest once more, then decide.
        if (!(e instanceof ReceiptVerificationError) || e.code !== "unknown_key") throw e;
        await verify(domain);
        await verifyAgainst((store.business(domain) as Business).keys);
      }
    } catch (e) {
      if (e instanceof ReceiptVerificationError) {
        const code = e.code === "wrong_issuer" ? "bad_payload" : e.code;
        return problem(c, 422, code, e.message);
      }
      throw e;
    }
    const parsed = parseReceiptClaims(payload, { rules: CLAIMS_RULES });
    if (!parsed) return problem(c, 422, "bad_payload", "The claims are not v1 or v2 claims this network takes.");
    const claims = parsed.claims as {
      iat: number;
      nonce: string;
      knd: string;
      typ: string;
      out?: string;
      ref?: string;
      sub: string;
    };
    if (claims.iat > Math.floor(now() / 1000) + 300) return problem(c, 422, "not_yet", "iat is more than 300 s ahead.");
    let acknowledged = false;
    if (ack !== undefined) {
      const checked = await checkAck(ack, receipt);
      if (checked !== true) return problem(c, 422, `ack_${checked}`, "The acknowledgement did not verify.");
      acknowledged = true;
    }
    const held = store.receipt(iss, claims.nonce);
    if (held) {
      if (held.jws !== receipt)
        return problem(c, 409, "nonce_reused", "This issuer already sent a different receipt with this nonce.");
      if (acknowledged && !held.acknowledged) {
        store.acknowledge(iss, claims.nonce);
        return c.json({ ok: true, state: "acknowledged", duplicate: false });
      }
      return c.json({ ok: true, state: held.acknowledged ? "acknowledged" : "issued", duplicate: true });
    }
    if (claims.knd === "outcome" && !store.receipt(iss, claims.ref ?? "")) {
      return problem(c, 422, "unknown_ref", "Publish the outcome's promise first.");
    }
    store.keepReceipt(
      {
        iss,
        nonce: claims.nonce,
        jws: receipt,
        kind: claims.knd,
        typ: claims.typ,
        out: claims.out ?? null,
        sub: claims.sub,
      },
      acknowledged,
      now(),
    );
    return c.json({ ok: true, state: acknowledged ? "acknowledged" : "issued", duplicate: false }, 201);
  });

  /* --- the directory (§4.3) --- */

  const listingOf = (b: Business) => {
    const shown = shownOf(b.domain, b.manifest);
    const t = store.tally(`https://${b.domain}`);
    const answering = b.lastPingAt !== null && now() - b.lastPingAt < ANSWERING_MS;
    return {
      listing: {
        domain: b.domain,
        ...shown,
        open_now: null,
        manifest_url: `https://${b.domain}/.well-known/agent-inbox.json`,
        verified_at: iso(b.verifiedAt) as string,
        ...(b.lastPingAt ? { last_ping_at: iso(b.lastPingAt) } : {}),
        ...(b.software ? { software: b.software } : {}),
        receipts: {
          issued: t.issued,
          acknowledged: t.acknowledged,
          customers: t.customers,
          ...(t.lastAt ? { last_at: iso(t.lastAt) } : {}),
        },
        answering,
        online: answering,
        not_answering_since: answering ? null : iso(b.lastPingAt ? b.lastPingAt + ANSWERING_MS : b.verifiedAt),
      },
      outcomes: t.outcomes,
    };
  };

  type Listing = ReturnType<typeof listingOf>["listing"];

  /**
   * One page of the directory: newest verified first, every filter only leaving businesses out, so
   * the page is filled from as far as it takes. The REST door and the MCP tools both read it.
   */
  const search = (p: {
    q?: string | undefined;
    category?: string | undefined;
    language?: string | undefined;
    itemType?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): { businesses: Listing[]; next: string | null } | { status: 400 | 410; code: string; detail: string } => {
    const limit = Math.min(Math.max(Math.trunc(p.limit ?? 20) || 20, 1), 100);
    let after: { v: number; d: string } | null = null;
    if (p.cursor) {
      try {
        const v = JSON.parse(Buffer.from(p.cursor, "base64url").toString("utf8")) as { v?: unknown; d?: unknown };
        if (typeof v.v !== "number" || typeof v.d !== "string") throw new Error("cursor");
        after = { v: v.v, d: v.d };
      } catch {
        return { status: 410, code: "cursor_expired", detail: "Start again without a cursor." };
      }
    }
    const q = (p.q ?? "").trim();
    const words = fold(q)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1);
    if (q && words.length === 0) return { status: 400, code: "bad_payload", detail: "q has no word to look for." };
    const category = p.category;
    const slug = category ? categorySlug(category) : undefined;
    const language = p.language?.toLowerCase();
    const out: Listing[] = [];
    let last: Business | undefined;
    let more = false;
    for (let scanned = 0; scanned < 5_000; ) {
      const batch = store.listed(last ? { v: last.verifiedAt as number, d: last.domain } : after, 200);
      if (batch.length === 0) break;
      for (const b of batch) {
        scanned++;
        last = b;
        const { listing } = listingOf(b);
        const text = fold(
          [
            listing.name,
            listing.description ?? "",
            ...listing.categories,
            ...listing.tags,
            ...(listing.services ?? []).map((s) => s.name),
          ].join(" "),
        );
        if (words.some((w) => !text.includes(w))) continue;
        if (
          category &&
          !(slug ? listing.categories.includes(slug) : listing.tags.some((t) => fold(t) === fold(category)))
        )
          continue;
        if (
          language &&
          !listing.languages.some((l) => l.toLowerCase() === language || l.toLowerCase().startsWith(`${language}-`))
        )
          continue;
        if (p.itemType && !listing.item_types.includes(p.itemType)) continue;
        if (out.length === limit) {
          more = true;
          break;
        }
        out.push(listing);
      }
      if (more) break;
    }
    const tail = out.at(-1);
    const next =
      more && tail
        ? Buffer.from(JSON.stringify({ v: Date.parse(tail.verified_at), d: tail.domain })).toString("base64url")
        : null;
    return { businesses: out, next };
  };

  app.get("/v1/businesses", (c) => {
    const found = search({
      q: c.req.query("q"),
      category: c.req.query("category"),
      language: c.req.query("language"),
      itemType: c.req.query("item_type"),
      limit: Number.parseInt(c.req.query("limit") ?? "20", 10),
      cursor: c.req.query("cursor"),
    });
    if ("code" in found) return problem(c, found.status, found.code, found.detail);
    return c.json({ businesses: found.businesses, next_cursor: found.next });
  });

  app.get("/v1/businesses/:domain", (c) => {
    const b = store.business(c.req.param("domain"));
    if (!b?.verifiedAt) return problem(c, 404, "not_found", "No business with that domain is listed here.");
    if (!b.listed) return problem(c, 404, "not_found", "That business left the directory.");
    const { listing, outcomes } = listingOf(b);
    return c.json({ ...listing, outcomes });
  });

  app.get("/v1/categories", (c) =>
    c.json({
      version: (categories as { version: number }).version,
      categories: (categories as { categories: { slug: string; labels: Record<string, string> }[] }).categories.map(
        ({ slug, labels }) => ({ slug, labels }),
      ),
    }),
  );

  /* --- the rules (§4.4, §10) --- */

  app.get("/v1/ranking", (c) => {
    const v = c.req.query("version");
    if (v !== undefined && v !== String(RULES.version)) return problem(c, 404, "not_found", "No such rules version.");
    return c.json({ ...RULES, url: `${origin}/v1/ranking?version=${RULES.version}` });
  });

  app.get("/llms.txt", (c) =>
    c.text(
      [
        `# ${host}`,
        "",
        "> A directory of businesses that take bookings, orders and quote requests through their own inboxes.",
        "",
        `- Search: GET ${origin}/v1/businesses?q=&category=&language=&item_type=&limit=&cursor=`,
        `- One business: GET ${origin}/v1/businesses/{domain}; its protocols name where to book or order.`,
        `- How this directory is ordered: GET ${origin}/v1/ranking`,
        "",
      ].join("\n"),
    ),
  );

  /* --- assistants (§4.7) --- */

  /** A listing as an assistant reads it from the tools (the spec's businessCardSchema). */
  const cardOf = (l: Listing) => ({
    domain: l.domain,
    name: l.name,
    ...(l.description ? { description: l.description } : {}),
    ...(l.url ? { website: l.url } : {}),
    categories: l.categories,
    tags: l.tags,
    languages: l.languages,
    takes: l.item_types,
    services: l.services ?? [],
    open_now: null,
    hours_today: null,
    answering: l.answering,
    inbox: {
      url: `https://${l.domain}`,
      ...(l.protocols.mcp ? { mcp: l.protocols.mcp } : {}),
      ...(l.protocols.rest ? { rest: l.protocols.rest } : {}),
      ...(l.protocols.openapi ? { openapi: l.protocols.openapi } : {}),
    },
    listing_url: `${origin}/v1/businesses/${l.domain}`,
  });

  const TOOLS = [
    {
      name: "search_businesses",
      description:
        "Find businesses in this directory that take bookings, orders or quote requests through their own inboxes. Newest first; no one pays to move. Each result names the inbox where you book or order.",
      inputSchema: z.toJSONSchema(searchBusinessesInputSchema),
    },
    {
      name: "get_business",
      description: "One business in this directory, by its domain: what it does and where its inbox is.",
      inputSchema: z.toJSONSchema(getBusinessInputSchema),
    },
    {
      name: "list_categories",
      description: "The categories businesses here may name, with English and Portuguese labels.",
      inputSchema: z.toJSONSchema(listCategoriesInputSchema),
    },
  ];

  const callTool = (name: string, args: unknown): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (name === "search_businesses") {
      const input = searchBusinessesInputSchema.safeParse(args ?? {});
      if (!input.success) return { ok: false, error: input.error.issues[0]?.message ?? "invalid arguments" };
      if (input.data.near || input.data.open_now) {
        // This directory keeps no places and no hours: say so rather than answer as if it did.
        return {
          ok: false,
          error: "This directory has no locations or opening hours: search by words, category or language.",
        };
      }
      const found = search({
        q: input.data.query,
        category: input.data.category,
        language: input.data.language,
        itemType: input.data.item_type,
        cursor: input.data.cursor,
      });
      if ("code" in found) return { ok: false, error: found.detail };
      return {
        ok: true,
        value: {
          businesses: found.businesses.map(cardOf),
          next_cursor: found.next,
          rules: { version: RULES.version, url: `${origin}/v1/ranking?version=${RULES.version}` },
        },
      };
    }
    if (name === "get_business") {
      const input = getBusinessInputSchema.safeParse(args ?? {});
      if (!input.success) return { ok: false, error: "domain is required" };
      const b = store.business(input.data.domain.toLowerCase());
      if (!b?.verifiedAt || !b.listed) return { ok: false, error: "No business with that domain is listed here." };
      const { listing, outcomes } = listingOf(b);
      return { ok: true, value: { ...cardOf(listing), outcomes } };
    }
    if (name === "list_categories") {
      return {
        ok: true,
        value: {
          version: (categories as { version: number }).version,
          categories: (categories as { categories: { slug: string; labels: Record<string, string> }[] }).categories.map(
            ({ slug, labels }) => ({ slug, labels }),
          ),
        },
      };
    }
    return { ok: false, error: `No tool named ${name}.` };
  };

  // MCP over Streamable HTTP, stateless: one JSON-RPC message per POST, answered as JSON.
  app.post("/mcp", async (c) => {
    const body = await bodyOf(c);
    if (body instanceof Response) return body;
    const msg = body.json as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
    } | null;
    const id = msg?.id ?? null;
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => c.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Not a JSON-RPC 2.0 request.");
    if (msg.id === undefined) return c.body(null, 202); // a notification: nothing to answer
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: host, version: "0.1.0" },
          instructions:
            "A directory of businesses that take bookings, orders and quote requests through their own inboxes. Search it, then book or order at the inbox a result names.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        const out = callTool(name, msg.params?.arguments);
        if (!out.ok) return reply({ content: [{ type: "text", text: out.error }], isError: true });
        return reply({ content: [{ type: "text", text: JSON.stringify(out.value) }], structuredContent: out.value });
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  });

  // Everything else of §4 and §5 is the full level's, which this network does not offer (§10.1).
  app.all("*", (c) => problem(c, 404, "not_found", "This network is at the directory level and does not offer that."));

  /** Reads every member's manifest again: what a server does every six hours (§4.1). */
  const refresh = async () => {
    for (const domain of store.members()) await verify(domain);
  };

  return { app, store, refresh };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function categorySlug(word: string): string | undefined {
  const f = fold(word);
  for (const c of (
    categories as {
      categories: { slug: string; labels: Record<string, string>; synonyms?: Record<string, string[]> }[];
    }
  ).categories) {
    if ([c.slug, ...Object.values(c.labels), ...Object.values(c.synonyms ?? {}).flat()].some((w) => fold(w) === f))
      return c.slug;
  }
  return undefined;
}

function payloadOf(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as unknown;
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * An acknowledgement (ADR-016): the customer's agent's JWS over `{sha, iat}`, with its key in the
 * header as `jwk`, where `sha` is base64url(SHA-256) of the receipt. True, or the code after `ack_`.
 */
async function checkAck(ack: unknown, receipt: string): Promise<true | string> {
  if (typeof ack !== "string") return "malformed";
  const parts = ack.split(".");
  if (parts.length !== 3) return "malformed";
  let header: { alg?: unknown; typ?: unknown; jwk?: { kty?: unknown; crv?: unknown; x?: unknown } };
  let payload: { sha?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  if (header.alg !== "EdDSA") return "bad_alg";
  if (header.typ !== "sdi-receipt-ack+jws") return "bad_typ";
  if (header.jwk?.kty !== "OKP" || header.jwk.crv !== "Ed25519" || typeof header.jwk.x !== "string")
    return "unknown_key";
  if (payload.sha !== (await receiptSha(receipt))) return "bad_payload";
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: header.jwk.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Buffer.from(parts[2] as string, "base64url"),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return ok ? true : "bad_signature";
  } catch {
    return "bad_signature";
  }
}
