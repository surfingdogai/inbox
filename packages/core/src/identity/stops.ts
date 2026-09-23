import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Contact } from "../domain/types";
import { ulid } from "../ids";
import { secretHash } from "../protocol/credentials";
import { hashText } from "../util/canonical";
import { type ContactValue, contactValues, rootParty } from "./contacts";

/**
 * A customer who asked the business not to use booking networks for them (Tiago, 23 September
 * 2026): from then on nothing more about them goes to any network — no first contact, no
 * presentation, no receipt, no acknowledgement, no code — and nothing a network said about them is
 * read. Their bookings, orders and emails work as before.
 *
 * Email customers get a party per request (`write/party.ts`), so the stop is written on every party
 * that is this customer (`customerParties`) and as fingerprints of their email address, phone number
 * and parties in `network_stops`, which every door checks before it calls a network. The
 * fingerprints stay when the customer's data is erased, so the stop outlives the erasure.
 *
 * No network can yet be asked to unlink or erase what it already has (the protocol has no such
 * call): `stopView` says, per network, what that was, and the owner is shown it.
 */
export type StopVia = "customer" | "owner" | "erased";

/**
 * At most this many parties are one customer: a bound on every statement a stop or an erasure
 * writes. As many as the items one erasure takes, since an email customer gets a party per request.
 */
export const MAX_CUSTOMER_PARTIES = 1_000;
/** Bound values per statement, well inside D1's hundred. */
const CHUNK = 90;

/** hex SHA-256 of what names the customer: `email:<as the network normalises it>`, `phone:<digits>`, `party:<id>`. */
export function stopHash(kind: ContactValue["kind"] | "party", value: string): Promise<string> {
  return hashText(`network-stop\0${kind}:${value}`);
}

