import {
  appendThreadEntry,
  type Caller,
  Capabilities,
  createItem,
  createSecretBox,
  type Db,
  DEFAULT_SETTINGS,
  JobRunner,
  matchesEvent,
  type RunReport,
  type SecretBox,
  schema,
  setFlags,
  transitionItem,
  ulid,
  WebhookCapabilities,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  buildEvent,
  DELIVER_JOB_MAX_ATTEMPTS,
  deliverDedupeKey,
  MAX_DELIVERY_ATTEMPTS,
  MAX_ENDPOINTS_PER_EVENT,
  matchesSubscription,
  newWebhookSecret,
  RETRY_SCHEDULE_MS,
  readEvent,
  retryAt,
  signedContent,
  signedHeaders,
  signWebhook,
  splitSecrets,
  verifyWebhook,
  WEBHOOK_DELIVERY_KIND,
  WEBHOOK_FANOUT_KIND,
  webhookDeliverHandler,
  webhookFanoutHandler,
  webhookSettings,
} from "../src/webhooks/index";
import { freshDb } from "./db";

const T0 = Date.parse("2026-09-21T10:00:00Z");
const KEY = "test-instance-key-0123456789abcdef";

const customer = (now: number): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => now,
});
const owner = (now: number): Caller => ({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => now,
});
/** A fake receiver: answers with the programmed status and records exactly what arrived. */
function receiver(reply: (call: number, url: string) => number | Promise<number>) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), body: String(init?.body ?? ""), headers });
    const status = await reply(calls.length, String(input));
    return new Response(status >= 200 && status < 300 ? null : "no thanks", { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function addEndpoint(
  db: Db,
  box: SecretBox,
  opts: { url: string; events: string[]; style?: "thin" | "full"; failingSince?: number | null },
): Promise<{ id: string; secret: string }> {
  const id = ulid();
  const secret = newWebhookSecret();
  await db.client.query({
    sql: "INSERT INTO webhooks (id, url, secret_enc, events, payload_style, active, failing_since, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
    params: [
      id,
      opts.url,
      await box.seal("webhook-secret", id, secret),
      JSON.stringify(opts.events),
      opts.style ?? "thin",
      opts.failingSince ?? null,
      T0,
      T0,
    ],
    method: "run",
  });
  return { id, secret };
}

function runnerWith(deps: { secrets: SecretBox | null; fetchImpl?: typeof fetch }): JobRunner {
  return new JobRunner()
    .register(WEBHOOK_FANOUT_KIND, webhookFanoutHandler())
    .register(
      WEBHOOK_DELIVERY_KIND,
      webhookDeliverHandler({
        secrets: deps.secrets,
        version: "0.0.0",
        baseUrl: "https://inbox.example.com",
        fetchImpl: deps.fetchImpl,
      }),
    )
    .register("notify", async () => undefined)
    .register("rules", async () => undefined);
}

/**
 * Fanout writes the delivery jobs, so the delivery itself happens on the next pass: the runner
 * claims what was due when it started, which is exactly how the outbox behaves in production.
 */
async function drain(runner: JobRunner, db: Db, now: number): Promise<RunReport> {
  const total = { claimed: 0, done: 0, failed: 0, dead: 0, released: 0 };
  for (let pass = 0; pass < 6; pass++) {
    const r = await runner.runDue(db, { now });
    total.claimed += r.claimed;
    total.done += r.done;
    total.failed += r.failed;
    total.dead += r.dead;
    total.released += r.released;
    if (r.claimed === 0) break;
  }
  return total;
}

const rows = async (db: Db, sql: string, params: readonly (string | number | null)[] = []) =>
  (await db.client.query({ sql, params, method: "all" })).rows;

const deliveries = (db: Db) =>
  rows(
    db,
    "SELECT id, webhook_id, event_type, status, attempts, next_at, last_status, last_error FROM webhook_deliveries ORDER BY id",
  );

const jobsOf = (db: Db, kind: string) =>
  rows(db, "SELECT id, dedupe_key, run_at, status, max_attempts FROM jobs WHERE kind = ? ORDER BY run_at, id", [kind]);

const message = (text = "Do you deliver to Setúbal?") => ({
  type: "message" as const,
  payload: { text, subject: "Delivery" },
  contact: { name: "Rita Amaral", email: "rita@example.com" },
});

describe("standard webhooks signatures", () => {
  it("reproduces the published Standard Webhooks test vector", async () => {
    // From the Standard Webhooks specification itself. If this line ever changes, an off-the-shelf
    // verifier in any language stops agreeing with us, which is the entire reason for the format.
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const payload = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330, body: '{"test": 2432232314}' };
    expect(signedContent(payload)).toBe('msg_p5jXN8AQM9LWM0D4loKWxJek.1614265330.{"test": 2432232314}');
    expect(await signWebhook(secret, payload)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifies what it signs, refuses a tampered body, an old timestamp and a foreign secret", async () => {
    const secret = newWebhookSecret();
    const payload = { id: ulid(T0), timestamp: Math.floor(T0 / 1000), body: '{"hello":"world"}' };
    const signature = await signWebhook(secret, payload);
    expect(await verifyWebhook(secret, { ...payload, signature }, { now: T0 })).toEqual({ ok: true });
    expect(await verifyWebhook(secret, { ...payload, body: '{"hello":"mars"}', signature }, { now: T0 })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verifyWebhook(newWebhookSecret(), { ...payload, signature }, { now: T0 })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verifyWebhook(secret, { ...payload, signature }, { now: T0 + 3_600_000 })).toEqual({
      ok: false,
      reason: "timestamp",
    });
  });

  it("sends both signatures during a rotation, so either secret verifies", async () => {
    const fresh = newWebhookSecret();
    const old = newWebhookSecret();
    const payload = { id: ulid(T0), timestamp: Math.floor(T0 / 1000), body: "{}" };
    const signature = await signWebhook([fresh, old], payload);
    expect(signature.split(" ")).toHaveLength(2);
    expect(signature.startsWith(`${await signWebhook(fresh, payload)} `)).toBe(true);
    expect(await verifyWebhook(old, { ...payload, signature }, { now: T0 })).toEqual({ ok: true });
    expect(await verifyWebhook(fresh, { ...payload, signature }, { now: T0 })).toEqual({ ok: true });
  });

  it("matches subscriptions exactly, by prefix and by wildcard — and never by accident", () => {
    expect(matchesSubscription(["booking.confirm"], "booking.confirm")).toBe(true);
    expect(matchesSubscription(["booking.*"], "booking.confirm")).toBe(true);
    expect(matchesSubscription(["*"], "order.create")).toBe(true);
    expect(matchesSubscription(["booking.*"], "order.create")).toBe(false);
    expect(matchesSubscription([], "order.create")).toBe(false);
    expect(matchesSubscription(["booking"], "booking.confirm")).toBe(false);
  });

  /**
   * `*.create` is a pattern the input schema accepts and `replayMissing` honours. A fanout that
   * did not honour it would refuse to send an event and then agree to replay the very same one —
   * so the two must be one function, and this is the case that proves it.
   */
  it("is the same rule the owner capability replays by, `*.create` and all", () => {
    for (const [patterns, type, expected] of [
      [["*.create"], "order.create", true],
      [["*.create"], "order.confirm", false],
      [["*.message"], "booking.message", true],
      [["booking.*", "*.create"], "refund.create", true],
      [["*"], "booking.flags", true],
    ] as const) {
      expect(matchesSubscription([...patterns], type), `${patterns.join("|")} vs ${type}`).toBe(expected);
      expect(matchesEvent([...patterns], type), `${patterns.join("|")} vs ${type}`).toBe(expected);
    }
  });
});

describe("fanout", () => {
  it("writes nothing at all when no endpoint is active", async () => {
    const { db } = await freshDb();
    const created = await createItem(db, customer(T0), message());
    expect(await jobsOf(db, WEBHOOK_FANOUT_KIND)).toHaveLength(0);

    // And the handler itself, asked directly, refuses to invent work.
    const runner = runnerWith({ secrets: createSecretBox([KEY]) });
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 8, ?)",
      params: [
        ulid(T0),
        WEBHOOK_FANOUT_KIND,
        JSON.stringify({ eventId: (await firstEventId(db, created.view.item.id)) ?? ulid(T0) }),
        T0,
        T0,
      ],
      method: "run",
    });
    await drain(runner, db, T0);
    expect(await deliveries(db)).toHaveLength(0);
    expect(await jobsOf(db, WEBHOOK_DELIVERY_KIND)).toHaveLength(0);
  });

  it("turns one event into one delivery and one job per subscribed endpoint, and no more", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    const a = await addEndpoint(db, box, { url: "https://hooks.example.com/a", events: ["*"] });
    const b = await addEndpoint(db, box, { url: "https://hooks.example.com/b", events: ["message.*"] });
    await addEndpoint(db, box, { url: "https://hooks.example.com/c", events: ["booking.confirm"] });

    await createItem(db, customer(T0), message());
    const fanout = await jobsOf(db, WEBHOOK_FANOUT_KIND);
    expect(fanout).toHaveLength(1);

    const net = receiver(() => 200);
    const runner = runnerWith({ secrets: box, fetchImpl: net.fetchImpl });
    await drain(runner, db, T0);

    const rowsOut = await deliveries(db);
    expect(rowsOut).toHaveLength(2);
    expect(new Set(rowsOut.map((r) => String(r[1])))).toEqual(new Set([a.id, b.id]));
    expect(rowsOut.every((r) => String(r[2]) === "message.create")).toBe(true);
    expect(await jobsOf(db, WEBHOOK_DELIVERY_KIND)).toHaveLength(2);
    expect(net.calls.map((c) => c.url).sort()).toEqual(["https://hooks.example.com/a", "https://hooks.example.com/b"]);
  });

  /**
   * `events_v1` shows a flag change as `<type>.flags` whether or not an endpoint exists, so the
   * cursor has always carried it. A subscriber has to see the same event: a rule raising
   * "needs a human" is exactly the moment an integration is for.
   */
  it("fans out a flag change, the way the cursor already showed one", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/a", events: ["message.flags"] });
    const created = await createItem(db, customer(T0), message());
    await setFlags(db, owner(T0 + 1_000), {
      itemId: created.view.item.id,
      flags: { needsHuman: true },
      reason: "a rule raised it",
    });

    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0 + 1_000);
    const out = await deliveries(db);
    expect(out.map((r) => String(r[2]))).toEqual(["message.flags"]);
    expect(out.map((r) => String(r[3]))).toEqual(["delivered"]);
    expect(JSON.parse(net.calls[0]?.body ?? "{}")).toMatchObject({ type: "message.flags" });
  });

  /**
   * The cap stands — an endpoint list is a list, not a broadcast tree — but a fanout that drops an
   * endpoint says so. The runner persists the note on the job row, so the evidence outlives the run.
   */
  it("names the endpoints it dropped when more subscribe than the cap allows", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    for (let i = 0; i <= MAX_ENDPOINTS_PER_EVENT; i++) {
      await addEndpoint(db, box, { url: `https://hooks.example.com/${i}`, events: ["*"] });
    }
    await createItem(db, customer(T0), message());
    const [fanout] = await jobsOf(db, WEBHOOK_FANOUT_KIND);
    const payload = String(
      (await rows(db, "SELECT payload FROM jobs WHERE id = ?", [String(fanout?.[0])]))[0]?.[0] ?? "{}",
    );
    const note = (
      await webhookFanoutHandler()(
        {
          id: String(fanout?.[0]),
          kind: WEBHOOK_FANOUT_KIND,
          payload: JSON.parse(payload),
          attempts: 1,
          maxAttempts: 8,
        },
        { db, now: T0 },
      )
    )?.note;
    expect(await deliveries(db)).toHaveLength(MAX_ENDPOINTS_PER_EVENT);
    expect(note).toContain(`1 over the ${MAX_ENDPOINTS_PER_EVENT} cap, not delivered`);
  });

  it("is idempotent: running the same fanout twice writes the same two rows", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/a", events: ["*"] });
    await addEndpoint(db, box, { url: "https://hooks.example.com/b", events: ["*"] });
    await createItem(db, customer(T0), message());
    const [fanout] = await jobsOf(db, WEBHOOK_FANOUT_KIND);
    const payload = String(
      (await rows(db, "SELECT payload FROM jobs WHERE id = ?", [String(fanout?.[0])]))[0]?.[0] ?? "{}",
    );

    const handler = webhookFanoutHandler();
    const job = {
      id: String(fanout?.[0]),
      kind: WEBHOOK_FANOUT_KIND,
      payload: JSON.parse(payload),
      attempts: 1,
      maxAttempts: 8,
    };
    const first = await handler(job, { db, now: T0 });
    const after = await deliveries(db);
    const second = await handler(job, { db, now: T0 + 1_000 });
    expect(first?.note).toBe(second?.note);
    expect(await deliveries(db)).toEqual(after);
    expect(await jobsOf(db, WEBHOOK_DELIVERY_KIND)).toHaveLength(2);
  });
});

