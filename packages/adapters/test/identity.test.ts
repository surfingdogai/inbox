import {
  type Caller,
  Capabilities,
  createRunner,
  createSecretBox,
  generateKeyPair,
  IDENTITY_ISSUE_KIND,
  KEY_LINE,
  networkRulesStatement,
  type PublicJwk,
  schema,
  signRequest,
  TAG_AGENT,
  TAG_WEB_BOT_AUTH,
  thumbprint,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import {
  agentFromRequest,
  carriesSecret,
  createIdentityPort,
  forwardable,
  identityIssueHandler,
} from "../src/identity";
import { freshDb } from "./db";
import { fakeNetwork } from "./fake-network";

/**
 * People at the doors (ADR-017 §2.1, §7.2, §8.1): a first contact gets a key and a pass from each
 * network that issues, over calls signed sdi-instance/1 that the fake network checks against the
 * instance's published keys; what an agent carries is presented, cached by hash and, while a
 * network is down, stood in for by a stored link; a pass reference travels only as the agent's own
 * signature, forwarded. Runs on Node and inside workerd.
 */
const T0 = Date.parse("2026-09-23T09:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = "identity-adapters-instance-key-0123456789";
const ISS = "https://inbox.example.com";
const HOST = "net.example.com";
const NET = `https://${HOST}`;

const owner = (t: number): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const agent = (t: number, extra: Partial<Caller> = {}): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
  ...extra,
});

async function setup(opts: { intercept?: Parameters<typeof fakeNetwork>[0]["intercept"] } = {}) {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox([KEY]), ISS, 0);
  // Switched on for people, sharing nothing else, so no ping or publishing job is part of this.
  await caps.updateSettings(owner(T0), {
    doc: {
      networks: { [NET]: { enabled: true, share: { listing: false, counts: false, receipts: false } } },
      business: { name: "Oficina Maré" },
    },
  });
  await db.client.query({ sql: "DELETE FROM jobs", params: [], method: "run" });
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const net = fakeNetwork({
    host: HOST,
    keys: async () => (await caps.receipts.jwks()).keys as PublicJwk[],
    instanceDomain: "inbox.example.com",
    ...(opts.intercept ? { intercept: opts.intercept } : {}),
  });
  const deps = { db, caps, baseUrl: ISS, version: "0.0.0", fetchImpl: net.fetchImpl, timeoutMs: 1_000 };
  const port = createIdentityPort(deps);
  const mail = logMailOut();
  caps.people.attachPort(port);
  caps.people.attachMail(mail);
  const runner = createRunner({ mailOut: mail, receipts: caps.receipts, secrets: caps.secrets, baseUrl: ISS }).register(
    IDENTITY_ISSUE_KIND,
    identityIssueHandler({ ...deps, port }),
  );
  const drain = async (t: number) => {
    for (let i = 0; i < 30; i++) {
      const r = await runner.runDue(db, { now: t, limit: 100 });
      if (r.claimed === 0) return;
    }
  };
  const book = (caller: Caller, extra: Record<string, unknown> = {}, email = "rita@example.com") =>
    caps.createBooking(caller, {
      payload: {
        reservationFor: { serviceId: svc, name: "Surf lesson" },
        startTime: new Date(T0 + 2 * DAY).toISOString(),
        endTime: new Date(T0 + 2 * DAY + 90 * MIN).toISOString(),
      },
      contact: { name: "Rita", email },
      ...extra,
    });
  return { db, caps, net, port, mail, runner, drain, book };
}

/** What a customer's email never says: they wrote to a business, and it is the business that writes back. */
const PLATFORM_WORDS = /surfing ?dog|network|\bpass\b|\bkeys?\b|receipt|reputation|presentation/i;

const rows = async (db: Awaited<ReturnType<typeof freshDb>>["db"], sql: string, params: unknown[] = []) =>
  (await db.client.query({ sql, params: params as never, method: "all" })).rows;

