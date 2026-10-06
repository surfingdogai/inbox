import { generateReceiptKey, type InstanceSigningKey, signInstanceRequest, signReceipt } from "@surfingdog/sdk";
import {
  businessesResponseSchema,
  categoriesResponseSchema,
  directoryRulesSchema,
  instanceRegistrationResponseSchema,
  instanceStatusSchema,
  listingDetailSchema,
  listingResponseSchema,
  type NetworkProtocol,
  protocolOf,
  rankingDocumentSchema,
  readRankingDocument,
  receiptPublishResultSchema,
  searchBusinessesOutputSchema,
  signedPingResponseSchema,
} from "@surfingdog/spec";
import doorVocabulary from "@surfingdog/spec/vocab/doors.json" with { type: "json" };
import type { z } from "zod";

/**
 * Checks a network against the Surfing Dog network protocol (docs/protocol/network.md), at the
 * level its rules say it offers (§10).
 *
 * Without `flow`, it only reads, and sends requests a correct network refuses without keeping
 * anything: a listing change with no signature or the wrong one, a forged receipt, a ping for a
 * domain nobody registered. Safe against any network, a production one included.
 *
 * With `flow`, it plays an inbox from start to finish: it publishes a manifest for `flow.domain`,
 * registers it, pings unsigned and signed, leaves the directory and comes back, and publishes
 * receipts. The network must be able to read that manifest, so `flow` is for a network in a test
 * mode (the example network's `NETWORK_TEST_MANIFESTS`), never for one others use.
 */

export type Requirement = "must" | "should";

export interface CheckResult {
  /** A short stable name, like `listing.unsigned`. */
  readonly id: string;
  /** Where the protocol says it. */
  readonly section: string;
  readonly requirement: Requirement;
  readonly outcome: "pass" | "fail" | "skip";
  readonly detail: string;
}

export interface Report {
  readonly network: string;
  /** What the network's rules say it offers; null when they could not be read. */
  readonly protocol: NetworkProtocol | null;
  /** Whether the rules said it outright (`protocol`), or it was read from their version. */
  readonly said: boolean;
  readonly results: readonly CheckResult[];
  /** Every `must` passed. */
  readonly passed: boolean;
}

export interface FlowOptions {
  /** The domain of the inbox the checker plays, as the network will be told to read it. */
  readonly domain: string;
  /** Makes the manifest readable by the network: serve it, or hand it to the network under test. */
  readonly publishManifest: (manifest: Record<string, unknown>) => Promise<void> | void;
}

export interface CheckOptions {
  /** The network's origin, `https://<host>`: what signatures name, and where requests go. */
  readonly network: string;
  /** Where requests are sent when that is not the origin (a network on this machine behind no proxy). */
  readonly base?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly flow?: FlowOptions | undefined;
  /** Milliseconds; the clock by default. */
  readonly now?: (() => number) | undefined;
  /** Called as each check finishes, for progress. */
  readonly onResult?: ((r: CheckResult) => void) | undefined;
}

const NOWHERE = "no-such-business.network-check.invalid";

