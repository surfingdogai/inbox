import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { conditionSchema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";

/**
 * The tool schemas, as real AI clients take them. Run against the real clients on 1 November 2026:
 * with the owner's MCP connected, Gemini refused every request, even one that called no tool, because
 * a condition (upsert_rule, test_rule) looped back to itself through a required field (`not`); and
 * the MCP Inspector's --strict refused `items: false`, the JSON Schema of a tuple with no rest. These
 * hold every tool of both servers to what those clients accept.
 */

type Json = Record<string, unknown>;

async function toolsOf(app: App, path: string, headers: Record<string, string> = {}) {
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return app.request(String(input), { ...init, headers: merged });
  };
  const client = new Client({ name: "portable-check", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://inbox.test${path}`), { fetch: fetchLike }));
  return (await client.listTools()).tools;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every place a schema object is expected and a bare boolean was given (additionalProperties may be one). */
function bareBooleans(schema: unknown, at: string, out: string[] = []): string[] {
  if (!isObject(schema)) return out;
  const one = (v: unknown, path: string) => {
    if (typeof v === "boolean") out.push(path);
    else bareBooleans(v, path, out);
  };
  for (const key of ["items", "not", "contains", "propertyNames"]) if (key in schema) one(schema[key], `${at}.${key}`);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = schema[key];
    if (Array.isArray(list)) for (const [i, v] of list.entries()) one(v, `${at}.${key}[${i}]`);
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    const map = schema[key];
    if (isObject(map)) for (const [k, v] of Object.entries(map)) one(v, `${at}.${key}.${k}`);
  }
  if (isObject(schema.additionalProperties))
    bareBooleans(schema.additionalProperties, `${at}.additionalProperties`, out);
  return out;
}

/**
 * The definitions a schema reaches without passing an optional property, a nullable branch or an
 * array that may be empty: Gemini takes a $ref loop only through one of those.
 */
function requiredRefs(schema: unknown, out = new Set<string>()): Set<string> {
  if (!isObject(schema)) return out;
  if (typeof schema.$ref === "string") {
    out.add(schema.$ref.replace(/^#\/(\$defs|definitions)\//, ""));
    return out;
  }
  for (const key of ["anyOf", "oneOf"]) {
    const list = schema[key];
    // A union that may be null breaks the loop; otherwise every branch is a way the loop can go.
    if (Array.isArray(list) && !list.some((b) => isObject(b) && b.type === "null")) {
      for (const b of list) requiredRefs(b, out);
    }
  }
  if (Array.isArray(schema.allOf)) for (const b of schema.allOf) requiredRefs(b, out);
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  if (isObject(schema.properties)) {
    for (const [k, v] of Object.entries(schema.properties)) if (required.has(k)) requiredRefs(v, out);
  }
  if (Number(schema.minItems ?? 0) > 0) requiredRefs(schema.items, out);
  return out;
}

/** A definition that reaches itself through required fields only, if any. */
function requiredLoop(schema: Json): string | null {
  const defs = (isObject(schema.$defs) ? schema.$defs : isObject(schema.definitions) ? schema.definitions : {}) as Json;
  const edges = new Map(Object.entries(defs).map(([name, def]) => [name, requiredRefs(def)]));
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === start) return start;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return null;
}

describe("MCP tool schemas, as real clients take them", () => {
  it("the owner's and the customer's tools carry no bare boolean schema and no loop through required fields", async () => {
    const db = await freshDb();
    const app = createApp({ db });
    const owner = await createApiKey(db, { kind: "owner", name: "portable" });
    const tools = [
      ...(await toolsOf(app, "/mcp")),
      ...(await toolsOf(app, "/mcp/owner", { authorization: `Bearer ${owner.key}` })),
    ];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["create_booking", "upsert_rule", "test_rule"]));
    const problems: string[] = [];
    for (const t of tools) {
      for (const [side, schema] of [
        ["inputSchema", t.inputSchema],
        ["outputSchema", t.outputSchema],
      ] as const) {
        if (!isObject(schema)) continue;
        for (const path of bareBooleans(schema, `${t.name}.${side}`)) problems.push(`${path}: a bare boolean`);
        const loop = requiredLoop(schema);
        if (loop) problems.push(`${t.name}.${side}: $defs.${loop} loops back through required fields`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("a condition still needs what `not` negates, though its schema no longer says it is required", () => {
    expect(conditionSchema.safeParse({ not: { fn: "is_sandbox" } }).success).toBe(true);
    expect(conditionSchema.safeParse({ not: { not: { path: "item.type", op: "eq", value: "order" } } }).success).toBe(
      true,
    );
    expect(conditionSchema.safeParse({}).success).toBe(false);
    expect(conditionSchema.safeParse({ not: null }).success).toBe(false);
    expect(conditionSchema.safeParse({ all: [{ not: {} }] }).success).toBe(false);
  });
});
