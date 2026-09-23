import {
  type Caller,
  Capabilities,
  createSecretBox,
  JobRunner,
  NETWORK_PING_KIND,
  NETWORK_PING_ONE_KIND,
  NETWORK_PUBLISH_KIND,
  type PublicJwk,
  readNetworkStatus,
  verifyInstanceRequest,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type NetworkDeps, networkPingHandler, networkPingOneHandler, pingNetworksNow } from "../src/network";
import { freshDb } from "./db";

/**
 * The signed ping (ADR-017 §7.3): an inbox that can sign pings with its receipt key, sdi-instance/1,
 * and a network answers a ping signed by the domain's own key with the business's standing there
 * and the rules it applies. Everything that is not a verified answer leaves the ping as it always
 * was: a network that does not read signatures, one that cannot check this one, one that refuses
 * signed pings outright (pinged again unsigned), and an inbox with no key. Node and workerd.
 */
const A = "https://network.example.com";
const KEY = "network-standing-instance-key-0123456789";
const BASE = "https://demo.example.com";
const T0 = Date.UTC(2026, 8, 23, 10, 0, 30);

const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});

type Answer = (verified: boolean, headers: Record<string, string>) => Response;

/** A network that knows the instance, checks every signed ping against its published keys, and answers with `answer`. */
function network(keys: () => Promise<readonly PublicJwk[]>, answer: Answer) {
  const calls: { url: string; signed: boolean; verified: boolean; error?: string; headers: Record<string, string> }[] =
    [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/v1/ranking")) {
      calls.push({ url, signed: false, verified: false, headers });
      return Response.json({
        version: 2,
        next: { version: 3, effective_at: "2026-10-09T00:00:00Z" },
        verified: { recognised_platforms: ["https://Agents.Example.net", "chatgpt.com", "not a host", 42] },
      });
    }
    const signed = headers["Signature-Input"] !== undefined;
    let verified = false;
    let error: string | undefined;
    if (signed) {
      try {
        const v = await verifyInstanceRequest({
          method: init?.method ?? "GET",
          url,
          headers,
          body: String(init?.body ?? ""),
          authorities: [new URL(A).host],
          now: Date.now(),
          keysFor: async (domain) => (domain === "demo.example.com" ? keys() : null),
        });
        verified = v.domain === "demo.example.com";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    calls.push({ url, signed, verified, headers, ...(error ? { error } : {}) });
    return answer(verified, headers);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Rules version 2 in force, 3 announced, and a standing: what our network says to a signed ping. */
const standingAnswer =
  (standing: { score: number; tier: string; ranked: boolean }): Answer =>
  (verified) =>
    verified
      ? Response.json({
          ok: true,
          rules: { version: 2, effective_at: "2026-09-22T00:00:00Z" },
          next_rules: { version: 3, effective_at: "2026-10-09T00:00:00Z", url: `${A}/v1/ranking?version=3` },
          reports: [],
          contests: [],
          standing,
        })
      : new Response(null, { status: 204 });

async function setup(answer: Answer, opts: { secret?: boolean } = {}) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, opts.secret === false ? null : createSecretBox([KEY]), BASE, 0);
  await caps.updateSettings(owner(T0), {
    doc: { networks: { [A]: { enabled: true, share: { listing: true, counts: false, receipts: false } } } },
  });
  const net = network(async () => (await caps.receipts.jwks()).keys as PublicJwk[], answer);
  const deps: NetworkDeps = {
    baseUrl: BASE,
    version: "0.0.0",
    fetchImpl: net.fetchImpl,
    instanceKey: async () => (caps.secrets ? caps.receipts.keys.active() : null),
  };
  const runner = new JobRunner()
    .register(NETWORK_PING_KIND, networkPingHandler(deps))
    .register(NETWORK_PING_ONE_KIND, networkPingOneHandler(deps));
  for (const kind of ["notify", "rules", NETWORK_PUBLISH_KIND, "network_receipt", "lifecycle_sweep"]) {
    runner.register(kind, async () => undefined);
  }
  const ping = async (t: number) => {
    await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
    await pingNetworksNow(db, t);
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t })).claimed === 0) break;
  };
  const view = async () => (await caps.getNetworks(owner(T0))).networks.find((n) => n.origin === A);
  const note = async () =>
    (
      await db.client.query({
        sql: "SELECT last_error FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT 1",
        params: [NETWORK_PING_ONE_KIND],
        method: "all",
      })
    ).rows[0]?.[0];
  return { db, caps, net, ping, view, note };
}

