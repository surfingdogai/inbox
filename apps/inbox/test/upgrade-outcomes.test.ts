import { createDb, type Db, ensureLifecycleSweep, MIGRATIONS, readSettings } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, makeClient } from "./harness";

/**
 * Outcomes and receipt claims v2 (ADR-017 §3, §8), as a live instance meets them on upgrade: its
 * settings, items and receipts are the previous release's, and nothing is done by the owner. Late
 * cancellations stay refused where the owner never chose; every receipt already issued is kept as
 * it was and gets its sha from the sweep; a booking or an order promised before the upgrade was
 * promised under the rules of the day (R18): the sweep neither completes nor lapses it, no outcome
 * is recorded for it, and its owner closes it by hand, with no correction offered after. Runs on
 * Node and inside workerd.
 */
const INBOX = "https://inbox.surfingdog.ai";
const SECRET_KEY = "upgrade-outcomes-instance-key-0123456789";
const T0 = Date.parse("2026-09-20T09:00:00Z");
const HOUR = 3_600_000;
const START = T0 + 24 * HOUR;
const END = START + 90 * 60_000;
const LEGACY_NONCE = "0123456789abcdef0123456789abcdef";

async function drain(inbox: ReturnType<typeof createInbox>, db: Db, now: number) {
  for (let i = 0; i < 30; i++) {
    const r = await inbox.runner.runDue(db, { now, limit: 100 });
    expect(r.failed + r.dead).toBe(0);
    if (r.claimed === 0) return;
  }
}

