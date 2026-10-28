import { isPlainObject, LISTING_FIELDS, parseStoredSettings } from "./schema";

/**
 * When the owner last said each listing field (`directory.saved`, spec 0.13): stamped by the inbox on the write that
 * changes it, or that clears the note that it was only read from the business's website (the owner checked it, so it
 * is now the business's own word). What a write itself sends for `saved` is never taken: the stamps are the inbox's,
 * so a network is told the truth about when the business said what it says.
 *
 * `merged` is the document about to be stored; it is changed in place. `stored` is the document as it was.
 */
export function stampListingSaves(stored: unknown, merged: Record<string, unknown>, now: number): void {
  const before = parseStoredSettings(stored).settings;
  const after = parseStoredSettings(merged).settings;
  const at = new Date(now).toISOString();
  const saved: Record<string, string> = { ...before.directory.saved };
  let stamped = false;
  for (const field of LISTING_FIELDS) {
    const changed = JSON.stringify(before.directory[field]) !== JSON.stringify(after.directory[field]);
    const source = `directory.${field}`;
    const checked = Boolean(before.setup.sources[source]) && !after.setup.sources[source];
    if (changed || checked) {
      saved[field] = at;
      stamped = true;
    }
  }
  const directory = isPlainObject(merged.directory) ? merged.directory : null;
  // Nothing to stamp, and nothing sent or stored under `saved`: the document stays as it was written.
  if (!stamped && !(directory && Object.hasOwn(directory, "saved"))) return;
  merged.directory = { ...(directory ?? {}), saved };
}
