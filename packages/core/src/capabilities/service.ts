import { and, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { type NetworkView, networkStartStatements, networkViews } from "../network/index";
import { ReceiptCapabilities, type ReceiptStatus, type ReceiptView } from "../receipts/capabilities";
import {
  business,
  itemEvents,
  items,
  parties,
  partyIdentities,
  products,
  services,
  settings as settingsTable,
  threadEntries,
} from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { mergeSettings, patchPaths } from "../settings/merge";
import { prepareSettingsWrite, syncLegacyPair } from "../settings/patch";
import {
  isPlainObject,
  parseStoredSettings,
  readSettings,
  reportsTo,
  SETTINGS_SCHEMA_VERSION,
  type Settings,
  settingsWriteSchema,
} from "../settings/schema";
import { hashText } from "../util/canonical";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { type CreateResult, createItem } from "../write/create";
import { type FieldProblem, fromZod, WriteError } from "../write/errors";
import { appendThreadEntry } from "../write/thread";
import { type TransitionResult, transitionItem } from "../write/transition";
import { type ItemView, type PartyView, rowToItem, viewFor } from "../write/views";
import { findSlots, type Slot } from "./availability";
import { FeedCapabilities } from "./feeds";
import { SetupCapabilities } from "./setup";
import type * as T from "./types";
import { WebhookCapabilities } from "./webhooks";

/**
 * The capability set: the eleven public and the owner operations, implemented once. Adapters
 * (REST, MCP, A2A, email, form, …) only translate; they never touch storage or policy.
 */
export interface BusinessProfile {
  readonly name: string;
  readonly domain: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: readonly string[];
  readonly item_types: readonly string[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ItemDetail extends ItemView {
  readonly events: readonly {
    seq: number;
    event: string;
    from: string | null;
    to: string;
    actor: string;
    reason: string | null;
    at: string;
  }[];
  readonly thread: readonly {
    id: string;
    direction: string;
    channel: string;
    actor: string;
    body: string;
    at: string;
  }[];
}

export class Capabilities {
  /** The owner's setup: profile, services, products, opening hours, rules. */
  readonly setup: SetupCapabilities;

  /** Where events go, and the cursor a developer polls when it cannot receive one (ADR-015). */
  readonly webhooks: WebhookCapabilities;

  /** Product feeds: the one integration that needs no credentials at all (ADR-015 §7.3). */
  readonly feeds: FeedCapabilities;

  /** Signed receipts and their acknowledgements (ADR-016). Issued by a job, read by every door. */
  readonly receipts: ReceiptCapabilities;

  /**
   * Seals connector credentials and webhook secrets (ADR-015 §2). Null when the instance has no
   * `INBOX_SECRET_KEY`: everything else works, and anything that would store a secret refuses
   * through `requireSecretBox`.
   */
  readonly secrets: SecretBox | null;

  constructor(
    private readonly db: Db,
    secrets: SecretBox | null = null,
    /**
     * This instance's public URL (`INBOX_PUBLIC_URL`), when the host knows it. It is what an
     * event's `data.url` hangs off, and the delivery job resolves it the same way, so the URL in a
     * webhook body and the URL in `GET /v1/owner/events` are the same string for the same event.
     */
    baseUrl?: string | undefined,
    /**
     * How far behind live the developer event cursor reads (`EVENT_SETTLE_MS`). Only a test that
     * writes an event and polls for it in the same tick ever passes zero.
     */
    eventSettleMs?: number | undefined,
  ) {
    this.setup = new SetupCapabilities(db);
    this.feeds = new FeedCapabilities(db);
    this.secrets = secrets;
    this.webhooks = new WebhookCapabilities(db, secrets, undefined, baseUrl, eventSettleMs);
    this.receipts = new ReceiptCapabilities(db, secrets, baseUrl);
  }

  // ---- public ----------------------------------------------------------------

  async getBusinessProfile(): Promise<BusinessProfile> {
    const [row] = await this.db.orm.select().from(business).limit(1);
    const s = await readSettings(this.db);
    return {
      name: row?.name || s.business.name,
      domain: row?.domain ?? null,
      timezone: row?.timezone ?? s.business.timezone,
      currency: row?.currency ?? s.business.currency,
      languages: row?.languages?.length ? row.languages : s.business.languages,
      item_types: ["message", "quote_request", "booking", "order"],
    };
  }

  async listServices(input: T.ListServicesInput): Promise<Page<typeof services.$inferSelect>> {
    const rows = await this.db.orm
      .select()
      .from(services)
      .where(eq(services.active, 1))
      .orderBy(services.sort, services.name)
      .limit(input.limit + 1);
    return page(rows, input.limit, (r) => r.id);
  }

  async listProducts(input: T.ListProductsInput): Promise<Page<typeof products.$inferSelect>> {
    const where = input.q
      ? and(eq(products.active, 1), sql`lower(${products.name}) LIKE ${`%${input.q.toLowerCase()}%`}`)
      : eq(products.active, 1);
    const rows = await this.db.orm
      .select()
      .from(products)
      .where(where)
      .orderBy(products.name)
      .limit(input.limit + 1);
    return page(rows, input.limit, (r) => r.id);
  }

  async checkAvailability(
    input: T.CheckAvailabilityInput,
  ): Promise<{ service: { id: string; name: string; durationMin: number }; slots: Slot[] }> {
    const profile = await this.getBusinessProfile();
    return findSlots(this.db, {
      serviceId: input.service_id,
      from: input.from,
      to: input.to,
      timezone: profile.timezone,
    });
  }

  requestQuote(caller: Caller, input: T.RequestQuoteInput): Promise<CreateResult> {
    return createItem(this.db, withKey(caller, input.idempotency_key), {
      type: "quote_request",
      payload: input.payload,
      contact: input.contact,
      message: input.message,
    });
  }

  createBooking(caller: Caller, input: T.CreateBookingInput): Promise<CreateResult> {
    return createItem(this.db, withKey(caller, input.idempotency_key), {
      type: "booking",
      payload: input.payload,
      contact: input.contact,
      message: input.message,
    });
  }

  createOrder(caller: Caller, input: T.CreateOrderInput): Promise<CreateResult> {
    return createItem(this.db, withKey(caller, input.idempotency_key), {
      type: "order",
      payload: input.payload,
      contact: input.contact,
      message: input.message,
    });
  }

  async getItemStatus(caller: Caller, input: T.GetItemStatusInput): Promise<ItemView> {
    const row = await this.loadOwned(withToken(caller, input.access_token), input.item_id);
    const receipts = await this.receipts.forItem(row.id);
    return { ...viewFor(rowToItem(row), caller.actor.kind), receipts };
  }

  cancelItem(caller: Caller, input: T.CancelItemInput): Promise<TransitionResult> {
    return transitionItem(this.db, withToken(withKey(caller, input.idempotency_key), input.access_token), {
      itemId: input.item_id,
      event: "cancel",
      ...(input.reason ? { input: { note: input.reason }, reason: input.reason } : {}),
    });
  }

  /** A new conversation, or a reply on an item the caller owns (which reopens an answered message). */
  async sendMessage(caller: Caller, input: T.SendMessageInput): Promise<CreateResult | TransitionResult | ItemView> {
    const c = withToken(withKey(caller, input.idempotency_key), input.access_token);
    if (!input.item_id) {
      return createItem(this.db, c, {
        type: "message",
        payload: { text: input.body, subject: input.subject },
        contact: input.contact,
        message: input.body,
        messageId: input.message_id,
      });
    }
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    if (item.type === "message" && item.state !== "open") {
      return transitionItem(this.db, c, { itemId: item.id, event: "reopen", input: { note: input.body } });
    }
    await this.appendEntry(c, item, input.body, "in", input.message_id);
    return viewFor(item, caller.actor.kind);
  }

  /**
   * The customer's agent counter-signs a receipt it was handed (ADR-016). Ownership of the item is
   * proved the same way as reading it — the party on the caller, or the access token the creator
   * received — and the acknowledgement itself is checked by the receipt capability.
   */
  async acknowledgeReceipt(caller: Caller, input: T.AcknowledgeReceiptInput): Promise<ReceiptView> {
    const row = await this.loadOwned(withToken(caller, input.access_token), input.item_id);
    return this.receipts.acknowledge(row, input.counter_signature, { now: nowOf(caller), receipt: input.receipt });
  }

  // ---- owner -----------------------------------------------------------------

  async listItems(caller: Caller, input: T.ListItemsInput): Promise<Page<ItemView>> {
    requireBusiness(caller);
    const conditions = [eq(items.sandbox, input.sandbox ? 1 : 0)];
    if (input.type) conditions.push(eq(items.type, input.type));
    if (input.state) conditions.push(eq(items.state, input.state));
    if (input.needs_human !== undefined) conditions.push(eq(items.needsHuman, input.needs_human ? 1 : 0));
    if (input.open_only && !input.state) conditions.push(sql`${items.closedAt} IS NULL`);
    if (input.q) {
      const match = ftsQuery(input.q);
      conditions.push(sql`${items.id} IN (SELECT item_id FROM search_fts WHERE search_fts MATCH ${match})`);
    }
    if (input.cursor) {
      const c = decodeCursor(input.cursor);
      conditions.push(
        or(lt(items.updatedAt, c.updatedAt), and(eq(items.updatedAt, c.updatedAt), lt(items.id, c.id))) ?? sql`1`,
      );
    }
    const rows = await this.db.orm
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(input.limit + 1);
    const partyViews = await this.partyViews(rows.map((r) => r.partyId));
    const views = rows.map((r) => viewFor(rowToItem(r), caller.actor.kind, partyViews.get(r.partyId)));
    const last = rows[input.limit - 1];
    return {
      items: views.slice(0, input.limit),
      next_cursor: rows.length > input.limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
    };
  }

  /** For the Settings page: can this instance issue receipts, and how many has it. */
  getReceiptStatus(caller: Caller): Promise<ReceiptStatus> {
    requireBusiness(caller);
    return this.receipts.status();
  }

  async getItem(caller: Caller, input: T.GetItemInput): Promise<ItemDetail> {
    requireBusiness(caller);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw new WriteError("not_found", "no such item");
    const item = rowToItem(row);
    const [events, thread, partyViews, receipts] = await Promise.all([
      this.db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, item.id)).orderBy(itemEvents.seq),
      this.db.orm
        .select()
        .from(threadEntries)
        .where(eq(threadEntries.itemId, item.id))
        .orderBy(threadEntries.createdAt),
      this.partyViews([row.partyId]),
      this.receipts.forItem(item.id),
    ]);
    return {
      ...viewFor(item, caller.actor.kind, partyViews.get(row.partyId)),
      receipts,
      events: events.map((e) => ({
        seq: e.seq,
        event: e.event,
        from: e.fromState,
        to: e.toState,
        actor: `${e.actorKind}:${e.actorId}`,
        reason: e.reason,
        at: new Date(e.createdAt).toISOString(),
      })),
      thread: thread.map((t) => ({
        id: t.id,
        direction: t.direction,
        channel: t.channel,
        actor: `${t.actorKind}:${t.actorId ?? ""}`,
        body: t.bodyText,
        at: new Date(t.createdAt).toISOString(),
      })),
    };
  }

  transitionItem(caller: Caller, input: T.TransitionItemInput): Promise<TransitionResult> {
    requireBusiness(caller);
    return transitionItem(this.db, withKey(caller, input.idempotency_key), {
      itemId: input.item_id,
      event: input.event,
      ...(input.input ? { input: input.input } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expected_version !== undefined ? { expectedVersion: input.expected_version } : {}),
    });
  }

  /** A reply to the customer (answers an open message) or an internal note. */
  async reply(caller: Caller, input: T.ReplyInput): Promise<TransitionResult | ItemView> {
    requireBusiness(caller);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw new WriteError("not_found", "no such item");
    const item = rowToItem(row);
    if (!input.internal && item.type === "message" && item.state === "open") {
      return transitionItem(this.db, withKey(caller, input.idempotency_key), {
        itemId: item.id,
        event: "answer",
        input: { note: input.body },
      });
    }
    await this.appendEntry(caller, item, input.body, input.internal ? "note" : "out");
    return viewFor(item, caller.actor.kind);
  }

  async getSettings(caller: Caller): Promise<{ doc: Settings; version: number }> {
    requireBusiness(caller);
    const [row] = await this.db.orm
      .select({ doc: settingsTable.doc, version: settingsTable.version })
      .from(settingsTable)
      .limit(1);
    // Leniently, like every other reader: a stored value this version rejects is shown as its
    // default, and the owner app saving the page writes only what the owner changed.
    return { doc: parseStoredSettings(row?.doc ?? {}).settings, version: row?.version ?? 0 };
  }

  /**
   * A merge, never a replace (`settings/merge.ts`): the caller's changes are laid over the stored
   * document as it was written — not over what this version parsed out of it — and that raw
   * document is what is stored. So a section, a key or a network the caller left out keeps its
   * value, a key only a newer version knows survives, and no default is written back as if it had
   * been chosen. The result is checked along the paths the caller changed; a stored value that
   * was valid once and is not now does not block a change to something else.
   */
  async updateSettings(caller: Caller, input: T.UpdateSettingsInput): Promise<{ doc: Settings; version: number }> {
    requireBusiness(caller);
    const now = nowOf(caller);
    const [row] = await this.db.orm
      .select({ doc: settingsTable.doc, version: settingsTable.version })
      .from(settingsTable)
      .limit(1);
    const stored = row && isPlainObject(row.doc) ? row.doc : {};
    const prepared = prepareSettingsWrite(stored, input.doc);
    if ("problems" in prepared) {
      throw new WriteError("invalid_input", `Invalid input: ${describeProblems(prepared.problems)}`, {
        fields: prepared.problems,
      });
    }
    const merged = mergeSettings(prepared.base, prepared.patch) as Record<string, unknown>;
    merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
    syncLegacyPair(merged);
    const checked = settingsWriteSchema.safeParse(merged);
    if (!checked.success) {
      const changed = patchPaths(prepared.patch);
      const issues = checked.error.issues.filter((issue) => {
        const at = issue.path.map(String);
        return changed.some((p) => startsWith(at, p) || startsWith(p, at));
      });
      if (issues.length) throw fromZod(new z.ZodError(issues), "doc");
    }
    const json = JSON.stringify(merged);
    // What is stored is what was sent, unknown keys included, so its size is bounded here.
    if (json.length > MAX_SETTINGS_BYTES) {
      throw new WriteError("invalid_input", `the settings document would be over ${MAX_SETTINGS_BYTES / 1024} KB`, {
        fields: [{ path: "doc", problem: "invalid", message: "too large" }],
      });
    }
    const before = parseStoredSettings(stored).settings;
    const after = parseStoredSettings(merged).settings;
    let version: number;
    if (!row) {
      await this.db.client.query({
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', ?, ?, 1, ?)",
        params: [SETTINGS_SCHEMA_VERSION, json, now],
        method: "run",
      });
      version = 1;
    } else {
      const expected = input.expected_version ?? row.version;
      const res = await this.db.client.query({
        sql: "UPDATE settings SET doc = ?, version = version + 1, updated_at = ? WHERE id = 'singleton' AND version = ?",
        params: [json, now, expected],
        method: "run",
      });
      if (res.changes !== 1)
        throw new WriteError("version_conflict", "settings changed since you read them", {
          details: { currentVersion: row.version },
        });
      version = expected + 1;
    }
    // A network just switched on hears from this inbox now, not at the top of the next hour: its
    // ping, and its publisher, which queues every receipt already issued (ADR-017 §8.1). Losing
    // this insert costs nothing but the wait: the hourly tick queues the same jobs by the same keys.
    const started = Object.entries(after.networks).filter(
      ([origin, entry]) => reportsTo(entry) && !reportsTo(before.networks[origin]),
    );
    if (started.length) {
      await this.db.batch(started.flatMap(([origin, entry]) => networkStartStatements(origin, entry, now)));
    }
    return { doc: after, version };
  }

  /** Every network in settings, switched on or not, with how it is going and what it has been sent. */
  async getNetworks(caller: Caller): Promise<{ networks: NetworkView[] }> {
    requireBusiness(caller);
    return { networks: await networkViews(this.db, await readSettings(this.db)) };
  }

  // ---- helpers ---------------------------------------------------------------

  /** Who is behind each item, for the business side: name, contact, and whether any identity is verified. */
  private async partyViews(ids: readonly string[]): Promise<Map<string, PartyView>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, PartyView>();
    if (unique.length === 0) return out;
    const [rows, verified] = await Promise.all([
      this.db.orm.select().from(parties).where(inArray(parties.id, unique)),
      this.db.orm
        .select({ partyId: partyIdentities.partyId })
        .from(partyIdentities)
        .where(and(inArray(partyIdentities.partyId, unique), isNotNull(partyIdentities.verifiedAt))),
    ]);
    const verifiedIds = new Set(verified.map((v) => v.partyId));
    for (const p of rows) {
      const contact = (p.contact ?? {}) as { email?: string; phone?: string; name?: string };
      out.set(p.id, {
        id: p.id,
        name: p.displayName ?? contact.name ?? null,
        kind: p.kind,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        verified: verifiedIds.has(p.id),
      });
    }
    return out;
  }

  private async loadOwned(caller: Caller, itemId: string) {
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, itemId));
    if (!row) throw new WriteError("not_found", "no such item");
    if (isCustomer(caller)) {
      const owns =
        (caller.actor.partyId && caller.actor.partyId === row.partyId) ||
        (caller.accessToken && row.accessTokenHash && (await hashText(caller.accessToken)) === row.accessTokenHash);
      if (!owns) throw new WriteError("not_allowed", "this item belongs to someone else");
    }
    return row;
  }

  private appendEntry(
    caller: Caller,
    item: Item,
    body: string,
    direction: "in" | "out" | "note",
    messageId?: string | undefined,
  ): Promise<void> {
    return appendThreadEntry(this.db, caller, item, body, direction, messageId);
  }
}

