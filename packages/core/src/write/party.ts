import type { Statement } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import type { Contact } from "../domain/types";
import { ulid } from "../ids";
import { parties } from "../schema/tables";
import { WriteError } from "./errors";

/**
 * Parties are pseudonymous principals with identity evidence. An authenticated caller brings its
 * party id. A human through the form or email gets a fresh party per item unless a verified
 * identity says otherwise; unverified emails never merge parties (that would let anyone claim
 * someone else's history).
 */
export interface PartyPlan {
  readonly partyId: string;
  readonly statements: Statement[];
}

export async function planParty(
  db: Db,
  input: {
    partyId?: string | undefined;
    contact?: Contact | undefined;
    kind?: "human" | "agent" | "unknown" | undefined;
  },
  now: number,
): Promise<PartyPlan> {
  if (input.partyId) {
    const [row] = await db.orm
      .select({
        id: parties.id,
        erasedAt: parties.erasedAt,
        displayName: parties.displayName,
        contact: parties.contact,
      })
      .from(parties)
      .where(eq(parties.id, input.partyId));
    if (!row) throw new WriteError("not_found", "unknown party");
    if (row.erasedAt) throw new WriteError("not_allowed", "this party's data was erased");
    return { partyId: input.partyId, statements: filledIn(row, input.contact, now) };
  }
  const id = ulid();
  const contact = input.contact ?? {};
  return {
    partyId: id,
    statements: [
      {
        sql: "INSERT INTO parties (id, kind, display_name, locale, contact, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params: [
          id,
          input.kind ?? "unknown",
          contact.name ?? contact.email ?? null,
          contact.locale ?? null,
          JSON.stringify(contact),
          now,
          now,
        ],
        method: "run",
      },
    ],
  };
}

const DETAILS = ["name", "email", "phone", "locale"] as const;

/**
 * What a request joining a known party says of the person that the party does not hold yet (ADR-048): a name,
 * an email, a phone or a language it never had is written on it, so the details an assistant was made to bring
 * are never dropped, and a party known only by its address is named once a request names it. Nothing it holds
 * is ever changed: a strong match is the same customer, and what they told the business first stands.
 */
function filledIn(
  row: { readonly id: string; readonly displayName: string | null; readonly contact: unknown },
  sent: Contact | undefined,
  now: number,
): Statement[] {
  const known = (row.contact && typeof row.contact === "object" ? row.contact : {}) as Record<string, unknown>;
  const adds: Record<string, string> = {};
  for (const key of DETAILS) {
    const value = (sent as Record<string, unknown> | undefined)?.[key];
    const held = known[key];
    if (typeof value === "string" && value.trim() && !(typeof held === "string" && held.trim()))
      adds[key] = value.trim();
  }
  if (!Object.keys(adds).length) return [];
  // A party known by its address alone stands under that address: a name, once given, stands instead.
  const nameless = row.displayName === null || row.displayName === known.email;
  const display = nameless && adds.name ? adds.name : nameless && !row.displayName && adds.email ? adds.email : null;
  return [
    {
      sql: `UPDATE parties SET contact = ?, display_name = COALESCE(?, display_name), locale = COALESCE(locale, ?),
              updated_at = ? WHERE id = ? AND erased_at IS NULL`,
      params: [JSON.stringify({ ...known, ...adds }), display, adds.locale ?? null, now, row.id],
      method: "run",
    },
  ];
}