export async function checkNetwork(options: CheckOptions): Promise<Report> {
  const origin = new URL(options.network).origin;
  const base = (options.base ?? origin).replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const results: CheckResult[] = [];

  const record = (r: CheckResult) => {
    results.push(r);
    options.onResult?.(r);
  };
  const check = async (
    id: string,
    section: string,
    requirement: Requirement,
    run: () => Promise<string | Skip>,
  ): Promise<boolean> => {
    try {
      const detail = await run();
      if (detail instanceof Skip) {
        record({ id, section, requirement, outcome: "skip", detail: detail.why });
        return false;
      }
      record({ id, section, requirement, outcome: "pass", detail });
      return true;
    } catch (e) {
      record({ id, section, requirement, outcome: "fail", detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  /** A request to the network: the path is signed against the origin, sent to `base`. */
  const call = async (
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string>; sign?: { domain: string; key: InstanceSigningKey } } = {},
  ): Promise<Answer> => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (init.sign) {
      const signed = await signInstanceRequest({
        method,
        url: `${origin}${path}`,
        body: init.body ?? null,
        instance: `https://${init.sign.domain}`,
        key: init.sign.key,
        now: now(),
      });
      Object.assign(headers, signed.headers);
    }
    return send(method, path, init.body, headers);
  };
  const send = async (method: string, path: string, body: string | undefined, headers: Record<string, string>) => {
    const res = await doFetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  };

  /* --- the rules, and so the level ------------------------------------------------------------ */

  let protocol: NetworkProtocol | null = null;
  let said = false;
  let rulesVersion = 0;
  await check("rules.read", "§4.4, §10", "must", async () => {
    const a = await call("GET", "/v1/ranking");
    expectStatus(a, 200);
    protocol = protocolOf(a.json);
    if (!protocol) throw new Error("the rules are not a rules document: no version, no protocol");
    said = typeof a.json === "object" && a.json !== null && "protocol" in a.json;
    rulesVersion = (a.json as { version: number }).version;
    let newer = "";
    if (said) shape(directoryRulesSchema, a.json, "rules");
    else {
      // A version this checker knows must match its schema whole; a newer one is read by what every version has.
      const read = readRankingDocument(a.json);
      if (!read.ok) shape(rankingDocumentSchema, a.json, "ADR-017 rules");
      else if (!read.known) newer = `; version ${rulesVersion} is newer than this checker; read leniently`;
    }
    return `${protocol.level} level, claims ${protocol.claims}${said ? "" : `, read from version ${rulesVersion}`}${newer}`;
  });
  const level = (protocol as NetworkProtocol | null)?.level ?? "directory";
  const claims = (protocol as NetworkProtocol | null)?.claims ?? 1;
  await check("rules.version", "§4.4", "should", async () => {
    if (!rulesVersion) return new Skip("no rules version to ask for");
    const a = await call("GET", `/v1/ranking?version=${rulesVersion}`);
    expectStatus(a, 200);
    if ((a.json as { version?: unknown })?.version !== rulesVersion)
      throw new Error("?version= answered another version");
    return `version ${rulesVersion} answers by number`;
  });

  /* --- the directory ------------------------------------------------------------------------- */

  // Any listed business, for its detail; and a listed member, for what belongs to an instance (its
  // status, its listing switch, its receipts). From protocol 0.2 a directory also lists entries
  // that are not instances (source registered or found, §4.11); before it every entry is a member.
  let listed: string | null = null;
  let member: string | null = null;
  const isMember = (b: { source?: string | undefined }) => b.source === undefined || b.source === "member";
  await check("directory.list", "§4.3", "must", async () => {
    const a = await call("GET", "/v1/businesses?limit=2");
    expectStatus(a, 200);
    const page = shape(businessesResponseSchema, a.json, "the directory");
    listed = page.businesses[0]?.domain ?? null;
    member = page.businesses.find(isMember)?.domain ?? null;
    if (listed && !member) {
      // Members may sit further down: ask for one. A network that does not know the filter is
      // left without a member to try, which skips those checks rather than failing them.
      const m = await call("GET", "/v1/businesses?source=member&limit=1");
      const parsed = m.status === 200 ? businessesResponseSchema.safeParse(m.json) : undefined;
      member = parsed?.success ? (parsed.data.businesses.find(isMember)?.domain ?? null) : null;
    }
    if (page.businesses.length > 2) throw new Error(`limit=2 answered ${page.businesses.length} businesses`);
    if (page.next_cursor) {
      const b = await call("GET", `/v1/businesses?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`);
      expectStatus(b, 200);
      const next = shape(businessesResponseSchema, b.json, "the next page");
      const seen = new Set(page.businesses.map((x) => x.domain));
      if (next.businesses.some((x) => seen.has(x.domain))) throw new Error("the next page repeats a business");
      return `${page.businesses.length} on the first page, and the cursor goes on`;
    }
    return `${page.businesses.length} listed`;
  });
  await check("directory.unknown", "§4.3", "must", async () => {
    expectProblem(await call("GET", `/v1/businesses/${NOWHERE}`), 404, ["not_found"]);
    return "404 not_found";
  });
  await check("directory.categories", "§4.3", "should", async () => {
    const a = await call("GET", "/v1/categories");
    expectStatus(a, 200);
    shape(categoriesResponseSchema, a.json, "the categories");
    return `${(a.json as { categories: unknown[] }).categories.length} categories`;
  });
  await check("assistants.llms", "§4.7", "should", async () => {
    const a = await call("GET", "/llms.txt");
    expectStatus(a, 200);
    if (!a.text.trim()) throw new Error("llms.txt is empty");
    return "served";
  });
  /** One JSON-RPC call to the network's MCP server, at a revision every server negotiates. */
  const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
    const a = await call("POST", "/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      headers: { Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18" },
    });
    expectStatus(a, 200);
    const json = a.json ?? sseJson(a.text);
    const result = (json as { result?: Record<string, unknown> } | undefined)?.result;
    if (!result) throw new Error(`${method} did not answer a result`);
    return result;
  };
  const initialize = () =>
    rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "network-check", version: "0.2.0" },
    });
  await check("assistants.mcp", "§4.7", "should", async () => {
    await initialize();
    const tools = ((await rpc(2, "tools/list", {})).tools ?? []) as { name?: unknown }[];
    const names = tools.map((t) => t.name);
    for (const name of ["search_businesses", "get_business", "list_categories"]) {
      if (!names.includes(name)) throw new Error(`tools/list has no ${name}`);
    }
    const found = await rpc(3, "tools/call", { name: "search_businesses", arguments: {} });
    shape(searchBusinessesOutputSchema, found.structuredContent, "search_businesses' structuredContent");
    return "initialize, the three tools, and a search that matches the schema";
  });

  /* --- doors and filters (protocol 0.2) ----------------------------------------------------------- */

  await check("doors.no-human-door", "§4.8", "must", async () => {
    const a = await call("GET", "/v1/businesses?limit=100");
    expectStatus(a, 200);
    const listed = entriesOf(a.json);
    let cards: unknown[] = [];
    try {
      await initialize();
      const found = await rpc(3, "tools/call", { name: "search_businesses", arguments: {} });
      cards = entriesOf(found.structuredContent);
    } catch {
      // A network without the MCP door is read through GET /v1/businesses alone.
    }
    const human = [...humanDoors(listed, "GET /v1/businesses"), ...humanDoors(cards, "search_businesses")];
    if (human.length > 0) throw new Error(human.slice(0, 3).join("; "));
    const doors = [...listed, ...cards].reduce<number>((n, e) => n + doorsOf(e).length, 0);
    return doors === 0 ? "no doors listed" : `${doors} doors, none of them a human channel`;
  });

  await check("filters.narrow", "§4.3", "should", async () => {
    const a = await call("GET", "/v1/businesses?limit=100");
    expectStatus(a, 200);
    const base = domainsOf(a.json);
    const whole = (a.json as { next_cursor?: unknown } | undefined)?.next_cursor == null;
    const first = entriesOf(a.json)[0] as { languages?: unknown; categories?: unknown } | undefined;
    const firstOf = (v: unknown) => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);
    const filters: [string, string][] = [];
    const language = firstOf(first?.languages);
    const category = firstOf(first?.categories);
    if (language) filters.push(["language", language]);
    if (category) filters.push(["category", category]);
    filters.push(["has_inbox", "true"], ["level", "askable"], ["source", "member"]);
    const where = new Map(base.map((d, i) => [d, i]));
    const notes: string[] = [];
    let ran = 0;
    for (const [name, value] of filters) {
      const f = await call("GET", `/v1/businesses?limit=100&${name}=${encodeURIComponent(value)}`);
      if (f.status === 400) {
        notes.push(`${name}: not supported`);
        continue;
      }
      expectStatus(f, 200);
      const kept = domainsOf(f.json);
      let last = -1;
      for (const d of kept) {
        const at = where.get(d);
        if (at === undefined) {
          if (whole) throw new Error(`${name}=${value} added ${d}, which the whole list does not have`);
          continue;
        }
        if (at < last) throw new Error(`${name}=${value} moved ${d} before a business it follows without the filter`);
        last = at;
      }
      ran++;
      notes.push(`${name}=${value}: ${kept.length} of ${base.length}`);
    }
    if (ran === 0) return new Skip(`no filter supported (${notes.join(", ")})`);
    return `each kept the order: ${notes.join(", ")}`;
  });

  /* --- instances -------------------------------------------------------------------------------- */

  await check("instances.status-unknown", "§4.1", "must", async () => {
    const a = await call("GET", `/v1/instances/${NOWHERE}/status`);
    expectStatus(a, 404);
    return "404";
  });
  await check("instances.register-bad", "§4.1", "must", async () => {
    const a = await call("POST", "/v1/instances", { body: JSON.stringify({ domain: "not a domain" }) });
    if (a.status !== 400) throw new Error(`expected 400 for a domain that is not one, got ${a.status}`);
    return "400";
  });
  await check("instances.ping-unknown", "§4.1", "must", async () => {
    const a = await call("POST", `/v1/instances/${NOWHERE}/ping`, {
      body: JSON.stringify({ version: "network-check", runtime: "check" }),
    });
    expectStatus(a, 404);
    return "404";
  });

  // The checker's own key: never in any manifest the network holds, unless the flow publishes it.
  const key = await generateReceiptKey();

  // A key no manifest holds: what signs every request a network must refuse as someone else's.
  const stranger = await generateReceiptKey();

  /**
   * The checks that need a listed business: one the directory already lists, or, on an empty
   * network, the checker's own inbox once the flow has listed it. Those about an instance take a
   * listed member: detail is any listed business, domain a listed member (or null).
   */
  const aboutListed = async (detail: string | null, domain: string | null) => {
    await check("directory.detail", "§4.3", "must", async () => {
      if (!detail) return new Skip("no business is listed to read");
      const a = await call("GET", `/v1/businesses/${detail}`);
      expectStatus(a, 200);
      shape(listingDetailSchema, a.json, "a business");
      return detail;
    });
    await check("instances.status", "§4.1", "must", async () => {
      if (!domain) return new Skip("no member is listed to ask about");
      const a = await call("GET", `/v1/instances/${domain}/status`);
      expectStatus(a, 200);
      shape(instanceStatusSchema, a.json, "an instance's status");
      return domain;
    });
    await check("listing.unsigned", "§3, §4.5", "must", async () => {
      if (!domain) return new Skip("no member is listed to try");
      // `listed: true` for a listed business: if a network wrongly took it, nothing would change.
      expectProblem(
        await call("POST", `/v1/instances/${domain}/listing`, { body: JSON.stringify({ listed: true }) }),
        401,
        ["bad_signature"],
      );
      return "401 bad_signature";
    });
    await check("listing.wrong-key", "§3, §4.5", "must", async () => {
      if (!domain) return new Skip("no member is listed to try");
      const a = await call("POST", `/v1/instances/${domain}/listing`, {
        body: JSON.stringify({ listed: true }),
        sign: { domain, key: stranger },
      });
      expectProblem(a, 401, ["bad_signature", "unknown_instance"]);
      return `401 ${problemCode(a)}`;
    });
    await check("receipts.forged", "§4.2", "must", async () => {
      if (!domain) return new Skip("no member is listed to forge a receipt for");
      const jws = await signReceipt(promiseClaims(`https://${domain}`, claims, now()), stranger);
      expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: jws }) }), 422, [
        "unknown_key",
      ]);
      return "422 unknown_key";
    });
  };

  /* --- receipts ------------------------------------------------------------------------------- */

  await check("receipts.malformed", "§4.2", "must", async () => {
    const a = await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: "not-a-receipt" }) });
    expectProblem(a, [400, 422], ["malformed", "bad_payload"]);
    return `${a.status} ${problemCode(a)}`;
  });
  await check("receipts.unknown-issuer", "§4.2", "must", async () => {
    const jws = await signReceipt(promiseClaims(`https://${NOWHERE}`, 1, now()), key);
    expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: jws }) }), 404, [
      "unknown_issuer",
    ]);
    return "404 unknown_issuer";
  });
  await check("receipts.too-large", "§1", "should", async () => {
    const a = await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: "x".repeat(70 * 1024) }) });
    expectProblem(a, 413, ["too_large"]);
    return "413 too_large";
  });

  /* --- the level's edge ---------------------------------------------------------------------- */

  await check("level.persons", "§5.1, §10.1", "must", async () => {
    const a = await call("POST", "/v1/persons", {
      body: JSON.stringify({ request_id: "network-check", email: "check@example.com" }),
    });
    if (level === "directory") {
      expectProblem(a, 404, ["not_found"]);
      return "404 not_found: a directory gives no keys";
    }
    expectProblem(a, 401, ["bad_signature"]);
    return "401 bad_signature: unsigned";
  });

  /* --- the flow: an inbox's whole life --------------------------------------------------------- */

  if (member || !options.flow) await aboutListed(listed, member);
  if (options.flow) {
    const registered = await runFlow(options.flow, {
      origin,
      call,
      check,
      now,
      key,
      claims,
      level,
      listedOther: listed,
    });
    if (!member && registered) await aboutListed(listed ?? options.flow.domain, options.flow.domain);
  }

  const passed = results.every((r) => r.requirement !== "must" || r.outcome !== "fail");
  return { network: origin, protocol, said, results, passed };
}

