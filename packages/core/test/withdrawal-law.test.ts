import { logMailOut, runMigrations } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { putReturnPolicy, type ReturnPolicyInput, returnPolicyTooShort } from "../src/catalogue/policies";
import { COPY, vars, WITHDRAWAL_OTHER, withdrawalCopy } from "../src/customer/copy";
import { linksForEmail } from "../src/customer/links";
import { createDb, type Db } from "../src/db";
import { customerCopyProblems } from "../src/i18n/customer-words";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { contractLawOf, lawOf } from "../src/negotiation/holidays";
import { periodEnd, withdrawalRight } from "../src/negotiation/withdrawal";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, items, outboundMail, products, services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import { type Caller, createItem, rowToItem, transitionItem, WriteError } from "../src/write/index";
import { makeClient, openAllWeek, resetTables } from "./harness";

/**
 * The law a business sells under, by its own country (ADR-018 Amendment 7): the EU's right of withdrawal
 * and its model form only in the EU, the EEA and Gibraltar, the UK's in the UK, and anywhere else no
 * right claimed at all, only a return policy the owner wrote, where there is one, or that what was
 * bought cannot be returned. A business in Japan, Mexico, Canada or Brazil, one in a member state, one in
 * Gibraltar and one in the UK each take a priced order and a booking through the confirm step and send
 * the first confirmation. A contract keeps the law it was asked for under, recorded on it
 * (`contractLawOf`), whatever the country becomes and whenever the inbox took this release; what the
 * owner's AI may approve there is what the customer was told. Runs on Node and in workerd.
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
const anon = (accessToken?: string): Caller => ({
  actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
  tier: "anonymous",
  sandbox: false,
  now: () => clock.now,
  ...(accessToken ? { accessToken } : {}),
});

const WINDOW_30: Omit<ReturnPolicyInput, "id" | "name"> = {
  default: true,
  eligibility: "window",
  window_days: 30,
  resolutions: ["refund"],
  methods: ["by_post"],
  return_postage: "customer",
};
const UNLIMITED: Omit<ReturnPolicyInput, "id" | "name"> = {
  default: true,
  eligibility: "unlimited",
  resolutions: ["refund"],
  methods: ["by_post"],
  return_postage: "business",
};
const NO_RETURNS: Omit<ReturnPolicyInput, "id" | "name"> = {
  default: true,
  eligibility: "not_accepted",
  resolutions: [],
  methods: [],
};

interface Country {
  readonly country: string;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly lang: "en" | "pt";
  /** The return policy the owner wrote; none keeps the settings' standard one. */
  readonly policy?: Omit<ReturnPolicyInput, "id" | "name"> | undefined;
  /** What the confirm step and the first confirmation say of returns before an order; null for nothing. */
  readonly orderLine: string | null;
  /** …and before a booking. */
  readonly bookingLine: string | null;
  /** The model form's first words and the link's label, where the law gives the right. */
  readonly form?: string | undefined;
  readonly link?: string | undefined;
}

const CASES: readonly Country[] = [
  {
    country: "JP",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    locale: "en",
    lang: "en",
    policy: UNLIMITED,
    orderLine: "Under our return policy, you can return it at any time.",
    bookingLine: null,
  },
  {
    country: "MX",
    currency: "MXN",
    timezone: "America/Mexico_City",
    locale: "en",
    lang: "en",
    policy: NO_RETURNS,
    orderLine: null,
    bookingLine: null,
  },
  {
    country: "CA",
    currency: "CAD",
    timezone: "America/Toronto",
    locale: "en",
    lang: "en",
    policy: WINDOW_30,
    orderLine: "Under our return policy, you can return it within 30 days of receiving it.",
    bookingLine: null,
  },
  {
    // No return policy written: the standard one only follows the settings' floor of 14 days, which the
    // owner never chose, so nothing is said of returns.
    country: "BR",
    currency: "BRL",
    timezone: "America/Sao_Paulo",
    locale: "pt-BR",
    lang: "pt",
    orderLine: null,
    bookingLine: null,
  },
  {
    country: "DE",
    currency: "EUR",
    timezone: "Europe/Berlin",
    locale: "en",
    lang: "en",
    orderLine: "You can withdraw within 14 days of receiving it, without giving a reason.",
    bookingLine: "You can withdraw within 14 days of booking, without giving a reason.",
    form: "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):",
    link: "Withdraw from contract here",
  },
  {
    // Gibraltar's own law took the directive in (LN 2013/177): the EU's words and form.
    country: "GI",
    currency: "GBP",
    timezone: "Europe/Gibraltar",
    locale: "en",
    lang: "en",
    orderLine: "You can withdraw within 14 days of receiving it, without giving a reason.",
    bookingLine: "You can withdraw within 14 days of booking, without giving a reason.",
    form: "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):",
    link: "Withdraw from contract here",
  },
  {
    country: "GB",
    currency: "GBP",
    timezone: "Europe/London",
    locale: "en",
    lang: "en",
    orderLine: "You can cancel within 14 days of receiving it, without giving a reason.",
    bookingLine: "You can cancel within 14 days of booking, without giving a reason.",
    form: "Model cancellation form (complete and return this form only if you wish to cancel the contract):",
    link: "Cancel this contract here",
  },
];

