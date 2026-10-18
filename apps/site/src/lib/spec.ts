import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { siteDir } from "./shell";

/**
 * The reference at https://surfingdog.ai/spec/: the specs people read (the pages under src/content/docs/spec), and the
 * files machines read, served byte for byte from packages/spec (MIT): every vocabulary, JSON Schema and set of test
 * vectors, each version of the capability vocabulary at a path of its own, and /spec/index.json, which lists them.
 * A schema's `$id` is the address it is served at here.
 */

export const SPEC_ORIGIN = "https://surfingdog.ai";
/** packages/spec, found from the site's own directory: a built chunk does not sit where this file does. */
const SPEC_DIR = `${join(siteDir(), "..", "..", "packages", "spec")}/`;

/** One published file: where it is served under /spec/, and the file in packages/spec it is. */
export interface SpecFile {
  /** The path under /spec/: `schemas/manifest.json`. */
  readonly path: string;
  /** The file in packages/spec: `schemas/manifest.json`. */
  readonly source: string;
}

const jsonIn = (dir: string) =>
  readdirSync(`${SPEC_DIR}${dir}`)
    .filter((f) => f.endsWith(".json"))
    .sort();

/** The capability vocabulary's versions: each file's `version`, and the file. */
export function vocabularyVersions(): { version: number; source: string }[] {
  return jsonIn("vocab")
    .filter((f) => /^capabilities(-v\d+)?\.json$/.test(f))
    .map((f) => ({
      version: (JSON.parse(readFileSync(`${SPEC_DIR}vocab/${f}`, "utf8")) as { version: number }).version,
      source: `vocab/${f}`,
    }))
    .sort((a, b) => a.version - b.version);
}

/** The capability vocabulary's own files in vocab/: served at /spec/capabilities.json and /spec/capabilities/v<N>.json. */
const VOCABULARY_FILE = /^capabilities(-v\d+)?\.json$/;

/**
 * Every file served under /spec/, in path order: each at one address. The capability vocabulary is at
 * /spec/capabilities.json (the latest) and /spec/capabilities/v<N>.json (each version), never under /spec/vocab/.
 */
export function specFiles(): SpecFile[] {
  const files: SpecFile[] = [{ path: "capabilities.json", source: "vocab/capabilities.json" }];
  for (const v of vocabularyVersions()) files.push({ path: `capabilities/v${v.version}.json`, source: v.source });
  for (const dir of ["schemas", "vectors", "vocab"]) {
    for (const f of jsonIn(dir)) {
      if (dir === "vocab" && VOCABULARY_FILE.test(f)) continue;
      files.push({ path: `${dir}/${f}`, source: `${dir}/${f}` });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** A published file's bytes, exactly as packages/spec has them. */
export function specBytes(source: string): Buffer {
  return readFileSync(`${SPEC_DIR}${source}`);
}

/** The specs for people, each with its version and the date it last changed. */
export interface SpecDoc {
  readonly id: "capabilities" | "manifest" | "receipts" | "census";
  readonly title: string;
  /** What it is, in one line. */
  readonly summary: string;
  /** The version, for a machine to compare: a number, or the manifest's identifier. */
  readonly version: number | string;
  /** The version as the document names it, in words. */
  readonly label: string;
  /** The day its rules last changed, YYYY-MM-DD. */
  readonly revised: string;
  /** Its page. */
  readonly page: string;
  /** Its machine-readable files under /spec/: the document itself, its schemas, its vectors. */
  readonly files: readonly string[];
}

const vocabulary = JSON.parse(readFileSync(`${SPEC_DIR}vocab/capabilities.json`, "utf8")) as {
  version: number;
  published: string;
};

export const SPEC_DOCS: readonly SpecDoc[] = [
  {
    id: "capabilities",
    title: "What an AI agent can do at a business",
    summary:
      "The capability vocabulary: twenty things an agent can do, what each means, the evidence for it, and how each kind of agent door carries it.",
    version: vocabulary.version,
    label: `version ${vocabulary.version}`,
    revised: vocabulary.published,
    page: "/spec/capabilities/",
    files: [
      "capabilities.json",
      `capabilities/v${vocabulary.version}.json`,
      "schemas/capabilities.json",
      "vectors/capability-names.json",
    ],
  },
  {
    id: "manifest",
    title: "Agent inbox manifest",
    summary: "The document at /.well-known/agent-inbox.json: what a business's inbox takes and where its doors are.",
    version: "surfingdog-inbox/0",
    label: "surfingdog-inbox/0",
    revised: "2026-10-15",
    page: "/spec/manifest/",
    files: ["schemas/manifest.json", "vectors/doors-elsewhere.json", "vectors/profile.json"],
  },
  {
    id: "receipts",
    title: "Receipts",
    summary: "The signed record of a promise and how it ended, and the customer's agent's counter-signature.",
    version: 2,
    label: "claims version 2",
    revised: "2026-09-27",
    page: "/spec/receipts/",
    files: [
      "schemas/receipt-v1.json",
      "schemas/receipt-v2.json",
      "schemas/receipt-ack-v1.json",
      "schemas/receipt-ack-v2.json",
      "vectors/receipts.json",
      "vectors/receipts-v2.json",
      "vectors/receipts-v6.json",
    ],
  },
  {
    id: "census",
    title: "The census of what AI agents can do",
    summary:
      "How the monthly census counts what agents can do at the websites checked, and the format of its open data.",
    version: 1,
    label: "method version 1",
    revised: "2026-10-18",
    page: "/spec/census/",
    files: [
      "schemas/census-edition.json",
      "schemas/census-editions.json",
      "vectors/census-edition.json",
      "schemas/mcp-get-census-input.json",
      "schemas/mcp-get-census-output.json",
      "vocab/score-rules-v3.json",
    ],
  },
];

/** /spec/index.json: every spec, its version and its files, for a machine that wants them all. */
export function specIndex(): Record<string, unknown> {
  const url = (p: string) => `${SPEC_ORIGIN}/spec/${p}`;
  return {
    title: "Surfing Dog specs",
    licence: { code_and_docs: "MIT", data: "ODbL-1.0 (the census's counts)" },
    conformance: `${SPEC_ORIGIN}/spec/check/`,
    source: "https://github.com/surfingdogai/inbox/tree/main/packages/spec",
    specs: SPEC_DOCS.map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      version: d.version,
      version_label: d.label,
      revised: d.revised,
      page: `${SPEC_ORIGIN}${d.page}`,
      files: d.files.map(url),
      ...(d.id === "capabilities"
        ? {
            latest: url("capabilities.json"),
            versions: vocabularyVersions().map((v) => ({
              version: v.version,
              url: url(`capabilities/v${v.version}.json`),
            })),
          }
        : {}),
    })),
    files: specFiles().map((f) => url(f.path)),
  };
}
