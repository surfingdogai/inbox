import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { loadPolicies, putReturnPolicy, type ReturnPolicyInput } from "../src/catalogue/policies";
import { createDb, type Db } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ensureLifecycleSweep, LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "../src/jobs/lifecycle";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, outboundMail, products, returnPolicies, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { makeClient, openAllWeek, resetTables } from "./harness";

/**
 * A contract's law and what its customer is told of returns, settled as it is made and held to after
 * (ADR-018 Amendment 7, as the reviews of 9 November 2026 asked): an order the business prices later
 * takes the law of when it becomes a contract; what the confirm step told is fingerprinted, recorded and
 * what the owner's AI approves inside; one excepted line never speaks for the others; only the return
 * policies an owner elsewhere wrote are published; and a record this release cannot read fails toward the
 * customer. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-11-16T10:00:00Z"); // a Monday
const DAY = 86_400_000;
const BASE = "https://orders.example";
const iso = (ms: number) => new Date(ms).toISOString();
const clock = { now: T0 };
const at = (kind: Caller["actor"]["kind"], channel: Caller["actor"]["channel"]): Caller => ({
  actor: { kind, id: `${kind}_1`, channel },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
});
const owner = at("owner", "owner_ui");
const shop = at("connector", "connector");
const ai = at("owner_ai", "mcp_owner");
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});

const window = (days: number): Omit<ReturnPolicyInput, "id" | "name"> => ({
  default: true,
  eligibility: "window",
  window_days: days,
  resolutions: ["refund"],
  methods: ["by_post"],
  return_postage: "customer",
});
const NO_RETURNS: Omit<ReturnPolicyInput, "id" | "name"> = {
  default: true,
  eligibility: "not_accepted",
  resolutions: [],
  methods: [],
};
const EU_LINE = "You can withdraw within 14 days of receiving it, without giving a reason";
const EU_FORM = "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):";
const POLICY_30 = "Under our return policy, you can return it within 30 days of receiving it";

async function setup(country: string, policy?: Omit<ReturnPolicyInput, "id" | "name">) {
  clock.now = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const currency = country === "US" ? "USD" : "EUR";
  await db.orm.insert(business).values({
    id: "self",
    name: "Harbour Cycles",
    timezone: country === "US" ? "America/New_York" : "Europe/Lisbon",
    currency,
    languages: ["en"],
    createdAt: T0,
    updatedAt: T0,
  });
  const money = (value: number) => ({ value, currency });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    price: { model: "fixed", value: 4500, currency },
    createdAt: T0,
    updatedAt: T0,
  });
  await openAllWeek(db);
  const chain = ulid();
  const cake = ulid();
  await db.orm.insert(products).values([
    { id: chain, sku: "CH-9", name: "Chain", price: money(1850), active: 1, createdAt: T0, updatedAt: T0 },
    {
      id: cake,
      sku: "CK-1",
      name: "Cake",
      price: money(900),
      withdrawal: "perishable",
      active: 1,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  const caps = new Capabilities(db, createSecretBox(["withdrawal-terms-test-secret-0123456789"]), BASE);
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Harbour Cycles" },
      notifications: { ownerEmail: "hello@harbour.example", appUrl: BASE },
      email: { fromAddress: "orders@harbour.example" },
      commerce: {
        legal: {
          country,
          legalName: "Harbour Cycles Ltd",
          address: "1 Quay Street",
          email: "hello@harbour.example",
          vatId: "X123",
        },
      },
    },
  });
  if (policy) await putReturnPolicy(db, { id: "standard", name: "Our returns", ...policy }, T0);
  const runner = createRunner({
    mailOut: logMailOut(),
    receipts: caps.receipts,
    baseUrl: BASE,
    secrets: caps.secrets,
  }).register(LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler());
  const drain = async () => {
    for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  const sweep = async (t: number) => {
    clock.now = t;
    await ensureLifecycleSweep(db, t);
    await drain();
  };
  return { db, caps, svc, chain, cake, money, drain, sweep };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

const contact = { name: "Rita", email: "rita@example.com", locale: "en" };
const orderOf = (s: Setup, lines: readonly { productId: string; quantity?: number }[]) => ({
  payload: {
    orderedItem: lines.map((l) => ({
      productId: l.productId,
      name: "x",
      quantity: l.quantity ?? 1,
      price: s.money(1),
    })),
    totalPrice: s.money(1),
  },
  contact,
});

/** A priced order through the confirm step: what was told, and the order its yes made. */
async function confirmed(s: Setup, lines: readonly { productId: string; quantity?: number }[]) {
  const input = orderOf(s, lines);
  const asked = await refused(s.caps.createOrder(anon(), input));
  expect(asked.code).toBe("confirm_terms");
  const d = asked.details as { summary: string; terms_sha: string };
  const made = await s.caps.createOrder(anon(), { ...input, terms_sha: d.terms_sha });
  return { summary: d.summary, sha: d.terms_sha, id: made.view.item.id, token: made.accessToken as string };
}