/** What a customer must never read where no right of withdrawal is claimed, in either language. */
const STATUTORY =
  /withdraw|without giving a reason|model .*form|retrat|livre resolução|sem indicar motivo|modelo de formulário/i;
/** Any line about returning or cancelling, where nothing is to be said. */
const ANY_RETURN_LINE = /return policy|return it|cancel within|política de devoluções|pode cancelar/i;

async function setup(c: Country) {
  clock.now = T0;
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Harbour Cycles",
    timezone: c.timezone,
    currency: c.currency,
    languages: [c.lang],
    createdAt: T0,
    updatedAt: T0,
  });
  const money = (value: number) => ({ value, currency: c.currency });
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    price: { model: "fixed", value: 4500, currency: c.currency },
    createdAt: T0,
    updatedAt: T0,
  });
  await openAllWeek(db);
  const chain = ulid();
  await db.orm
    .insert(products)
    .values({ id: chain, sku: "CH-9", name: "Chain", price: money(1850), active: 1, createdAt: T0, updatedAt: T0 });
  const caps = new Capabilities(db, createSecretBox(["withdrawal-law-test-secret-0123456789"]), BASE);
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Harbour Cycles" },
      notifications: { ownerEmail: "hello@harbour.example", appUrl: BASE },
      email: { fromAddress: "orders@harbour.example" },
      commerce: {
        legal: {
          country: c.country,
          legalName: "Harbour Cycles Ltd",
          address: "1 Quay Street",
          email: "hello@harbour.example",
          vatId: "X123",
        },
      },
    },
  });
  if (c.policy) await putReturnPolicy(db, { id: "standard", name: "Our returns", ...c.policy }, T0);
  const runner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts, baseUrl: BASE, secrets: caps.secrets });
  const drain = async () => {
    for (let i = 0; i < 30; i++) if ((await runner.runDue(db, { now: clock.now, limit: 100 })).claimed === 0) return;
  };
  return { db, caps, svc, chain, money, drain };
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

/** A priced order through the confirm step: the summary the customer saw, then the order confirmed. */
async function confirmedOrder(s: Setup, c: Country, productId: string = s.chain) {
  const input = {
    payload: {
      orderedItem: [{ productId, name: "x", quantity: 1, price: s.money(1) }],
      totalPrice: s.money(1),
    },
    contact: { name: "Rita", email: "rita@example.com", locale: c.locale },
  };
  const asked = await refused(s.caps.createOrder(anon(), input));
  expect(asked.code).toBe("confirm_terms");
  const d = asked.details as { summary: string; terms_sha: string };
  const made = await s.caps.createOrder(anon(), { ...input, terms_sha: d.terms_sha });
  return { summary: d.summary, id: made.view.item.id, token: made.accessToken as string };
}

/** A priced booking through the confirm step, for twenty days on: the summary the customer saw, then the request. */
async function askedBooking(s: Setup, c: Country) {
  const start = clock.now + 20 * DAY;
  const input = {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: iso(start),
      endTime: iso(start + 90 * 60_000),
    },
    contact: { name: "Rita", email: "rita@example.com", locale: c.locale },
  };
  const asked = await refused(s.caps.createBooking(anon(), input));
  expect(asked.code).toBe("confirm_terms");
  const d = asked.details as { summary: string; terms_sha: string };
  const made = await s.caps.createBooking(anon(), { ...input, terms_sha: d.terms_sha });
  return { summary: d.summary, id: made.view.item.id, token: made.accessToken as string };
}

const customerMail = async (db: Db, id: string) =>
  (await db.orm.select().from(outboundMail).where(eq(outboundMail.itemId, id))).filter(
    (m) => m.recipient === "customer",
  );

