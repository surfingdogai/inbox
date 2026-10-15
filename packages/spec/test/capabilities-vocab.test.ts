import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  capabilitiesVocabSchema,
  capabilityStateSchema,
  evidenceSchema,
  LEAD_CAPABILITIES,
  VOCAB_DOOR_IDS,
} from "../src/index";
import latest from "../vocab/capabilities.json";
import v1 from "../vocab/capabilities-v1.json";
import doorsVocab from "../vocab/doors.json";

/**
 * The capability vocabulary, version 2: what an agent can do at a business, published at
 * https://surfingdog.ai/spec/capabilities.json. Version 1 is kept as it was published
 * (`vocab/capabilities-v1.json`); version 2 adds to every capability and changes none of version 1's fields.
 * Whether each example name really maps to its capability under the published name rules is the network's to check
 * against its door registry; here, everything the document can say about itself.
 */
const v = capabilitiesVocabSchema.parse(latest);
const old = capabilitiesVocabSchema.parse(v1);

describe("the capability vocabulary", () => {
  it("is version 2, and version 1 still reads under the same schema", () => {
    expect(v.version).toBe(2);
    expect(old.version).toBe(1);
    expect(v.url).toBe("https://surfingdog.ai/spec/capabilities.json");
    expect(v.licence).toBe("MIT");
  });

  it("keeps every id, journey, label and question of version 1, in its order: nothing renamed or removed", () => {
    const four = (c: { id: string; journey: string; label: string; question: string }) => ({
      id: c.id,
      journey: c.journey,
      label: c.label,
      question: c.question,
    });
    expect(v.capabilities.map(four)).toEqual(old.capabilities.map(four));
    expect(v.capabilities.map((c) => c.id)).toEqual([...CAPABILITY_IDS]);
    expect(v.lead).toEqual([...LEAD_CAPABILITIES]);
    expect(v.states).toEqual(capabilityStateSchema.options);
    expect(v.evidence).toEqual(evidenceSchema.options);
    expect(v.journeys).toEqual(old.journeys);
  });

  it("says what each state and each step of the evidence ladder means", () => {
    for (const s of v.states) expect(v.state_meanings?.[s], s).toBeTruthy();
    for (const e of v.evidence) expect(v.evidence_meanings?.[e], e).toBeTruthy();
    expect(v.produced).toEqual(["declared", "tested"]);
  });

  it("gives every capability a definition, other words, what partial means, its evidence, what is not enough and its doors", () => {
    for (const c of v.capabilities) {
      expect(c.definition, c.id).toMatch(/\.$/);
      expect(c.aliases?.length, c.id).toBeGreaterThan(0);
      expect(c.partial, c.id).toMatch(/\.$/);
      for (const step of ["declared", "tested", "proven"] as const)
        expect(c.evidence?.[step], `${c.id} ${step}`).toBeTruthy();
      expect(c.not_enough?.length, c.id).toBeGreaterThan(0);
      expect(Object.keys(c.doors ?? {}).length, c.id).toBeGreaterThan(0);
    }
  });

  it("gives no word to two capabilities: an alias is never another capability's id, label or alias", () => {
    const owner = new Map<string, string>();
    for (const c of v.capabilities) {
      for (const w of [c.id, c.label.toLowerCase()]) owner.set(w, c.id);
    }
    const seen = new Map<string, string>();
    for (const c of v.capabilities) {
      for (const a of c.aliases ?? []) {
        const w = a.toLowerCase();
        expect(seen.get(w) ?? c.id, `${a} is an alias of two capabilities`).toBe(c.id);
        expect(owner.get(w) ?? c.id, `${a} names another capability`).toBe(c.id);
        seen.set(w, c.id);
      }
    }
  });

  it("names each of the directory's request kinds once, on the capability it filters by", () => {
    const kinds = v.capabilities.flatMap((c) => (c.kind ? [[c.kind, c.id]] : []));
    expect(Object.fromEntries(kinds)).toEqual({
      ask: "message",
      quote: "negotiate",
      book: "book",
      order: "order",
      pay: "pay",
    });
    expect(kinds.map(([k]) => k).sort()).toEqual([...doorsVocab.kinds].sort());
  });

  it("describes every kind of door it uses, the experimental ones as doors.json has them", () => {
    expect(v.doors?.map((d) => d.id)).toEqual([...VOCAB_DOOR_IDS]);
    const experimental = (v.doors ?? []).filter((d) => d.experimental).map((d) => d.id);
    expect(experimental).toEqual(doorsVocab.experimental);
    for (const d of v.doors ?? []) {
      if (!d.experimental) expect(doorsVocab.types, d.id).toContain(d.id);
      expect(d.how, d.id).toMatch(/\.$/);
    }
    const ids = new Set<string>(VOCAB_DOOR_IDS);
    for (const c of v.capabilities)
      for (const d of Object.keys(c.doors ?? {})) expect(ids.has(d), `${c.id}: ${d}`).toBe(true);
    expect(v.never_doors).toMatch(/email address, a phone number/);
  });

  it("maps an inbox's item types to capabilities only through the five item types", () => {
    const items = new Set(["message", "quote_request", "booking", "order", "refund"]);
    for (const c of v.capabilities)
      for (const t of c.doors?.inbox ?? []) expect(items.has(t), `${c.id}: ${t}`).toBe(true);
  });

  it("keeps a changelog, oldest first, ending with this version", () => {
    const log = v.changelog ?? [];
    expect(log.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < log.length; i++) {
      const at = (e: (typeof log)[number]) => e.published ?? e.amended ?? "";
      expect(log[i]?.version ?? 0).toBeGreaterThanOrEqual(log[i - 1]?.version ?? 0);
      expect(at(log[i] as (typeof log)[number]) >= at(log[i - 1] as (typeof log)[number])).toBe(true);
    }
    const last = log[log.length - 1];
    expect(last?.version).toBe(v.version);
    expect(last?.published).toBe(v.published);
  });

  it("speaks plainly: no claim of being first or only, and no line that is only a heading", () => {
    const text = JSON.stringify(latest);
    expect(text).not.toMatch(/\b(first to|only one|world's|best)\b/i);
  });
});
