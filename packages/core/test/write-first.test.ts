import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/connectors/sdk";
import {
  RESOLVE_WITHIN_MS,
  registerWriteResolver,
  resolveWrite,
  type WriteRow,
  type WrittenRef,
  writeFirst,
} from "../src/connectors/write-first";
import { createDb, type Db } from "../src/db";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { makeClient, resetTables } from "./harness";

/**
 * Write first (ADR-036): nothing is promised until the business's own system took the write. One
 * caller writes for an item at a time; every attempt is journalled; a retry under the same key is never
 * written twice; a timeout is looked for by its key before anything is decided, and settled by the
 * resolver within minutes; a system that takes an oversold write has ours taken back.
 */
const T0 = Date.parse("2026-12-01T03:00:00Z");

async function setup(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  await db.client.query({
    sql: "INSERT INTO connectors (id, kind, name, config_enc, status, created_at, updated_at) VALUES ('conn1', 'fake_property', 'Fake', '', 'active', ?, ?)",
    params: [T0, T0],
    method: "run",
  });
  return db;
}

/** A property system as a fake: what it holds, by our key; how it answers; what it was asked. */
function fakeSystem() {
  const held = new Map<string, WrittenRef>();
  const calls: string[] = [];
  let n = 0;
  const mode: { write: "ok" | "refuse" | "slow" | "slow_lands" | "unreachable"; oversold: boolean } = {
    write: "ok",
    oversold: false,
  };
  return {
    held,
    calls,
    mode,
    async write(key: string): Promise<WrittenRef> {
      calls.push(`write ${key}`);
      if (mode.write === "refuse") throw new ConnectorError("refused", "Those nights are no longer free.");
      if (mode.write === "unreachable") throw new ConnectorError("unreachable", "No answer.");
      const ref = { externalId: `B${++n}` };
      if (mode.write === "slow_lands") {
        held.set(key, ref);
        return new Promise<WrittenRef>(() => {});
      }
      if (mode.write === "slow") return new Promise<WrittenRef>(() => {});
      held.set(key, ref);
      return ref;
    },
    async find(key: string): Promise<WrittenRef | null> {
      calls.push(`find ${key}`);
      return held.get(key) ?? null;
    },
    async readBack(): Promise<"ok" | "conflict"> {
      calls.push("read back");
      return mode.oversold ? "conflict" : "ok";
    },
    async rollback(ref: WrittenRef): Promise<void> {
      calls.push(`cancel ${ref.externalId}`);
      for (const [k, v] of held) if (v.externalId === ref.externalId) held.delete(k);
    },
  };
}

const call = (sys: ReturnType<typeof fakeSystem>, over: Partial<Parameters<typeof writeFirst>[1]> = {}) => ({
  connectorId: "conn1",
  itemId: "stay1",
  op: "reserve" as const,
  owner: "test",
  key: "stay1.hold.1",
  request: { checkIn: "2026-12-12", checkOut: "2026-12-15", price: 77_400 },
  timeoutMs: 50,
  write: sys.write,
  find: sys.find,
  readBack: sys.readBack,
  rollback: sys.rollback,
  now: T0,
  ...over,
});

async function journal(db: Db) {
  const { rows } = await db.client.query({
    sql: "SELECT attempt, op, outcome, external_id, request_sha FROM connector_writes ORDER BY attempt",
    method: "all",
  });
  return rows.map((r) => ({ attempt: Number(r[0]), op: String(r[1]), outcome: String(r[2]), externalId: r[3] }));
}