describe("the law a business sells under, by its country", () => {
  it("is the EU's in the member states, the EEA and Gibraltar, the UK's in the UK, and another's elsewhere", () => {
    for (const c of [
      "DE",
      "FR",
      "ES",
      "IT",
      "IE",
      "PL",
      "SE",
      "GR",
      "EL",
      "RE",
      "GP",
      "AX",
      "NO",
      "IS",
      "LI",
      "GI",
      "gi",
      "de",
    ])
      expect(lawOf(c), c).toBe("eu");
    expect(lawOf("PT")).toBe("pt");
    expect(lawOf("GB")).toBe("uk");
    expect(lawOf("UK")).toBe("uk");
    for (const c of ["JP", "MX", "CA", "US", "AU", "BR", "CH", "TR", "JE", "GG", "IM", "jp"])
      expect(lawOf(c), c).toBe("other");
    // Nobody said which: erring toward the customer, as return policies do.
    expect(lawOf("")).toBe("eu");
    expect(lawOf(undefined)).toBe("eu");
  });

  it("is the same law the return policies are held to", () => {
    const short = { eligibility: "window", window_days: 7 } as const;
    for (const c of ["DE", "NO", "PT", "GB", "UK", "RE", "AX", "EL", "GI", ""])
      expect(returnPolicyTooShort(short, c), c).not.toBeNull();
    for (const c of ["JP", "MX", "CA", "US", "AU", "BR"]) expect(returnPolicyTooShort(short, c), c).toBeNull();
  });

  it("claims no right under another country's law, but still counts the business's own policy period", () => {
    const base = {
      type: "order" as const,
      state: "fulfilled",
      consumer: true,
      flags: ["standard"],
      paid: true,
      period: {
        kind: "goods" as const,
        concludedAt: T0,
        deliveredAt: T0 + DAY,
        days: 14,
        assumedTransitDays: 7,
        law: "other" as const,
        timezone: "Asia/Tokyo",
      },
      now: T0 + 3 * DAY,
    };
    expect(withdrawalRight(base)).toEqual({ available: false, until: null, why: "other_law" });
    expect(withdrawalRight({ ...base, state: "requested" })).toMatchObject({ why: "not_agreed" });
    expect(withdrawalRight({ ...base, policy: true })).toMatchObject({ available: true });
    expect(withdrawalRight({ ...base, period: { ...base.period, law: "eu" } })).toMatchObject({ available: true });
    // Asked of the policy, its own days alone, with no statutory floor; none written, nothing inside it.
    const seven = { ...base, policy: true, period: { ...base.period, days: 7 } };
    expect(withdrawalRight(seven)).toEqual({
      available: true,
      until: periodEnd(T0 + DAY, 7, "other", "Asia/Tokyo"),
    });
    expect(withdrawalRight({ ...seven, now: T0 + 12 * DAY })).toMatchObject({ available: false, why: "lapsed" });
    expect(withdrawalRight({ ...seven, now: T0 + 12 * DAY, period: { ...seven.period, law: "eu" } })).toMatchObject({
      available: true,
    });
    expect(withdrawalRight({ ...base, policy: true, period: { ...base.period, days: 0 } })).toMatchObject({
      available: false,
      why: "other_law",
    });
    expect(withdrawalRight({ ...seven, flags: ["perishable"] })).toMatchObject({ why: "excepted" });
  });

  it("has words for elsewhere that claim no right and name nothing but the business", () => {
    for (const lang of ["en", "pt"] as const) {
      const w = WITHDRAWAL_OTHER[lang];
      expect(withdrawalCopy(lang, "other")).toBe(w);
      expect(w.modelForm).toBeNull();
      expect(w.startsEarly).toBeNull();
      const v = vars({
        what: '"1 × Chain"',
        when: "Monday",
        deadline: "Friday",
        ref: "7K3QXA",
        days: "14",
        amount: "¥1,850",
        yourNoun: COPY[lang].yourNoun.order,
        address: "1 Quay Street",
      });
      const texts = [
        w.label,
        w.confirm,
        w.lineGoods(v),
        w.lineService(v),
        w.until(v),
        ...Object.values(w.except),
        w.receivedSubject(v),
        w.received(v),
        w.statement(v),
        w.noRight(v),
        w.passedOn(v),
        w.page.heading,
        w.page.done(v),
        w.page.sent(v),
        COPY[lang].returns.policy.window(v),
        COPY[lang].returns.policy.anyTime,
      ];
      for (const t of texts) {
        expect(t.trim().length).toBeGreaterThan(0);
        expect(t, t).not.toMatch(STATUTORY);
      }
      // No withdrawal is ever sent from a page there, so none is ever said to have been emailed.
      expect(w.page.done(v)).toBe(w.page.sent(v));
      expect(w.noRight(v)).not.toMatch(/online/);
      expect(customerCopyProblems(texts, lang)).toEqual([]);
    }
  });
});

describe("before an order or a booking binds, and in its first confirmation", () => {
  for (const c of CASES) {
    const law = lawOf(c.country);
    it(`in ${c.country} (${c.currency}): ${law === "other" ? "only our own return policy" : `the ${law.toUpperCase()}'s right and model form`}`, async () => {
      const s = await setup(c);

      // The confirm step of an order.
      const o = await confirmedOrder(s, c);
      if (c.orderLine) expect(o.summary).toContain(c.orderLine);
      else expect(o.summary).not.toMatch(ANY_RETURN_LINE);
      if (law === "other") expect(o.summary).not.toMatch(STATUTORY);
      expect(customerCopyProblems([o.summary], c.lang)).toEqual([]);

      // The confirm step of a booking.
      const start = T0 + 20 * DAY;
      const asked = await refused(
        s.caps.createBooking(anon(), {
          payload: {
            reservationFor: { serviceId: s.svc, name: "Full service" },
            startTime: iso(start),
            endTime: iso(start + 90 * 60_000),
          },
          contact: { email: "rita@example.com", locale: c.locale },
        }),
      );
      expect(asked.code).toBe("confirm_terms");
      const bookingSummary = (asked.details as { summary: string }).summary;
      if (c.bookingLine) expect(bookingSummary).toContain(c.bookingLine);
      else expect(bookingSummary).not.toMatch(ANY_RETURN_LINE);
      if (law === "other") expect(bookingSummary).not.toMatch(STATUTORY);
      expect(customerCopyProblems([bookingSummary], c.lang)).toEqual([]);

      // The first confirmation, once we accept the order.
      await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
      await s.drain();
      const accepted = (await customerMail(s.db, o.id)).find((m) => m.template === "order.accepted");
      if (!accepted) throw new Error("expected the confirmation");
      expect(customerCopyProblems([accepted.subject, accepted.bodyText], c.lang)).toEqual([]);
      if (c.orderLine) expect(accepted.bodyText).toContain(c.orderLine);
      else expect(accepted.bodyText).not.toMatch(ANY_RETURN_LINE);
      const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
      if (law === "other") {
        expect(accepted.bodyText).not.toMatch(STATUTORY);
        expect(accepted.bodyText).not.toContain(WITHDRAWAL_OTHER[c.lang].label);
        // Nothing to withdraw from: the status says nothing of it, and offers no withdrawal.
        expect(status.withdrawal ?? null).toBeNull();
        expect(status.next?.map((n) => n.action)).not.toContain("withdraw_from_contract");
      } else {
        expect(accepted.bodyText).toContain(c.form);
        expect(accepted.bodyText).toMatch(new RegExp(`${c.link}: https://orders\\.example/c/`));
        expect(accepted.bodyText).toContain("Harbour Cycles Ltd · 1 Quay Street · hello@harbour.example · VAT X123");
        expect(status.withdrawal).toMatchObject({ available: true, label: c.link });
      }

      // Paid and sent: the confirmations after the first carry no policy line, and no right elsewhere.
      await transitionItem(s.db, shop, {
        itemId: o.id,
        event: "record_payment",
        input: { paymentRef: "pi_1", amount: s.money(1850) },
      });
      clock.now = T0 + DAY;
      await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
      await s.drain();
      const fulfilled = (await customerMail(s.db, o.id)).find((m) => m.template === "order.fulfilled");
      if (!fulfilled) throw new Error("expected the fulfilment email");
      expect(customerCopyProblems([fulfilled.subject, fulfilled.bodyText], c.lang)).toEqual([]);
      if (law === "other") expect(fulfilled.bodyText).not.toMatch(new RegExp(`${STATUTORY.source}|return policy`, "i"));
      else expect(fulfilled.bodyText).toMatch(new RegExp(`${c.link}: https://orders\\.example/c/`));
    });
  }
});

