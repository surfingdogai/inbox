import { createApiKey, customerText } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay, nextDay, confirmed as sentConfirmed } from "./harness";

/**
 * Changes to what was agreed through the doors the app serves (ADR-018 §3.1, §6): the customer's
 * assistant asks to move a confirmed booking and the owner accepts; the owner asks for a change and
 * the customer keeps what was agreed from the email's link, then accepts the next one through their
 * assistant with the confirm step; the confirmation's link asks for another time from the free
 * times. Runs on Node and in workerd.
 */
const BASE = "https://inbox.test";
const DAY = futureDay();
const NEXT = nextDay(DAY);

async function setup() {
  const db = await freshDb();
  const now = Date.now();
  const svc = ulid();
  await db.orm.insert(schema.services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: now,
    updatedAt: now,
  });
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en"],
    createdAt: now,
    updatedAt: now,
  });
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "amendments-doors-test-secret-0123456789",
    background: () => {},
  });
  const key = await createApiKey(db, { kind: "owner", name: "t" });
  const owner = { authorization: `Bearer ${key.key}` };
  // A priced request is sent as the customer's assistant sends it once its person confirmed it.
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    sentConfirmed(
      (r) => inbox.app.request(r),
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await inbox.runner.runDue(db, { limit: 100 })).claimed === 0) return;
  };
  const lastMail = () => [...mail.sent].reverse().find((m) => m.to.includes("rita@example.com"))?.text ?? "";
  const submit = (path: string, form: Record<string, string>) =>
    inbox.app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
  return { db, svc, call, owner, drain, lastMail, submit, app: inbox.app };
}
type S = Awaited<ReturnType<typeof setup>>;

function linksIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, label, url] of text.matchAll(/^([^:\n]+): (https:\/\/inbox\.test\/c\/\S+)$/gm)) {
    if (label && url) out[label] = url.slice(BASE.length);
  }
  return out;
}

function formOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (name) out[name] = value ?? "";
  }
  return out;
}

