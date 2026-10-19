import { DEFAULT_NETWORK, readSettings } from "@surfingdog/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeTenant, type Runtime, startRuntime } from "./harness";

/**
 * A hosted inbox joins network.surfingdog.ai and signs receipts from day one: switched on with its
 * first settings, held off while it is only at its setup address, on and listed the moment it is
 * live at the business's own address, with nothing for the owner to do; the owner can switch it off
 * and it stays off, through a lost DNS record and back. An inbox made before this is left as it was
 * until its host runs `join-networks` on it. No test here reaches a network: every call is refused
 * and recorded (`outbound`).
 */

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

const settingsOf = async (t: FakeTenant) => {
  const shard = rt.shardOf(t);
  const entry = await shard.acquire(t.tenantId);
  try {
    return await readSettings(entry.db);
  } finally {
    shard.release(entry);
  }
};

const manifestOf = async (host: string) =>
  (await rt.http(host, "GET", "/.well-known/agent-inbox.json")).json as {
    review_services?: string[];
    directory?: { listed: boolean };
    receipt_keys?: { keys: unknown[] };
  };

const put = (host: string, cookie: string, doc: Record<string, unknown>) =>
  rt.http(host, "PUT", "/v1/owner/settings", {
    headers: { cookie, "content-type": "application/json", origin: `https://${host}` },
    body: JSON.stringify({ doc }),
  });

describe("a new hosted inbox", () => {
  it("is on the network, held, from its first settings, and on and listed once it is live", async () => {
    const t = await rt.createTenant();
    let s = await settingsOf(t);
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: true });
    expect(s.directory).toMatchObject({ listed: false, resume: true });

    await rt.setState(t, "live", { ownResolves: true });
    s = await settingsOf(t);
    // Listed, counted, receipts; no first-time customer's email until the owner switches keys on.
    expect(s.networks[DEFAULT_NETWORK]).toMatchObject({ enabled: true, issue: false });
    expect(s.networks[DEFAULT_NETWORK]?.resume).toBeUndefined();
    expect(s.directory.listed).toBe(true);
    const manifest = await manifestOf(t.ownHost ?? "");
    expect(manifest.review_services).toEqual([DEFAULT_NETWORK]);
    expect(manifest.directory).toBeUndefined();
  });

  it("is ready to sign receipts from the start: its key is made, sealed and published", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const shard = rt.shardOf(t);
    const entry = await shard.acquire(t.tenantId);
    try {
      const status = await entry.inbox.caps.receipts.status();
      expect(status.ready).toBe(true);
      // The key receipts are signed with exists from the first one, sealed with this inbox's own key.
      const key = await entry.inbox.caps.receipts.keys.active();
      expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      shard.release(entry);
    }
    const manifest = await manifestOf(t.ownHost ?? "");
    expect(manifest.receipt_keys?.keys).toHaveLength(1);
  });

  it("stays off once the owner switches it off, through a lost record and back", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const off = await put(t.ownHost ?? "", cookie, { networks: { [DEFAULT_NETWORK]: { enabled: false } } });
    expect(off.status).toBe(200);
    await rt.setState(t, "dns_pending", { ownLost: true });
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: false });
    await rt.setState(t, "live", { ownLost: false, ownResolves: true });
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    expect((await manifestOf(t.ownHost ?? "")).review_services).toEqual([]);
  });

  it("lets the owner say no before it is live: then nothing reaches the network when it is", async () => {
    const t = await rt.createTenant();
    const cookie = await rt.signIn(t, t.slugHost);
    const no = await put(t.slugHost, cookie, { networks: { [DEFAULT_NETWORK]: { enabled: false } } });
    expect(no.status).toBe(200);
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]).toMatchObject({ enabled: false, resume: false });
    const seen = rt.outbound.length;
    await rt.setState(t, "live", { ownResolves: true });
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);
    expect((await manifestOf(t.ownHost ?? "")).review_services).toEqual([]);
    expect(rt.outbound.slice(seen).filter((url) => url.includes(t.ownHost ?? "-"))).toEqual([]);
  });

  it("starts the owner's download with the receipt key while the inbox closes", async () => {
    const t = await rt.createTenant();
    await rt.setState(t, "live", { ownResolves: true });
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const here = async () =>
      (await rt.http(t.ownHost ?? "", "GET", "/v1/owner/download", { headers: { cookie } })).json as {
        leaving?: boolean;
      };
    expect((await here()).leaving).toBe(false);
    await rt.setState(t, "closing", { prevState: "live" });
    expect((await here()).leaving).toBe(true);
  });

  it("joins none when its host's policy names none", async () => {
    const t = await rt.createTenant({ joinNetworks: [] });
    await rt.setState(t, "live", { ownResolves: true });
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);
  });

  it("reaches no network from a test", () => {
    for (const url of rt.outbound) expect(url.startsWith(DEFAULT_NETWORK), url).toBe(true);
  });
});

describe("an inbox made before hosted inboxes joined", () => {
  it("is left as it was, until its host joins it; twice is once, and a read-only inbox is refused", async () => {
    // Made without the seed: as the first hosted inbox was.
    const t = await rt.createTenant({ joinNetworks: [] });
    await rt.setState(t, "live", { ownResolves: true });
    t.joinNetworks = undefined;
    await rt.setState(t, "live", { ownResolves: true });
    expect((await settingsOf(t)).networks[DEFAULT_NETWORK]?.enabled).toBe(false);

    const joined = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/networks/join`);
    expect(joined.status).toBe(200);
    expect(joined.body).toEqual({
      changed: true,
      level: 2,
      listed: true,
      networks: [{ origin: DEFAULT_NETWORK, on: true }],
    });
    expect((await manifestOf(t.ownHost ?? "")).review_services).toEqual([DEFAULT_NETWORK]);
    const again = await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/networks/join`);
    expect((again.body as { changed: boolean }).changed).toBe(false);

    // Held: remembered as on, still off until it is live again.
    const u = await rt.createTenant({ joinNetworks: [] });
    u.joinNetworks = undefined;
    await rt.setState(u, "dns_pending");
    const held = await rt.admin("POST", `/admin/v1/tenants/${u.tenantId}/networks/join`);
    expect(held.body).toMatchObject({
      changed: true,
      level: 1,
      listed: false,
      listed_when_live: true,
      networks: [{ origin: DEFAULT_NETWORK, on: false, held: true, on_when_live: true }],
    });

    await rt.setState(t, "closing", { prevState: "live" });
    expect((await rt.admin("POST", `/admin/v1/tenants/${t.tenantId}/networks/join`)).status).toBe(423);
  });
});