describe("a change of mind under another country's law", () => {
  const canada = CASES.find((c) => c.country === "CA") as Country;

  it("after delivery is a return under our policy, for us to answer and free to refuse", async () => {
    const s = await setup(canada);
    const o = await confirmedOrder(s, canada);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await transitionItem(s.db, shop, {
      itemId: o.id,
      event: "record_payment",
      input: { paymentRef: "pi_1", amount: s.money(1850) },
    });
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });

    clock.now = T0 + 3 * DAY;
    const asked = await refused(s.caps.customer.withdraw(anon(o.token), { item_id: o.id, access_token: o.token }));
    expect(asked.code).toBe("confirm_withdrawal");
    const statement = (asked.details as { statement: Record<string, unknown> }).statement;
    expect(statement).toMatchObject({ available: false, label: "Cancel or return here" });
    expect(statement.why).toBeUndefined();
    expect(String(statement.text)).not.toMatch(STATUTORY);

    const done = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    if (!("linked" in done) || !done.linked) throw new Error("expected a return");
    const id = done.linked.item.id;
    expect(done.linked.item).toMatchObject({ state: "requested", payload: { kind: "policy" } });
    await s.drain();
    const ack = (await customerMail(s.db, id)).find((m) => m.template === "refund.received");
    expect(ack?.bodyText).toMatch(
      /We have received your request to return "1 × Chain"\. We will answer within 48 hours\./,
    );
    expect(ack?.bodyText).not.toMatch(STATUTORY);

    // Not a withdrawal no one may refuse: a person may say no, with the reason.
    await transitionItem(s.db, owner, { itemId: id, event: "reject", input: { note: "It has been ridden." } });
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, id));
    expect(row && rowToItem(row).state).toBe("rejected");
  });

  it("before the goods went out reaches a person as the customer's message, never refused", async () => {
    const s = await setup(canada);
    const o = await confirmedOrder(s, canada);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await transitionItem(s.db, shop, {
      itemId: o.id,
      event: "record_payment",
      input: { paymentRef: "pi_1", amount: s.money(1850) },
    });
    const passed = await s.caps.customer.withdraw(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      confirm_withdrawal: true,
    });
    if (!("passed_on" in passed)) throw new Error("expected it passed on");
    expect(passed.passed_on).toBe("We have passed your message to a person on our team, who will reply soon.");
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, o.id));
    expect(row && rowToItem(row).state).toBe("paid");
    // The business that records the cancel cancels: it is not turned into a withdrawal.
    await transitionItem(s.db, owner, {
      itemId: o.id,
      event: "record_cancel",
      input: { note: "The customer rang to cancel." },
    });
    const { rows } = await s.db.client.query({
      sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY created_at, id",
      params: [o.id],
      method: "all",
    });
    const events = rows.map((r) => String(r[0]));
    expect(events).toContain("record_cancel");
    expect(events).not.toContain("record_withdrawal");
  });
});

