import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { signingKeys } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { requireSecretBox } from "../secrets/box";
import { WriteError } from "../write/errors";
import type { KeyPair, PublicJwk } from "./sign";
import { generateKeyPair, thumbprint } from "./sign";

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