describe("write first", () => {
  it("writes, reads back and journals; the same key again is answered, never written twice", async () => {
    const db = await setup();
    const sys = fakeSystem();
    const first = await writeFirst(db, call(sys));
    expect(first).toMatchObject({ status: "written", ref: { externalId: "B1" }, replayed: false });
    const again = await writeFirst(db, call(sys));
    expect(again).toMatchObject({ status: "written", ref: { externalId: "B1" }, replayed: true });
    expect(sys.calls).toEqual(["write stay1.hold.1", "read back"]);
    expect(await journal(db)).toEqual([{ attempt: 1, op: "reserve", outcome: "written", externalId: "B1" }]);
    // The fingerprint is a hash: the request itself, which may name the guest, is never kept.
    const { rows } = await db.client.query({ sql: "SELECT request_sha, detail FROM connector_writes", method: "all" });
    expect(String(rows[0]?.[0])).not.toContain("2026-12-12");
  });

  it("says what the system refused, and promises nothing", async () => {
    const db = await setup();
    const sys = fakeSystem();
    sys.mode.write = "refuse";
    expect(await writeFirst(db, call(sys))).toMatchObject({
      status: "refused",
      reason: "Those nights are no longer free.",
    });
    expect((await journal(db))[0]?.outcome).toBe("refused");
  });

  it("looks for a write whose answer never came, and adopts it when it landed", async () => {
    const db = await setup();
    const sys = fakeSystem();
    sys.mode.write = "slow_lands";
    const r = await writeFirst(db, call(sys));
    expect(r).toMatchObject({ status: "written", ref: { externalId: "B1" } });
    expect(sys.calls).toEqual(["write stay1.hold.1", "find stay1.hold.1", "read back"]);
  });

  it("never counts a timeout as a refusal: unknown, then settled by the resolver within minutes", async () => {
    const db = await setup();
    const sys = fakeSystem();
    const settled: { outcome: string; ref: WrittenRef | null }[] = [];
    registerWriteResolver("test", {
      find: async (_db: Db, row: WriteRow) => sys.find(row.idemKey),
      settled: async (_db, _row, outcome, ref) => {
        settled.push({ outcome, ref });
      },
    });
    sys.mode.write = "slow";
    const r = await writeFirst(db, call(sys));
    expect(r.status).toBe("pending");
    expect((await journal(db))[0]?.outcome).toBe("unknown");
    // Asked again under the same key while unknown: still pending, nothing written twice.
    expect((await writeFirst(db, call(sys))).status).toBe("pending");
    expect(sys.calls.filter((c) => c.startsWith("write"))).toHaveLength(1);
    const journalId = (r as { journalId: string }).journalId;
    expect(await resolveWrite(db, journalId, T0 + 30_000)).toBe("not found yet");
    // It turns up in the system after all: written.
    sys.held.set("stay1.hold.1", { externalId: "B7" });
    expect(await resolveWrite(db, journalId, T0 + 60_000)).toBe("found: written");
    expect(settled).toEqual([{ outcome: "written", ref: { externalId: "B7" } }]);
    expect(await journal(db)).toEqual([{ attempt: 1, op: "reserve", outcome: "written", externalId: "B7" }]);
  });

  it("counts a write never found within the window as not written, and says so once", async () => {
    const db = await setup();
    const sys = fakeSystem();
    const settled: string[] = [];
    registerWriteResolver("test", {
      find: async (_db: Db, row: WriteRow) => sys.find(row.idemKey),
      settled: async (_db, _row, outcome) => {
        settled.push(outcome);
      },
    });
    sys.mode.write = "unreachable";
    const r = (await writeFirst(db, call(sys))) as { status: string; journalId: string };
    expect(r.status).toBe("pending");
    expect(await resolveWrite(db, r.journalId, T0 + RESOLVE_WITHIN_MS + 1)).toBe("never found: not written");
    expect(await resolveWrite(db, r.journalId, T0 + RESOLVE_WITHIN_MS + 2)).toBe("settled already: refused");
    expect(settled).toEqual(["refused"]);
  });

  it("takes its own write back when the system took it oversold, and promises nothing", async () => {
    const db = await setup();
    const sys = fakeSystem();
    sys.mode.oversold = true;
    expect((await writeFirst(db, call(sys))).status).toBe("conflict");
    expect(sys.calls).toEqual(["write stay1.hold.1", "read back", "cancel B1"]);
    expect(sys.held.size).toBe(0);
    expect((await journal(db))[0]?.outcome).toBe("rolled_back");
  });

  it("lets one caller write for an item at a time", async () => {
    const db = await setup();
    const sys = fakeSystem();
    sys.mode.write = "slow";
    const first = writeFirst(db, call(sys, { timeoutMs: 200 }));
    // Another write for the same item, under another key, while the first holds the claim.
    await new Promise((r) => setTimeout(r, 20));
    expect(await writeFirst(db, call(sys, { key: "stay1.hold.2" }))).toEqual({ status: "busy" });
    expect((await first).status).toBe("pending");
    // Claim released: the next attempt may go.
    sys.mode.write = "ok";
    expect((await writeFirst(db, call(sys, { key: "stay1.hold.3" }))).status).toBe("written");
    expect((await journal(db)).map((j) => j.attempt)).toEqual([1, 2]);
  });
});
