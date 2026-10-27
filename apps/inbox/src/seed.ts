import {
  appendThreadEntry,
  asideStatements,
  type Caller,
  Capabilities,
  type Channel,
  createItem,
  createRunner,
  type Db,
  DEFAULT_NETWORK,
  type JobRunner,
  PRESETS,
  type ReceiptCapabilities,
  type RuleDefinition,
  schema,
  setFlags,
  transitionItem,
  ulid,
} from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";

/**
 * What a seed needs beyond the database. `receipts` is the instance's receipt capability when the
 * host has a secret key and a public URL; with it, the items a seed confirms earn real receipts,
 * the way they would on a live instance. Without it they do not, and the jobs say so.
 */
export interface SeedDeps {
  readonly receipts?: ReceiptCapabilities | undefined;
}

/** The showcase shop's domain. */
export const SHOWCASE_DOMAIN = "oficinamare.pt";

/**
 * The public demo's copy of the shop has a domain of its own, and a public demo only ever wipes an
 * instance whose business has it. `.example` is reserved (RFC 2606), so no real business has it, and
 * nothing but the demo's own seed writes it: not seed-demo, not seed-showcase, not the setup wizard.
 */
export const DEMO_SHOP_DOMAIN = "oficinamare.example";

/**
 * A demo business so a fresh instance has something to show: Oficina Maré, a bicycle workshop in
 * Ericeira. Idempotent; never touches an instance that already has a business row.
 */
export async function seedDemo(db: Db, now = Date.now(), _deps: SeedDeps = {}): Promise<{ seeded: boolean }> {
  const [existing] = await db.orm
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  if (existing) return { seeded: false };
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    domain: SHOWCASE_DOMAIN,
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
      networks: { [DEFAULT_NETWORK]: { enabled: true } },
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
 *
 * `demo` is the public demo's copy (demo.ts): the same shop with no owner address, no sender and no
 * network, since a demo emails nobody and reports to nobody.
 */
export async function seedShowcase(
  db: Db,
  now = Date.now(),
  deps: SeedDeps = {},
  opts: { demo?: boolean } = {},
): Promise<{ seeded: boolean; items: number }> {
  const t0 = now - 10 * DAY;
  // The business row is the claim: one statement that only the first of two seeders at once wins,
  // so the other returns here instead of failing half way (two requests can meet an empty demo).
  const claim = await db.client.query({
    sql: "INSERT OR IGNORE INTO business (id, name, domain, timezone, currency, created_at, updated_at) VALUES ('self', ?, ?, ?, ?, ?, ?)",
    params: ["Oficina Maré", opts.demo ? DEMO_SHOP_DOMAIN : SHOWCASE_DOMAIN, TZ, "EUR", t0, t0],
    method: "run",
  });
  if (claim.changes === 0) return { seeded: false, items: 0 };

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
      // A demo is tried from anywhere, so it answers in English first.
      business: {
        name: "Oficina Maré",
        timezone: TZ,
        currency: "EUR",
        languages: opts.demo ? ["en", "pt"] : ["pt", "en"],
      },
      booking: { cancellationWindowMin: 120, holdOnPropose: true, autoExpireHours: 48 },
      orders: { maxValueWithoutApprovalMinor: 20_000 },
      ...(opts.demo
        ? {}
        : {
            notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: "https://inbox.oficinamare.pt" },
            email: { fromAddress: "inbox@oficinamare.pt", fromName: "Oficina Maré", replyTo: "hello@oficinamare.pt" },
            networks: { [DEFAULT_NETWORK]: { enabled: true } },
          }),
    },
  });

  // ---- the items, oldest first, each followed by the jobs it caused (rules, notifications) ----
  const runner = createRunner({ mailOut: logMailOut(), receipts: deps.receipts });
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
    await confirmIfNeeded(db, deps, owner(now - 8 * DAY + 20 * MIN), r.view.item.id);
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

  // 4. A quote the customer accepted, which became an order, accepted with it.
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
    await confirmIfNeeded(db, deps, owner(t + 25 * MIN), r.view.item.id);
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
    await confirmIfNeeded(db, deps, owner(t + 30 * MIN), r.view.item.id);
    await transitionItem(db, person(now - DAY, "form", r.view.item.partyId), {
      itemId: r.view.item.id,
      event: "cancel",
      input: { note: "Found a shop nearer home, sorry about that." },
    });
    await settle(now - DAY);
    count++;
  }

  // 7b. Two bookings today, confirmed days ago: what the Today pane opens on.
  for (const [days, hh, mm, service, name, who, mail, note] of [
    [
      3,
      15,
      0,
      "puncture",
      "Puncture repair",
      "Diogo Nunes",
      "diogo.nunes@example.com",
      "Rear tyre, tubeless; it lost pressure overnight.",
    ],
    [
      2,
      16,
      30,
      "brakes",
      "Brake bleed",
      "Beatriz Gomes",
      "beatriz.gomes@example.com",
      "Front lever feels spongy since the last ride.",
    ],
  ] as const) {
    const start = localTime(now, TZ, 0, hh, mm);
    const t = now - days * DAY;
    const r = await createItem(db, person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc[service], name },
        startTime: iso(start),
        endTime: iso(start + (service === "brakes" ? 45 : 30) * MIN),
        totalPrice: EUR(service === "brakes" ? 3500 : 1200),
      },
      contact: { name: who, email: mail },
      message: note,
    });
    await settle(t);
    await confirmIfNeeded(db, deps, owner(t + 20 * MIN), r.view.item.id);
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

  // 15. The spam filter (ADR-041): what it held, what it put aside, what it labelled, with its reasons.
  if (!opts.demo) count += await seedSpam(db, now, { person, agent, settle, svc });

  return { seeded: true, items: count };
}

