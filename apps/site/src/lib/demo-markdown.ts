/**
 * The demo shop's example dates in the docs, worked out when the site is built, so an example never
 * names a day that has gone. A page writes a token in its text or its code, and the build puts the
 * date in its place:
 *
 *   {{demo:day}}   the Saturday the examples book, at least a week after the build (YYYY-MM-DD)
 *   {{demo:to}}    a week after it, the end of the window the examples ask free times in
 *
 * The demo shop (src/lib/demo.ts has its address) is open Saturdays 09:00–13:00 Europe/Lisbon, as
 * seedShowcase in apps/inbox/src/seed.ts sets its hours, so 10:00 UTC on that day is a time it takes,
 * in summer and in winter. A token this file does not know stops the build.
 */
import type { AstroIntegration } from "astro";

const DAY_MS = 86_400_000;
const TOKEN = /\{\{demo:([a-z]+)\}\}/g;

/** The dates the tokens stand for, from the day the site is built. */
export function demoDates(now: Date): { readonly day: string; readonly to: string } {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 7 * DAY_MS);
  const day = new Date(at.getTime() + ((6 - at.getUTCDay() + 7) % 7) * DAY_MS);
  return {
    day: day.toISOString().slice(0, 10),
    to: new Date(day.getTime() + 7 * DAY_MS).toISOString().slice(0, 10),
  };
}

/** `text` with every token in place. */
export function withDemoDates(text: string, dates: ReturnType<typeof demoDates>): string {
  return text.replace(TOKEN, (token, name: string) => {
    if (name === "day" || name === "to") return dates[name];
    throw new Error(`demo-markdown: unknown token ${token}`);
  });
}

/** What the plugin needs of a node and of Sätteri's context. */
interface ValueNode {
  readonly type: string;
  readonly value?: string;
}
interface ValueContext {
  setProperty(node: ValueNode, key: "value", value: string): void;
}

/**
 * The Markdown plugin, for Sätteri. Its name carries the date: Astro keeps each page as rendered
 * between builds and starts afresh only when its config changes, so a build on a later day renders
 * the pages again with the new dates.
 */
export function demoDatesPlugin(now: Date = new Date()) {
  const dates = demoDates(now);
  const put = (node: ValueNode, ctx: ValueContext) => {
    if (typeof node.value === "string" && node.value.includes("{{demo:")) {
      ctx.setProperty(node, "value", withDemoDates(node.value, dates));
    }
  };
  return { name: `surfingdog-demo-dates: ${dates.day}`, text: put, inlineCode: put, code: put };
}

/** Puts the plugin in Astro's Markdown pipeline (Sätteri), on the Markdown tree. */
export function demoDatesMarkdown(now: Date = new Date()): AstroIntegration {
  return {
    name: "surfingdog:demo-dates-markdown",
    hooks: {
      "astro:config:setup": ({ config }) => {
        const processor = config.markdown.processor;
        const options = processor?.options as { mdastPlugins?: unknown[] } | undefined;
        if (processor?.name !== "satteri" || !Array.isArray(options?.mdastPlugins)) {
          throw new Error(
            `demo-markdown: the Markdown processor is "${processor?.name}", and the demo's dates need Sätteri`,
          );
        }
        options.mdastPlugins.push(demoDatesPlugin(now));
      },
    },
  };
}
