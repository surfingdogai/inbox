import { describe, expect, it } from "vitest";
import type { PayloadOf } from "../src/domain/types";
import { sweepStays } from "../src/stays/jobs";
import { transitionItem, type WriteError } from "../src/write/index";
import { clock, contact, guest, kijaniHouse, mapleHollow, owner } from "./stay-fixtures";

/**
 * Night claims (ADR-037 §4.2, §4.3): one unit per room per night under a primary key, so the last room
 * goes once whoever asks at the same moment; holds lapse and let go; a booking makes its claims the
 * stay's for good.
 */
type StayPayload = PayloadOf<"stay">;

async function claims(db: Awaited<ReturnType<typeof kijaniHouse>>["db"], itemId: string) {
  const { rows } = await db.client.query({
    sql: "SELECT night, ordinal, hold_until FROM night_claims WHERE item_id = ? ORDER BY night, ordinal",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => [String(r[0]), Number(r[1]), r[2] === null ? null : Number(r[2])]);
}

describe("night claims", () => {
  it("two guests accepting quotes for the last room at once: exactly one stay is confirmed", async () => {
    clock.now = Date.parse("2026-11-02T06:00:00Z");
    const k = await kijaniHouse();
    // One unit left: the other is taken by an owner's own stay.
    await k.db.client.query({
      sql: "UPDATE room_types SET units = 1 WHERE id = ?",
      params: [k.rooms.garden],
      method: "run",
    });
    const ask = async (name: string) => {
      const made = await k.caps.stays.request(guest(), {
        check_in: "2026-12-12",
        check_out: "2026-12-14",
        rooms: [{ room_type_id: k.rooms.garden, adults: 2 }],
        contact: { ...contact, name, email: `${name.toLowerCase()}@example.org` },
        consent: true,
      });
      await transitionItem(k.db, owner, { itemId: made.view.item.id, event: "quote", input: { from: "rates" } });
      const sha = await transitionItem(k.db, guest({ accessToken: made.accessToken as string }), {
        itemId: made.view.item.id,
        event: "accept",
      })
        .then(() => "")
        .catch((e: WriteError) => (e.details as { terms_sha: string }).terms_sha);
      return { id: made.view.item.id, token: made.accessToken as string, sha };
    };
    const a = await ask("Ama");
    const b = await ask("Baraka");
    const results = await Promise.allSettled(
      [a, b].map((x) =>
        transitionItem(k.db, guest({ accessToken: x.token }), {
          itemId: x.id,
          event: "accept",
          input: { terms_sha: x.sha },
        }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "slot_taken" });
  });

  it("a hold lapses on its own and lets go: another guest can hold the room after the sweep", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const hold = () =>
      m.caps.stays.hold(guest(), {
        check_in: "2026-12-04",
        check_out: "2026-12-06",
        rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
        contact,
        consent: true,
      });
    const first = await hold();
    expect(first.view.item.state).toBe("held");
    const until = Date.parse((first.view.item.payload as StayPayload).hold?.until ?? "");
    expect(until - clock.now).toBe(20 * 60_000);
    expect((await claims(m.db, first.view.item.id)).map((c) => c[2])).toEqual([until, until]);
    // The one room kept is held: nobody else is offered it now.
    const second = await hold().catch((e: WriteError) => e);
    expect((second as WriteError).code).toBe("guard_failed");
    clock.now = until + 1;
    const swept = await sweepStays(m.db, clock.now);
    expect(swept.moved).toBe(1);
    expect(await claims(m.db, first.view.item.id)).toEqual([]);
    const third = await hold();
    expect(third.view.item.state).toBe("held");
  });

  it("booking makes the claims the stay's for good", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const held = await m.caps.stays.hold(guest(), {
      check_in: "2026-12-04",
      check_out: "2026-12-06",
      rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
      contact,
      consent: true,
    });
    await m.caps.stays.book(guest({ accessToken: held.accessToken as string }), {
      item_id: held.view.item.id,
      terms_sha: held.terms_sha,
    });
    expect((await claims(m.db, held.view.item.id)).map((c) => c[2])).toEqual([null, null]);
  });

  it("ten guests holding the one room kept for direct guests at the same moment: one hold", async () => {
    clock.now = Date.parse("2026-11-02T13:00:00Z");
    const m = await mapleHollow();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        m.caps.stays.hold(guest(), {
          check_in: "2026-12-10",
          check_out: "2026-12-12",
          rooms: [{ room_type_id: m.rooms.harbour, adults: 2 }],
          contact: { ...contact, email: `guest${i}@example.org` },
          consent: true,
        }),
      ),
    );
    const held = results.filter((r) => r.status === "fulfilled" && r.value.view.item.state === "held");
    expect(held).toHaveLength(1);
    const { rows } = await m.db.client.query({
      sql: "SELECT COUNT(DISTINCT item_id) FROM night_claims WHERE room_type_id = ? AND night = '2026-12-10'",
      params: [m.rooms.harbour],
      method: "all",
    });
    expect(Number(rows[0]?.[0])).toBe(1);
  });
});
