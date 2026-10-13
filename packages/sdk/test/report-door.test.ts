import { describe, expect, it, vi } from "vitest";
import { DOOR_REPORT_CLASSES, doorReportSchema, readDoorReports } from "../../spec/src/index";
import {
  DoorReporter,
  type DoorReportInput,
  doorReportBody,
  flushDoorReports,
  generateAgentKey,
  NetworkCallError,
  newIntent,
  reportDoor,
} from "../src/index";

/**
 * reportDoor (network protocol §4.15): every report the SDK sends is one the protocol's own reader
 * takes, it batches and sends on its own, and it sends only to the network it was given. Node and workerd.
 */

const NOW = Date.parse("2026-10-13T12:00:00Z");
const MCP = { type: "mcp", url: "https://bakery.example/mcp" };
const doors = (d: string) => (d === "bakery.example" ? [MCP] : []);
const base: DoorReportInput = { domain: "bakery.example", door: MCP, op: "book", tool: "create_booking", result: "ok" };

/** A network that answers every call 202, or what `answer` says, and keeps what it was sent. */
function network(answer?: (n: number) => Response) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    if (answer) return answer(calls.length);
    const read = readDoorReports(String(init.body), { now: NOW / 1000, doors });
    const accepted = read.status === 202 ? read.kept.map((k) => ({ i: k.i, proof: "none", counts: "counter" })) : [];
    return new Response(
      JSON.stringify({ accepted, ignored: read.status === 202 ? read.ignored : [], next: "Thanks." }),
      {
        status: read.status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  return { calls, fetch };
}

describe("doorReportBody", () => {
  it("is a report the protocol takes, the time and intent filled in, the tool lowercased", () => {
    const body = doorReportBody({ ...base, tool: "Create_Booking", ms: 1840 }, NOW);
    expect(doorReportSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ at: NOW / 1000, tool: "create_booking", ms: 1840 });
    expect(body.intent).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Object.keys(body)).not.toContain("class");
  });

  it("takes every class of the vocabulary with its result", () => {
    for (const c of DOOR_REPORT_CLASSES) {
      const body = doorReportBody({ ...base, result: c.result, class: c.id }, NOW);
      expect(doorReportSchema.safeParse(body).success, c.id).toBe(true);
    }
  });

  it("refuses at once what the network would refuse whole", () => {
    const bad: Partial<DoorReportInput>[] = [
      { result: "ok", class: "slot_taken" },
      { result: "fail" },
      { tool: "create booking" },
      { door: { type: "mcp", url: "https://bakery.example/mcp?x=1" } },
      { door: { type: "mcp", url: "http://bakery.example/mcp" } },
      { domain: "Bakery.Example" },
      { op: "Book" },
      { intent: "short" },
      { ms: 600_001 },
      { result: "maybe" as never },
      { token: "not-a-jws" },
    ];
    for (const b of bad)
      expect(() => doorReportBody({ ...base, ...b } as DoorReportInput, NOW), JSON.stringify(b)).toThrow(TypeError);
  });

  it("keeps an intent given for an attempt and its retries", () => {
    const intent = newIntent();
    expect(doorReportBody({ ...base, intent }, NOW).intent).toBe(intent);
    expect(newIntent()).not.toBe(intent);
  });
});

