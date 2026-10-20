import { addLocalDays, dateIn, transitionItem } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import type { stripePlatform } from "./pay-platforms";
import { at, HOUR, OWNER, ok, type Setup, setup } from "./stay-harness";

/**
 * Stays' pay links (ADR-033 §5.4) on the property's own Stripe: one live link per stay and entry, the
 * deposit's closed when its window closes; a payment landing after that takes the nights again when
 * they are still free and is owed back when they are not, never refunded here; the balance's own link
 * in the days before it is due; and a card to hold a stay, a page in setup mode made when it is opened.
 */
type S = Setup & { stripe: ReturnType<typeof stripePlatform> };

async function kyoto(opts: { deposit?: unknown; balance?: unknown; guarantee?: "card"; units?: number } = {}) {
  const s = (await setup({ name: "Ryokan Hoshi", timezone: "Asia/Tokyo", currency: "JPY" })) as S;
  const conn = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/integrations", { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } }),
    201,
  );
  await ok(
    s.owner("PUT", "/v1/owner/property", {
      name: "Ryokan Hoshi",
      kind: "ryokan",
      currency: "JPY",
      check_in_from: "15:00",
      check_out_until: "10:00",
    }),
  );
  const room = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/property/rooms", {
      name: "Japanese room",
      units: opts.units ?? 1,
      capacity: { adults: 2, children: 0, total: 2 },
    }),
  );
  if (opts.guarantee) {
    await s.inbox.caps.connectors.payments.setGuarantees(conn.id, true, Date.now());
  }
  const plan = await ok<{ id: string }>(
    s.owner("POST", "/v1/owner/property/rate-plans", {
      name: "Flexible",
      policy: { preset: "free_until", days: 3, after: "first_night", no_show: "full" },
      deposit: opts.deposit ?? { kind: "first_night" },
      ...(opts.balance ? { balance: opts.balance } : {}),
      ...(opts.guarantee ? { guarantee: opts.guarantee } : {}),
    }),
  );
  await ok(
    s.owner("PUT", "/v1/owner/property/rates", {
      rate_plan_id: plan.id,
      room_type_id: room.id,
      nightly: 25_800,
      base_guests: 2,
    }),
  );
  return { s, room: room.id, conn: conn.id };
}

/** A request quoted from the rates and accepted on the terms shown: the stay waiting for what is due now. */
async function accepted(s: S, room: string, checkIn: string, nights = 3, email = "maria@example.org") {
  const made = await ok<{ view: { item: { id: string } }; accessToken: string }>(
    s.guest("POST", "/v1/stays", {
      check_in: checkIn,
      check_out: addLocalDays(checkIn, nights),
      rooms: [{ room_type_id: room, adults: 2 }],
      contact: { name: "Maria A.", email },
      consent: true,
    }),
    201,
  );
  const id = made.view.item.id;
  await ok(s.owner("POST", `/v1/owner/items/${id}/transitions`, { event: "quote", input: { from: "rates" } }));
  const asked = await s.guest("POST", `/v1/items/${id}/accept`, { access_token: made.accessToken });
  const sha = ((await asked.json()) as { details: { terms_sha: string } }).details.terms_sha;
  const r = await ok<{ view: { item: { state: string } } }>(
    s.guest("POST", `/v1/items/${id}/accept`, { access_token: made.accessToken, terms_sha: sha }),
  );
  await s.drain();
  return { id, token: made.accessToken, state: r.view.item.state };
}

async function links(s: S, itemId: string) {
  const { rows } = await s.db.client.query({
    sql: "SELECT schedule_id, purpose, state, amount, expires_at FROM connector_payments WHERE item_id = ? ORDER BY created_at, rowid",
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    scheduleId: String(r[0]),
    purpose: String(r[1]),
    state: String(r[2]),
    amount: Number(r[3]),
    expiresAt: r[4] === null ? null : Number(r[4]),
  }));
}

async function state(s: S, id: string) {
  return (await ok<{ item: { state: string } }>(s.owner("GET", `/v1/owner/items/${id}`))).item.state;
}

const ahead = (s: S, days: number) => addLocalDays(dateIn(s.clock.now, "Asia/Tokyo"), days);

