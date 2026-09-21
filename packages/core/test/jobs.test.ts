import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { backoffMs, createRunner, JobRunner } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { jobs, services } from "../src/schema/tables";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return db;
}

describe("JobRunner", () => {
  it("claims due jobs, retries with backoff, and gives up after max attempts", async () => {
    const db = await setup();
    await db.orm.insert(jobs).values([
      { id: ulid(), kind: "flaky", payload: { n: 1 }, runAt: T0, maxAttempts: 2, createdAt: T0 },
      { id: ulid(), kind: "later", payload: {}, runAt: T0 + 60_000, createdAt: T0 },
      { id: ulid(), kind: "unknown_kind", payload: {}, runAt: T0, maxAttempts: 1, createdAt: T0 },
    ]);
    let calls = 0;
    const runner = new JobRunner().register("flaky", async () => {
      calls++;
      throw new Error("boom");
    });
    const first = await runner.runDue(db, { now: T0 });
    expect(first).toEqual({ claimed: 2, done: 0, failed: 1, dead: 1 });
    expect(calls).toBe(1);
    const rows = await db.orm
      .select({ kind: jobs.kind, status: jobs.status, runAt: jobs.runAt, lastError: jobs.lastError })
      .from(jobs);
    const flaky = rows.find((r) => r.kind === "flaky");
    expect(flaky?.status).toBe("queued");
    expect(flaky?.runAt).toBe(T0 + backoffMs(1));
    expect(rows.find((r) => r.kind === "unknown_kind")?.status).toBe("dead");
    expect(rows.find((r) => r.kind === "later")?.status).toBe("queued");
    // Too early for the retry.
    expect(await runner.runDue(db, { now: T0 + 1_000 })).toEqual({ claimed: 0, done: 0, failed: 0, dead: 0 });
    const second = await runner.runDue(db, { now: T0 + backoffMs(1) + 1 });
    expect(second).toEqual({ claimed: 2, done: 0, failed: 1, dead: 1 }); // flaky dies at attempt 2; "later" (no handler, 8 attempts) requeues
    expect(calls).toBe(2);
  });

  it("notifies the owner and the customer by email after a booking is created and confirmed", async () => {
    const db = await setup();
    const svc = ulid();
    await db.orm
      .insert(services)
      .values({
        id: svc,
        name: "Full service",
        durationMin: 90,
        capacity: 1,
        granularityMin: 30,
        createdAt: T0,
        updatedAt: T0,
      });
    const caps = new Capabilities(db);
    const owner: Caller = {
      actor: { kind: "owner", id: "u1", channel: "owner_ui" },
      tier: "verified_principal",
      sandbox: false,
      now: () => T0,
    };
    await caps.updateSettings(owner, {
      doc: {
        business: { name: "Oficina Maré" },
        notifications: { ownerEmail: "hello@oficinamare.pt", appUrl: "https://app.example" },
        email: { fromAddress: "inbox@oficinamare.pt", replyTo: "hello@oficinamare.pt" },
      },
    });
    const mail = logMailOut();
    const runner = createRunner({ mailOut: mail });
    const customer: Caller = {
      actor: { kind: "customer_human", id: "form", channel: "form" },
      tier: "anonymous",
      sandbox: false,
      now: () => T0,
    };
    const created = await caps.createBooking(customer, {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-22T08:00:00Z",
        endTime: "2026-09-22T09:30:00Z",
      },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
    });
    expect(await runner.runDue(db, { now: T0 })).toMatchObject({ claimed: 2, done: 2 });
    expect(mail.sent.map((m) => [m.to[0], m.subject])).toEqual([
      ["hello@oficinamare.pt", "New booking from Rita Amaral: Full service"],
    ]);
    expect(mail.sent[0]?.text).toContain("https://app.example/items/");

    await caps.transitionItem(owner, { item_id: created.view.item.id, event: "confirm" });
    await runner.runDue(db, { now: T0 + 1 });
    const toCustomer = mail.sent.find((m) => m.to[0] === "rita@example.com");
    expect(toCustomer?.subject).toBe("Confirmed: Full service");
    expect(toCustomer?.replyTo).toBe("hello@oficinamare.pt");
    expect(toCustomer?.from).toEqual({ address: "inbox@oficinamare.pt", name: "Oficina Maré" });
    const left = await db.orm.select({ status: jobs.status }).from(jobs);
    expect(left.every((j) => j.status === "done")).toBe(true);
  });
});
