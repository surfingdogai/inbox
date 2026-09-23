/**
 * A settings write is a change, never a reset (22 Sep 2026, after a partial write to our own
 * instance silently turned `network.join` off — every section the caller left out came back as
 * its default). The caller's document is laid over the current one, as JSON Merge Patch
 * (RFC 7396) does it: objects merge key by key, `null` removes the key (so its default applies
 * again, or an optional value is cleared), and anything else — strings, numbers, booleans,
 * arrays — replaces what was there. Leaving a key out is how it is kept.
 */
export function mergeSettings(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = isPlainObject(value) ? mergeSettings(out[key], value) : value;
  }
  return out;
}

/**
 * Every path a patch sets or removes: `{business: {name: "x"}}` is `business.name`. A write is
 * held to the schema along these paths only, so a stored value an older version accepted and
 * this one does not never blocks a change to something else.
 */
export function patchPaths(patch: unknown, prefix: readonly string[] = []): string[][] {
  if (!isPlainObject(patch) || (Object.keys(patch).length === 0 && prefix.length > 0)) return [[...prefix]];
  return Object.entries(patch).flatMap(([key, value]) => patchPaths(value, [...prefix, key]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