const lawOn = async (db: Db, id: string) => {
  const [row] = await db.orm.select().from(items).where(eq(items.id, id));
  return (row?.payload as { law?: string } | undefined)?.law;
};
const mailOf = async (db: Db, id: string, template: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).find(
    (m) => m.recipient === "customer" && m.template === template,
  );
const moveTo = (s: Setup, country: string) =>
  s.caps.updateSettings(owner, { doc: { commerce: { legal: { country } } } });
const pay = (s: Setup, id: string, value: number) =>
  transitionItem(s.db, shop, {
    itemId: id,
    event: "record_payment",
    input: { paymentRef: `pi_${id}`, amount: s.money(value) },
  });

/** Accepted, paid and delivered the day after: the first confirmation's text. */
async function deliver(s: Setup, id: string, value: number) {
  await transitionItem(s.db, owner, { itemId: id, event: "accept" });
  await s.drain();
  const accepted = (await mailOf(s.db, id, "order.accepted"))?.bodyText ?? "";
  await pay(s, id, value);
  clock.now = T0 + DAY;
  await transitionItem(s.db, owner, { itemId: id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
  return accepted;
}

/** A change of mind `days` after delivery for `lines`, and what the owner's AI may do with it. */
async function changeOfMind(
  s: Setup,
  o: { id: string; token: string },
  days: number,
  lines?: { index: number; quantity: number }[],
) {
  clock.now = T0 + DAY + days * DAY;
  const r = await s.caps.customer.requestReturn(anon(o.token), {
    item_id: o.id,
    access_token: o.token,
    reason: "changed_mind",
    ...(lines ? { lines } : {}),
  });
  const ret = r.linked?.item;
  if (!ret) throw new Error("expected a return");
  if (ret.state !== "requested") return { kind: (ret.payload as { kind: string }).kind, ai: "agreed at once" };
  try {
    await transitionItem(s.db, ai, { itemId: ret.id, event: "approve" });
    return { kind: (ret.payload as { kind: string }).kind, ai: "approved" };
  } catch (e) {
    if (!(e instanceof WriteError)) throw e;
    return { kind: (ret.payload as { kind: string }).kind, ai: e.message };
  }
}

describe("an order the business prices later takes the law of when it becomes a contract", () => {
  /** An order for a line the business must price: no confirm step, nothing told before the business's offer. */
  async function unpriced(s: Setup) {
    const made = await s.caps.createOrder(anon(), {
      payload: {
        orderedItem: [{ name: "Custom frame", quantity: 1, price: s.money(5000) }],
        totalPrice: s.money(5000),
      },
      contact,
    });
    return { id: made.view.item.id, token: made.accessToken as string };
  }
  /** The business prices it, and the customer takes the price through the confirm step of an offer. */
  async function pricedAndTaken(s: Setup, o: { id: string; token: string }) {
    await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "propose",
      input: { orderedItem: [{ name: "Custom frame", quantity: 1, price: s.money(7000) }] },
    });
    const asked = await refused(s.caps.customer.acceptOffer(anon(o.token), { item_id: o.id, access_token: o.token }));
    expect(asked.code).toBe("confirm_terms");
    const { terms_sha } = asked.details as { terms_sha: string };
    await s.caps.customer.acceptOffer(anon(o.token), { item_id: o.id, access_token: o.token, terms_sha });
    await s.drain();
  }

  it("asked for in the United States, priced and taken once the business is in a member state: the EU's", async () => {
    const s = await setup("US", window(30));
    const o = await unpriced(s);
    expect(await lawOn(s.db, o.id)).toBe("other");
    await moveTo(s, "DE");
    await pricedAndTaken(s, o);
    expect(await lawOn(s.db, o.id)).toBe("eu");
    const accepted = await mailOf(s.db, o.id, "order.accepted");
    expect(accepted?.bodyText).toContain(EU_FORM);
    expect(accepted?.bodyText).not.toContain("Under our return policy");
    await pay(s, o.id, 7000);
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal).toMatchObject({ available: true, label: "Withdraw from contract here" });
    expect(status.next?.map((n) => n.action)).toContain("withdraw_from_contract");
  });

  it("asked for in a member state and taken once the business is in the United States: none claimed", async () => {
    const s = await setup("DE");
    const o = await unpriced(s);
    expect(await lawOn(s.db, o.id)).toBe("eu");
    await moveTo(s, "US");
    await pricedAndTaken(s, o);
    expect(await lawOn(s.db, o.id)).toBe("other");
    const accepted = await mailOf(s.db, o.id, "order.accepted");
    expect(accepted?.bodyText).not.toMatch(/withdraw|Model .*form/i);
  });

  it("taken by the business itself after the move, never told the law it was asked under", async () => {
    const s = await setup("US", window(30));
    const o = await unpriced(s);
    await moveTo(s, "DE");
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    expect(await lawOn(s.db, o.id)).toBe("eu");
  });

  it("confirmed under another country's law and taken once the business is in a member state: more, never less", async () => {
    const s = await setup("US", window(30));
    const o = await confirmed(s, [{ productId: s.chain }]);
    expect(o.summary).toContain(POLICY_30);
    await moveTo(s, "DE");
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    expect(await lawOn(s.db, o.id)).toBe("eu");
    // The other way, what the customer was told stands: a business that moved out keeps its word.
    const d = await setup("DE");
    const e = await confirmed(d, [{ productId: d.chain }]);
    await moveTo(d, "JP");
    await transitionItem(d.db, owner, { itemId: e.id, event: "accept" });
    expect(await lawOn(d.db, e.id)).toBe("eu");
  });
});