/** A signal as `spam_verdicts.signals` keeps it: a code, its points, what it measured, where from. */
interface SeedSignal {
  readonly c: string;
  readonly w: number;
  readonly v?: number;
  readonly f: string;
  readonly x?: 1;
  readonly d?: string;
}

/**
 * The showcase's spam filter, as it would stand after a fortnight with Sales pitches and Scams on:
 * four requests held (one that may be a customer after all), four messages put aside, two delivered
 * with a label, one brought back, and the two lists. Names and places from many countries; the
 * passages quoted are the senders' own words, as the AI check found them.
 */
async function seedSpam(
  db: Db,
  now: number,
  o: {
    readonly person: (t: number, channel?: Channel, partyId?: string) => Caller;
    readonly agent: (t: number, partyId?: string) => Caller;
    readonly settle: (t: number) => Promise<void>;
    readonly svc: { readonly full: string; readonly truing: string; readonly puncture: string };
  },
): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  await db.batch([
    // The free protection's learning week, long over; Sales pitches on for twelve days, Scams for four.
    {
      sql: "UPDATE spam_filter_spans SET from_at = ?, learning_until = ? WHERE id = 'basic'",
      params: [now - 30 * DAY, now - 23 * DAY],
      method: "run",
    },
    {
      sql: `INSERT OR IGNORE INTO spam_filter_spans (id, filter, choice, from_at, to_at, learning_until, by_kind, by_id)
            VALUES (?, 'pitches', 'aside', ?, NULL, ?, 'owner', 'owner'), (?, 'scams', 'aside', ?, NULL, ?, 'owner', 'owner')`,
      params: [ulid(), now - 12 * DAY, now - 5 * DAY, ulid(), now - 4 * DAY, now + 3 * DAY],
      method: "run",
    },
  ]);
  const verdict = (
    itemId: string,
    v: {
      readonly door: string;
      readonly verdict: string;
      readonly cause: string;
      readonly certain?: boolean;
      readonly signals: readonly SeedSignal[];
      readonly ai?: string;
      readonly answer?: Record<string, unknown>;
      readonly quotes?: readonly string[];
      readonly learning?: boolean;
      readonly owner?: string;
      readonly at: number;
    },
  ) => ({
    sql: `INSERT OR IGNORE INTO spam_verdicts (item_id, door, verdict, cause, certain, score, signals, ai, answer, quotes, learning,
            owner_verdict, owner_at, created_at, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      itemId,
      v.door,
      v.verdict,
      v.cause,
      v.certain ? 1 : 0,
      v.signals.reduce((n, x) => n + x.w, 0),
      JSON.stringify(v.signals),
      v.ai ?? "none",
      v.answer ? JSON.stringify(v.answer) : null,
      v.quotes?.length ? JSON.stringify(v.quotes) : null,
      v.learning ? 1 : 0,
      v.owner ?? null,
      v.owner ? v.at + HOUR : null,
      v.at,
      v.at,
    ],
    method: "run" as const,
  });
  const screen = (itemId: string, to: string, at: number) => ({
    sql: "UPDATE items SET screen = ?, screen_at = ? WHERE id = ?",
    params: [to, at, itemId],
    method: "run" as const,
  });
  const ai = (kind: string, certainty: string, topic: string, intent = false) => ({
    kind,
    certainty,
    customer_intent: intent,
    talks_to_filter: false,
    topic,
  });
  let n = 0;

  // Held: a booking from someone who made six requests today. It may well be a customer.
  {
    const t = now - 3 * HOUR;
    const start = localTime(now, TZ, 1, 15, 0);
    const r = await createItem(db, o.person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: o.svc.full, name: "Full service" },
        startTime: iso(start),
        endTime: iso(start + 90 * MIN),
        totalPrice: EUR(4500),
      },
      contact: { name: "Kwame Asante", email: "kwame.asante@example.com" },
      message: "Booking for my whole cycling club, one bike at a time. This is the first.",
    });
    await db.batch([
      screen(r.view.item.id, "held", t),
      verdict(r.view.item.id, {
        door: "form",
        verdict: "hold",
        cause: "many_new",
        certain: true,
        signals: [{ c: "many_new", w: 6, v: 6, f: "basic", x: 1 }],
        at: t,
      }),
    ]);
    await o.settle(t);
    n++;
  }
  // Held: a quote request filled in in three seconds from a throwaway address; the AI check wasn't sure.
  {
    const t = now - 5 * HOUR;
    const r = await createItem(db, o.person(t), {
      type: "quote_request",
      payload: {
        itemOffered: { name: "Wheel truing", serviceId: o.svc.truing },
        description: "Front wheel of a folding bike rubs the brake pad. How much to true it?",
      },
      contact: { name: "Aiko Tanaka", email: "aiko.t@mailbox-temp.example" },
    });
    await db.batch([
      screen(r.view.item.id, "held", t),
      verdict(r.view.item.id, {
        door: "form",
        verdict: "hold",
        cause: "too_fast",
        signals: [
          { c: "too_fast", w: 4, v: 3, f: "basic" },
          { c: "disposable", w: 2, f: "basic" },
        ],
        ai: "judged",
        answer: ai("unclear", "low", "none", true),
        at: t,
      }),
    ]);
    await o.settle(t);
    n++;
  }
  // Held: an order whose very words came from fourteen senders this week.
  {
    const t = now - 7 * HOUR;
    const r = await createItem(db, o.agent(t), {
      type: "order",
      payload: {
        orderedItem: [{ sku: "CH-9", name: "Chain, 9-speed", quantity: 40, price: EUR(1850) }],
        totalPrice: EUR(74000),
        delivery: { method: "delivery" },
        paymentMethod: "card",
      },
      contact: { email: "orders@bulk-supply.example" },
      message: "Urgent bulk order, pay by card on delivery, send tracking.",
    });
    await db.batch([
      screen(r.view.item.id, "held", t),
      verdict(r.view.item.id, {
        door: "agent",
        verdict: "hold",
        cause: "wave",
        certain: true,
        signals: [{ c: "wave", w: 6, v: 14, f: "basic", x: 1 }],
        at: t,
      }),
    ]);
    await o.settle(t);
    n++;
  }
  // Held: a booking from a form a bot filled in, hidden field and all.
  {
    const t = now - 26 * HOUR;
    const start = localTime(now, TZ, 3, 9, 0);
    const r = await createItem(db, o.person(t), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: o.svc.puncture, name: "Puncture repair" },
        startTime: iso(start),
        endTime: iso(start + 30 * MIN),
        totalPrice: EUR(1200),
      },
      contact: { name: "Best Bonus Online", email: "win@bonus-spin.example" },
      message: "Claim your 500% welcome bonus today.",
    });
    await db.batch([
      screen(r.view.item.id, "held", t),
      verdict(r.view.item.id, {
        door: "form",
        verdict: "hold",
        cause: "trap",
        certain: true,
        signals: [{ c: "trap", w: 6, f: "basic", x: 1 }],
        at: t,
      }),
    ]);
    await o.settle(t);
    n++;
  }

  /** A message put aside as it arrived, as the system: its state, its screen, its reasons. */
  const aside = async (
    t: number,
    channel: Channel,
    payload: { subject: string; text: string },
    contact: { name: string; email: string },
    v: Parameters<typeof verdict>[1],
  ) => {
    const r = await createItem(db, o.person(t, channel), { type: "message", payload, contact });
    await db.batch([
      ...asideStatements(r.view.item.id, r.view.item.state, r.view.item.version, t),
      screen(r.view.item.id, "aside", t),
      verdict(r.view.item.id, v),
    ]);
    await o.settle(t);
    return r.view.item.id;
  };

  // Put aside: a search-ranking pitch the AI check was sure of, in the sender's own words.
  {
    const t = now - 2 * HOUR;
    await aside(
      t,
      "form",
      {
        subject: "Your website and Google",
        text: "Hi there! I noticed your shop isn't on the first page of Google. We guarantee top 3 rankings in 30 days with our backlink package. Can I send you a free audit?",
      },
      { name: "Daniel Brooks", email: "daniel@rankboost.example" },
      {
        door: "form",
        verdict: "aside",
        cause: "pitches",
        signals: [
          { c: "ai_kind", w: 6, f: "pitches" },
          { c: "pitch_phrases", w: 2, f: "pitches" },
        ],
        ai: "judged",
        answer: ai("sales_pitch", "high", "seo"),
        quotes: ["We guarantee top 3 rankings in 30 days with our backlink package"],
        at: t,
      },
    );
    n++;
  }
  // Put aside: a domain "final notice" asking for money today.
  {
    const t = now - 9 * HOUR;
    await aside(
      t,
      "email",
      {
        subject: "Final notice: your domain listing expires today",
        text: "Your domain listing will be suspended unless the renewal fee of €89 is received today. Pay now at domain-notice.example/pay to keep your website online.",
      },
      { name: "Domain Renewal Desk", email: "billing@domain-notice.example" },
      {
        door: "email",
        verdict: "aside",
        cause: "scams",
        signals: [
          { c: "ai_kind", w: 6, f: "scams" },
          { c: "scam_phrases", w: 3, f: "scams" },
        ],
        ai: "judged",
        answer: ai("scam", "high", "domain_listing"),
        quotes: ["will be suspended unless the renewal fee of €89 is received today"],
        at: t,
      },
    );
    n++;
  }
  // Put aside: what a bot sent through the form, its hidden field filled.
  {
    const t = now - 30 * HOUR;
    await aside(
      t,
      "form",
      { subject: "Bonus", text: "500% casino welcome bonus, spin now, free credits every day" },
      { name: "Lucky Spin", email: "promo@lucky-spin.example" },
      {
        door: "form",
        verdict: "aside",
        cause: "trap",
        certain: true,
        signals: [{ c: "trap", w: 6, f: "basic", x: 1 }],
        at: t,
      },
    );
    n++;
  }
  // Put aside: an email a mail server it passed through had marked as spam.
  {
    const t = now - 2 * DAY;
    await aside(
      t,
      "email",
      {
        subject: "Grow your followers by 10k this month",
        text: "Real followers, real likes, delivered in days. Reply YES to start.",
      },
      { name: "Social Boost", email: "hello@socialboost.example" },
      {
        door: "email",
        verdict: "aside",
        cause: "server_marked",
        certain: true,
        signals: [{ c: "server_marked", w: 6, f: "basic", x: 1 }],
        at: t,
      },
    );
    n++;
  }
  // Brought back: a customer writing in Spanish, put aside a week ago, Not spam since: on Let through.
  {
    const t = now - 6 * DAY;
    const r = await createItem(db, o.person(t), {
      type: "message",
      payload: {
        subject: "Revisión de bici de carretera",
        text: "Hola, ¿hacéis revisiones completas de bicis de carretera? Tengo una Orbea de 2018 y quisiera saber el precio y cuánto tardáis.",
      },
      contact: { name: "Lucía Fernández", email: "lucia.fernandez@example.com" },
    });
    await db.batch([
      screen(r.view.item.id, "released", t + HOUR),
      verdict(r.view.item.id, {
        door: "form",
        verdict: "aside",
        cause: "pitches",
        signals: [{ c: "pitch_phrases", w: 6, f: "pitches" }],
        owner: "not_spam",
        at: t,
      }),
      {
        sql: `INSERT OR IGNORE INTO spam_lists (list, kind, value, party_id, item_id, by_user, created_at)
              VALUES ('allow', 'address', 'lucia.fernandez@example.com', ?, ?, 'owner', ?),
                     ('block', 'address', 'offers@rankboost.example', NULL, NULL, 'owner', ?)`,
        params: [r.view.item.partyId, r.view.item.id, t + HOUR, now - 3 * DAY],
        method: "run",
      },
    ]);
    await o.settle(t);
    n++;
  }

  /** Delivered with a label: on the desk, needing a person, its rules only flagging. */
  const warned = async (
    t: number,
    payload: { subject: string; text: string },
    contact: { name: string; email: string },
    label: string,
    v: Parameters<typeof verdict>[1],
  ) => {
    const r = await createItem(db, o.person(t, v.door === "email" ? "email" : "form"), {
      type: "message",
      payload,
      contact,
    });
    await db.batch([
      screen(r.view.item.id, "warned", t),
      {
        sql: "UPDATE items SET flags = json_patch(flags, ?) WHERE id = ?",
        params: [JSON.stringify({ needsHuman: true, spamLabel: label }), r.view.item.id],
        method: "run",
      },
      verdict(r.view.item.id, v),
    ]);
    await o.settle(t);
  };
  // Labelled: a web designer selling, who also wants their own bike serviced. It came to the desk.
  await warned(
    now - 70 * MIN,
    {
      subject: "Websites for small shops (and my bike)",
      text: "Hello! I build websites for small shops and would love to show you some ideas. Also, my own bike needs a service: do you have time on Friday?",
    },
    { name: "Sofía Herrera", email: "sofia@studiocanela.example" },
    "pitches",
    {
      door: "form",
      verdict: "warn",
      cause: "pitches",
      signals: [
        { c: "ai_kind", w: 3, f: "pitches" },
        { c: "pitch_phrases", w: 1, f: "pitches" },
      ],
      ai: "judged",
      answer: ai("sales_pitch", "medium", "web_design", true),
      quotes: ["I build websites for small shops"],
      at: now - 70 * MIN,
    },
  );
  // Labelled while Scams is still learning: what it would have put aside.
  await warned(
    now - 4 * HOUR,
    {
      subject: "New bank details for your parts order",
      text: "Please note our bank details have changed. Send the payment for the parts order to the new account from today and confirm by return.",
    },
    { name: "Arjun Mehta", email: "accounts@partsdirect-billing.example" },
    "learning",
    {
      door: "email",
      verdict: "warn",
      cause: "scams",
      signals: [
        { c: "ai_kind", w: 6, f: "scams" },
        { c: "scam_phrases", w: 3, f: "scams" },
      ],
      ai: "judged",
      answer: ai("scam", "high", "bank_details"),
      quotes: ["our bank details have changed"],
      learning: true,
      at: now - 4 * HOUR,
    },
  );
  n += 2;

  // This month's counts, as the filter keeps them by day.
  await db.client.query({
    sql: `INSERT INTO spam_days (day, key, n) VALUES (?, 'aside', 4), (?, 'held', 4), (?, 'warned', 2), (?, 'brought_back', 1),
            (?, 'judged', 6), (?, 'tokens_in', 5400), (?, 'tokens_out', 420)
          ON CONFLICT (day, key) DO UPDATE SET n = excluded.n`,
    params: [day, day, day, day, day, day, day],
    method: "run",
  });
  return n;
}

async function confirmIfNeeded(db: Db, deps: SeedDeps, caller: Caller, itemId: string): Promise<void> {
  const [row] = await db.orm
    .select({ state: schema.items.state })
    .from(schema.items)
    .where(eq(schema.items.id, itemId));
  if (row?.state === "requested") {
    await transitionItem(db, caller, { itemId, event: "confirm" });
    await drain(
      createRunner({ mailOut: logMailOut(), receipts: deps.receipts }),
      db,
      caller.now ? caller.now() : Date.now(),
    );
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

// ---- Surfing Dog's own inbox ------------------------------------------------------------

/**
 * Surfing Dog's own inbox: the company that makes the software runs on it. Calls can be booked,
 * quotes for hosted setups and connectors requested, and anyone (or their agent) can message.
 * Idempotent like seedDemo. Opening hours are a working assumption until the owner edits them.
 */
export async function seedSurfingDog(db: Db, now = Date.now(), _deps: SeedDeps = {}): Promise<{ seeded: boolean }> {
  const [existing] = await db.orm
    .select({ id: schema.business.id })
    .from(schema.business)
    .where(eq(schema.business.id, "self"));
  if (existing) return { seeded: false };
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Surfing Dog",
    domain: "surfingdog.ai",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en", "pt"],
    createdAt: now,
    updatedAt: now,
  });
  await db.orm.insert(schema.services).values([
    {
      id: ulid(),
      name: "Intro call",
      description: "Thirty minutes about your business and what an inbox for agents would do for it.",
      durationMin: 30,
      capacity: 1,
      granularityMin: 30,
      price: { model: "fixed", value: 0, currency: "EUR" },
      sort: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ulid(),
      name: "Working session",
      description: "One hour of hands-on setup: rules, availability, connectors, your own AI on the owner MCP.",
      durationMin: 60,
      bufferAfterMin: 15,
      capacity: 1,
      granularityMin: 30,
      price: { model: "quote" },
      sort: 2,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const hours: [string, string][] = [["10:00", "18:00"]];
  await db.orm.insert(schema.availabilityRules).values({
    id: ulid(),
    kind: "open",
    weekly: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours },
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
      business: { name: "Surfing Dog", timezone: "Europe/Lisbon", currency: "EUR", languages: ["en", "pt"] },
      booking: { cancellationWindowMin: 60 },
      networks: { [DEFAULT_NETWORK]: { enabled: true } },
    },
  });
  return { seeded: true };
}