describe("stays' pay links", () => {
  it("makes one link for the deposit, closes it with its window, and lets the stay lapse", async () => {
    const { s, room, conn } = await kyoto();
    const stay = await accepted(s, room, ahead(s, 30));
    expect(stay.state).toBe("awaiting_payment");
    const [link] = await links(s, stay.id);
    expect(link).toMatchObject({ scheduleId: "deposit", purpose: "deposit", state: "open", amount: 25_800 });
    expect(link?.expiresAt).toBeGreaterThan(s.clock.now + 23 * HOUR);
    // Not paid in time: the stay lapses, the link closes, on Stripe too.
    s.clock.now = (link?.expiresAt ?? 0) + 60_000;
    await s.drain();
    await s.inbox.caps.connectors.run(conn, s.clock.now, "sync");
    expect(await state(s, stay.id)).toBe("expired");
    expect((await links(s, stay.id))[0]?.state).toBe("closed");
    expect([...s.stripe.links.values()][0]?.active).toBe(false);
  });

  it("takes a payment that lands late while the nights are still free, and confirms the stay", async () => {
    const { s, room } = await kyoto();
    const stay = await accepted(s, room, ahead(s, 30));
    const [made] = [...s.stripe.links.values()];
    await transitionItem(
      s.db,
      { ...at(s, { kind: "system", id: "sweep", channel: "system" }), now: () => Date.now() + 25 * HOUR },
      { itemId: stay.id, event: "expire" },
    );
    expect(await state(s, stay.id)).toBe("expired");
    const hook = await s.inbox.app.request(await s.stripe.pay(made?.id ?? ""));
    expect(hook.status).toBe(200);
    expect(await state(s, stay.id)).toBe("confirmed");
  });

  it("owes back a payment that lands late when the nights went to someone else: never refunded here", async () => {
    const { s, room } = await kyoto();
    const checkIn = ahead(s, 30);
    const first = await accepted(s, room, checkIn);
    const [made] = [...s.stripe.links.values()];
    await transitionItem(
      s.db,
      { ...at(s, { kind: "system", id: "sweep", channel: "system" }), now: () => Date.now() + 25 * HOUR },
      { itemId: first.id, event: "expire" },
    );
    // Another guest takes the last room and pays.
    const second = await accepted(s, room, checkIn, 3, "kenji@example.org");
    expect(second.state).toBe("awaiting_payment");
    const secondLink = [...s.stripe.links.values()].at(-1);
    await s.inbox.app.request(await s.stripe.pay(secondLink?.id ?? ""));
    expect(await state(s, second.id)).toBe("confirmed");
    // The first guest's payment lands after all.
    await s.inbox.app.request(await s.stripe.pay(made?.id ?? ""));
    expect(await state(s, first.id)).toBe("expired");
    const refunds = await ok<{
      items: { item: { type: string; state: string; linkedItemId: string; payload: { amount: { value: number } } } }[];
    }>(s.owner("GET", "/v1/owner/items?type=refund&open_only=false"));
    expect(refunds.items.map((r) => [r.item.linkedItemId, r.item.state, r.item.payload.amount.value])).toEqual([
      [first.id, "approved", 25_800],
    ]);
    const { rows } = await s.db.client.query({
      sql: "SELECT body_text FROM thread_entries WHERE item_id = ? AND direction = 'note'",
      params: [first.id],
      method: "all",
    });
    expect(rows.map((r) => String(r[0])).join("\n")).toMatch(
      /^Refund .*25,800 in .+ Nothing is refunded automatically\.$/m,
    );
  });

  it("asks for the balance with its own link in the days before it is due", async () => {
    const { s, room } = await kyoto({
      deposit: { kind: "percent", value: 20 },
      balance: { when: "days_before", days: 7 },
      units: 2,
    });
    const checkIn = ahead(s, 30);
    const stay = await accepted(s, room, checkIn);
    const [deposit] = [...s.stripe.links.values()];
    await s.inbox.app.request(await s.stripe.pay(deposit?.id ?? ""));
    expect(await state(s, stay.id)).toBe("confirmed");
    expect((await links(s, stay.id)).map((l) => l.scheduleId)).toEqual(["deposit"]);
    // Nine days before arrival (two before the balance is due): its link is made, for what is left.
    const nineBefore = Date.parse(`${addLocalDays(checkIn, -9)}T01:00:00Z`);
    await s.inbox.caps.connectors.payments.ensure(stay.id, nineBefore);
    const balance = (await links(s, stay.id)).find((l) => l.scheduleId === "balance");
    expect(balance).toMatchObject({ purpose: "balance", state: "open", amount: 77_400 - 15_480 });
  });

  it("holds a stay with a card saved in setup mode on the property's Stripe, made when the guest opens the link", async () => {
    const { s, room } = await kyoto({ deposit: { kind: "none" }, guarantee: "card" });
    const stay = await accepted(s, room, ahead(s, 30));
    expect(stay.state).toBe("awaiting_payment");
    const current = async () => (await s.inbox.caps.getItem(at(s, OWNER), { item_id: stay.id })).item;
    expect((await s.inbox.caps.stays.terms(await current(), "en", Date.now()))?.card).toBe("requested");
    const opened = await s.inbox.caps.stays.openCard(
      await current(),
      "en",
      "https://inbox.example.com/c/back",
      Date.now(),
    );
    expect(opened).toMatchObject({ url: expect.stringMatching(/^https:\/\//) });
    const session = [...s.stripe.sessions.values()].at(-1);
    expect(session).toMatchObject({ mode: "setup" });
    s.stripe.saveCard(String(session?.id));
    expect(await s.inbox.caps.stays.checkCard(await current(), Date.now())).toBe(true);
    expect(await state(s, stay.id)).toBe("confirmed");
  });
});
