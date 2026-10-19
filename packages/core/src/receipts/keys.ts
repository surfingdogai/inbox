import type { Statement } from "@surfingdog/platform";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db";
import { signingKeys } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { requireSecretBox } from "../secrets/box";
import { WriteError } from "../write/errors";
import type { KeyPair, PrivateJwk, PublicJwk } from "./sign";
import { ALG, generateKeyPair, keyPairMatches, thumbprint } from "./sign";

/**
 * Where an instance's receipt-signing key lives (ADR-016).
 *
 * The private half is sealed by the secret box before it touches a row, so a database backup, a
 * replica or a stolen SQLite file carries a key nobody can sign with. That is also why an instance
 * with no `INBOX_SECRET_KEY` does not issue receipts at all: a private key that could only be
 * stored in the clear is one that should not exist.
 */
export const RECEIPT_PURPOSE = "receipts";

export interface KeyStore {
  /** The key receipts are signed with, generating one on first use. */
  active(): Promise<KeyPair>;
  /** Every key a verifier should still accept, newest first — what `/.well-known/jwks.json` serves. */
  published(): Promise<PublicJwk[]>;
}

interface Row {
  kid: string;
  publicJwk: unknown;
  privateJwkEnc: string;
}

export function createKeyStore(db: Db, secrets: SecretBox | null, now: () => number = Date.now): KeyStore {
  // One import per isolate per key. The CryptoKey is non-extractable, so holding it costs no
  // secrecy that the sealed row did not already cost, and it saves an unseal on every receipt.
  const opened = new Map<string, Promise<KeyPair>>();

  const unseal = async (box: SecretBox, row: Row): Promise<KeyPair> => {
    const privateJwk = JSON.parse(await box.open("receipt-key", row.kid, row.privateJwkEnc));
    const publicJwk = row.publicJwk as PublicJwk;
    // The row says which key this is; check that the key agrees. A kid that does not match its own
    // public JWK means the row was edited, and every receipt signed under it would be unverifiable
    // against the JWKS we publish — better to refuse now than to issue silently broken receipts.
    const actual = await thumbprint(publicJwk);
    if (actual !== row.kid) {
      throw new WriteError("internal", `signing key ${row.kid} does not match its own public key (${actual})`);
    }
    return { kid: row.kid, publicJwk, privateJwk };
  };

  const remember = (box: SecretBox, row: Row): Promise<KeyPair> => {
    let pending = opened.get(row.kid);
    if (!pending) {
      pending = unseal(box, row).catch((error) => {
        opened.delete(row.kid);
        throw error;
      });
      opened.set(row.kid, pending);
    }
    return pending;
  };

  const current = async (): Promise<Row | undefined> => {
    const [row] = await db.orm
      .select({ kid: signingKeys.kid, publicJwk: signingKeys.publicJwk, privateJwkEnc: signingKeys.privateJwkEnc })
      .from(signingKeys)
      .where(and(eq(signingKeys.purpose, RECEIPT_PURPOSE), isNull(signingKeys.retiredAt)))
      // Oldest first, so two isolates racing on a fresh instance still agree on which key signs.
      .orderBy(asc(signingKeys.createdAt), asc(signingKeys.kid))
      .limit(1);
    return row as Row | undefined;
  };

  return {
    async active() {
      const box = requireSecretBox(secrets);
      const existing = await current();
      if (existing) return remember(box, existing);

      const fresh = await generateKeyPair();
      const sealed = await box.seal("receipt-key", fresh.kid, JSON.stringify(fresh.privateJwk));
      // Conditional insert: whoever gets there first is the one active key, and a second isolate
      // that generated at the same moment writes nothing and reads the winner below. Storing both
      // would publish a key that never signs anything.
      await db.client.query({
        sql: `INSERT INTO signing_keys (kid, public_jwk, private_jwk_enc, purpose, created_at)
              SELECT ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM signing_keys WHERE purpose = ? AND retired_at IS NULL)`,
        params: [fresh.kid, JSON.stringify(fresh.publicJwk), sealed, RECEIPT_PURPOSE, now(), RECEIPT_PURPOSE],
        method: "run",
      });

      const winner = await current();
      if (!winner)
        throw new WriteError("internal", "the receipt signing key vanished immediately after it was written");
      return remember(box, winner);
    },

    async published() {
      const rows = await db.orm
        .select({ publicJwk: signingKeys.publicJwk })
        .from(signingKeys)
        .where(eq(signingKeys.purpose, RECEIPT_PURPOSE))
        // Retired keys stay: a receipt signed last year must still verify, and the only reason to
        // drop one is that it was compromised, which is a deletion someone decides to make.
        .orderBy(asc(signingKeys.createdAt));
      return rows.map((r) => r.publicJwk as PublicJwk).reverse();
    },
  };
}

