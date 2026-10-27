import { describe, expect, it } from "vitest";
import { createRunner } from "../../src/jobs/index";
import { phonePushOneHandler } from "../../src/phones/jobs";
import { buildPushPayload, HELD_SOON_EVENT } from "../../src/phones/payload";
import { classPayload, DAY, HOUR, MIN, owner, spamSetup, T0, visitor } from "./harness";

/**
 * What the owner's phones hear of the spam filter (ADR-029 §12): nothing about what it holds or puts
 * aside, but once, without a name, of a booking request it holds for a time within 48 hours; and a
 * labelled request's title says what it may be, on a phone that shows details.
 */

type Setup = Awaited<ReturnType<typeof spamSetup>>;

const pitch = "Hello, we can get your café on the first page of Google with our SEO services. Reply for prices.";

async function heldByBot(s: Setup, t: number, contact: { name: string; email: string }, at?: number) {
  const b = await s.caps.createBooking(
    visitor(t),
    { payload: classPayload(s.svc, at), contact },
    { screen: { door: "form", form: { key: "none", trap: false } } },
  );
  return b.view.item.id;
}

describe("the phone, about held requests", () => {
  async function withPhone() {
    const s = await spamSetup();
    await s.db.client.query({
      sql: `INSERT INTO phone_devices (id, user_id, name, platform, key_jwk, key_thumbprint, notify, push_state, confirmed_at, created_at)
            VALUES ('ph_1', 'user_1', 'Pixel', 'android', '{}', 'tp_1', '{}', 'on', ?, ?)`,
      params: [T0 - DAY, T0 - DAY],
      method: "run",
    });
    const runner = createRunner({ mailOut: s.mail, secrets: null, spam: s.caps.spam, phones: s.caps.phones });
    const jobs = (kind: string) => s.q("SELECT payload FROM jobs WHERE kind = ? ORDER BY created_at", [kind]);
    return { s, runner, jobs };
  }

  it("tells it once of a booking request held for a time within 48 hours, and of nothing else held", async () => {
    const { s, runner, jobs } = await withPhone();
    const soon = await heldByBot(s, T0, { name: "Bot", email: "bot@example.net" }, T0 + 20 * HOUR);
    await heldByBot(s, T0, { name: "Bot", email: "bot@example.net" }, T0 + 5 * DAY);
    const queued = (await jobs("phone_push")).map((r) => JSON.parse(String(r[0])));
    expect(queued).toEqual([{ itemId: soon, event: HELD_SOON_EVENT, key: `held_soon:${soon}` }]);
    for (let i = 0; i < 5; i++) await runner.runDue(s.db, { now: T0 + MIN, limit: 50 });
    // The fanout queued it for the phone that listens; nothing about the other held one.
    const ones = (await jobs("phone_push_one")).map((r) => JSON.parse(String(r[0])));
    expect(ones.map((o) => [o.itemId, o.event])).toEqual([[soon, HELD_SOON_EVENT]]);
  });

  it("never names the sender or says their words, even on a phone that shows details", async () => {
    const s = await spamSetup();
    const soon = await heldByBot(s, T0, { name: "Scam Sender", email: "pay.now@scam.example.net" }, T0 + 20 * HOUR);
    const sent: Uint8Array[] = [];
    const phones = {
      listeners: async () => [{ id: "ph_1", notify: JSON.stringify({ details: true }) }],
      deliver: async (_device: string, bytes: Uint8Array) => {
        sent.push(bytes);
        return { note: "sent" };
      },
    } as unknown as Parameters<typeof phonePushOneHandler>[0];
    await phonePushOneHandler(phones)(
      {
        id: "j1",
        kind: "phone_push_one",
        payload: { deviceId: "ph_1", itemId: soon, event: HELD_SOON_EVENT },
      } as never,
      { db: s.db, now: T0 + MIN } as never,
    );
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(new TextDecoder().decode(sent[0]));
    expect(payload.title).toBe("A booking request for Tue 27 Oct is waiting in Held");
    expect(payload.who).toBeUndefined();
    expect(payload.text).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/Scam Sender|scam\.example/);
    // And the builder holds to it whatever it is handed.
    const built = buildPushPayload({
      item: (await s.caps.getItem(owner(T0), { item_id: soon })).item as never,
      kind: "booking",
      event: HELD_SOON_EVENT,
      details: true,
      who: "Scam Sender",
      text: "Pay the deposit at https://scam.example.net",
      timezone: "Asia/Jakarta",
      now: T0,
    });
    expect(built.who).toBeUndefined();
    expect(built.text).toBeUndefined();
  });

  it("says it without a name, and a labelled request with what it may be when details are on", () => {
    const base = {
      version: 1,
      partyId: "p",
      locationId: null,
      channel: "form",
      subject: null,
      linkedItemId: null,
      createdAt: "2026-10-26T09:00:00Z",
      updatedAt: "2026-10-26T09:00:00Z",
      closedAt: null,
    };
    const booking = {
      ...base,
      id: "01B",
      type: "booking",
      state: "requested",
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      payload: {
        reservationFor: { serviceId: "s", name: "Class" },
        startTime: "2026-10-27T08:00:00Z",
        endTime: "2026-10-27T09:00:00Z",
      },
    };
    const held = buildPushPayload({
      item: booking as never,
      kind: "booking",
      event: HELD_SOON_EVENT,
      details: false,
      who: null,
      timezone: "Asia/Jakarta",
      now: T0,
    });
    expect(held.title).toBe("A booking request for Tue 27 Oct is waiting in Held");
    expect(held.who).toBeUndefined();
    expect(held.action).toBeUndefined();
    const message = {
      ...base,
      id: "01M",
      type: "message",
      state: "open",
      flags: { needsHuman: true, sandbox: false, priority: 0, spamLabel: "pitches" },
      payload: { text: pitch },
    };
    const ctx = { item: message as never, kind: "message" as const, event: "create", timezone: "UTC", now: T0 };
    expect(buildPushPayload({ ...ctx, details: true, who: "Growth Team" }).title).toBe(
      "May be a sales pitch: New message",
    );
    expect(buildPushPayload({ ...ctx, details: false }).title).toBe("New message");
  });
});
