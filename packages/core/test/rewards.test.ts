import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { renderCustomerMail } from "../src/customer/mail";
import { createDb } from "../src/db";
import type { Item } from "../src/domain/types";
import { ulid } from "../src/ids";
import {
  NO_STANDING,
  rewardConditionProblem,
  rewardFor,
  rewardPrice,
  rewardProblems,
  rewardsOf,
  type Standing,
} from "../src/negotiation/rewards";
import { NO_CUSTOMER, NO_PERSON } from "../src/rules/evaluate";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, products, services } from "../src/schema/tables";
import { type Caller, WriteError } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * Rewarding good customers (ADR-018 §4, Q3): a better price the owner's own rules give a customer whose
 * record earned it, applied by the inbox — never below the owner's floor, never above the list price,
 * never several at once — with the personalised-price notice in the business's voice wherever the
 * price is offered. Only the owner in person writes or reads the rewards. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const EUR = (value: number) => ({ value, currency: "EUR" });
const at = (t: number) => () => t;

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  principal: { via: "session", id: "s1", name: "owner@example.com", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const ai: Caller = {
  actor: { kind: "owner_ai", id: "client_1", channel: "mcp_owner" },
  actsAs: "owner",
  principal: { via: "oauth", id: "client_1", name: "Assistant", scopes: ["*"], userId: "u1" },
  tier: "verified_principal",
  sandbox: false,
  now: at(T0),
};
const anon = (t = T0): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${t}`, channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: at(t),
});
/** A customer the business knows: their assistant's key names their party. */
const known = (partyId: string, t = T0): Caller => ({
  actor: { kind: "customer_agent", id: "key_rita", channel: "rest", partyId },
  tier: "verified_principal",
  sandbox: false,
  now: at(t),
});

const REGULARS = {
  regulars: {
    if: { path: "customer.completed", op: "gte", value: 1 },
    pct: 5,
    says: "Thank you for coming back.",
  },
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm
    .insert(business)
    .values({ id: "self", name: "Oficina Maré", timezone: "UTC", currency: "EUR", createdAt: T0, updatedAt: T0 });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 60,
    capacity: 4,
    granularityMin: 30,
    price: { model: "fixed", value: 5_000, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const chain = ulid();
  const saddle = ulid();
  await db.orm.insert(products).values([
    { id: chain, sku: "CH-9", name: "Chain", price: EUR(1_850), createdAt: T0, updatedAt: T0 },
    { id: saddle, sku: "SD-1", name: "Saddle", price: EUR(9_999), createdAt: T0, updatedAt: T0 },
  ]);
  const raw = new Capabilities(db);
  const caps = confirming(new Capabilities(db));
  let hour = 8;
  const slot = () => {
    hour++;
    return {
      startTime: `2026-09-23T${String(hour).padStart(2, "0")}:00:00Z`,
      endTime: `2026-09-23T${String(hour + 1).padStart(2, "0")}:00:00Z`,
    };
  };
  const booking = (serviceId = svc) => ({ reservationFor: { serviceId, name: "Full service" }, ...slot() });
  /** A customer with one completed booking here: their party. */
  const regular = async () => {
    const first = await caps.createBooking(anon(), { payload: booking(), contact: { email: "rita@example.com" } });
    await caps.transitionItem(owner, { item_id: first.view.item.id, event: "confirm" });
    await caps.transitionItem(owner, { item_id: first.view.item.id, event: "complete" });
    return first.view.item.partyId;
  };
  return { db, caps, raw, svc, chain, saddle, booking, regular };
}

async function refusal(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

const standing = (customer: Partial<Standing["customer"]>): Standing => ({
  customer: { ...NO_CUSTOMER, match: "strong", known: true, ...customer },
  person: NO_PERSON,
});

describe("the price a reward gives", () => {
  it("is the list price less the reward, rounded down to the cent in the customer's favour", () => {
    expect(rewardPrice(5_000, null, 5)).toBe(4_750);
    expect(rewardPrice(999, null, 5)).toBe(949);
    expect(rewardPrice(999, null, 2.5)).toBe(974);
    expect(rewardPrice(1_000, null, 50)).toBe(500);
  });

  it("is never below the owner's floor, and never above the list price", () => {
    expect(rewardPrice(5_000, 4_900, 5)).toBe(4_900);
    expect(rewardPrice(5_000, 6_000, 5)).toBe(5_000);
    expect(rewardPrice(5_000, 0, 5)).toBe(4_750);
  });

  it("is the best reward that matches, never several added up", () => {
    const rewards = rewardsOf({
      regulars: { if: { path: "customer.completed", op: "gte", value: 1 }, pct: 5 },
      loyal: { if: { path: "customer.completed", op: "gte", value: 3 }, pct: 10 },
      chains: { if: { fn: "customer_known" }, pct: 20, only: ["chain"] },
    });
    const three = standing({ completed: 3 });
    expect(rewardFor(rewards, three, "saddle")?.id).toBe("loyal");
    expect(rewardFor(rewards, three, "chain")?.id).toBe("chains");
    expect(rewardFor(rewards, standing({ completed: 1 }), "saddle")?.id).toBe("regulars");
    // A customer with no record here, or no record the conditions ask for, pays the list price.
    expect(rewardFor(rewards, NO_STANDING, "saddle")).toBeNull();
    expect(rewardFor(rewards, standing({ completed: 0, known: false }), "saddle")).toBeNull();
  });
});

describe("what a reward may read, and say", () => {
  it("reads only the record a customer earned: never who or where they are, and never what they are not", () => {
    expect(rewardConditionProblem({ path: "customer.completed", op: "gte", value: 2 })).toBeNull();
    expect(rewardConditionProblem({ any: [{ fn: "person_trusted" }, { fn: "customer_known" }] })).toBeNull();
    expect(
      rewardConditionProblem({ fn: "person_tier_on", args: { network: "net.example", min: "building" } }),
    ).toBeNull();
    expect(rewardConditionProblem({ not: { fn: "customer_known" } })).toMatch(/never what they are not/);
    expect(
      rewardConditionProblem({ path: "item.payload.shippingAddress.addressCountry", op: "eq", value: "PT" }),
    ).toMatch(/customer\.\* and person\.\* only/);
    expect(rewardConditionProblem({ fn: "slot_is_free" })).toMatch(/not the customer's record/);
    expect(rewardConditionProblem({ all: [] })).toMatch(/say who earns it/);
  });

  it("is refused when saved with the field to fix: a condition, a percentage, words for the customer", () => {
    const problems = rewardProblems(
      {
        abroad: { if: { path: "item.payload.billingAddress.addressCountry", op: "eq", value: "ES" }, pct: 5 },
        greedy: { if: { fn: "customer_known" }, pct: 60 },
        chatty: { if: { fn: "customer_known" }, pct: 5, says: "Your score on the network earned this." },
        "Bad Name": { if: { fn: "customer_known" }, pct: 5 },
        extra: { if: { fn: "customer_known" }, pct: 5, price: 1 },
      },
      "doc.negotiation.rewards",
    );
    const paths = problems.map((p) => p.path);
    expect(paths).toContain("doc.negotiation.rewards.abroad.if");
    expect(paths).toContain("doc.negotiation.rewards.greedy.pct");
    expect(paths).toContain("doc.negotiation.rewards.chatty.says");
    expect(paths).toContain("doc.negotiation.rewards.Bad Name");
    expect(paths.some((p) => p.startsWith("doc.negotiation.rewards.extra"))).toBe(true);
  });

  it("is the owner's in person: the AI can neither write rewards nor read them", async () => {
    const s = await setup();
    const refused = await refusal(s.caps.updateSettings(ai, { doc: { negotiation: { rewards: REGULARS } } }));
    expect(refused.code).toBe("not_allowed");
    const bad = await refusal(
      s.caps.updateSettings(owner, {
        doc: { negotiation: { rewards: { everyone: { if: { not: { fn: "customer_known" } }, pct: 5 } } } },
      }),
    );
    expect(bad.code).toBe("invalid_input");
    expect(bad.fields?.[0]?.path).toBe("doc.negotiation.rewards.everyone.if");
    const saved = await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    expect(saved.doc.negotiation.rewards).toEqual(REGULARS);
    const read = await s.caps.getSettings(ai);
    expect(read.withheld).toEqual(["negotiation.ai", "negotiation.rewards"]);
    expect(JSON.stringify(read.doc)).not.toContain("regulars");
    // Removed with null, like any key.
    const removed = await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: { regulars: null } } } });
    expect(removed.doc.negotiation.rewards).toEqual({});
  });
});

describe("a rewarded customer's request", () => {
  it("is confirmed at their price, with the notice in our voice, and written as they confirmed it", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    const party = await s.regular();
    const payload = s.booking();
    const asked = await refusal(s.raw.createBooking(known(party), { payload }));
    expect(asked.code).toBe("confirm_terms");
    const d = asked.details as {
      summary: string;
      terms: { totalPrice: unknown };
      disclosures?: string[];
      terms_sha: string;
    };
    expect(d.terms.totalPrice).toEqual(EUR(4_750));
    expect(d.disclosures).toEqual(["personalised_price"]);
    expect(d.summary).toContain(
      "Your price: €47.50 (our price €50.00). We personalised this price for you by automated decision-making. Thank you for coming back.",
    );
    const made = await s.raw.createBooking(known(party), { payload, terms_sha: d.terms_sha });
    expect(made.view.item.payload).toMatchObject({
      totalPrice: EUR(4_750),
      personalised: { listPrice: EUR(5_000), says: "Thank you for coming back." },
    });
    expect(made.view.item.payload).not.toHaveProperty("customerStatedPrice");
    // The assistant wrote the list price: that is not a price of theirs, they pay their own.
    const listed = await s.caps.createBooking(known(party), { payload: { ...s.booking(), totalPrice: EUR(5_000) } });
    expect(listed.view.item.payload).toMatchObject({ totalPrice: EUR(4_750) });
    expect(listed.view.item.payload).not.toHaveProperty("customerStatedPrice");
    // Every word to them about it says so, in their language too.
    const status = await s.caps.getItemStatus(known(party), { item_id: made.view.item.id });
    expect(status.human).toContain("Your price: €47.50 (our price €50.00).");
  });

  it("is ours as the inbox priced it, so automation confirms it even after the owner changed the reward", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    const party = await s.regular();
    const made = await s.caps.createBooking(known(party), { payload: s.booking() });
    expect(made.view.item.payload).toMatchObject({ totalPrice: EUR(4_750) });
    // The owner narrows the reward to one product while the request waits: the price the customer
    // confirmed stays the business's own, not a price of theirs to judge against the floor.
    await s.caps.updateSettings(owner, {
      doc: { negotiation: { rewards: { regulars: { ...REGULARS.regulars, only: [s.chain] } } } },
    });
    const confirmed = await s.caps.transitionItem(ai, { item_id: made.view.item.id, event: "confirm" });
    expect(confirmed.view.item.state).toBe("confirmed");
    expect(confirmed.view.item.payload).toMatchObject({
      totalPrice: EUR(4_750),
      personalised: { listPrice: EUR(5_000) },
    });
  });

  it("is the list price for a customer with no record here, or none the condition asks for", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    const stranger = await s.caps.createBooking(anon(), { payload: s.booking() });
    expect(stranger.view.item.payload).toMatchObject({ totalPrice: EUR(5_000) });
    expect(stranger.view.item.payload).not.toHaveProperty("personalised");
  });

  it("never goes below the owner's floor", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    await s.caps.setup.setFloors(owner, { floors: [{ kind: "service", ref_id: s.svc, floor_minor: 4_900 }] });
    const party = await s.regular();
    const made = await s.caps.createBooking(known(party), { payload: s.booking() });
    expect(made.view.item.payload).toMatchObject({ totalPrice: EUR(4_900), personalised: { listPrice: EUR(5_000) } });
  });

  it("prices an order's lines one by one, only those the reward covers, with the list total beside it", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: {
        negotiation: { rewards: { chains: { if: { fn: "customer_known" }, pct: 10, only: [s.chain] } } },
      },
    });
    const party = await s.regular();
    const made = await s.caps.createOrder(known(party), {
      payload: {
        orderedItem: [
          { productId: s.chain, name: "Chain", quantity: 2, price: EUR(1_850) },
          { productId: s.saddle, name: "Saddle", quantity: 1, price: EUR(9_999) },
        ],
        totalPrice: EUR(13_699),
      },
    });
    expect(made.view.item.payload).toMatchObject({
      orderedItem: [
        { productId: s.chain, price: EUR(1_665), listPrice: EUR(1_850) },
        { productId: s.saddle, price: EUR(9_999) },
      ],
      totalPrice: EUR(13_329),
      personalised: { listPrice: EUR(13_699) },
    });
    expect((made.view.item.payload as { orderedItem: object[] }).orderedItem[1]).not.toHaveProperty("listPrice");
  });
});

describe("automation pricing for a rewarded customer", () => {
  it("offers their price, never the list price, and says it is theirs", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    const party = await s.regular();
    const b = await s.caps.createBooking(known(party), { payload: s.booking() });
    // The AI names the list price it can see: the customer is offered theirs, with the notice.
    const later = { startTime: "2026-09-24T10:00:00Z", endTime: "2026-09-24T11:00:00Z", totalPrice: EUR(5_000) };
    const r = await s.caps.transitionItem(ai, { item_id: b.view.item.id, event: "propose", input: later });
    expect(r.drafted).toBeUndefined();
    expect(r.view.item.payload).toMatchObject({
      proposed: { totalPrice: EUR(4_750), personalised: { listPrice: EUR(5_000) } },
    });
    const offers = await s.caps.listOffers(owner, { item_id: b.view.item.id });
    const open = offers.offers.find((o) => o.status === "open");
    expect(open?.shown?.disclosures).toContain("personalised_price");
    expect(open?.shown?.human).toContain("Your price: €47.50 (our price €50.00).");
    // The customer's assistant reads the same: the notice in the business's words, and the disclosure.
    const status = await s.caps.getItemStatus(known(party), { item_id: b.view.item.id });
    expect(status.offer?.disclosures).toContain("personalised_price");
    expect(status.offer?.human).toContain("We personalised this price for you by automated decision-making.");
    // Above their price is holding the reward back, and dearer than we just offered: a draft for the owner.
    const dearer = await s.caps.transitionItem(ai, {
      item_id: b.view.item.id,
      event: "propose",
      input: { ...later, totalPrice: EUR(4_900) },
    });
    expect(dearer.drafted?.breaches).toEqual(["above_list", "worse_than_before"]);
  });

  it("keeps their price and the notice when the owner sends automation's draft as it is", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { negotiation: { rewards: REGULARS } } });
    const party = await s.regular();
    const b = await s.caps.createBooking(known(party), { payload: s.booking() });
    // Further from the time asked than the AI may go: a draft, at the customer's price.
    const later = { startTime: "2026-10-09T10:00:00Z", endTime: "2026-10-09T11:00:00Z", totalPrice: EUR(5_000) };
    const r = await s.caps.transitionItem(ai, { item_id: b.view.item.id, event: "propose", input: later });
    expect(r.drafted?.breaches).toEqual(["time_moved"]);
    const sent = await s.caps.sendOfferDraft(owner, { item_id: b.view.item.id });
    expect(sent.view.item.payload).toMatchObject({
      proposed: {
        totalPrice: EUR(4_750),
        personalised: { listPrice: EUR(5_000), says: "Thank you for coming back." },
      },
    });
    const status = await s.caps.getItemStatus(known(party), { item_id: b.view.item.id });
    expect(status.offer?.disclosures).toContain("personalised_price");
  });
});

describe("the emails about a price chosen for the customer", () => {
  const base = {
    id: "01JD0000000000000000QX7K3A",
    version: 2,
    partyId: "p",
    locationId: null,
    channel: "form",
    flags: { needsHuman: false, sandbox: false, priority: 0 },
    linkedItemId: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    closedAt: null,
  };
  const render = (item: Item, lang: "en" | "pt", event: string) =>
    renderCustomerMail({
      item,
      event,
      lang,
      timezone: "Europe/Lisbon",
      business: "Oficina Maré",
      name: "Rita",
      cancellationWindowMin: 0,
      now: T0,
    });
  const personalised = { listPrice: EUR(5_000), says: "Thank you for coming back." };

  it("carry the notice beside it, in the customer's language: a time we propose, a booking confirmed", () => {
    const proposed = {
      ...base,
      type: "booking",
      state: "proposed",
      subject: "Full service",
      payload: {
        reservationFor: { serviceId: "s", name: "Full service" },
        startTime: "2026-09-25T08:00:00Z",
        endTime: "2026-09-25T09:30:00Z",
        totalPrice: EUR(5_000),
        proposed: {
          startTime: "2026-09-25T10:00:00Z",
          endTime: "2026-09-25T11:30:00Z",
          totalPrice: EUR(4_750),
          personalised,
        },
      },
    } as unknown as Item;
    expect(render(proposed, "en", "propose").text).toContain(
      "Your price: €47.50 (our price €50.00). We personalised this price for you by automated decision-making. Thank you for coming back.",
    );
    expect(render(proposed, "pt", "propose").text).toContain(
      "Este preço foi personalizado com base numa decisão automatizada.",
    );
    const confirmed = {
      ...proposed,
      state: "confirmed",
      payload: { ...(proposed.payload as object), proposed: undefined, totalPrice: EUR(4_750), personalised },
    } as unknown as Item;
    expect(render(confirmed, "en", "confirm").text).toContain("Your price: €47.50 (our price €50.00).");
  });

  it("carry it with changes to an order and with an accepted order, and never with a list price", () => {
    const lines = [{ productId: "c", name: "Chain", quantity: 2, price: EUR(1_665), listPrice: EUR(1_850) }];
    const order = {
      ...base,
      type: "order",
      state: "proposed",
      subject: "Chain",
      payload: {
        orderedItem: lines,
        totalPrice: EUR(3_330),
        proposed: { orderedItem: lines, totalPrice: EUR(3_330), personalised: { listPrice: EUR(3_700) } },
      },
    } as unknown as Item;
    expect(render(order, "en", "propose").text).toContain("Your price: €33.30 (our price €37.00).");
    const accepted = {
      ...order,
      state: "accepted",
      payload: { orderedItem: lines, totalPrice: EUR(3_330), personalised: { listPrice: EUR(3_700) } },
    } as unknown as Item;
    expect(render(accepted, "en", "accept").text).toContain("Your price: €33.30 (our price €37.00).");
    const listPriced = {
      ...accepted,
      payload: { orderedItem: [{ ...lines[0], price: EUR(1_850), listPrice: undefined }], totalPrice: EUR(3_700) },
    } as unknown as Item;
    expect(render(listPriced, "en", "accept").text).not.toContain("personalised");
  });
});