/** A booking for DAY at 10:00 in Lisbon, made by the customer's assistant and confirmed by the owner. */
async function confirmed(s: S) {
  const created = await s.call("POST", "/v1/bookings", {
    payload: {
      reservationFor: { serviceId: s.svc, name: "Full service" },
      startTime: `${DAY}T09:00:00Z`,
      endTime: `${DAY}T10:30:00Z`,
    },
    contact: { name: "Rita", email: "rita@example.com" },
    idempotency_key: "booking-1",
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { view: { item: { id: string } }; accessToken: string };
  const id = body.view.item.id;
  const ok = await s.call("POST", `/v1/owner/items/${id}/transitions`, { event: "confirm" }, s.owner);
  expect(ok.status).toBe(200);
  await s.drain();
  return { id, q: `access_token=${body.accessToken}` };
}

describe("changes to what was agreed, through the doors", () => {
  it("the customer's assistant asks to move it; the owner accepts; the status shows what stands", async () => {
    const s = await setup();
    const b = await confirmed(s);
    // The confirmation carries the link to ask for another time.
    expect(Object.keys(linksIn(s.lastMail()))).toEqual(["Change the time"]);

    const asked = await s.call("POST", `/v1/items/${b.id}/offers?${b.q}`, {
      terms: { start_time: `${DAY}T13:00:00Z` },
      note: "The morning is hard for me.",
      idempotency_key: "change-1",
    });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({
      view: {
        item: { state: "confirmed", payload: { startTime: `${DAY}T09:00:00Z` } },
        waiting_on: "us",
        requested_change: { terms: { startTime: `${DAY}T13:00:00.000Z` } },
      },
    });
    const seen = (await (await s.call("GET", `/v1/owner/items/${b.id}`, undefined, s.owner)).json()) as {
      transitions: { event: string }[];
    };
    expect(seen.transitions.map((t) => t.event)).toContain("accept_change");
    const accepted = await s.call(
      "POST",
      `/v1/owner/items/${b.id}/transitions`,
      { event: "accept_change", idempotency_key: "accept-change-1" },
      s.owner,
    );
    expect(accepted.status).toBe(200);
    const status = (await (await s.call("GET", `/v1/items/${b.id}?${b.q}`)).json()) as {
      agreed: { terms: { startTime: string } };
      requested_change: unknown;
      offer: unknown;
    };
    expect(status).toMatchObject({
      agreed: { terms: { startTime: `${DAY}T13:00:00.000Z` } },
      requested_change: null,
      offer: null,
    });
    await s.drain();
    expect(s.lastMail()).toMatch(/Done: your booking "Full service" is now for /);
  });

  it("the owner asks for a change: kept as agreed from the link, then accepted with the confirm step", async () => {
    const s = await setup();
    const b = await confirmed(s);
    const ask = (at: string, key: string) =>
      s.call(
        "POST",
        `/v1/owner/items/${b.id}/offers`,
        { input: { startTime: at, note: "Our lift is out that morning." }, idempotency_key: key },
        s.owner,
      );
    expect((await ask(`${NEXT}T09:00:00Z`, "ask-1")).status).toBe(200);
    await s.drain();
    const text = s.lastMail();
    expect(text).toMatch(/Can we move your booking "Full service" from .* to .*\? If that does not suit you/);
    const links = linksIn(text);
    expect(Object.keys(links)).toEqual(["Accept the change", "Keep it as it is"]);

    const page = await (await s.app.request(`${BASE}${links["Keep it as it is"]}`)).text();
    expect(page).toContain("Keep it as it is?");
    const kept = await s.submit(links["Keep it as it is"] as string, formOf(page));
    expect(kept.status).toBe(303);
    const after = (await (await s.call("GET", `/v1/items/${b.id}?${b.q}`)).json()) as {
      item: { payload: { startTime: string; change?: unknown } };
      offer: unknown;
    };
    expect(after.item.payload.startTime).toBe(`${DAY}T09:00:00Z`);
    expect(after.item.payload.change).toBeUndefined();
    expect(after.offer).toBeNull();

    expect((await ask(`${NEXT}T10:00:00Z`, "ask-2")).status).toBe(200);
    const status = (await (await s.call("GET", `/v1/items/${b.id}?${b.q}`)).json()) as {
      offer: { id: string; kind: string; terms_sha: string };
      next: { action: string }[];
    };
    expect(status.offer.kind).toBe("change");
    expect(status.next.map((n) => n.action)).toEqual([
      "accept_offer",
      "decline_offer",
      "suggest_time",
      "cancel_item",
      "send_message",
    ]);
    const unconfirmed = await s.call("POST", `/v1/items/${b.id}/offers/${status.offer.id}/accept?${b.q}`, {});
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { code: string }).code).toBe("confirm_terms");
    const yes = await s.call("POST", `/v1/items/${b.id}/offers/${status.offer.id}/accept?${b.q}`, {
      terms_sha: status.offer.terms_sha,
      idempotency_key: "yes-1",
    });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toMatchObject({
      view: { item: { state: "confirmed", payload: { startTime: `${NEXT}T10:00:00.000Z` } } },
    });
    // What an assistant reads when only the text reaches it.
    expect(
      customerText({
        human: "We would like to move your booking.",
        offer: { ...(status.offer as object), expired: false, warnings: [] } as unknown as Parameters<
          typeof customerText
        >[0]["offer"],
        waiting_on: "you",
        next: [],
      }),
    ).toMatch(/decline_offer to keep what was agreed/);
  });

  it("the confirmation's link opens the free times and asks for one; the booking stays until we say yes", async () => {
    const s = await setup();
    const b = await confirmed(s);
    const pick = linksIn(s.lastMail())["Change the time"] as string;
    const page = await (await s.app.request(`${BASE}${pick}`)).text();
    expect(page).toContain("Change the time");
    const starts = [...page.matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1] as string);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts).not.toContain(`${DAY}T09:00:00.000Z`);
    const chosen = starts.find((t) => t.startsWith(NEXT)) ?? (starts[0] as string);
    const sent = await s.submit(pick, { ...formOf(page), start: chosen });
    expect(sent.status).toBe(303);
    const done = await (await s.app.request(`${BASE}${pick}`)).text();
    expect(done).toContain("We have your request to move");
    const status = (await (await s.call("GET", `/v1/items/${b.id}?${b.q}`)).json()) as {
      item: { payload: { startTime: string } };
      requested_change: { terms: { startTime: string } };
    };
    expect(status.item.payload.startTime).toBe(`${DAY}T09:00:00Z`);
    expect(status.requested_change.terms.startTime).toBe(chosen);
  });
});