describe("delivery", () => {
  it("retries on the published schedule and stops at the last attempt, without ever throwing", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/down", events: ["*"] });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 500);
    const runner = runnerWith({ secrets: box, fetchImpl: net.fetchImpl });

    let now = T0;
    const gaps: number[] = [];
    // The handler records failures; it never raises them, so nothing ever fails or dies here.
    expect(await drain(runner, db, now)).toMatchObject({ failed: 0, dead: 0 });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      const [row] = await deliveries(db);
      if (!row || String(row[3]) !== "pending") break;
      const next = Number(row[5]);
      gaps.push(next - now);
      expect(next).toBe(retryAt(now, Number(row[4]), String(row[0])));
      now = next;
      expect(await drain(runner, db, now)).toMatchObject({ failed: 0, dead: 0 });
    }

    const [final] = await deliveries(db);
    expect(String(final?.[3])).toBe("failed");
    expect(Number(final?.[4])).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(final?.[5]).toBeNull();
    expect(Number(final?.[6])).toBe(500);
    expect(net.calls).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(net.calls.map((c) => c.headers["sdi-delivery-attempt"])).toEqual(
      Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, i) => String(i + 1)),
    );
    // Each gap is its scheduled interval plus at most a tenth of jitter.
    for (const [i, gap] of gaps.entries()) {
      const base = RETRY_SCHEDULE_MS[i + 1] ?? 0;
      expect(gap).toBeGreaterThanOrEqual(base);
      expect(gap).toBeLessThanOrEqual(base * 1.1);
    }
    // And a delivery job is our-bug-only: the runner's own backoff barely applies.
    expect((await jobsOf(db, WEBHOOK_DELIVERY_KIND)).every((j) => Number(j[4]) === DELIVER_JOB_MAX_ATTEMPTS)).toBe(
      true,
    );
  });

  /**
   * A replay starts the attempt count over at zero, so its successor jobs are keyed the same way
   * the first chain's were. Unless the old keys go, `INSERT OR IGNORE` swallows the successor and
   * the delivery stalls after one attempt, advertising a next_attempt_at that never arrives — in
   * exactly the case replay exists for, an endpoint that already burned its attempts.
   */
  it("gives a replayed delivery its whole retry chain back, not one attempt", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/down", events: ["*"] });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 500);
    const runner = runnerWith({ secrets: box, fetchImpl: net.fetchImpl });

    // Burn the first chain to the end, so `whsend:<id>:1` is sitting in `jobs`, done.
    let now = T0;
    await drain(runner, db, now);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      const [row] = await deliveries(db);
      if (!row || String(row[3]) !== "pending") break;
      now = Number(row[5]);
      await drain(runner, db, now);
    }
    const [spent] = await deliveries(db);
    const deliveryId = String(spent?.[0]);
    expect(String(spent?.[3])).toBe("failed");
    expect(await jobsOf(db, WEBHOOK_DELIVERY_KIND)).toHaveLength(MAX_DELIVERY_ATTEMPTS);

    // The address is fixed and the owner replays. The receiver is still down for one more attempt.
    now += 60_000;
    await new WebhookCapabilities(db, box).replayDelivery(owner(now), { delivery_id: deliveryId });
    expect((await jobsOf(db, WEBHOOK_DELIVERY_KIND)).some((j) => String(j[1]).startsWith("whsend:"))).toBe(false);
    await drain(runner, db, now);

    const [replayed] = await deliveries(db);
    expect(String(replayed?.[3])).toBe("pending");
    expect(Number(replayed?.[4])).toBe(1);
    const queued = await jobsOf(db, WEBHOOK_DELIVERY_KIND);
    expect(queued.some((j) => j[1] === deliverDedupeKey(deliveryId, 1) && String(j[3]) === "queued")).toBe(true);

    // And the chain really runs on: the second attempt happens rather than being swallowed.
    await drain(runner, db, Number(replayed?.[5]));
    expect(Number((await deliveries(db))[0]?.[4])).toBe(2);
  });

  it("counts a redirect as a failure and never follows it", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/moved", events: ["*"] });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 302);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0);

    const [row] = await deliveries(db);
    expect(String(row?.[3])).toBe("pending");
    expect(Number(row?.[4])).toBe(1);
    expect(Number(row?.[6])).toBe(302);
    expect(String(row?.[7])).toContain("302");
    expect(net.calls).toHaveLength(1);
  });

  it("marks a 2xx delivered, clears the endpoint's failing run, and never sends it again", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    const ep = await addEndpoint(db, box, { url: "https://hooks.example.com/ok", events: ["*"], failingSince: T0 - 1 });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 204);
    const runner = runnerWith({ secrets: box, fetchImpl: net.fetchImpl });
    await drain(runner, db, T0);

    const [row] = await deliveries(db);
    expect(String(row?.[3])).toBe("delivered");
    expect(Number(row?.[4])).toBe(1);
    expect(row?.[5]).toBeNull();
    const [endpoint] = await rows(db, "SELECT failing_since, last_error, active FROM webhooks WHERE id = ?", [ep.id]);
    expect(endpoint?.[0]).toBeNull();
    expect(endpoint?.[1]).toBeNull();

    // Replaying the same job (a lease that outlived its run, a manual requeue) sends nothing.
    await db.client.query({
      sql: "UPDATE jobs SET status = 'queued', run_at = ?, lease_until = NULL WHERE kind = ?",
      params: [T0 + 60_000, WEBHOOK_DELIVERY_KIND],
      method: "run",
    });
    await drain(runner, db, T0 + 60_000);
    expect(net.calls).toHaveLength(1);
  });

  it("signs every request so an off-the-shelf verifier accepts it", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    const ep = await addEndpoint(db, box, { url: "https://hooks.example.com/ok", events: ["message.create"] });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0);

    const call = net.calls[0];
    if (!call) throw new Error("nothing was delivered");
    expect(call.headers["user-agent"]).toBe("surfingdog-inbox/0.0.0");
    expect(call.headers["sdi-event-type"]).toBe("message.create");
    expect(call.headers["webhook-timestamp"]).toBe(String(Math.floor(T0 / 1000)));
    expect(String(call.headers["webhook-signature"]).startsWith("v1,")).toBe(true);
    const verified = await verifyWebhook(
      ep.secret,
      {
        id: call.headers["webhook-id"] ?? "",
        timestamp: Number(call.headers["webhook-timestamp"]),
        body: call.body,
        signature: call.headers["webhook-signature"] ?? "",
      },
      { now: T0 },
    );
    expect(verified).toEqual({ ok: true });
    expect(JSON.parse(call.body).id).toBe(call.headers["webhook-id"]);
  });

  it("deactivates an endpoint that has done nothing but fail, and keeps every delivery", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    const ep = await addEndpoint(db, box, {
      url: "https://hooks.example.com/gone",
      events: ["*"],
      failingSince: T0 - 6 * 86_400_000,
    });
    await createItem(db, customer(T0), message());
    const net = receiver(() => 500);
    const runner = runnerWith({ secrets: box, fetchImpl: net.fetchImpl });
    await drain(runner, db, T0);

    const [endpoint] = await rows(db, "SELECT active, disabled_at, last_error FROM webhooks WHERE id = ?", [ep.id]);
    expect(Number(endpoint?.[0])).toBe(0);
    expect(Number(endpoint?.[1])).toBe(T0);
    expect(String(endpoint?.[2])).toContain("500");
    const [row] = await deliveries(db);
    expect(row).toBeDefined();
    expect(String(row?.[3])).toBe("failed");
    expect(row?.[5]).toBeNull(); // nothing is scheduled against a sleeping endpoint
    expect(net.calls).toHaveLength(1);

    // A later event is not even fanned out to it, and the delivery log stays where it is.
    await createItem(db, customer(T0 + 1_000), message("Still there?"));
    await drain(runner, db, T0 + 1_000);
    expect(await deliveries(db)).toHaveLength(1);
  });
});

