import { sha256Hex } from "@surfingdog/platform";

/** Deterministic JSON: sorted object keys, no undefined. Enough for hashing our own inputs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

export async function hashText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
