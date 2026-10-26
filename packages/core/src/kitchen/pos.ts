import type { Statement } from "@surfingdog/platform";
import type { ConnectorCapabilities, SyncStep } from "../connectors/capability";
import type { OutboundOrder, PosOrderState, PosOrderStatus, RunContext } from "../connectors/sdk";
import { registerWriteResolver, type WriteRow, type WrittenRef, writeFirst } from "../connectors/write-first";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { PayloadOf } from "../domain/types";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { menuOf } from "../menu/schema";
import { readSettings } from "../settings/schema";
import { jobStatement } from "../write/common";
import { markForPerson, setOrderProgress } from "./progress";

/**
 * The kitchen's own systems (ADR-040). Three seams, each the owner's choice:
 *
 * - **Orders into a till or a channel** (`orders_out`: Toast, Lightspeed, Clover, Deliverect): an order
 *   the business accepted here is written into its till, first and once (`writeFirst`, op `order`), under
 *   a key that is the same on every retry, with what the kitchen needs and no card data: at once when it
 *   is paid at the handover, once paid when it goes through the business's pay link. Its word back
 *   (`status_in`) is read on every sync: preparing, ready and out for delivery become the order's
 *   progress; a till that refuses or cancels it marks the order for a person, with the till's words. A
 *   till that never answered is written to once more where it answers a repeat as the same order
 *   (`OrdersWriter.idempotent`), else a person is told to look in it; an order cancelled here after it
 *   went in marks the order for a person to cancel it there too.
 * - **Orders taken elsewhere** (GloriaFood's accepted orders): read on every sync, only while the owner
 *   switched the view on, into `pos_orders` for the owner to see, with no customer details, never an
 *   item, never a receipt, kept two days.
 * - **Pause** (Flipdish): pausing the kitchen here pauses the ordering system too, when the owner chose it.
 *
 * A test order never leaves the inbox. Nothing goes back to any network.
 */

/** The kinds of the food connectors, frozen once merged (they name connection rows). */
export const POS_KINDS = ["gloriafood", "flipdish", "toast", "lightspeed", "clover", "deliverect"] as const;
/** The ones accepted orders are written into. */
export const ORDER_KINDS = ["toast", "lightspeed", "clover", "deliverect"] as const;

export const POS_PUSH_KIND = "pos_push";
export const POS_CANCEL_KIND = "pos_cancel";
export const POS_WRITE_OWNER = "food";
/** How long an order taken elsewhere is kept for the owner's view. */
export const ELSEWHERE_KEEP_MS = 2 * 86_400_000;
/** The connection choice that switches the view of orders taken elsewhere on. */
export const ORDERS_VIEW_CHOICE = "orders_view";

const kindsSql = (kinds: readonly string[]) => kinds.map((k) => `'${k}'`).join(", ");