/* --- the flow ----------------------------------------------------------------------------------- */

interface FlowContext {
  readonly origin: string;
  readonly call: (
    method: string,
    path: string,
    init?: { body?: string; headers?: Record<string, string>; sign?: { domain: string; key: InstanceSigningKey } },
  ) => Promise<Answer>;
  readonly check: (
    id: string,
    section: string,
    requirement: Requirement,
    run: () => Promise<string | Skip>,
  ) => Promise<boolean>;
  readonly now: () => number;
  readonly key: InstanceSigningKey & { readonly publicJwk: Record<string, unknown> };
  readonly claims: number;
  readonly level: string;
  readonly listedOther: string | null;
}

async function runFlow(flow: FlowOptions, f: FlowContext): Promise<boolean> {
  const { call, check, key, now } = f;
  const domain = flow.domain;
  const iss = `https://${domain}`;
  const sign = { domain, key };
  const manifest = {
    spec: "surfingdog-inbox/0",
    instance: iss,
    profile: {
      name: "Network check",
      description: "An inbox the network checker plays. It takes no real bookings.",
      categories: ["bike-repair"],
      languages: ["en"],
      services: [{ name: "Check", type: "booking" }],
    },
    item_types: ["booking", "order"],
    protocols: { mcp: `${iss}/mcp`, rest: `${iss}/v1` },
    agent_policy: { tiers: ["anonymous"] },
    receipt_keys: { keys: [key.publicJwk] },
    review_services: [],
  };
  await flow.publishManifest(manifest);

  const registered = await check("flow.register", "§4.1", "must", async () => {
    const a = await call("POST", "/v1/instances", { body: JSON.stringify({ domain }) });
    expectStatus(a, 202);
    shape(instanceRegistrationResponseSchema, a.json, "the registration");
    for (let i = 0; i < 20; i++) {
      const s = await call("GET", `/v1/instances/${domain}/status`);
      if (s.status === 200 && (s.json as { status?: unknown }).status === "verified")
        return "verified from its manifest";
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the domain was not verified within 10 s: can the network read the manifest?");
  });
  if (!registered) return false;

  const ping = JSON.stringify({
    version: "network-check",
    runtime: "check",
    counts: { bookings: 1, orders: 0, quotes: 0, messages: 0 },
  });
  await check("flow.ping-unsigned", "§4.1", "must", async () => {
    expectStatus(await call("POST", `/v1/instances/${domain}/ping`, { body: ping }), 204);
    return "204";
  });
  await check("flow.ping-signed", "§3, §4.1", "must", async () => {
    const a = await call("POST", `/v1/instances/${domain}/ping`, { body: ping, sign });
    expectStatus(a, 200);
    const answer = shape(signedPingResponseSchema, a.json, "a signed ping's answer");
    if (f.level === "full" && !answer.standing)
      throw new Error("a full-level network answers a signed ping with the standing");
    return f.level === "full" ? `200, standing ${answer.standing?.tier}` : "200";
  });
  await check("flow.replay", "§3", "must", async () => {
    const signed = await signInstanceRequest({
      method: "POST",
      url: `${f.origin}/v1/instances/${domain}/ping`,
      body: ping,
      instance: iss,
      key,
      now: now(),
    });
    const headers = { "Content-Type": "application/json", ...signed.headers };
    const first = await rawSend(call, `/v1/instances/${domain}/ping`, ping, headers);
    expectStatus(first, 200);
    expectProblem(await rawSend(call, `/v1/instances/${domain}/ping`, ping, headers), 401, ["replayed_signature"]);
    return "the same signature twice: 401 replayed_signature";
  });
  await check("flow.listed", "§4.3", "must", async () => {
    const a = await call("GET", `/v1/businesses/${domain}`);
    expectStatus(a, 200);
    const b = shape(listingDetailSchema, a.json, "the checker's listing");
    if (b.name !== "Network check") throw new Error(`the listing's name is ${b.name}, not the profile's`);
    return "listed, with its profile's name";
  });
  await check("flow.leave-and-return", "§4.5", "must", async () => {
    const off = await call("POST", `/v1/instances/${domain}/listing`, {
      body: JSON.stringify({ listed: false }),
      sign,
    });
    expectStatus(off, 200);
    if (shape(listingResponseSchema, off.json, "leaving").listed !== false) throw new Error("leaving answered listed");
    expectStatus(await call("GET", `/v1/businesses/${domain}`), 404);
    const on = await call("POST", `/v1/instances/${domain}/listing`, { body: JSON.stringify({ listed: true }), sign });
    expectStatus(on, 200);
    if (shape(listingResponseSchema, on.json, "coming back").listed !== true)
      throw new Error("coming back answered not listed");
    return "left at once, and came back";
  });
  await check("flow.listing-other-domain", "§4.5", "must", async () => {
    if (!f.listedOther || f.listedOther === domain) return new Skip("no other business is listed");
    expectProblem(
      await call("POST", `/v1/instances/${f.listedOther}/listing`, { body: JSON.stringify({ listed: true }), sign }),
      401,
      ["unknown_instance"],
    );
    return "another domain's listing, signed by this one: 401 unknown_instance";
  });

  // Receipts, in the claims the network said it takes.
  const promise = promiseClaims(iss, f.claims, now());
  const promiseJws = await signReceipt(promise, key);
  await check("flow.receipt", "§4.2", "must", async () => {
    const a = await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: promiseJws }) });
    expectStatus(a, 201);
    if (shape(receiptPublishResultSchema, a.json, "a receipt's answer").duplicate)
      throw new Error("a new receipt answered duplicate");
    const again = await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: promiseJws }) });
    expectStatus(again, 200);
    if (!shape(receiptPublishResultSchema, again.json, "a receipt sent again").duplicate)
      throw new Error("the same receipt twice was not a duplicate");
    return "201 issued, then 200 duplicate";
  });
  await check("flow.nonce-reused", "§4.2", "must", async () => {
    const other = await signReceipt({ ...promise, itm: "network-check-other" }, key);
    expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: other }) }), 409, [
      "nonce_reused",
    ]);
    return "409 nonce_reused";
  });
  await check("flow.receipt-counted", "§4.3", "must", async () => {
    const a = await call("GET", `/v1/businesses/${domain}`);
    expectStatus(a, 200);
    const issued = shape(listingDetailSchema, a.json, "the listing").receipts.issued;
    if (issued < 1) throw new Error("the listing counts no receipt");
    return `receipts.issued ${issued}`;
  });
  await check("flow.receipt-bad-signature", "§4.2", "must", async () => {
    const fresh = await signReceipt(promiseClaims(iss, f.claims, now()), key);
    const [h, p, s] = fresh.split(".") as [string, string, string];
    const tampered = `${h}.${p}.${s.startsWith("A") ? `B${s.slice(1)}` : `A${s.slice(1)}`}`;
    expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: tampered }) }), 422, [
      "bad_signature",
    ]);
    return "422 bad_signature";
  });
  await check("flow.receipt-not-yet", "§4.2", "must", async () => {
    const ahead = await signReceipt(promiseClaims(iss, f.claims, now() + 3_600_000), key);
    expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: ahead }) }), 422, ["not_yet"]);
    return "an iat an hour ahead: 422 not_yet";
  });
  await check("flow.receipt-bad-payload", "§4.2, §6", "must", async () => {
    const bad = await signReceipt(
      { iss, itm: "x", typ: "booking", knd: "confirmed", iat: Math.floor(now() / 1000), nonce: hex(16) },
      key,
    );
    expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: bad }) }), 422, ["bad_payload"]);
    return "claims without sub: 422 bad_payload";
  });
  if (f.claims >= 2) {
    await check("flow.outcome", "§4.2, §6", "must", async () => {
      const outcome = await signReceipt(outcomeClaims(promise, now()), key);
      expectStatus(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: outcome }) }), 201);
      const a = await call("GET", `/v1/businesses/${domain}`);
      const counted = shape(listingDetailSchema, a.json, "the listing").outcomes["booking.completed"] ?? 0;
      if (counted < 1) throw new Error("the listing counts no booking.completed");
      return "201, and counted under outcomes";
    });
    await check("flow.outcome-unknown-ref", "§4.2", "must", async () => {
      const orphan = await signReceipt(outcomeClaims({ ...promise, nonce: hex(16) }, now()), key);
      expectProblem(await call("POST", "/v1/receipts", { body: JSON.stringify({ receipt: orphan }) }), 422, [
        "unknown_ref",
      ]);
      return "an outcome of no promise it holds: 422 unknown_ref";
    });
  }
  return true;
}