describe("a first contact (§2.1)", () => {
  it("gets a key and a pass, hands the pass back, seals both, and links the person", async () => {
    const s = await setup();
    const r = await s.book(agent(T0));
    const itemId = r.view.item.id;
    expect(r.identity).toMatchObject({ recognised: "none", networks: [{ network: NET, state: "issued" }] });
    expect(r.identity?.passes).toHaveLength(1);
    expect(r.identity?.passes[0]?.pass).toMatch(/^sdpass1_net\.example\.com_[a-z2-7]{16}_[a-z2-7]{32}$/);
    expect(r.identity?.guide).toBe("https://surfingdog.ai/for-agents.md");

    // One call, signed so that the network verifies it against the manifest's keys, named by the item.
    const persons = s.net.calls.filter((c) => c.path === "/v1/persons");
    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({ verified: true, body: { request_id: itemId, email: "rita@example.com" } });

    // Sealed, never in the clear; the presentation is the item's, the person linked to its party.
    const pending = await rows(s.db, "SELECT state, key_enc, pass_enc FROM pending_identity WHERE item_id = ?", [
      itemId,
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.[0]).toBe("issued");
    expect(String(pending[0]?.[1])).toMatch(/^v1\./);
    const dump = JSON.stringify(await rows(s.db, "SELECT * FROM pending_identity"));
    expect(dump).not.toContain("sdkey1_");
    expect(dump).not.toContain("sdpass1_");
    const presented = await rows(s.db, "SELECT network, ppid FROM item_presentations WHERE item_id = ?", [itemId]);
    expect(presented).toEqual([[NET, s.net.ppidOf(s.net.persons[0] as never)]]);
    const links = await rows(s.db, "SELECT party_id, network, ppid, pass_hash IS NOT NULL FROM person_links");
    expect(links).toEqual([[r.view.item.partyId, NET, s.net.ppidOf(s.net.persons[0] as never), 1]]);

    // The rules were queued a moment ahead for those answers; they are in, so the rules are due at
    // once, for the runner pass that follows the request (Workers' waitUntil) to run them.
    const rules = await rows(s.db, "SELECT run_at FROM jobs WHERE kind = 'rules'");
    expect(Number(rules[0]?.[0])).toBe(T0);

    // The status door hands the pass back.
    const status = await s.caps.getItemStatus(agent(T0 + MIN), { item_id: itemId, access_token: r.accessToken });
    expect(status.identity.passes).toEqual(r.identity?.passes);
  });

  it("sends the key with the first email to the customer, once", async () => {
    const s = await setup();
    const r = await s.book(agent(T0));
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + 2 * MIN);
    const toRita = s.mail.sent.filter((m) => m.to.includes("rita@example.com"));
    expect(toRita).toHaveLength(1);
    const key = /sdkey1_net\.example\.com_[a-z2-7]{16}_[a-z2-7]{32}/.exec(toRita[0]?.text ?? "")?.[0];
    expect(key).toBeDefined();
    expect(toRita[0]?.text).toContain(`${KEY_LINE} ${key}`);
    // The business speaking: its name on it, its own words, one quiet line at the end, nobody else.
    expect(toRita[0]?.from).toEqual({ address: "inbox@localhost", name: "Oficina Maré" });
    expect(toRita[0]?.text.trim().split("\n").at(-1)).toBe(`${KEY_LINE} ${key}`);
    expect(`${toRita[0]?.subject}\n${toRita[0]?.text.replace(key ?? "", "")}`).not.toMatch(PLATFORM_WORDS);
    const pending = await rows(s.db, "SELECT key_enc, delivered_at, pass_enc IS NOT NULL FROM pending_identity");
    expect(pending).toEqual([[null, T0 + 2 * MIN, 1]]);
    // A second email to the customer carries no key.
    await s.caps.transitionItem(owner(T0 + 3 * MIN), { item_id: r.view.item.id, event: "cancel_by_business" });
    await s.drain(T0 + 4 * MIN);
    const later = s.mail.sent.filter((m) => m.to.includes("rita@example.com"));
    expect(later).toHaveLength(2);
    expect(later[1]?.text).not.toContain("sdkey1_");
  });

  it("carries no key in any email when the business switched the line off", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner(T0), { doc: { customers: { emailKey: false } } });
    const r = await s.book(agent(T0));
    // The assistant still gets its pass.
    expect(r.identity?.passes).toHaveLength(1);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + 2 * MIN);
    await s.db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), T0 + DAY + MIN, "sweep-test-off", T0],
      method: "run",
    });
    await s.drain(T0 + DAY + MIN);
    const toRita = s.mail.sent.filter((m) => m.to.includes("rita@example.com"));
    expect(toRita.map((m) => m.subject)).toEqual(["Confirmed: Surf lesson"]);
    expect(toRita[0]?.text).not.toContain("sdkey1_");
    expect(toRita[0]?.text).not.toContain("assistant");
  });

  it("sends a key no email carried within a day in one line of its own, and keeps nothing after seven days", async () => {
    const s = await setup();
    await s.book(agent(T0));
    await s.db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), T0 + DAY + MIN, "sweep-test-1", T0],
      method: "run",
    });
    await s.drain(T0 + HOUR);
    expect(s.mail.sent.filter((m) => m.to.includes("rita@example.com"))).toHaveLength(0);
    await s.drain(T0 + DAY + MIN);
    const alone = s.mail.sent.filter((m) => m.to.includes("rita@example.com"));
    expect(alone).toHaveLength(1);
    // From the business, about what Rita booked with it, in one line: nothing about anyone else.
    expect(alone[0]?.from).toEqual({ address: "inbox@localhost", name: "Oficina Maré" });
    expect(alone[0]?.subject).toBe("For next time: Surf lesson");
    expect(alone[0]?.text).toMatch(new RegExp(`^${KEY_LINE} sdkey1_net\\.example\\.com_[a-z2-7]{16}_[a-z2-7]{32}$`));
    expect(KEY_LINE).toBe("If you use an assistant, it can show this code next time so we recognise you:");
    expect(`${alone[0]?.subject} ${alone[0]?.text.replace(/sdkey1_\S+/, "")}`).not.toMatch(PLATFORM_WORDS);
    await s.db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), T0 + 8 * DAY, "sweep-test-2", T0],
      method: "run",
    });
    await s.drain(T0 + 8 * DAY);
    expect(await rows(s.db, "SELECT COUNT(*) FROM pending_identity")).toEqual([[0]]);
  });

  it("tells the agent to present the person's pass when the network knows them, and asks no more that day", async () => {
    const s = await setup();
    s.net.addPerson("rita@example.com");
    const r = await s.book(agent(T0));
    expect(r.identity).toMatchObject({
      recognised: "none",
      passes: [],
      networks: [{ network: NET, state: "person_exists" }],
    });
    await s.book(agent(T0 + HOUR));
    // Cached for a day: the second booking asked nobody.
    expect(s.net.calls.filter((c) => c.path === "/v1/persons")).toHaveLength(1);
    await s.book(agent(T0 + DAY + MIN));
    expect(s.net.calls.filter((c) => c.path === "/v1/persons")).toHaveLength(2);
  });

  it("leaves the item alone when no network answers, and asks again with the same request id", async () => {
    let down = true;
    const s = await setup({
      intercept: (path) => (path === "/v1/persons" && down ? new Response("down", { status: 503 }) : undefined),
    });
    const r = await s.book(agent(T0));
    expect(r.view.item.state).toBe("requested");
    expect(r.identity).toMatchObject({ passes: [], networks: [{ network: NET, state: "pending" }] });

    // The confirmation's promise waits for the person, at most fifteen minutes.
    await s.caps.transitionItem(owner(T0 + 10_000), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + 20_000);
    expect(await rows(s.db, "SELECT COUNT(*) FROM receipts")).toEqual([[0]]);

    down = false;
    await s.drain(T0 + 2 * MIN);
    const persons = s.net.calls.filter((c) => c.path === "/v1/persons");
    expect(persons.map((c) => c.body?.request_id)).toEqual([r.view.item.id, r.view.item.id]);
    expect(await rows(s.db, "SELECT state FROM pending_identity")).toEqual([["issued"]]);
    // The promise names the person the network presented.
    await s.drain(T0 + 3 * MIN);
    const [receipt] = await rows(s.db, "SELECT payload FROM receipts");
    const claims = JSON.parse(String(receipt?.[0])) as { per?: { n: string; p: string }[] };
    expect(claims.per).toEqual([{ n: HOST, p: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) }]);
    // And the status door hands back the pass the retry got.
    const status = await s.caps.getItemStatus(agent(T0 + 4 * MIN), {
      item_id: r.view.item.id,
      access_token: r.accessToken,
    });
    expect(status.identity.passes).toHaveLength(1);
  });

  it("links a weak match's new person to the customer it may be only once a code proves it", async () => {
    const s = await setup();
    // The business made a booking for Rita itself: it knows her address, and no network knows her.
    const byOwner = await s.book(owner(T0));
    expect(s.net.calls).toHaveLength(0);
    const r = await s.book(agent(T0 + MIN));
    expect(r.identity).toMatchObject({ recognised: "weak", networks: [{ network: NET, state: "issued" }] });
    expect(r.identity?.passes).toHaveLength(1);
    expect(await rows(s.db, "SELECT COUNT(*) FROM person_links")).toEqual([[0]]);
    await s.caps.verifyCustomer(agent(T0 + 2 * MIN), { item_id: r.view.item.id, access_token: r.accessToken });
    const code = /\b(\d{6})\b/.exec(s.mail.sent.at(-1)?.text ?? "")?.[1] as string;
    await s.caps.verifyCustomer(agent(T0 + 3 * MIN), { item_id: r.view.item.id, access_token: r.accessToken, code });
    expect(await rows(s.db, "SELECT party_id FROM person_links")).toEqual([[byOwner.view.item.partyId]]);
    // Next time, the pass alone is the customer the business knows.
    const next = await s.book(agent(T0 + DAY), { pass: r.identity?.passes[0]?.pass });
    expect(next.identity?.recognised).toBe("strong");
    expect(next.view.item.partyId).toBe(byOwner.view.item.partyId);
  });

  it("asks again the next day when the network's issuance limit is reached", async () => {
    let limited = true;
    const s = await setup({
      intercept: (path) =>
        path === "/v1/persons" && limited
          ? Response.json({ status: 429, code: "rate_limited", title: "limited", type: "x" }, { status: 429 })
          : undefined,
    });
    const r = await s.book(agent(T0));
    expect(await rows(s.db, "SELECT state FROM pending_identity")).toEqual([["limited"]]);
    await s.drain(T0 + 2 * MIN);
    expect(await rows(s.db, "SELECT state FROM pending_identity")).toEqual([["limited"]]);
    const next = await rows(s.db, "SELECT run_at FROM jobs WHERE kind = ? AND status = 'queued'", [
      IDENTITY_ISSUE_KIND,
    ]);
    // Asked again a day after the network said so, not before.
    expect(next.map((j) => Number(j[0]))).toEqual([T0 + DAY]);
    expect(s.net.calls.filter((c) => c.path === "/v1/persons")).toHaveLength(1);
    limited = false;
    await s.drain(T0 + DAY);
    expect(await rows(s.db, "SELECT state FROM pending_identity")).toEqual([["issued"]]);
    expect(r.view.item.id).toBeDefined();
  });
});

