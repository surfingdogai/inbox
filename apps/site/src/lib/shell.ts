import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * shell.css: the site's look for pages the site does not render. The network's public pages (the
 * checker at /check, result pages at /b/<domain>, the leaderboards, the crawler's /bot page) are
 * served by another service behind the same domain, and link https://surfingdog.ai/shell.css?v=N
 * so they wear the same tokens, fonts, sky, bar, footer, box and type as every page here.
 *
 * It is not a copy. It is site.css itself (with the design tokens it imports from @surfingdog/ui),
 * compiled and optimised by the same Tailwind pipeline the site's own build runs (@tailwindcss/vite
 * is @tailwindcss/node's compile, then its optimize), plus shell/parts.css: the bar, the footer,
 * the box, the score card and the tables, written as plain classes because those pages carry no
 * script. A token changed in site.css or in the tokens changes shell.css in the same build.
 *
 * The fonts are the site's own (Fontsource), published at /fonts/<name>.<hash>.woff2 so the names
 * change with the bytes and can be cached for a year.
 *
 * SHELL_VERSION is the ?v= the network links. The site's test holds SHELL_SHA256, the hash of what
 * this version builds: when anything that goes into shell.css changes, the test fails until the
 * version is raised and the hash recorded, and the network's shellVersion has to follow.
 */
export const SHELL_VERSION = 1;
export const SHELL_SHA256 = "d046a0359e2f08cdf8e91062f933517cd6fa7ddaf6bc886883d09e1cc1dbf7a5";

/** The utilities shell/parts.css leans on. The site's own build emits only those it finds used. */
const UTILITIES = ["glass", "glass-strong", "pill-glass", "row-glass", "tabular"];

/** The two families the site loads, from the same packages Layout.astro imports. */
const FONT_PACKAGES = ["@fontsource-variable/manrope", "@fontsource-variable/plus-jakarta-sans"];

export interface ShellFont {
  /** The published name: the package's file name with eight hex of its sha256 before .woff2. */
  name: string;
  /** Where the bytes are on disk. */
  path: string;
}

/** The site's directory (apps/site), from wherever the build or the test was started. */
export function siteDir(from = process.cwd()): string {
  for (const dir of [from, join(from, "apps", "site")]) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "@surfingdog/site") return dir;
  }
  throw new Error(`shell.css: run from apps/site or the repository root, not ${from}`);
}

const pkgDir = (dir: string, name: string) => realpathSync(join(dir, "node_modules", name));

function fontFaces(dir: string): { css: string; fonts: ShellFont[] } {
  const fonts: ShellFont[] = [];
  const css = FONT_PACKAGES.map((pkg) => {
    const root = pkgDir(dir, pkg);
    return readFileSync(join(root, "index.css"), "utf8").replace(
      /url\(\.\/files\/([a-z0-9-]+)\.woff2\)/g,
      (_m, file: string) => {
        const path = join(root, "files", `${file}.woff2`);
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 8);
        const name = `${file}.${hash}.woff2`;
        fonts.push({ name, path });
        return `url(/fonts/${name})`;
      },
    );
  }).join("\n");
  return { css, fonts };
}

/** The font files shell.css names, for the /fonts/[file] endpoint. */
export function shellFonts(dir = siteDir()): ShellFont[] {
  return fontFaces(dir).fonts;
}

interface TailwindNode {
  compile(
    css: string,
    options: { base: string; onDependency: (path: string) => void; shouldRewriteUrls?: boolean },
  ): Promise<{ build(candidates: string[]): string }>;
  optimize(css: string, options: { minify: boolean }): { code: string };
}

/**
 * The compiler the site's build uses: @tailwindcss/node, as @tailwindcss/vite (a dependency of the
 * site) resolves it, so shell.css is made by exactly the version and the options site.css is.
 */
async function tailwindNode(dir: string): Promise<TailwindNode> {
  const fromVite = createRequire(join(pkgDir(dir, "@tailwindcss/vite"), "package.json"));
  const cjs = fromVite.resolve("@tailwindcss/node");
  return (await import(/* @vite-ignore */ pathToFileURL(join(dirname(cjs), "index.mjs")).href)) as TailwindNode;
}

/**
 * shell.css, as the site publishes it at /shell.css: minified, as the site's own stylesheets are.
 * `minify: false` is the same stylesheet laid out to be read (the site's test compares its tokens).
 */
export async function buildShell(dir = siteDir(), { minify = true } = {}): Promise<string> {
  const tw = await tailwindNode(dir);
  const compiler = await tw.compile(`@import "../src/styles/site.css";\n@import "./parts.css";\n`, {
    base: join(dir, "shell"),
    onDependency: () => {},
    shouldRewriteUrls: true,
  });
  // The footer's logo, inline: a page on the network's own host may load no image from this one.
  const logo = readFileSync(join(dir, "shell", "logo-40.png")).toString("base64");
  const css = [
    compiler.build(UTILITIES),
    fontFaces(dir).css,
    `:root { --sd-logo: url(data:image/png;base64,${logo}); }`,
  ].join("\n");
  const { code } = tw.optimize(css, { minify });
  return `/* surfingdog.ai shell.css v${SHELL_VERSION}: the site's tokens, fonts, bar, footer and type for pages it does not render. Built from site.css by src/lib/shell.ts; do not edit. */\n${code.trim()}\n`;
}

/** The sha256 of a built shell.css, hex. */
export function shellHash(css: string): string {
  return createHash("sha256").update(css).digest("hex");
}