describe("the signed ping", () => {
  it("signs the ping with the receipt key, and keeps the standing and the rules the network answers", async () => {
    const s = await setup(standingAnswer({ score: 0.523456, tier: "building", ranked: true }));
    await s.ping(T0);
    const pings = s.net.calls.filter((c) => c.url.endsWith("/ping"));
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ signed: true, verified: true });
    expect(pings[0]?.headers["Sdi-Instance"]).toBe("https://demo.example.com");
    // The answer carried the rules; the document is read once today all the same, for the platforms
    // the network recognises, which a ping's answer does not carry (§4). An hour on, nothing is read.
    expect(s.net.calls.filter((c) => c.url.endsWith("/v1/ranking"))).toHaveLength(1);
    expect((await readNetworkStatus(s.db, A))?.recognisedPlatforms).toEqual(["agents.example.net", "chatgpt.com"]);
    expect(await s.note()).toBe(
      "pinged network.example.com as demo.example.com, signed; rules 2, next 3, takes claims v2",
    );
    expect(await s.view()).toMatchObject({
      last_ping_at: new Date(T0).toISOString(),
      ping_signature: "verified",
      standing: { tier: "building", score: 0.523456, ranked: true, at: new Date(T0).toISOString() },
      rules: { version: 2, next: 3, next_at: "2026-10-09T00:00:00.000Z", v2: true },
    });
    await s.ping(T0 + 3_600_000);
    expect(s.net.calls.filter((c) => c.url.endsWith("/v1/ranking"))).toHaveLength(1);
  });

  it("keeps the last standing, dated, when a later ping brings none", async () => {
    let signedAnswers = true;
    const s = await setup((verified, headers) =>
      signedAnswers
        ? standingAnswer({ score: 0.81, tier: "trusted", ranked: true })(verified, headers)
        : new Response(null, { status: 204, headers: { "Sdi-Signature": 'invalid; reason="expired"' } }),
    );
    await s.ping(T0);
    signedAnswers = false;
    await s.ping(T0 + 3_600_000);
    expect(await s.view()).toMatchObject({
      last_ping_at: new Date(T0 + 3_600_000).toISOString(),
      ping_signature: "invalid: expired",
      standing: { tier: "trusted", score: 0.81, ranked: true, at: new Date(T0).toISOString() },
    });
  });

  it("takes a ping a network answers as unsigned, and says it did not read the signature", async () => {
    const s = await setup(() => new Response(null, { status: 204 }));
    await s.ping(T0);
    expect(s.net.calls.filter((c) => c.url.endsWith("/ping")).map((c) => c.signed)).toEqual([true]);
    expect(await s.view()).toMatchObject({
      last_ping_at: new Date(T0).toISOString(),
      last_error: null,
      ping_signature: "ignored",
      standing: null,
    });
  });

  it("pings again unsigned, at once, a network that refuses a signed ping", async () => {
    const s = await setup((_verified, headers) =>
      headers["Signature-Input"] === undefined
        ? new Response(null, { status: 204 })
        : Response.json({ code: "bad_signature" }, { status: 401 }),
    );
    await s.ping(T0);
    expect(s.net.calls.filter((c) => c.url.endsWith("/ping")).map((c) => c.signed)).toEqual([true, false]);
    expect(await s.view()).toMatchObject({
      last_ping_at: new Date(T0).toISOString(),
      last_error: null,
      ping_signature: "refused",
    });
  });

  it("says why a network could not check the signature, from its Sdi-Signature", async () => {
    const s = await setup(
      () => new Response(null, { status: 204, headers: { "Sdi-Signature": 'invalid; reason="unknown_instance"' } }),
    );
    await s.ping(T0);
    expect(await s.view()).toMatchObject({ ping_signature: "invalid: unknown_instance", standing: null });
  });

  it("pings unsigned, as always, an inbox that cannot sign", async () => {
    const s = await setup(standingAnswer({ score: 0.9, tier: "trusted", ranked: true }), { secret: false });
    await s.ping(T0);
    const pings = s.net.calls.filter((c) => c.url.endsWith("/ping"));
    expect(pings.map((c) => c.signed)).toEqual([false]);
    expect(pings[0]?.headers["Sdi-Instance"]).toBeUndefined();
    expect(await s.view()).toMatchObject({ ping_signature: "unsigned", standing: null });
  });

  it("does not take a standing from an answer that does not parse", async () => {
    const s = await setup((verified) =>
      verified
        ? Response.json({ ok: true, standing: { tier: "legendary", score: 7 } })
        : new Response(null, { status: 204 }),
    );
    await s.ping(T0);
    expect(await s.view()).toMatchObject({ ping_signature: "ignored", standing: null });
  });
});
