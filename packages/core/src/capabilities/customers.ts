import type { Statement } from "@surfingdog/platform";
import { inArray } from "drizzle-orm";
import { base64Url } from "../customer/offer";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import {
  customerSet,
  inChunks,
  MAX_CUSTOMER_PARTIES,
  type StopView,
  stopNetworks,
  stopStatements,
  stopView,
} from "../identity/stops";
import { items as itemsTable } from "../schema/tables";
import { canonicalJson } from "../util/canonical";
import { type Caller, isCustomer, isOwnerAssistant, isOwnerInPerson, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import { rowToItem } from "../write/views";

/**
 * One customer's data, for the owner (Tiago, 23 September 2026): everything the inbox holds about
 * them, exported as one JSON document, and — at their request — erased. Email text is kept until
 * the owner deletes it; there is no automatic cut.
 *
 * Erasing rewrites the customer's personal data to a placeholder — names, email addresses, phone
 * numbers, postal addresses, message text, the business's notes and emails about them — and keeps
 * the structure: which items there were, their types, states, times, amounts and lines, the sequence
 * of their events, their receipts. It also stops booking networks for them (`identity/stops.ts`),
 * and the fingerprints of their email and phone stay, so the stop holds if they come back. It
 * cannot be undone, so it takes a confirm step, and only the owner in person — or a key the owner
 * gave `customers:erase` — may do it; the owner's AI may export, never erase.
 *
 * "The customer" is every party that is them (`customerParties`): email customers get a party per
 * request, so erasing one booking's customer reaches all of theirs.
 */

/** The most items one export or erasure takes: a bound on the batch. */
export const MAX_CUSTOMER_ITEMS = 1_000;
const ERASED = "[erased]";
const ERASED_NAME = "Erased customer";
/** What stands for the customer as the actor of their own events once erased (`email:<address>` before). */
const ERASED_ACTOR = "erased";
const CUSTOMER_ACTORS = "'customer_human', 'customer_agent'";
/** An order line (`e`, a `json_each` row) that names no product of the catalogue: the customer named it. */
const OFF_CATALOGUE = "NOT EXISTS (SELECT 1 FROM products pr WHERE pr.id = json_extract(e.value, '$.productId'))";
/** What an event's diff may hold of a customer's own words or address (each is `[before, after]`). */
const DIFF_PERSONAL = [
  "$.payload.text",
  "$.payload.subject",
  "$.payload.inReplyTo",
  "$.payload.description",
  "$.payload.itemOffered.name",
  "$.payload.reason",
  "$.payload.notes",
  "$.payload.deliveryAddress",
  "$.payload.billingAddress",
  "$.payload.shippingAddress",
  "$.payload.paymentRef",
  "$.payload.paymentUrl",
  "$.payload.quote[0].notes",
  "$.payload.quote[1].notes",
];

export interface CustomerSummary {
  readonly party_id: string;
  readonly name: string | null;
  /** The parties that are this customer: merged, or with the same email address (`customerParties`). */
  readonly parties: readonly string[];
  readonly items: number;
  /** Items not closed yet: erasing leaves them in their state, and nobody can be emailed about them. */
  readonly open_items: number;
  readonly entries: number;
  readonly emails: number;
  readonly erased_at: string | null;
  readonly networks_off: StopView | null;
}

export interface CustomerExport {
  readonly exported_at: string;
  readonly customer: CustomerSummary;
  readonly parties: readonly Record<string, unknown>[];
  readonly contacts: readonly Record<string, unknown>[];
  readonly identities: readonly Record<string, unknown>[];
  readonly person_links: readonly Record<string, unknown>[];
  readonly agents: readonly Record<string, unknown>[];
  readonly items: readonly {
    readonly item: Item;
    readonly events: readonly Record<string, unknown>[];
    readonly thread: readonly Record<string, unknown>[];
    readonly emails: readonly Record<string, unknown>[];
    readonly receipts: readonly Record<string, unknown>[];
  }[];
}

export interface EraseResult {
  readonly erased: boolean;
  /** The customer had been erased already: nothing more was done. */
  readonly already: boolean;
  readonly customer: CustomerSummary;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v)).toISOString());

export class CustomerData {
  constructor(private readonly db: Db) {}

