import { createNetwork } from "@surfingdog/example-network";
import { checkManifest } from "@surfingdog/example-network/manifest";
import { generateReceiptKey } from "@surfingdog/sdk";
import { describe, expect, it } from "vitest";
import scoreRulesV1 from "../../spec/vocab/score-rules-v1.json" with { type: "json" };
import { checkNetwork, type Report } from "../src/index";
import rulesV7 from "./rules-v7.json" with { type: "json" };

/**
 * The checker against the example network, in one process: the network reads the checker's
 * manifest from memory, as `NETWORK_TEST_MANIFESTS` makes it read one from a local URL. Every
 * `must` of the directory level passes, flow included; and a network that breaks a rule fails.
 */
const ORIGIN = "https://network.example.org";

async function exampleNetwork() {
  const manifests = new Map<string, Record<string, unknown>>();
  const network = createNetwork({
    origin: ORIGIN,
    fetchManifest: async (domain) => {
      const m = manifests.get(domain);
      return m ? checkManifest(domain, m) : { ok: false, error: "no manifest for that domain" };
    },
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    network.app.fetch(new Request(input, init))) as typeof fetch;
  // A business already listed, so the checks that need one have it.
  const other = await generateReceiptKey();
  manifests.set("bakery.example.com", {
    spec: "surfingdog-inbox/0",
    instance: "https://bakery.example.com",
    profile: { name: "Padaria Sol", categories: ["Bakery"], languages: ["pt", "en"] },
    item_types: ["order"],
    protocols: { mcp: "https://bakery.example.com/mcp" },
    agent_policy: { tiers: ["anonymous"] },
    receipt_keys: { keys: [other.publicJwk] },
    review_services: [],
  });
  await fetchImpl(`${ORIGIN}/v1/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "bakery.example.com" }),
  });
  return { network, manifests, fetchImpl };
}

/** The example network with two businesses listed, so an order can be seen to hold or not. */
async function twoListed() {
  const n = await exampleNetwork();
  const key = await generateReceiptKey();
  n.manifests.set("salon.example.net", {
    spec: "surfingdog-inbox/0",
    instance: "https://salon.example.net",
    profile: { name: "Salon Aurora", categories: ["hair-beauty"], languages: ["es", "en"] },
    item_types: ["booking"],
    protocols: { mcp: "https://salon.example.net/mcp", email: "mailto:hola@salon.example.net" },
    agent_policy: { tiers: ["anonymous"] },
    receipt_keys: { keys: [key.publicJwk] },
    review_services: [],
  });
  await n.fetchImpl(`${ORIGIN}/v1/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "salon.example.net" }),
  });
  const page = (await (await n.fetchImpl(`${ORIGIN}/v1/businesses?limit=100`)).json()) as {
    businesses: { domain: string }[];
  };
  expect(page.businesses.map((b) => b.domain).sort()).toEqual(["bakery.example.com", "salon.example.net"]);
  return n;
}

/** A fetch that answers the paths `answer` takes, and passes every other request to the network. */
function around(
  inner: typeof fetch,
  answer: (url: URL, pass: () => Promise<Response>) => Promise<Response | undefined>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return (await answer(new URL(req.url), () => inner(req.clone()))) ?? inner(req);
  }) as typeof fetch;
}

const result = (r: Report, id: string) => r.results.find((x) => x.id === id);

const failures = (r: Report) => r.results.filter((x) => x.outcome === "fail").map((x) => `${x.id}: ${x.detail}`);

