import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilitiesVocabSchema, censusEditionSchema, SCHEMA_BASE } from "../../../packages/spec/src/index";
import vocabulary from "../../../packages/spec/vocab/capabilities.json";
import { type HeadingNode, ownHeadingId } from "../src/lib/heading-ids";
import { SPEC_DOCS, specBytes, specFiles, specIndex, vocabularyVersions } from "../src/lib/spec";
import { capabilitiesMarkdown, commonTested, longDate } from "../src/lib/spec-capabilities";

/**
 * The reference at /spec/: the pages people read say what the files say, and the files machines read are
 * packages/spec's own, byte for byte, at the addresses their `$id`s give.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const spec = (path: string) => fileURLToPath(new URL(`../../../packages/spec/${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

describe("the capability vocabulary's page", () => {
  it("is written from the vocabulary itself (UPDATE_SPEC_PAGES=1 writes it)", () => {
    const want = capabilitiesMarkdown(capabilitiesVocabSchema.parse(vocabulary));
    const path = site("src/content/docs/spec/capabilities.md");
    if (process.env.UPDATE_SPEC_PAGES === "1") writeFileSync(path, want);
    expect(readFileSync(path, "utf8")).toBe(want);
  });

  it("has a section for every capability, with its question, definition and doors", () => {
    const page = read("src/content/docs/spec/capabilities.md");
    for (const c of vocabulary.capabilities) {
      expect(page, c.id).toContain(`### ${c.label} {#${c.id}}\n`);
      expect(page, c.id).toContain(`*${c.question}*`);
      expect(page, c.id).toContain(c.definition);
    }
    expect(page).toContain(`**Version ${vocabulary.version}**, published ${longDate(vocabulary.published)}.`);
  });
});

describe("each capability's own anchor", () => {
  const page = read("src/content/docs/spec/capabilities.md");

  it("names every capability's heading by its id and every part of the journey by journey-<part>, each once", () => {
    const ids = [...page.matchAll(/^#{2,3} .+ \{#([a-z][a-z0-9_-]*)\}$/gm)].map((m) => m[1]);
    for (const c of vocabulary.capabilities) expect(ids, c.id).toContain(c.id);
    for (const j of vocabulary.journeys) expect(ids, j).toContain(`journey-${j}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives a heading ending in {#id} that id, and takes it out of the heading's words", () => {
    const calls: unknown[][] = [];
    const ctx = {
      setProperty: (...a: unknown[]) => calls.push(["set", ...a.slice(1)]),
      removeChildAt: (...a: unknown[]) => calls.push(["remove", a[1]]),
      insertChildAt: (...a: unknown[]) => calls.push(["insert", a[1], a[2]]),
    };
    const h = (...children: HeadingNode[]): HeadingNode => ({ type: "element", children });
    ownHeadingId(h({ type: "text", value: "Membership {#subscription}" }), ctx);
    expect(calls).toEqual([
      ["set", "id", "subscription"],
      ["remove", 0],
      ["insert", 0, { type: "text", value: "Membership" }],
    ]);
    calls.length = 0;
    ownHeadingId(h({ type: "text", value: "Plain words" }), ctx);
    ownHeadingId(h({ type: "text", value: "Not {#Upper}" }), ctx);
    ownHeadingId(h({ type: "element" }), ctx);
    expect(calls).toEqual([]);
  });

  it("is in Astro's Markdown pipeline, before Starlight", () => {
    const config = read("astro.config.mjs");
    expect(config.indexOf("headingIdsMarkdown(),")).toBeGreaterThan(-1);
    expect(config.indexOf("headingIdsMarkdown(),")).toBeLessThan(config.indexOf("starlight({"));
  });

  it("says the tested step most capabilities share once, and the network's own choices as its own", () => {
    const v = capabilitiesVocabSchema.parse(vocabulary);
    const tested = commonTested(v) ?? "";
    expect(tested).toBeTruthy();
    expect(page.split(tested).length - 1).toBe(1);
    expect(page).toContain("**Surfing Dog's network.**");
    expect(page).toContain('<dl class="spec-doors">');
    expect(page).not.toContain("| Door | Read by | How |");
  });
});

describe("the files machines read", () => {
  const files = specFiles();

  it("serves every vocabulary, schema and set of vectors, byte for byte, each at one address", () => {
    for (const dir of ["schemas", "vectors", "vocab"]) {
      for (const f of readdirSync(spec(dir)).filter((x) => x.endsWith(".json"))) {
        const at = files.filter((x) => x.source === `${dir}/${f}`);
        // The vocabulary's own files are at /spec/capabilities/v<N>.json, the latest also at /spec/capabilities.json.
        const vocabulary = dir === "vocab" && /^capabilities(-v\d+)?\.json$/.test(f);
        expect(at.length, `${dir}/${f}`).toBe(vocabulary && f === "capabilities.json" ? 2 : 1);
        if (vocabulary)
          expect(
            at.every((x) => x.path.startsWith("capabilities")),
            f,
          ).toBe(true);
        else expect(at[0]?.path, f).toBe(`${dir}/${f}`);
        for (const served of at)
          expect(specBytes(served.source).equals(readFileSync(spec(`${dir}/${f}`))), f).toBe(true);
      }
    }
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    expect(files.some((f) => f.path.startsWith("vocab/capabilities"))).toBe(false);
  });

  it("keeps each version of the vocabulary at its own address, and the latest at /spec/capabilities.json", () => {
    const versions = vocabularyVersions();
    expect(versions.map((v) => v.version)).toEqual(Array.from({ length: vocabulary.version }, (_, i) => i + 1));
    for (const v of versions) {
      const served = files.find((f) => f.path === `capabilities/v${v.version}.json`);
      expect(JSON.parse(specBytes(served?.source ?? "").toString()).version).toBe(v.version);
    }
    expect(files.find((f) => f.path === "capabilities.json")?.source).toBe("vocab/capabilities.json");
  });

  it("serves each schema at its $id; the MCP tools' schemas carry none", () => {
    for (const f of files.filter((x) => x.path.startsWith("schemas/"))) {
      const schema = JSON.parse(specBytes(f.source).toString()) as { $id?: string };
      if (f.path.startsWith("schemas/mcp-")) expect(schema.$id, f.path).toBeUndefined();
      else expect(schema.$id, f.path).toBe(`${SCHEMA_BASE}${f.path.slice("schemas/".length)}`);
    }
    expect(SCHEMA_BASE).toBe("https://surfingdog.ai/spec/schemas/");
  });

  it("lists every spec and every file in /spec/index.json, versions a machine can compare", () => {
    const index = specIndex() as {
      specs: {
        id: string;
        files: string[];
        version: unknown;
        version_label: string;
        revised: string;
        versions?: unknown;
      }[];
      files: string[];
    };
    expect(index.specs.map((s) => s.id)).toEqual(SPEC_DOCS.map((d) => d.id));
    expect(index.files).toEqual(files.map((f) => `https://surfingdog.ai/spec/${f.path}`));
    for (const s of index.specs) for (const f of s.files) expect(index.files, `${s.id}: ${f}`).toContain(f);
    expect(Object.fromEntries(index.specs.map((s) => [s.id, s.version]))).toEqual({
      capabilities: vocabulary.version,
      manifest: "surfingdog-inbox/0",
      receipts: 2,
      census: 1,
    });
    for (const s of index.specs) expect(s.revised, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(index.specs[0]?.versions).toEqual([
      { version: 1, url: "https://surfingdog.ai/spec/capabilities/v1.json" },
      { version: 2, url: "https://surfingdog.ai/spec/capabilities/v2.json" },
    ]);
  });
});

describe("the specs for people", () => {
  it("each names its version and the day it last changed, as the index does", () => {
    const index = read("src/content/docs/spec/index.md");
    for (const d of SPEC_DOCS) {
      const page = read(`src/content/docs${d.page.replace(/\/$/, "")}.md`);
      const head = page.split("\n").slice(0, 8).join("\n");
      expect(head.toLowerCase(), d.id).toContain(d.label.toLowerCase());
      expect(index.toLowerCase(), d.id).toContain(`| ${d.label.toLowerCase()} |`);
      expect(index, d.id).toContain(`[${d.title}](${d.page})`);
      expect(index, d.id).toContain(longDate(d.revised));
      expect(page, d.id).toContain("## Changelog");
    }
  });

  it("each changelog's newest date is the day the spec says it last changed", () => {
    for (const d of SPEC_DOCS.filter((x) => x.id !== "capabilities")) {
      const page = read(`src/content/docs${d.page.replace(/\/$/, "")}.md`);
      const log = page.slice(page.indexOf("## Changelog"));
      expect(log, d.id).toContain(`**${longDate(d.revised)}**`);
      expect(page.split("\n").slice(0, 8).join("\n"), d.id).toContain(`last changed ${longDate(d.revised)}`);
    }
  });

  it("the census's method states the minimum sample, the licence and the credit the code uses", () => {
    const page = read("src/content/docs/spec/census.md");
    expect(page).toContain("at least 100 of its sites");
    expect(page).toContain("[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)");
    expect(page).toContain('crediting "Surfing Dog census, surfingdog.ai, CC BY 4.0"');
    expect(page).toContain('credit "© Overture Maps Foundation"');
    expect(page).not.toContain("A database you make from it is shared under the same licence");
    expect(page).toContain("edition,scope,key,metric,value");
    expect(censusEditionSchema.shape.licence.shape.name.value).toBe("CC-BY-4.0");
    expect(censusEditionSchema.shape.licence.shape.url.value).toBe("https://creativecommons.org/licenses/by/4.0/");
  });

  it("puts the specs in the docs' sidebar, the check with them", () => {
    const config = read("astro.config.mjs");
    for (const d of SPEC_DOCS) expect(config, d.id).toContain(`"spec/${d.id}"`);
    expect(config).toContain('link: "/spec/check/"');
  });

  it("the check runs in the browser and sends nothing anywhere", () => {
    const page = read("src/pages/spec/check.astro");
    expect(page).toContain("packages/spec/src/conformance");
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon/);
  });

  it("the check never says a receipt holds when its signature was not checked, and reads in mono", () => {
    const page = read("src/pages/spec/check.astro");
    expect(page).toContain('"signature_not_checked", "receipt_not_given", "age_not_checked"');
    expect(page).toContain("Its form holds to the spec. Its signature was not checked: paste the inbox's keys below.");
    expect(page).toContain("tableOfContents: false");
    expect(page).toContain("var(--sl-font-mono)");
    expect(read("src/styles/docs.css")).toMatch(/--sl-font-mono: ui-monospace/);
  });
});