// ---- taking the key along ------------------------------------------------------------------------

/**
 * The receipt-signing key as a download carries it when the owner asks for it (`receipt-keys.json`),
 * so the inbox that opens the copy signs as this one did: the same `kid`, the same public key in its
 * manifest. Only the key that signs now: a retired key never signs again, so its private half would
 * be of use to nobody but someone forging a back-dated receipt, and its public half is in `inbox.db`
 * already, so what it signed still verifies. The private half is in the clear in this file, and only
 * here: `inbox.db` beside it never holds one.
 */
export const RECEIPT_KEY_FILE_FORMAT = "surfingdog-receipt-keys/1";

export interface ExportedReceiptKey {
  readonly kid: string;
  /** The private JWK (`d` with `x`): RFC 8037, Ed25519. */
  readonly jwk: PrivateJwk;
  readonly created_at: string;
  readonly retired_at: string | null;
}

export interface ReceiptKeyFile {
  readonly format: typeof RECEIPT_KEY_FILE_FORMAT;
  /** The key that signs now, which the inbox that takes the file in signs with. */
  readonly active: string | null;
  /** The keys in the file, oldest first: a download writes the active one alone. */
  readonly keys: readonly ExportedReceiptKey[];
}

/**
 * The key this inbox signs receipts with now (the oldest key not retired, as `KeyStore.active` picks
 * it), opened from its sealed row: null without the secret box or without such a key. When its row
 * cannot be opened here (sealed under a key this instance no longer has, or its private half is not
 * here), the file is null and the kid is named in `unreadable`, never guessed at.
 */
export async function exportReceiptKeys(
  db: Db,
  secrets: SecretBox | null,
): Promise<{ readonly file: ReceiptKeyFile | null; readonly unreadable: readonly string[] } | null> {
  if (!secrets) return null;
  const [row] = await db.orm
    .select({
      kid: signingKeys.kid,
      publicJwk: signingKeys.publicJwk,
      privateJwkEnc: signingKeys.privateJwkEnc,
      createdAt: signingKeys.createdAt,
    })
    .from(signingKeys)
    .where(and(eq(signingKeys.purpose, RECEIPT_PURPOSE), isNull(signingKeys.retiredAt)))
    .orderBy(asc(signingKeys.createdAt), asc(signingKeys.kid))
    .limit(1);
  if (!row) return null;
  try {
    if (!row.privateJwkEnc) throw new Error("no private half here");
    const jwk = JSON.parse(await secrets.open("receipt-key", row.kid, row.privateJwkEnc)) as PrivateJwk;
    if (!(await keyPairMatches(jwk, row.publicJwk as PublicJwk))) throw new Error("not the row's key");
    const key: ExportedReceiptKey = {
      kid: row.kid,
      jwk,
      created_at: new Date(Number(row.createdAt)).toISOString(),
      retired_at: null,
    };
    return { file: { format: RECEIPT_KEY_FILE_FORMAT, active: row.kid, keys: [key] }, unreadable: [] };
  } catch {
    return { file: null, unreadable: [row.kid] };
  }
}

/**
 * Retires the key receipts are signed with now, so this inbox never signs with it again, and makes a
 * new one (`keys.active()`): what the owner does when a copy of the key may be in the wrong hands.
 * The retired key stays published, so every receipt it signed still verifies. Null when this inbox
 * holds no receipt key yet. Needs `INBOX_SECRET_KEY`, as signing does.
 */
