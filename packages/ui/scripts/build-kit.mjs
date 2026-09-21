// Assembles dist/kit: the standalone page (index.html + kit.css + ../fonts) and a single-file
// artifact.html (fonts inlined as data URIs, no document skeleton) for publishing.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
mkdirSync(path.join(dist, "kit"), { recursive: true });
mkdirSync(path.join(dist, "fonts"), { recursive: true });

const fonts = [
  ["@fontsource-variable/manrope", "files/manrope-latin-wght-normal.woff2"],
  ["@fontsource-variable/manrope", "files/manrope-latin-ext-wght-normal.woff2"],
  ["@fontsource-variable/plus-jakarta-sans", "files/plus-jakarta-sans-latin-wght-normal.woff2"],
  ["@fontsource-variable/plus-jakarta-sans", "files/plus-jakarta-sans-latin-ext-wght-normal.woff2"],
];
const fontData = new Map();
for (const [pkg, file] of fonts) {
  const src = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
  const name = path.basename(file);
  cpSync(src, path.join(dist, "fonts", name));
  fontData.set(name, `data:font/woff2;base64,${readFileSync(src).toString("base64")}`);
}

const html = readFileSync(path.join(root, "kit", "index.html"), "utf8");
writeFileSync(path.join(dist, "kit", "index.html"), html);

// Artifact variant: <title> + one <style> + the body fragment between the markers.
const css = readFileSync(path.join(dist, "kit", "kit.css"), "utf8");
const pick = (id) => html.match(new RegExp(`<style id="${id}">([\\s\\S]*?)</style>`))?.[1] ?? "";
let fontsCss = pick("kit-fonts");
for (const [name, uri] of fontData) fontsCss = fontsCss.replaceAll(`../fonts/${name}`, uri);
const layoutCss = pick("kit-layout");
const body = html.slice(html.indexOf("<!-- kit:start -->"), html.indexOf("<!-- kit:end -->"));
const artifact = `<title>Inbox Kit</title>\n<style>\n${fontsCss}\n${css}\n${layoutCss}\n</style>\n${body}`;
writeFileSync(path.join(dist, "kit", "artifact.html"), artifact);
console.log(`kit built: ${(artifact.length / 1024).toFixed(0)} KB artifact, ${fonts.length} fonts`);
