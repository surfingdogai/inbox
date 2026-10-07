import { readFileSync } from "node:fs";
import type { APIRoute, GetStaticPaths } from "astro";
import { shellFonts } from "../../lib/shell";

/** /fonts/<name>.<hash>.woff2: the site's fonts at names that change with their bytes, for shell.css. */
export const prerender = true;

export const getStaticPaths = (() =>
  shellFonts().map((f) => ({ params: { file: f.name }, props: { path: f.path } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(readFileSync((props as { path: string }).path), { headers: { "Content-Type": "font/woff2" } });