export async function posConnections(
  db: Db,
  kinds: readonly string[] = POS_KINDS,
): Promise<{ id: string; kind: string; name: string }[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id, kind, name FROM connectors WHERE kind IN (${kindsSql(kinds)}) AND status <> 'disabled' ORDER BY created_at, id`,
    params: [],
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), kind: String(r[1]), name: String(r[2] ?? r[1]) }));
}

/**
 * The job that writes an order into the till, in the batch that accepted it or recorded its payment:
 * none without a till. `when` keeps the two apart, so an order whose pay link made it wait at its accept
 * is still written once paid; the write itself happens once (`writeFirst`, by the order's key).
 */
export async function posPushStatements(
  db: Db,
  itemId: string,
  now: number,
  when: "accepted" | "paid" = "accepted",
): Promise<Statement[]> {
  if ((await posConnections(db, ORDER_KINDS)).length === 0) return [];
  const dedupeKey = when === "accepted" ? `pos_push:${itemId}` : `pos_push:${itemId}:paid`;
  return [jobStatement(POS_PUSH_KIND, { itemId }, now, { dedupeKey })];
}

/** The writes of an order into tills that may have landed: written, or never answered. */
async function landedWrites(db: Db, itemId: string): Promise<{ connectorId: string; kind: string }[]> {
  const { rows } = await db.client.query({
    sql: `SELECT DISTINCT w.connector_id, c.kind FROM connector_writes w JOIN connectors c ON c.id = w.connector_id
           WHERE w.item_id = ? AND w.op = 'order' AND w.outcome IN ('written', 'unknown', 'pending')`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({ connectorId: String(r[0]), kind: String(r[1]) }));
}

/**
 * An order that ends here after it went into a till (cancelled, declined, lapsed unpaid): a job that
 * marks it for a person, to cancel it in the till too, so the kitchen does not make it. In the batch that
 * ends it; none when no write of it may have landed.
 */
export async function posCancelStatements(db: Db, itemId: string, now: number): Promise<Statement[]> {
  if ((await landedWrites(db, itemId)).length === 0) return [];
  return [jobStatement(POS_CANCEL_KIND, { itemId }, now, { dedupeKey: `pos_cancel:${itemId}` })];
}

export function posCancelHandler(): JobHandler {
  return async (job, { db, now }) => {
    const itemId = (job.payload as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== "string") return { note: "no item" };
    const tills = await landedWrites(db, itemId);
    for (const t of tills) {
      const title = TITLES[t.kind] ?? "your till";
      await markForPerson(
        db,
        itemId,
        `This order was cancelled here: cancel it in ${title} too, so the kitchen does not make it.`,
        now,
      );
    }
    return { note: tills.map((t) => `${t.kind}: told a person`).join("; ") || "in no till" };
  };
}

interface OrderRow {
  readonly id: string;
  readonly state: string;
  readonly sandbox: boolean;
  readonly payload: PayloadOf<"order">;
  readonly name: string | null;
  readonly phone: string | null;
}

async function orderRow(db: Db, itemId: string): Promise<OrderRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.id, i.type, i.state, i.flags, i.payload, p.display_name, p.contact
            FROM items i LEFT JOIN parties p ON p.id = i.party_id WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r || String(r[1]) !== "order") return null;
  const json = (v: unknown) => {
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  const contact = (json(r[6]) ?? {}) as { name?: unknown; phone?: unknown };
  const name = typeof contact.name === "string" ? contact.name : typeof r[5] === "string" ? r[5] : null;
  return {
    id: String(r[0]),
    state: String(r[2]),
    sandbox: (json(r[3]) as { sandbox?: unknown } | null)?.sandbox === true,
    payload: json(r[4]) as PayloadOf<"order">,
    name,
    phone: typeof contact.phone === "string" ? contact.phone : null,
  };
}

/** The order as the till is given it: the till's own ids where the menu came from it, a first name. */
export async function outboundOrder(
  db: Db,
  row: OrderRow,
  ctx: Pick<RunContext, "inbox">,
  kind: string,
): Promise<OutboundOrder> {
  const p = row.payload;
  const ids = p.orderedItem.flatMap((l) => (l.productId ? [l.productId] : []));
  const ext = new Map<string, { externalId: string | null; menu: ReturnType<typeof menuOf> }>();
  if (ids.length) {
    const { rows } = await db.client.query({
      sql: `SELECT id, source, external_id, menu FROM products WHERE id IN (${ids.map(() => "?").join(", ")})`,
      params: ids,
      method: "all",
    });
    for (const r of rows) {
      ext.set(String(r[0]), {
        externalId: String(r[1]) === kind && r[2] !== null ? String(r[2]) : null,
        menu: menuOf(r[3]),
      });
    }
  }
  const delivery = p.fulfil?.method === "delivery";
  const first = (row.name ?? "").trim().split(/\s+/)[0] ?? "";
  return {
    itemId: row.id,
    reference: shortRef(row.id),
    key: `${ctx.inbox.id}:${row.id}`,
    method: p.fulfil?.method ?? "pickup",
    slotStart: p.fulfil?.slot ? Date.parse(p.fulfil.slot.start) : null,
    lines: p.orderedItem.map((l) => {
      const e = l.productId ? ext.get(l.productId) : undefined;
      return {
        externalId: e?.externalId ?? null,
        groupExternalId: e?.externalId ? (e.menu?.externalGroupId ?? null) : null,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.price,
        options: (l.options ?? []).map((o) => {
          const group = e?.menu?.optionGroups.find((g) => g.id === o.groupId);
          const choice = group?.choices.find((c) => c.id === o.choiceId);
          return {
            name: o.name ?? o.choiceId,
            externalId: e?.externalId ? (choice?.externalId ?? null) : null,
            groupExternalId: e?.externalId ? (group?.externalId ?? null) : null,
            priceDelta: o.priceDelta ?? null,
            portion: o.portion ?? "whole",
          };
        }),
        note: l.note ?? null,
      };
    }),
    total: p.totalPrice,
    fee: p.fulfil?.fee ?? null,
    tip: p.tip?.amount ?? null,
    paid: p.paidAmount !== undefined || p.paymentRef !== undefined,
    customer: { firstName: first || null, phone: delivery ? row.phone : null },
    address: delivery ? (p.shippingAddress ?? null) : null,
    note: p.notes ? p.notes.slice(0, 500) : null,
  };
}

export interface PosPushOutcome {
  readonly connectorId: string;
  readonly kind: string;
  readonly status: "written" | "pending" | "refused" | "busy" | "skipped";
  readonly note: string;
}

/** Writes an accepted order into every till connected; answers what each did. */
export async function pushOrder(
  db: Db,
  connectors: ConnectorCapabilities,
  itemId: string,
  now: number,
): Promise<PosPushOutcome[]> {
  const row = await orderRow(db, itemId);
  if (!row || row.state === "declined" || row.state === "cancelled" || row.state === "expired") return [];
  // A pay link is out: the order goes in once paid (its own job then), never as one to pay at the door.
  if (row.state === "awaiting_payment" || row.state === "payment_failed") return [];
  const out: PosPushOutcome[] = [];
  for (const conn of await posConnections(db, ORDER_KINDS)) {
    const skip = (note: string): PosPushOutcome => ({ connectorId: conn.id, kind: conn.kind, status: "skipped", note });
    if (row.sandbox) {
      out.push(skip("a test order never goes to a till"));
      continue;
    }
    const run = await connectors.contextFor(conn.id, now);
    const writer = run?.definition.orders;
    if (!run || !writer || !run.definition.capabilities.includes("orders_out")) {
      out.push(skip("this till cannot take orders here"));
      continue;
    }
    const order = await outboundOrder(db, row, run.ctx, conn.kind);
    const r = await writeFirst(db, {
      connectorId: conn.id,
      itemId,
      op: "order",
      owner: POS_WRITE_OWNER,
      key: order.key,
      request: { reference: order.reference, lines: order.lines.length, total: order.total },
      write: async () => toWritten(await writer.put(run.ctx, order)),
      find: async () => {
        const found = await writer.find(run.ctx, order);
        return found ? toWritten(found) : null;
      },
      now,
    });
    if (r.status === "written") {
      out.push({
        connectorId: conn.id,
        kind: conn.kind,
        status: "written",
        note: r.replayed ? "there already" : "written",
      });
    } else if (r.status === "refused") {
      out.push({ connectorId: conn.id, kind: conn.kind, status: "refused", note: r.reason });
      await markForPerson(db, itemId, `${run.definition.title} did not take this order: ${r.reason}`, now);
    } else if (r.status === "pending") {
      out.push({ connectorId: conn.id, kind: conn.kind, status: "pending", note: "no answer yet: looked for again" });
      // The kitchen may not have it: a person knows now, not only once the looking is over.
      await markForPerson(
        db,
        itemId,
        `${run.definition.title} has not answered about this order yet. This inbox looks for it there for five minutes; check ${run.definition.title} if it does not show.`,
        now,
      );
    } else if (r.status === "busy") {
      out.push({ connectorId: conn.id, kind: conn.kind, status: "busy", note: "being written now" });
    } else {
      out.push({ connectorId: conn.id, kind: conn.kind, status: "refused", note: "the till took it back" });
    }
  }
  return out;
}

function toWritten(ref: { externalId: string; status?: PosOrderStatus | undefined }): WrittenRef {
  return { externalId: ref.externalId, ...(ref.status ? { detail: { status: ref.status } } : {}) };
}

export function posPushHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const itemId = (job.payload as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== "string") return { note: "no item" };
    const outcomes = await pushOrder(db, connectors, itemId, now);
    return { note: outcomes.map((o) => `${o.kind}: ${o.status} (${o.note})`).join("; ") || "no till" };
  };
}

/**
 * Settles an order write whose answer never came: looked for again by its key in the till. Never found,
 * it is written once more where the till answers a repeat of the same key as the same order; otherwise,
 * or when that was the second time, a person is told to look in the till. Nothing is ever left unsaid.
 */
export function registerFoodResolver(connectors: ConnectorCapabilities): void {
  registerWriteResolver(POS_WRITE_OWNER, {
    async find(db: Db, row: WriteRow, now: number) {
      const run = await connectors.contextFor(row.connectorId, now);
      const writer = run?.definition.orders;
      const item = await orderRow(db, row.itemId);
      if (!run || !writer || !item) return null;
      const kind = (await posConnections(db)).find((c) => c.id === row.connectorId)?.kind ?? "";
      const found = await writer.find(run.ctx, await outboundOrder(db, item, run.ctx, kind));
      return found ? toWritten(found) : null;
    },
    async settled(db: Db, row: WriteRow, outcome: "written" | "refused", _ref: WrittenRef | null, now: number) {
      if (outcome !== "refused") return;
      const run = await connectors.contextFor(row.connectorId, now);
      const kind = (await posConnections(db)).find((c) => c.id === row.connectorId)?.kind ?? "";
      const title = run?.definition.title ?? TITLES[kind] ?? "The till";
      const idempotent = run?.definition.orders?.idempotent === true;
      const { rows } = await db.client.query({
        sql: "SELECT COUNT(*) FROM connector_writes WHERE connector_id = ? AND item_id = ? AND op = 'order'",
        params: [row.connectorId, row.itemId],
        method: "all",
      });
      if (idempotent && Number(rows[0]?.[0] ?? 0) < 2) {
        await ensureJob(db, POS_PUSH_KIND, `pos_push:${row.itemId}:again`, { now, payload: { itemId: row.itemId } });
        return;
      }
      await markForPerson(
        db,
        row.itemId,
        idempotent
          ? `${title} did not answer about this order, twice: check it in ${title}.`
          : `${title} did not answer about this order: check it in ${title}. It was not sent again, so it is never made twice.`,
        now,
      );
    },
  });
}

/**
 * What a till's word on one of its orders does here: a refusal or a cancellation marks the order for a
 * person with the till's words; preparing, ready and out for delivery become its progress. Kept on the
 * write's journal row, so the same word is applied once.
 */
export async function applyPosState(
  db: Db,
  connectorId: string,
  externalId: string,
  state: PosOrderState,
  now: number,
): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT w.id, w.item_id, w.detail, c.kind FROM connector_writes w JOIN connectors c ON c.id = w.connector_id
           WHERE w.connector_id = ? AND w.op = 'order' AND w.outcome = 'written' AND w.external_id = ?
           ORDER BY w.attempt DESC LIMIT 1`,
    params: [connectorId, externalId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return false;
  let detail: { status?: string } = {};
  try {
    detail = typeof r[2] === "string" ? (JSON.parse(r[2]) as { status?: string }) : {};
  } catch {
    detail = {};
  }
  if (detail.status === state.status) return false;
  // Kept as applied only with what it did: a refusal and the person it marks are one batch.
  const applied: Statement = {
    sql: "UPDATE connector_writes SET detail = ?, updated_at = ? WHERE id = ?",
    params: [JSON.stringify({ ...detail, status: state.status }), now, String(r[0])],
    method: "run",
  };
  const itemId = String(r[1]);
  const title = TITLES[String(r[3])] ?? "The till";
  if (state.status === "rejected" || state.status === "cancelled") {
    const why = state.reason ? `: ${state.reason.slice(0, 300)}` : ".";
    await markForPerson(
      db,
      itemId,
      `${title} ${state.status === "rejected" ? "did not take" : "cancelled"} this order${why}`,
      now,
      [applied],
    );
    return true;
  }
  if (state.status === "preparing" || state.status === "ready" || state.status === "out_for_delivery") {
    const system = {
      actor: { kind: "connector" as const, id: connectorId, channel: "connector" as const },
      tier: "verified_principal" as const,
      sandbox: false,
      now: () => now,
    };
    try {
      await setOrderProgress(db, system, {
        itemId,
        stage: state.status,
        ...(state.etaAt ? { etaAt: new Date(state.etaAt).toISOString() } : {}),
      });
    } catch {
      // An order that moved on here first (fulfilled by hand) keeps what the business said.
    }
  }
  await db.client.query(applied);
  return true;
}

const TITLES: Readonly<Record<string, string>> = {
  toast: "Toast",
  lightspeed: "Lightspeed",
  clover: "Clover",
  deliverect: "Deliverect",
};

/** What became of the orders written to one till: their progress, or a person told it refused them. */
export const posStatusStep: SyncStep = async ({ db, connectorId, definition, ctx, now }) => {
  const writer = definition.orders;
  if (!writer || !definition.capabilities.includes("status_in")) return null;
  const { rows } = await db.client.query({
    sql: `SELECT w.id, w.item_id, w.external_id, w.detail FROM connector_writes w JOIN items i ON i.id = w.item_id
           WHERE w.connector_id = ? AND w.op = 'order' AND w.outcome = 'written' AND w.external_id IS NOT NULL
             AND i.state IN ('accepted', 'awaiting_payment', 'payment_failed', 'paid', 'fulfilling')
           ORDER BY w.updated_at, w.id LIMIT 20`,
    params: [connectorId],
    method: "all",
  });
  let moved = 0;
  for (const r of rows) {
    // Read now: to the back of the line, so the next sync asks about the others first.
    await db.client.query({
      sql: "UPDATE connector_writes SET updated_at = ? WHERE id = ?",
      params: [now, String(r[0])],
      method: "run",
    });
    const state = await writer.status(ctx, { externalId: String(r[2]) });
    if (state && (await applyPosState(db, connectorId, String(r[2]), state, now))) moved++;
  }
  return moved ? `${moved} order${moved === 1 ? "" : "s"} moved in ${definition.title}` : null;
};

/** Orders taken in the ordering system, read for the owner's view while they switched it on. */
export const elsewhereStep: SyncStep = async ({ db, connectorId, definition, ctx, now }) => {
  const reader = definition.elsewhere;
  if (!reader) return null;
  await db.client.query({
    sql: "DELETE FROM pos_orders WHERE created_at < ?",
    params: [now - ELSEWHERE_KEEP_MS],
    method: "run",
  });
  if (ctx.choices?.[ORDERS_VIEW_CHOICE] !== "on") return null;
  const orders = await reader.poll(ctx);
  for (const o of orders.slice(0, 200)) {
    await db.client.query({
      sql: `INSERT INTO pos_orders (connector_id, external_id, accepted_at, view, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (connector_id, external_id) DO NOTHING`,
      params: [connectorId, o.externalId.slice(0, 100), o.acceptedAt, JSON.stringify(o), now],
      method: "run",
    });
  }
  return orders.length ? `${orders.length} order${orders.length === 1 ? "" : "s"} taken in ${definition.title}` : null;
};

/** The orders taken elsewhere, newest first, for the owner's screen. */
export async function elsewhereOrders(db: Db, now: number): Promise<{ connectorId: string; order: unknown }[]> {
  const { rows } = await db.client.query({
    sql: "SELECT connector_id, view FROM pos_orders WHERE created_at >= ? ORDER BY accepted_at DESC LIMIT 100",
    params: [now - ELSEWHERE_KEEP_MS],
    method: "all",
  });
  return rows.map((r) => {
    let order: unknown = null;
    try {
      order = typeof r[1] === "string" ? JSON.parse(r[1]) : r[1];
    } catch {
      order = null;
    }
    return { connectorId: String(r[0]), order };
  });
}

/** Pauses (or resumes, `until` null) every ordering system that can be, when the owner chose so. */
export async function pauseConnected(
  db: Db,
  connectors: ConnectorCapabilities,
  until: number | null,
  now: number,
): Promise<{ kind: string; ok: boolean; note: string }[]> {
  const settings = await readSettings(db);
  if (!settings.kitchen.pausePos) return [];
  const out: { kind: string; ok: boolean; note: string }[] = [];
  for (const conn of await posConnections(db)) {
    const run = await connectors.contextFor(conn.id, now);
    const pause = run?.definition.pause;
    if (!run || !pause) continue;
    try {
      if (until === null) await pause.resume(run.ctx);
      else await pause.pause(run.ctx, until);
      out.push({ kind: conn.kind, ok: true, note: until === null ? "resumed" : "paused" });
    } catch (error) {
      out.push({ kind: conn.kind, ok: false, note: error instanceof Error ? error.message : "did not answer" });
    }
  }
  return out;
}
