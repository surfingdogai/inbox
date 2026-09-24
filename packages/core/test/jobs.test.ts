import { logMailOut, runMigrations } from "@surfingdog/platform";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { backoffMs, createRunner, JobRunner, LEASE_MS } from "../src/jobs/index";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { jobs, outboundMail, services, users } from "../src/schema/tables";
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
    expect(first).toEqual({ claimed: 2, done: 0, failed: 1, dead: 1, released: 0 });
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
    expect(await runner.runDue(db, { now: T0 + 1_000 })).toEqual({
      claimed: 0,
      done: 0,
      failed: 0,
      dead: 0,
      released: 0,
    });
    const second = await runner.runDue(db, { now: T0 + backoffMs(1) + 1 });
    expect(second).toEqual({ claimed: 2, done: 0, failed: 1, dead: 1, released: 0 }); // flaky dies at attempt 2; "later" (no handler, 8 attempts) requeues
    expect(calls).toBe(2);
  });

  it("runs each lane beside the others, and hands back what a lane had no time to start", async () => {
    const db = await setup();
    const row = (kind: string, lane: string, n: number) => ({
      id: ulid(),
      kind,
      payload: { network: lane, n },
      runAt: T0,
      createdAt: T0,
    });
    await db.orm
      .insert(jobs)
      .values([
        row("slow", "a", 1),
        row("slow", "a", 2),
        row("slow", "a", 3),
        row("fast", "b", 1),
        row("plain", "", 1),
      ]);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const lane = (p: unknown) =>
      (p as { network: string }).network ? `lane:${(p as { network: string }).network}` : undefined;
    const runner = new JobRunner({ laneBudgetMs: 30 })
      // The slow lane waits for the fast lane to have run, then takes longer than its budget.
      .register(
        "slow",
        async (job) => {
          await gate;
          await new Promise((r) => setTimeout(r, 40));
          order.push(`slow ${(job.payload as { n: number }).n}`);
          return undefined;
        },
        { lane },
      )
      .register(
        "fast",
        async () => {
          order.push("fast");
          release();
          return undefined;
        },
        { lane },
      )
      .register("plain", async () => {
        order.push("plain");
        return undefined;
      });
    const report = await runner.runDue(db, { now: T0 });
    expect(order).toContain("fast");
    expect(order).toContain("plain");
    expect(order.filter((o) => o.startsWith("slow"))).toHaveLength(1);
    expect(report).toEqual({ claimed: 5, done: 3, failed: 0, dead: 0, released: 2 });
    const left = await db.orm.select({ status: jobs.status, attempts: jobs.attempts, kind: jobs.kind }).from(jobs);
    expect(left.filter((j) => j.status === "queued")).toEqual([
      { status: "queued", attempts: 0, kind: "slow" },
      { status: "queued", attempts: 0, kind: "slow" },
    ]);
  });

  it("puts what a lane handed back behind the jobs already waiting, so a backlog cannot take every slot", async () => {
    const db = await setup();
    const lane = (p: unknown) => {
      const network = (p as { network?: string }).network;
      return network ? `lane:${network}` : undefined;
    };
    // A slow lane with a backlog bigger than one claim, queued before anything else. (One row per
    // insert: D1 takes at most 100 bound values in a statement.)
    for (const row of [
      ...Array.from({ length: 12 }, (_, n) => ({
        id: ulid(),
        kind: "slow",
        payload: { network: "a", n },
        runAt: T0 - 60_000 + n,
        createdAt: T0,
      })),
      { id: ulid(), kind: "plain", payload: {}, runAt: T0 - 1_000, createdAt: T0 },
      { id: ulid(), kind: "other", payload: { network: "b" }, runAt: T0 - 500, createdAt: T0 },
    ]) {
      await db.orm.insert(jobs).values(row);
    }
    const ran = new Map<string, number>();
    let run = 0;
    const runner = new JobRunner({ laneBudgetMs: 20 })
      .register(
        "slow",
        async () => {
          await new Promise((r) => setTimeout(r, 25));
          return undefined;
        },
        { lane },
      )
      .register(
        "other",
        async () => {
          ran.set("other", ran.get("other") ?? run);
          return undefined;
        },
        { lane },
      )
      .register("plain", async () => {
        ran.set("plain", ran.get("plain") ?? run);
        return undefined;
      });
    for (run = 0; run < 12 && ran.size < 2; run++) {
      await runner.runDue(db, { now: T0 + run * 1_000, limit: 5 });
    }
    // One run of the backlog, then the two that were waiting: not the whole backlog first.
    expect(ran.get("plain")).toBeLessThanOrEqual(3);
    expect(ran.get("other")).toBeLessThanOrEqual(3);
  });

  it("never leaves a run waiting on a run that stopped without finishing", async () => {
    // On Workers a run belongs to the invocation that started it, and stops for good when that one
    // ends: its promise never settles. Nothing after it may be stuck behind it.
    const db = await setup();
    await db.orm.insert(jobs).values({ id: ulid(), kind: "stuck", payload: {}, runAt: T0, createdAt: T0 });
    let wall = 1_000_000;
    let started = 0;
    // The first attempt stops for good; a later one finishes.
    const runner = new JobRunner({ clock: () => wall }).register("stuck", () => {
      started++;
      return started === 1 ? new Promise(() => {}) : Promise.resolve(undefined);
    });
    const within = <T>(p: Promise<T>, what: string) =>
      Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer: ${what}`)), 2_000))]);
    void runner.runDue(db, { now: T0 });
    while (started === 0) await new Promise((r) => setTimeout(r, 1));
    // A caller that awaits its run (a cron tick, a queue batch) gets one of its own at once. The stuck
    // job's lease still holds, so there is nothing for it to claim.
    expect(await within(runner.runDue(db, { now: T0 + 1_000, join: false }), "a run of its own")).toEqual({
      claimed: 0,
      done: 0,
      failed: 0,
      dead: 0,
      released: 0,
    });
    // Once a lease has passed, a joining caller starts a new run too, rather than waiting for ever,
    // and the job the stopped run held is claimed again.
    wall += LEASE_MS;
    await db.orm.insert(jobs).values({ id: ulid(), kind: "fine", payload: {}, runAt: T0, createdAt: T0 });
    runner.register("fine", async () => undefined);
    const after = await within(runner.runDue(db, { now: T0 + LEASE_MS + 1_000 }), "a run after the lease");
    expect(after).toEqual({ claimed: 2, done: 2, failed: 0, dead: 0, released: 0 });
    expect(started).toBe(2);
  });

  it("notifies the owner and the customer by email after a booking is created and confirmed", async () => {
    const db = await setup();
    const svc = ulid();
    await db.orm.insert(services).values({
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
    // The acknowledgement falls due after the confirmation went out, and is not sent: one email, not two.
    await runner.runDue(db, { now: T0 + 2 * 60_000 });
    const toCustomer = mail.sent.find((m) => m.to[0] === "rita@example.com");
    expect(toCustomer?.subject).toBe("Confirmed: Full service");
    expect(toCustomer?.replyTo).toBe("hello@oficinamare.pt");
    expect(toCustomer?.from).toEqual({ address: "inbox@oficinamare.pt", name: "Oficina Maré" });
    expect(mail.sent.filter((m) => m.to[0] === "rita@example.com")).toHaveLength(1);
    const left = await db.orm.select({ status: jobs.status }).from(jobs);
    expect(left.every((j) => j.status === "done")).toBe(true);
  });

  it("tells the owner at the address they sign in with when they gave none, and says so when there is none", async () => {
    const db = await setup();
    const svc = ulid();
    await db.orm.insert(services).values({
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
      doc: { business: { name: "Oficina Maré" }, email: { fromAddress: "inbox@oficinamare.pt" } },
    });
    const mail = logMailOut();
    const runner = createRunner({ mailOut: mail });
    const customer: Caller = {
      actor: { kind: "customer_human", id: "form", channel: "form" },
      tier: "anonymous",
      sandbox: false,
      now: () => T0,
    };
    const book = (hour: number) =>
      caps.createBooking(customer, {
        payload: {
          reservationFor: { serviceId: svc, name: "Full service" },
          startTime: `2026-09-22T${hour}:00:00Z`,
          endTime: `2026-09-22T${hour}:30:00Z`,
        },
        contact: { name: "Rita Amaral", email: "rita@example.com" },
      });
    // Nobody has signed in, and no address was given: the email is not sent, and the row says why.
    const first = await book(10);
    await runner.runDue(db, { now: T0 });
    expect(mail.sent).toEqual([]);
    const [skipped] = await db.orm
      .select({ status: outboundMail.status, reason: outboundMail.skipReason })
      .from(outboundMail)
      .where(and(eq(outboundMail.itemId, first.view.item.id), eq(outboundMail.recipient, "owner")));
    expect(skipped).toEqual({ status: "skipped", reason: "no_address" });
    // The owner signs in: their address is where they hear of the next request.
    await db.orm.insert(users).values([
      { id: "u1", email: "ana@oficinamare.pt", role: "owner", createdAt: T0 },
      { id: "u2", email: "rui@oficinamare.pt", role: "owner", createdAt: T0 + 1 },
    ]);
    await book(12);
    await runner.runDue(db, { now: T0 + 1 });
    expect(mail.sent.map((m) => [m.to[0], m.subject])).toEqual([
      ["ana@oficinamare.pt", "New booking from Rita Amaral: Full service"],
    ]);
    // An address the owner gave wins.
    await caps.updateSettings(owner, { doc: { notifications: { ownerEmail: "hello@oficinamare.pt" } } });
    await book(14);
    await runner.runDue(db, { now: T0 + 2 });
    expect(mail.sent.at(-1)?.to).toEqual(["hello@oficinamare.pt"]);
  });
});