export async function replaceReceiptKey(
  db: Db,
  keys: KeyStore,
  now: number = Date.now(),
): Promise<{ readonly retired: readonly string[]; readonly active: string } | null> {
  const live = await db.orm
    .select({ kid: signingKeys.kid })
    .from(signingKeys)
    .where(and(eq(signingKeys.purpose, RECEIPT_PURPOSE), isNull(signingKeys.retiredAt)));
  if (live.length === 0) return null;
  await db.client.query({
    sql: "UPDATE signing_keys SET retired_at = ? WHERE purpose = ? AND retired_at IS NULL",
    params: [now, RECEIPT_PURPOSE],
    method: "run",
  });
  const fresh = await keys.active();
  return { retired: live.map((r) => r.kid), active: fresh.kid };
}

export interface ReceiptKeyImport {
  /** Keys this inbox did not have the private half of, and now has, sealed with its own key. */
  readonly imported: readonly string[];
  /** Keys it had already: left as they were. Taking the same file in twice changes nothing. */
  readonly already: readonly string[];
  /** The key that signs from now on. */
  readonly active: string | null;
  /** Keys this inbox signed with until now, retired so the file's key signs: they still verify. */
  readonly retired: readonly string[];
}

/**
 * Takes in a `receipt-keys.json` from a download (`import-receipt-keys`): each key checked (its kid
 * is its own thumbprint, and its private half signs what its public half verifies), sealed with this
 * inbox's secret box, and the file's active key made the one that signs. Every check runs before
 * anything is written, so a file that fails one changes nothing. Needs `INBOX_SECRET_KEY`.
 */
export async function importReceiptKeys(
  db: Db,
  secrets: SecretBox | null,
  raw: unknown,
  now: number = Date.now(),
): Promise<ReceiptKeyImport> {
  const box = requireSecretBox(secrets);
  const file = await checkKeyFile(raw);
  const kids = file.keys.map((k) => k.kid);
  const existing = new Map(
    (
      await db.orm
        .select({
          kid: signingKeys.kid,
          purpose: signingKeys.purpose,
          privateJwkEnc: signingKeys.privateJwkEnc,
          retiredAt: signingKeys.retiredAt,
        })
        .from(signingKeys)
        .where(inArray(signingKeys.kid, kids))
    ).map((r) => [r.kid, r]),
  );
  // A key this inbox holds for something else is never made a receipt key: refused, nothing written.
  for (const [kid, row] of existing) {
    if (row.purpose !== RECEIPT_PURPOSE) {
      throw new WriteError(
        "invalid_input",
        `not a receipt key file from a download: ${kid} is a key held here for something else`,
      );
    }
  }
  const imported: string[] = [];
  const already: string[] = [];
  const statements: Statement[] = [];
  for (const key of file.keys) {
    const row = existing.get(key.kid);
    if (row?.privateJwkEnc) {
      already.push(key.kid);
      continue;
    }
    const sealed = await box.seal("receipt-key", key.kid, JSON.stringify(key.jwk));
    imported.push(key.kid);
    if (row) {
      statements.push({
        sql: "UPDATE signing_keys SET private_jwk_enc = ? WHERE kid = ? AND purpose = ? AND private_jwk_enc = ''",
        params: [sealed, key.kid, RECEIPT_PURPOSE],
        method: "run",
      });
    } else {
      const { d: _private, ...pub } = key.jwk;
      const retired = key.retired_at === null ? null : Date.parse(key.retired_at);
      statements.push({
        sql: `INSERT INTO signing_keys (kid, public_jwk, private_jwk_enc, purpose, created_at, retired_at)
              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kid) DO NOTHING`,
        params: [
          key.kid,
          JSON.stringify({ ...pub, kid: key.kid, alg: ALG, use: "sig" }),
          sealed,
          RECEIPT_PURPOSE,
          Date.parse(key.created_at),
          key.kid === file.active ? null : (retired ?? now),
        ],
        method: "run",
      });
    }
  }
  const retired: string[] = [];
  if (file.active) {
    const others = await db.orm
      .select({ kid: signingKeys.kid })
      .from(signingKeys)
      .where(and(eq(signingKeys.purpose, RECEIPT_PURPOSE), isNull(signingKeys.retiredAt)));
    for (const o of others) if (o.kid !== file.active) retired.push(o.kid);
    statements.push(
      {
        sql: "UPDATE signing_keys SET retired_at = NULL WHERE kid = ? AND purpose = ?",
        params: [file.active, RECEIPT_PURPOSE],
        method: "run",
      },
      {
        sql: "UPDATE signing_keys SET retired_at = ? WHERE purpose = ? AND retired_at IS NULL AND kid <> ?",
        params: [now, RECEIPT_PURPOSE, file.active],
        method: "run",
      },
    );
  }
  // One batch: every key sealed in, the file's key signing, the others retired, or none of it.
  // Each statement changes nothing the second time, so taking the same file in again is harmless.
  if (statements.length) await db.batch(statements);
  // Said done only when it is: the file's key is the one that signs, with its private half here.
  if (file.active) {
    const [signs] = await db.orm
      .select({ kid: signingKeys.kid })
      .from(signingKeys)
      .where(
        and(
          eq(signingKeys.kid, file.active),
          eq(signingKeys.purpose, RECEIPT_PURPOSE),
          ne(signingKeys.privateJwkEnc, ""),
          isNull(signingKeys.retiredAt),
        ),
      )
      .limit(1);
    if (!signs) throw new WriteError("internal", `the key ${file.active} was not taken in: nothing signs with it`);
  }
  return { imported, already, active: file.active, retired };
}

