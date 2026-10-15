import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  classifyDoorRead,
  countedIntents,
  DOOR_REPORT_CLASSES,
  type DoorReadObservation,
  type DoorReportSource,
  doorReportClassesVocabSchema,
  doorReportEarns,
  doorReportEffect,
  doorReporterSchema,
  doorReportsRequestSchema,
  doorReportsResponseSchema,
  doorStatusAfter,
  jsonSchemaOf,
  NETWORK_ONLY_DOOR_CLASSES,
  parseStrictJson,
  pingDoorsSchema,
  READ_ALLOWANCE,
  REPORTER_CREDIT_RULE,
  readDoorReports,
  reporterCreditOf,
  signedPingResponseSchema,
} from "../src/index";
import vectors from "../vectors/door-reports.json";
import classes from "../vocab/door-report-classes.json";

/**
 * Door reports (protocol §4.15) and the network's own reads (§4.8) against `vectors/door-reports.json`,
 * which a network's own code is held to as well. Node and workerd.
 */

const doors = (domain: string) => (vectors.doors as Record<string, { type: string; url: string }[]>)[domain] ?? [];

type Call = (typeof vectors.calls)[number] & {
  body?: unknown;
  raw?: string;
  repeat?: { count: number; report: unknown };
  pad?: number;
};

function textOf(c: Call): string {
  if (c.raw !== undefined) return c.raw;
  const body = c.repeat ? { v: 1, reports: Array.from({ length: c.repeat.count }, () => c.repeat?.report) } : c.body;
  return JSON.stringify(body) + " ".repeat(c.pad ?? 0);
}

describe("POST /v1/door-reports, as vectors/door-reports.json reads it", () => {
  it("has the cases the protocol names", () => {
    expect(vectors.calls.length).toBeGreaterThanOrEqual(30);
    expect(vectors.calls.filter((c) => c.expect.status === 400).length).toBeGreaterThanOrEqual(20);
  });

  for (const c of vectors.calls as Call[]) {
    it(c.name, () => {
      const got = readDoorReports(textOf(c), { now: vectors.now, doors });
      if (c.expect.status !== 202) {
        expect({ status: got.status, code: "code" in got ? got.code : null }).toEqual(c.expect);
        return;
      }
      if (got.status !== 202) throw new Error(`expected 202, got ${got.status}: ${"detail" in got ? got.detail : ""}`);
      const sent = (c.body as { reports: Record<string, unknown>[] }).reports;
      expect(got.ignored).toEqual((c.expect as { ignored: unknown[] }).ignored);
      expect(got.kept.map((k) => ({ i: k.i, at: k.at }))).toEqual((c.expect as { kept: unknown[] }).kept);
      // Everything else of a kept report is what was sent; nothing is added.
      for (const k of got.kept) expect({ ...k, i: undefined, at: undefined }).toEqual({ ...sent[k.i], at: undefined });
    });
  }

  it("50 tries of one attempt count as one", () => {
    const report = (n: number) => ({
      domain: "bakery.example",
      door: { type: "inbox", url: "https://bakery.example/mcp" },
      op: "book",
      at: vectors.now - 600 + n,
      intent: "one-attempt",
      result: n === 49 ? "ok" : "fail",
      ...(n === 49 ? {} : { class: "tcp.reset" }),
    });
    const got = readDoorReports(JSON.stringify({ v: 1, reports: Array.from({ length: 50 }, (_, n) => report(n)) }), {
      now: vectors.now,
      doors,
    });
    if (got.status !== 202) throw new Error("expected 202");
    expect(got.kept.map((k) => [k.i, k.result])).toEqual([[49, "ok"]]);
    expect(got.ignored.every((x) => x.why === "superseded")).toBe(true);
    expect(got.ignored).toHaveLength(49);
  });

  it("every report the vectors keep is a valid request, and the request schema is strict", () => {
    for (const c of vectors.calls as Call[]) {
      if (c.expect.status === 202) expect(doorReportsRequestSchema.safeParse(c.body).success, c.name).toBe(true);
    }
    const schema = jsonSchemaOf("door-reports-request") as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
    const one = jsonSchemaOf("door-report") as { additionalProperties?: unknown; properties: Record<string, unknown> };
    expect(one.additionalProperties).toBe(false);
    expect(Object.keys(one.properties).sort()).toEqual(
      ["at", "class", "domain", "door", "intent", "ms", "op", "result", "token", "tool"].sort(),
    );
  });

  it("answers in the shape the protocol gives", () => {
    expect(
      doorReportsResponseSchema.safeParse({
        accepted: [{ i: 0, proof: "none", counts: "counter" }],
        ignored: [{ i: 1, why: "unknown_door" }],
        next: "We read a door again when agents report it down.",
      }).success,
    ).toBe(true);
  });
});