function withKey(caller: Caller, key: string | undefined): Caller {
  if (!key) return caller;
  const scope = caller.idempotency?.scope ?? `${caller.actor.kind}:${caller.actor.id}:${caller.actor.channel}`;
  return { ...caller, idempotency: { scope, key } };
}

function withToken(caller: Caller, token: string | undefined): Caller {
  return token ? { ...caller, accessToken: token } : caller;
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "owner operations need an owner or staff principal");
}

function page<R>(rows: R[], limit: number, id: (r: R) => string): Page<R> {
  const last = rows[limit - 1];
  return { items: rows.slice(0, limit), next_cursor: rows.length > limit && last ? id(last) : null };
}

function encodeCursor(c: { updatedAt: number; id: string }): string {
  return btoa(`${c.updatedAt}|${c.id}`);
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const [updatedAt, id] = atob(cursor).split("|");
    if (!updatedAt || !id) throw new Error("bad cursor");
    return { updatedAt: Number(updatedAt), id };
  } catch {
    throw new WriteError("invalid_input", "invalid cursor", {
      fields: [{ path: "cursor", problem: "invalid", message: "not a cursor from this API" }],
    });
  }
}

/** Never pass user text to FTS raw: tokenise, quote, prefix-match. */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"*`).join(" ");
}

const MAX_SETTINGS_BYTES = 64 * 1024;

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((p, i) => path[i] === p);
}

function describeProblems(problems: readonly FieldProblem[]): string {
  return problems.map((p) => `${p.path} ${p.message}`).join("; ");
}
