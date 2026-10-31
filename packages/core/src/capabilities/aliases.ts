import { z } from "zod";

/**
 * The names an agent sends in either spelling: the inputs' own (top-level fields are snake_case,
 * payloads keep their schema.org camelCase) and the other one, which agents write as often, from
 * habit or from a create answer that carries `accessToken`. Each pair is snake_case, camelCase.
 */
export const FIELD_ALIASES: readonly (readonly [string, string])[] = [
  ["service_id", "serviceId"],
  ["access_token", "accessToken"],
];

type Def = {
  readonly type: string;
  readonly shape?: Record<string, z.core.$ZodType>;
  readonly innerType?: z.core.$ZodType;
  readonly in?: z.core.$ZodType;
  readonly out?: z.core.$ZodType;
};

/**
 * The fields of an object schema, through optional, default, nullable and pipe; null for anything
 * else, a schema that is not Zod's included.
 */
function shapeOf(schema: z.core.$ZodType): Record<string, z.core.$ZodType> | null {
  let at: z.core.$ZodType | undefined = schema;
  for (let depth = 0; at && depth < 8; depth++) {
    const def: Def | undefined = (at as { _zod?: { def?: Def } })._zod?.def;
    if (!def) return null;
    if (def.type === "object") return def.shape ?? null;
    if (def.type === "pipe") at = def.in?._zod.def.type === "transform" ? def.out : def.in;
    else at = def.innerType;
  }
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `value` with each field sent under its other spelling renamed to the one `schema` has, at every
 * object level the schema describes. A name is renamed only where the schema has one spelling and not
 * the other, and only when the value does not already carry the schema's own: what an input names
 * stays as it was, and anything else is left for the schema to judge.
 */
export function withAliasesFor(schema: z.core.$ZodType, value: unknown): unknown {
  const shape = shapeOf(schema);
  if (!shape || !isPlainObject(value)) return value;
  let out = value;
  const own = () => {
    if (out === value) out = { ...value };
    return out;
  };
  for (const [snake, camel] of FIELD_ALIASES) {
    const want = snake in shape && !(camel in shape) ? snake : camel in shape && !(snake in shape) ? camel : null;
    if (!want) continue;
    const other = want === snake ? camel : snake;
    if (other in out && !(want in out)) {
      const o = own();
      o[want] = o[other];
      delete o[other];
    }
  }
  for (const [key, field] of Object.entries(shape)) {
    const v = out[key];
    if (!isPlainObject(v)) continue;
    const renamed = withAliasesFor(field, v);
    if (renamed !== v) own()[key] = renamed;
  }
  return out;
}

/** Whether `schema` has any field `FIELD_ALIASES` names, at any object level. */
export function hasAliasedFields(schema: z.core.$ZodType): boolean {
  const shape = shapeOf(schema);
  if (!shape) return false;
  return Object.entries(shape).some(
    ([key, field]) => FIELD_ALIASES.some((pair) => pair.includes(key)) || hasAliasedFields(field),
  );
}

/**
 * The input a door validates against: `schema`, taking each field of `FIELD_ALIASES` under either
 * spelling (`withAliasesFor`). It reads and describes itself as `schema` (its JSON Schema, in MCP's tool
 * list and in /openapi.json, is the same), so the spelling it documents stays the one to send.
 */
export function lenientInput<S extends z.ZodType>(schema: S) {
  return z.preprocess((value: unknown) => withAliasesFor(schema, value), schema);
}
