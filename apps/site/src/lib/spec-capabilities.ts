import type { CapabilitiesVocab } from "../../../../packages/spec/src/index";

/**
 * The page /spec/capabilities/ (src/content/docs/spec/capabilities.md), written from the vocabulary itself
 * (packages/spec/vocab/capabilities.json), so the page and the JSON never say two things. The page is a file, not a
 * component, so its headings make the page's contents and it reads as text in llms-full.txt. test/spec.node.test.ts
 * fails when the file is not what this writes; `UPDATE_SPEC_PAGES=1` makes it write it.
 */

const JOURNEYS: Record<string, string> = {
  before: "Before",
  doing: "Doing it",
  after: "After",
  ongoing: "Ongoing",
  policies: "Policies",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 2026-10-15 → 15 October 2026. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|");
const code = (s: string) => `\`${s}\``;

export function capabilitiesMarkdown(v: CapabilitiesVocab): string {
  const doorLabel = new Map((v.doors ?? []).map((d) => [d.id, d.label]));
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  line("---");
  line(`title: ${v.title ?? v.name}`);
  line(
    `description: "The capability vocabulary, version ${v.version}: what an AI agent can do at a business, what has to be seen before anyone says a business offers it, and how each kind of agent door carries it."`,
  );
  line("---");
  line();
  line(
    "<!-- Written from packages/spec/vocab/capabilities.json by apps/site/src/lib/spec-capabilities.ts. Edit the JSON, then run UPDATE_SPEC_PAGES=1 pnpm vitest run apps/site/test/spec.node.test.ts. -->",
  );
  line();
  const versions = Array.from({ length: v.version }, (_, i) => v.version - i)
    .map((n) => `[version ${n}](/spec/capabilities/v${n}.json)`)
    .join(" · ");
  line(
    `**Version ${v.version}**, published ${longDate(v.published ?? "")}. As JSON: [the latest](/spec/capabilities.json) · ${versions} · [its JSON Schema](/spec/schemas/capabilities.json). ${v.licence ?? "MIT"} licence.`,
  );
  line();
  if (v.summary) {
    line(v.summary);
    line();
  }
  line("## How to read it");
  line();
  line("A capability is in one of four states at a business:");
  line();
  line("| State | Meaning |");
  line("| --- | --- |");
  for (const s of v.states) line(`| ${code(s)} | ${cell(v.state_meanings?.[s] ?? "")} |`);
  line();
  line("How anyone knows, from weakest to strongest:");
  line();
  line("| Evidence | Meaning |");
  line("| --- | --- |");
  for (const e of v.evidence) line(`| ${code(e)} | ${cell(v.evidence_meanings?.[e] ?? "")} |`);
  line();
  line(
    `Surfing Dog's network gives ${v.produced.map(code).join(" and ")} today. The six a result leads with are ${v.lead.map(code).join(", ")}.`,
  );
  line();
  line("## Doors");
  line();
  line("A capability is met through a door an agent can use. Each kind of door is read by one thing:");
  line();
  line("| Door | Read by | How |");
  line("| --- | --- | --- |");
  for (const d of v.doors ?? []) {
    const name = d.spec ? `[${d.label}](${d.spec})` : d.label;
    line(`| ${name}${d.experimental ? " (experimental)" : ""} | ${d.via} | ${cell(d.how)} |`);
  }
  line();
  if (v.never_doors) {
    line(v.never_doors);
    line();
  }
  if (v.names) {
    line(v.names);
    line();
  }
  for (const journey of v.journeys) {
    const caps = v.capabilities.filter((c) => c.journey === journey);
    if (caps.length === 0) continue;
    line(`## ${JOURNEYS[journey] ?? journey}`);
    line();
    for (const c of caps) {
      line(`### ${c.label}`);
      line();
      const meta = [code(c.id)];
      if (c.aliases?.length) meta.push(`also ${c.aliases.join(", ")}`);
      if (c.kind) meta.push(`a directory's ${code(`accepts=${c.kind}`)}`);
      line(meta.join(" · "));
      line();
      line(`*${c.question}*`);
      line();
      if (c.definition) {
        line(c.definition);
        line();
      }
      if (c.partial) {
        line(`**Partial:** ${c.partial}`);
        line();
      }
      if (c.evidence) {
        line("| Evidence | What has to be seen |");
        line("| --- | --- |");
        for (const e of v.evidence) {
          const text = c.evidence[e as keyof typeof c.evidence];
          if (text) line(`| ${code(e)} | ${cell(text)} |`);
        }
        line();
      }
      if (c.not_enough?.length) {
        line("Not enough:");
        line();
        for (const n of c.not_enough) line(`- ${n}`);
        line();
      }
      const doors = Object.entries(c.doors ?? {});
      if (doors.length > 0) {
        line("| Door | For example |");
        line("| --- | --- |");
        for (const [id, examples] of doors) {
          line(`| ${doorLabel.get(id as never) ?? id} | ${(examples ?? []).map((x) => cell(code(x))).join(", ")} |`);
        }
        line();
      }
    }
  }
  line("## Changelog");
  line();
  for (const e of [...(v.changelog ?? [])].reverse()) {
    const when = e.published ? `published ${longDate(e.published)}` : `amended ${longDate(e.amended ?? "")}`;
    line(`- **Version ${e.version}**, ${when}. ${e.summary}`);
  }
  line();
  line(
    "Ids never change: a capability is added, never renamed or removed. What counts toward a score, and how much, is a score's own rules, published apart ([the agentic score's](https://surfingdog.ai/v1/score-rules)).",
  );
  return `${out.join("\n")}\n`;
}