describe("a contract keeps the law it was asked for under", () => {
  /** A business in the United States with no return policy of its own written. */
  const usa: Country = {
    country: "US",
    currency: "USD",
    timezone: "America/New_York",
    locale: "en",
    lang: "en",
    orderLine: null,
    bookingLine: null,
  };
  const member = CASES.find((c) => c.country === "DE") as Country;
  const japan = CASES.find((c) => c.country === "JP") as Country;
  const EU_ORDER_LINE = "You can withdraw within 14 days of receiving it, without giving a reason.";
  const EU_FORM =
    "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):";
  const pay = (s: Setup, id: string, value: number) =>
    transitionItem(s.db, shop, {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: `pi_${id}`, amount: s.money(value) },
    });
  const eventsOf = async (db: Db, id: string) =>
    (
      await db.client.query({
        sql: "SELECT event FROM item_events WHERE item_id = ? ORDER BY created_at, id",
        params: [id],
        method: "all",
      })
    ).rows.map((r) => String(r[0]));
  const lawOn = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(items).where(eq(items.id, id));
    return (row?.payload as { law?: string } | undefined)?.law;
  };
  /** As an order or a booking made before items recorded their law (an inbox updated later): nothing says which. */
  const madeBefore = (db: Db, id: string) =>
    db.client.query({
      sql: "UPDATE items SET payload = json_remove(payload, '$.law') WHERE id = ?",
      params: [id],
      method: "run",
    });
  const moveTo = (s: Setup, country: string) =>
    s.caps.updateSettings(owner, { doc: { commerce: { legal: { country } } } });

  it("is the one it recorded, else, made before items recorded it, its business's country's now, never another's", () => {
    for (const law of ["eu", "pt", "uk", "other"] as const)
      for (const c of ["DE", "JP", "GB", "PT", ""])
        expect(contractLawOf(c, { payload: { law } }), `${law} ${c}`).toBe(law);
    for (const c of ["JP", "MX", "CA", "US", "BR", "JE"]) expect(contractLawOf(c, { payload: {} }), c).toBe("eu");
    for (const [c, law] of [
      ["DE", "eu"],
      ["GI", "eu"],
      ["PT", "pt"],
      ["GB", "uk"],
      ["", "eu"],
    ] as const)
      expect(contractLawOf(c, { payload: {} }), c).toBe(law);
    // What is no law is no record.
    expect(contractLawOf("JP", { payload: { law: "jp" } })).toBe("eu");
    expect(contractLawOf("JP", null)).toBe("eu");
  });

  it("is recorded as it is asked for, the law its summary told, never what a request or a system sends", async () => {
    const s = await setup(usa);
    const o = await confirmedOrder(s, usa);
    const b = await askedBooking(s, usa);
    expect(await lawOn(s.db, o.id)).toBe("other");
    expect(await lawOn(s.db, b.id)).toBe("other");
    // The confirm step hands the create the law it told: that is what is recorded, whatever the country
    // reads by the time the order is written.
    const told = await createItem(s.db, anon(), {
      type: "order",
      payload: {
        orderedItem: [{ productId: s.chain, name: "x", quantity: 1, price: s.money(1850) }],
        totalPrice: s.money(1850),
      },
      contact: { email: "rita@example.com" },
      confirmed: true,
      law: "eu",
    });
    expect(await lawOn(s.db, told.view.item.id)).toBe("eu");

    // In a member state: a shop's system or a customer that sends a law of its own is not believed.
    const d = await setup(member);
    const sent = { orderedItem: [{ productId: d.chain, name: "x", quantity: 1, price: d.money(1850) }], law: "other" };
    const fromShop = await createItem(d.db, shop, { type: "order", payload: { ...sent, totalPrice: d.money(1850) } });
    expect(await lawOn(d.db, fromShop.view.item.id)).toBe("eu");
    const fromCustomer = await createItem(d.db, anon(), {
      type: "order",
      payload: { ...sent, totalPrice: d.money(1850) },
      contact: { email: "rita@example.com" },
    });
    expect(await lawOn(d.db, fromCustomer.view.item.id)).toBe("eu");

    // The owner moves the business between the customer's yes and the order being written: the order
    // keeps the law its summary told.
    const create = d.caps.people.create.bind(d.caps.people);
    d.caps.people.create = async (...args: Parameters<typeof create>) => {
      await moveTo(d, "US");
      return create(...args);
    };
    const yes = await confirmedOrder(d, member);
    expect(yes.summary).toContain(EU_ORDER_LINE);
    expect(await lawOn(d.db, yes.id)).toBe("eu");
    const status = await d.caps.getItemStatus(anon(yes.token), { item_id: yes.id, access_token: yes.token });
    expect(status.item.payload).toMatchObject({ law: "eu" });
  });

  it("made before items recorded it, by a business elsewhere: its confirmation, the status door, the link, its pages and the copy", async () => {
    const s = await setup(usa);
    const o = await confirmedOrder(s, usa);
    // An inbox that took this release after the order was asked for: the EU's right, as it told then.
    await madeBefore(s.db, o.id);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await s.drain();
    await pay(s, o.id, 1850);
    await s.drain();
    const accepted = (await customerMail(s.db, o.id)).find((m) => m.template === "order.accepted");
    if (!accepted) throw new Error("expected the confirmation");
    expect(accepted.bodyText).toContain(EU_FORM);
    expect(accepted.bodyText).not.toContain("Under our return policy");
    const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal).toMatchObject({ available: true, label: "Withdraw from contract here" });
    expect(status.next?.map((n) => n.action)).toContain("withdraw_from_contract");

    // The link the confirmation carries: the EU's page, its button, and the page once it was sent.
    expect(accepted.bodyText).toMatch(/Withdraw from contract here: https:\/\/orders\.example\/c\//);
    const [row0] = await s.db.orm.select().from(items).where(eq(items.id, o.id));
    if (!row0) throw new Error("expected the order");
    const links = await linksForEmail(s.db, s.caps.secrets, rowToItem(row0), {
      mailKey: "test:accepted",
      lang: "en",
      base: BASE,
      now: clock.now,
      withdraw: { until: null },
    });
    const token = String(links?.get("withdraw")).split("/c/")[1] as string;
    const page = await s.caps.customer.linkView(token, { now: clock.now });
    expect(page.heading).toBe("Withdraw from your contract");
    expect(page.form?.button).toBe("Confirm withdrawal");
    expect(page.quote).toMatch(/^I withdraw from my contract for "1 × Chain" \(reference [0-9A-Z]{6}\)\.$/);
    expect(await s.caps.customer.linkAct(token, page.form?.hidden ?? {}, { now: clock.now })).toEqual({
      redirect: `/c/${token}`,
    });
    const done = await s.caps.customer.linkView(token, { now: clock.now });
    expect(done.heading).toMatch(/^Your withdrawal was sent on .*\. We have emailed you a copy\.$/);
    const [row] = await s.db.orm.select().from(items).where(eq(items.id, o.id));
    expect(row && rowToItem(row).state).toBe("cancelled");
    await s.drain();
    const copy = (await customerMail(s.db, o.id)).find((m) => m.template === "order.withdrawn");
    expect(copy?.subject).toBe("We have received your withdrawal: 1 × Chain");
    expect(customerCopyProblems([copy?.subject ?? "", copy?.bodyText ?? ""], "en")).toEqual([]);
  });

  it("made before items recorded it: a return after delivery, a cancel the business records, and a booking; one asked for now has none", async () => {
    const s = await setup(usa);
    const delivered = await confirmedOrder(s, usa);
    const paidOnly = await confirmedOrder(s, usa);
    const booking = await askedBooking(s, usa);
    for (const id of [delivered.id, paidOnly.id, booking.id]) await madeBefore(s.db, id);
    const fresh = await confirmedOrder(s, usa);
    expect(fresh.summary).not.toMatch(ANY_RETURN_LINE);
    expect(fresh.summary).not.toMatch(STATUTORY);
    for (const o of [delivered, paidOnly, fresh]) {
      await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
      await pay(s, o.id, 1850);
    }
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: delivered.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    await transitionItem(s.db, owner, { itemId: booking.id, event: "confirm" });
    await pay(s, booking.id, 4500);

    // A change of mind after delivery: the EU's withdrawal, agreed at once, and its copy in the EU's words.
    clock.now = T0 + 4 * DAY;
    const back = await s.caps.customer.requestReturn(anon(delivered.token), {
      item_id: delivered.id,
      access_token: delivered.token,
      reason: "changed_mind",
    });
    expect(back.linked?.item).toMatchObject({ state: "approved", payload: { kind: "withdrawal", goodsBack: true } });
    await s.drain();
    const ack = (await customerMail(s.db, back.linked?.item.id as string)).find(
      (m) => m.template === "refund.withdrawn",
    );
    expect(ack?.subject).toBe("We have received your withdrawal: 1 × Chain");
    expect(ack?.bodyText).toMatch(/I withdraw from my contract for "1 × Chain"/);

    // What the customer told the business, recorded as a cancel of what they paid for, is their withdrawal.
    await transitionItem(s.db, owner, {
      itemId: paidOnly.id,
      event: "record_cancel",
      input: { note: "The customer rang to cancel." },
    });
    expect(await eventsOf(s.db, paidOnly.id)).toContain("record_withdrawal");

    // The booking: the right runs until it starts, and the customer's cancel is their withdrawal.
    const seen = await s.caps.getItemStatus(anon(booking.token), { item_id: booking.id, access_token: booking.token });
    expect(seen.withdrawal).toMatchObject({ available: true, label: "Withdraw from contract here" });
    const cancelled = await s.caps.cancelItem(anon(booking.token), {
      item_id: booking.id,
      access_token: booking.token,
    });
    expect(cancelled.linked?.item).toMatchObject({ state: "approved", payload: { kind: "withdrawal" } });
    expect(await eventsOf(s.db, booking.id)).toContain("withdraw");

    // Asked for now: no right, and the owner is told why, in the owner's words.
    const status = await s.caps.getItemStatus(anon(fresh.token), { item_id: fresh.id, access_token: fresh.token });
    expect(status.withdrawal ?? null).toBeNull();
    const no = await refused(
      transitionItem(s.db, owner, {
        itemId: fresh.id,
        event: "record_withdrawal",
        input: { note: "The customer wrote that they withdraw." },
      }),
    );
    expect(no.details).toMatchObject({ guard: "withdrawal_open", why: "other_law" });
    expect(no.message).toContain("no right of withdrawal is claimed for it");
  });

  it("whatever the business's country becomes after: none to the United States, a member state to Japan, and back", async () => {
    for (const [from, to] of [
      ["", "US"],
      ["DE", "JP"],
    ] as const) {
      const s = await setup({ ...member, country: from });
      const o = await confirmedOrder(s, member);
      expect(o.summary).toContain(EU_ORDER_LINE);
      await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
      await s.drain();
      await pay(s, o.id, 1850);
      const accepted = (await customerMail(s.db, o.id)).find((m) => m.template === "order.accepted");
      expect(accepted?.bodyText).toContain(EU_FORM);
      clock.now = T0 + DAY;
      await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
      // The owner moves the business the day after: what the customer was told stands.
      clock.now = T0 + 2 * DAY;
      await moveTo(s, to);
      const status = await s.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
      expect(status.withdrawal, `${from} to ${to}`).toMatchObject({
        available: true,
        label: "Withdraw from contract here",
      });
      expect(status.next?.map((n) => n.action)).toContain("withdraw_from_contract");
      const done = await s.caps.customer.withdraw(anon(o.token), {
        item_id: o.id,
        access_token: o.token,
        confirm_withdrawal: true,
      });
      if (!("linked" in done) || !done.linked) throw new Error("expected the withdrawal");
      expect(done.linked.item).toMatchObject({ payload: { kind: "withdrawal" } });
      // A new order there is asked for under the law it moved to.
      const later = await confirmedOrder(s, member);
      expect(later.summary).not.toMatch(STATUTORY);
      expect(await lawOn(s.db, later.id)).toBe("other");
    }

    // And the other way: an order asked for in Japan stays without a right once the business is in the EU.
    const j = await setup(japan);
    const o = await confirmedOrder(j, japan);
    await transitionItem(j.db, owner, { itemId: o.id, event: "accept" });
    await pay(j, o.id, 1850);
    // Its unlimited policy is 14 days or more: nothing stops the move.
    await moveTo(j, "DE");
    const status = await j.caps.getItemStatus(anon(o.token), { item_id: o.id, access_token: o.token });
    expect(status.withdrawal ?? null).toBeNull();
    expect(status.next?.map((n) => n.action)).not.toContain("withdraw_from_contract");
  });

  it("a summary read before the business moved and said yes to after it is shown again; in the EU the yes binds", async () => {
    const s = await setup({ ...usa, country: "" });
    const input = {
      payload: {
        orderedItem: [{ productId: s.chain, name: "x", quantity: 1, price: s.money(1) }],
        totalPrice: s.money(1),
      },
      contact: { name: "Rita", email: "rita@example.com", locale: "en" },
    };
    const first = (await refused(s.caps.createOrder(anon(), input))).details as { summary: string; terms_sha: string };
    expect(first.summary).toContain(EU_ORDER_LINE);
    await moveTo(s, "US");
    const again = await refused(s.caps.createOrder(anon(), { ...input, terms_sha: first.terms_sha }));
    expect(again.code).toBe("confirm_terms");
    const now = again.details as { summary: string; terms_sha: string; changed?: boolean };
    expect(now.changed).toBe(true);
    expect(now.summary).not.toMatch(STATUTORY);
    expect(now.summary).not.toMatch(ANY_RETURN_LINE);
    const made = await s.caps.createOrder(anon(), { ...input, terms_sha: now.terms_sha });
    expect(made.view.item.state).toBe("received");
    expect(await lawOn(s.db, made.view.item.id)).toBe("other");

    // From one member state to another the law is the EU's either way: the same fingerprint, so the yes binds.
    const d = await setup(member);
    const order = {
      ...input,
      payload: {
        orderedItem: [{ productId: d.chain, name: "x", quantity: 1, price: d.money(1) }],
        totalPrice: d.money(1),
      },
    };
    const sha = ((await refused(d.caps.createOrder(anon(), order))).details as { terms_sha: string }).terms_sha;
    await moveTo(d, "AT");
    const bound = await d.caps.createOrder(anon(), { ...order, terms_sha: sha });
    expect(bound.view.item.state).toBe("received");
    expect(await lawOn(d.db, bound.view.item.id)).toBe("eu");
  });
});