describe("payload styles", () => {
  it("a thin body carries a pointer and no customer data; a full one carries the item and the party", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/thin", events: ["*"], style: "thin" });
    await addEndpoint(db, box, { url: "https://hooks.example.com/full", events: ["*"], style: "full" });
    const created = await createItem(db, customer(T0), message("Do you deliver to Setúbal?"));
    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0);

    const thin = JSON.parse(net.calls.find((c) => c.url.endsWith("/thin"))?.body ?? "{}");
    const full = JSON.parse(net.calls.find((c) => c.url.endsWith("/full"))?.body ?? "{}");
    const id = created.view.item.id;

    expect(Object.keys(thin).sort()).toEqual(["data", "id", "timestamp", "type"]);
    expect(thin.type).toBe("message.create");
    expect(thin.timestamp).toBe(new Date(T0).toISOString());
    // Who caused it, through which door, and whether it is test traffic — but never who the
    // customer is: a customer's actor id is a fingerprint and is not given out.
    expect(thin.data).toEqual({
      id,
      type: "message",
      state: "open",
      version: 1,
      url: `https://inbox.example.com/v1/owner/items/${id}`,
      actor: { kind: "customer_human", id: null },
      channel: "form",
      sandbox: false,
    });
    const thinText = JSON.stringify(thin);
    expect(thinText).not.toContain("rita@example.com");
    expect(thinText).not.toContain("Rita Amaral");
    expect(thinText).not.toContain("Setúbal");

    expect(full.id).toBe(thin.id);
    expect(full.data.url).toBe(thin.data.url);
    expect(full.data.item.payload.text).toContain("Setúbal");
    expect(full.data.party.email).toBe("rita@example.com");
    expect(full.data.party.name).toBe("Rita Amaral");
  });

  it("a full message event carries the message itself", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/full", events: ["message.message"], style: "full" });
    const created = await createItem(db, customer(T0), message());
    // The customer writes back: an inbound thread entry is its own event in `events_v1`.
    await appendThreadEntry(db, customer(T0 + 2_000), created.view.item, "Then I will order on Friday.", "in");

    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0 + 2_000);
    const body = JSON.parse(net.calls[0]?.body ?? "{}");
    expect(body.type).toBe("message.message");
    expect(body.data.message.body).toBe("Then I will order on Friday.");
    expect(body.data.message.direction).toBe("in");
  });

  it("builds both bodies straight from the event view", async () => {
    const { db } = await freshDb();
    const created = await createItem(db, customer(T0), message());
    const eventId = await firstEventId(db, created.view.item.id);
    const event = await readEvent(db, eventId ?? "");
    if (!event) throw new Error("no event");
    const thin = await buildEvent(db, event, "thin", "https://inbox.example.com/");
    expect((thin.data as Record<string, unknown>).url).toBe(
      `https://inbox.example.com/v1/owner/items/${created.view.item.id}`,
    );
    const full = await buildEvent(db, event, "full", "https://inbox.example.com");
    expect((full.data as Record<string, { email?: string }>).party?.email).toBe("rita@example.com");
  });
});