describe("what an agent carries (§7.2, §8.1)", () => {
  it("recognises a pass it has seen, joins the customer's party, and asks the network once an hour", async () => {
    const s = await setup();
    const first = await s.book(agent(T0));
    const pass = first.identity?.passes[0]?.pass as string;
    const second = await s.book(agent(T0 + DAY), { pass }, "rita.other@example.com");
    expect(second.identity).toMatchObject({ recognised: "strong", networks: [{ network: NET, state: "presented" }] });
    expect(second.view.item.partyId).toBe(first.view.item.partyId);
    const third = await s.book(agent(T0 + DAY + MIN), { pass });
    expect(third.view.item.partyId).toBe(first.view.item.partyId);
    // The same pass with the same email within the hour: answered from the cache.
    const fourth = await s.book(agent(T0 + DAY + 30 * MIN), { pass });
    expect(fourth.view.item.partyId).toBe(first.view.item.partyId);
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations")).toHaveLength(2);
    // Each presentation asked with the item's email, so the network can say whose it is.
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations").map((c) => c.body?.email)).toEqual([
      "rita.other@example.com",
      "rita@example.com",
    ]);
    // A pass presented is never stored, not even in the cache.
    expect(JSON.stringify(await rows(s.db, "SELECT * FROM network_cache"))).not.toContain(pass);
    // The status door recognises the person by the pass alone, without the access token.
    const status = await s.caps.getItemStatus(agent(T0 + DAY + 2 * MIN, { carried: [pass] }), {
      item_id: first.view.item.id,
    });
    expect(status.item.id).toBe(first.view.item.id);
  });

  it("exchanges a key for a pass it hands back once, and never stores the key", async () => {
    const s = await setup();
    const known = s.net.addPerson("ana@example.pt", { tier: "trusted", score: 0.81, kept: 6 });
    const r = await s.book(agent(T0), { key: known.key }, "ana@example.pt");
    expect(r.identity?.passes).toHaveLength(1);
    expect(r.identity?.passes[0]?.pass).not.toBe(known.pass);
    expect(r.identity?.recognised).toBe("none");
    const [presented] = await rows(s.db, "SELECT person FROM item_presentations");
    expect(JSON.parse(String(presented?.[0]))).toMatchObject({ tier: "trusted", score: 0.81 });
    const everything = JSON.stringify([
      await rows(s.db, "SELECT * FROM item_presentations"),
      await rows(s.db, "SELECT * FROM person_links"),
      await rows(s.db, "SELECT * FROM network_cache"),
      await rows(s.db, "SELECT * FROM items"),
      await rows(s.db, "SELECT * FROM item_events"),
      await rows(s.db, "SELECT * FROM idempotency_keys"),
    ]);
    expect(everything).not.toContain(known.key);
    // No first contact for someone who carried something.
    expect(s.net.calls.filter((c) => c.path === "/v1/persons")).toHaveLength(0);
    // The status door says nothing of a pass a key became: it was handed back once.
    const status = await s.caps.getItemStatus(agent(T0 + MIN), {
      item_id: r.view.item.id,
      access_token: r.accessToken,
    });
    expect(status.identity.passes).toEqual([]);
  });

  it("keeps a revoked pass's answer for an hour, and presents only to networks switched on", async () => {
    const s = await setup();
    const known = s.net.addPerson("ana@example.pt");
    s.net.revoke(known.pass);
    const other = "sdpass1_other.example.org_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567";
    const r = await s.book(agent(T0), { pass: `${known.pass} ${other}` }, "ana@example.pt");
    expect(r.identity?.networks).toEqual([
      { network: NET, state: "revoked" },
      { network: "https://other.example.org", state: "not_enabled" },
    ]);
    await s.book(agent(T0 + 30 * MIN), { pass: known.pass }, "ana@example.pt");
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations")).toHaveLength(1);
  });

  it("stands in with a stored link only while the network cannot be reached", async () => {
    let down = false;
    const s = await setup({
      intercept: (path) => (path === "/v1/presentations" && down ? new Response("down", { status: 502 }) : undefined),
    });
    const first = await s.book(agent(T0));
    const pass = first.identity?.passes[0]?.pass as string;
    down = true;
    const second = await s.book(agent(T0 + DAY), { pass }, "rita@example.com");
    expect(second.view.item.partyId).toBe(first.view.item.partyId);
    expect(second.identity?.recognised).toBe("strong");
    // The stand-in names no presentation, so the item's promises carry none for it.
    expect(
      await rows(s.db, "SELECT presentation_id FROM item_presentations WHERE item_id = ?", [second.view.item.id]),
    ).toEqual([[""]]);
    // Three failures in a row, and the network is left alone for a minute.
    await s.book(agent(T0 + DAY + 1_000), { pass: `${pass.slice(0, -1)}a` });
    await s.book(agent(T0 + DAY + 2_000), { pass: `${pass.slice(0, -1)}b` });
    const tried = s.net.calls.filter((c) => c.path === "/v1/presentations").length;
    await s.book(agent(T0 + DAY + 3_000), { pass: `${pass.slice(0, -1)}c` });
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations").length).toBe(tried);
  });

  it("forwards a pass reference only as the agent's own signature, which the network verifies", async () => {
    const s = await setup();
    const known = s.net.addPerson("ana@example.pt", { tier: "trusted", score: 0.8, kept: 5, emailProven: true });
    const agentKey = await generateKeyPair();
    const jkt = await thumbprint(agentKey.publicJwk);
    const passRef = s.net.delegate(known.pass, jkt, agentKey.publicJwk.x);

    // Unsigned, a pass reference is not presented at all.
    const unsigned = await s.book(agent(T0), { pass: passRef }, "ana@example.pt");
    expect(unsigned.identity?.networks).toEqual([{ network: NET, state: "pass_requires_signature" }]);
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations")).toHaveLength(0);

    // Signed by the delegated key, it goes as agent_key and the network verifies the base itself.
    const body = JSON.stringify({ pass: passRef });
    const request = await signedAgentRequest({
      url: `${ISS}/v1/bookings`,
      body,
      key: agentKey,
      extraHeaders: { "Sdi-Pass": `"${passRef}"` },
    });
    const seen = await agentFromRequest(s.db, request, { baseUrl: ISS });
    expect(seen.agent).toMatchObject({ level: "self", thumbprint: jkt });
    expect(seen.carried).toEqual([passRef]);
    const signed = await s.book(agent(T0 + MIN, { agent: seen.agent, carried: seen.carried }), {}, "ana@example.pt");
    // The network says the item's email is the person's, proven by a code: the customer the
    // business knows by that address (the unsigned booking's) is this person.
    expect(signed.identity).toMatchObject({ recognised: "strong", networks: [{ network: NET, state: "presented" }] });
    expect(signed.view.item.partyId).toBe(unsigned.view.item.partyId);
    const [call] = s.net.calls.filter((c) => c.path === "/v1/presentations");
    expect(call?.body).toMatchObject({ agent_key: { jkt, pass_ref: passRef, label: "sig1" }, purpose: "request" });
    const [row] = await rows(s.db, "SELECT agent_thumbprint, agent_level, customer_match FROM items WHERE id = ?", [
      signed.view.item.id,
    ]);
    expect(row).toEqual([jkt, "self", "strong"]);
    // A bound pass's secret form is worthless on its own.
    const copied = await s.book(agent(T0 + 2 * MIN), { pass: known.pass }, "ana@example.pt");
    expect(copied.identity?.networks).toEqual([{ network: NET, state: "pass_requires_signature" }]);
  });

  it("never forwards a signature whose base would hand the network a secret", async () => {
    const s = await setup();
    const known = s.net.addPerson("ana@example.pt", { tier: "trusted", score: 0.8, kept: 5, emailProven: true });
    const agentKey = await generateKeyPair();
    const jkt = await thumbprint(agentKey.publicJwk);
    const passRef = s.net.delegate(known.pass, jkt, agentKey.publicJwk.x);
    const other = "sdpass1_other.example.org_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const cases: { url: string; pass: string; headers?: Record<string, string>; cover?: string[] }[] = [
      // The item's access token in the signed URL.
      { url: `${ISS}/v1/bookings?access_token=tok_secret_value`, pass: `"${passRef}"` },
      // Another network's pass, secret and all, in the signed Sdi-Pass beside the reference.
      { url: `${ISS}/v1/bookings`, pass: `"${passRef}", "${other}"` },
      // A header the agent chose to sign as well: the item's access token, an API key, a cookie.
      {
        url: `${ISS}/v1/bookings`,
        pass: `"${passRef}"`,
        headers: { "X-Access-Token": "tok" },
        cover: ["x-access-token"],
      },
      {
        url: `${ISS}/v1/bookings`,
        pass: `"${passRef}"`,
        headers: { Authorization: "Bearer k" },
        cover: ["authorization"],
      },
      { url: `${ISS}/v1/bookings`, pass: `"${passRef}"`, headers: { Cookie: "s=1" }, cover: ["cookie"] },
    ];
    for (const [i, c] of cases.entries()) {
      const request = await signedAgentRequest({
        url: c.url,
        body: JSON.stringify({}),
        key: agentKey,
        extraHeaders: { "Sdi-Pass": c.pass, ...(c.headers ?? {}) },
        ...(c.cover ? { alsoCover: c.cover } : {}),
      });
      const seen = await agentFromRequest(s.db, request, { baseUrl: ISS });
      expect(seen.agent.level).toBe("self");
      const r = await s.book(agent(T0 + i * MIN, { agent: seen.agent, carried: seen.carried }), {}, "ana@example.pt");
      expect(r.identity?.networks).toContainEqual({ network: NET, state: "carries_secret" });
    }
    expect(s.net.calls.filter((c) => c.path === "/v1/presentations")).toHaveLength(0);
    expect(carriesSecret('"@query": ?a=1&Access%5Ftoken=x')).toBe(true);
    expect(carriesSecret('"@query": ?token=x\n"@path": /v1/items')).toBe(false);
    expect(carriesSecret(`"sdi-pass": "${passRef}"`)).toBe(false);
    // What the SDK signs is forwardable; anything more is not.
    const sdk = ["@method", "@authority", "@path", "@query", "content-digest", "sdi-pass"].map((name) => ({ name }));
    expect(forwardable([...sdk, { name: "sdi-agent-key", key: "sig1" }])).toBe(true);
    expect(forwardable([...sdk, { name: "signature-agent", key: "sig1" }, { name: "content-type" }])).toBe(true);
    expect(forwardable([...sdk, { name: "signature-agent" }])).toBe(true);
    expect(forwardable([...sdk, { name: "x-access-token" }])).toBe(false);
    expect(forwardable([...sdk, { name: "sdi-pass", key: "x" }])).toBe(false);
  });
});