  /** Who the customer is, in numbers: what an export holds and an erasure would reach. */
  async summary(caller: Caller, input: { readonly party_id: string }): Promise<CustomerSummary> {
    requireBusiness(caller);
    return (await this.scope(input.party_id)).summary;
  }

  /** Everything the inbox holds about the customer, as one document for the owner to hand them. */
  async export(caller: Caller, input: { readonly party_id: string }): Promise<CustomerExport> {
    requireBusiness(caller);
    const { summary, parties, items } = await this.scope(input.party_id);
    const rows = async (sql: (m: string) => string, ids: readonly string[]) => {
      const out: unknown[][] = [];
      for (const part of inChunks(ids)) {
        const { rows: r } = await this.db.client.query({ sql: sql(marks(part.length)), params: part, method: "all" });
        out.push(...r.map((x) => [...x]));
      }
      return out;
    };
    const [partyRows, contacts, identities, links, agents] = await Promise.all([
      rows(
        (m) =>
          `SELECT id, kind, display_name, locale, contact, notes, created_at, erased_at, networks_off_at, merged_into FROM parties WHERE id IN (${m}) ORDER BY id`,
        parties,
      ),
      rows(
        (m) =>
          `SELECT party_id, kind, value, verified_at, created_at FROM party_contacts WHERE party_id IN (${m}) ORDER BY created_at`,
        parties,
      ),
      rows(
        (m) =>
          `SELECT party_id, kind, value_normalized, verified_at, created_at FROM party_identities WHERE party_id IN (${m}) ORDER BY created_at`,
        parties,
      ),
      rows(
        (m) =>
          `SELECT party_id, network, ppid, created_at FROM person_links WHERE party_id IN (${m}) ORDER BY created_at`,
        parties,
      ),
      rows(
        (m) =>
          `SELECT party_id, name, operator, homepage_host, tier, created_at, last_seen_at FROM agents WHERE party_id IN (${m}) ORDER BY created_at`,
        parties,
      ),
    ]);
    const ids = items.map((i) => i.id);
    const itemRows: (typeof itemsTable.$inferSelect)[] = [];
    for (const part of inChunks(ids)) {
      itemRows.push(...(await this.db.orm.select().from(itemsTable).where(inArray(itemsTable.id, part))));
    }
    const [events, thread, emails, receipts] = await Promise.all([
      rows(
        (m) =>
          `SELECT item_id, seq, event, from_state, to_state, actor_kind, reason, created_at FROM item_events WHERE item_id IN (${m}) ORDER BY item_id, seq`,
        ids,
      ),
      rows(
        (m) =>
          `SELECT item_id, direction, channel, actor_kind, subject, body_text, created_at FROM thread_entries WHERE item_id IN (${m}) ORDER BY item_id, created_at, id`,
        ids,
      ),
      rows(
        (m) =>
          `SELECT item_id, recipient, template, lang, subject, body_text, status, skip_reason, created_at, sent_at FROM outbound_mail WHERE item_id IN (${m}) ORDER BY item_id, created_at, id`,
        ids,
      ),
      rows(
        (m) =>
          `SELECT item_id, id, kind, outcome, sha, issued_at, ack_at, jws FROM receipts WHERE item_id IN (${m}) ORDER BY item_id, issued_at`,
        ids,
      ),
    ]);
    const byItem = <T>(list: unknown[][], map: (r: unknown[]) => T) => {
      const out = new Map<string, T[]>();
      for (const r of list) {
        const k = String(r[0]);
        const arr = out.get(k) ?? [];
        arr.push(map(r));
        out.set(k, arr);
      }
      return out;
    };
    const ev = byItem(events, (r) => ({
      seq: Number(r[1]),
      event: r[2],
      from: r[3],
      to: r[4],
      by: r[5],
      reason: r[6],
      at: iso(r[7]),
    }));
    const th = byItem(thread, (r) => ({
      direction: r[1],
      channel: r[2],
      by: r[3],
      subject: r[4],
      text: r[5],
      at: iso(r[6]),
    }));
    const em = byItem(emails, (r) => ({
      recipient: r[1],
      template: r[2],
      lang: r[3],
      subject: r[4],
      text: r[5],
      status: r[6],
      skip_reason: r[7],
      created_at: iso(r[8]),
      sent_at: iso(r[9]),
    }));
    const rc = byItem(receipts, (r) => ({
      id: r[1],
      kind: r[2],
      outcome: r[3] || null,
      sha: r[4],
      issued_at: iso(r[5]),
      acknowledged_at: iso(r[6]),
      jws: r[7],
    }));
    const itemsOut = itemRows
      .map((r) => rowToItem(r))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        item,
        events: ev.get(item.id) ?? [],
        thread: th.get(item.id) ?? [],
        emails: em.get(item.id) ?? [],
        receipts: rc.get(item.id) ?? [],
      }));
    return {
      exported_at: new Date(nowOf(caller)).toISOString(),
      customer: summary,
      parties: partyRows.map((r) => ({
        id: r[0],
        kind: r[1],
        name: r[2],
        locale: r[3],
        contact: parse(r[4]),
        notes: r[5],
        created_at: iso(r[6]),
        erased_at: iso(r[7]),
        networks_off_at: iso(r[8]),
        merged_into: r[9],
      })),
      contacts: contacts.map((r) => ({
        party_id: r[0],
        kind: r[1],
        value: r[2],
        verified_at: iso(r[3]),
        created_at: iso(r[4]),
      })),
      identities: identities.map((r) => ({
        party_id: r[0],
        kind: r[1],
        value: r[2],
        verified_at: iso(r[3]),
        created_at: iso(r[4]),
      })),
      person_links: links.map((r) => ({ party_id: r[0], network: r[1], ppid: r[2], created_at: iso(r[3]) })),
      agents: agents.map((r) => ({
        party_id: r[0],
        name: r[1],
        operator: r[2],
        homepage_host: r[3],
        tier: r[4],
        created_at: iso(r[5]),
        last_seen_at: iso(r[6]),
      })),
      items: itemsOut,
    };
  }

  /**
   * The owner switches booking networks off for the customer: the same stop as the customer's own
   * link. Anyone at the business may, the owner's AI too: it only ever takes network use away.
   */
  async stopNetworks(
    caller: Caller,
    input: { readonly party_id: string; readonly item_id?: string | undefined },
  ): Promise<CustomerSummary> {
    requireBusiness(caller);
    const { summary, items } = await this.scope(input.party_id);
    const now = nowOf(caller);
    // The note goes on one of the customer's own items, never on someone else's the request named.
    if (input.item_id !== undefined && !items.some((i) => i.id === input.item_id)) {
      throw new WriteError("invalid_input", "item_id is not one of this customer's items", {
        fields: [{ path: "item_id", problem: "invalid", message: "an item of this customer's, or none" }],
      });
    }
    const itemId = input.item_id ?? (await this.latestItem(summary.parties));
    await stopNetworks(
      this.db,
      {
        partyId: input.party_id,
        via: "owner",
        ...(itemId
          ? {
              itemId,
              note: "Booking networks switched off for this customer: nothing more about them goes to any network.",
            }
          : {}),
      },
      now,
    );
    return (await this.scope(input.party_id)).summary;
  }

  /**
   * Erases the customer: see the class. Without `confirm`, or with one that no longer matches what
   * would be erased, nothing is done and the answer (`confirm_erase`) says what would be.
   */
  async erase(
    caller: Caller,
    input: { readonly party_id: string; readonly confirm?: string | undefined },
  ): Promise<EraseResult> {
    requireBusiness(caller);
    const mayErase =
      (isOwnerInPerson(caller) && !isOwnerAssistant(caller)) ||
      (caller.principal?.keyKind === "integration" && caller.principal.scopes.includes("customers:erase"));
    if (!mayErase) {
      throw new WriteError(
        "not_allowed",
        "Only the owner can erase a customer, in the app, or with a key the owner gave customers:erase. Their data can be exported (export_customer) for the owner to look at.",
        { details: { reason: "owner_only", scope: "customers:erase" } },
      );
    }
    const { summary, parties, items } = await this.scope(input.party_id);
    if (summary.erased_at !== null && (await this.allErased(parties))) {
      return { erased: false, already: true, customer: summary };
    }
    const confirm = await fingerprint(
      parties,
      items.map((i) => i.id),
    );
    if (input.confirm !== confirm) {
      throw new WriteError(
        "confirm_erase",
        `Erasing cannot be undone. It rewrites the names, email addresses, phone numbers, postal addresses and all the text of ${summary.items} item(s) (${summary.open_items} still open) and ${summary.emails} email(s), and keeps only their types, states, times, amounts and history. To go ahead, send confirm: "${confirm}".`,
        { details: { summary, confirm } },
      );
    }
    const now = nowOf(caller);
    const statements = [
      ...(await stopStatements(this.db, parties, "erased", now)),
      ...eraseStatements(parties, now),
      // The search index forgets a rewritten entry's words only when its segments are merged: until
      // then their name and text stay in its pages. Merged now, in the same batch.
      { sql: "INSERT INTO search_fts(search_fts) VALUES ('optimize')", params: [], method: "run" } as Statement,
    ];
    await this.db.batch(statements);
    return { erased: true, already: false, customer: (await this.scope(input.party_id)).summary };
  }

  // ---- helpers ---------------------------------------------------------------

  /** The customer's parties and items, and the summary of both. */
  private async scope(partyId: string): Promise<{
    summary: CustomerSummary;
    parties: string[];
    items: { id: string; closed: boolean }[];
  }> {
    const { rows: found } = await this.db.client.query({
      sql: "SELECT display_name, erased_at FROM parties WHERE id = ?",
      params: [partyId],
      method: "all",
    });
    const first = found[0];
    if (!first) throw new WriteError("not_found", "no such customer");
    const { parties, complete } = await customerSet(this.db, partyId);
    if (!complete) {
      throw new WriteError(
        "invalid_input",
        `This customer has more than ${MAX_CUSTOMER_PARTIES} records, more than one export or erasure can take.`,
      );
    }
    const items: { id: string; closed: boolean }[] = [];
    let entries = 0;
    let emails = 0;
    for (const part of inChunks(parties)) {
      const m = marks(part.length);
      const [its, ent, em] = await Promise.all([
        this.db.client.query({
          sql: `SELECT id, closed_at FROM items WHERE party_id IN (${m}) ORDER BY id`,
          params: part,
          method: "all",
        }),
        this.db.client.query({
          sql: `SELECT COUNT(*) FROM thread_entries WHERE item_id IN (SELECT id FROM items WHERE party_id IN (${m}))`,
          params: part,
          method: "all",
        }),
        this.db.client.query({
          sql: `SELECT COUNT(*) FROM outbound_mail WHERE item_id IN (SELECT id FROM items WHERE party_id IN (${m}))`,
          params: part,
          method: "all",
        }),
      ]);
      for (const r of its.rows) items.push({ id: String(r[0]), closed: r[1] !== null && r[1] !== undefined });
      entries += Number(ent.rows[0]?.[0] ?? 0);
      emails += Number(em.rows[0]?.[0] ?? 0);
    }
    if (items.length > MAX_CUSTOMER_ITEMS) {
      throw new WriteError(
        "invalid_input",
        `This customer has ${items.length} items, more than the ${MAX_CUSTOMER_ITEMS} one export or erasure can take.`,
      );
    }
    return {
      parties,
      items,
      summary: {
        party_id: partyId,
        name: first[0] === null || first[0] === undefined ? null : String(first[0]),
        parties,
        items: items.length,
        open_items: items.filter((i) => !i.closed).length,
        entries,
        emails,
        erased_at: iso(first[1]),
        networks_off: await stopView(this.db, partyId),
      },
    };
  }

  private async allErased(parties: readonly string[]): Promise<boolean> {
    for (const part of inChunks(parties)) {
      const { rows } = await this.db.client.query({
        sql: `SELECT 1 FROM parties WHERE id IN (${marks(part.length)}) AND erased_at IS NULL LIMIT 1`,
        params: part,
        method: "all",
      });
      if (rows.length) return false;
    }
    return true;
  }

  private async latestItem(parties: readonly string[]): Promise<string | null> {
    const part = parties.slice(0, 90);
    const { rows } = await this.db.client.query({
      sql: `SELECT id FROM items WHERE party_id IN (${marks(part.length)}) ORDER BY created_at DESC, id DESC LIMIT 1`,
      params: part,
      method: "all",
    });
    return rows[0]?.[0] ? String(rows[0][0]) : null;
  }
}

