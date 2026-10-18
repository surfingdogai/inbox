/**
 * A heading's own id, written after it: `### Membership {#subscription}` is `<h3 id="subscription">Membership</h3>`.
 * Without it a heading's id is its text, slugged (`membership`), and two headings with the same text get `-1` after
 * the second. The capability vocabulary's page names each capability's heading by its id, so a link to
 * `/spec/capabilities/#subscription` from a result page, a census row or another company's docs lands on it, whatever
 * the heading's words. The heading keeps its place in the page's contents.
 *
 * A Sätteri plugin on the HTML tree, run before Astro gives every heading its id (which keeps one already given).
 */
import type { AstroIntegration } from "astro";

/** `{#id}` at a heading's end: a lower-case id, after a space. */
export const OWN_ID = /^(.*?)\s*\{#([a-z][a-z0-9_-]*)\}$/;

/** What the plugin needs of a node: an element's children, a text's value. */
export interface HeadingNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly HeadingNode[];
}

/** What the plugin needs of Sätteri's context. */
export interface HeadingContext {
  setProperty(node: HeadingNode, key: string, value: unknown): void;
  removeChildAt(node: HeadingNode, index: number): void;
  insertChildAt(node: HeadingNode, index: number, child: HeadingNode): void;
}

/** Gives a heading that ends in `{#id}` that id, and takes the `{#id}` out of its text. */
export function ownHeadingId(node: HeadingNode, ctx: HeadingContext): void {
  const children = node.children ?? [];
  const last = children[children.length - 1];
  if (last?.type !== "text" || typeof last.value !== "string") return;
  const m = last.value.match(OWN_ID);
  if (!m) return;
  const i = children.length - 1;
  ctx.setProperty(node, "id", m[2]);
  ctx.removeChildAt(node, i);
  if (m[1]) ctx.insertChildAt(node, i, { type: "text", value: m[1] });
}

export const headingIdsPlugin = {
  name: "surfingdog-heading-ids",
  element: { filter: ["h1", "h2", "h3", "h4", "h5", "h6"], visit: ownHeadingId },
};

/** Puts the plugin in Astro's Markdown pipeline (Sätteri), on the HTML tree. */
export function headingIdsMarkdown(): AstroIntegration {
  return {
    name: "surfingdog:heading-ids",
    hooks: {
      "astro:config:setup": ({ config }) => {
        const processor = config.markdown.processor;
        const options = processor?.options as { hastPlugins?: unknown[] } | undefined;
        if (processor?.name !== "satteri" || !Array.isArray(options?.hastPlugins)) {
          throw new Error(
            `heading-ids: the Markdown processor is "${processor?.name}", and headings' own ids need Sätteri`,
          );
        }
        options.hastPlugins.push(headingIdsPlugin);
      },
    },
  };
}
