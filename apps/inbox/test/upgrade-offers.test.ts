import {
  Capabilities,
  createDb,
  createRunner,
  createSecretBox,
  ensureLifecycleSweep,
  type Item,
  LIFECYCLE_SWEEP_KIND,
  legacyOfferId,
  lifecycleSweepHandler,
  linksForEmail,
  MIGRATIONS,
  offerRows,
} from "@surfingdog/core";
import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * Offers (ADR-018 §1, §11, migration 0014), as a live instance meets them on upgrade: a time it
 * proposed and a quote it sent, with the links its emails already carry, and nothing else. After
 * the migration (twice), the sweep gives each the offer it holds, fingerprinted exactly as its links
 * are, and the customer's old link still answers it. A request made before keeps no clock and never
 * lapses on its own. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z"); // a Monday
const HOUR = 3_600_000;
const MIN = 60_000;
const START = Date.parse("2026-09-24T13:00:00Z"); // a Thursday, 14:00 in Lisbon
const box = createSecretBox(["upgrade-offers-instance-key-0123456789"]);
const iso = (ms: number) => new Date(ms).toISOString();
const flags = JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 });

describe("upgrading to offers", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("keeps what was proposed and sent, answerable by the links already emailed", async () => {
    const client = await makeClient();
    const before = MIGRATIONS.filter((m) => m.name < "0014_offers");
    expect(await runMigrations(client, before)).toBe(before.length);
    const db = createDb(client);
    const booking = {
      reservationFor: { serviceId: "svc_1", name: "Full service" },
      startTime: iso(START + DAYS(1)),
      endTime: iso(START + DAYS(1) + 90 * MIN),
      totalPrice: { value: 4500, currency: "EUR" },
      proposed: { startTime: iso(START), endTime: iso(START + 90 * MIN) },
    };
    const request = { itemOffered: { name: "Wheel rebuild" }, description: "Rear wheel, 28 spokes" };
    const quote = {
      totalPrice: { value: 31000, currency: "EUR" },
      validThrough: iso(T0 + 7 * DAYS(1)),
      lines: [{ name: "Build", quantity: 1, price: { value: 31000, currency: "EUR" } }],
      creates: "order",
    };
    await client.batch([
      {
        sql: "INSERT INTO business (id, name, timezone, currency, languages, created_at, updated_at) VALUES ('self', 'Oficina Maré', 'Europe/Lisbon', 'EUR', '[\"en\"]', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO services (id, name, duration_min, capacity, granularity_min, price, created_at, updated_at) VALUES ('svc_1', 'Full service', 90, 1, 30, ?, ?, ?)",
        params: [JSON.stringify({ model: "fixed", value: 4500, currency: "EUR" }), T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, contact, created_at, updated_at) VALUES ('party_1', 'human', '{\"email\":\"rita@example.com\"}', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      ...[
        ["item_b", "booking", "proposed", booking],
        ["item_q", "quote_request", "quoted", { ...request, quote }],
        ["item_r", "booking", "requested", { ...booking, proposed: undefined }],
      ].map(([id, type, state, payload]) => ({
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES (?, ?, ?, 2, 'party_1', 'form', ?, ?, ?, ?)",
        params: [id as string, type as string, state as string, JSON.stringify(payload), flags, T0, T0],
        method: "run" as const,
      })),
      ...["item_b", "item_q", "item_r"].flatMap((id) => [
        {
          sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES (?, ?, 1, 'create', NULL, ?, 'customer_human', 'form', 0, ?)",
          params: [
            `01JD000000000000000000${id.slice(-1).toUpperCase()}001`,
            id,
            id === "item_q" ? "received" : "requested",
            T0,
          ],
          method: "run" as const,
        },
      ]),
    ]);
    // The links the previous release emailed, from the item as it held them.
    const asItem = (id: string, type: Item["type"], state: string, payload: unknown) =>
      ({
        id,
        type,
        state,
        version: 2,
        partyId: "party_1",
        locationId: null,
        channel: "form",
        subject: null,
        flags: { needsHuman: false, sandbox: false, priority: 0 },
        linkedItemId: null,
        createdAt: iso(T0),
        updatedAt: iso(T0),
        closedAt: null,
        payload,
      }) as Item;
    const opts = { lang: "en" as const, base: "https://inbox.oficinamare.pt", now: T0, minNoticeMin: 60 };
    const timeLinks = await linksForEmail(db, box, asItem("item_b", "booking", "proposed", booking), {
      ...opts,
      mailKey: "job_b",
    });
    const quoteLinks = await linksForEmail(
      db,
      box,
      asItem("item_q", "quote_request", "quoted", { ...request, quote: { ...quote, lines: quote.lines } }),
      { ...opts, mailKey: "job_q" },
    );
    const token = (url: string | undefined) => (url ?? "").split("/c/")[1] as string;

    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    const columns = async (table: string) =>
      (await client.query({ sql: `PRAGMA table_info(${table})`, method: "all" })).rows.map((r) => String(r[1]));
    expect(await columns("item_offers")).toEqual(
      expect.arrayContaining(["id", "item_id", "rev", "status", "valid_through", "terms", "terms_sha", "round"]),
    );
    expect(await columns("slot_claims")).toContain("offer_id");
    const { rows: clocks } = await client.query({
      sql: "SELECT id, request_expires_at FROM items ORDER BY id",
      method: "all",
    });
    expect(clocks).toEqual([
      ["item_b", null],
      ["item_q", null],
      ["item_r", null],
    ]);

    // The sweep gives what was proposed its offer, fingerprinted as its links are; nothing is sent.
    const caps = new Capabilities(db, box, "https://inbox.oficinamare.pt");
    const runner = createRunner({ mailOut: logMailOut(), receipts: caps.receipts }).register(
      LIFECYCLE_SWEEP_KIND,
      lifecycleSweepHandler(),
    );
    const now = T0 + HOUR;
    await ensureLifecycleSweep(db, now);
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now, limit: 100 })).claimed === 0) break;
    const [timeOffer] = await offerRows(db, "item_b");
    const [quoteOffer] = await offerRows(db, "item_q");
    const { rows: linkShas } = await client.query({
      sql: "SELECT item_id, terms_sha FROM action_links ORDER BY item_id",
      method: "all",
    });
    expect(timeOffer).toMatchObject({
      id: legacyOfferId("item_b"),
      by: "business",
      status: "open",
      // What its email said: its start less the minimum notice.
      validThrough: START - 60 * MIN,
    });
    expect(quoteOffer).toMatchObject({ id: legacyOfferId("item_q"), validThrough: Date.parse(quote.validThrough) });
    expect(new Set(linkShas.filter((r) => r[0] === "item_b").map((r) => r[1]))).toEqual(new Set([timeOffer?.termsSha]));
    expect(new Set(linkShas.filter((r) => r[0] === "item_q").map((r) => r[1]))).toEqual(
      new Set([quoteOffer?.termsSha]),
    );
    // A request left from before has no offer yet, and no clock: it never lapses on its own.
    expect(await offerRows(db, "item_r")).toEqual([]);
    const { rows: mails } = await client.query({ sql: "SELECT COUNT(*) FROM outbound_mail", method: "all" });
    expect(Number(mails[0]?.[0])).toBe(0);

    // The customer's old links answer what they were sent.
    for (const [url, id, state] of [
      [timeLinks?.get("accept_time"), "item_b", "confirmed"],
      [quoteLinks?.get("accept_quote"), "item_q", "accepted"],
    ] as const) {
      const page = await caps.customer.linkView(token(url), { now });
      expect(page.status).toBe(200);
      const acted = await caps.customer.linkAct(
        token(url),
        { terms: page.form?.hidden.terms, v: page.form?.hidden.v },
        { now },
      );
      expect(acted).toEqual({ redirect: `/c/${token(url)}` });
      const { rows } = await client.query({ sql: "SELECT state FROM items WHERE id = ?", params: [id], method: "all" });
      expect(rows[0]?.[0]).toBe(state);
      expect((await offerRows(db, id))[0]?.status).toBe("accepted");
    }
  });
});

function DAYS(n: number): number {
  return n * 24 * HOUR;
}