describe("network-check against the example network", () => {
  it("passes every must at the directory level, with the whole flow", async () => {
    const { manifests, fetchImpl } = await exampleNetwork();
    const report = await checkNetwork({
      network: ORIGIN,
      fetch: fetchImpl,
      flow: { domain: "inbox-check.test", publishManifest: (m) => void manifests.set("inbox-check.test", m) },
    });
    expect(failures(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.protocol).toEqual({ level: "directory", claims: 2 });
    expect(report.said).toBe(true);
    const ran = new Set(report.results.filter((r) => r.outcome === "pass").map((r) => r.id));
    for (const id of [
      "rules.read",
      "directory.list",
      "directory.detail",
      "listing.unsigned",
      "listing.wrong-key",
      "receipts.forged",
      "level.persons",
      "flow.register",
      "flow.ping-signed",
      "flow.replay",
      "flow.leave-and-return",
      "flow.listing-other-domain",
      "flow.receipt",
      "flow.nonce-reused",
      "flow.outcome",
      "flow.outcome-unknown-ref",
    ]) {
      expect(ran, id).toContain(id);
    }
    expect(report.results.find((r) => r.id === "assistants.mcp")).toMatchObject({ outcome: "pass" });
  });

  it("fails a network that takes an unsigned listing change, or answers a receipt without checking it", async () => {
    const { fetchImpl } = await exampleNetwork();
    const careless = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname.endsWith("/listing") && !req.headers.get("signature-input")) {
        return Response.json({ domain: "x", listed: true, delisted_at: null, dormant_since: null, shown_from: null });
      }
      if (url.pathname === "/v1/receipts")
        return Response.json({ ok: true, state: "issued", duplicate: false }, { status: 201 });
      return fetchImpl(req);
    }) as typeof fetch;
    const report = await checkNetwork({ network: ORIGIN, fetch: careless });
    expect(report.passed).toBe(false);
    const failed = report.results.filter((r) => r.outcome === "fail").map((r) => r.id);
    expect(failed).toEqual(expect.arrayContaining(["listing.unsigned", "receipts.unknown-issuer", "receipts.forged"]));
  });

  it("only reads and is refused without --flow: nothing about the network changes", async () => {
    const { network, fetchImpl } = await exampleNetwork();
    const before = network.store.db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number };
    const businesses = network.store.db.prepare("SELECT domain, listed FROM businesses").all();
    const report = await checkNetwork({ network: ORIGIN, fetch: fetchImpl });
    expect(report.passed).toBe(true);
    expect(network.store.db.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toEqual(before);
    expect(network.store.db.prepare("SELECT domain, listed FROM businesses").all()).toEqual(businesses);
  });
});