describe("what a report can do", () => {
  for (const e of vectors.effects) {
    it(e.name, () => {
      expect(doorReportEffect(e.source as DoorReportSource, e.report as never)).toEqual(e.expect);
    });
  }

  it("nothing without a door token ever counts toward anything public", () => {
    for (const signature of ["none", "key", "platform"] as const) {
      for (const c of DOOR_REPORT_CLASSES) {
        const got = doorReportEffect({ signature, token: false, independent: true }, { result: c.result, class: c.id });
        expect(got.public_line, `${signature} ${c.id}`).toBe(false);
      }
    }
  });
});

describe("the network's own reads", () => {
  for (const r of vectors.reads) {
    it(r.name, () => {
      expect(classifyDoorRead(r.observation as DoorReadObservation)).toBe(r.expect);
    });
  }

  for (const s of vectors.states) {
    it(`the door state machine: ${s.name}`, () => {
      expect(doorStatusAfter(s.reads as never, s.now)).toEqual(s.expect);
    });
  }

  it(vectors.intents.name, () => {
    expect(countedIntents(vectors.intents.reports)).toEqual(vectors.intents.expect);
  });
});

describe("vocab/door-report-classes.json", () => {
  it("is the classes the code knows, each with one result of its phase", () => {
    const vocab = doorReportClassesVocabSchema.parse(classes);
    expect(vocab.classes).toEqual(JSON.parse(JSON.stringify(DOOR_REPORT_CLASSES)));
    expect(vocab.network_only.map((c) => c.id)).toEqual([...NETWORK_ONLY_DOOR_CLASSES]);
    const phases = new Map(vocab.phases.map((p) => [p.id, p.results]));
    for (const c of vocab.classes) expect(phases.get(c.phase), c.id).toContain(c.result);
    expect(new Set(vocab.classes.map((c) => c.id)).size).toBe(vocab.classes.length);
    expect(vocab.classes.some((c) => c.result === "ok")).toBe(false);
  });

  it("maps every client-side code the protocol names, and every 429", () => {
    const by = (code: number) => vocabClass((c) => [...(c.jsonrpc ?? []), ...(c.mcp ?? [])].includes(code));
    expect([-32602, -32700, -32600, -32020, -32021].map((n) => by(n)?.phase)).toEqual(Array(5).fill("client"));
    expect(vocabClass((c) => c.http === "429")?.id).toBe("client.rate_limited");
    expect(by(-32603)?.id).toBe("protocol.internal");
    expect(by(-32601)?.id).toBe("protocol.advertised_missing");
    expect(by(-32022)?.id).toBe("protocol.version");
  });

  it("names only ops of the capability vocabulary in its vectors", () => {
    for (const c of vectors.calls as Call[]) {
      for (const r of ((c.body as { reports?: { op?: string }[] })?.reports ?? []) as { op?: string }[]) {
        if (r.op && r.op !== "teleport") expect(CAPABILITY_IDS as readonly string[], c.name).toContain(r.op);
      }
    }
  });
});

const vocabClass = (f: (c: (typeof DOOR_REPORT_CLASSES)[number]) => boolean) => DOOR_REPORT_CLASSES.find(f);