describe("under another country's law, a customer is told only what the owner wrote, and the AI approves only that", () => {
  const ai = at("owner_ai", "mcp_owner");
  const elsewhere = (country: "JP" | "MX", policy?: Omit<ReturnPolicyInput, "id" | "name">): Country => ({
    country,
    currency: country === "MX" ? "MXN" : "JPY",
    timezone: country === "MX" ? "America/Mexico_City" : "Asia/Tokyo",
    locale: "en",
    lang: "en",
    ...(policy ? { policy } : {}),
    orderLine: null,
    bookingLine: null,
  });
  const window = (days: number): Omit<ReturnPolicyInput, "id" | "name"> => ({ ...WINDOW_30, window_days: days });
  /** An order through the confirm step, accepted, paid and delivered the day after: what was said of returns. */
  async function delivered(s: Setup, c: Country, productId: string, price: number) {
    const o = await confirmedOrder(s, c, productId);
    await transitionItem(s.db, owner, { itemId: o.id, event: "accept" });
    await s.drain();
    const accepted = (await customerMail(s.db, o.id)).find((m) => m.template === "order.accepted");
    if (!accepted) throw new Error("expected the confirmation");
    await transitionItem(s.db, shop, {
      itemId: o.id,
      event: "record_payment",
      input: { paymentRef: `pi_${o.id}`, amount: s.money(price) },
    });
    clock.now = T0 + DAY;
    await transitionItem(s.db, owner, { itemId: o.id, event: "fulfil", input: { deliveredAt: iso(T0 + DAY) } });
    return { ...o, accepted: accepted.bodyText };
  }
  /** The customer's change of mind `days` after delivery, and the owner's AI approving it. */
  async function aiApproves(s: Setup, o: { id: string; token: string }, days: number) {
    clock.now = T0 + DAY + days * DAY;
    const r = await s.caps.customer.requestReturn(anon(o.token), {
      item_id: o.id,
      access_token: o.token,
      reason: "changed_mind",
    });
    expect(r.linked?.item).toMatchObject({ state: "requested", payload: { kind: "policy" } });
    try {
      await transitionItem(s.db, ai, { itemId: r.linked?.item.id as string, event: "approve" });
      return "approved";
    } catch (e) {
      if (!(e instanceof WriteError)) throw e;
      expect(e.details).toMatchObject({ guard: "return_outside_policy", draft_for_owner: true });
      return e.message;
    }
  }

  it("a dish that does not keep is told it cannot be returned, whatever the policy, as in the EU", async () => {
    for (const c of [elsewhere("MX", WINDOW_30), CASES.find((x) => x.country === "DE") as Country]) {
      const s = await setup(c);
      const pizza = ulid();
      await s.db.orm.insert(products).values({
        id: pizza,
        sku: "PZ-1",
        name: "Pizza al pastor",
        price: s.money(18900),
        withdrawal: "perishable",
        active: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const o = await delivered(s, c, pizza, 18900);
      for (const told of [o.summary, o.accepted]) {
        expect(told, c.country).toContain("This cannot be returned: it does not keep.");
        expect(told).not.toMatch(/return policy|within 30 days|within 14 days/);
      }
      if (c.country === "MX")
        expect(await aiApproves(s, o, 2)).toBe(
          "This return is outside the owner's return policy, so a person decides. Tell the owner in a note (reply with internal: true) what you would do.",
        );
    }
  });

  it("with no policy written, nothing is told, and the owner's AI approves nothing", async () => {
    const c = elsewhere("JP");
    const s = await setup(c);
    const o = await delivered(s, c, s.chain, 1850);
    for (const told of [o.summary, o.accepted]) expect(told).not.toMatch(ANY_RETURN_LINE);
    expect(await aiApproves(s, o, 2)).toMatch(
      /^No return policy the customer was told of takes this back, so a person decides\./,
    );
  });

  it("with no returns, nothing is told, and the owner's AI approves nothing", async () => {
    const c = elsewhere("MX", CASES.find((x) => x.country === "MX")?.policy);
    const s = await setup(c);
    const o = await delivered(s, c, s.chain, 1850);
    for (const told of [o.summary, o.accepted]) expect(told).not.toMatch(ANY_RETURN_LINE);
    expect(await aiApproves(s, o, 2)).toMatch(/^No return policy the customer was told of takes this back/);
  });

  it("with seven days, seven are told and the AI approves only inside them; with thirty, past the law's fourteen", async () => {
    const seven = elsewhere("JP", window(7));
    const s = await setup(seven);
    const early = await delivered(s, seven, s.chain, 1850);
    for (const told of [early.summary, early.accepted])
      expect(told).toContain("Under our return policy, you can return it within 7 days of receiving it.");
    clock.now = T0;
    const late = await delivered(s, seven, s.chain, 1850);
    expect(await aiApproves(s, early, 3)).toBe("approved");
    expect(await aiApproves(s, late, 10)).toMatch(/^This return is outside the owner's return policy/);

    const thirty = elsewhere("JP", window(30));
    const t = await setup(thirty);
    const o = await delivered(t, thirty, t.chain, 1850);
    expect(o.summary).toContain("Under our return policy, you can return it within 30 days of receiving it.");
    expect(await aiApproves(t, o, 20)).toBe("approved");
  });
});

describe("a withdraw link that could no longer withdraw", () => {
  it("passes the message to a person, and its page then says so, not that a copy was emailed", async () => {
    const member = CASES.find((c) => c.country === "DE") as Country;
    const s = await setup(member);
    const b = await askedBooking(s, member);
    await transitionItem(s.db, owner, { itemId: b.id, event: "confirm" });
    await transitionItem(s.db, shop, {
      itemId: b.id,
      event: "record_payment",
      input: { paymentRef: "pi_b", amount: s.money(4500) },
    });
    await s.drain();
    const [row0] = await s.db.orm.select().from(items).where(eq(items.id, b.id));
    if (!row0) throw new Error("expected the booking");
    const links = await linksForEmail(s.db, s.caps.secrets, rowToItem(row0), {
      mailKey: "test:paid",
      lang: "en",
      base: BASE,
      now: clock.now,
      withdraw: { until: null },
    });
    const token = String(links?.get("withdraw")).split("/c/")[1] as string;
    // The booking has begun: there is nothing to withdraw from online any more.
    clock.now = T0 + 21 * DAY;
    const page = await s.caps.customer.linkView(token, { now: clock.now });
    expect(page.paragraphs).toContain("You can still send it: a person on our team will answer.");
    const emails = (await customerMail(s.db, b.id)).length;
    const sent = await s.caps.customer.linkAct(token, page.form?.hidden ?? {}, { now: clock.now });
    if (!("page" in sent)) throw new Error("expected a page");
    expect(sent.page.heading).toMatch(/^We have passed your message to a person on our team, who will reply soon\./);
    const done = await s.caps.customer.linkView(token, { now: clock.now });
    expect(done.heading).toMatch(/^Your message was sent on .*: a person on our team will answer\.$/);
    expect(done.heading).not.toMatch(/emailed you a copy/);
    await s.drain();
    expect((await customerMail(s.db, b.id)).length).toBe(emails);
  });
});
