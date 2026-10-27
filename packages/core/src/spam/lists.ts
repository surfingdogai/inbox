import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { SHARED_MAIL_PROVIDERS } from "./data";
import { emailDomain, foldAddress } from "./normalise";

/**
 * The owner's two lists (ADR-041 §8): Let through, and Always put aside. Only a person at the
 * business adds to them, by what they do with an item (Not spam, Let it in, "Always put aside this
 * sender"); each row can be removed in Settings. A domain is never blocked by inference, and a mail
 * provider many people share is never a domain on either list.
 */

export type ListName = "allow" | "block";
export type ListKind = "address" | "domain" | "agent_key";

export interface ListEntry {
  readonly list: ListName;
  readonly kind: ListKind;
  readonly value: string;
  readonly created_at: string;
}

/** Which list, if any, names this sender: Always put aside wins over Let through. */
export async function listOf(
  db: Db,
  sender: { readonly email?: string | undefined; readonly thumbprint?: string | undefined },
): Promise<ListName | null> {
  const keys: [ListKind, string][] = [];
  if (sender.email) {
    const address = foldAddress(sender.email);
    keys.push(["address", address]);
    const domain = emailDomain(address);
    if (domain && !SHARED_MAIL_PROVIDERS.has(domain)) keys.push(["domain", domain]);
  }
  if (sender.thumbprint) keys.push(["agent_key", sender.thumbprint]);
  if (keys.length === 0) return null;
  const { rows } = await db.client.query({
    sql: `SELECT list FROM spam_lists WHERE ${keys.map(() => "(kind = ? AND value = ?)").join(" OR ")}`,
    params: keys.flat(),
    method: "all",
  });
  const lists = rows.map((r) => String(r[0]));
  if (lists.includes("block")) return "block";
  if (lists.includes("allow")) return "allow";
  return null;
}

export function addToListStatements(input: {
  readonly list: ListName;
  readonly kind: ListKind;
  readonly value: string;
  readonly partyId: string | null;
  readonly itemId: string | null;
  readonly byUser: string;
  readonly now: number;
}): Statement[] {
  const value = input.kind === "address" ? foldAddress(input.value) : input.value.trim().toLowerCase();
  if (input.kind === "domain" && SHARED_MAIL_PROVIDERS.has(value)) return [];
  const other: ListName = input.list === "allow" ? "block" : "allow";
  return [
    // A sender is on one list at a time: the newest choice stands.
    {
      sql: "DELETE FROM spam_lists WHERE list = ? AND kind = ? AND value = ?",
      params: [other, input.kind, input.kind === "agent_key" ? input.value : value],
      method: "run",
    },
    {
      sql: `INSERT OR REPLACE INTO spam_lists (list, kind, value, party_id, item_id, by_user, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.list,
        input.kind,
        input.kind === "agent_key" ? input.value : value,
        input.partyId,
        input.itemId,
        input.byUser.slice(0, 200),
        input.now,
      ],
      method: "run",
    },
  ];
}

export async function listEntries(db: Db): Promise<ListEntry[]> {
  const { rows } = await db.client.query({
    sql: "SELECT list, kind, value, created_at FROM spam_lists ORDER BY created_at DESC LIMIT 500",
    params: [],
    method: "all",
  });
  return rows.map((r) => ({
    list: String(r[0]) as ListName,
    kind: String(r[1]) as ListKind,
    value: String(r[2]),
    created_at: new Date(Number(r[3])).toISOString(),
  }));
}

export function removeFromListStatement(list: ListName, kind: ListKind, value: string): Statement {
  return {
    sql: "DELETE FROM spam_lists WHERE list = ? AND kind = ? AND value = ?",
    params: [list, kind, value],
    method: "run",
  };
}
