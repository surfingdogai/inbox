import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The whole repository is MIT (ADR-008, amended 8 Oct 2026). These tests hold every file to it: the
 * root LICENSE is the MIT text, every package says MIT, every LICENSE copy matches the root, and no
 * file says the inbox is under the AGPL. The only places the old licence may still be named are the
 * history: ADR-008's original decision, kept below its amendment, and the launch post, which keeps
 * its words under a dated note.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

/** Every file in the repository, tracked or new, that git does not ignore. */
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f && !f.startsWith(".claude/"))
  .filter((f) => statSync(`${root}${f}`, { throwIfNoEntry: false })?.isFile());

const ADR = "docs/adr/008-licences.md";
const POST = "apps/site/src/content/blog/surfing-dog-inbox-is-open.md";
const SELF = "apps/site/test/licence.node.test.ts";
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|mp4|webm|wasm|zip|gz)$/i;
const OLD = /\bAGPL\b|Affero|gnu\.org\/licenses\/agpl/i;

describe("the licence: MIT, everywhere", () => {
  it("has the MIT text at the root, in Surfing Dog Lda's name", () => {
    const licence = read("LICENSE");
    expect(licence.startsWith("MIT License\n")).toBe(true);
    expect(licence).toContain("Copyright (c) 2026 Surfing Dog Lda");
  });

  it("says MIT in every package, and every LICENSE copy is the root's", () => {
    const manifests = files.filter((f) => f === "package.json" || f.endsWith("/package.json"));
    expect(manifests.length).toBeGreaterThan(5);
    for (const f of manifests) expect(JSON.parse(read(f)).license, f).toBe("MIT");
    const copies = files.filter((f) => f.endsWith("/LICENSE"));
    expect(copies.length).toBeGreaterThan(0);
    for (const f of copies) expect(read(f), f).toBe(read("LICENSE"));
  });

  it("has no file that says the inbox is under the AGPL, outside the history", () => {
    const named = files
      .filter((f) => f !== ADR && f !== POST && f !== SELF && !BINARY.test(f))
      .filter((f) => {
        const text = read(f);
        return !text.includes("\0") && OLD.test(text);
      });
    expect(named).toEqual([]);
  });

  it("keeps the history marked as history", () => {
    const adr = read(ADR);
    expect(adr.indexOf("## Amendment, 2026-10-08")).toBeGreaterThan(-1);
    expect(adr.indexOf("## Amendment, 2026-10-08")).toBeLessThan(adr.indexOf("## Decision"));
    const body = read(POST).split(/^---$/m)[2]?.trimStart() ?? "";
    expect(body.startsWith("*Update, 8 Oct 2026: the inbox is now MIT-licensed, like the rest of the project.*")).toBe(
      true,
    );
  });
});