export function inChunks<T>(values: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Every party that is this customer: the party, the one it was merged into and those merged into
 * either, and every party that gave the same email address (whether or not it was proven: a stop or
 * an erasure should reach everything filed under the address). A phone number is shared too often —
 * a family's, a shop's landline — to reach another party by it, unless the customer gave no email
 * address at all. At most 500.
 */
export async function customerParties(db: Db, partyId: string): Promise<string[]> {
  return (await customerSet(db, partyId)).parties;
}

/**
 * `customerParties`, and whether that is all of them: a customer with more than
 * `MAX_CUSTOMER_PARTIES` parties is cut there, which an erasure must refuse rather than half do.
 */
export async function customerSet(db: Db, partyId: string): Promise<{ parties: string[]; complete: boolean }> {
  const found = new Set<string>([partyId, await rootParty(db, partyId)]);
  let complete = true;
  const values = new Map<string, ContactValue>();
  const byPhone = !(await contactsOf(db, [...found])).some((v) => v.kind === "email");
  let frontier = [...found];
  for (let round = 0; round < 8 && frontier.length && found.size < MAX_CUSTOMER_PARTIES; round++) {
    const next: string[] = [];
    const add = (id: unknown) => {
      if (typeof id !== "string" || !id || found.has(id)) return;
      if (found.size >= MAX_CUSTOMER_PARTIES) {
        complete = false;
        return;
      }
      found.add(id);
      next.push(id);
    };
    for (const part of inChunks(frontier)) {
      const [mergedIn, mergedInto, contacts, own] = await Promise.all([
        db.client.query({
          sql: `SELECT id FROM parties WHERE merged_into IN (${marks(part.length)})`,
          params: part,
          method: "all",
        }),
        db.client.query({
          sql: `SELECT merged_into FROM parties WHERE id IN (${marks(part.length)}) AND merged_into IS NOT NULL`,
          params: part,
          method: "all",
        }),
        db.client.query({
          sql: `SELECT kind, value FROM party_contacts WHERE party_id IN (${marks(part.length)})`,
          params: part,
          method: "all",
        }),
        db.client.query({
          sql: `SELECT contact FROM parties WHERE id IN (${marks(part.length)})`,
          params: part,
          method: "all",
        }),
      ]);
      for (const r of [...mergedIn.rows, ...mergedInto.rows]) add(r[0]);
      const fresh: ContactValue[] = [];
      const note = (v: ContactValue) => {
        const k = `${v.kind}:${v.value}`;
        if (values.has(k)) return;
        values.set(k, v);
        fresh.push(v);
      };
      for (const r of contacts.rows) {
        if (r[0] === "email" || r[0] === "phone") note({ kind: r[0], value: String(r[1]) });
      }
      for (const r of own.rows) for (const v of contactValues(parseContact(r[0]))) note(v);
      for (const v of fresh) {
        if (v.kind === "phone" && !byPhone) continue;
        // By phone, only the parties that gave no email address either: one that did is someone who
        // shares the phone (a husband with his own address), never this customer by it alone.
        const { rows } = await db.client.query({
          sql:
            v.kind === "phone"
              ? `SELECT DISTINCT c.party_id FROM party_contacts c
                  WHERE c.kind = 'phone' AND c.value = ?
                    AND NOT EXISTS (SELECT 1 FROM party_contacts e WHERE e.party_id = c.party_id AND e.kind = 'email')
                    AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.id = c.party_id
                                     AND COALESCE(json_extract(p.contact, '$.email'), '') <> '')
                  LIMIT ?`
              : "SELECT DISTINCT party_id FROM party_contacts WHERE kind = 'email' AND value = ? LIMIT ?",
          // Every party with it, up to one more than a customer may have: a regular writes every week.
          params: [v.value, MAX_CUSTOMER_PARTIES + 1],
          method: "all",
        });
        for (const r of rows) add(r[0]);
      }
    }
    frontier = next;
  }
  if (frontier.length && found.size >= MAX_CUSTOMER_PARTIES) complete = false;
  return { parties: [...found].sort(), complete };
}

/** The email addresses and phone numbers these parties gave, as the inbox normalises them. */
export async function contactsOf(db: Db, partyIds: readonly string[]): Promise<ContactValue[]> {
  const values = new Map<string, ContactValue>();
  for (const part of inChunks(partyIds)) {
    const [contacts, own] = await Promise.all([
      db.client.query({
        sql: `SELECT kind, value FROM party_contacts WHERE party_id IN (${marks(part.length)})`,
        params: part,
        method: "all",
      }),
      db.client.query({
        sql: `SELECT contact FROM parties WHERE id IN (${marks(part.length)})`,
        params: part,
        method: "all",
      }),
    ]);
    for (const r of contacts.rows) {
      if (r[0] === "email" || r[0] === "phone") values.set(`${r[0]}:${r[1]}`, { kind: r[0], value: String(r[1]) });
    }
    for (const r of own.rows) for (const v of contactValues(parseContact(r[0]))) values.set(`${v.kind}:${v.value}`, v);
  }
  return [...values.values()];
}

/**
 * Whether the customer a request is from asked not to use networks: a party of theirs is stopped,
 * their email or phone has a fingerprint in `network_stops`, or a pass they carry is the one a stopped
 * customer's person was last presented with. Answered from local rows only, before any network call.
 */
export async function networksStopped(
  db: Db,
  q: {
    readonly partyIds?: readonly (string | null | undefined)[] | undefined;
    readonly contact?: Contact | null | undefined;
    readonly credentials?: readonly string[] | undefined;
  },
): Promise<boolean> {
  const ids = [...new Set((q.partyIds ?? []).filter((p): p is string => typeof p === "string" && p.length > 0))];
  if (ids.length) {
    const roots = await Promise.all(ids.map((id) => rootParty(db, id)));
    const all = [...new Set([...ids, ...roots])].slice(0, CHUNK);
    const { rows } = await db.client.query({
      sql: `SELECT 1 FROM parties WHERE id IN (${marks(all.length)}) AND networks_off_at IS NOT NULL LIMIT 1`,
      params: all,
      method: "all",
    });
    if (rows.length) return true;
  }
  // Whom a request names: its email address; its phone number only when it gave no email (a phone is
  // shared too often to stop someone who gave their own address by it).
  const given = contactValues(q.contact ?? undefined);
  const named = given.some((v) => v.kind === "email") ? given.filter((v) => v.kind === "email") : given;
  const hashes = await Promise.all(named.map((v) => stopHash(v.kind, v.value)));
  if (hashes.length) {
    const { rows } = await db.client.query({
      sql: `SELECT 1 FROM network_stops WHERE hash IN (${marks(hashes.length)}) LIMIT 1`,
      params: hashes,
      method: "all",
    });
    if (rows.length) return true;
  }
  return (await stoppedPartyByPass(db, q.credentials ?? [])) !== null;
}

/** Whether the item's customer is stopped: its party, or the party it was merged into. */
export async function itemStopped(db: Db, itemId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM items i JOIN parties p ON p.id = i.party_id
           WHERE i.id = ? AND (p.networks_off_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM parties r WHERE r.id = p.merged_into AND r.networks_off_at IS NOT NULL))`,
    params: [itemId],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * A condition on a receipt `r` (a `receipts` row alias): its item's customer is not stopped. What
 * the network publishers add to every query that picks receipts to send.
 */
export const RECEIPT_NOT_STOPPED_SQL = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM items si JOIN parties sp ON sp.id = si.party_id WHERE si.id = ${alias}.item_id AND sp.networks_off_at IS NOT NULL)`;

/**
 * The stopped party a carried pass belongs to: the one whose person was last presented with it. A
 * stopped customer's assistant keeps its access by the pass it holds, and no network is asked.
 */
export async function stoppedPartyByPass(db: Db, credentials: readonly string[]): Promise<string | null> {
  const passes = credentials.filter((c) => c.startsWith("sdpass1_")).slice(0, 8);
  if (passes.length === 0) return null;
  const hashes = await Promise.all(passes.map((p) => secretHash(p)));
  const { rows } = await db.client.query({
    sql: `SELECT l.party_id FROM person_links l JOIN parties p ON p.id = l.party_id
           WHERE l.pass_hash IN (${marks(hashes.length)}) AND p.networks_off_at IS NOT NULL AND p.erased_at IS NULL
           ORDER BY l.party_id LIMIT 1`,
    params: hashes,
    method: "all",
  });
  const id = rows[0]?.[0];
  return typeof id === "string" ? rootParty(db, id) : null;
}

/**
 * The stop, as statements for one batch: every party of the customer marked; the fingerprints of
 * their parties and email addresses (their phone number only when they gave no email); the sealed code and first pass of a first contact deleted (no
 * code email goes); the presentations on their items deleted (no receipt names a person); the
 * standing a network gave dropped (the pairwise id and pass hash stay, as the local markers that
 * recognise them); and every receipt of theirs still waiting for a network withheld.
 */
export async function stopStatements(
  db: Db,
  partyIds: readonly string[],
  via: StopVia,
  now: number,
): Promise<Statement[]> {
  const out: Statement[] = [];
  const hashes = new Set<string>();
  for (const id of partyIds) hashes.add(await stopHash("party", id));
  // Their email addresses; a phone number only for a customer who gave none (it may be a family's).
  const contacts = await contactsOf(db, partyIds);
  const withEmail = contacts.some((v) => v.kind === "email");
  for (const v of contacts) if (v.kind === "email" || !withEmail) hashes.add(await stopHash(v.kind, v.value));
  for (const part of inChunks([...hashes], 30)) {
    out.push({
      sql: `INSERT OR IGNORE INTO network_stops (hash, via, created_at) VALUES ${part.map(() => "(?, ?, ?)").join(", ")}`,
      params: part.flatMap((h) => [h, via, now]),
      method: "run",
    });
  }
  for (const part of inChunks(partyIds)) {
    const inParties = `(${marks(part.length)})`;
    const theirItems = `(SELECT id FROM items WHERE party_id IN ${inParties})`;
    out.push(
      {
        sql: `UPDATE parties SET networks_off_at = COALESCE(networks_off_at, ?), updated_at = ? WHERE id IN ${inParties}`,
        params: [now, now, ...part],
        method: "run",
      },
      { sql: `DELETE FROM pending_identity WHERE item_id IN ${theirItems}`, params: part, method: "run" },
      { sql: `DELETE FROM item_presentations WHERE item_id IN ${theirItems}`, params: part, method: "run" },
      {
        sql: `UPDATE person_links SET person = NULL, updated_at = ? WHERE party_id IN ${inParties}`,
        params: [now, ...part],
        method: "run",
      },
      {
        sql: `UPDATE network_publications SET state = 'withheld', updated_at = ?
               WHERE state = 'queued' AND receipt_id IN (SELECT id FROM receipts WHERE item_id IN ${theirItems})`,
        params: [now, ...part],
        method: "run",
      },
    );
  }
  return out;
}

/** Who recorded the stop these parties or this address are under: the customer, the owner, an erasure. */
export async function stopViaOf(
  db: Db,
  partyIds: readonly (string | null | undefined)[],
  contact?: Contact | null | undefined,
): Promise<StopVia> {
  const ids = [...new Set(partyIds.filter((p): p is string => typeof p === "string" && p.length > 0))].slice(0, 40);
  const roots = await Promise.all(ids.map((id) => rootParty(db, id)));
  const hashes = [
    ...(await Promise.all([...new Set([...ids, ...roots])].map((id) => stopHash("party", id)))),
    ...(await Promise.all(contactValues(contact ?? undefined).map((v) => stopHash(v.kind, v.value)))),
  ];
  if (hashes.length === 0) return "owner";
  const { rows } = await db.client.query({
    sql: `SELECT via FROM network_stops WHERE hash IN (${marks(hashes.length)}) ORDER BY created_at LIMIT 1`,
    params: hashes,
    method: "all",
  });
  const via = rows[0]?.[0];
  return via === "customer" || via === "erased" ? via : "owner";
}

/**
 * A stopped customer's request that starts or joins a party (`createItem`): that party is stopped
 * too, and the address the request gave (its phone only without one) is fingerprinted, so a later
 * request from that address alone — a new party, maybe an address the customer never used before —
 * is stopped at the door, before any network is called.
 */
export async function stopFollowsStatements(
  input: { readonly partyId: string; readonly contact?: Contact | null | undefined; readonly via: StopVia },
  now: number,
): Promise<Statement[]> {
  const given = contactValues(input.contact ?? undefined);
  const named = given.some((v) => v.kind === "email") ? given.filter((v) => v.kind === "email") : given;
  const hashes = [
    await stopHash("party", input.partyId),
    ...(await Promise.all(named.map((v) => stopHash(v.kind, v.value)))),
  ];
  return [
    {
      sql: "UPDATE parties SET networks_off_at = COALESCE(networks_off_at, ?) WHERE id = ?",
      params: [now, input.partyId],
      method: "run",
    },
    {
      sql: `INSERT OR IGNORE INTO network_stops (hash, via, created_at) VALUES ${hashes.map(() => "(?, ?, ?)").join(", ")}`,
      params: hashes.flatMap((h) => [h, input.via, now]),
      method: "run",
    },
  ];
}

/**
 * Stops networks for the customer `partyId` is, in one batch, and leaves a note on `itemId` (the
 * item the customer or the owner acted from) so the history says when and who. Stopping again
 * changes nothing, and leaves no second note.
 */
export async function stopNetworks(
  db: Db,
  input: {
    readonly partyId: string;
    readonly via: StopVia;
    readonly itemId?: string | undefined;
    readonly note?: string;
  },
  now: number,
): Promise<{ readonly parties: number; readonly since: number }> {
  const partyIds = await customerParties(db, input.partyId);
  const statements = await stopStatements(db, partyIds, input.via, now);
  const already = await networksStopped(db, { partyIds: [input.partyId] });
  if (input.itemId && input.note && !already) {
    statements.push({
      sql: `INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, actor_id, party_id, subject, body_text, body_format, message_id, created_at)
            VALUES (?, ?, 'note', 'system', 'system', NULL, NULL, NULL, ?, 'text', NULL, ?)`,
      params: [ulid(now), input.itemId, input.note, now],
      method: "run",
    });
  }
  await db.batch(statements);
  const { rows } = await db.client.query({
    sql: "SELECT networks_off_at FROM parties WHERE id = ?",
    params: [input.partyId],
    method: "all",
  });
  return { parties: partyIds.length, since: Number(rows[0]?.[0] ?? now) };
}

/** What each network already had about a stopped customer when they stopped it (and since). */
export interface StopView {
  /** When they asked (ISO 8601). */
  readonly since: string;
  /** Who recorded it: the customer by the link in our email, the owner, or an erasure. */
  readonly via: StopVia | null;
  readonly networks: readonly {
    readonly network: string;
    /** Receipts about them this network took before the stop. */
    readonly receipts: number;
    /** Their promises this network holds with no outcome: it records each as unclosed nine days after it was due. */
    readonly open_promises: number;
    /** Whether this network knows their person (it gave this business a pairwise id for them). */
    readonly person: boolean;
  }[];
}

export async function stopView(db: Db, partyId: string): Promise<StopView | null> {
  const root = await rootParty(db, partyId);
  const { rows } = await db.client.query({
    sql: `SELECT MIN(networks_off_at) FROM parties WHERE id IN (?, ?) AND networks_off_at IS NOT NULL`,
    params: [partyId, root],
    method: "all",
  });
  const since = rows[0]?.[0];
  if (since === null || since === undefined) return null;
  const partyIds = await customerParties(db, partyId);
  const via = new Map<string, number>();
  const counts = new Map<string, { receipts: number; open: number; person: boolean }>();
  const entry = (n: string) => {
    const e = counts.get(n) ?? { receipts: 0, open: 0, person: false };
    counts.set(n, e);
    return e;
  };
  const viaRows = await db.client.query({
    sql: `SELECT via, COUNT(*) FROM network_stops WHERE hash IN (${marks(Math.min(partyIds.length, CHUNK))}) GROUP BY via`,
    params: await Promise.all(partyIds.slice(0, CHUNK).map((id) => stopHash("party", id))),
    method: "all",
  });
  for (const r of viaRows.rows) via.set(String(r[0]), Number(r[1]));
  for (const part of inChunks(partyIds)) {
    const inParties = `(${marks(part.length)})`;
    const [published, open, persons] = await Promise.all([
      db.client.query({
        sql: `SELECT p.network, COUNT(DISTINCT r.id) FROM network_publications p
                JOIN receipts r ON r.id = p.receipt_id JOIN items i ON i.id = r.item_id
               WHERE i.party_id IN ${inParties} AND p.state = 'published' AND p.stage = 'issued'
               GROUP BY p.network`,
        params: part,
        method: "all",
      }),
      db.client.query({
        sql: `SELECT p.network, COUNT(DISTINCT r.item_id) FROM network_publications p
                JOIN receipts r ON r.id = p.receipt_id JOIN items i ON i.id = r.item_id
               WHERE i.party_id IN ${inParties} AND p.state = 'published' AND p.stage = 'issued' AND r.kind <> 'outcome'
                 AND NOT EXISTS (SELECT 1 FROM network_publications p2 JOIN receipts r2 ON r2.id = p2.receipt_id
                                  WHERE r2.item_id = r.item_id AND r2.kind = 'outcome' AND p2.network = p.network
                                    AND p2.state = 'published')
               GROUP BY p.network`,
        params: part,
        method: "all",
      }),
      db.client.query({
        sql: `SELECT DISTINCT network FROM person_links WHERE party_id IN ${inParties}`,
        params: part,
        method: "all",
      }),
    ]);
    for (const r of published.rows) entry(String(r[0])).receipts += Number(r[1] ?? 0);
    for (const r of open.rows) entry(String(r[0])).open += Number(r[1] ?? 0);
    for (const r of persons.rows) entry(String(r[0])).person = true;
  }
  const order: StopVia[] = ["customer", "owner", "erased"];
  return {
    since: new Date(Number(since)).toISOString(),
    via: order.find((v) => via.has(v)) ?? null,
    networks: [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([network, c]) => ({ network, receipts: c.receipts, open_promises: c.open, person: c.person })),
  };
}

function parseContact(v: unknown): Contact | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") return v as Contact;
  try {
    return JSON.parse(String(v)) as Contact;
  } catch {
    return undefined;
  }
}