describe("receipt events (ADR-016)", () => {
  /** A booking to earn a receipt on: one service, one confirmed request. */
  async function confirmedBooking(db: Db) {
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const created = await createItem(db, customer(T0), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-23T08:00:00Z",
        endTime: "2026-09-23T09:30:00Z",
        totalPrice: { value: 4500, currency: "EUR" },
      },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
    });
    return created.view.item.id;
  }

  it("delivers the issue and the acknowledgement, with the receipt in the full body", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/full", events: ["booking.*"], style: "full" });
    const caps = new Capabilities(db, box, "https://inbox.example.com", 0);
    const itemId = await confirmedBooking(db);

    const issued = await caps.receipts.issue(itemId, "confirmed", T0 + 1_000);
    if (issued.outcome !== "issued") throw new Error(`expected issued, got ${issued.outcome}`);
    const receipt = issued.receipt;

    // The fanout job was written under the receipt's id, and the view resolves it.
    expect((await jobsOf(db, WEBHOOK_FANOUT_KIND)).map((r) => r[1])).toContain(`fanout:${receipt.id}`);
    const event = await readEvent(db, receipt.id);
    expect(event).toMatchObject({ type: "booking.receipt_issued", itemId, source: "receipt" });
    if (!event) throw new Error("no event");
    const full = await buildEvent(db, event, "full", "https://inbox.example.com");
    const data = full.data as { receipt?: { id: string; jws: string; acknowledged_at: string | null }; item?: unknown };
    expect(data.receipt).toMatchObject({ id: receipt.id, jws: receipt.jws, acknowledged_at: null });
    expect(data.item).toBeDefined();
    // The thin style stays a pointer: no receipt, no customer. A receipt is issued by the system.
    const thinReceipt = (await buildEvent(db, event, "thin", "https://inbox.example.com")).data as Record<
      string,
      unknown
    >;
    expect(Object.keys(thinReceipt)).toEqual(["id", "type", "state", "version", "url", "actor", "channel", "sandbox"]);
    expect(thinReceipt.actor).toEqual({ kind: "system", id: null });

    // Delivered like any other event.
    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0 + 2_000);
    const bodies = net.calls.map((c) => JSON.parse(c.body) as { type: string; data: { receipt?: { jws: string } } });
    expect(bodies.map((b) => b.type)).toContain("booking.receipt_issued");
    expect(bodies.find((b) => b.type === "booking.receipt_issued")?.data.receipt?.jws).toBe(receipt.jws);

    // The acknowledgement is its own event, id `<receipt>:ack`, and carries the receipt as acked.
    await db.orm.update(schema.receipts).set({ ackJws: "x.y.z", ackAt: T0 + 3_000 });
    const ack = await readEvent(db, `${receipt.id}:ack`);
    expect(ack).toMatchObject({ type: "booking.receipt_acknowledged", itemId, source: "receipt_ack" });
    if (!ack) throw new Error("no ack event");
    const fullAck = await buildEvent(db, ack, "full", "https://inbox.example.com");
    expect((fullAck.data as { receipt?: { acknowledged_at: string | null } }).receipt?.acknowledged_at).toBe(
      new Date(T0 + 3_000).toISOString(),
    );
  });
});

