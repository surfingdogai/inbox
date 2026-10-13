import { hkdfSync } from "node:crypto";

/**
 * Each inbox's secret key (what `INBOX_SECRET_KEY` is to an inbox run on its own): HKDF-SHA256 over
 * the runtime's master key, with the tenant id as the info, so no two inboxes share a key, none is
 * stored, and a copy of one inbox's file opens nothing of another's.
 *
 * The master key may be several, comma-separated, newest first, as `INBOX_SECRET_KEY` may: each
 * gives a key, in the same order, so what was sealed under an older master key still opens.
 */
const SALT = "inbox-hosted-tenant-key/v1";

export function parseMasterKeys(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function tenantSecretKey(masterKeys: readonly string[], tenantId: string): string {
  if (masterKeys.length === 0) throw new Error("no master key: every inbox here needs one to seal its secrets");
  return masterKeys
    .map((master) =>
      Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), SALT, `tenant:${tenantId}`, 32)).toString(
        "base64url",
      ),
    )
    .join(",");
}

/** A key for one purpose of the runtime itself (the ledger's recipient hashes), never an inbox's. */
export function runtimeKey(masterKeys: readonly string[], purpose: string): string {
  const master = masterKeys[0];
  if (master === undefined) throw new Error("no master key");
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), SALT, `runtime:${purpose}`, 32)).toString(
    "base64url",
  );
}
