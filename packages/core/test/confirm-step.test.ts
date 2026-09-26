import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { offerRows } from "../src/negotiation/offers";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { business, idempotencyKeys, items, products, services } from "../src/schema/tables";
import { type Caller, WriteError, withIdempotencyKey } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * The confirm step (ADR-018 §5; CRD art. 8(2)): a consumer's booking or order that carries a price
 * binds them only once they confirmed its summary — what, when, from whom, the total, the right of
 * withdrawal or why there is none, and that confirming means paying. Asked without the fingerprint of
 * that summary, nothing is written and the answer is the summary; sent with it, the request is theirs
 * and binds them. A business selling only to businesses, a request with no price of ours yet, or a free
 * one, goes through as before. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = 86_400_000;
const EUR = (value: number) => ({ value, currency: "EUR" });
const iso = (ms: number) => new Date(ms).toISOString();
const owner: Caller = {
  actor: { kind: "owner", id: "owner_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const agent = (key?: string): Caller => {
  const c: Caller = {
    actor: { kind: "customer_agent", id: "agent:test", channel: "rest" },
    tier: "anonymous",
    sandbox: false,
    now: () => T0,
  };
  return key ? withIdempotencyKey(c, key) : c;
};

async function setup(doc: Record<string, unknown> = {}) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.orm.insert(business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: T0,
    updatedAt: T0,
  });
  const svc = ulid();
  const free = ulid();
  await db.orm.insert(services).values([
    {
      id: svc,
      name: "Full service",
      durationMin: 90,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      createdAt: T0,
      updatedAt: T0,
    },
    { id: free, name: "Check-up", durationMin: 30, price: { model: "fixed", value: 0 }, createdAt: T0, updatedAt: T0 },
  ]);
  const chain = ulid();
  const cheese = ulid();
  await db.orm.insert(products).values([
    { id: chain, sku: "CH-9", name: "Chain", price: EUR(1850), createdAt: T0, updatedAt: T0 },
    {
      id: cheese,
      sku: "QJ-1",
      name: "Fresh cheese",
      price: EUR(900),
      withdrawal: "perishable",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  const caps = new Capabilities(db);
  await caps.updateSettings(owner, {
    doc: {
      business: { name: "Oficina Maré" },
      commerce: { legal: { legalName: "Oficina Maré Lda", address: "Rua do Mar 1, Lisboa" } },
      ...doc,
    },
  });
  return { db, caps, svc, free, chain, cheese };
}

const bookingOf = (svc: string, start = T0 + 20 * DAY) => ({
  reservationFor: { serviceId: svc, name: "Full service" },
  startTime: iso(start),
  endTime: iso(start + 90 * 60_000),
});

async function refused(p: Promise<unknown>): Promise<WriteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

describe("the confirm step before a priced request binds", () => {
  it("writes nothing without it, and answers with the summary to show the customer", async () => {
    const s = await setup();
    const e = await refused(
      s.caps.createBooking(agent("b-1"), { payload: bookingOf(s.svc), contact: { email: "rita@example.com" } }),
    );
    expect(e.code).toBe("confirm_terms");
    expect(e.status).toBe(409);
    const d = e.details as { summary: string; terms_sha: string; obligation_to_pay: boolean };
    expect(d.obligation_to_pay).toBe(true);
    expect(d.terms_sha).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.summary).toBe(
      `Please check before you confirm: "Full service" on Sunday, 11 October 2026 at 11:00 (Western European Time). Total €45.00. From Oficina Maré Lda, Rua do Mar 1, Lisboa. You can withdraw within 14 days of booking, without giving a reason. Confirming means an obligation to pay €45.00.`,
    );
    expect(e.message).toBe(
      `Before this binds your customer, show them: ${d.summary} Accept only on their clear yes, with terms_sha ${d.terms_sha}.`,
    );
    // Nothing: no item, and no answer kept under the key, so the confirmed request is a first one.
    expect(await s.db.orm.select().from(items)).toHaveLength(0);
    expect(await s.db.orm.select().from(idempotencyKeys)).toHaveLength(0);

    const made = await s.caps.createBooking(agent("b-1"), {
      payload: bookingOf(s.svc),
      contact: { email: "rita@example.com" },
      terms_sha: d.terms_sha,
    });
    expect(made.replayed).toBe(false);
    expect(made.view.item.payload).toMatchObject({ totalPrice: EUR(4500) });
    // Confirmed, the request binds the customer as their offer.
    const [request] = await offerRows(s.db, made.view.item.id);
    expect(request).toMatchObject({ by: "customer", binding: true, termsSha: d.terms_sha });
    // A retry under the same key, with or without the fingerprint, is the same request.
    const again = await s.caps.createBooking(agent("b-1"), {
      payload: bookingOf(s.svc),
      contact: { email: "rita@example.com" },
    });
    expect(again.replayed).toBe(true);
    expect(again.view.item.id).toBe(made.view.item.id);
  });

  it("with the fingerprint of other terms, answers with the current ones", async () => {
    const s = await setup();
    const e = await refused(s.caps.createBooking(agent(), { payload: bookingOf(s.svc), terms_sha: "x".repeat(43) }));
    expect(e.code).toBe("confirm_terms");
    expect(e.details).toMatchObject({ changed: true });
  });

  it("names every line, why something cannot be returned, and the total, for an order", async () => {
    const s = await setup();
    const e = await refused(
      s.caps.createOrder(agent(), {
        payload: {
          orderedItem: [
            { productId: s.chain, name: "Chain", quantity: 2, price: EUR(1) },
            { productId: s.cheese, name: "Cheese", quantity: 1, price: EUR(1) },
          ],
          totalPrice: EUR(1),
        },
      }),
    );
    expect((e.details as { summary: string }).summary).toBe(
      "Please check before you confirm: 2 × Chain — €37.00; 1 × Fresh cheese — €9.00. Total €46.00. From Oficina Maré Lda, Rua do Mar 1, Lisboa. This cannot be returned: it does not keep. Confirming means an obligation to pay €46.00.",
    );
  });

  it("asks for a booking that starts within the period to start then", async () => {
    const s = await setup();
    const e = await refused(s.caps.createBooking(agent(), { payload: bookingOf(s.svc, T0 + 3 * DAY) }));
    expect((e.details as { summary: string }).summary).toContain(
      "It starts within that time: by confirming, you ask us to start then.",
    );
  });

  it("speaks the customer's language", async () => {
    const s = await setup();
    const e = await refused(
      s.caps.createBooking(agent(), { payload: bookingOf(s.svc), contact: { email: "a@example.pt", locale: "pt-PT" } }),
    );
    expect((e.details as { summary: string }).summary).toMatch(
      /^Confirme antes de marcar: "Full service" para domingo, 11 de outubro de 2026 às 11:00 .* Total 45,00.€\. De Oficina Maré Lda, Rua do Mar 1, Lisboa\. Pode retratar-se no prazo de 14 dias após a marcação, sem indicar motivo\. Confirmar implica a obrigação de pagar 45,00.€\.$/,
    );
  });

  it("is not asked of a business selling to businesses, of what we have still to price, or of what is free", async () => {
    const b2b = await setup({ commerce: { customers: "businesses" } });
    const booked = await b2b.caps.createBooking(agent(), { payload: bookingOf(b2b.svc) });
    const [request] = await offerRows(b2b.db, booked.view.item.id);
    expect(request?.binding).toBe(false);

    const s = await setup();
    // A line naming nothing of ours: a person prices it first, and the confirm step comes with ours.
    await s.caps.createOrder(agent(), {
      payload: { orderedItem: [{ name: "Custom frame", quantity: 1, price: EUR(20_000) }], totalPrice: EUR(20_000) },
    });
    await s.caps.createBooking(agent(), {
      payload: { ...bookingOf(s.free), reservationFor: { serviceId: s.free, name: "Check-up" } },
    });
    expect(await s.db.orm.select().from(items)).toHaveLength(2);
  });

  it("is the customer's own: the business writing a request down for them is not asked", async () => {
    const s = await setup();
    const r = await s.caps.createBooking(owner, { payload: bookingOf(s.svc) });
    expect(r.view.item.state).toBe("requested");
  });
});
