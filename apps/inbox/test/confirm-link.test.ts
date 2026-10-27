import { createApiKey } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { LOCAL_SENDER, type MailOut, type OutboundMail } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, openWeekdays } from "./harness";

/**
 * "Confirm it's me" (ADR-041 §3.3), through the whole app: every acknowledgement to someone new
 * carries it; opening the link changes nothing; pressing its button proves the address and lets a
 * request held for an uncertain reason go on; and a bot's request gets no acknowledgement at all, so
 * a forged address is never written to. Runs on Node and in workerd.
 */

const BASE = "https://inbox.example.org";
/**
 * The inbox's clock, a day ahead of the real one: ids are made in time order, and a clock behind the
 * real one would write what it queues at the real time, past what the test runs.
 */
const clock = { t: Date.now() + 86_400_000 };

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Bengkel Sari",
    domain: "bengkelsari.example",
    timezone: "Asia/Makassar",
    currency: "IDR",
    languages: ["id", "en"],
    createdAt: clock.t,
    updatedAt: clock.t,
  });
  await db.orm.insert(schema.services).values({
    id: "svc_tune",
    name: "Bike tune-up",
    durationMin: 60,
    capacity: 3,
    granularityMin: 30,
    createdAt: clock.t,
    updatedAt: clock.t,
  });
  await openWeekdays(db);
  const sent: OutboundMail[] = [];
  const mailOut: MailOut = {
    sender: LOCAL_SENDER,
    async send(mail) {
      sent.push(mail);
      return { messageId: `m${sent.length}` };
    },
  };
  const inbox = createInbox({
    db,
    mailOut,
    baseUrl: BASE,
    secretKey: "confirm-link-test-secret-0123456789abc",
    background: () => {},
    now: () => clock.t,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  await inbox.app.request(
    new Request(`${BASE}/v1/owner/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        doc: {
          email: { fromAddress: "halo@bengkelsari.example" },
          notifications: { ownerEmail: "owner@bengkelsari.example" },
        },
      }),
    }),
  );
  const drain = async () => {
    for (let i = 0; i < 20; i++)
      if ((await inbox.runner.runDue(db, { now: clock.t, limit: 100 })).claimed === 0) return;
  };
  return { db, app: inbox.app, sent, drain };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A weekday at 02:00 UTC (10:00 in Makassar), more than two days after the clock. */
const slot = (() => {
  const d = new Date(clock.t + 3 * 86_400_000);
  d.setUTCHours(2, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
})();
const start = new Date(slot).toISOString();
const end = new Date(slot + 3_600_000).toISOString();

async function book(s: S, email: string, i: number, message?: string) {
  const r = await s.app.request(
    new Request(`${BASE}/v1/bookings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `198.51.100.${i + 1}`,
        "idempotency-key": `b-${email}-${i}`,
      },
      body: JSON.stringify({
        payload: { reservationFor: { serviceId: "svc_tune", name: "Bike tune-up" }, startTime: start, endTime: end },
        contact: { name: "Rudi Hartono", email },
        ...(message ? { message } : {}),
      }),
    }),
  );
  expect(r.status).toBe(201);
  return (await r.json()) as { view: { item: { id: string } }; identity: { confirm?: { sent_to: string } | null } };
}

const rowsOf = async (s: S, sql: string, params: string[] = []) =>
  (await s.db.client.query({ sql, params, method: "all" })).rows;
const screenOf = async (s: S, id: string) => (await rowsOf(s, "SELECT screen FROM items WHERE id = ?", [id]))[0]?.[0];
const toOwner = (s: S) => s.sent.filter((m) => m.to.includes("owner@bengkelsari.example"));

