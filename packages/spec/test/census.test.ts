import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  CENSUS_CSV_HEADER,
  CENSUS_SCOPES,
  capabilitiesVocabSchema,
  censusEditionSchema,
  censusMetricSchema,
  getCensusOutputSchema,
  scoreRulesSchema,
  VOCAB_DOOR_IDS,
} from "../src/index";
import names from "../vectors/capability-names.json";
import example from "../vectors/census-edition.json";
import vocabulary from "../vocab/capabilities.json";
import scoreRulesV3 from "../vocab/score-rules-v3.json";

/**
 * The census's data (protocol §4.16) against its example (vectors/census-edition.json), and the vectors that say how
 * a door's names are read as capabilities (vectors/capability-names.json, from the network): every example name the
 * vocabulary gives is there, meeting its capability. And the score rules version 3 an edition is counted under.
 */

describe("an edition of the census", () => {
  const e = censusEditionSchema.parse(example);

  it("reads under its schema, every metric one the schema names", () => {
    expect(e.status).toBe("published");
    for (const r of e.rows) expect(censusMetricSchema.safeParse(r.metric).success, r.metric).toBe(true);
    expect(e.capabilities).toEqual([...CAPABILITY_IDS]);
    expect(CENSUS_CSV_HEADER).toBe("edition,scope,key,metric,value");
  });

  it("adds up: the levels and no_ai are the checked; the levels from askable up are the agent-ready", () => {
    const keys = new Set(e.rows.map((r) => `${r.scope}/${r.key}`));
    for (const k of keys) {
      const rows = e.rows.filter((r) => `${r.scope}/${r.key}` === k);
      const v = (m: string) => rows.find((r) => r.metric === m)?.value ?? Number.NaN;
      const levels = e.levels.reduce((n, l) => n + v(`level:${l}`), 0);
      expect(levels + v("no_ai"), k).toBe(v("checked"));
      const ready = e.levels.slice(e.levels.indexOf("askable")).reduce((n, l) => n + v(`level:${l}`), 0);
      expect(ready, k).toBe(v("agent_ready"));
      for (const r of rows.filter((x) => x.metric.startsWith("can:") || x.metric.startsWith("door:")))
        expect(r.value, `${k} ${r.metric}`).toBeLessThanOrEqual(v("agent_ready"));
      // Every published key has a row for every metric, zero included.
      expect(rows.filter((r) => r.metric !== "places").length, k).toBe(
        2 + e.capabilities.length + e.doors.length + e.levels.length + 1,
      );
    }
    for (const s of keys) expect(CENSUS_SCOPES as readonly string[]).toContain(s.split("/")[0]);
  });

  it("reads a later edition that adds a scope, a metric, a capability and a kind of door, as the protocol promises", () => {
    const later = structuredClone(example) as typeof example;
    later.capabilities.push("deliver");
    later.doors.push("ap2");
    later.rows.push(
      { scope: "neighbourhood", key: "alfama", metric: "checked", value: 120 },
      { scope: "all", key: "", metric: "can:deliver", value: 3 },
      { scope: "all", key: "", metric: "door:ap2", value: 1 },
    );
    expect(censusEditionSchema.safeParse(later).success).toBe(true);
    const bad = structuredClone(example) as typeof example;
    bad.rows.push({ scope: "all", key: "", metric: "anything at all", value: 1 });
    expect(censusEditionSchema.safeParse(bad).success).toBe(false);
  });

  it("names the score rules it was counted under by version and revision, and get_census answers the same way", () => {
    expect(e.score_rules).toEqual({
      version: 3,
      revised: "2026-10-18",
      url: "https://surfingdog.ai/v1/score-rules?version=3",
    });
    const answer = {
      edition: e.edition,
      title: e.title,
      status: e.status,
      as_of: e.as_of,
      published_at: e.published_at,
      note: null,
      scope: "city",
      key: "lisbon",
      rows: e.rows.filter((r) => r.scope === "city"),
      truncated: false,
      url: "https://surfingdog.ai/census/2026-11",
      json: "https://surfingdog.ai/v1/census/2026-11",
      csv: "https://surfingdog.ai/census/2026-11.csv",
      method: e.method.url,
      vocabulary: e.vocabulary.url,
      licence: e.licence,
    };
    expect(getCensusOutputSchema.safeParse(answer).success).toBe(true);
  });
});

describe("the score rules version 3", () => {
  it("read under the rules' schema, revised on 15 October 2026 or later: a commerce profile counts where the site sells", () => {
    const rules = scoreRulesSchema.parse(scoreRulesV3);
    expect(rules.version).toBe(3);
    const revised = (scoreRulesV3.changelog as { version: number; published?: string; amended?: string }[])
      .filter((c) => c.version === 3)
      .map((c) => c.amended ?? c.published ?? "")
      .sort()
      .at(-1);
    expect((revised ?? "") >= "2026-10-15").toBe(true);
  });
});

describe("how a door's names are read as capabilities (vectors/capability-names.json)", () => {
  const v = capabilitiesVocabSchema.parse(vocabulary);

  it("holds every example name of the vocabulary, meeting its capability", () => {
    expect(names.vocabulary).toBe(v.version);
    for (const c of v.capabilities) {
      for (const [door, examples] of Object.entries(c.doors ?? {})) {
        for (const ex of examples) {
          const found = names.cases.find((x) => x.door === door && x.name === ex);
          expect(found, `${door} ${ex}`).toBeDefined();
          expect(found?.expect, `${door} ${ex}`).toContain(c.id);
        }
      }
    }
  });

  it("says why each name that meets another capability, or none, does", () => {
    const refusals = names.cases.filter((x) => "why" in x);
    expect(refusals.length).toBeGreaterThanOrEqual(8);
    for (const r of refusals) expect((r as { why: string }).why, r.name).toMatch(/\.$/);
    expect(refusals.find((r) => r.name === "cancel_cart")?.expect).toEqual([]);
    expect(refusals.find((r) => r.name === "GET /bookings")?.expect).toEqual([]);
    for (const x of names.cases) {
      expect(VOCAB_DOOR_IDS as readonly string[], x.name).toContain(x.door);
      for (const id of x.expect) expect(CAPABILITY_IDS as readonly string[], `${x.name}: ${id}`).toContain(id);
    }
  });
});