describe("protocol 0.2 checks", () => {
  it("the example network passes doors.no-human-door and filters.narrow: it lists no doors and ignores filters it lacks", async () => {
    const { fetchImpl } = await twoListed();
    const report = await checkNetwork({ network: ORIGIN, fetch: fetchImpl });
    expect(failures(report)).toEqual([]);
    expect(result(report, "doors.no-human-door")).toMatchObject({ outcome: "pass", requirement: "must" });
    expect(result(report, "doors.no-human-door")?.detail).toBe("no doors listed");
    expect(result(report, "filters.narrow")).toMatchObject({ outcome: "pass", requirement: "should" });
    // The checker filters by the top business's language and category: those really narrow; the rest
    // it ignores, which keeps the order. Which of the two is on top depends on whether both were
    // verified within the same moment (then by domain), so either is right.
    expect(result(report, "filters.narrow")?.detail).toMatch(
      /language=es: 1 of 2, category=hair-beauty: 1 of 2, has_inbox=true: 2 of 2|language=pt: 1 of 2, category=bakery: 1 of 2, has_inbox=true: 2 of 2/,
    );
  });

  it("reads rules version 7 whole, and a version newer than it knows leniently", async () => {
    const { fetchImpl } = await exampleNetwork();
    const v7 = around(fetchImpl, async (url) => (url.pathname === "/v1/ranking" ? Response.json(rulesV7) : undefined));
    const seven = await checkNetwork({ network: ORIGIN, fetch: v7 });
    expect(result(seven, "rules.read")).toMatchObject({ outcome: "pass" });
    expect(result(seven, "rules.read")?.detail).toBe("full level, claims 6, read from version 7");
    expect(seven.protocol).toEqual({ level: "full", claims: 6 });

    const v9doc = {
      version: 9,
      status: "in_force",
      effective_at: "2027-03-01T00:00:00Z",
      summary: "How a later network orders its directory.",
      next: null,
      order: { something: "new" },
    };
    const v9 = around(fetchImpl, async (url) => (url.pathname === "/v1/ranking" ? Response.json(v9doc) : undefined));
    const nine = await checkNetwork({ network: ORIGIN, fetch: v9 });
    expect(result(nine, "rules.read")).toMatchObject({ outcome: "pass" });
    expect(result(nine, "rules.read")?.detail).toContain("version 9 is newer than this checker; read leniently");

    // A version this checker knows is read whole: version 7 without what version 7 adds is not version 7.
    const { rule: _rule, ...order } = rulesV7.order;
    const broken = around(fetchImpl, async (url) =>
      url.pathname === "/v1/ranking" ? Response.json({ ...rulesV7, order }) : undefined,
    );
    expect(result(await checkNetwork({ network: ORIGIN, fetch: broken }), "rules.read")).toMatchObject({
      outcome: "fail",
    });
  });

  it("fails a directory that lists a phone, a mail address or a messaging link as a door", async () => {
    const { fetchImpl } = await twoListed();
    const withDoors = (doors: unknown[]) =>
      around(fetchImpl, async (url, pass) => {
        if (url.pathname !== "/v1/businesses") return undefined;
        const page = (await (await pass()).json()) as { businesses: Record<string, unknown>[] };
        return Response.json({ ...page, businesses: page.businesses.map((b) => ({ ...b, doors })) });
      });
    const live = { level: "askable", status: "live", kinds: ["ask"], src: "declared" };
    for (const [doors, why] of [
      [[{ ...live, type: "tel", url: "tel:+351912345678" }], "a tel door"],
      [[{ ...live, type: "other", protocol: "x", url: "mailto:owner@salon.example.net" }], "a mailto: address"],
      [[{ ...live, type: "api", url: "https://wa.me/351912345678" }], "a wa.me link"],
    ] as const) {
      const report = await checkNetwork({ network: ORIGIN, fetch: withDoors([...doors]) });
      expect(result(report, "doors.no-human-door"), why).toMatchObject({ outcome: "fail" });
      expect(result(report, "doors.no-human-door")?.detail, why).toContain(why);
      expect(report.passed, why).toBe(false);
    }
    const fine = await checkNetwork({
      network: ORIGIN,
      fetch: withDoors([{ ...live, type: "mcp", url: "https://salon.example.net/mcp" }]),
    });
    expect(result(fine, "doors.no-human-door")).toMatchObject({
      outcome: "pass",
      detail: "2 doors, none of them a human channel",
    });

    // A mail address offered among a listing's protocols is a human channel too.
    const mailto = around(fetchImpl, async (url, pass) => {
      if (url.pathname !== "/v1/businesses") return undefined;
      const page = (await (await pass()).json()) as { businesses: { protocols: Record<string, string> }[] };
      const [b, ...rest] = page.businesses;
      return Response.json({
        ...page,
        businesses: [{ ...b, protocols: { ...b?.protocols, email: "mailto:hola@salon.example.net" } }, ...rest],
      });
    });
    const report = await checkNetwork({ network: ORIGIN, fetch: mailto });
    expect(result(report, "doors.no-human-door")?.detail).toMatch(/a mailto: address as protocols\.email/);
  });

  it("asks a member, never a found entry, about what belongs to an instance", async () => {
    const { fetchImpl } = await exampleNetwork();
    // A found entry at the top, as a 0.2 network may list one: it has a detail, but no instance.
    const found = around(fetchImpl, async (url, pass) => {
      if (url.pathname === "/v1/businesses" && !url.searchParams.has("source")) {
        const page = (await (await pass()).json()) as { businesses: Record<string, unknown>[] };
        const [first] = page.businesses;
        return Response.json({
          ...page,
          businesses: [{ ...first, domain: "found.example.net", source: "found", claimed: false }, ...page.businesses],
        });
      }
      if (url.pathname === "/v1/businesses/found.example.net") {
        const detail = (await (await fetchImpl(`${ORIGIN}/v1/businesses/bakery.example.com`)).json()) as object;
        return Response.json({ ...detail, domain: "found.example.net", source: "found", claimed: false });
      }
      return undefined;
    });
    const report = await checkNetwork({ network: ORIGIN, fetch: found });
    expect(failures(report)).toEqual([]);
    expect(result(report, "directory.detail")?.detail).toBe("found.example.net");
    for (const id of ["instances.status", "listing.unsigned", "listing.wrong-key", "receipts.forged"]) {
      expect(result(report, id), id).toMatchObject({ outcome: "pass" });
    }
    expect(result(report, "instances.status")?.detail).toBe("bakery.example.com");
  });

  it("the example network keeps no mail address among a business's protocols", async () => {
    const { fetchImpl } = await twoListed();
    const salon = (await (await fetchImpl(`${ORIGIN}/v1/businesses/salon.example.net`)).json()) as {
      protocols: Record<string, string>;
    };
    expect(salon.protocols).toEqual({ mcp: "https://salon.example.net/mcp" });
  });

  it("fails a filter that reorders, and passes one that only leaves businesses out", async () => {
    const { fetchImpl } = await twoListed();
    const reorders = around(fetchImpl, async (url, pass) => {
      if (url.pathname !== "/v1/businesses" || !url.searchParams.has("has_inbox")) return undefined;
      const page = (await (await pass()).json()) as { businesses: unknown[] };
      return Response.json({ ...page, businesses: [...page.businesses].reverse() });
    });
    const bad = await checkNetwork({ network: ORIGIN, fetch: reorders });
    expect(result(bad, "filters.narrow")).toMatchObject({ outcome: "fail", requirement: "should" });
    expect(result(bad, "filters.narrow")?.detail).toMatch(/^has_inbox=true moved /);
    expect(bad.passed).toBe(true); // a should: reported, not failing the network

    const adds = around(fetchImpl, async (url, pass) => {
      if (url.pathname !== "/v1/businesses" || !url.searchParams.has("source")) return undefined;
      const page = (await (await pass()).json()) as { businesses: { domain: string }[] };
      const [first] = page.businesses;
      return Response.json({ ...page, businesses: [...page.businesses, { ...first, domain: "elsewhere.example" }] });
    });
    expect(result(await checkNetwork({ network: ORIGIN, fetch: adds }), "filters.narrow")?.detail).toMatch(
      /source=member added elsewhere\.example/,
    );

    const subset = around(fetchImpl, async (url, pass) => {
      if (url.pathname !== "/v1/businesses" || !url.searchParams.has("level")) return undefined;
      const page = (await (await pass()).json()) as { businesses: unknown[] };
      return Response.json({ ...page, businesses: page.businesses.slice(1) });
    });
    const good = await checkNetwork({ network: ORIGIN, fetch: subset });
    expect(result(good, "filters.narrow")).toMatchObject({ outcome: "pass" });
    expect(result(good, "filters.narrow")?.detail).toContain("level=askable: 1 of 2");

    const refuses = around(fetchImpl, async (url) =>
      url.pathname === "/v1/businesses" && [...url.searchParams.keys()].some((k) => k !== "limit")
        ? new Response(null, { status: 400 })
        : undefined,
    );
    expect(result(await checkNetwork({ network: ORIGIN, fetch: refuses }), "filters.narrow")).toMatchObject({
      outcome: "skip",
    });
  });
});