describe("confirm it's me", () => {
  it("rides in every acknowledgement to someone new, held or not, so it tells nobody anything", async () => {
    const s = await setup();
    const plain = await book(s, "rudi.h@example.co.id", 0);
    const odd = await book(s, "rudi@bengkelsarl.example", 1, "https://bengkelsarl.example/voucher");
    expect(await screenOf(s, plain.view.item.id)).toBe("delivered");
    expect(await screenOf(s, odd.view.item.id)).toBe("held");
    // The create answers have the same shape: each says where the link went.
    expect(plain.identity.confirm).toEqual({ sent_to: "r•••@e•••.id" });
    expect(odd.identity.confirm?.sent_to).toMatch(/^r•••@b•••\.example$/);
    clock.t += 2 * 60_000;
    await s.drain();
    const acks = s.sent.filter((m) => !m.to.includes("owner@bengkelsari.example"));
    expect(acks.map((m) => m.to[0]).sort()).toEqual(["rudi.h@example.co.id", "rudi@bengkelsarl.example"]);
    for (const m of acks) {
      expect(m.subject).toBe("We have your booking request");
      expect(m.text).toContain("Please confirm it's you, so we know your request reached the right person.");
      expect(m.text).toMatch(/Confirm it's me: https:\/\/\S+/);
    }
    // The owner heard of the one that came in, and not of the held one.
    expect(toOwner(s)).toHaveLength(1);
  });

  it("changes nothing when opened; its button proves the address and lets the held request go on, once", async () => {
    const s = await setup();
    const odd = await book(s, "rudi@bengkelsarl.example", 1, "https://bengkelsarl.example/voucher");
    const held = odd.view.item.id;
    clock.t += 2 * 60_000;
    await s.drain();
    const ack = s.sent.find((m) => m.to.includes("rudi@bengkelsarl.example")) as OutboundMail;
    const path = new URL(/Confirm it's me: (https:\/\/\S+)/.exec(ack.text)?.[1] as string).pathname;
    // Opening the link, as a mail scanner does, changes nothing.
    for (let i = 0; i < 3; i++) {
      const page = await s.app.request(new Request(`${BASE}${path}`));
      expect(page.status).toBe(200);
    }
    const html = await (await s.app.request(new Request(`${BASE}${path}`))).text();
    expect(html.replaceAll("&#39;", "'")).toContain("Confirm it's me");
    expect(await screenOf(s, held)).toBe("held");
    expect(
      await rowsOf(s, "SELECT proven_at FROM spam_handles WHERE kind = 'mailbox' AND proven_at IS NOT NULL"),
    ).toHaveLength(0);
    expect(toOwner(s)).toHaveLength(0);
    const fields = Object.fromEntries(
      [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]),
    );
    const press = () =>
      s.app.request(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
          body: new URLSearchParams(fields as Record<string, string>).toString(),
        }),
      );
    expect((await press()).status).toBe(303);
    const done = (await (await s.app.request(new Request(`${BASE}${path}`))).text()).replaceAll("&#39;", "'");
    expect(done).toContain("Thank you, that's confirmed. We'll be in touch.");
    expect(await screenOf(s, held)).toBe("released");
    expect(await rowsOf(s, "SELECT released_by FROM spam_verdicts WHERE item_id = ?", [held])).toEqual([["sender"]]);
    expect(await rowsOf(s, "SELECT kind FROM spam_handles WHERE proven_at IS NOT NULL")).toEqual([["mailbox"]]);
    await s.drain();
    // The owner hears of it now, once, however often the button is pressed.
    await press();
    await s.drain();
    expect(toOwner(s)).toHaveLength(1);
    // Proving the address let that one request go on. The sender's next one is screened as before,
    // with wider budgets: its look-alike address labels it, as it would anyone's (ADR-041 §5).
    const next = await book(s, "rudi@bengkelsarl.example", 2, "Could you also check the brakes?");
    expect(await screenOf(s, next.view.item.id)).toBe("warned");
  });

  it("is never sent for a bot's request, and does not release one held for a certain reason", async () => {
    const s = await setup();
    const r = await s.app.request(
      new Request(`${BASE}/p/book`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.200" },
        body: new URLSearchParams({
          service: "svc_tune",
          start,
          name: "x",
          email: "victim@example.net",
          k: "",
        }).toString(),
      }),
    );
    expect(r.status).toBe(303);
    const [item] = await rowsOf(
      s,
      "SELECT i.id, i.screen, v.cause FROM items i JOIN spam_verdicts v ON v.item_id = i.id",
    );
    expect(item?.slice(1)).toEqual(["held", "no_key"]);
    clock.t += 2 * 60_000;
    await s.drain();
    // No acknowledgement, so a forged address is never written to.
    expect(s.sent.filter((m) => m.to.includes("victim@example.net"))).toHaveLength(0);
    expect(toOwner(s)).toHaveLength(0);
  });
});
