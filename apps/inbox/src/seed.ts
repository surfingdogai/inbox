import {
  appendThreadEntry,
  type Caller,
  Capabilities,
  type Channel,
  createItem,
  createRunner,
  type Db,
  type JobRunner,
  PRESETS,
  type RuleDefinition,
  schema,
  setFlags,
  transitionItem,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";

/**
 * A demo business so a fresh instance has something to show: Oficina Maré, a bicycle workshop in
 * Ericeira. Idempotent; never touches an instance that already has a business row.
 */
export async function seedDemo(db: Db, now = Date.now()): Promise<{ seeded: boolean }> {
  const [existing] = await db.orm
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  if (existing) return { seeded: false };
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    domain: "oficinamare.pt",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: now,
    updatedAt: now,
  });
  const full = ulid();
  const puncture = ulid();
  await db.orm.insert(schema.services).values([
    {
      id: full,
      name: "Full service",
      description: "Brakes, gears, wheels, bearings, a clean and a test ride.",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      sort: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: puncture,
      name: "Puncture repair",
      description: "Tube or tubeless, while you wait.",
      durationMin: 30,
      capacity: 2,
      granularityMin: 15,
      price: { model: "fixed", value: 1200, currency: "EUR" },
      sort: 2,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.orm.insert(schema.products).values([
    {
      id: ulid(),
      sku: "SM-700-35",
      name: "Schwalbe Marathon 700×35",
      price: { value: 3920, currency: "EUR" },
      stock: 6,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ulid(),
      sku: "CH-9",
      name: "Chain, 9-speed",
      price: { value: 1850, currency: "EUR" },
      stock: 12,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const hours: [string, string][] = [["09:00", "18:00"]];
  await db.orm.insert(schema.availabilityRules).values({
    id: ulid(),
    kind: "open",
    weekly: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: [["09:00", "13:00"]] },
    createdAt: now,
  });
  await db.orm.insert(schema.rules).values(
    (PRESETS.appointments ?? []).map((p) => ({
      id: ulid(),
      name: p.name,
      priority: p.priority,
      enabled: 1,
      definition: p.definition,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const caps = new Capabilities(db);
  const system: Caller = {
    actor: { kind: "system", id: "seed", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
  };
  await caps.updateSettings(system, {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
      booking: { cancellationWindowMin: 120 },
      network: { join: true },
    },
  });
  return { seeded: true };
}

// ---- the showcase --------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "Europe/Lisbon";
const EUR = (value: number) => ({ value, currency: "EUR" });

/**
 * Oficina Maré with a week of life in it, for screenshots and demos: every item type in several
 * states, the appointments rules plus two of the shop's own, services with buffers and capacity,
 * opening hours with Saturday mornings, notifications and network membership on. Everything goes
 * through the real write path with timestamps relative to now, and the rules run as they would
 * have, so timelines say who did what. Idempotent like seedDemo.
 */
export async function seedShowcase(db: Db, now = Date.now()): Promise<{ seeded: boolean; items: number }> {
  const [existing] = await db.orm
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  if (existing) return { seeded: false, items: 0 };
  const t0 = now - 10 * DAY;
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    domain: "oficinamare.pt",
    timezone: TZ,
    currency: "EUR",
    createdAt: t0,
    updatedAt: t0,
  });

  const svc = { full: ulid(), puncture: ulid(), brakes: ulid(), custom: ulid(), truing: ulid() };
  await db.orm.insert(schema.services).values([
    {
      id: svc.full,
      name: "Full service",
      description: "Brakes, gears, wheels, bearings, a clean and a test ride.",
      durationMin: 90,
      bufferAfterMin: 15,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 4500, currency: "EUR" },
      sort: 1,
      createdAt: t0,
      updatedAt: t0,
    },
    {
      id: svc.puncture,
      name: "Puncture repair",
      description: "Tube or tubeless, while you wait.",
      durationMin: 30,
      capacity: 2,
      granularityMin: 15,
      price: { model: "fixed", value: 1200, currency: "EUR" },
      sort: 2,
      createdAt: t0,
      updatedAt: t0,
    },
    {
      id: svc.brakes,
      name: "Brake bleed",
      description: "Hydraulic disc brakes, both wheels, new fluid and pads checked.",
      durationMin: 45,
      bufferBeforeMin: 5,
      bufferAfterMin: 10,
      capacity: 1,
      granularityMin: 15,
      price: { model: "fixed", value: 3500, currency: "EUR" },
      sort: 3,
      createdAt: t0,
      updatedAt: t0,
    },
    {
      id: svc.truing,
      name: "Wheel truing",
      description: "Spoke tension and true, one wheel.",
      durationMin: 40,
      bufferAfterMin: 5,
      capacity: 1,
      granularityMin: 20,
      price: { model: "from", value: 2000, currency: "EUR" },
      sort: 4,
      createdAt: t0,
      updatedAt: t0,
    },
    {
      id: svc.custom,
      name: "Custom build consultation",
      description: "An hour on the bench to spec your build; the price comes as a quote.",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      price: { model: "quote" },
      sort: 5,
      createdAt: t0,
      updatedAt: t0,
    },
  ]);

  await db.orm.insert(schema.products).values(
    [
      ["SM-700-35", "Schwalbe Marathon 700×35", 3920, 6],
      ["CH-9", "Chain, 9-speed", 1850, 12],
      ["BP-SH-RES", "Brake pads, Shimano resin", 1290, 20],
      ["LT-USB-F", "Front light, USB", 3490, 8],
      ["SD-BRK-C", "Saddle, Brooks Cambium", 11900, 2],
    ].map(([sku, name, value, stock]) => ({
      id: ulid(),
      sku: String(sku),
      name: String(name),
      price: EUR(Number(value)),
      stock: Number(stock),
      createdAt: t0,
      updatedAt: t0,
    })),
  );

  const weekday: [string, string][] = [["09:00", "18:00"]];
  await db.orm.insert(schema.availabilityRules).values([
    {
      id: ulid(),
      kind: "open",
      weekly: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [["09:00", "13:00"]] },
      createdAt: t0,
    },
    {
      id: ulid(),
      kind: "open",
      serviceId: svc.puncture,
      weekly: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [["09:00", "14:00"]] },
      createdAt: t0,
    },
  ]);

  const custom: { name: string; priority: number; definition: RuleDefinition }[] = [
    {
      name: "Orders over €200 need your approval",
      priority: 90,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "order" },
            { path: "item.payload.totalPrice.value", op: "gt", value: 20_000 },
          ],
        },
        actions: [{ action: "set_flags", needsHuman: true, priority: 2 }],
        stop: true,
        maxRunsPerItem: 1,
      },
    },
    {
      name: "Answer new messages from people with the opening hours",
      priority: 50,
      definition: {
        on: ["item.created"],
        if: {
          all: [
            { path: "item.type", op: "eq", value: "message" },
            { path: "event.actorKind", op: "neq", value: "customer_agent" },
            { not: { fn: "text_has_keywords", args: { keywords: ["unsubscribe", "seo", "special offer"] } } },
          ],
        },
        actions: [
          {
            action: "reply",
            template:
              "Thanks for writing to Oficina Maré. We answer within a working day. The workshop is open Monday to Friday 9–18 and Saturday 9–13.",
            internal: false,
          },
        ],
        stop: false,
        maxRunsPerItem: 1,
      },
    },
  ];
  await db.orm.insert(schema.rules).values(
    [...(PRESETS.appointments ?? []), ...custom].map((p) => ({
      id: ulid(),
      name: p.name,
      priority: p.priority,
      enabled: 1,
      definition: p.definition,
      createdAt: t0,
      updatedAt: t0,
    })),
  );

  const caps = new Capabilities(db);
  const system: Caller = {
    actor: { kind: "system", id: "seed", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
    now: () => t0,
  };
  await caps.updateSettings(system, {
    doc: {
      business: { name: "Oficina Maré", timezone: TZ, currency: "EUR", languages: ["pt", "en"] },
      booking: { cancellationWindowMin: 120, holdOnPropose: true, autoExpireHours: 48 },
      orders: { maxValueWithoutApprovalMinor: 20_000 },
      notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: "https://inbox.oficinamare.pt" },
      email: { fromAddress: "inbox@oficinamare.pt", fromName: "Oficina Maré", replyTo: "hello@oficinamare.pt" },
      network: { join: true },
    },
  });

  // ---- the items, oldest first, each followed by the jobs it caused (rules, notifications) ----
  const runner = createRunner({ mailOut: logMailOut() });
  const owner = (t: number): Caller => ({
    actor: { kind: "owner", id: "owner", channel: "owner_ui" },
    tier: "verified_principal",
    sandbox: false,
    now: () => t,
  });
  const person = (t: number, channel: Channel = "form", partyId?: string): Caller => ({
    actor: { kind: "customer_human", id: `anon:${partyId ?? ulid()}`, channel, ...(partyId ? { partyId } : {}) },
    tier: "anonymous",
    sandbox: false,
    now: () => t,
  });
  const agent = (t: number, partyId?: string): Caller => ({
    actor: { kind: "customer_agent", id: "agent:claude", channel: "mcp_public", ...(partyId ? { partyId } : {}) },
    tier: "signed_agent",
    sandbox: false,
    now: () => t,
  });
  const settle = (t: number) => drain(runner, db, t);
  /** The preset flags every new item for a person; once the owner has acted, the flag comes off. */
  const handled = (t: number, itemId: string) =>
    setFlags(db, owner(t), { itemId, flags: { needsHuman: false }, reason: "no longer needs you" });
  let count = 0;

  // 1. A completed booking, last week: the Done list.
  {
    const start = localTime(now, TZ, -7, 10, 0);
    const r = await createItem(db, person(now - 8 * DAY), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc.brakes, name: "Brake bleed" },
        startTime: iso(start),
        endTime: iso(start + 45 * MIN),
        totalPrice: EUR(3500),
      },
      contact: { name: "Helena Duarte", email: "helena.duarte@example.com" },
      message: "Rear brake lever goes to the bar. Both wheels if you can.",
    });
    await settle(now - 8 * DAY);
    await confirmIfNeeded(db, owner(now - 8 * DAY + 20 * MIN), r.view.item.id);
    await transitionItem(db, owner(now - 7 * DAY + 90 * MIN), { itemId: r.view.item.id, event: "complete" });
    await settle(now - 7 * DAY + 90 * MIN);
    count++;
  }

  // 2. An order that went all the way, then a refund the owner has approved and not yet paid.
  {
    const t = now - 6 * DAY;
    const r = await createItem(db, person(t, "form"), {
      type: "order",
      payload: {
        orderedItem: [{ sku: "LT-USB-F", name: "Front light, USB", quantity: 1, price: EUR(3490) }],
        totalPrice: EUR(3490),
        delivery: { method: "pickup" },
        paymentMethod: "card",
      },
      contact: { name: "Miguel Sousa", email: "miguel.sousa@example.com" },
    });
    await settle(t);
    const id = r.view.item.id;
    await transitionItem(db, owner(t + HOUR), { itemId: id, event: "accept" });
    await transitionItem(db, owner(t + 2 * HOUR), {
      itemId: id,
      event: "record_payment",
      input: { paymentRef: "MBW-20388" },
    });
    await transitionItem(db, owner(t + DAY), { itemId: id, event: "fulfil" });
    await transitionItem(db, owner(t + DAY + 10 * MIN), { itemId: id, event: "complete" });
    await settle(t + DAY + 10 * MIN);
    const refund = await createItem(db, person(now - DAY - 2 * HOUR, "email", r.view.item.partyId), {
      type: "refund",
      payload: {
        orderItemId: id,
        amount: EUR(3490),
        reason: "The light will not charge past two bars; bringing it back.",
      },
      contact: { name: "Miguel Sousa", email: "miguel.sousa@example.com" },
    });
    await settle(now - DAY - 2 * HOUR);
    await transitionItem(db, owner(now - 3 * HOUR), { itemId: refund.view.item.id, event: "approve" });
    await handled(now - 3 * HOUR, refund.view.item.id);
    await settle(now - 3 * HOUR);
    count += 2;
  }

  // 3. A quote the owner declined: also Done.
  {
    const t = now - 3 * DAY;
    const r = await createItem(db, person(t), {
      type: "quote_request",
      payload: {
        itemOffered: { name: "Carbon frame crack repair" },
        description: "Hairline crack on the down tube of a 2019 carbon road frame, near the bottle cage bolt.",
      },
      contact: { name: "Nuno Carvalho", email: "nuno.carvalho@example.com" },
    });
    await settle(t);
    await transitionItem(db, owner(t + HOUR), {
      itemId: r.view.item.id,
      event: "decline",
      input: { note: "We do not repair carbon frames; a specialist like Carbon Lab in Porto can help." },
    });
    await settle(t + HOUR);
    count++;
  }

  // 4. A quote the customer accepted, which became an order waiting for you.
  {
    const t = now - 5 * DAY;
    const r = await createItem(db, person(t), {
      type: "quote_request",
      payload: {
        itemOffered: { name: "Wheel rebuild, DT Swiss 350" },
        description: "Rear wheel rebuild on a DT Swiss 350 hub, 28 spokes, for a gravel bike. Current rim is cracked.",
        budget: EUR(35000),
      },
      contact: { name: "Pedro Silva", email: "pedro.silva@example.com" },
      message: "Happy to bring the wheel in this week for you to look at.",
    });
    await settle(t);
    const id = r.view.item.id;
    await transitionItem(db, owner(t + DAY), {
      itemId: id,
      event: "quote",
      input: {
        totalPrice: EUR(31000),
        validThrough: iso(now + 10 * DAY),
        lines: [
          { name: "DT Swiss R 470 rim", quantity: 1, price: EUR(9500) },
          { name: "Sapim Race spokes and nipples", quantity: 28, price: EUR(250) },
          { name: "Build and true", quantity: 1, price: EUR(14500) },
        ],
        notes: "Two to three days once the rim arrives.",
        creates: "order",
      },
    });
    await settle(t + DAY);
    await transitionItem(db, person(t + 2 * DAY, "form", r.view.item.partyId), { itemId: id, event: "accept" });
    await settle(t + 2 * DAY);
    count += 2;
  }

  // 5. A quote request with your quote sent, waiting for the customer.
  {
    const t = now - 2 * DAY;
    const r = await createItem(db, person(t), {
      type: "quote_request",
      payload: {
        itemOffered: { name: "Custom gravel build, Shimano GRX", serviceId: svc.custom },
        description:
          "Full custom gravel build around a titanium frame: GRX 2×12, tubeless 700×45, dynamo front hub. Budget flexible for the right wheels.",
        budget: EUR(350000),
      },
      contact: { name: "Mariana Lopes", email: "mariana.lopes@example.com" },
      message: "I ride mostly forest tracks. Happy to come by the shop to talk it through.",
    });
    await settle(t);
    await transitionItem(db, owner(now - DAY), {
      itemId: r.view.item.id,
      event: "quote",
      input: {
        totalPrice: EUR(324000),
        validThrough: iso(now + 14 * DAY),
        lines: [
          { name: "Shimano GRX RX820 2×12 groupset", quantity: 1, price: EUR(115000) },
          { name: "Hunt 4 Season gravel wheelset, SON dynamo front", quantity: 1, price: EUR(98000) },
          { name: "Finishing kit, bars, stem, post, saddle, tyres", quantity: 1, price: EUR(61000) },
          { name: "Build, cabling, bleed, fit", quantity: 1, price: EUR(50000) },
        ],
        notes: "Frame not included. Three weeks from deposit; dynamo wiring hidden in the fork.",
        creates: "order",
      },
    });
    await handled(now - DAY, r.view.item.id);
    await appendThreadEntry(
      db,
      owner(now - 23 * HOUR),
      r.view.item,
      "Hunt wheels are three weeks out; if she wants sooner, offer the DT Swiss GR 1600 at the same price.",
      "note",
    );
    await settle(now - DAY);
    count++;
  }

  // 6. A confirmed booking for tomorrow at 10:00: the one the screenshots open.
  const tomorrow10 = localTime(now, TZ, 1, 10, 0);
  {
    const t = now - 26 * HOUR;
    const r = await createItem(db, person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc.full, name: "Full service" },
        startTime: iso(tomorrow10),
        endTime: iso(tomorrow10 + 90 * MIN),
        totalPrice: EUR(4500),
        notes: "City bike, 2021.",
      },
      contact: { name: "Rita Amaral", email: "rita.amaral@example.com" },
      message: "Brakes squeak at low speed. Please check the rear wheel, it wobbles a little.",
    });
    await settle(t);
    await confirmIfNeeded(db, owner(t + 25 * MIN), r.view.item.id);
    count++;
  }

  // 7. A booking that was confirmed and then cancelled by the customer.
  {
    const start = localTime(now, TZ, 2, 11, 0);
    const t = now - 2 * DAY;
    const r = await createItem(db, person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc.puncture, name: "Puncture repair" },
        startTime: iso(start),
        endTime: iso(start + 30 * MIN),
        totalPrice: EUR(1200),
      },
      contact: { name: "Carla Mendes", email: "carla.mendes@example.com" },
    });
    await settle(t);
    await confirmIfNeeded(db, owner(t + 30 * MIN), r.view.item.id);
    await transitionItem(db, person(now - DAY, "form", r.view.item.partyId), {
      itemId: r.view.item.id,
      event: "cancel",
      input: { note: "Found a shop nearer home, sorry about that." },
    });
    await settle(now - DAY);
    count++;
  }

  // 8. A message from a person, answered.
  {
    const t = now - DAY;
    const r = await createItem(db, person(t), {
      type: "message",
      payload: {
        subject: "Do you fix e-bike batteries?",
        text: "Hi, my Bosch PowerTube only charges to about 60%. Is that something you can look at, and roughly what does it cost?",
      },
      contact: { name: "Tomás Pereira", email: "tomas.pereira@example.com" },
    });
    await settle(t);
    await caps.reply(owner(now - 23 * HOUR), {
      item_id: r.view.item.id,
      body: "Yes: Bosch and Shimano packs. Bring it in any weekday; the diagnosis takes twenty minutes and costs €25, taken off the repair if there is one.",
      internal: false,
    });
    await handled(now - 23 * HOUR, r.view.item.id);
    await settle(now - 23 * HOUR);
    count++;
  }

  // 9. Spam by email, marked as such.
  {
    const t = now - 5 * HOUR;
    const r = await createItem(db, person(t, "email"), {
      type: "message",
      payload: {
        subject: "Rank #1 on Google: special offer for bike shops",
        text: "Our SEO team can put oficinamare.pt on the first page in 30 days. Reply now for 50% off. Unsubscribe: link.",
      },
      contact: { name: "SEO Growth Partners", email: "deals@seo-growth.example" },
    });
    await settle(t);
    await transitionItem(db, owner(now - 4 * HOUR), { itemId: r.view.item.id, event: "mark_spam" });
    await settle(now - 4 * HOUR);
    count++;
  }

  // 10. An order placed by an agent, accepted and paid.
  {
    const t = now - 8 * HOUR;
    const r = await createItem(db, agent(t), {
      type: "order",
      payload: {
        orderedItem: [{ sku: "SM-700-35", name: "Schwalbe Marathon 700×35", quantity: 2, price: EUR(3920) }],
        totalPrice: EUR(7840),
        delivery: { method: "pickup", when: iso(localTime(now, TZ, 1, 17, 0)) },
        paymentMethod: "mbway",
      },
      contact: { name: "Luís Costa", email: "luis.costa@example.com" },
      message: "Luís asked for the tyres to be fitted while he waits, if that is possible tomorrow at five.",
    });
    await settle(t);
    await transitionItem(db, owner(now - 7 * HOUR), { itemId: r.view.item.id, event: "accept" });
    await transitionItem(db, owner(now - 6 * HOUR), {
      itemId: r.view.item.id,
      event: "record_payment",
      input: { paymentRef: "MBW-20419", amount: EUR(7840) },
    });
    await handled(now - 6 * HOUR, r.view.item.id);
    await settle(now - 6 * HOUR);
    count++;
  }

  // 11. A booking request that needs you: outside opening hours, so no rule could confirm it.
  {
    const start = localTime(now, TZ, 2, 18, 30);
    const t = now - 2 * HOUR;
    await createItem(db, agent(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc.puncture, name: "Puncture repair" },
        startTime: iso(start),
        endTime: iso(start + 30 * MIN),
        totalPrice: EUR(1200),
        notes: "Tubeless, rear wheel.",
      },
      contact: { name: "Ana Ferreira", email: "ana.ferreira@example.com" },
      message: "Ana can only come after work; is half past six possible, even if you normally close at six?",
    });
    await settle(t);
    count++;
  }

  // 12. An order over the approval limit, flagged by your own rule.
  {
    const t = now - 90 * MIN;
    await createItem(db, agent(t), {
      type: "order",
      payload: {
        orderedItem: [
          { sku: "SD-BRK-C", name: "Saddle, Brooks Cambium", quantity: 1, price: EUR(11900) },
          { name: "Thule Yepp child seat and rack", quantity: 1, price: EUR(26600) },
        ],
        totalPrice: EUR(38500),
        delivery: { method: "delivery" },
        shippingAddress: {
          streetAddress: "Rua da Praia 14",
          postalCode: "2655-320",
          addressLocality: "Ericeira",
          addressCountry: "PT",
        },
        paymentMethod: "card",
      },
      contact: { name: "Sofia Rodrigues", email: "sofia.rodrigues@example.com" },
    });
    await settle(t);
    count++;
  }

  // 13. A booking that clashed with Rita's slot: you proposed another time.
  {
    const t = now - 3 * HOUR;
    const r = await createItem(db, person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc.full, name: "Full service" },
        startTime: iso(tomorrow10),
        endTime: iso(tomorrow10 + 90 * MIN),
        totalPrice: EUR(4500),
      },
      contact: { name: "João Martins", email: "joao.martins@example.com" },
      message: "Gears skip under load on the small cog.",
    });
    await settle(t);
    await transitionItem(db, owner(now - 40 * MIN), {
      itemId: r.view.item.id,
      event: "propose",
      input: { startTime: iso(tomorrow10 + 2 * HOUR), endTime: iso(tomorrow10 + 2 * HOUR + 90 * MIN) },
    });
    await handled(now - 40 * MIN, r.view.item.id);
    await settle(now - 40 * MIN);
    count++;
  }

  // 14. An open message from an agent with a short thread: a follow-up and your internal note.
  {
    const t = now - 50 * MIN;
    const r = await createItem(db, agent(t), {
      type: "message",
      payload: {
        subject: "Group ride service, six bikes before Saturday",
        text: "Inês Almeida runs a Saturday group ride. She would like all six bikes checked and chains replaced this week. Can you take them, and what would it cost?",
      },
      contact: { name: "Inês Almeida", email: "ines.almeida@example.com" },
    });
    await settle(t);
    const item = r.view.item;
    await appendThreadEntry(
      db,
      agent(now - 45 * MIN, item.partyId),
      item,
      "Inês can drop them all off on Thursday evening if that helps your planning.",
      "in",
    );
    await appendThreadEntry(
      db,
      owner(now - 30 * MIN),
      item,
      "Check the 11-speed chain stock before answering; we may need to order four.",
      "note",
    );
    count++;
  }

  return { seeded: true, items: count };
}

async function confirmIfNeeded(db: Db, caller: Caller, itemId: string): Promise<void> {
  const [row] = await db.orm
    .select({ state: schema.items.state })
    .from(schema.items)
    .where(eq(schema.items.id, itemId));
  if (row?.state === "requested") {
    await transitionItem(db, caller, { itemId, event: "confirm" });
    await drain(createRunner({ mailOut: logMailOut() }), db, caller.now ? caller.now() : Date.now());
  }
}

/** Runs every due job (rules, notifications) as of `now`, until the outbox is quiet. */
async function drain(runner: JobRunner, db: Db, now: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await runner.runDue(db, { now, limit: 50, workerId: "seed" });
    if (r.claimed === 0) return;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The UTC offset of `tz` at `ms`, in milliseconds. */
function tzOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads hh:mm, `days` days from today. */
export function localTime(now: number, tz: string, days: number, hh: number, mm: number): number {
  const ref = now + days * DAY;
  const wall = ref + tzOffset(ref, tz);
  const d = new Date(wall);
  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - tzOffset(ref, tz);
  // A DST change between ref and the target moves the offset; one correction settles it.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - tzOffset(guess, tz);
}
