import { createApiKey } from "@surfingdog/adapters";
import { MANIFEST_PATH, type SetupPlanInput } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay, nextDay } from "./harness";

/**
 * A setup plan through the owner's REST door (`POST /v1/owner/setup/plan`), and a salon that had no
 * hours or services on its site, set up from one: a dry run says it in sentences and writes nothing,
 * applying it opens booking, an agent finds free times and asks to book, and the booking waits for
 * the owner, who is told. Runs on Node and in workerd.
 */
const BASE = "https://inbox.test";
const OWNER = "rosa@salaorosa.pt";
/** No credentials: what anyone, or any agent, sends. */
const PUBLIC: Record<string, string> = { "user-agent": "SomeAssistant/1.0" };

async function setup() {
  const db = await freshDb();
  const mail = logMailOut();
  const inbox = createInbox({
    db,
    mailOut: mail,
    baseUrl: BASE,
    secretKey: "setup-plan-test-secret-0123456789abc",
    background: () => {},
  });
  const key = await createApiKey(db, { kind: "owner", name: "cli" });
  /** As the owner's key, unless `headers` names another authorization, or `PUBLIC` for none. */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const auth = headers === PUBLIC ? {} : { authorization: `Bearer ${key.key}` };
    const r = await inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...auth, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: r.status, headers: r.headers, body: (await r.json()) as Record<string, unknown> };
  };
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      if ((await inbox.runner.runDue(db, { limit: 100, now: Date.now() + 2 * 60_000 })).claimed === 0) return;
    }
  };
  return { db, inbox, call, mail, drain };
}

/** A salon the check read only a name from: the owner picked the weekday hours and typed one service. */
const salon: SetupPlanInput = {
  profile: { name: "Salão Rosa", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
  directory: { listed: false, url: "" },
  hours: {
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]],
    fri: [["09:00", "18:00"]],
  },
  services: [{ name: "Corte", duration_min: 30 }],
  preset: "appointments",
  booking: { confirm: "owner" },
  doors: ["message", "quote_request", "booking"],
  sources: {
    "profile.name": {
      source_url: "https://salaorosa.pt/",
      checked_at: "2026-10-11T09:30:00Z",
      confidence: "declared",
    },
  },
};

describe("a setup plan through the owner's door", () => {
  it("answers a dry run in sentences, applies once, and is idempotent", async () => {
    const { call } = await setup();
    const dry = await call("POST", "/v1/owner/setup/plan?dry_run=true", salon);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, changed: true, doors: { missing: [] } });
    expect(dry.body.sentences).toEqual(
      expect.arrayContaining([
        "Read from salaorosa.pt on 11 Oct 2026.",
        "Adds the service Corte: 30 minutes, price on request.",
        "Sets the opening hours: Mon–Fri 09:00–18:00.",
        "You confirm each booking.",
      ]),
    );
    expect((await call("GET", "/v1/owner/services")).body.items).toEqual([]);

    const applied = await call("POST", "/v1/owner/setup/plan", salon, { "idempotency-key": "plan-1" });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ dry_run: false, changed: true, sentences: dry.body.sentences });
    const replayed = await call("POST", "/v1/owner/setup/plan", salon, { "idempotency-key": "plan-1" });
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    const again = await call("POST", "/v1/owner/setup/plan", salon);
    expect(again.body).toMatchObject({ changed: false });
    expect((await call("GET", "/v1/owner/services")).body.items).toHaveLength(1);
  });

  it("refuses a plan with products, and lets an integration key see what a plan would do but not apply it", async () => {
    const { db, call } = await setup();
    const refused = await call("POST", "/v1/owner/setup/plan", {
      products: [{ name: "Champô", price: { value: 900, currency: "EUR" } }],
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body.fields)).toContain("never holds products");
    const zap = await createApiKey(db, { kind: "integration", name: "Zapier", scopes: ["setup:run"] });
    const auth = { authorization: `Bearer ${zap.key}` };
    expect((await call("POST", "/v1/owner/setup/plan?dry_run=true", salon, auth)).status).toBe(200);
    const denied = await call("POST", "/v1/owner/setup/plan", salon, auth);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "not_allowed", details: { ask_owner: true } });
    expect((await call("GET", "/v1/owner/services")).body.items).toEqual([]);
  });

  it("applies a preset with the owner confirming: no rule that says yes on its own", async () => {
    const { call } = await setup();
    const r = await call("POST", "/v1/owner/rules/presets/appointments", { confirm: "owner" });
    expect(r.status).toBe(200);
    const rules = r.body.items as { definition: { actions: { action: string; event?: string }[] } }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.flatMap((x) => x.definition.actions).filter((a) => a.action === "transition")).toEqual([]);
  });
});

describe("a salon with no hours or services read, set up from a plan", () => {
  it("opens booking; an agent asks for a free time; the booking waits for the owner, who is told", async () => {
    const { call, mail, drain } = await setup();
    await call("PUT", "/v1/owner/settings", { doc: { notifications: { ownerEmail: OWNER } } });
    expect((await call("POST", "/v1/owner/setup/plan", salon)).status).toBe(200);

    const manifest = await call("GET", MANIFEST_PATH, undefined, PUBLIC);
    expect(manifest.body.item_types).toEqual(["message", "quote_request", "booking"]);
    const services = (await call("GET", "/v1/services", undefined, PUBLIC)).body.items as { id: string }[];
    const day = futureDay();
    const free = await call(
      "GET",
      `/v1/availability?service_id=${services[0]?.id}&from=${day}T00:00:00Z&to=${nextDay(day)}T00:00:00Z`,
      undefined,
      PUBLIC,
    );
    const slot = (free.body.slots as { startTime: string; endTime: string }[])[0];
    if (!slot) throw new Error("no free time");

    const asked = await call(
      "POST",
      "/v1/bookings",
      {
        payload: {
          reservationFor: { serviceId: services[0]?.id, name: "Corte" },
          startTime: slot.startTime,
          endTime: slot.endTime,
        },
        contact: { name: "Ana", email: "ana@example.com" },
      },
      PUBLIC,
    );
    expect(asked.status).toBe(201);
    const id = (asked.body.view as { item: { id: string } }).item.id;
    await drain();
    const item = (await call("GET", `/v1/owner/items/${id}`)).body as {
      item: { state: string; flags: { needsHuman: boolean } };
    };
    // Nothing confirmed it on its own: it waits for the owner.
    expect(item.item.state).toBe("requested");
    expect(item.item.flags.needsHuman).toBe(true);
    expect(mail.sent.some((m) => m.to.includes(OWNER))).toBe(true);
  });
});
