import { createNetwork } from "@surfingdog/example-network";
import { checkManifest } from "@surfingdog/example-network/manifest";
import { generateReceiptKey } from "@surfingdog/sdk";
import { describe, expect, it } from "vitest";
import { checkNetwork, type Report } from "../src/index";

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
