import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import {
  business,
  itemEvents,
  items,
  products,
  services,
  settings as settingsTable,
  threadEntries,
} from "../schema/tables";
import { readSettings, SETTINGS_SCHEMA_VERSION, type Settings, settingsSchema } from "../settings/schema";
import { hashText } from "../util/canonical";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { type CreateResult, createItem } from "../write/create";
import { fromZod, WriteError } from "../write/errors";
import { appendThreadEntry } from "../write/thread";
import { type TransitionResult, transitionItem } from "../write/transition";
import { type ItemView, rowToItem, viewFor } from "../write/views";
import { findSlots, type Slot } from "./availability";
import type * as T from "./types";

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
  constructor(private readonly db: Db) {}

  // ---- public ----------------------------------------------------------------

  async getBusinessProfile(): Promise<BusinessProfile> {
    const [row] = await this.db.orm.select().from(business).limit(1);
    const s = await readSettings(this.db);
    return {
      name: row?.name || s.business.name,
      domain: row?.domain ?? null,
      timezone: row?.timezone ?? s.business.timezone,
      currency: row?.currency ?? s.business.currency,
      languages: s.business.languages,
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
    return viewFor(rowToItem(row), caller.actor.kind);
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
      });
    }
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    if (item.type === "message" && item.state !== "open") {
      return transitionItem(this.db, c, { itemId: item.id, event: "reopen", input: { note: input.body } });
    }
    await this.appendEntry(c, item, input.body, "in");
    return viewFor(item, caller.actor.kind);
  }

  acknowledgeReceipt(): Promise<never> {
    throw new WriteError("internal", "receipts arrive in the next release");
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
    const views = rows.map((r) => viewFor(rowToItem(r), caller.actor.kind));
    const last = rows[input.limit - 1];
    return {
      items: views.slice(0, input.limit),
      next_cursor: rows.length > input.limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
    };
  }

  async getItem(caller: Caller, input: T.GetItemInput): Promise<ItemDetail> {
    requireBusiness(caller);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw new WriteError("not_found", "no such item");
    const item = rowToItem(row);
    const [events, thread] = await Promise.all([
      this.db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, item.id)).orderBy(itemEvents.seq),
      this.db.orm
        .select()
        .from(threadEntries)
        .where(eq(threadEntries.itemId, item.id))
        .orderBy(threadEntries.createdAt),
    ]);
    return {
      ...viewFor(item, caller.actor.kind),
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
    const doc = row ? settingsSchema.safeParse(row.doc) : undefined;
    return { doc: doc?.success ? doc.data : await readSettings(this.db), version: row?.version ?? 0 };
  }

  async updateSettings(caller: Caller, input: T.UpdateSettingsInput): Promise<{ doc: Settings; version: number }> {
    requireBusiness(caller);
    const parsed = settingsSchema.safeParse({ ...input.doc, schemaVersion: SETTINGS_SCHEMA_VERSION });
    if (!parsed.success) throw fromZod(parsed.error, "doc");
    const now = nowOf(caller);
    const [row] = await this.db.orm.select({ version: settingsTable.version }).from(settingsTable).limit(1);
    if (!row) {
      await this.db.client.query({
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', ?, ?, 1, ?)",
        params: [SETTINGS_SCHEMA_VERSION, JSON.stringify(parsed.data), now],
        method: "run",
      });
      return { doc: parsed.data, version: 1 };
    }
    const expected = input.expected_version ?? row.version;
    const res = await this.db.client.query({
      sql: "UPDATE settings SET doc = ?, version = version + 1, updated_at = ? WHERE id = 'singleton' AND version = ?",
      params: [JSON.stringify(parsed.data), now, expected],
      method: "run",
    });
    if (res.changes !== 1)
      throw new WriteError("version_conflict", "settings changed since you read them", {
        details: { currentVersion: row.version },
      });
    return { doc: parsed.data, version: expected + 1 };
  }

  // ---- helpers ---------------------------------------------------------------

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

  private appendEntry(caller: Caller, item: Item, body: string, direction: "in" | "out" | "note"): Promise<void> {
    return appendThreadEntry(this.db, caller, item, body, direction);
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
