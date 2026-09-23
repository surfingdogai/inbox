import { createDb, MIGRATIONS, readSettings, schema, ulid } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { makeClient } from "./harness";

/**
 * People and customers (ADR-017 §8), as a live instance meets them on upgrade: its parties become
 * customers the business knows — the verified ones at once, the rest by a resumable job — its
 * items keep answering with no identity columns set, its settings gain the new sections as
 * defaults, and a new customer with a known address is a weak match. Runs on Node and in workerd.
 */
const INBOX = "https://inbox.surfingdog.ai";
const T0 = Date.parse("2026-09-20T09:00:00Z");

describe("upgrading to people and customers", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("keeps every party and item, fills their contacts, and a second run changes nothing", async () => {
    const client = await makeClient();
    expect(
      await runMigrations(
        client,
        MIGRATIONS.filter((m) => m.name < "0009_identity"),
      ),
    ).toBe(9);
    const db = createDb(client);
    const contact = (email: string, phone?: string) =>
      JSON.stringify({ name: "Ana Silva", email, ...(phone ? { phone } : {}) });
    await client.batch([
      {
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 3, ?)",
        params: [JSON.stringify({ notifications: { appUrl: INBOX } }), T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, display_name, contact, created_at, updated_at) VALUES ('party_1', 'human', 'Ana Silva', ?, ?, ?)",
        params: [contact("Ana@Example.PT", "+351 912 345 678"), T0, T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, contact, created_at, updated_at) VALUES ('party_2', 'agent', ?, ?, ?)",
        params: [contact("bruno@example.pt"), T0 + 1, T0 + 1],
        method: "run",
      },
      // Never written by a release, but a hand-made row keeps its verified badge.
      {
        sql: "INSERT INTO party_identities (id, party_id, kind, value_normalized, verified_at, created_at) VALUES ('pi_1', 'party_2', 'email', 'bruno@example.pt', ?, ?)",
        params: [T0 + 2, T0 + 2],
        method: "run",
      },
      {
        sql: "INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, access_token_hash, created_at, updated_at) VALUES ('item_1', 'message', 'open', 1, 'party_1', 'form', ?, ?, NULL, ?, ?)",
        params: [
          JSON.stringify({ text: "hello" }),
          JSON.stringify({ needsHuman: false, sandbox: false, priority: 0 }),
          T0,
          T0,
        ],
        method: "run",
      },
    ]);

    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    // The verified row is there at once; the rest waits for the job the migration queued.
    const before = await client.query({
      sql: "SELECT party_id, kind, value, verified_at FROM party_contacts",
      method: "all",
    });
    expect(before.rows).toEqual([["party_2", "email", "bruno@example.pt", T0 + 2]]);
    const queued = await client.query({ sql: "SELECT kind, status FROM jobs", method: "all" });
    expect(queued.rows).toEqual([["party_contacts_backfill", "queued"]]);

    const inbox = createInbox({
      db,
      baseUrl: INBOX,
      secretKey: "upgrade-identity-instance-key-0123456789",
      background: () => {},
    });
    for (let i = 0; i < 10; i++) {
      const r = await inbox.runner.runDue(db, { now: Date.now() + 60_000, limit: 100 });
      expect(r.failed + r.dead).toBe(0);
      if (r.claimed === 0) break;
    }
    const after = await client.query({
      sql: "SELECT party_id, kind, value, verified_at IS NOT NULL FROM party_contacts ORDER BY party_id, kind",
      method: "all",
    });
    expect(after.rows).toEqual([
      ["party_1", "email", "ana@example.pt", 0],
      ["party_1", "phone", "351912345678", 0],
      ["party_2", "email", "bruno@example.pt", 1],
    ]);

    // Nothing the owner never chose changes; the new sections read as their defaults.
    const settings = await readSettings(db);
    expect(settings.identity).toEqual({ extraAuthorities: [] });
    expect(settings.customers).toEqual({
      otp: { ttlMinutes: 10, attempts: 5, sendsPerHour: 3, sendsPerDay: 5, guessesPerDay: 10 },
      emailKey: true,
    });
    expect(settings.notifications.appUrl).toBe(INBOX);

    // An item from before has no identity columns, and the owner still reads it.
    const detail = await inbox.caps.getItem(
      { actor: { kind: "owner", id: "u1", channel: "owner_ui" }, tier: "verified_principal", sandbox: false },
      { item_id: "item_1" },
    );
    expect(detail.customer).toMatchObject({ match: null, possible: null, known: false });

    // A new customer giving the known address is a weak match naming the party from before.
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Massage",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await inbox.caps.createBooking(
      { actor: { kind: "customer_human", id: "form", channel: "form" }, tier: "anonymous", sandbox: false },
      {
        payload: {
          reservationFor: { serviceId: svc, name: "Massage" },
          startTime: "2026-10-01T10:00:00Z",
          endTime: "2026-10-01T11:00:00Z",
        },
        contact: { email: "ana@example.pt" },
      },
    );
    expect(r.identity).toMatchObject({ recognised: "weak", verify: { available: true, sent_to: null } });
    const [row] = (
      await client.query({
        sql: "SELECT possible_party_id FROM items WHERE id = ?",
        params: [r.view.item.id],
        method: "all",
      })
    ).rows;
    expect(row).toEqual(["party_1"]);
  });
});