/**
 * The statements that rewrite one customer's personal data, for the erasure's batch: the parties,
 * their contacts and identities, their items' free text and addresses, the conversation, the
 * history's words, the emails, a shop's raw events and the blobs. The structure stays.
 */
export function eraseStatements(parties: readonly string[], now: number): Statement[] {
  const out: Statement[] = [];
  for (const part of inChunks(parties)) {
    const inParties = `(${marks(part.length)})`;
    const theirItems = `(SELECT id FROM items WHERE party_id IN ${inParties})`;
    const run = (sql: string, params: readonly (string | number)[] = part): Statement => ({
      sql,
      params,
      method: "run",
    });
    out.push(
      // First the name the search index copies onto each entry, so the rewritten entries carry the placeholder.
      run(
        `UPDATE parties SET display_name = ?, contact = '{}', locale = NULL, notes = NULL,
                erased_at = COALESCE(erased_at, ?), updated_at = ? WHERE id IN ${inParties}`,
        [ERASED_NAME, now, now, ...part],
      ),
      run(`DELETE FROM party_contacts WHERE party_id IN ${inParties}`),
      run(`DELETE FROM party_identities WHERE party_id IN ${inParties}`),
      run(`DELETE FROM person_links WHERE party_id IN ${inParties}`),
      run(`DELETE FROM agents WHERE party_id IN ${inParties}`),
      run(`DELETE FROM customer_codes WHERE party_id IN ${inParties}`),
      run(`DELETE FROM customer_codes WHERE item_id IN ${theirItems}`),
      run(`DELETE FROM action_links WHERE item_id IN ${theirItems}`),
      run(`DELETE FROM idempotency_keys WHERE item_id IN ${theirItems}`),
      run(`DELETE FROM reviews_outbox WHERE item_id IN ${theirItems}`),
      // What they wrote and where they live; the lines, amounts and times stay.
      run(
        `UPDATE items SET payload = json_remove(json_set(payload, '$.text', ?), '$.subject', '$.inReplyTo'), subject = ?
          WHERE type = 'message' AND party_id IN ${inParties}`,
        [ERASED, ERASED, ...part],
      ),
      run(
        `UPDATE items SET payload = json_remove(json_set(payload, '$.description', ?), '$.deliveryAddress', '$.quote.notes'), subject = ?
          WHERE type = 'quote_request' AND party_id IN ${inParties}`,
        [ERASED, ERASED, ...part],
      ),
      // What they asked a quote for, in their own words (no service or product of the catalogue named it).
      run(
        `UPDATE items SET payload = json_set(payload, '$.itemOffered.name', ?)
          WHERE type = 'quote_request' AND party_id IN ${inParties}
            AND json_extract(payload, '$.itemOffered.serviceId') IS NULL
            AND json_extract(payload, '$.itemOffered.productId') IS NULL`,
        [ERASED, ...part],
      ),
      run(
        `UPDATE items SET payload = json_set(payload, '$.reason', ?), subject = ?
          WHERE type = 'refund' AND party_id IN ${inParties}`,
        [ERASED, ERASED, ...part],
      ),
      run(
        `UPDATE items SET payload = json_remove(payload, '$.notes') WHERE type = 'booking' AND party_id IN ${inParties}`,
      ),
      run(
        `UPDATE items SET payload = json_remove(payload, '$.notes', '$.billingAddress', '$.shippingAddress', '$.paymentRef', '$.paymentUrl')
          WHERE type = 'order' AND party_id IN ${inParties}`,
      ),
      // A line no product of the catalogue named is in their own words (the catalogue names its own):
      // its name goes, its quantity and price stay; the title made from it goes first.
      run(
        `UPDATE items SET subject = ? WHERE type = 'order' AND party_id IN ${inParties}
            AND EXISTS (SELECT 1 FROM json_each(items.payload, '$.orderedItem') e WHERE ${OFF_CATALOGUE})`,
        [ERASED, ...part],
      ),
      run(
        `UPDATE items SET payload = json_set(payload, '$.orderedItem', (
            SELECT json_group_array(CASE WHEN ${OFF_CATALOGUE} THEN json_set(e.value, '$.name', ?) ELSE json(e.value) END)
              FROM json_each(items.payload, '$.orderedItem') e))
          WHERE type = 'order' AND party_id IN ${inParties}
            AND EXISTS (SELECT 1 FROM json_each(items.payload, '$.orderedItem') e WHERE ${OFF_CATALOGUE})`,
        [ERASED, ...part],
      ),
      run(`UPDATE items SET access_token_hash = NULL WHERE party_id IN ${inParties}`),
      run(
        `UPDATE items SET possible_party_id = NULL, customer_match = CASE WHEN customer_match = 'weak' THEN 'none' ELSE customer_match END
          WHERE possible_party_id IN ${inParties}`,
      ),
      run(
        `UPDATE thread_entries SET body_text = ?, subject = NULL, attachments = NULL, raw_blob_key = NULL,
                message_id = NULL, in_reply_to = NULL WHERE item_id IN ${theirItems}`,
        [ERASED, ...part],
      ),
      // Who the customer was, as each event and entry names them: a customer who wrote by email is
      // `email:<their address>`. The kind stays (the customer did it); the id goes.
      run(`UPDATE item_events SET actor_id = ? WHERE item_id IN ${theirItems} AND actor_kind IN (${CUSTOMER_ACTORS})`, [
        ERASED_ACTOR,
        ...part,
      ]),
      run(
        `UPDATE thread_entries SET actor_id = ? WHERE item_id IN ${theirItems} AND actor_id IS NOT NULL AND actor_kind IN (${CUSTOMER_ACTORS})`,
        [ERASED_ACTOR, ...part],
      ),
      // The history keeps its sequence, states, actors, times and the changes to times and amounts;
      // the words written with each event, and the before and after of their free text, go.
      run(
        `UPDATE item_events SET reason = CASE WHEN reason IS NULL THEN NULL ELSE ? END,
                meta = CASE WHEN meta IS NULL THEN NULL ELSE json_remove(meta, '$.input') END,
                diff = CASE WHEN diff IS NULL THEN NULL ELSE json_remove(diff, ${DIFF_PERSONAL.map((p) => `'${p}'`).join(", ")}) END
          WHERE item_id IN ${theirItems}`,
        [ERASED, ...part],
      ),
      // The emails, and what a mail service said back about one (a refusal quotes the address).
      run(
        `UPDATE outbound_mail SET subject = ?, body_text = ?, last_error = CASE WHEN last_error IS NULL THEN NULL ELSE ? END
          WHERE item_id IN ${theirItems}`,
        [ERASED, ERASED, ERASED, ...part],
      ),
      run(
        `UPDATE connector_events SET raw = '{}', error = CASE WHEN error IS NULL THEN NULL ELSE ? END WHERE item_id IN ${theirItems}`,
        [ERASED, ...part],
      ),
      // What a webhook's receiver answered to their events (a full payload carries their details, and
      // an error may quote them back).
      run(
        `UPDATE webhook_deliveries SET last_error = ? WHERE last_error IS NOT NULL
          AND event_id IN (SELECT id FROM item_events WHERE item_id IN ${theirItems})`,
        [ERASED, ...part],
      ),
      run(
        `UPDATE webhook_deliveries SET last_error = ? WHERE last_error IS NOT NULL
          AND event_id IN (SELECT id FROM thread_entries WHERE item_id IN ${theirItems})`,
        [ERASED, ...part],
      ),
      // What a job wrote about its work on their items (an error may quote an address).
      run(`UPDATE jobs SET last_error = NULL WHERE json_extract(payload, '$.itemId') IN ${theirItems}`),
      run(`UPDATE blobs SET deleted_at = COALESCE(deleted_at, ?) WHERE party_id IN ${inParties}`, [now, ...part]),
      run(`UPDATE blobs SET deleted_at = COALESCE(deleted_at, ?) WHERE item_id IN ${theirItems}`, [now, ...part]),
    );
  }
  return out;
}

/** What an erasure's confirm names: exactly these parties and items, so a customer who changed since is asked again. */
async function fingerprint(parties: readonly string[], items: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ parties: [...parties].sort(), items: [...items].sort() }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return base64Url(digest).slice(0, 22);
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "owner operations need an owner or staff principal");
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