describe("what a full event offers the owner next", () => {
  it("leaves out a one-time correction once its window has passed", async () => {
    const { db } = await freshDb();
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const created = await createItem(db, customer(T0), {
      type: "booking",
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-23T08:00:00Z",
        endTime: "2026-09-23T09:30:00Z",
      },
      contact: { name: "Rita Amaral", email: "rita@example.com" },
    });
    const id = created.view.item.id;
    const end = Date.parse("2026-09-23T09:30:00Z");
    await transitionItem(db, owner(T0 + 1_000), { itemId: id, event: "confirm" });
    const done = await transitionItem(db, owner(end + 60_000), { itemId: id, event: "complete" });
    const event = await readEvent(db, (await lastEventId(db, id)) ?? "");
    if (!event) throw new Error("no event");
    expect(done.view.transitions.map((t) => t.event)).toContain("no_show");
    const within = await buildEvent(db, event, "full", "https://inbox.example.com", end + 3_600_000);
    expect((within.data as { transitions: { event: string }[] }).transitions.map((t) => t.event)).toContain("no_show");
    const past = await buildEvent(db, event, "full", "https://inbox.example.com", end + 49 * 3_600_000);
    expect((past.data as { transitions: { event: string }[] }).transitions).toEqual([]);
  });
});

describe("working with the owner's Integrations screen", () => {
  it("delivers a job that carries only a delivery id, taking the attempt from the row", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    const ep = await addEndpoint(db, box, { url: "https://hooks.example.com/replay", events: ["*"] });
    const created = await createItem(db, customer(T0), message());
    const eventId = await firstEventId(db, created.view.item.id);
    const deliveryId = ulid(T0);
    await db.client.query({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, next_at, created_at) VALUES (?, ?, ?, 'message.create', 'pending', 0, ?, ?)",
      params: [deliveryId, ep.id, eventId ?? "", T0, T0],
      method: "run",
    });
    await db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 'queued', 0, 2, ?)",
      params: [ulid(T0), WEBHOOK_DELIVERY_KIND, JSON.stringify({ deliveryId }), T0, T0],
      method: "run",
    });

    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0);
    const [row] = await rows(db, "SELECT status, attempts FROM webhook_deliveries WHERE id = ?", [deliveryId]);
    expect(String(row?.[0])).toBe("delivered");
    expect(Number(row?.[1])).toBe(1);
    expect(net.calls).toHaveLength(1);
  });

  it("calls nobody while outbound webhooks are switched off in Settings", async () => {
    const { db } = await freshDb();
    const box = createSecretBox([KEY]);
    if (!box) throw new Error("no box");
    await addEndpoint(db, box, { url: "https://hooks.example.com/a", events: ["*"] });
    await createItem(db, customer(T0), message());
    await writeSettings(db, { enabled: false });
    const net = receiver(() => 200);
    await drain(runnerWith({ secrets: box, fetchImpl: net.fetchImpl }), db, T0);
    expect(net.calls).toHaveLength(0);
    expect(String((await deliveries(db))[0]?.[3])).toBe("pending");
  });

  it("reads the rotation document the Integrations screen seals, and drops an expired previous", () => {
    const doc = JSON.stringify({ current: "whsec_new", previous: "whsec_old", previousUntil: T0 + 1_000 });
    expect(splitSecrets(doc, T0)).toEqual(["whsec_new", "whsec_old"]);
    expect(splitSecrets(doc, T0 + 2_000)).toEqual(["whsec_new"]);
    expect(splitSecrets("whsec_plain", T0)).toEqual(["whsec_plain"]);
  });

  it("reads the Settings document, and falls back to the shipped defaults without one", () => {
    expect(webhookSettings(undefined)).toEqual({
      enabled: true,
      timeoutMs: 10_000,
      maxAttempts: 8,
      disableAfterDays: 5,
      retainDeliveryDays: 30,
      allowPrivateTargets: false,
    });
    expect(webhookSettings(DEFAULT_SETTINGS).maxAttempts).toBe(8);
    expect(
      webhookSettings({ integrations: { webhooks: { enabled: false, maxAttempts: 3, allowPrivateTargets: true } } }),
    ).toMatchObject({ enabled: false, maxAttempts: 3, allowPrivateTargets: true });
  });
});

