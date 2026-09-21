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
      .select({ id: parties.id, erasedAt: parties.erasedAt })
      .from(parties)
      .where(eq(parties.id, input.partyId));
    if (!row) throw new WriteError("not_found", "unknown party");
    if (row.erasedAt) throw new WriteError("not_allowed", "this party's data was erased");
    return { partyId: input.partyId, statements: [] };
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
