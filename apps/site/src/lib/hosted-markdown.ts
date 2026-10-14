/**
 * Markdown that follows the hosted pilot's switch (src/lib/hosted.ts). A page writes both of its
 * versions, each between two HTML comments:
 *
 *   <!-- hosted: open -->   what it says while the pilot is open   <!-- hosted: end -->
 *   <!-- hosted: closed --> what it says while it is closed        <!-- hosted: end -->
 *
 * An `open` part may run straight into a `closed` one before the `end`. The markers work between
 * blocks (each on its own line, with a blank line around it) and inside a line or a table cell.
 * Before anything is rendered the version for the other state is dropped, and the markers with it,
 * so a page says one thing, and while the pilot is closed it renders as it did before the markers.
 * A marker left open, one this file does not know, or one that shares its block with text (a line
 * that starts with a marker and goes on) stops the build.
 *
 * A docs page's description is frontmatter, which Markdown plugins do not reach: a page gives the
 * description it has while the pilot is open as `hostedOpen.description`, and `hostedDocsData`
 * (src/content.config.ts) puts it in place.
 */
import type { AstroIntegration } from "astro";
import { HOSTED_PILOT_OPEN } from "./hosted";

/** The smallest shape of a Markdown tree this needs: a node, its children, an HTML node's text. */
export interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MdNode[];
}

const MARKER = /^<!--\s*hosted:\s*([a-z]+)\s*-->$/;
const ANY_MARKER = /<!--\s*hosted:/;

/**
 * The marker an HTML node is, if it is one. A node that holds a marker and anything else (a marker
 * that starts a line with text after it, which Markdown reads as one block of raw HTML) stops the
 * build, since neither of its versions could be dropped and the page would say both.
 */
function markerOf(node: MdNode): "open" | "closed" | "end" | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const value = node.value.trim();
  if (!ANY_MARKER.test(value)) return null;
  const m = value.match(MARKER);
  if (!m) {
    throw new Error(
      `hosted-markdown: a marker must stand alone, on its own line with a blank line around it, or sit inside a line: "${value.slice(0, 80)}"`,
    );
  }
  const word = m[1];
  if (word === "open" || word === "closed" || word === "end") return word;
  throw new Error(`hosted-markdown: unknown marker "${node.value.trim()}"`);
}

/**
 * Names, at every level under `node`, what to drop for a state of the switch: every marker, and
 * each node of the version for the other state. What is kept is walked in turn.
 */
export function hostedDrops(node: MdNode, open: boolean, drop: (node: MdNode) => void): void {
  if (!node.children) return;
  let part: "open" | "closed" | null = null;
  for (const child of node.children) {
    const marker = markerOf(child);
    if (marker) {
      part = marker === "end" ? null : marker;
      drop(child);
    } else if ((part === "open" && !open) || (part === "closed" && open)) {
      drop(child);
    } else {
      hostedDrops(child, open, drop);
    }
  }
  if (part !== null) throw new Error(`hosted-markdown: a "${part}" part without its <!-- hosted: end -->`);
}

/** What a Sätteri plugin's hook is handed, as far as this needs it. */
interface DropContext {
  readonly source: string;
  removeNode(node: MdNode): void;
}

/**
 * The Markdown plugin, for Sätteri (Astro's Markdown processor). A page with no marker is left as
 * it is, untouched. Its name carries the switch's state: Astro keeps each page as rendered between
 * builds and starts afresh only when its config changes, and the plugin's name is part of that
 * config, so a build after the switch flips renders every page again.
 */
export function hostedMarkdownPlugin(open: boolean = HOSTED_PILOT_OPEN) {
  return {
    name: `surfingdog-hosted-pilot: ${open ? "open" : "closed"}`,
    before(root: MdNode, ctx: DropContext) {
      if (!ctx.source.includes("<!-- hosted:")) return;
      hostedDrops(root, open, (node) => ctx.removeNode(node));
    },
  };
}

/**
 * Puts the plugin first in the Markdown pipeline (astro.config.mjs lists this before Starlight), so
 * the other plugins never see the version that is dropped.
 */
export function hostedPilotMarkdown(open: boolean = HOSTED_PILOT_OPEN): AstroIntegration {
  return {
    name: "surfingdog:hosted-pilot-markdown",
    hooks: {
      "astro:config:setup": ({ config }) => {
        const processor = config.markdown.processor;
        const options = processor?.options as { mdastPlugins?: unknown[] } | undefined;
        if (processor?.name !== "satteri" || !Array.isArray(options?.mdastPlugins)) {
          throw new Error(
            `hosted-markdown: the Markdown processor is "${processor?.name}", and the pages with two versions need Sätteri`,
          );
        }
        options.mdastPlugins.unshift(hostedMarkdownPlugin(open));
      },
    },
  };
}

/** A docs page's data with its open description in place while the pilot is open. */
export function hostedDocsData<
  T extends { description?: string | undefined; hostedOpen?: { description: string } | undefined },
>(data: T, open: boolean = HOSTED_PILOT_OPEN): T {
  return open && data.hostedOpen ? { ...data, description: data.hostedOpen.description } : data;
}
