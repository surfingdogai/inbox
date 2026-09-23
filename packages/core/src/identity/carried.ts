import { MAX_CREDENTIAL_LENGTH, MAX_CREDENTIALS, parseCredential } from "../protocol/credentials";
import { WriteError } from "../write/errors";

/**
 * What an agent carries for its person (ADR-017 §2.4): passes in the `pass` field (space-separated)
 * or the `Sdi-Pass` header, and perhaps a key. At most eight strings of at most 200 characters;
 * the first one per network counts, a field before the header and any pass before a key. A string
 * that is none of them is dropped, not refused: the request still goes through, unrecognised.
 */
export interface Carried {
  /** One per network, in the order they count. */
  readonly credentials: readonly string[];
  /** Strings that were not a key, a pass or a pass reference. */
  readonly dropped: number;
}

export function collectCarried(
  field: string | undefined,
  key: string | undefined,
  header: readonly string[] | undefined,
): Carried {
  const fromField = (field ?? "").split(/\s+/).filter((s) => s.length > 0);
  if (fromField.length > MAX_CREDENTIALS) {
    throw new WriteError("invalid_input", `at most ${MAX_CREDENTIALS} passes`, {
      fields: [{ path: "pass", problem: "invalid", message: `at most ${MAX_CREDENTIALS} space-separated passes` }],
    });
  }
  for (const s of fromField) {
    if (s.length > MAX_CREDENTIAL_LENGTH) {
      throw new WriteError("invalid_input", "a pass is at most 200 characters", {
        fields: [{ path: "pass", problem: "invalid", message: "each pass is at most 200 characters" }],
      });
    }
  }
  if (key !== undefined && parseCredential(key)?.kind !== "key") {
    throw new WriteError("invalid_input", "key is not a key (sdkey1_<network host>_<id>_<secret>)", {
      fields: [{ path: "key", problem: "invalid", message: "not a key: sdkey1_<network host>_<id>_<secret>" }],
    });
  }
  const all = [...fromField, ...(header ?? []), ...(key === undefined ? [] : [key])].slice(0, 3 * MAX_CREDENTIALS);
  const seen = new Set<string>();
  const credentials: string[] = [];
  let dropped = 0;
  for (const s of all) {
    const c = parseCredential(s);
    if (!c) {
      dropped++;
      continue;
    }
    if (seen.has(c.host)) continue;
    seen.add(c.host);
    credentials.push(s);
    if (credentials.length === MAX_CREDENTIALS) break;
  }
  return { credentials, dropped };
}