describe("the fingerprint a customer confirms holds the law and what they were told of returns", () => {
  it("is the one agreed: under another country's law and in the EU alike", async () => {
    for (const country of ["US", "DE"]) {
      const s = await setup(country, window(30));
      const o = await confirmed(s, [{ productId: s.chain }]);
      await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
      // The customer's own view of the item holds what was agreed (`agreed`).
      const status = (await s.caps.getItemStatus(anon(o.token), {
        item_id: o.id,
        access_token: o.token,
      })) as unknown as {
        agreed: { terms: Record<string, unknown>; terms_sha: string } | null;
      };
      expect(status.agreed?.terms_sha, country).toBe(o.sha);
      expect(status.agreed?.terms).toMatchObject({ law: country === "US" ? "other" : "eu" });
    }
  });

  it("shows the summary again when the law changes before the yes, even between the EU's and the UK's", async () => {
    for (const [from, to] of [
      ["DE", "GB"],
      ["PT", "ES"],
    ] as const) {
      const s = await setup(from);
      const input = orderOf(s, [{ productId: s.chain }]);
      const first = (await refused(s.caps.createOrder(anon(), input))).details as { terms_sha: string };
      await moveTo(s, to);
      const again = await refused(s.caps.createOrder(anon(), { ...input, terms_sha: first.terms_sha }));
      expect(again.code, `${from} to ${to}`).toBe("confirm_terms");
      expect(again.details).toMatchObject({ changed: true });
    }
  });

  it("shows it again when the owner's return policy changes before the yes, and holds to what was told after it", async () => {
    const s = await setup("US", window(30));
    const input = orderOf(s, [{ productId: s.chain }]);
    const first = (await refused(s.caps.createOrder(anon(), input))).details as { summary: string; terms_sha: string };
    expect(first.summary).toContain(POLICY_30);
    // No returns from now on: the yes to thirty days does not bind.
    await putReturnPolicy(s.db, { id: "standard", name: "Our returns", ...NO_RETURNS }, T0 + 1);
    const again = await refused(s.caps.createOrder(anon(), { ...input, terms_sha: first.terms_sha }));
    expect(again.details).toMatchObject({ changed: true });
    expect((again.details as { summary: string }).summary).not.toMatch(/return policy|return it/);

    // Told thirty days, then the policy becomes no returns before the business even accepts: the first
    // confirmation tells the thirty days the customer was told, and the owner's AI approves inside them.
    await putReturnPolicy(s.db, { id: "standard", name: "Our returns", ...window(30) }, T0 + 2);
    const o = await confirmed(s, [{ productId: s.chain }]);
    await putReturnPolicy(s.db, { id: "standard", name: "Our returns", ...NO_RETURNS }, T0 + 3);
    const accepted = await deliver(s, o.id, 1850);
    expect(accepted).toContain(`${POLICY_30}.`);
    expect(await changeOfMind(s, o, 5)).toEqual({ kind: "policy", ai: "approved" });
  });

  it("holds to nothing told when the owner writes a policy after the order", async () => {
    const s = await setup("JP");
    const o = await confirmed(s, [{ productId: s.chain }]);
    expect(o.summary).not.toMatch(/return policy|return it/);
    await putReturnPolicy(s.db, { id: "standard", name: "Our returns", ...window(30) }, T0 + 1);
    await deliver(s, o.id, 1850);
    const r = await changeOfMind(s, o, 2);
    expect(r.ai).toMatch(/^No return policy the customer was told of takes this back, so a person decides\./);
  });
});

