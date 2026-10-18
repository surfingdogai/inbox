import type { CapabilitiesVocab } from "../../../../packages/spec/src/index";

/**
 * The page /spec/capabilities/ (src/content/docs/spec/capabilities.md), written from the vocabulary itself
 * (packages/spec/vocab/capabilities.json), so the page and the JSON never say two things. The page is a file, not a
 * component, so its headings make the page's contents and it reads as text in llms-full.txt. Each capability's heading
 * is anchored at its id (`#subscription`), each part of the journey at `journey-<part>` (src/lib/heading-ids.ts).
 * test/spec.node.test.ts fails when the file is not what this writes; `UPDATE_SPEC_PAGES=1` makes it write it.
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
const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The tested step most capabilities share, said once under "How to read it" and left out of their tables. */
export function commonTested(v: CapabilitiesVocab): string | null {
  const counts = new Map<string, number>();
  for (const c of v.capabilities) {
    const t = c.evidence?.tested;
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [t, n] of counts) if (n > 1 && (best === null || n > (counts.get(best) ?? 0))) best = t;
  return best;
}

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
    `**Version ${v.version}**, published ${longDate(v.published ?? "")}. As JSON: [the latest](/spec/capabilities.json) · ${versions} · [its JSON Schema](/spec/schemas/capabilities.json) · [how names are read, as vectors](/spec/vectors/capability-names.json). ${v.licence ?? "MIT"} licence.`,
  );
  line();
  if (v.summary) {
    line(v.summary);
    line();
  }
  line("## How to read it {#how-to-read-it}");
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
  const tested = commonTested(v);
  if (tested) {
    line(`Unless a capability says otherwise below, its ${code("tested")} step is: ${tested}`);
    line();
  }
  line(
    `**Surfing Dog's network.** It gives ${v.produced.map(code).join(" and ")} today, and its result pages lead with ${v.lead.map(code).join(", ")}. These are the network's choices, not part of what the capabilities mean.`,
  );
  line();
  line("## Doors {#doors}");
  line();
  line("A capability is met through a door an agent can use. Each kind of door is read by one thing:");
  line();
  line('<dl class="spec-doors">');
  for (const d of v.doors ?? []) {
    const name = d.spec ? `<a href="${html(d.spec)}">${html(d.label)}</a>` : html(d.label);
    line(`<dt>${name}${d.experimental ? " (experimental)" : ""} · read by ${html(d.via)}</dt>`);
    line(`<dd>${html(d.how)}</dd>`);
  }
  line("</dl>");
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
    line(`## ${JOURNEYS[journey] ?? journey} {#journey-${journey}}`);
    line();
    for (const c of caps) {
      line(`### ${c.label} {#${c.id}}`);
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
          if (text && !(e === "tested" && text === tested)) line(`| ${code(e)} | ${cell(text)} |`);
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
        line("Through each kind of door, for example:");
        line();
        for (const [id, examples] of doors) {
          line(`- ${doorLabel.get(id as never) ?? id}: ${(examples ?? []).map((x) => code(x)).join(", ")}`);
        }
        line();
      }
    }
  }
  line("## Changelog {#changelog}");
  line();
  for (const e of [...(v.changelog ?? [])].reverse()) {
    line(`- **Version ${e.version}**, ${e.change} ${longDate(e.date)}. ${e.summary}`);
  }
  line();
  line(
    "Version 1 is kept as it was last served, as amended on 13 October 2026 ([`/spec/capabilities/v1.json`](/spec/capabilities/v1.json)).",
  );
  line();
  line(
    "Ids never change: a capability is added, never renamed or removed. What counts toward a score, and how much, is a score's own rules, published apart ([the agentic score's](https://surfingdog.ai/v1/score-rules)).",
  );
  return `${out.join("\n")}\n`;
}
