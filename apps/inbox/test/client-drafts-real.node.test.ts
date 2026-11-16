import { logMailOut, runMigrations } from "@surfingdog/platform";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../../../packages/core/src/capabilities/service";
import { orderLinesText } from "../../../packages/core/src/customer/describe";
import { createDb } from "../../../packages/core/src/db";
import { ulid } from "../../../packages/core/src/ids";
import { createRunner } from "../../../packages/core/src/jobs/index";
import { menuFieldsSchema } from "../../../packages/core/src/menu/schema";
import { MIGRATIONS } from "../../../packages/core/src/schema/migrations.generated";
import type { Caller } from "../../../packages/core/src/write/caller";
import { confirming, makeClient, resetTables } from "../../../packages/core/test/harness";
import { clock, contact, guest, kijaniHouse, owner, payPlatform } from "../../../packages/core/test/stay-fixtures";
import { DraftCard as PhoneDraftCard } from "../../mobile/src/screens/Item";
import { DraftCard } from "../client/src/components/Draft";
import { type DraftView, draftDetails, termsLine } from "../client/src/lib/drafts";
import { formatMoney } from "../client/src/lib/format";

/**
 * A draft's card, for drafts the inbox really makes (ADR-028 Amendment 5): "Send as it is" sends what
 * the card says, so the card says every term the customer reads. A stay's quote from the rates, drafted
 * by the stays preset's rule, then sent; and an order change the owner's AI drafted with menu choices
 * and a half portion, then sent. Both on the owner app's card (Draft.tsx) and the phone's (Item.tsx).
 */
const html = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#x27;");

function cards(draft: DraftView, tz: string): string[] {
  const web = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(DraftCard, { itemId: "i", draft, tz, onDone: () => undefined }),
    ) as ReactElement,
  );
  const phone = renderToStaticMarkup(
    createElement(PhoneDraftCard, { draft, tz, busy: false, onSend: () => undefined, onDrop: () => undefined }),
  );
  return [web, phone];
}

describe("a stay's draft from the rates", () => {
  it("says the rate plan, what it includes, the cancellation and the card, as the guest is sent them", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const made = await k.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-14",
      rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    const runner = createRunner({ mailOut: logMailOut(() => {}) });
    for (let i = 0; i < 30; i++) if ((await runner.runDue(k.db, { now: clock.now, limit: 100 })).claimed === 0) break;
    const draft = (await k.caps.getItem(owner, { item_id: id })).draft as DraftView | null;
    if (!draft) throw new Error("the rule made no draft");
    const tz = "Africa/Nairobi";
    const details = draftDetails(draft.terms, tz, draft.created_at);
    // The quote is worked out again as it goes, so it holds a day from then, as the card says.
    expect(details).toContain("They can accept it for up to a day once it is sent");
    clock.now += 3 * 3_600_000;
    // What goes when it is sent: the quote the guest gets.
    const sent = await k.caps.sendOfferDraft(owner, { item_id: id });
    const q = (
      sent.view.item.payload as unknown as {
        quote: {
          total: { value: number; currency: string };
          lines: { label: string; amount: number }[];
          ratePlan: { name: string; refundable: boolean };
          policy: { after: { value: number; currency: string }; noShow: { value: number; currency: string } };
          guarantee: string;
          includes: string[];
          validThrough: string;
        };
      }
    ).quote;
    expect(Date.parse(q.validThrough)).toBe(clock.now + 24 * 3_600_000);
    expect(q.ratePlan).toMatchObject({ name: "Bed and breakfast", refundable: true });
    expect(q.includes).toEqual(["Breakfast for 2"]);
    expect(q.guarantee).toBe("none");
    expect(q.policy.after).toEqual({ value: 650_000, currency: "KES" });
    const line = termsLine(draft.terms, tz);
    for (const l of q.lines)
      expect(line).toContain(`${l.label} — ${formatMoney({ value: l.amount, currency: q.total.currency })}`);
    expect(line).toContain(`${formatMoney(q.total)} in all`);
    expect(details).toEqual(
      expect.arrayContaining([
        "Bed and breakfast, refundable",
        "Includes: Breakfast for 2",
        "No card needed to hold it",
      ]),
    );
    // The cancellation as the guest is sent it: free until the first step's time where the property is
    // (23:59 on 10 December in Nairobi), then the first night, and the first night for a no-show.
    const cancel = details.find((d) => d.startsWith("Free cancellation until "));
    expect(cancel).toMatch(/10/);
    expect(cancel).toMatch(/Dec/);
    expect(cancel).toContain("23:59");
    expect(
      cancel?.endsWith(`; after that ${formatMoney(q.policy.after)}; no-show ${formatMoney(q.policy.noShow)}`),
    ).toBe(true);
    for (const card of cards(draft, tz)) for (const w of [line, ...details]) expect(card).toContain(html(w));
  });

  it("says a card holds it, and no more, when part of it is paid now", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    await payPlatform(k.db, { cards: true });
    await k.caps.stays.upsertRatePlan(owner, {
      id: k.plans.bnb,
      name: "Bed and breakfast, pay ahead",
      meal: "breakfast",
      policy: { preset: "non_refundable" },
      deposit: { kind: "percent", value: 30 },
      balance: { when: "days_before", days: 7 },
      guarantee: "card",
    });
    await k.caps.setup.applyPreset(owner, { preset: "stays", replace: false });
    const made = await k.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-14",
      rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
      contact,
      consent: true,
    });
    const runner = createRunner({ mailOut: logMailOut(() => {}) });
    for (let i = 0; i < 30; i++) if ((await runner.runDue(k.db, { now: clock.now, limit: 100 })).claimed === 0) break;
    const draft = (await k.caps.getItem(owner, { item_id: made.view.item.id })).draft as DraftView | null;
    if (!draft) throw new Error("the rule made no draft");
    const tz = "Africa/Nairobi";
    const details = draftDetails(draft.terms, tz, draft.created_at);
    const now = `Paid ${formatMoney({ value: 390_000, currency: "KES" })} now, `;
    expect(details.find((d) => d.startsWith("Paid "))?.startsWith(now)).toBe(true);
    expect(details).toContain("A card holds the booking");
    for (const card of cards(draft, tz)) {
      expect(card).toContain(html("A card holds the booking"));
      expect(card).not.toContain("nothing is charged now");
    }
  });
});