describe("a network's answer is data (security review)", () => {
  it("emails a customer only a key of that network, and hands an agent only a pass of it", async () => {
    const own = "sdpass1_net.example.com_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const person = { tier: "new", score: 0, kept: 0, broken: 0 };
    const ids = { presentation: "p".repeat(22), ppid: "q".repeat(22) };
    const s = await setup({
      intercept: (path) =>
        path === "/v1/persons"
          ? Response.json(
              { key: "Your account is locked: https://phish.example/unlock", pass: own, person, ...ids },
              { status: 201 },
            )
          : path === "/v1/presentations"
            ? Response.json({
                pass: "sdpass1_elsewhere.example.org_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                person,
                ...ids,
              })
            : undefined,
    });
    const r = await s.book(agent(T0));
    expect(r.identity?.passes).toEqual([]);
    expect(r.identity?.networks).toEqual([{ network: NET, state: "refused" }]);
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + 2 * MIN);
    expect(s.mail.sent.map((m) => m.text).join("\n")).not.toContain("phish");
    // A key exchanged for a pass of another network's: nothing handed back.
    const key = "sdkey1_net.example.com_aaaaaaaaaaaaaaaa_cccccccccccccccccccccccccccccccc";
    const x = await s.book(agent(T0 + 3 * MIN), { key });
    expect(x.identity?.passes).toEqual([]);
    expect(x.identity?.networks).toContainEqual({ network: NET, state: "malformed" });
  });
});