async function rawSend(
  call: FlowContext["call"],
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<Answer> {
  return call("POST", path, { body, headers });
}

/* --- claims ------------------------------------------------------------------------------------ */

/** A booking confirmed tomorrow, in claims v1 or v2 as the network takes. */
function promiseClaims(iss: string, claims: number, now: number): Record<string, unknown> {
  const iat = Math.floor(now / 1000);
  const base = {
    iss,
    sub: b64u(16),
    itm: `network-check-${hex(4)}`,
    typ: "booking",
    knd: "confirmed",
    iat,
    nonce: hex(16),
  };
  if (claims < 2) return base;
  return { ...base, ver: 2, due: iat + 86_400, end: iat + 86_400 + 3_600 };
}

function outcomeClaims(promise: Record<string, unknown>, now: number): Record<string, unknown> {
  return {
    iss: promise.iss,
    sub: promise.sub,
    itm: promise.itm,
    typ: "booking",
    knd: "outcome",
    out: "booking.completed",
    iat: Math.floor(now / 1000),
    nonce: hex(16),
    ver: 2,
    ref: promise.nonce,
    due: promise.due,
    end: promise.end,
  };
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64u(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer)
    .toString("base64url")
    .padEnd(22, "A");
}

/* --- doors ------------------------------------------------------------------------------------- */

/** The businesses of a page (`businesses`), read without a schema: a door a schema would refuse is what is looked for. */
function entriesOf(page: unknown): unknown[] {
  const list = (page as { businesses?: unknown } | null | undefined)?.businesses;
  return Array.isArray(list) ? list : [];
}

function domainsOf(page: unknown): string[] {
  return entriesOf(page).flatMap((e) => {
    const d = (e as { domain?: unknown } | null)?.domain;
    return typeof d === "string" ? [d] : [];
  });
}

function doorsOf(entry: unknown): unknown[] {
  const doors = (entry as { doors?: unknown } | null)?.doors;
  return Array.isArray(doors) ? doors : [];
}

/** Why a URL is a human channel (§4.8): a refused scheme, or a messaging host; null when it is not one. */
function humanUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme && doorVocabulary.refused_url_schemes.includes(scheme)) return `a ${scheme}: address`;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const refused = doorVocabulary.refused_hosts.find((h) => host === h || host.endsWith(`.${h}`));
  return refused ? `a ${refused} link` : null;
}