describe("headers", () => {
  it("names the three Standard Webhooks headers and nothing else", async () => {
    const headers = await signedHeaders(newWebhookSecret(), { id: "evt", timestamp: 1, body: "{}" });
    expect(Object.keys(headers).sort()).toEqual(["webhook-id", "webhook-signature", "webhook-timestamp"]);
  });

  it("names a delivery job by its delivery and its attempt", () => {
    expect(deliverDedupeKey("d1", 3)).toBe("whsend:d1:3");
  });
});

async function writeSettings(db: Db, patch: Record<string, unknown>): Promise<void> {
  const doc = {
    ...DEFAULT_SETTINGS,
    integrations: {
      ...(DEFAULT_SETTINGS as unknown as { integrations?: Record<string, unknown> }).integrations,
      webhooks: {
        ...((DEFAULT_SETTINGS as unknown as { integrations?: { webhooks?: Record<string, unknown> } }).integrations
          ?.webhooks ?? {}),
        ...patch,
      },
    },
  };
  await db.client.query({
    sql: "INSERT OR REPLACE INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 1, ?)",
    params: [JSON.stringify(doc), T0],
    method: "run",
  });
}

async function firstEventId(db: Db, itemId: string): Promise<string | undefined> {
  const { rows: r } = await db.client.query({
    sql: "SELECT id FROM item_events WHERE item_id = ? ORDER BY seq LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return r[0] ? String(r[0][0]) : undefined;
}

async function lastEventId(db: Db, itemId: string): Promise<string | undefined> {
  const { rows } = await db.client.query({
    sql: "SELECT id FROM item_events WHERE item_id = ? ORDER BY seq DESC LIMIT 1",
    params: [itemId],
    method: "all",
  });
  return rows[0]?.[0] === undefined ? undefined : String(rows[0][0]);
}
