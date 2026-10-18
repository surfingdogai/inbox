import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import {
  createKeyStore,
  exportReceiptKeys,
  importReceiptKeys,
  RECEIPT_KEY_FILE_FORMAT,
  type ReceiptKeyFile,
  replaceReceiptKey,
} from "../src/receipts/keys";
import { generateKeyPair, keyPairMatches, signReceipt, verifyReceipt } from "../src/receipts/sign";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox, type SecretBox } from "../src/secrets/box";
import { WriteError } from "../src/write/errors";
import { makeClient, resetTables } from "./harness";

/**
 * Taking the receipt key along (`receipts/keys.ts`): a business that leaves exports the key its
 * receipts are signed with now, and the inbox it moves to takes it in, sealed with its own secret
 * key, and signs as before. Every check runs before anything is written. A key that may be in the
 * wrong hands is replaced: never used again here, still published. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-10-18T09:00:00Z");
const OLD = createSecretBox(["the-old-inbox-secret-key-0123456789abcdef"]) as SecretBox;
const NEW = createSecretBox(["the-new-inbox-secret-key-0123456789abcdef"]) as SecretBox;

async function fresh(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return db;
}

const keyRows = async (db: Db) =>
  (
    await db.client.query({
      sql: "SELECT kid, private_jwk_enc <> '', retired_at IS NOT NULL FROM signing_keys ORDER BY created_at, kid",
      method: "all",
    })
  ).rows;

const payload = (iss: string) => ({
  iss,
  sub: "Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb29iYXJiYXo",
  itm: "01M34AVYNXTNSE2RC495H3W8QS",
  typ: "booking" as const,
  knd: "confirmed" as const,
  iat: Math.floor(T0 / 1000),
  nonce: "0123456789abcdef0123456789abcdef",
});

describe("taking the receipt key along", () => {
  it("exports nothing without a secret box, or before any key exists", async () => {
    const db = await fresh();
    expect(await exportReceiptKeys(db, null)).toBeNull();
    expect(await exportReceiptKeys(db, OLD)).toBeNull();
  });

  it("exports the key that signs, with its private half, and the new inbox signs as the old", async () => {
    const before = await fresh();
    const store = createKeyStore(before, OLD, () => T0);
    const key = await store.active();
    const file = (await exportReceiptKeys(before, OLD))?.file as ReceiptKeyFile;
    expect(file.format).toBe(RECEIPT_KEY_FILE_FORMAT);
    expect(file.active).toBe(key.kid);
    expect(file.keys).toHaveLength(1);
    expect(await keyPairMatches(file.keys[0]?.jwk as never, key.publicJwk)).toBe(true);

    // The new inbox, empty: the key is inserted, sealed with its own box, and signs.
    const after = await fresh();
    const took = await importReceiptKeys(after, NEW, JSON.parse(JSON.stringify(file)), T0 + 1);
    expect(took).toEqual({ imported: [key.kid], already: [], active: key.kid, retired: [] });
    expect(await keyRows(after)).toEqual([[key.kid, 1, 0]]);
    const moved = await createKeyStore(after, NEW).active();
    expect(moved.kid).toBe(key.kid);
    const jws = await signReceipt(payload("https://inbox.example.com"), moved);
    await expect(verifyReceipt(jws, [key.publicJwk])).resolves.toBeTruthy();
    // The old inbox's box opens nothing there: it is sealed under the new one.
    await expect(createKeyStore(after, OLD).active()).rejects.toThrow();
  });

  it("refuses a file that is not one, a kid that is not its key's, a private half of another key: nothing written", async () => {
    const db = await fresh();
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const entry = (over: Record<string, unknown> = {}) => ({
      kid: a.kid,
      jwk: a.privateJwk,
      created_at: new Date(T0).toISOString(),
      retired_at: null,
      ...over,
    });
    const file = (keys: unknown[], active: unknown = a.kid) => ({ format: RECEIPT_KEY_FILE_FORMAT, active, keys });
    const cases: [string, unknown][] = [
      ["not an object", "receipt"],
      ["another format", { ...file([entry()]), format: "jwks" }],
      ["no keys", file([])],
      ["a public key only", file([entry({ jwk: a.publicJwk })])],
      ["a kid of another key", file([entry({ kid: b.kid })])],
      ["a private half of another key", file([entry({ jwk: { ...a.privateJwk, d: b.privateJwk.d } })])],
      ["a date that is not one", file([entry({ created_at: "yesterday" })])],
      ["an active key not in it", file([entry()], b.kid)],
      ["the same key twice", file([entry(), entry()])],
    ];
    for (const [why, raw] of cases) {
      const error = await importReceiptKeys(db, NEW, raw, T0).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, why).toBeInstanceOf(WriteError);
      expect((error as WriteError).code, why).toBe("invalid_input");
    }
    expect(await keyRows(db)).toEqual([]);
    // Without a secret box there is nothing to seal it with: refused, never stored in the clear.
    await expect(importReceiptKeys(db, null, file([entry()]), T0)).rejects.toThrow();
    expect(await keyRows(db)).toEqual([]);
  });

  it("refuses a key this inbox holds for something else, and writes nothing", async () => {
    const db = await fresh();
    const a = await generateKeyPair();
    await db.client.query({
      sql: "INSERT INTO signing_keys (kid, public_jwk, private_jwk_enc, purpose, created_at) VALUES (?, ?, 'x', 'other', ?)",
      params: [a.kid, JSON.stringify(a.publicJwk), T0],
      method: "run",
    });
    const file = {
      format: RECEIPT_KEY_FILE_FORMAT,
      active: a.kid,
      keys: [{ kid: a.kid, jwk: a.privateJwk, created_at: new Date(T0).toISOString(), retired_at: null }],
    };
    await expect(importReceiptKeys(db, NEW, file, T0)).rejects.toThrow(/something else/);
    expect(await keyRows(db)).toEqual([[a.kid, 1, 0]]);
  });

  it("exports only the key that signs: a retired one stays behind, its public half in the copy", async () => {
    const before = await fresh();
    const store = createKeyStore(before, OLD, () => T0);
    const first = await store.active();
    // The first key retired, a second made: the second signs.
    await before.client.query({ sql: "UPDATE signing_keys SET retired_at = ?", params: [T0 + 5], method: "run" });
    const second = await createKeyStore(before, OLD, () => T0 + 10).active();
    const file = (await exportReceiptKeys(before, OLD))?.file as ReceiptKeyFile;
    expect(file.active).toBe(second.kid);
    expect(file.keys.map((k) => [k.kid, k.retired_at])).toEqual([[second.kid, null]]);
    expect(JSON.stringify(file)).not.toContain(first.kid);

    // The copy, as a download strips it: both public halves, no private one, every key retired.
    const after = await fresh();
    for (const k of [first, second]) {
      await after.client.query({
        sql: "INSERT INTO signing_keys (kid, public_jwk, private_jwk_enc, purpose, created_at, retired_at) VALUES (?, ?, '', 'receipts', ?, ?)",
        params: [k.kid, JSON.stringify(k.publicJwk), k === first ? T0 : T0 + 10, T0 + 20],
        method: "run",
      });
    }
    const took = await importReceiptKeys(after, NEW, file, T0 + 30);
    expect(took).toEqual({ imported: [second.kid], already: [], active: second.kid, retired: [] });
    expect(await keyRows(after)).toEqual([
      [first.kid, 0, 1],
      [second.kid, 1, 0],
    ]);
    const store2 = createKeyStore(after, NEW);
    expect((await store2.active()).kid).toBe(second.kid);
    // Both still published: what the first key signed still verifies.
    expect((await store2.published()).map((k) => k.kid).sort()).toEqual([first.kid, second.kid].sort());
    // Taken in again: nothing changes.
    expect(await importReceiptKeys(after, NEW, file, T0 + 40)).toEqual({
      imported: [],
      already: [second.kid],
      active: second.kid,
      retired: [],
    });
    expect(await keyRows(after)).toEqual([
      [first.kid, 0, 1],
      [second.kid, 1, 0],
    ]);
  });

  it("says which key it cannot open, and exports none", async () => {
    const db = await fresh();
    const key = await createKeyStore(db, OLD, () => T0).active();
    const exported = await exportReceiptKeys(db, NEW);
    expect(exported?.file).toBeNull();
    expect(exported?.unreadable).toEqual([key.kid]);
  });
});

describe("a new receipt key", () => {
  it("retires the one that signed, signs with a new one, and keeps both published", async () => {
    const db = await fresh();
    const store = createKeyStore(db, OLD, () => T0);
    expect(await replaceReceiptKey(db, store, T0)).toBeNull();
    const old = await store.active();
    const replaced = await replaceReceiptKey(db, store, T0 + 1);
    expect(replaced?.retired).toEqual([old.kid]);
    expect(replaced?.active).not.toBe(old.kid);
    const now = await createKeyStore(db, OLD).active();
    expect(now.kid).toBe(replaced?.active);
    expect((await store.published()).map((k) => k.kid).sort()).toEqual([old.kid, now.kid].sort());
    // What the old key signed still verifies against what is published.
    const jws = await signReceipt(payload("https://inbox.example.com"), old);
    await expect(verifyReceipt(jws, await store.published())).resolves.toBeTruthy();
    // A download now takes the new key, never the old one.
    const file = (await exportReceiptKeys(db, OLD))?.file as ReceiptKeyFile;
    expect(file.keys.map((k) => k.kid)).toEqual([now.kid]);
  });
});