describe("strict JSON", () => {
  it("takes what JSON.parse takes, members named once", () => {
    for (const t of [
      '{"a":[1,2.5e3,-0,true,false,null,"x\\u0041\\n"]}',
      "[]",
      ' {"a" : {"b":{}} } ',
      '"\\ud83d\\ude00"',
    ]) {
      expect(parseStrictJson(t), t).toEqual({ ok: true, value: JSON.parse(t) });
    }
  });

  it("refuses what it must", () => {
    for (const t of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"x":{"a":1,"a":1}}',
      "{'a':1}",
      '{"a":01}',
      '{"a":1,}',
      "[1,]",
      '"\t"',
      "1 2",
      "",
    ]) {
      expect(parseStrictJson(t).ok, t).toBe(false);
    }
    expect(parseStrictJson("[".repeat(40) + "]".repeat(40)).ok).toBe(false);
  });

  it("keeps a member named __proto__ as a plain member", () => {
    const got = parseStrictJson('{"__proto__":{"polluted":true}}');
    expect(got.ok && Object.getPrototypeOf(got.value)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("the ping's doors block", () => {
  it("is optional, so a network that takes no reports answers as before", () => {
    const base = {
      ok: true,
      rules: { version: 9, effective_at: "2026-10-23T00:00:00Z" },
      next_rules: null,
      reports: [],
      contests: [],
    };
    expect(signedPingResponseSchema.safeParse(base).success).toBe(true);
    expect(
      signedPingResponseSchema.safeParse({
        ...base,
        doors: {
          as_of: "2026-10-12",
          doors: [
            {
              type: "mcp",
              url: "https://bakery.example/mcp",
              status: "live",
              checked: { result: "good", at: "2026-10-12T09:00:00Z" },
              reports: [{ op: "book", tool: "create_booking", proof: "none", result: "ok", d7: 12, d30: 40 }],
              platforms: [],
            },
          ],
          incidents: [],
          trouble: [],
          fixes: [],
        },
      }).success,
    ).toBe(true);
    expect(pingDoorsSchema.safeParse({ as_of: "2026-10-12T00:00:00Z" }).success).toBe(false);
  });
});

describe("the reporters' reading allowance, as vectors/door-reports.json's contributors pin it", () => {
  const v = vectors.contributors;

  it("publishes the rule this code applies", () => {
    expect(v.rule).toEqual(REPORTER_CREDIT_RULE);
    expect(v.cases.length).toBeGreaterThanOrEqual(8);
    expect(v.earning.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of v.cases) {
    it(c.name, () => {
      expect(reporterCreditOf(c.days)).toEqual(c.expect);
    });
  }

  for (const c of v.earning) {
    it(c.name, () => {
      expect(doorReportEarns(c.report as Parameters<typeof doorReportEarns>[0])).toBe(c.expect.earns);
    });
  }

  it("answers GET /v1/door-reports/me as its schema says, for a key and a platform", () => {
    const base = {
      credit: { points: 31, days: 7 },
      contributor: true,
      threshold: REPORTER_CREDIT_RULE,
      reads: { ...READ_ALLOWANCE.key, per: "key" },
      contributor_reads: { ...READ_ALLOWANCE.key, per: "key" },
      rule: "https://network.example/report.md#a-larger-reading-allowance",
      as_of: "2026-10-15T12:00:00Z",
    };
    const key = { ...base, reporter: { type: "key", keyid: "U1FnFeccbN76Yku-3J2NFbaHkQUK6EUvTBDDdGI27xI" } };
    expect(doorReporterSchema.safeParse(key).success).toBe(true);
    const platform = {
      ...base,
      reporter: { type: "platform", origin: "https://agents.example.com", platform: "example.com" },
      reads: { ...READ_ALLOWANCE.address, per: "address" },
    };
    expect(doorReporterSchema.safeParse(platform).success).toBe(true);
    expect(doorReporterSchema.safeParse({ ...key, reporter: { type: "key", keyid: "short" } }).success).toBe(false);
    expect(
      doorReporterSchema.safeParse({ ...key, reads: { per_minute: 600, burst: 200, per: "person" } }).success,
    ).toBe(false);
    expect(doorReporterSchema.safeParse({ ...key, as_of: "yesterday" }).success).toBe(false);
    expect(jsonSchemaOf("door-reporter")).toMatchObject({ title: expect.stringContaining("/v1/door-reports/me") });
  });
});
