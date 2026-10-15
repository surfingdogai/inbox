import type { APIRoute, GetStaticPaths } from "astro";
import { specBytes, specFiles, specIndex } from "../../lib/spec";

/**
 * /spec/<path>.json: packages/spec's vocabularies, JSON Schemas and vectors, byte for byte, each version of the
 * capability vocabulary at /spec/capabilities/v<N>.json, and /spec/index.json, which lists them (src/lib/spec.ts).
 */
export const prerender = true;

export const getStaticPaths = (() => [
  { params: { file: "index.json" }, props: { source: null } },
  ...specFiles().map((f) => ({ params: { file: f.path }, props: { source: f.source } })),
]) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const source = (props as { source: string | null }).source;
  const body = source === null ? `${JSON.stringify(specIndex(), null, 2)}\n` : new Uint8Array(specBytes(source));
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
};