describe("DoorReporter", () => {
  it("sends what waits in batches of 100, each a call the protocol takes", async () => {
    const net = network();
    const r = new DoorReporter({ network: "network.example", fetch: net.fetch, autoFlush: false, now: () => NOW });
    for (let n = 0; n < 250; n++) r.report({ ...base, ms: n });
    expect(net.calls).toHaveLength(0);
    const last = await r.flush();
    expect(net.calls.map((c) => (JSON.parse(c.body) as { reports: unknown[] }).reports.length)).toEqual([100, 100, 50]);
    expect(net.calls.every((c) => c.url === "https://network.example/v1/door-reports")).toBe(true);
    expect(last?.accepted).toHaveLength(50);
    expect(r.pending).toBe(0);
    expect(await r.flush()).toBeNull();
  });

  it("sends on its own, by default, a moment after a report waits", async () => {
    const net = network();
    const r = new DoorReporter({ network: "network.example", fetch: net.fetch, flushAfterMs: 5, now: () => NOW });
    r.report(base);
    r.report({ ...base, result: "fail", class: "tcp.timed_out" });
    expect(net.calls).toHaveLength(0);
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    expect((JSON.parse(net.calls[0]?.body ?? "{}") as { reports: unknown[] }).reports).toHaveLength(2);
  });

  it("sends at once when a batch is full", async () => {
    const net = network();
    const r = new DoorReporter({ network: "network.example", fetch: net.fetch, batchSize: 3, flushAfterMs: 60_000 });
    for (let n = 0; n < 3; n++) r.report(base);
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    expect(r.pending).toBe(0);
  });

  it("keeps a batch the network could not take now, and drops one it refused whole", async () => {
    const busy = network((n) => new Response(null, { status: n === 1 ? 503 : 202 }));
    const r = new DoorReporter({ network: "network.example", fetch: busy.fetch, autoFlush: false });
    r.report(base);
    await expect(r.flush()).rejects.toBeInstanceOf(NetworkCallError);
    expect(r.pending).toBe(1);
    await r.flush();
    expect(r.pending).toBe(0);

    const refused = network(
      () =>
        new Response(JSON.stringify({ code: "malformed", title: "x", status: 400, type: "about:blank" }), {
          status: 400,
        }),
    );
    const r2 = new DoorReporter({ network: "network.example", fetch: refused.fetch, autoFlush: false });
    r2.report(base);
    await expect(r2.flush()).rejects.toMatchObject({ status: 400, code: "malformed" });
    expect(r2.pending).toBe(0);
  });

  it("tells onError what went wrong in the background", async () => {
    const down = network(() => new Response(null, { status: 500 }));
    const errors: unknown[] = [];
    const r = new DoorReporter({
      network: "network.example",
      fetch: down.fetch,
      flushAfterMs: 1,
      onError: (e) => errors.push(e),
    });
    r.report(base);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(r.pending).toBe(1);
  });

  it("signs sdi-agent/1 with the agent's own key when given one, and not otherwise", async () => {
    const net = network();
    const key = await generateAgentKey();
    const signed = new DoorReporter({ network: "network.example", fetch: net.fetch, autoFlush: false, key });
    signed.report(base);
    await signed.flush();
    const plain = new DoorReporter({ network: "network.example", fetch: net.fetch, autoFlush: false });
    plain.report(base);
    await plain.flush();
    expect(Object.keys(net.calls[0]?.headers ?? {})).toEqual(
      expect.arrayContaining(["Signature", "Signature-Input", "Sdi-Agent-Key"]),
    );
    expect(Object.keys(net.calls[1]?.headers ?? {})).not.toContain("Signature");
  });

  it("sends only to the network it is given, named as a host, an origin, or a key or pass it issued", () => {
    expect(() => new DoorReporter({ network: "https://evil.example/collect" })).toThrow(TypeError);
    expect(() => new DoorReporter({ network: "not a host" })).toThrow(TypeError);
    const fromPass = new DoorReporter({
      network: "sdpass1_network.example_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      autoFlush: false,
    });
    expect(fromPass.pending).toBe(0);
  });
});

describe("reportDoor", () => {
  it("queues per network and flushDoorReports sends them all", async () => {
    const a = network();
    const b = network();
    reportDoor({ ...base, network: "a.network.example", fetch: a.fetch, flushAfterMs: 60_000 });
    reportDoor({ ...base, network: "https://a.network.example", fetch: a.fetch });
    reportDoor({ ...base, network: "b.network.example", fetch: b.fetch, flushAfterMs: 60_000 });
    await flushDoorReports();
    expect(a.calls).toHaveLength(1);
    expect((JSON.parse(a.calls[0]?.body ?? "{}") as { reports: unknown[] }).reports).toHaveLength(2);
    expect(b.calls[0]?.url).toBe("https://b.network.example/v1/door-reports");
  });
});