/** The file, every key in it checked, or a `WriteError` that says which and why. */
async function checkKeyFile(raw: unknown): Promise<ReceiptKeyFile> {
  const bad = (why: string) => new WriteError("invalid_input", `not a receipt key file from a download: ${why}`);
  if (typeof raw !== "object" || raw === null) throw bad("it is not a JSON object");
  const f = raw as Record<string, unknown>;
  if (f.format !== RECEIPT_KEY_FILE_FORMAT) throw bad(`format is not ${RECEIPT_KEY_FILE_FORMAT}`);
  if (!Array.isArray(f.keys) || f.keys.length === 0 || f.keys.length > 100) throw bad("keys is not a list of keys");
  const keys: ExportedReceiptKey[] = [];
  for (const [i, k] of f.keys.entries()) {
    const e = (typeof k === "object" && k !== null ? k : {}) as Record<string, unknown>;
    const jwk = (typeof e.jwk === "object" && e.jwk !== null ? e.jwk : {}) as Record<string, unknown>;
    const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 200;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !str(jwk.x) || !str(jwk.d) || !str(e.kid)) {
      throw bad(`key ${i + 1} is not an Ed25519 private key`);
    }
    const pub = { kty: "OKP", crv: "Ed25519", x: String(jwk.x) } as const;
    if ((await thumbprint(pub)) !== e.kid) throw bad(`key ${i + 1}'s kid is not its own thumbprint`);
    const priv = { ...pub, d: String(jwk.d) };
    if (!(await keyPairMatches(priv, pub))) throw bad(`key ${i + 1}'s private half does not match its public key`);
    const created = typeof e.created_at === "string" ? Date.parse(e.created_at) : Number.NaN;
    const retiredAt = e.retired_at === null || e.retired_at === undefined ? null : String(e.retired_at);
    if (!Number.isFinite(created) || (retiredAt !== null && !Number.isFinite(Date.parse(retiredAt)))) {
      throw bad(`key ${i + 1}'s dates are not dates`);
    }
    if (keys.some((other) => other.kid === e.kid)) throw bad(`key ${i + 1} is in it twice`);
    keys.push({ kid: String(e.kid), jwk: priv, created_at: new Date(created).toISOString(), retired_at: retiredAt });
  }
  const active = f.active === null || f.active === undefined ? null : String(f.active);
  if (active !== null && !keys.some((k) => k.kid === active)) throw bad("active names a key that is not in it");
  return { format: RECEIPT_KEY_FILE_FORMAT, active, keys };
}
