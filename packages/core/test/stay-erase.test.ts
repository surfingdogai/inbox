import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PII_PATHS } from "../src/domain/types";
import { items } from "../src/schema/tables";
import type { Caller } from "../src/write/caller";
import { transitionItem } from "../src/write/index";
import { rowToItem } from "../src/write/views";
import { clock, contact, guest, ryokanHoshi, owner as stayOwner } from "./stay-fixtures";

/**
 * Erasing a guest (ADR-018's erasure, with ADR-037's stays): who was coming, what they asked for in
 * their own words, when they would arrive and their children's ages go from the stay and from its
 * history; its dates, rooms, adults, quote and state stay, and it still reads. Runs on Node and in workerd.
 */
const ownerInPerson: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => clock.now,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "user_1" },
};

describe("erasing a guest", () => {
  it("takes their guests' names, special requests, arrival window and children's ages off the stay and its history", async () => {
    clock.now = Date.parse("2026-11-02T01:00:00Z");
    const r = await ryokanHoshi();
    const made = await r.caps.stays.request(guest(), {
      check_in: "2026-12-12",
      check_out: "2026-12-15",
      rooms: [{ room_type_id: r.rooms.japanese, adults: 2, children_ages: [7] }],
      guests: { lead: { name: "Amara Okafor" }, others: [{ name: "Chidi Okafor" }] },
      arrival: { from: "21:00", to: "23:00" },
      requests: "Amara is seven months pregnant: a ground-floor room, please, and a late check-in.",
      contact,
      consent: true,
    });
    const id = made.view.item.id;
    // The owner quotes it, so the history holds a change too.
    await transitionItem(r.db, stayOwner, { itemId: id, event: "quote", input: { from: "rates" } });
    const party = made.view.item.partyId as string;
    const asked = await r.caps.customers.erase(ownerInPerson, { party_id: party }).catch((e) => e);
    expect(asked).toMatchObject({ code: "confirm_erase" });
    const done = await r.caps.customers.erase(ownerInPerson, { party_id: party, confirm: asked.details.confirm });
    expect(done).toMatchObject({ erased: true });

    const { rows } = await r.db.client.query({
      sql: "SELECT payload, subject FROM items WHERE id = ?",
      params: [id],
      method: "all",
    });
    const stored = `${String(rows[0]?.[0])} ${String(rows[0]?.[1])}`;
    const ev = await r.db.client.query({
      sql: "SELECT COALESCE(diff, ''), COALESCE(meta, '') FROM item_events WHERE item_id = ?",
      params: [id],
      method: "all",
    });
    const history = ev.rows.map((x) => `${x[0]} ${x[1]}`).join("\n");
    for (const words of [stored, history]) {
      expect(words).not.toMatch(/Amara|Chidi|pregnant|ground-floor/);
      expect(words).not.toMatch(/"arrival"|"guests"|"requests"|"childrenAges":\[7\]/);
    }

    // The structure stays, and the stay still reads.
    const [row] = await r.db.orm.select().from(items).where(eq(items.id, id));
    const item = rowToItem(row as never);
    expect(item.type).toBe("stay");
    if (item.type !== "stay") return;
    expect(item.state).toBe("quoted");
    expect(item.payload).toMatchObject({ checkIn: "2026-12-12", checkOut: "2026-12-15" });
    expect(item.payload.rooms).toEqual([expect.objectContaining({ roomTypeId: r.rooms.japanese, adults: 2 })]);
    expect(item.payload.rooms[0]?.childrenAges).toEqual([]);
    expect(item.payload.quote?.total).toBeDefined();
    // What the stay declares as a guest's own (PII_PATHS) is all gone.
    for (const key of PII_PATHS.stay.filter((k) => !k.startsWith("rooms.")))
      expect(item.payload).not.toHaveProperty(key);
  });
});
