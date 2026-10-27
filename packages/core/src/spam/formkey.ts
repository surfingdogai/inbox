import type { Db } from "../db";
import { isUlid, ulid } from "../ids";
import type { SecretBox } from "../secrets/box";
import { countStatement } from "./meter";
import { dayOf, type FormFacts } from "./types";

/**
 * The business's own form, signed (ADR-041 §4.1). Each form is drawn with a key: a ULID (when it was
 * drawn) and ten characters of an HMAC over it, the page and the kind of request — 36 characters, the
 * idempotency key all the same, so a double click is one request. Its hidden field takes a name drawn
 * from the same key, so no bot learns one name for every form. A key that does not verify is a forged
 * one, or one drawn before the secret changed: it counts against a request, never decides alone.
 * Without a secret to sign with, keys are plain ULIDs and the field keeps its old name.
 */

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encoder = new TextEncoder();

/** The name the hidden field had before forms were signed, and has where nothing signs them. */
export const LEGACY_TRAP = "website";

async function mac(secrets: SecretBox, text: string): Promise<Uint8Array> {
  const key = await secrets.mac("form-key");
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text) as BufferSource));
}

function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/** The hidden field's name for a form drawn under this key. */
export async function trapNameOf(secrets: SecretBox | null, key: string): Promise<string> {
  const id = key.slice(0, 26);
  if (!secrets || !isUlid(id)) return LEGACY_TRAP;
  return `f_${base32(await mac(secrets, `${id}|trap`), 6).toLowerCase()}`;
}

/** A new key for a form, and its hidden field's name. */
export async function drawFormKey(
  secrets: SecretBox | null,
  path: string,
  kind: string,
  now: number,
): Promise<{ readonly k: string; readonly trap: string }> {
  const id = ulid(now);
  if (!secrets) return { k: id, trap: LEGACY_TRAP };
  const sig = base32(await mac(secrets, `${id}|${path}|${kind}`), 10);
  return { k: `${id}${sig}`, trap: await trapNameOf(secrets, id) };
}

/** When a key's form was drawn: its ULID's time. */
export function drawnAtOf(key: string): number | null {
  const id = key.slice(0, 26);
  if (!isUlid(id)) return null;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + B32.indexOf(ch);
  return t;
}

/**
 * What a posted form says of itself: its key, signed or not, when it was drawn, and whether its
 * hidden field came back filled. With no usable key at all, the request still gets one to be written
 * under, and says it had none.
 */
export async function readFormKey(
  secrets: SecretBox | null,
  form: Readonly<Record<string, string | undefined>>,
  path: string,
  kind: string,
): Promise<{ readonly facts: FormFacts; readonly key: string }> {
  const k = form.k ?? "";
  const filled = async (name: string) => (form[name] ?? "").trim().length > 0;
  const shaped = /^[0-9A-Za-z]{10,40}$/.test(k);
  if (!shaped) {
    return { facts: { key: "none", trap: await filled(LEGACY_TRAP) }, key: ulid() };
  }
  const drawnAt = drawnAtOf(k) ?? undefined;
  const trap = (await filled(LEGACY_TRAP)) || (await filled(await trapNameOf(secrets, k)));
  if (!secrets) return { facts: { key: "unsigned", trap, ...(drawnAt !== undefined ? { drawnAt } : {}) }, key: k };
  const id = k.slice(0, 26);
  const valid =
    k.length === 36 && isUlid(id) && base32(await mac(secrets, `${id}|${path}|${kind}`), 10) === k.slice(26);
  return { facts: { key: valid ? "valid" : "invalid", trap, ...(drawnAt !== undefined ? { drawnAt } : {}) }, key: k };
}

/** Bots' requests written a day: past this, a filled hidden field is only counted, and nothing is kept. */
export const TRAP_ITEMS_PER_DAY = 200;

/** Whether today's bots' requests have room to be written; counted when they have not. */
export async function trapRoom(db: Db, now: number): Promise<boolean> {
  const day = dayOf(now);
  const { rows } = await db.client.query({
    sql: "SELECT COUNT(*) FROM spam_verdicts WHERE cause = 'trap' AND created_at >= ?",
    params: [Date.parse(`${day}T00:00:00Z`)],
    method: "all",
  });
  if (Number(rows[0]?.[0] ?? 0) < TRAP_ITEMS_PER_DAY) return true;
  await db.batch([countStatement("trap_over_cap", now)]);
  return false;
}
