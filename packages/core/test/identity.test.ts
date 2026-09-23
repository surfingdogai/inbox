import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customerSummary } from "../src/capabilities/identity";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { collectCarried } from "../src/identity/carried";
import { backfillPartyContacts, maskEmail, normalisePhone } from "../src/identity/contacts";
import { customerHistory } from "../src/identity/history";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { evaluate, NO_AGENT_CONTEXT, NO_CUSTOMER, NO_PERSON, type RuleContext } from "../src/rules/evaluate";
import { PRESETS } from "../src/rules/presets";
import { positiveOnlyProblem } from "../src/rules/reputation";
import type { RuleDefinition } from "../src/rules/schema";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { availabilityRules, items, jobs, parties, products, rules, services } from "../src/schema/tables";
import { readSettings } from "../src/settings/schema";
import { WriteError } from "../src/write/errors";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Customers the business already knows (ADR-017 §8.2) and the rules that may read a standing
 * (§8.3): matches decided in the create batch, one-time codes that merge, the business's own
 * history, and "positive only" — enforced when a rule is saved and again when an old one runs.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0, extra: Partial<Caller> = {}): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
  ...extra,
});

async function setup(vertical?: keyof typeof PRESETS) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Massage",
    durationMin: 60,
    capacity: 3,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const week = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["08:00", "20:00"]]]),
  );
  await db.orm.insert(availabilityRules).values({ id: ulid(), kind: "open", weekly: week, createdAt: T0 });
  if (vertical) {
    await db.orm.insert(rules).values(
      (PRESETS[vertical] ?? []).map((p) => ({
        id: ulid(),
        name: p.name,
        priority: p.priority,
        enabled: 1,
        definition: p.definition,
        createdAt: T0,
        updatedAt: T0,
      })),
    );
  }
  const mail = logMailOut();
  const caps = new Capabilities(db);
  caps.people.attachMail(mail);
  const runner = createRunner({ mailOut: mail });
  let slot = 0;
  const book = (caller: Caller, contact: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const start = T0 + 2 * DAY + ++slot * 90 * MIN;
    return caps.createBooking(caller, {
      payload: {
        reservationFor: { serviceId: svc, name: "Massage" },
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 60 * MIN).toISOString(),
        ...extra,
      },
      contact,
    });
  };
  const drain = async (t = T0) => {
    for (let i = 0; i < 10; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  // The business sets its prices (ADR-018 §3.2): a price a rule reads is one the catalogue gives.
  const priced = async (value: number) => {
    const id = ulid();
    await db.orm.insert(services).values({
      id,
      name: "Massage",
      durationMin: 60,
      capacity: 3,
      granularityMin: 30,
      price: { model: "fixed", value, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    });
    return { reservationFor: { serviceId: id, name: "Massage" } };
  };
  const product = async (value: number) => {
    const id = ulid();
    await db.orm
      .insert(products)
      .values({ id, name: "Chain", price: { value, currency: "EUR" }, createdAt: T0, updatedAt: T0 });
    return id;
  };
  return { db, caps, mail, runner, svc, book, drain, priced, product };
}

const col = async (db: Db, itemId: string) => {
  const [row] = await db.orm.select().from(items).where(eq(items.id, itemId));
  return row;
};

describe("what an agent carries", () => {
  it("counts at most eight strings, the first per network, a field before the header and a pass before a key", () => {
    const p = (host: string, c = "a") => `sdpass1_${host}_${c.repeat(16)}_${"b".repeat(32)}`;
    const key = `sdkey1_one.example.com_${"c".repeat(16)}_${"d".repeat(32)}`;
    expect(
      collectCarried(`${p("one.example.com")}  ${p("two.example.com")}`, key, [p("one.example.com", "e")]),
    ).toEqual({
      credentials: [p("one.example.com"), p("two.example.com")],
      dropped: 0,
    });
    expect(collectCarried("nonsense", undefined, [p("one.example.com")])).toEqual({
      credentials: [p("one.example.com")],
      dropped: 1,
    });
    expect(() =>
      collectCarried(Array.from({ length: 9 }, (_, i) => p(`n${i}.example.com`)).join(" "), undefined, []),
    ).toThrow(WriteError);
    expect(() => collectCarried(undefined, "sdpass1_x.example.com_aaaaaaaaaaaaaaaa", [])).toThrow(/not a key/);
  });

  it("normalises phones to six or more digits and masks an address", () => {
    expect(normalisePhone("+351 912 345 678")).toBe("351912345678");
    expect(normalisePhone("12-34")).toBeNull();
    expect(maskEmail("ana.silva@example.pt")).toBe("a•••@e•••.pt");
  });
});

describe("customers the business already knows (§8.2)", () => {
  it("decides the match in the create: none, weak by email or phone, strong by an API key's party or authenticated mail", async () => {
    const { db, caps, book } = await setup();
    const first = await book(customer(), { name: "Ana Silva", email: "Ana@Example.pt", phone: "+351 912 345 678" });
    expect(await col(db, first.view.item.id)).toMatchObject({ customerMatch: "none", possiblePartyId: null });
    const contacts = await db.client.query({
      sql: "SELECT kind, value, verified_at FROM party_contacts WHERE party_id = ? ORDER BY kind",
      params: [first.view.item.partyId],
      method: "all",
    });
    expect(contacts.rows).toEqual([
      ["email", "ana@example.pt", null],
      ["phone", "351912345678", null],
    ]);

    // The same address, nothing that proves it: a party of its own, naming the one it may be.
    const byEmail = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    expect(byEmail.view.item.partyId).not.toBe(first.view.item.partyId);
    expect(await col(db, byEmail.view.item.id)).toMatchObject({
      customerMatch: "weak",
      possiblePartyId: first.view.item.partyId,
    });
    expect(byEmail.identity).toMatchObject({ recognised: "weak", verify: { available: true, sent_to: null } });
    const byPhone = await book(customer(T0 + 2 * MIN), { phone: "00351 912345678" });
    expect(await col(db, byPhone.view.item.id)).toMatchObject({ customerMatch: "none" });
    const samePhone = await book(customer(T0 + 3 * MIN), { phone: "+351912345678" });
    expect(await col(db, samePhone.view.item.id)).toMatchObject({
      customerMatch: "weak",
      possiblePartyId: first.view.item.partyId,
    });

    // A weak match never sees the known party's items.
    await expect(
      caps.getItemStatus(customer(T0 + 4 * MIN), { item_id: first.view.item.id, access_token: byEmail.accessToken }),
    ).rejects.toMatchObject({ code: "not_allowed" });

    // The owner sees who it may be.
    const detail = await caps.getItem(owner(T0 + 5 * MIN), { item_id: byEmail.view.item.id });
    expect(detail.customer).toMatchObject({
      match: "weak",
      possible: { party_id: first.view.item.partyId, name: "Ana Silva" },
      known: false,
    });

    // An agent key that names the party joins it, as it always did.
    const keyed = await book(
      {
        ...customer(T0 + 6 * MIN),
        actor: { kind: "customer_agent", id: "key_1", channel: "rest", partyId: first.view.item.partyId },
        tier: "verified_principal",
      },
      { email: "ana@example.pt" },
    );
    expect(keyed.view.item.partyId).toBe(first.view.item.partyId);
    expect(await col(db, keyed.view.item.id)).toMatchObject({ customerMatch: "strong" });

    // Authenticated mail from the known address joins the known party and verifies the address.
    const mail = await caps.sendMessage(
      {
        actor: { kind: "customer_human", id: "email:ana@example.pt", channel: "email" },
        tier: "verified_principal",
        sandbox: false,
        now: () => T0 + 7 * MIN,
      },
      { body: "Can I move my massage?", contact: { email: "ana@example.pt" } },
    );
    const mailItem = (mail as { view: { item: { id: string; partyId: string } } }).view.item;
    expect(mailItem.partyId).toBe(first.view.item.partyId);
    expect(await col(db, mailItem.id)).toMatchObject({ customerMatch: "strong" });
    const verified = await db.client.query({
      sql: "SELECT verified_at FROM party_contacts WHERE party_id = ? AND kind = 'email'",
      params: [first.view.item.partyId],
      method: "all",
    });
    expect(verified.rows).toEqual([[T0 + 7 * MIN]]);
    const again = await caps.getItem(owner(T0 + 8 * MIN), { item_id: first.view.item.id });
    expect(again.party?.verified).toBe(true);
  });

  it("proves a weak match with a code sent to the known address, and merges on the right one", async () => {
    const { db, caps, mail, book } = await setup();
    const known = await book(customer(), { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await book(customer(T0 + MIN), { email: "ana@example.pt", name: "Ana" });
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };

    await expect(
      caps.verifyCustomer(customer(T0 + 2 * MIN), { item_id: known.view.item.id, access_token: known.accessToken }),
    ).rejects.toMatchObject({
      code: "nothing_to_verify",
      status: 409,
    });
    const sent = await caps.verifyCustomer(customer(T0 + 2 * MIN), target);
    expect(sent).toEqual({ sent_to: "a•••@e•••.pt" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toEqual(["ana@example.pt"]);
    const code = /\b(\d{6})\b/.exec(mail.sent[0]?.text ?? "")?.[1] as string;
    const status = await caps.getItemStatus(customer(T0 + 2 * MIN), target);
    expect(status.identity.verify).toEqual({ available: true, sent_to: "a•••@e•••.pt" });

    const wrong = code === "000000" ? "111111" : "000000";
    await expect(caps.verifyCustomer(customer(T0 + 3 * MIN), { ...target, code: wrong })).rejects.toMatchObject({
      code: "bad_code",
      status: 422,
    });
    // After ten minutes the code has expired.
    await expect(caps.verifyCustomer(customer(T0 + 13 * MIN), { ...target, code })).rejects.toMatchObject({
      code: "code_expired",
    });
    // A new one; five wrong tries, and even the right code stops working.
    await caps.verifyCustomer(customer(T0 + 14 * MIN), target);
    const second = /\b(\d{6})\b/.exec(mail.sent[1]?.text ?? "")?.[1] as string;
    const wrong2 = second === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(caps.verifyCustomer(customer(T0 + 15 * MIN), { ...target, code: wrong2 })).rejects.toMatchObject({
        code: "bad_code",
      });
    }
    await expect(caps.verifyCustomer(customer(T0 + 15 * MIN), { ...target, code: second })).rejects.toMatchObject({
      code: "too_many_attempts",
      status: 429,
    });
    // Three codes an hour to one address, then no more.
    await caps.verifyCustomer(customer(T0 + 16 * MIN), target);
    await expect(caps.verifyCustomer(customer(T0 + 17 * MIN), target)).rejects.toMatchObject({
      code: "too_many_attempts",
    });
    const third = /\b(\d{6})\b/.exec(mail.sent[2]?.text ?? "")?.[1] as string;
    expect(await caps.verifyCustomer(customer(T0 + 18 * MIN), { ...target, code: third })).toEqual({
      recognised: "strong",
    });

    // One party now: the weak item moved, its party points at the known one, the address is verified.
    expect(await col(db, weak.view.item.id)).toMatchObject({
      partyId: known.view.item.partyId,
      customerMatch: "strong",
      possiblePartyId: null,
    });
    const [merged] = await db.orm.select().from(parties).where(eq(parties.id, weak.view.item.partyId));
    expect(merged?.mergedInto).toBe(known.view.item.partyId);
    const contacts = await db.client.query({
      sql: "SELECT COUNT(*) FROM party_contacts WHERE value = 'ana@example.pt' AND verified_at IS NULL",
      params: [],
      method: "all",
    });
    expect(contacts.rows).toEqual([[0]]);
    await expect(caps.verifyCustomer(customer(T0 + 19 * MIN), target)).rejects.toMatchObject({
      code: "already_verified",
    });
    // The customer may be recognised now; the item still answers to its token.
    const after = await caps.getItemStatus(customer(T0 + 20 * MIN), target);
    expect(after.identity.recognised).toBe("strong");
    // A later customer with the address is weak again, naming the (only) known party.
    const later = await book(customer(T0 + 21 * MIN), { email: "ana@example.pt" });
    expect(await col(db, later.view.item.id)).toMatchObject({
      customerMatch: "weak",
      possiblePartyId: known.view.item.partyId,
    });
  });

  it("counts the business's own history over every party that is the customer", async () => {
    const { db, caps, book } = await setup();
    const a = await book(customer(), { email: "ana@example.pt" });
    const b = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    for (const [id, end] of [
      [a.view.item.id, "complete"],
      [b.view.item.id, "no_show"],
    ] as const) {
      await caps.transitionItem(owner(T0 + 2 * MIN), { item_id: id, event: "confirm" });
      await caps.transitionItem(owner(T0 + 3 * MIN), { item_id: id, event: end });
    }
    const order = await caps.createOrder(customer(T0 + 4 * MIN), {
      payload: {
        orderedItem: [{ name: "Oil", quantity: 1, price: { value: 4200, currency: "EUR" } }],
        totalPrice: { value: 4200, currency: "EUR" },
      },
      contact: { email: "ana@example.pt" },
    });
    await caps.transitionItem(owner(T0 + 5 * MIN), { item_id: order.view.item.id, event: "accept" });
    await caps.transitionItem(owner(T0 + 6 * MIN), {
      item_id: order.view.item.id,
      event: "record_payment",
      input: { paymentRef: "p1", amount: { value: 4200, currency: "EUR" } },
    });
    // Before any proof, each party is only itself.
    expect(await customerHistory(db, a.view.item.partyId)).toMatchObject({ items: 1, completed: 1, no_shows: 0 });
    // Authenticated mail verifies the address: every party holding it verified is the same customer.
    await db.client.query({
      sql: "UPDATE party_contacts SET verified_at = ? WHERE value = 'ana@example.pt'",
      params: [T0],
      method: "run",
    });
    expect(await customerHistory(db, a.view.item.partyId)).toMatchObject({
      items: 3,
      completed: 1,
      no_shows: 1,
      paid: 1,
      largest_paid: 4200,
      first_seen: T0,
    });
  });

  it("shows the owner each network's standing: with this request, else as last presented for the customer", async () => {
    const { db, caps, book } = await setup();
    const first = await book(customer(), { email: "ana@example.pt", name: "Ana Silva" });
    const next = await book(customer(T0 + MIN), { email: "bruno@example.pt" });
    const person = (tier: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        tier,
        score: 0.8,
        kept: 9,
        broken: 1,
        businesses: 4,
        email_proven: true,
        since: "2026-03-14T09:00:00Z",
        unusual_use: false,
        rules: 3,
        ...extra,
      });
    await db.client.batch([
      // A network presented Ana on this item...
      {
        sql: "INSERT INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [first.view.item.id, "https://a.example.org", "p".repeat(22), "q".repeat(22), person("trusted"), T0],
        method: "run",
      },
      // ...and another knows her from an earlier item; a third said something that does not parse.
      {
        sql: "INSERT INTO person_links (party_id, network, ppid, pass_hash, person, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        params: [
          first.view.item.partyId,
          "https://b.example.org",
          "r".repeat(22),
          person("building", { unusual_use: true }),
          T0 - DAY,
          T0 - DAY,
        ],
        method: "run",
      },
      {
        sql: "INSERT INTO person_links (party_id, network, ppid, pass_hash, person, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        params: [
          first.view.item.partyId,
          "https://c.example.org",
          "s".repeat(22),
          '{"tier":"legend","score":9,"kept":-1}',
          T0,
          T0,
        ],
        method: "run",
      },
      // The link of a network that presented her on this item does not repeat it.
      {
        sql: "INSERT INTO person_links (party_id, network, ppid, pass_hash, person, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        params: [first.view.item.partyId, "https://a.example.org", "q".repeat(22), person("new"), T0 - DAY, T0 - DAY],
        method: "run",
      },
    ]);
    const view = await caps.people.customerView({ id: first.view.item.id, partyId: first.view.item.partyId });
    expect(view.persons).toEqual([
      {
        network: "https://a.example.org",
        tier: "trusted",
        score: 0.8,
        kept: 9,
        broken: 1,
        businesses: 4,
        email_proven: true,
        since: "2026-03-14T09:00:00Z",
        unusual_use: false,
        seen: "this_item",
        as_of: new Date(T0).toISOString(),
      },
      expect.objectContaining({
        network: "https://b.example.org",
        tier: "building",
        unusual_use: true,
        seen: "earlier",
      }),
      expect.objectContaining({ network: "https://c.example.org", tier: "new", score: 0, kept: 0, since: null }),
    ]);
    expect(customerSummary(view)).toBe(
      "trusted on a.example.org (9 kept, 1 broken, known since 2026-03). building on b.example.org (9 kept, 1 broken, known since 2026-03, as of 2026-09-20). new on c.example.org (no record yet, as of 2026-09-21).",
    );
    // Someone the networks never presented: nothing to say.
    const stranger = await caps.people.customerView({ id: next.view.item.id, partyId: next.view.item.partyId });
    expect(stranger.persons).toEqual([]);
    expect(customerSummary(stranger)).toBe("");
    // The owner's item carries the same view.
    expect((await caps.getItem(owner(), { item_id: first.view.item.id })).customer?.persons).toHaveLength(3);
  });

  it("fills party_contacts from existing parties, resumably", async () => {
    const { db } = await setup();
    const ids = Array.from({ length: 5 }, () => ulid()).sort();
    await db.orm.insert(parties).values(
      ids.map((id, i) => ({
        id,
        kind: "human",
        contact: i === 4 ? {} : { email: `P${i}@Example.PT`, phone: i === 0 ? "+44 20 7946 0000" : "12" },
        createdAt: T0 + i,
        updatedAt: T0 + i,
      })),
    );
    const first = await backfillPartyContacts(db, "", T0, 3);
    expect(first).toEqual({ done: 3, last: ids[2] });
    const second = await backfillPartyContacts(db, first.last as string, T0, 3);
    expect(second).toEqual({ done: 2, last: ids[4] });
    const rows = await db.client.query({
      sql: "SELECT kind, value FROM party_contacts ORDER BY value",
      params: [],
      method: "all",
    });
    expect(rows.rows).toEqual([
      ["phone", "442079460000"],
      ["email", "p0@example.pt"],
      ["email", "p1@example.pt"],
      ["email", "p2@example.pt"],
      ["email", "p3@example.pt"],
    ]);
    // Again from the start: nothing twice.
    await backfillPartyContacts(db, "", T0, 10);
    const count = await db.client.query({ sql: "SELECT COUNT(*) FROM party_contacts", params: [], method: "all" });
    expect(count.rows).toEqual([[5]]);
  });
});

describe("rules that read a standing (§8.3)", () => {
  const ctx = (over: Partial<RuleContext>): RuleContext => ({
    item: { type: "order", payload: { totalPrice: { value: 9_000, currency: "EUR" } }, flags: {} },
    event: { event: "create", from: null, to: "received", actorKind: "customer_agent", depth: 0 },
    party: { kind: "agent", tier: "anonymous" },
    person: NO_PERSON,
    customer: NO_CUSTOMER,
    agent: NO_AGENT_CONTEXT,
    settings: {},
    now: T0,
    text: "",
    facts: { slotIsFree: null, withinBusinessHours: null },
    ...over,
  });
  const trusted = {
    present: true,
    tier: "trusted" as const,
    score: 0.8,
    networks: [{ network: "https://network.example.com", tier: "trusted" as const, score: 0.8, kept: 6, broken: 0 }],
    limit_minor: 40_000,
  };

  it("evaluates the new facts from local rows only", () => {
    expect(evaluate({ fn: "person_trusted" }, ctx({ person: trusted }))).toBe(true);
    expect(evaluate({ fn: "person_trusted" }, ctx({}))).toBe(false);
    expect(
      evaluate(
        { fn: "person_tier_on", args: { network: "network.example.com", min: "building" } },
        ctx({ person: trusted }),
      ),
    ).toBe(true);
    expect(
      evaluate({ fn: "person_tier_on", args: { network: "https://other.example.com" } }, ctx({ person: trusted })),
    ).toBe(false);
    const known = {
      ...NO_CUSTOMER,
      match: "strong" as const,
      known: true,
      completed: 2,
      largest_paid: 5_000,
      limit_minor: 10_000,
    };
    expect(evaluate({ fn: "customer_known" }, ctx({ customer: known }))).toBe(true);
    expect(evaluate({ fn: "customer_known" }, ctx({ customer: { ...known, match: "weak" } }))).toBe(false);
    expect(evaluate({ fn: "within_customer_limit" }, ctx({ customer: known }))).toBe(true);
    expect(evaluate({ fn: "within_customer_limit" }, ctx({}))).toBe(false);
    expect(evaluate({ fn: "within_customer_limit" }, ctx({ person: trusted }))).toBe(true);
    // A platform-vouched agent counts as verified; one with its own key does not.
    expect(
      evaluate(
        { fn: "party_verified" },
        ctx({
          party: { kind: "agent", tier: "signed_agent" },
          agent: { level: "vouched", platform: "https://p.example" },
        }),
      ),
    ).toBe(true);
    expect(
      evaluate(
        { fn: "party_verified" },
        ctx({ party: { kind: "agent", tier: "signed_agent" }, agent: { level: "self", platform: null } }),
      ),
    ).toBe(false);
  });

  it("counts a platform's agent as verified only when the door found its platform recognised (R18)", async () => {
    const { caps, book } = await setup();
    const signed = (level: "vouched" | "self") =>
      customer(T0, { agent: { level, thumbprint: "t".repeat(43), platform: "https://agents.example.net" } });
    // The door makes a platform no enabled network recognises `self`; the rules see it as that.
    const unrecognised = await book(signed("self"), { email: "a@example.pt" });
    const recognised = await book(signed("vouched"), { email: "b@example.pt" });
    const test = (itemId: string) =>
      caps.setup.testRule(owner(), {
        definition: {
          on: ["item.created"],
          if: { fn: "party_verified" },
          actions: [{ action: "transition", event: "confirm" }],
          stop: false,
          maxRunsPerItem: 1,
        },
        item_id: itemId,
      });
    expect(await test(unrecognised.view.item.id)).toMatchObject({
      matched: false,
      who: { agent: { level: "self", platform: null }, tier: "signed_agent" },
    });
    expect(await test(recognised.view.item.id)).toMatchObject({
      matched: true,
      who: { agent: { level: "vouched", platform: "https://agents.example.net" }, tier: "signed_agent" },
    });
  });

  it("refuses to save a rule that reads a standing and refuses, cancels, expires or queues", async () => {
    const { caps } = await setup();
    const def = (actions: RuleDefinition["actions"], cond: RuleDefinition["if"] = { fn: "person_trusted" }) => ({
      name: "r",
      priority: 10,
      enabled: true,
      definition: { on: ["item.created"], if: cond, actions, stop: false, maxRunsPerItem: 1 } as RuleDefinition,
    });
    for (const event of ["decline", "cancel", "cancel_by_business", "expire", "no_show"]) {
      await expect(caps.setup.createRule(owner(), def([{ action: "transition", event }]))).rejects.toMatchObject({
        code: "positive_only",
        status: 422,
      });
    }
    await expect(
      caps.setup.createRule(
        owner(),
        def([{ action: "enqueue", job: "x" }], { path: "customer.no_shows", op: "gt", value: 1 }),
      ),
    ).rejects.toMatchObject({ code: "positive_only" });
    await expect(
      caps.setup.createRule(
        owner(),
        def([{ action: "transition", event: "decline" }], { path: "party.tier", op: "eq", value: "anonymous" }),
      ),
    ).rejects.toMatchObject({ code: "positive_only" });
    // Speeding up, asking a person, replying: fine. And refusing on anything else: fine, as before.
    await caps.setup.createRule(
      owner(),
      def([
        { action: "transition", event: "confirm" },
        { action: "set_flags", needsHuman: true },
      ]),
    );
    await caps.setup.createRule(
      owner(),
      def([{ action: "transition", event: "decline" }], { path: "item.type", op: "eq", value: "booking" }),
    );
    // Every preset passes.
    for (const preset of Object.values(PRESETS))
      for (const r of preset) expect(positiveOnlyProblem(r.definition)).toBeNull();
  });

  it("skips an older rule's refusal, and a refusal chained through flags a reputation rule set", async () => {
    const { db, caps, book, drain } = await setup();
    await db.orm.insert(rules).values([
      {
        id: ulid(),
        name: "Old: decline strangers",
        priority: 50,
        enabled: 1,
        definition: {
          on: ["item.created"],
          if: { path: "customer.match", op: "eq", value: "none" },
          actions: [
            { action: "set_flags", priority: 3 },
            { action: "transition", event: "decline" },
          ],
          stop: false,
          maxRunsPerItem: 1,
        },
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: ulid(),
        name: "Decline priority 3",
        priority: 40,
        enabled: 1,
        definition: {
          on: ["item.created"],
          if: { path: "item.flags.priority", op: "eq", value: 3 },
          actions: [{ action: "transition", event: "decline" }],
          stop: false,
          maxRunsPerItem: 1,
        },
        createdAt: T0,
        updatedAt: T0,
      },
    ]);
    const r = await book(customer(), { email: "new@example.pt" });
    await drain();
    const row = await col(db, r.view.item.id);
    expect(row).toMatchObject({ state: "requested" });
    expect(row?.flags).toMatchObject({ priority: 3 });
    const notes = (await db.orm.select({ kind: jobs.kind, note: jobs.lastError }).from(jobs)).filter(
      (j) => j.kind === "rules",
    );
    expect(notes[0]?.note).toContain("Old: decline strangers: positive_only: skipped decline");
    expect(notes[0]?.note).toContain("Decline priority 3: positive_only: skipped decline");
    // The item's own history says so, in plain words, where the owner reads the item: its timeline.
    const detail = await caps.getItem(owner(), { item_id: r.view.item.id });
    expect(detail.events.filter((e) => e.event === "rule_skipped").map((e) => [e.reason, e.by.kind, e.to])).toEqual([
      [
        "Rule 'Old: decline strangers' wanted to decline this, but rules that read a customer's record can only help them",
        "rule",
        "requested",
      ],
      [
        "Rule 'Decline priority 3' wanted to decline this, but it follows from a rule that read the customer's record, and those can only help them",
        "rule",
        "requested",
      ],
    ]);
    // A note to the owner, not something that happened: the developer stream leaves it out.
    const stream = await db.client.query({
      sql: "SELECT event FROM events_v1 WHERE item_id = ?",
      params: [r.view.item.id],
      method: "all",
    });
    expect(stream.rows.map((x) => String(x[0]))).not.toContain("rule_skipped");
    expect(stream.rows.map((x) => String(x[0]))).toContain("flags");
    // "Test this rule" shows what a rule would read, and what a run would hold back, in the same words.
    const test = await caps.setup.testRule(owner(), {
      definition: {
        on: ["item.created"],
        if: { path: "customer.match", op: "eq", value: "none" },
        actions: [
          { action: "set_flags", needsHuman: true },
          { action: "transition", event: "decline" },
        ],
        stop: false,
        maxRunsPerItem: 1,
      },
      item_id: r.view.item.id,
      name: "Decline strangers",
    });
    expect(test).toMatchObject({
      matched: true,
      who: {
        customer: { match: "none", known: false },
        person: { present: false, tier: "new" },
        agent: { level: "none" },
      },
      skipped: [
        "Rule 'Decline strangers' wanted to decline this, but rules that read a customer's record can only help them",
      ],
    });
    expect(test.would).toHaveLength(1);
    expect(test.would.join(" ")).not.toMatch(/decline/i);
    expect(test.positive_only).toMatch(/never decline/);
    // A rule that reads flags a reputation rule set is held back on this item too, and says why.
    const chained = await caps.setup.testRule(owner(), {
      definition: {
        on: ["item.created"],
        if: { path: "item.flags.priority", op: "eq", value: 3 },
        actions: [{ action: "transition", event: "decline" }],
        stop: false,
        maxRunsPerItem: 1,
      },
      item_id: r.view.item.id,
    });
    expect(chained.skipped).toEqual([
      "This rule wanted to decline this, but it follows from a rule that read the customer's record, and those can only help them",
    ]);
    expect(chained.would).toEqual([]);
  });

  it("tests a rule against the item's last real event, not a note that a rule was held back", async () => {
    const { db, caps, book, drain } = await setup();
    await db.orm.insert(rules).values({
      id: ulid(),
      name: "Old: decline strangers",
      priority: 50,
      enabled: 1,
      definition: {
        on: ["item.created"],
        if: { path: "customer.match", op: "eq", value: "none" },
        actions: [{ action: "transition", event: "decline" }],
        stop: false,
        maxRunsPerItem: 1,
      },
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await book(customer(), { email: "new@example.pt" });
    await drain();
    const detail = await caps.getItem(owner(), { item_id: r.view.item.id });
    expect(detail.events.map((e) => e.event)).toEqual(["create", "rule_skipped"]);
    // A rule that reads nothing about the customer, tested on the item: it runs on the creation,
    // which no reputation rule caused, so nothing it does is held back.
    const plain = await caps.setup.testRule(owner(), {
      definition: {
        on: ["item.created"],
        if: { path: "item.type", op: "eq", value: "booking" },
        actions: [{ action: "transition", event: "decline" }],
        stop: false,
        maxRunsPerItem: 1,
      },
      item_id: r.view.item.id,
    });
    expect(plain).toMatchObject({ matched: true });
    expect(plain.skipped).toBeUndefined();
    expect(plain.would).toHaveLength(1);
  });

  it("notes a held-back action once per rule and reason, however often the rule runs", async () => {
    const { db, caps, book, drain } = await setup();
    await db.orm.insert(rules).values({
      id: ulid(),
      name: "Old: decline strangers, always",
      priority: 50,
      enabled: 1,
      definition: {
        on: ["item.created", "item.transitioned"],
        if: { path: "customer.match", op: "eq", value: "none" },
        actions: [{ action: "transition", event: "decline" }],
        stop: false,
        maxRunsPerItem: 5,
      },
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await book(customer(), { email: "new@example.pt" });
    await drain();
    await caps.transitionItem(owner(T0 + MIN), { item_id: r.view.item.id, event: "confirm" });
    await drain(T0 + MIN);
    const notes = (await db.orm.select({ kind: jobs.kind, note: jobs.lastError }).from(jobs)).filter(
      (j) => j.kind === "rules" && j.note?.includes("positive_only: skipped decline"),
    );
    expect(notes).toHaveLength(2);
    const detail = await caps.getItem(owner(T0 + MIN), { item_id: r.view.item.id });
    expect(detail.item.state).toBe("confirmed");
    expect(detail.events.map((e) => e.event)).toEqual(["create", "rule_skipped", "confirm"]);
  });

  it("appointments: a customer you know is confirmed at once; a stranger over the small limit waits for a person", async () => {
    const { db, caps, book, drain, priced } = await setup("appointments");
    // Two completed visits and no no-show, all as one customer (a verified address).
    for (let i = 0; i < 2; i++) {
      const v = await book(customer(T0 + i * MIN), { email: "rui@example.pt" }, await priced(9_000));
      await drain(T0 + i * MIN);
      await caps
        .transitionItem(owner(T0 + i * MIN + 1_000), { item_id: v.view.item.id, event: "confirm" })
        .catch(() => undefined);
      await caps.transitionItem(owner(T0 + i * MIN + 2_000), { item_id: v.view.item.id, event: "complete" });
    }
    await db.client.query({
      sql: "UPDATE party_contacts SET verified_at = ? WHERE value = 'rui@example.pt'",
      params: [T0],
      method: "run",
    });
    // The next one arrives by authenticated mail's party: an API key naming the party makes it strong.
    const [p] = (
      await db.client.query({
        sql: "SELECT party_id FROM party_contacts WHERE value = 'rui@example.pt' ORDER BY created_at LIMIT 1",
        params: [],
        method: "all",
      })
    ).rows;
    const known = await book(
      {
        ...customer(T0 + 10 * MIN),
        actor: { kind: "customer_agent", id: "key_rui", channel: "rest", partyId: String(p?.[0]) },
        tier: "verified_principal",
      },
      { email: "rui@example.pt" },
      await priced(12_000),
    );
    const stranger = await book(customer(T0 + 11 * MIN), { email: "someone@example.pt" }, await priced(12_000));
    await drain(T0 + 12 * MIN);
    expect((await col(db, known.view.item.id))?.state).toBe("confirmed");
    const s = await col(db, stranger.view.item.id);
    expect(s?.state).toBe("requested");
    expect(s?.flags).toMatchObject({ needsHuman: true });
  });

  it("appointments: a trusted person with few open bookings is confirmed at once, up to 20000", async () => {
    const { db, book, drain, priced } = await setup("appointments");
    const present = async (itemId: string) =>
      db.client.query({
        sql: "INSERT INTO item_presentations (item_id, network, presentation_id, ppid, person, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [
          itemId,
          "https://network.surfingdog.ai",
          "p".repeat(22),
          "q".repeat(22),
          JSON.stringify({ tier: "trusted", score: 0.8 }),
          T0,
        ],
        method: "run",
      });
    await db.client.query({
      sql: `UPDATE settings SET doc = json_set(doc, '$.networks', json('{"https://network.surfingdog.ai":{"enabled":true}}'))`,
      params: [],
      method: "run",
    });
    await db.client.query({
      sql: `INSERT INTO settings (id, schema_version, doc, version, updated_at)
            SELECT 'singleton', 1, '{"networks":{"https://network.surfingdog.ai":{"enabled":true}}}', 1, ? WHERE NOT EXISTS (SELECT 1 FROM settings)`,
      params: [T0],
      method: "run",
    });
    const small = await book(customer(), { email: "t@example.pt" }, await priced(15_000));
    const big = await book(customer(), { email: "u@example.pt" }, await priced(25_000));
    await present(small.view.item.id);
    await present(big.view.item.id);
    await drain();
    expect((await col(db, small.view.item.id))?.state).toBe("confirmed");
    expect((await col(db, big.view.item.id))?.state).toBe("requested");
  });

  it("shop: accepts a known customer's order within twice their largest paid, asks a new one to pay", async () => {
    const { db, caps, drain, product } = await setup("shop");
    const line = async (value: number) => ({
      orderedItem: [{ productId: await product(value), name: "Chain", quantity: 1, price: { value, currency: "EUR" } }],
      totalPrice: { value, currency: "EUR" },
    });
    const first = await caps.createOrder(customer(), {
      payload: await line(5_000),
      contact: { email: "rita@example.pt" },
    });
    await drain();
    expect((await col(db, first.view.item.id))?.state).toBe("awaiting_payment");
    await caps.transitionItem(owner(T0 + MIN), {
      item_id: first.view.item.id,
      event: "record_payment",
      input: { paymentRef: "p1" },
    });
    const party = first.view.item.partyId;
    const keyed = (t: number): Caller => ({
      ...customer(t),
      actor: { kind: "customer_agent", id: "key_rita", channel: "rest", partyId: party },
      tier: "verified_principal",
    });
    const within = await caps.createOrder(keyed(T0 + 2 * MIN), {
      payload: await line(9_000),
      contact: { email: "rita@example.pt" },
    });
    const over = await caps.createOrder(keyed(T0 + 3 * MIN), {
      payload: await line(25_000),
      contact: { email: "rita@example.pt" },
    });
    await drain(T0 + 4 * MIN);
    expect((await col(db, within.view.item.id))?.state).toBe("accepted");
    const o = await col(db, over.view.item.id);
    expect(o?.state).toBe("received");
    expect(o?.flags).toMatchObject({ needsHuman: true, priority: 2 });
  });

  it("offers a code to a possible known customer asking about earlier bookings, and refuses nobody", async () => {
    const { db, caps, book, drain } = await setup("appointments");
    await book(customer(), { email: "ana@example.pt" });
    const ask = await caps.sendMessage(customer(T0 + MIN), {
      body: "Hi, I need to cancel my booking tomorrow",
      contact: { email: "ana@example.pt" },
    });
    await drain(T0 + 2 * MIN);
    const id = (ask as { view: { item: { id: string } } }).view.item.id;
    const row = await col(db, id);
    expect(row).toMatchObject({ customerMatch: "weak", state: "open" });
    expect(row?.flags).toMatchObject({ needsHuman: true });
    const thread = await db.client.query({
      sql: "SELECT direction, body_text FROM thread_entries WHERE item_id = ? ORDER BY created_at",
      params: [id],
      method: "all",
    });
    expect(thread.rows.at(-1)?.[0]).toBe("out");
    // The reply is emailed to the customer: the business asks for the code, and names no tool.
    expect(String(thread.rows.at(-1)?.[1])).toContain("one-time code we email");
    expect(String(thread.rows.at(-1)?.[1])).not.toMatch(/verify_customer|\(|network|pass\b|key\b/);
  });
});

describe("codes and positive only under attack (security review)", () => {
  it("sends at most sendsPerHour codes to an address, however many ask at once", async () => {
    const { caps, mail, book } = await setup();
    await book(customer(), { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };
    const asks = await Promise.allSettled(
      Array.from({ length: 10 }, () => caps.verifyCustomer(customer(T0 + 2 * MIN), target)),
    );
    expect(asks.filter((a) => a.status === "fulfilled")).toHaveLength(3);
    expect(mail.sent).toHaveLength(3);
  });

  it("counts every guess sent together, so a burst gets no more tries than one at a time", async () => {
    const { caps, mail, book } = await setup();
    await book(customer(), { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };
    await caps.verifyCustomer(customer(T0 + 2 * MIN), target);
    const code = /\b(\d{6})\b/.exec(mail.sent[0]?.text ?? "")?.[1] as string;
    const wrong = code === "000000" ? "111111" : "000000";
    const guesses = await Promise.allSettled(
      Array.from({ length: 40 }, () => caps.verifyCustomer(customer(T0 + 3 * MIN), { ...target, code: wrong })),
    );
    const codes = guesses.map((g) => (g.status === "rejected" ? (g.reason as WriteError).code : "fulfilled"));
    expect(codes.filter((c) => c === "bad_code")).toHaveLength(5);
    expect(codes.filter((c) => c === "too_many_attempts")).toHaveLength(35);
    // Out of tries: even the right code is refused now.
    await expect(caps.verifyCustomer(customer(T0 + 4 * MIN), { ...target, code })).rejects.toMatchObject({
      code: "too_many_attempts",
    });
  });

  it("sends at most sendsPerDay codes to an address in a day, whatever the hour", async () => {
    const { caps, mail, book } = await setup();
    await book(customer(), { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };
    const HOUR = 60 * MIN;
    // Three in the first hour, two in the second: five, the day's default.
    for (const t of [2, 3, 4].map((m) => T0 + m * MIN)) await caps.verifyCustomer(customer(t), target);
    for (const t of [70, 71].map((m) => T0 + m * MIN)) await caps.verifyCustomer(customer(t), target);
    expect(mail.sent).toHaveLength(5);
    // The hour has room again; the day does not, and says so in the business's words.
    const refused = caps.verifyCustomer(customer(T0 + 3 * HOUR), target);
    await expect(refused).rejects.toMatchObject({ code: "too_many_attempts", status: 429 });
    await expect(caps.verifyCustomer(customer(T0 + 3 * HOUR), target)).rejects.toThrow(
      "We have sent 5 codes to this address today; please try again tomorrow.",
    );
    // A burst at the day's edge gets nothing either.
    const burst = await Promise.allSettled(
      Array.from({ length: 5 }, () => caps.verifyCustomer(customer(T0 + 20 * HOUR), target)),
    );
    expect(burst.filter((a) => a.status === "fulfilled")).toHaveLength(0);
    // A day after the first, room for one again.
    expect(await caps.verifyCustomer(customer(T0 + 2 * MIN + DAY + 1), target)).toEqual({ sent_to: "a•••@e•••.pt" });
    expect(mail.sent).toHaveLength(6);
  });

  it("allows guessesPerDay tries at an address's codes in a day, new codes or not, counted atomically", async () => {
    const { db, caps, mail, book } = await setup();
    // Merged into the stored settings: the other limits keep their values.
    await caps.updateSettings(owner(), { doc: { customers: { otp: { sendsPerDay: 9 } } } });
    await caps.updateSettings(owner(), { doc: { customers: { otp: { guessesPerDay: 7 } } } });
    expect((await readSettings(db)).customers).toEqual({
      otp: { ttlMinutes: 10, attempts: 5, sendsPerHour: 3, sendsPerDay: 9, guessesPerDay: 7 },
      emailKey: true,
    });
    await book(customer(), { name: "Ana Silva", email: "ana@example.pt" });
    const weak = await book(customer(T0 + MIN), { email: "ana@example.pt" });
    const target = { item_id: weak.view.item.id, access_token: weak.accessToken };
    const codeOf = (i: number) => /\b(\d{6})\b/.exec(mail.sent[i]?.text ?? "")?.[1] as string;
    const wrongFor = (c: string) => (c === "000000" ? "111111" : "000000");
    // Five wrong tries at the first code (its own limit), then a burst of ten at a second: only two
    // of the burst are counted, the day's seven reached.
    await caps.verifyCustomer(customer(T0 + 2 * MIN), target);
    for (let i = 0; i < 5; i++) {
      await expect(
        caps.verifyCustomer(customer(T0 + 3 * MIN), { ...target, code: wrongFor(codeOf(0)) }),
      ).rejects.toMatchObject({ code: "bad_code" });
    }
    await caps.verifyCustomer(customer(T0 + 4 * MIN), target);
    const burst = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        caps.verifyCustomer(customer(T0 + 5 * MIN), { ...target, code: wrongFor(codeOf(1)) }),
      ),
    );
    const codes = burst.map((g) => (g.status === "rejected" ? (g.reason as WriteError).code : "fulfilled"));
    expect(codes.filter((c) => c === "bad_code")).toHaveLength(2);
    expect(codes.filter((c) => c === "too_many_attempts")).toHaveLength(8);
    // A third code, and the right one: still refused today, and told why.
    await caps.verifyCustomer(customer(T0 + 6 * MIN), target);
    await expect(caps.verifyCustomer(customer(T0 + 7 * MIN), { ...target, code: codeOf(2) })).rejects.toThrow(
      "Too many tries at a code for this address today; please try again tomorrow.",
    );
    // A day on, a new code works.
    await caps.verifyCustomer(customer(T0 + 2 * MIN + DAY + 1), target);
    expect(await caps.verifyCustomer(customer(T0 + 3 * MIN + DAY), { ...target, code: codeOf(3) })).toEqual({
      recognised: "strong",
    });
  });

  it("refuses a reputation rule that closes a conversation, and skips a refusal chained through a state it set", async () => {
    const { db, caps, book, drain } = await setup();
    await expect(
      caps.setup.createRule(owner(), {
        name: "Close strangers' messages",
        priority: 10,
        enabled: true,
        definition: {
          on: ["item.created"],
          if: { path: "customer.match", op: "eq", value: "none" },
          actions: [{ action: "transition", event: "close" }],
          stop: false,
          maxRunsPerItem: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "positive_only" });

    // A reputation rule may confirm; a rule that cancels whatever is confirmed may not act on it.
    const confirmer = await caps.setup.createRule(owner(), {
      name: "Confirm newcomers",
      priority: 20,
      enabled: true,
      definition: {
        on: ["item.created"],
        if: { path: "customer.match", op: "eq", value: "none" },
        actions: [{ action: "transition", event: "confirm" }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    expect(confirmer.name).toBe("Confirm newcomers");
    await caps.setup.createRule(owner(), {
      name: "Cancel confirmed bookings",
      priority: 10,
      enabled: true,
      definition: {
        on: ["item.transitioned"],
        if: { path: "item.state", op: "eq", value: "confirmed" },
        actions: [{ action: "transition", event: "cancel_by_business" }],
        stop: false,
        maxRunsPerItem: 1,
      },
    });
    const r = await book(customer(), { email: "new@example.pt" });
    await drain(T0 + MIN);
    expect((await col(db, r.view.item.id))?.state).toBe("confirmed");
    const notes = (await db.orm.select({ kind: jobs.kind, note: jobs.lastError }).from(jobs))
      .filter((j) => j.kind === "rules")
      .map((j) => j.note ?? "");
    expect(notes.join("\n")).toContain(
      "Cancel confirmed bookings: positive_only: skipped cancel_by_business, because the rule reads a customer's standing (through a change a reputation rule made)",
    );

    // The same rule still cancels what the owner confirmed: only the reputation chain is cut.
    await caps.setup.updateRule(owner(), { rule_id: confirmer.id, enabled: false });
    const mine = await book(customer(T0 + 2 * MIN), { email: "other@example.pt" });
    await caps.transitionItem(owner(T0 + 3 * MIN), { item_id: mine.view.item.id, event: "confirm" });
    await drain(T0 + 4 * MIN);
    expect((await col(db, mine.view.item.id))?.state).toBe("cancelled_by_business");
  });
});
