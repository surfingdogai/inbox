import type { APIRoute } from "astro";
import { buildShell } from "../lib/shell";

/** /shell.css: the site's look for the pages another service renders under this domain (src/lib/shell.ts). */
export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(await buildShell(), { headers: { "Content-Type": "text/css; charset=utf-8" } });