/** Every human channel offered as a way in: a door of a refused type or address, or an inbox or protocol entry. */
function humanDoors(entries: readonly unknown[], where: string): string[] {
  const found: string[] = [];
  for (const e of entries) {
    const domain = String((e as { domain?: unknown } | null)?.domain ?? "?");
    for (const door of doorsOf(e)) {
      const { type, url } = (door ?? {}) as { type?: unknown; url?: unknown };
      if (typeof type === "string" && doorVocabulary.refused.includes(type.toLowerCase())) {
        found.push(`${where}: ${domain} lists a ${type} door, a human channel`);
        continue;
      }
      const why = humanUrl(url);
      if (why) found.push(`${where}: ${domain} lists ${why} as a door`);
    }
    for (const member of ["inbox", "protocols"] as const) {
      const value = (e as Record<string, unknown> | null)?.[member];
      if (typeof value !== "object" || value === null) continue;
      for (const [name, url] of Object.entries(value)) {
        const why = humanUrl(url);
        if (why) found.push(`${where}: ${domain} lists ${why} as ${member}.${name}`);
      }
    }
  }
  return found;
}

/* --- answers ----------------------------------------------------------------------------------- */

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

class Skip {
  constructor(readonly why: string) {}
}

function expectStatus(a: Answer, status: number): void {
  if (a.status !== status)
    throw new Error(`expected ${status}, got ${a.status}${a.text ? `: ${a.text.slice(0, 160)}` : ""}`);
}

/** The JSON of the first `data:` line of a text/event-stream answer, when an MCP server streams it. */
function sseJson(text: string): unknown {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(5));
  } catch {
    return undefined;
  }
}

function problemCode(a: Answer): string {
  return String((a.json as { code?: unknown } | undefined)?.code ?? "");
}

/** A refusal as §1 has it: the status, an RFC 9457 problem, and one of the codes §9 names. */
function expectProblem(a: Answer, status: number | readonly number[], codes: readonly string[]): void {
  const statuses = typeof status === "number" ? [status] : status;
  if (!statuses.includes(a.status)) {
    throw new Error(
      `expected ${statuses.join(" or ")} ${codes.join(" or ")}, got ${a.status}: ${a.text.slice(0, 160)}`,
    );
  }
  if (!(a.headers.get("content-type") ?? "").includes("application/problem+json")) {
    throw new Error(`a ${a.status} is an application/problem+json document (§1)`);
  }
  const code = problemCode(a);
  if (!codes.includes(code)) throw new Error(`expected the code ${codes.join(" or ")}, got ${code || "none"}`);
}

function shape<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`${what} does not match the schema: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`);
  }
  return r.data;
}