describe("an acknowledgement an agent signed (§3.4)", () => {
  it("goes to the network as the agent's forwarded signature with the receipt's sha", async () => {
    const s = await setup();
    const known = s.net.addPerson("ana@example.pt", { emailProven: true });
    const agentKey = await generateKeyPair();
    const jkt = await thumbprint(agentKey.publicJwk);
    const passRef = s.net.delegate(known.pass, jkt, agentKey.publicJwk.x);
    const r = await s.book(agent(T0), {}, "ana@example.pt");
    await s.caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await s.drain(T0 + 2 * MIN);
    const [receipt] = await s.caps.receipts.forItem(r.view.item.id);
    expect(receipt?.kind).toBe("confirmed");

    // Unsigned, naming a receipt is refused: only a counter-signature or a signature will do.
    await expect(
      s.caps.acknowledgeReceipt(agent(T0 + 3 * MIN, { carried: [passRef] }), {
        item_id: r.view.item.id,
        receipt_id: receipt?.id,
        access_token: r.accessToken,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const body = JSON.stringify({ receipt_id: receipt?.id, access_token: r.accessToken });
    const request = await signedAgentRequest({
      url: `${ISS}/v1/items/${r.view.item.id}/receipt-ack`,
      body,
      key: agentKey,
      extraHeaders: { "Sdi-Pass": `"${passRef}"` },
    });
    const seen = await agentFromRequest(s.db, request, { baseUrl: ISS });
    const acked = await s.caps.acknowledgeReceipt(agent(T0 + 3 * MIN, { agent: seen.agent, carried: seen.carried }), {
      item_id: r.view.item.id,
      receipt_id: receipt?.id,
      access_token: r.accessToken,
    });
    expect(acked.forwarded).toEqual([{ network: NET, presentation: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) }]);
    const [call] = s.net.calls.filter((c) => c.path === "/v1/presentations");
    const [sha] = (await rows(s.db, "SELECT sha FROM receipts WHERE id = ?", [receipt?.id])).map((x) => String(x[0]));
    expect(call?.body).toMatchObject({ purpose: "ack", sha, agent_key: { jkt, pass_ref: passRef } });
  });
});

describe("an agent's signature at the door (§2.4)", () => {
  it("verifies a self-held key, keeps the signature once, and says why one fails", async () => {
    const s = await setup();
    const key = await generateKeyPair();
    const request = await signedAgentRequest({ url: `${ISS}/v1/bookings`, body: '{"x":1}', key });
    const first = await agentFromRequest(s.db, request.clone(), { baseUrl: ISS });
    expect(first).toMatchObject({ agent: { level: "self" }, replayed: false });
    const again = await agentFromRequest(s.db, request.clone(), { baseUrl: ISS });
    expect(again.replayed).toBe(true);
    // Made for another host: counted as unsigned, and told.
    const elsewhere = await signedAgentRequest({ url: "https://other.example.com/v1/bookings", body: "{}", key });
    const bad = await agentFromRequest(s.db, new Request(`${ISS}/v1/bookings`, elsewhere.clone()), { baseUrl: ISS });
    expect(bad).toMatchObject({
      agent: { level: "none", invalid: "bad_signature" },
      header: 'invalid; reason="bad_signature"',
    });
    // An extra authority the owner names is honoured.
    await s.caps.updateSettings(owner(T0), { doc: { identity: { extraAuthorities: ["other.example.com"] } } });
    const ok = await agentFromRequest(s.db, new Request(`${ISS}/v1/bookings`, elsewhere.clone()), { baseUrl: ISS });
    expect(ok.agent.level).toBe("self");
    // Unsigned requests are unsigned; Sdi-Pass is read either way.
    const plain = await agentFromRequest(
      s.db,
      new Request(`${ISS}/v1/items/x`, { headers: { "Sdi-Pass": '"a", "b"', "User-Agent": "ChatGPT-User/1.0" } }),
      { baseUrl: ISS },
    );
    expect(plain).toEqual({ agent: { level: "none", label: "ChatGPT-User" }, carried: ["a", "b"], replayed: false });
  });

  it("vouches a key a platform's directory lists only when a network it reports to recognises the platform", async () => {
    const s = await setup();
    const platformKey = await generateKeyPair();
    let fetched = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetched++;
      const url = new URL(String(input));
      if (url.href === "https://agents.example.net/.well-known/http-message-signatures-directory") {
        return Response.json({ keys: [platformKey.publicJwk] }, { headers: { "cache-control": "max-age=600" } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const sign = () =>
      signedAgentRequest({
        url: `${ISS}/v1/bookings`,
        body: "{}",
        key: platformKey,
        platform: "https://agents.example.net",
      });
    // Listed by its platform's directory and signed — but no network this inbox reports to has said
    // it recognises that platform: a directory anyone can publish, so the agent's own key, no more.
    const seen = await agentFromRequest(s.db, await sign(), { baseUrl: ISS, fetchImpl });
    expect(seen.agent).toMatchObject({
      level: "self",
      platform: "https://agents.example.net",
      label: "agents.example.net",
    });
    // The network's rules name it (`verified.recognised_platforms`, read with them): vouched.
    await s.db.client.query(
      networkRulesStatement(NET, T0, { version: 3, next: null, nextAt: null }, T0, ["agents.example.net"]),
    );
    const vouched = await agentFromRequest(s.db, await sign(), { baseUrl: ISS, fetchImpl });
    expect(vouched.agent).toMatchObject({ level: "vouched", platform: "https://agents.example.net" });
    // Cached: the directory was fetched once for all of these.
    expect(fetched).toBe(1);
    // A network that recognises it and is switched off recognises nothing for this inbox, even
    // while another network, one that does not name the platform, is switched on.
    await s.caps.updateSettings(owner(T0), { doc: { networks: { [NET]: { enabled: false } } } });
    expect((await agentFromRequest(s.db, await sign(), { baseUrl: ISS, fetchImpl })).agent.level).toBe("self");
    const other = "https://other-net.example.com";
    await s.caps.updateSettings(owner(T0), {
      doc: { networks: { [other]: { enabled: true, share: { listing: false, counts: false, receipts: false } } } },
    });
    await s.db.client.query(networkRulesStatement(other, T0, { version: 3, next: null, nextAt: null }, T0, []));
    expect((await agentFromRequest(s.db, await sign(), { baseUrl: ISS, fetchImpl })).agent.level).toBe("self");
    await s.caps.updateSettings(owner(T0), { doc: { networks: { [NET]: { enabled: true } } } });
    // Another platform the same network does not name stays the agent's own key.
    await s.db.client.query(
      networkRulesStatement(NET, T0, { version: 3, next: null, nextAt: null }, T0, ["other.example.org"]),
    );
    expect((await agentFromRequest(s.db, await sign(), { baseUrl: ISS, fetchImpl })).agent.level).toBe("self");

    // A made-up platform from the same address in the same minute is not fetched.
    const made = await signedAgentRequest({
      url: `${ISS}/v1/bookings`,
      body: "{}",
      key: platformKey,
      platform: "https://made-up.example.net",
    });
    const refused = await agentFromRequest(s.db, made, { baseUrl: ISS, fetchImpl });
    expect(refused.agent).toMatchObject({ level: "none", invalid: "unknown_key" });
    expect(fetched).toBe(1);
  });
});

/** A request an agent signed (sdi-agent/1 with its own key, or Web Bot Auth for a platform). */
async function signedAgentRequest(opts: {
  url: string;
  body: string;
  key: Awaited<ReturnType<typeof generateKeyPair>>;
  platform?: string;
  extraHeaders?: Record<string, string>;
  /** Headers the signature covers beyond the profile's own (lowercase names). */
  alsoCover?: string[];
}): Promise<Request> {
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
  const covered: { name: string; key?: string }[] = (opts.alsoCover ?? []).map((name) => ({ name }));
  const jwk = { kty: "OKP", crv: "Ed25519", x: opts.key.publicJwk.x };
  if (opts.platform) {
    headers["Signature-Agent"] = `sig1="${opts.platform}"`;
    covered.push({ name: "signature-agent", key: "sig1" });
  } else {
    let binary = "";
    for (const b of new TextEncoder().encode(JSON.stringify(jwk))) binary += String.fromCharCode(b);
    headers["Sdi-Agent-Key"] = `sig1=:${btoa(binary)}:`;
    covered.push({ name: "sdi-agent-key", key: "sig1" });
  }
  if (headers["Sdi-Pass"] !== undefined) covered.push({ name: "sdi-pass" });
  const created = Math.floor(Date.now() / 1000);
  const signed = await signRequest({
    method: "POST",
    url: opts.url,
    body: opts.body,
    headers,
    covered,
    keyid: await thumbprint(jwk),
    privateJwk: opts.key.privateJwk,
    tag: opts.platform ? TAG_WEB_BOT_AUTH : TAG_AGENT,
    created,
    expires: created + 60,
  });
  return new Request(opts.url, {
    method: "POST",
    body: opts.body,
    headers: { "content-type": "application/json", ...signed.headers },
  });
}
