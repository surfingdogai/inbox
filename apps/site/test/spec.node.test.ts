import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilitiesVocabSchema, censusEditionSchema, SCHEMA_BASE } from "../../../packages/spec/src/index";
import vocabulary from "../../../packages/spec/vocab/capabilities.json";
import { SPEC_DOCS, specBytes, specFiles, specIndex, vocabularyVersions } from "../src/lib/spec";
import { capabilitiesMarkdown, longDate } from "../src/lib/spec-capabilities";

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
      expect(page, c.id).toContain(`### ${c.label}\n`);
      expect(page, c.id).toContain(`*${c.question}*`);
      expect(page, c.id).toContain(c.definition);
    }
    expect(page).toContain(`**Version ${vocabulary.version}**, published ${longDate(vocabulary.published)}.`);
  });
});

describe("the files machines read", () => {
  const files = specFiles();

  it("serves every vocabulary, schema and set of vectors, byte for byte", () => {
    for (const dir of ["schemas", "vectors", "vocab"]) {
      for (const f of readdirSync(spec(dir)).filter((x) => x.endsWith(".json"))) {
        const served = files.find((x) => x.path === `${dir}/${f}`);
        expect(served, `${dir}/${f}`).toBeDefined();
        expect(specBytes(served?.source ?? "").equals(readFileSync(spec(`${dir}/${f}`))), f).toBe(true);
      }
    }
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
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

  it("lists every spec and every file in /spec/index.json", () => {
    const index = specIndex() as { specs: { id: string; files: string[] }[]; files: string[] };
    expect(index.specs.map((s) => s.id)).toEqual(SPEC_DOCS.map((d) => d.id));
    expect(index.files).toEqual(files.map((f) => `https://surfingdog.ai/spec/${f.path}`));
    for (const s of index.specs) for (const f of s.files) expect(index.files, `${s.id}: ${f}`).toContain(f);
  });
});

describe("the specs for people", () => {
  it("each names its version and the day it last changed, as the index does", () => {
    const index = read("src/content/docs/spec/index.md");
    for (const d of SPEC_DOCS) {
      const page = read(`src/content/docs${d.page.replace(/\/$/, "")}.md`);
      const head = page.split("\n").slice(0, 8).join("\n");
      expect(head.toLowerCase(), d.id).toContain(d.version.toLowerCase());
      expect(index.toLowerCase(), d.id).toContain(`| ${d.version.toLowerCase()} |`);
      expect(index, d.id).toContain(`[${d.title}](${d.page})`);
      expect(index, d.id).toContain(longDate(d.revised));
      expect(page, d.id).toContain("## Changelog");
    }
  });

  it("each changelog's newest date is the day the spec says it last changed", () => {
    for (const d of SPEC_DOCS.filter((x) => x.id === "manifest" || x.id === "receipts")) {
      const page = read(`src/content/docs${d.page.replace(/\/$/, "")}.md`);
      const log = page.slice(page.indexOf("## Changelog"));
      expect(log, d.id).toContain(`**${longDate(d.revised)}**`);
      expect(page.split("\n").slice(0, 8).join("\n"), d.id).toContain(`last changed ${longDate(d.revised)}`);
    }
  });

  it("the census's method states the minimum sample, the licence and the credit the code uses", () => {
    const page = read("src/content/docs/spec/census.md");
    expect(page).toContain("at least 100 of its sites");
    expect(page).toContain("Open Database License 1.0");
    expect(page).toContain('Credit "Surfing Dog (surfingdog.ai)"');
    expect(page).toContain("edition,scope,key,metric,value");
    expect(censusEditionSchema.shape.licence.shape.url.value).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
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
});