describe("upgrading to outcomes", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("upgrades the previous release's database in place, and a second run changes nothing", async () => {
    const client = await makeClient();
    expect(
      await runMigrations(
        client,
        MIGRATIONS.filter((m) => m.name < "0008_outcomes"),
      ),
    ).toBe(8);
    const db = createDb(client);
    const legacyPayload = {
      iss: INBOX,
      sub: "0wWorHT-zGDpWTirCnd5ixnX05zWga0OGKCyrQ6VfB0",
      itm: "item_1",
      typ: "booking",
      knd: "confirmed",
      iat: Math.floor((T0 + 1) / 1000),
      nonce: LEGACY_NONCE,
    };
    // What the previous release left: its settings, a confirmed booking a customer made, and the
    // v1 receipt it issued for it.
    await client.batch([
      {
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 4, ?)",
        params: [JSON.stringify({ booking: { cancellationWindowMin: 60 }, notifications: { appUrl: INBOX } }), T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, contact, created_at, updated_at) VALUES ('party_1', 'human', '{\"email\":\"rita@example.com\"}', ?, ?)",
        params: [T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_1', 'booking', 'confirmed', 2, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            reservationFor: { serviceId: "svc_1", name: "Surf lesson" },
            startTime: new Date(START).toISOString(),
            endTime: new Date(END).toISOString(),
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
      {
        sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000B1', 'item_1', 1, 'create', NULL, 'requested', 'customer_human', 'form', 0, ?)",
        params: [T0],
        method: "run",
      },
      {
        sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES ('01JD00000000000000000000B2', 'item_1', 2, 'confirm', 'requested', 'confirmed', 'owner', 'user_1', 0, ?)",
        params: [T0 + 1],
        method: "run",
      },
      {
        sql: "INSERT INTO receipts (id, item_id, kind, jws, payload, kid, subject_hash, issued_at) VALUES ('01JD00000000000000000000R1', 'item_1', 'confirmed', 'eyJhbGciOiJFZERTQSJ9.e30.c2ln', ?, 'kid_1', ?, ?)",
        params: [JSON.stringify(legacyPayload), legacyPayload.sub, T0 + 2],
        method: "run",
      },
      // An order a customer made, accepted, its payment asked for and never made; and a booking
      // still waiting for the owner, which promised nothing yet.
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_2', 'order', 'awaiting_payment', 3, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            orderedItem: [{ name: "Wax", quantity: 1, price: { value: 900, currency: "EUR" } }],
            totalPrice: { value: 900, currency: "EUR" },
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
      ...["create:received", "accept:accepted", "request_payment:awaiting_payment"].map((step, i) => {
        const [event, to] = step.split(":");
        return {
          sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES (?, 'item_2', ?, ?, NULL, ?, ?, ?, 0, ?)",
          params: [`01JD00000000000000000000C${i}`, i + 1, event, to, i === 0 ? "customer_human" : "owner", "u", T0],
          method: "run" as const,
        };
      }),
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_3', 'booking', 'requested', 1, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            reservationFor: { serviceId: "svc_1", name: "Surf lesson" },
            startTime: new Date(START).toISOString(),
            endTime: new Date(END).toISOString(),
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
      // Promises already kept before the upgrade, which a correction or a charge-back could still
      // reach: a booking completed an hour and a half after it ended, and an order completed.
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_4', 'booking', 'completed', 3, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            reservationFor: { serviceId: "svc_1", name: "Surf lesson" },
            startTime: new Date(T0 - 3 * HOUR).toISOString(),
            endTime: new Date(T0 - 1.5 * HOUR).toISOString(),
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('item_5', 'order', 'completed', 5, 'party_1', 'form', ?, ?, ?, ?)",
        params: [
          JSON.stringify({
            orderedItem: [{ name: "Wax", quantity: 1, price: { value: 900, currency: "EUR" } }],
            totalPrice: { value: 900, currency: "EUR" },
          }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
      ...[
        "item_4:create::requested",
        "item_4:confirm:requested:confirmed",
        "item_4:complete:confirmed:completed",
        "item_5:create::received",
        "item_5:accept:received:accepted",
        "item_5:record_payment:accepted:paid",
        "item_5:fulfil:paid:fulfilled",
        "item_5:complete:fulfilled:completed",
      ].map((step, i) => {
        const [itemId, event, from, to] = step.split(":");
        return {
          sql: "INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
          params: [
            `01JD00000000000000000000D${i}`,
            itemId,
            itemId === "item_4" ? i + 1 : i - 2,
            event,
            from || null,
            to,
            event === "create" ? "customer_human" : "owner",
            "u",
            T0,
          ],
          method: "run" as const,
        };
      }),
    ]);

    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    // The owner never chose a late-cancellation policy, so the one they had stays: refused.
    const settings = await readSettings(db);
    expect(settings.booking).toMatchObject({ lateCancellation: "refuse", cancellationWindowMin: 60 });
    expect(settings.notifications.appUrl).toBe(INBOX);

    // The receipt is kept as it was, a promise, with its sha still to come; the booking knows its end.
    const receipt = await client.query({
      sql: "SELECT kind, outcome, sha FROM receipts WHERE id = '01JD00000000000000000000R1'",
      method: "all",
    });
    expect(receipt.rows).toEqual([["confirmed", "", null]]);
    const item = await client.query({ sql: "SELECT end_at FROM items WHERE id = 'item_1'", method: "all" });
    expect(Number(item.rows[0]?.[0])).toBe(Math.floor(END / 1000));
    // What was promised before is marked as such; what promised nothing is not.
    const legacy = await client.query({ sql: "SELECT id, legacy_promise FROM items ORDER BY id", method: "all" });
    expect(legacy.rows).toEqual([
      ["item_1", 1],
      ["item_2", 1],
      ["item_3", 0],
      ["item_4", 1],
      ["item_5", 1],
    ]);
    const indexes = await client.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipts' AND name LIKE 'receipts_%' ORDER BY name",
      method: "all",
    });
    expect(indexes.rows.map((r) => String(r[0]))).toEqual(["receipts_item_kind_outcome", "receipts_sha"]);

    // Two days after it ended, and weeks after the order's payment was asked for, the sweep leaves
    // both as they are: nothing completed, nothing lapsed, no outcome. It still gives the old
    // receipt its sha.
    const inbox = createInbox({ db, baseUrl: INBOX, secretKey: SECRET_KEY });
    const ownerAt = (t: number) => ({
      actor: { kind: "owner" as const, id: "u1", channel: "owner_ui" as const },
      tier: "verified_principal" as const,
      sandbox: false,
      now: () => t,
    });
    // An hour on, the kept booking is well inside its correction window, and still no correction
    // is offered or taken: it has no outcome to correct. The completed order's charge-back is the
    // owner's own record, taken, and records nothing for a network.
    const early = ownerAt(T0 + HOUR);
    expect((await inbox.caps.getItem(early, { item_id: "item_4" })).transitions.map((t) => t.event)).not.toContain(
      "no_show",
    );
    await expect(inbox.caps.transitionItem(early, { item_id: "item_4", event: "no_show" })).rejects.toMatchObject({
      code: "guard_failed",
      details: { legacy: true },
    });
    await inbox.caps.transitionItem(early, { item_id: "item_5", event: "record_charge_back" });
    const at = END + 49 * HOUR + 30 * 24 * HOUR;
    await ensureLifecycleSweep(db, at);
    await drain(inbox, db, at);
    const states = await client.query({ sql: "SELECT id, state FROM items ORDER BY id", method: "all" });
    expect(states.rows).toEqual([
      ["item_1", "confirmed"],
      ["item_2", "awaiting_payment"],
      ["item_3", "requested"],
      ["item_4", "completed"],
      ["item_5", "completed"],
    ]);
    // A lapse keeps the order's state, so it is looked for in the history: there is none.
    const lapses = await client.query({ sql: "SELECT COUNT(*) FROM item_events WHERE event = 'lapse'", method: "all" });
    expect(lapses.rows).toEqual([[0]]);
    const sha = await client.query({
      sql: "SELECT sha FROM receipts WHERE id = '01JD00000000000000000000R1'",
      method: "all",
    });
    expect(String(sha.rows[0]?.[0])).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The owner closes the booking by hand, as before: completed, with no outcome receipt, and the
    // one-time correction is neither offered nor taken.
    const owner = ownerAt(at + HOUR);
    expect((await inbox.caps.getItem(owner, { item_id: "item_1" })).transitions.map((t) => t.event)).toContain(
      "complete",
    );
    const done = await inbox.caps.transitionItem(owner, { item_id: "item_1", event: "complete" });
    expect(done.view.item.state).toBe("completed");
    expect(done.view.transitions.map((t) => t.event)).not.toContain("no_show");
    // Nothing is even queued for an outcome, and a receipt asked for all the same is refused.
    const queued = await client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = 'issue_receipt' AND json_extract(payload, '$.kind') = 'outcome'",
      method: "all",
    });
    expect(queued.rows).toEqual([[0]]);
    expect(
      await inbox.caps.receipts.issue("item_1", "outcome", at + HOUR, { outcome: "booking.completed" }),
    ).toMatchObject({ outcome: "skipped", note: expect.stringContaining("before outcomes were recorded") });
    await drain(inbox, db, at + HOUR);
    const receipts = await inbox.caps.receipts.forItem("item_1");
    expect(receipts.map((r) => r.kind)).toEqual(["confirmed"]);
    const detail = await inbox.caps.getItem(owner, { item_id: "item_1" });
    expect(detail.transitions.map((t) => t.event)).not.toContain("no_show");
    await expect(inbox.caps.transitionItem(owner, { item_id: "item_1", event: "no_show" })).rejects.toMatchObject({
      code: "guard_failed",
    });
    // The order is closed by hand too, and records nothing for a network either.
    await inbox.caps.transitionItem(owner, { item_id: "item_2", event: "cancel" });
    await drain(inbox, db, at + HOUR);
    expect((await inbox.caps.receipts.forItem("item_2")).map((r) => r.kind)).toEqual([]);
    const outcomes = await client.query({ sql: "SELECT COUNT(*) FROM receipts WHERE kind = 'outcome'", method: "all" });
    expect(outcomes.rows).toEqual([[0]]);
  });

  it("sets refuse only where the stored settings do not say, and never breaks on an odd document", async () => {
    const db = await freshDb();
    const statements = (MIGRATIONS.find((m) => m.name === "0008_outcomes")?.statements ?? []).filter((s) =>
      /`settings`/.test(s),
    );
    expect(statements).toHaveLength(3);
    const run = async (doc: string | null, withItem: boolean) => {
      await db.client.batch([
        { sql: "DELETE FROM settings", method: "run" },
        { sql: "DELETE FROM items", method: "run" },
        ...(doc === null
          ? []
          : [
              {
                sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 1, 0)",
                params: [doc],
                method: "run" as const,
              },
            ]),
        ...(withItem
          ? [
              {
                sql: "INSERT OR IGNORE INTO parties (id, kind, created_at, updated_at) VALUES ('p', 'human', 0, 0)",
                method: "run" as const,
              },
              {
                sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at) VALUES ('i', 'message', 'open', 1, 'p', 'form', '{}', '{}', 0, 0)",
                method: "run" as const,
              },
            ]
          : []),
      ]);
      await db.client.batch(statements.map((sql) => ({ sql, method: "run" as const })));
      const { rows } = await db.client.query({ sql: "SELECT doc FROM settings", method: "all" });
      return rows.map((r) => String(r[0]));
    };
    expect(await run(JSON.stringify({ booking: { autoExpireHours: 12 } }), true)).toEqual([
      JSON.stringify({ booking: { autoExpireHours: 12, lateCancellation: "refuse" } }),
    ]);
    // The owner's own choice stands, either way.
    expect(await run(JSON.stringify({ booking: { lateCancellation: "record" } }), true)).toEqual([
      JSON.stringify({ booking: { lateCancellation: "record" } }),
    ]);
    expect(await run(JSON.stringify({ networks: {} }), true)).toEqual([
      JSON.stringify({ networks: {}, booking: { lateCancellation: "refuse" } }),
    ]);
    expect(await run(JSON.stringify({ booking: 5 }), true)).toEqual([
      JSON.stringify({ booking: { lateCancellation: "refuse" } }),
    ]);
    expect(await run("not json", true)).toEqual(["not json"]);
    // An instance that has run on the defaults gets a row saying so; a fresh one gets nothing.
    expect(await run(null, true)).toEqual([JSON.stringify({ booking: { lateCancellation: "refuse" } })]);
    expect(await run(null, false)).toEqual([]);
  });
});