describe("one excepted line never speaks for the others", () => {
  it("under another country's law: each line told its own, and the chain comes back inside the policy", async () => {
    const s = await setup("US", window(30));
    const o = await confirmed(s, [{ productId: s.chain }, { productId: s.cake }]);
    const told = `${POLICY_30} (1 × Chain). This cannot be returned: it does not keep (1 × Cake).`;
    expect(o.summary).toContain(told);
    const accepted = await deliver(s, o.id, 2750);
    expect(accepted).toContain(told);
    expect(await changeOfMind(s, o, 3, [{ index: 0, quantity: 1 }])).toEqual({ kind: "policy", ai: "approved" });
    clock.now = T0;
    const p = await confirmed(s, [{ productId: s.chain }, { productId: s.cake }]);
    await deliver(s, p.id, 2750);
    expect((await changeOfMind(s, p, 3, [{ index: 1, quantity: 1 }])).ai).toMatch(
      /^This return is outside the owner's return policy/,
    );
  });

  it("under another country's law with no default written: a line under a policy of its own is told it, the rest nothing", async () => {
    const s = await setup("US");
    const thirty = { id: "thirty", name: "Thirty days", ...window(30), default: false };
    await putReturnPolicy(s.db, thirty, T0);
    await s.db.orm.update(products).set({ returnPolicyId: "thirty" }).where(eq(products.id, s.chain));
    const mug = ulid();
    await s.db.orm
      .insert(products)
      .values({ id: mug, name: "Mug", price: s.money(1200), active: 1, createdAt: T0, updatedAt: T0 });
    const o = await confirmed(s, [{ productId: s.chain }, { productId: mug }]);
    expect(o.summary).toContain(`${POLICY_30} (1 × Chain).`);
    expect(o.summary).not.toContain("Mug)");
  });

  it("in the EU: the chain's right is told and, once delivered, it comes back as a withdrawal", async () => {
    const s = await setup("DE");
    const o = await confirmed(s, [{ productId: s.chain }, { productId: s.cake }]);
    const told = `${EU_LINE} (1 × Chain). This cannot be returned: it does not keep (1 × Cake).`;
    expect(o.summary).toContain(told);
    const accepted = await deliver(s, o.id, 2750);
    expect(accepted).toContain(told);
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal).toMatchObject({ available: false, why: "excepted", reason: told });
    expect(await changeOfMind(s, o, 3, [{ index: 0, quantity: 1 }])).toEqual({
      kind: "withdrawal",
      ai: "agreed at once",
    });
  });
});

describe("a law this release cannot read", () => {
  it("is no law recorded: every door answers, and the EU's right stands", async () => {
    const s = await setup("US", window(30));
    const o = await confirmed(s, [{ productId: s.chain }]);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await pay(s, o.id, 1850);
    for (const bad of ['"jp"', "null", "5", '"EU"']) {
      await s.db.client.query({
        sql: `UPDATE items SET payload = json_set(payload, '$.law', json('${bad}')) WHERE id = ?`,
        params: [o.id],
        method: "run",
      });
      const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
      expect(status.withdrawal, bad).toMatchObject({ available: true });
      const list = await s.caps.listItems(owner, { limit: 50, open_only: false, sandbox: false });
      expect(list.items.map((i) => i.item.id)).toContain(o.id);
    }
    clock.now = T0 + DAY;
    const sent = await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil" });
    expect(sent.view.item.state).toBe("fulfilled");
  });
});

describe("under another country's law, a return policy's period", () => {
  it("runs from when the goods went out where no delivery is recorded, never from a day guessed later", async () => {
    const s = await setup("US", window(30));
    const o = await confirmed(s, [{ productId: s.chain }]);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await pay(s, o.id, 1850);
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil" });
    // Thirty days from fulfilment end on day 31: day 30 is inside, day 36 is not.
    expect((await changeOfMind(s, o, 29)).ai).toBe("approved");
    clock.now = T0;
    const p = await confirmed(s, [{ productId: s.chain }]);
    await transitionItem(s.db, owner, { itemId: p.id, event: "accept" });
    await pay(s, p.id, 1850);
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: p.id, event: "fulfil" });
    expect((await changeOfMind(s, p, 35)).ai).toMatch(/^This return is outside the owner's return policy/);
  });
});

