/**
 * A settings write is a change, never a reset (22 Sep 2026, after a partial write to our own
 * instance silently turned `network.join` off — every section the caller left out came back as
 * its default). The caller's document is laid over the current one: objects merge key by key,
 * anything else — strings, numbers, booleans, arrays — replaces what was there. Leaving a key out
 * is how it is kept; what clears a value is whatever the schema accepts for that field.
 */
export function mergeSettings(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(current[key]) ? mergeSettings(current[key], value) : value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