/** Pizzería Volcán (Mexico City, MXN), as the food tests keep it: a pizza with sizes, doughs and extras by the half. */
const T = Date.parse("2026-11-04T17:00:00Z");
const MXN = (value: number) => ({ value, currency: "MXN" });
const person: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
};
const assistant: Caller = {
  actor: { kind: "owner_ai", id: "app1", channel: "mcp_owner" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T,
  principal: { via: "oauth", id: "app1", name: "An assistant", scopes: ["*"], userId: "u1" },
};
const customer: Caller = {
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "mcp_public" },
  tier: "anonymous",
  sandbox: false,
  now: () => T,
};
const PIZZA = menuFieldsSchema.parse({
  section: "pizzas",
  optionGroups: [
    {
      id: "size",
      name: "Tamaño",
      min: 1,
      max: 1,
      choices: [
        { id: "chica", name: "Chica", default: true },
        { id: "grande", name: "Grande (36 cm)", priceDelta: 6000, opens: "masa" },
      ],
    },
    {
      id: "masa",
      name: "Masa",
      min: 1,
      max: 1,
      choices: [
        { id: "delgada", name: "Delgada" },
        { id: "gruesa", name: "Gruesa" },
      ],
    },
    {
      id: "extras",
      name: "Extras",
      min: 0,
      max: 4,
      halves: true,
      choices: [{ id: "pina", name: "Piña", priceDelta: 1500, halfDelta: 900 }],
    },
  ],
});

async function volcan() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const caps = confirming(new Capabilities(db));
  await db.client.query({
    sql: "INSERT OR REPLACE INTO business (id, name, timezone, currency, languages, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?)",
    params: ["Pizzería Volcán", "America/Mexico_City", "MXN", JSON.stringify(["es"]), T, T],
    method: "run",
  });
  await caps.updateSettings(person, {
    doc: {
      business: {
        name: "Pizzería Volcán",
        currency: "MXN",
        timezone: "America/Mexico_City",
        languages: ["es"],
      },
      kitchen: { enabled: true, prepMin: 20, slotMin: 15, perSlot: 4, accept: "caps" },
    },
  });
  const day = [["10:00", "22:00"]];
  await db.client.query({
    sql: "INSERT INTO availability_rules (id, service_id, kind, weekly, created_at) VALUES (?, NULL, 'open', ?, ?)",
    params: [ulid(), JSON.stringify({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }), T],
    method: "run",
  });
  const row = await caps.setup.createProduct(person, { name: "Pizza al pastor", price: MXN(18_900), active: true });
  const item = await caps.food.setMenuItem(person, { product_id: row.id, menu: PIZZA });
  await caps.food.confirmAllergens(person, { product_id: row.id, fingerprint: item.fingerprint as string });
  return { db, caps, product: row.id };
}

describe("an order change the owner's AI drafted, with menu choices and a half", () => {
  it("names each choice as the customer reads it, on the owner app's card and the phone's", async () => {
    const s = await volcan();
    const slots = await s.caps.food.listOrderSlots({ date: "2026-11-04", method: "pickup" }, T, "en");
    const slot = slots.slots[0]?.start;
    if (!slot) throw new Error(`no slot: ${slots.words}`);
    const made = await s.caps.createOrder(customer, {
      payload: {
        orderedItem: [
          {
            productId: s.product,
            quantity: 1,
            options: [
              { groupId: "size", choiceId: "grande" },
              { groupId: "masa", choiceId: "gruesa" },
              { groupId: "extras", choiceId: "pina", portion: "left" },
            ],
          },
        ],
        fulfil: { method: "pickup", slot: { start: slot } },
      },
      contact: { name: "A customer", email: "c1@example.com" },
    } as never);
    const id = made.view.item.id;
    await s.caps.transitionItem(person, { item_id: id, event: "accept" });
    // The owner's AI asks the customer for a later time, the lines as they are: a change to what was
    // agreed, which the owner did not let it ask for, so a draft (`change_not_allowed`).
    const drafted = await s.caps.transitionItem(assistant, {
      item_id: id,
      event: "propose_change",
      input: { delivery: { method: "pickup", when: new Date(Date.parse(slot) + 3_600_000).toISOString() } },
    });
    expect(drafted.drafted?.breaches).toContain("change_not_allowed");
    const draft = (await s.caps.getItem(person, { item_id: id })).draft as DraftView | null;
    if (!draft) throw new Error("no draft");
    const tz = "America/Mexico_City";
    const card = termsLine(draft.terms, tz);
    // Sent as it is: what the customer reads of its lines.
    const sent = await s.caps.sendOfferDraft(person, { item_id: id });
    const change = (sent.view.item.payload as { change: { orderedItem: Parameters<typeof orderLinesText>[0] } }).change;
    const reads = orderLinesText(change.orderedItem, "en");
    expect(reads).toContain("Grande (36 cm), Gruesa, ½ Piña");
    expect(card.split(" · ")[0]).toBe(reads);
    expect(card).not.toContain("grande");
    for (const html of cards(draft, tz)) expect(html).toContain(reads.replaceAll("&", "&amp;"));
  });
});