describe("what is published of returns", () => {
  it("elsewhere, only the policies the owner wrote: none written, none published and no profile policy", async () => {
    const s = await setup("JP");
    const published = await loadPolicies(s.db, undefined, { published: true });
    expect(published.return_policies).toEqual([]);
    expect(published.read.default_return_policy).toBeNull();
    expect((await s.caps.getBusinessProfile()).return_policy).toBeUndefined();
    // The owner's view keeps it, and says it is not published.
    const mine = await s.caps.getPolicies(owner);
    expect(mine.return_policies.map((p) => p.id)).toEqual(["standard"]);
    expect(mine.unpublished).toEqual(["standard"]);

    // A product naming it says nothing of returns, and moves once the owner writes its terms.
    await s.db.orm.update(products).set({ returnPolicyId: "standard" }).where(eq(products.id, s.chain));
    const seq = async () =>
      (
        await s.db.client.query({
          sql: "SELECT catalogue_seq FROM products WHERE id = ?",
          params: [s.chain],
          method: "all",
        })
      ).rows[0]?.[0];
    const before = await seq();
    await putReturnPolicy(s.db, { id: "standard", name: "Our returns", ...window(30) }, T0 + 1);
    expect(await seq()).not.toBe(before);
    const written = await loadPolicies(s.db, undefined, { published: true });
    expect(written.return_policies).toEqual([
      expect.objectContaining({ id: "standard", default: true, window_days: 30 }),
    ]);
    expect((await s.caps.getBusinessProfile()).return_policy).toMatchObject({ merchantReturnDays: 30 });
  });

  it("in the EU, the EEA, Gibraltar and the UK, never less than the 14 days the inbox applies", async () => {
    const s = await setup("GI");
    // Written while Gibraltar was taken for elsewhere: seven days.
    await s.db.orm.insert(returnPolicies).values({
      id: "short",
      name: "Seven days",
      isDefault: 0,
      terms: { eligibility: "window", window_days: 7, resolutions: ["refund"], methods: ["by_post"] },
      followsSettings: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await s.db.orm.update(returnPolicies).set({ isDefault: 0 }).where(eq(returnPolicies.id, "standard"));
    await s.db.orm.update(returnPolicies).set({ isDefault: 1 }).where(eq(returnPolicies.id, "short"));
    const doc = await loadPolicies(s.db, undefined, { published: true });
    expect(doc.return_policies.find((p) => p.id === "short")).toMatchObject({ window_days: 14 });
    // The owner's own view keeps what was written.
    expect((await s.caps.getPolicies(owner)).return_policies.find((p) => p.id === "short")).toMatchObject({
      window_days: 7,
    });
    expect((await s.caps.getBusinessProfile()).return_policy).toMatchObject({ merchantReturnDays: 14 });
  });

  it("elsewhere, the public doors leave out the right to withdraw, as the feed does", async () => {
    for (const country of ["JP", "DE"]) {
      const s = await setup(country);
      const products_ = await s.caps.listProducts({ limit: 50 });
      const services_ = await s.caps.listServices({ limit: 50 });
      for (const p of products_.items) {
        if (country === "JP") expect(p, country).not.toHaveProperty("withdrawal");
        else expect(p.withdrawal).toMatch(/^(standard|perishable)$/);
      }
      for (const v of services_.items) {
        if (country === "JP") expect(v).not.toHaveProperty("withdrawal");
        else expect(v.withdrawal).toBe("standard");
      }
    }
  });
});

describe("Portugal's tenth-day refund reminder", () => {
  it("follows the law the contract was made under, not the country the business moved to", async () => {
    const s = await setup("PT");
    const o = await confirmed(s, [{ productId: s.chain }]);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await pay(s, o.id, 1850);
    clock.now = T0 + DAY;
    await s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token, confirm_withdrawal: true });
    const [refund] = await s.db.orm.select().from(items).where(eq(items.linkedItemId, o.id));
    expect(refund && rowToItem(refund).payload).toMatchObject({ kind: "withdrawal" });
    await moveTo(s, "ES");
    await s.sweep(T0 + DAY + 10 * DAY + 3_600_000);
    const alerts = (
      await s.db.orm
        .select()
        .from(outboundMail)
        .where(eq(outboundMail.itemId, refund?.id as string))
    ).filter((m) => m.template === "owner.refund_due");
    expect(alerts).toHaveLength(1);
  });
});
