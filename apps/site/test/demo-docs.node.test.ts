import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_MCP, DEMO_URL } from "../src/lib/demo";
import { demoDates, demoDatesPlugin, withDemoDates } from "../src/lib/demo-markdown";

/**
 * The demo a developer meets first: the quickstart's calls, llms.txt and the README point at the demo
 * shop, never at our own inbox, and the quickstart's dates are the build's, never a day that has gone.
 */
const site = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(site(path), "utf8");

describe("the demo's example dates", () => {
  it("are a Saturday at least a week after the build, and the window runs a week from it", () => {
    for (const today of ["2026-10-31", "2026-11-01", "2026-11-06", "2026-11-07", "2026-12-29", "2027-03-27"]) {
      const now = new Date(`${today}T23:30:00Z`);
      const { day, to } = demoDates(now);
      const at = Date.parse(`${day}T00:00:00Z`);
      expect(new Date(at).getUTCDay(), today).toBe(6);
      expect(at - Date.parse(`${today}T00:00:00Z`), today).toBeGreaterThanOrEqual(7 * 86_400_000);
      expect(at - Date.parse(`${today}T00:00:00Z`), today).toBeLessThan(14 * 86_400_000);
      expect(Date.parse(`${to}T00:00:00Z`) - at).toBe(7 * 86_400_000);
    }
  });

  it("put every token in place, and stop the build at one they do not know", () => {
    const dates = { day: "2026-11-07", to: "2026-11-14" };
    expect(withDemoDates("from={{demo:day}}&to={{demo:to}}", dates)).toBe("from=2026-11-07&to=2026-11-14");
    expect(() => withDemoDates("{{demo:month}}", dates)).toThrow(/unknown token/);
  });

  it("render through the site's own Markdown parser in code, inline code and text, and name the day", async () => {
    const fromAstro = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
    const fromProcessor = createRequire(fromAstro.resolve("@astrojs/markdown-satteri"));
    const { markdownToHtml } = (await import(pathToFileURL(fromProcessor.resolve("satteri")).href)) as {
      markdownToHtml: (
        source: string,
        options: { mdastPlugins: unknown[]; features: { gfm: boolean } },
      ) => {
        html: string;
      };
    };
    const now = new Date("2026-10-31T12:00:00Z");
    const plugin = demoDatesPlugin(now);
    expect(plugin.name).toContain("2026-11-07");
    const quickstart = read("src/content/docs/docs/quickstart.md").replace(/^---\n[\s\S]*?\n---\n/, "");
    const html = markdownToHtml(quickstart, { mdastPlugins: [plugin], features: { gfm: true } }).html;
    expect(html).not.toContain("{{demo:");
    expect(html).toContain("from=2026-11-07T00:00:00Z&amp;to=2026-11-14T00:00:00Z");
    expect(html).toContain("2026-11-07T10:00:00Z");
    const inline = markdownToHtml("On `{{demo:day}}`, or {{demo:to}}.", {
      mdastPlugins: [plugin],
      features: { gfm: true },
    });
    expect(inline.html).toContain("<code>2026-11-07</code>");
    expect(inline.html).toContain("2026-11-14");
  });
});

describe("the demo a developer meets first", () => {
  it("is the demo shop in the quickstart's first calls, with no fixed date in them", () => {
    const quickstart = read("src/content/docs/docs/quickstart.md");
    const calls = quickstart.slice(
      quickstart.indexOf("## First calls"),
      quickstart.indexOf("On your own instance, the owner side"),
    );
    expect(calls).toContain(`${DEMO_URL}/v1/bookings`);
    expect(calls).not.toContain("inbox.surfingdog.ai");
    expect(calls).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("is the demo shop in llms.txt and in the README", () => {
    const config = read("astro.config.mjs");
    expect(config).toMatch(/our demo bike shop answers at \$\{DEMO_URL\}/);
    expect(config).toMatch(/url: `\$\{DEMO_URL\}\/\.well-known\/agent-inbox\.json`/);
    expect(config).not.toMatch(/demo[^\n]*inbox\.surfingdog\.ai/i);
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    expect(readme).toContain(DEMO_MCP);
    expect(readme).not.toContain("inbox.surfingdog.ai");
  });
});