describe("0.3 checks: the score's rules and the AI catalog", () => {
  it("the example network offers neither, and passes both as not offered", async () => {
    const { fetchImpl } = await exampleNetwork();
    const report = await checkNetwork({ network: ORIGIN, fetch: fetchImpl });
    expect(failures(report)).toEqual([]);
    expect(result(report, "score.rules")).toMatchObject({
      outcome: "pass",
      requirement: "should",
      detail: "not offered",
    });
    expect(result(report, "discovery.catalog")).toMatchObject({ outcome: "pass", detail: "not offered" });
  });

  it("reads published score rules, and fails rules that name a capability nobody knows", async () => {
    const { fetchImpl } = await exampleNetwork();
    const serving = (doc: unknown) =>
      around(fetchImpl, async (url) => (url.pathname === "/v1/score-rules" ? Response.json(doc) : undefined));
    const good = await checkNetwork({ network: ORIGIN, fetch: serving(scoreRulesV1) });
    expect(result(good, "score.rules")).toMatchObject({
      outcome: "pass",
      detail: "version 1, 7 profiles, 19 capabilities",
    });
    const groups = scoreRulesV1.groups.map((g) =>
      g.id === "core" ? { ...g, members: [...g.members, "teleport"] } : g,
    );
    const bad = await checkNetwork({ network: ORIGIN, fetch: serving({ ...scoreRulesV1, groups }) });
    expect(result(bad, "score.rules")).toMatchObject({ outcome: "fail", requirement: "should" });
    expect(bad.passed).toBe(true); // a should: reported, not failing the network
    const broken = await checkNetwork({ network: ORIGIN, fetch: serving({ version: 1 }) });
    expect(result(broken, "score.rules")).toMatchObject({ outcome: "fail" });
    const down = around(fetchImpl, async (url) =>
      url.pathname === "/v1/score-rules" ? new Response("no", { status: 500 }) : undefined,
    );
    expect(result(await checkNetwork({ network: ORIGIN, fetch: down }), "score.rules")).toMatchObject({
      outcome: "fail",
    });
  });

  it("reads an AI catalog, and fails one that points an agent at a plain http address", async () => {
    const { fetchImpl } = await exampleNetwork();
    const catalog = {
      specVersion: "1.0",
      host: {
        displayName: "A network",
        identifier: "did:web:network.example.org",
        documentationUrl: `${ORIGIN}/about`,
      },
      entries: [
        {
          identifier: "urn:air:network.example.org:mcp:directory",
          displayName: "Directory (MCP)",
          type: "application/mcp-server-card+json",
          url: `${ORIGIN}/.well-known/mcp/server-card.json`,
        },
        {
          identifier: "urn:air:network.example.org:llms",
          displayName: "llms.txt",
          type: "text/markdown",
          url: `${ORIGIN}/llms.txt`,
        },
      ],
    };
    const serving = (doc: unknown) =>
      around(fetchImpl, async (url) =>
        url.pathname === "/.well-known/ai-catalog.json" ? Response.json(doc) : undefined,
      );
    expect(result(await checkNetwork({ network: ORIGIN, fetch: serving(catalog) }), "discovery.catalog")).toMatchObject(
      {
        outcome: "pass",
        detail: "2 entries, every one at an https address",
      },
    );
    const plain = { ...catalog, entries: [{ ...catalog.entries[0], url: "http://network.example.org/card.json" }] };
    const bad = await checkNetwork({ network: ORIGIN, fetch: serving(plain) });
    expect(result(bad, "discovery.catalog")).toMatchObject({ outcome: "fail" });
    expect(result(bad, "discovery.catalog")?.detail).toContain("http://network.example.org/card.json");
    const plainHost = { ...catalog, host: { ...catalog.host, documentationUrl: "http://network.example.org/about" } };
    expect(
      result(await checkNetwork({ network: ORIGIN, fetch: serving(plainHost) }), "discovery.catalog"),
    ).toMatchObject({
      outcome: "fail",
    });
    const shapeless = await checkNetwork({ network: ORIGIN, fetch: serving({ entries: "none" }) });
    expect(result(shapeless, "discovery.catalog")).toMatchObject({ outcome: "fail" });
  });
});
