import { businessFacts } from "../customer/audience";
import { subjectIn } from "../customer/describe";
import { moneyIn, oneLine, shortRef } from "../customer/format";
import { customerLang } from "../customer/lang";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { randomToken, ulid } from "../ids";
import { ensureJob } from "../jobs/schedule";
import { readSettings } from "../settings/schema";
import type { Caller } from "../write/caller";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { PAY_LINK_KIND, PAY_NOTICE_KIND } from "./pay-queue";
import {
  ConnectorError,
  type InboundRequest,
  type KnownLink,
  type PaymentFact,
  type PaymentsHandler,
  type RunContext,
} from "./sdk";

/**
 * Getting paid through the business's own account (ADR-023). An order the inbox accepts gets a link
 * to pay in the business's own Stripe or Mollie account; the platform's signed word that it was
 * paid, checked again with the platform, marks it paid; refunds are made where the money is, in the
 * business's own dashboard. The money never passes the inbox, nor Surfing Dog.
 *
 * The rules that shape it:
 * - **One live link per order** (`connector_payments_live`). Two jobs that meet make one, never two,
 *   and only the job that holds a link's claim asks the platform for it.
 * - **A link for what the order comes to now.** When the total changes, the link is closed on the
 *   platform and a new one sent; when the order ends without a payment, it is closed.
 * - **Nothing the request says is believed.** A webhook is checked by its signature (Stripe) or not
 *   at all (Mollie's per-link one carries only an id), and what it is about is always read back from
 *   the platform with the business's own key before anything is marked paid.
 * - **Test keys for test orders, live keys for real ones.** Nobody is asked for real money for a
 *   test, and no real order is marked paid with a test card.
 * - **A payment that cannot be recorded is said, not swallowed**: one paid after the order was
 *   cancelled, or paid twice, is the owner's to refund, and they are told where.
 * - **The owner's own link stays theirs**: an order whose payment link the owner set is left alone.
 */

/** The order states that want a link: accepted, asked to pay, or a payment that did not go through. */
const WANTS_LINK: ReadonlySet<string> = new Set(["accepted", "awaiting_payment", "payment_failed"]);
/** A link being made is the job's for this long, past the slowest platform answer. */
const CLAIM_MS = 2 * 60_000;
/** Attempts at making one link before it is given up and the owner told. */
const MAX_ATTEMPTS = 8;
/** Platform calls one reconciliation run makes; the rest wait for the next. */
const CHECKS_PER_RUN = 10;
export type PayState = "creating" | "open" | "paid" | "failed" | "closed" | "error";

interface PayRow {
  readonly id: string;
  readonly connectorId: string;
  readonly kind: string;
  readonly itemId: string;
  readonly amount: number;
  readonly currency: string;
  readonly livemode: boolean;
  readonly state: PayState;
  readonly externalId: string | null;
  readonly url: string | null;
  readonly paymentId: string | null;
  readonly method: string | null;
  readonly paidAmount: number | null;
  readonly paidCurrency: string | null;
  readonly dashboardUrl: string | null;
  readonly claimUntil: number | null;
  readonly claimedBy: string | null;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly checkedAt: number | null;
  readonly lastError: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly paidAt: number | null;
  readonly closedAt: number | null;
}

const COLUMNS =
  "id, connector_id, kind, item_id, amount, currency, livemode, state, external_id, url, payment_id, method, paid_amount, paid_currency, dashboard_url, claim_until, claimed_by, attempts, retry_at, checked_at, last_error, note, created_at, paid_at, closed_at";

function rowOf(r: readonly unknown[]): PayRow {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r[0]),
    connectorId: String(r[1]),
    kind: String(r[2]),
    itemId: String(r[3]),
    amount: Number(r[4]),
    currency: String(r[5]),
    livemode: Number(r[6]) === 1,
    state: String(r[7]) as PayState,
    externalId: s(r[8]),
    url: s(r[9]),
    paymentId: s(r[10]),
    method: s(r[11]),
    paidAmount: n(r[12]),
    paidCurrency: s(r[13]),
    dashboardUrl: s(r[14]),
    claimUntil: n(r[15]),
    claimedBy: s(r[16]),
    attempts: Number(r[17] ?? 0),
    retryAt: n(r[18]),
    checkedAt: n(r[19]),
    lastError: s(r[20]),
    note: s(r[21]),
    createdAt: Number(r[22]),
    paidAt: n(r[23]),
    closedAt: n(r[24]),
  };
}

/** A payment connection as the payments side needs it: open, with what it is for. */
export interface PayConnection {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly mode: "live" | "test";
  readonly status: string;
  readonly payOn: boolean;
  readonly payments: PaymentsHandler;
  readonly ctx: RunContext;
}

/** What the payments side asks of the connections it works for. */
export interface PayHost {
  readonly db: Db;
  /** Every connection that takes payments, opened; a connection whose secrets do not open is left out. */
  payConnections(now: number): Promise<PayConnection[]>;
  /** One connection, opened, whatever its state (a paused one still hears of what was paid). */
  payConnection(id: string, now: number): Promise<PayConnection | null>;
  /** A connection failed in a way the owner must fix (a key withdrawn): said on its tile, and told once. */
  failed(connectorId: string, error: ConnectorError, now: number): Promise<void>;
  /** The connection works again. */
  worked(connectorId: string, now: number): Promise<void>;
}

/** One link as the owner app shows it: never a secret, and nothing about the customer. */
export interface PaymentView {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly state: PayState;
  readonly amount: Money;
  readonly url: string | null;
  readonly livemode: boolean;
  readonly paid_at: number | null;
  readonly paid_amount: Money | null;
  readonly method: string | null;
  /** The payment in the business's dashboard: where it is refunded. */
  readonly dashboard_url: string | null;
  readonly error: string | null;
  readonly note: string | null;
  readonly created_at: number;
  readonly closed_at: number | null;
}

const PROVIDER: Readonly<Record<string, string>> = { stripe: "Stripe", mollie: "Mollie" };
const providerOf = (kind: string) => PROVIDER[kind] ?? kind;

/** The words on the platform's page, in the customer's language. */
const PAGE_WORDS: Readonly<
  Record<"en" | "pt", { order: string; thanks: (b: string, ref: string) => string; inactive: (b: string) => string }>
> = {
  en: {
    order: "Order",
    thanks: (b, ref) => `Thank you. ${b} will confirm your payment for order ${ref} by email.`,
    inactive: (b) => `This payment link is no longer in use. ${b} has sent you the latest by email.`,
  },
  pt: {
    order: "Encomenda",
    thanks: (b, ref) => `Obrigado. ${b} vai confirmar o seu pagamento da encomenda ${ref} por email.`,
    inactive: (b) => `Este link de pagamento já não está em uso. ${b} enviou-lhe o mais recente por email.`,
  },
};

export class PaymentLinks {
  constructor(private readonly host: PayHost) {}

  private get db(): Db {
    return this.host.db;
  }

  /* --- the owner's view ------------------------------------------------------ */

  async forItem(itemId: string): Promise<PaymentView[]> {
    const { rows } = await this.db.client.query({
      // Newest first: by when each was made, then as written (rowid), since two can share a millisecond.
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      params: [itemId],
      method: "all",
    });
    return rows.map(rowOf).map(viewOf);
  }

  /** Counts for a connection's tile: links waiting, paid, and the last one paid. */
  async counts(
    connectorId: string,
  ): Promise<{ open: number; paid: number; failing: number; lastPaidAt: number | null }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END), SUM(CASE WHEN state = 'paid' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN state IN ('creating', 'error') AND last_error IS NOT NULL THEN 1 ELSE 0 END), MAX(paid_at)
              FROM connector_payments WHERE connector_id = ?`,
      params: [connectorId],
      method: "all",
    });
    const r = rows[0] ?? [];
    return {
      open: Number(r[0] ?? 0),
      paid: Number(r[1] ?? 0),
      failing: Number(r[2] ?? 0),
      lastPaidAt: r[3] === null || r[3] === undefined ? null : Number(r[3]),
    };
  }

  /* --- making, keeping and closing an order's link ---------------------------- */

  /**
   * Makes the order's link match the order: one for what it comes to now while it waits to be paid,
   * none otherwise. Called by the job every order event queues. Answers what it did, for the job's
   * note; throws only on our own bugs.
   */
  async ensure(itemId: string, now: number, depth = 0): Promise<string> {
    const note = await this.ensureOnce(itemId, now, depth);
    // Another job holds the link: this one looks again once that claim has run out, so a change made
    // while the link was being made is never left behind.
    if (note.startsWith("held")) {
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${itemId}:held:${Math.floor((now + CLAIM_MS) / 60_000)}`, {
        now,
        runAt: now + CLAIM_MS + 1_000,
        payload: { itemId },
      });
    }
    return note;
  }

  private async ensureOnce(itemId: string, now: number, depth: number): Promise<string> {
    const order = await this.order(itemId);
    if (!order) return "not an order";
    const rows = await this.rowsFor(itemId);
    const live = rows.find((r) => r.state === "creating" || r.state === "open") ?? null;
    const connections = (await this.host.payConnections(now)).filter((c) => c.status !== "disabled" && c.payOn);
    const conn = connections.find((c) => c.mode === (order.sandbox ? "test" : "live")) ?? null;
    const ours = new Set(rows.map((r) => r.url).filter((u): u is string => u !== null));
    // The owner set a link of their own: it is theirs, and ours goes.
    const foreign = order.paymentUrl !== null && !ours.has(order.paymentUrl);
    const want =
      WANTS_LINK.has(order.state) && order.total.value > 0 && !order.legacy && !foreign && !order.paid
        ? order.total
        : null;

    if (!want) {
      if (live) {
        const why = foreign
          ? "the owner gave the order a payment link of their own"
          : order.paid
            ? "the order was paid"
            : `the order is ${order.state.replaceAll("_", " ")}`;
        return this.close(live, why, now);
      }
      return "nothing to do";
    }
    if (!conn) {
      // Nothing takes this order (paused, pay links off, or only a key of the other mode): a link already
      // made keeps working, and none is made.
      return order.sandbox ? "no test-mode payment connection" : "no live payment connection";
    }
    if (live) {
      const same = live.connectorId === conn.id && live.amount === want.value && live.currency === want.currency;
      if (same && live.state === "open") return this.request(order, live, conn, now);
      if (same && live.state === "creating") return this.make(order, live, conn, now, depth);
      const closed = await this.close(
        live,
        live.connectorId === conn.id ? "the order's total changed" : "another payment account took over",
        now,
      );
      if (closed === "held") return "held";
    }
    // A new link: the row first, under the one-live-link index, then the platform.
    const id = ulid(now);
    const token = randomToken(12);
    const inserted = await this.db.client.query({
      sql: `INSERT OR IGNORE INTO connector_payments
              (id, connector_id, kind, item_id, amount, currency, livemode, state, claim_until, claimed_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?)`,
      params: [
        id,
        conn.id,
        conn.kind,
        itemId,
        want.value,
        want.currency,
        conn.mode === "live" ? 1 : 0,
        now + CLAIM_MS,
        token,
        now,
        now,
      ],
      method: "run",
    });
    if (inserted.changes !== 1) return "held: another job is making this order's link";
    const row = await this.row(id);
    if (!row) return "held";
    return this.make(order, row, conn, now, depth, token);
  }

  /**
   * Asks the platform for the link, under the row's claim. `token` is the claim the caller already
   * holds (a row it just made); otherwise one is taken here, from a job whose claim ran out.
   */
  private async make(
    order: OrderFacts,
    row: PayRow,
    conn: PayConnection,
    now: number,
    depth: number,
    held?: string,
  ): Promise<string> {
    let token = held;
    if (!token) {
      if (row.retryAt !== null && row.retryAt > now) return `waits until ${new Date(row.retryAt).toISOString()}`;
      token = randomToken(12);
      const claimed = await this.db.client.query({
        sql: `UPDATE connector_payments SET claim_until = ?, claimed_by = ?, updated_at = ?
               WHERE id = ? AND state = 'creating' AND (claim_until IS NULL OR claim_until < ?)`,
        params: [now + CLAIM_MS, token, now, row.id, now],
        method: "run",
      });
      if (claimed.changes !== 1) return "held: another job is making this order's link";
    }
    const settings = await readSettings(this.db);
    const facts = await businessFacts(this.db, settings);
    const lang = customerLang(order.locale, facts.languages) === "pt" ? "pt" : "en";
    const words = PAGE_WORDS[lang];
    const reference = shortRef(order.id);
    const business = oneLine(facts.name) || "We";
    const named = oneLine(order.subject);
    const title = (named ? `${named} (${reference})` : `${words.order} ${reference}`).slice(0, 250);
    const hookUrl = conn.ctx.hookUrl ? `${conn.ctx.hookUrl}?ref=${encodeURIComponent(row.id)}` : "";
    try {
      if (!conn.ctx.hookUrl) {
        throw new ConnectorError(
          "config",
          "This inbox does not know its own public https address (INBOX_PUBLIC_URL, or the Inbox address in Settings), so the payment platform could not tell it of payments.",
        );
      }
      const link = await conn.payments.createLink(conn.ctx, {
        ref: row.id,
        itemId: order.id,
        amount: { value: row.amount, currency: row.currency },
        title,
        reference,
        language: lang,
        thanks: words.thanks(business, reference),
        inactive: words.inactive(business),
        hookUrl,
      });
      const kept = await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'open', external_id = ?, url = ?, claim_until = NULL, claimed_by = NULL,
                     attempts = attempts + 1, retry_at = NULL, last_error = NULL, last_error_at = NULL, checked_at = ?, updated_at = ?
               WHERE id = ? AND claimed_by = ? AND state = 'creating'`,
        params: [link.externalId, link.url, now, now, row.id, token],
        method: "run",
      });
      if (kept.changes !== 1) return "lost: another job took over this link";
      await this.host.worked(conn.id, now);
      // The order may have changed while the platform answered: it is looked at again, once, as it is now.
      if (depth >= 1) {
        const fresh = await this.row(row.id);
        return fresh ? this.request(await this.order(order.id), fresh, conn, now) : "gone";
      }
      return `made a ${providerOf(conn.kind)} link; ${await this.ensureOnce(order.id, now, depth + 1)}`;
    } catch (error) {
      if (!(error instanceof ConnectorError)) {
        await this.releaseClaim(
          row.id,
          token,
          `unexpected: ${String((error as Error)?.message ?? error)}`,
          now + 600_000,
          now,
        );
        throw error;
      }
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || error.code === "config" || error.code === "refused";
      if (error.code === "auth" || error.code === "config") await this.host.failed(conn.id, error, now);
      if (giveUp) {
        await this.db.client.query({
          sql: `UPDATE connector_payments SET state = 'error', claim_until = NULL, claimed_by = NULL, attempts = ?,
                       last_error = ?, last_error_at = ?, closed_at = ?, updated_at = ?
                 WHERE id = ? AND claimed_by = ?`,
          params: [attempts, error.message.slice(0, 500), now, now, now, row.id, token],
          method: "run",
        });
        await this.notice(row.id, "link_failed", now);
        return `given up: ${error.message}`;
      }
      const retryAt = now + (error.retryAfterMs ?? retryDelay(attempts));
      await this.releaseClaim(row.id, token, error.message, retryAt, now, attempts);
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${order.id}:retry:${attempts}`, {
        now,
        runAt: retryAt,
        payload: { itemId: order.id },
      });
      return `failed, tried again at ${new Date(retryAt).toISOString()}: ${error.message}`;
    }
  }

  private async releaseClaim(
    id: string,
    token: string,
    message: string,
    retryAt: number,
    now: number,
    attempts?: number,
  ): Promise<void> {
    await this.db.client.query({
      sql: `UPDATE connector_payments SET claim_until = NULL, claimed_by = NULL, attempts = COALESCE(?, attempts + 1),
                   last_error = ?, last_error_at = ?, retry_at = ?, updated_at = ?
             WHERE id = ? AND claimed_by = ?`,
      params: [attempts ?? null, message.slice(0, 500), now, retryAt, now, id, token],
      method: "run",
    });
  }

  /**
   * The order is asked to pay at the link: from accepted, or again when it waits with another link (or
   * none), or after a payment failed. Once per link: a retry of the job is answered, not repeated.
   */
  private async request(order: OrderFacts | null, row: PayRow, conn: PayConnection, now: number): Promise<string> {
    if (!order || !row.url) return "gone";
    if (!WANTS_LINK.has(order.state)) return `not asked: the order is ${order.state}`;
    if (order.state === "awaiting_payment" && order.paymentUrl === row.url) return "link open, already asked";
    try {
      await transitionItem(this.db, connectorCaller(conn.id, now, `paylink:${row.id}`), {
        itemId: order.id,
        event: "request_payment",
        input: { paymentUrl: row.url },
      });
      return `asked to pay at the ${providerOf(conn.kind)} link`;
    } catch (error) {
      // The order moved on while the link was being made (cancelled, paid by hand): the next event's
      // job closes the link. Anything else is ours to look at.
      if (error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed")) {
        return `not asked: ${error.message}`;
      }
      throw error;
    }
  }

  /**
   * Stops a link taking payments. Closed here at once, so a new link can be made; when the platform
   * cannot be told now, it is told by the next reconciliation (`retry_at` on a closed row).
   */
  private async close(row: PayRow, why: string, now: number): Promise<string> {
    if (row.state === "creating" && row.claimUntil !== null && row.claimUntil > now) return "held";
    const done = await this.db.client.query({
      sql: `UPDATE connector_payments SET state = 'closed', closed_at = ?, note = ?, claim_until = NULL, claimed_by = NULL,
                   retry_at = CASE WHEN external_id IS NULL THEN NULL ELSE ? END, updated_at = ?
             WHERE id = ? AND state IN ('creating', 'open')`,
      params: [now, why.slice(0, 200), now, now, row.id],
      method: "run",
    });
    if (done.changes !== 1) return "already closed";
    if (!row.externalId) return `closed: ${why}`;
    const told = await this.tellClosed(row, now);
    return `closed: ${why}${told ? "" : "; the platform is told later"}`;
  }

  /** Tells the platform a closed link takes no more payments. True once it is done (or nothing is left to do). */
  private async tellClosed(row: PayRow, now: number): Promise<boolean> {
    if (!row.externalId) return true;
    const conn = await this.host.payConnection(row.connectorId, now);
    if (!conn) {
      // The connection is gone: nothing can be told, and nothing more is tried.
      await this.clearRetry(row.id, now);
      return true;
    }
    try {
      await conn.payments.closeLink(conn.ctx, { externalId: row.externalId });
      await this.clearRetry(row.id, now);
      return true;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "not_found") {
        await this.clearRetry(row.id, now);
        return true;
      }
      const message = error instanceof ConnectorError ? error.message : String((error as Error)?.message ?? error);
      await this.db.client.query({
        sql: `UPDATE connector_payments SET retry_at = ?, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?`,
        params: [now + retryDelay(row.attempts + 1), message.slice(0, 500), now, now, row.id],
        method: "run",
      });
      if (!(error instanceof ConnectorError)) throw error;
      return false;
    }
  }

  private async clearRetry(id: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE connector_payments SET retry_at = NULL, updated_at = ? WHERE id = ?",
      params: [now, id],
      method: "run",
    });
  }

  /* --- what the platform says -------------------------------------------------- */

  /**
   * A request a platform sent to `POST /v1/hooks/<kind>`. A request naming one of our links (`ref`,
   * Mollie's per-link webhook) is handed to that link's connection only; any other to each connection
   * of the kind until one's signature checks out. Answers the HTTP status to send back: 200 when it
   * was read (or is not ours), 400 when no signature checked out, 503 when the platform could not be
   * asked back (the platform sends it again).
   */
  async receive(
    kind: string,
    request: InboundRequest,
    now: number,
  ): Promise<{ readonly status: 200 | 400 | 404 | 503; readonly body: Record<string, unknown> }> {
    const ref = request.query.get("ref");
    let candidates: PayConnection[];
    if (ref) {
      const row = await this.row(ref);
      if (!row || row.kind !== kind)
        return { status: 200, body: { ok: true, handled: 0, note: "not a link of this inbox" } };
      const conn = await this.host.payConnection(row.connectorId, now);
      if (!conn) return { status: 200, body: { ok: true, handled: 0, note: "that connection is gone" } };
      candidates = [conn];
    } else {
      candidates = (await this.host.payConnections(now)).filter((c) => c.kind === kind);
      if (candidates.length === 0)
        return { status: 404, body: { error: "not_found", detail: `Nothing here takes ${kind}.` } };
    }
    const lookup = async (r: string): Promise<KnownLink | null> => {
      const row = await this.row(r);
      return row && row.kind === kind ? { ref: row.id, externalId: row.externalId, itemId: row.itemId } : null;
    };
    let refused = 0;
    for (const conn of candidates) {
      let result: Awaited<ReturnType<PaymentsHandler["receive"]>>;
      try {
        result = await conn.payments.receive(conn.ctx, request, lookup);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "refused") {
          refused++;
          continue;
        }
        if (error instanceof ConnectorError) {
          // The platform could not be asked back (or no longer takes the key): it sends the request
          // again later, and a withdrawn key is said on the connection.
          if (error.code === "auth") await this.host.failed(conn.id, error, now);
          return { status: 503, body: { error: "unavailable", detail: error.message } };
        }
        throw error;
      }
      if (!result) return { status: 200, body: { ok: true, handled: 0 } };
      const seen = await this.db.client.query({
        sql: `INSERT OR IGNORE INTO connector_events (id, connector_id, external_id, topic, received_at, status, raw)
              VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        params: [
          ulid(now),
          conn.id,
          result.eventId.slice(0, 200),
          result.topic.slice(0, 100),
          now,
          // What was read back, never the body: a platform's event carries the customer's details.
          JSON.stringify(result.facts.map((f) => ({ ...f, dashboardUrl: undefined }))),
        ],
        method: "run",
      });
      let handled = 0;
      let itemId: string | null = null;
      for (const fact of result.facts) {
        const applied = await this.apply(conn, fact, now);
        if (applied.itemId) itemId = applied.itemId;
        if (applied.done) handled++;
      }
      await this.db.client.query({
        sql: `UPDATE connector_events SET status = ?, item_id = COALESCE(?, item_id), handled_at = ?
               WHERE connector_id = ? AND external_id = ?`,
        params: [handled > 0 ? "handled" : "ignored", itemId, now, conn.id, result.eventId.slice(0, 200)],
        method: "run",
      });
      return { status: 200, body: { ok: true, handled, duplicate: seen.changes === 0 } };
    }
    return refused > 0
      ? { status: 400, body: { error: "bad_signature", detail: "The signature does not check out." } }
      : { status: 200, body: { ok: true, handled: 0 } };
  }

  /**
   * What the platform confirmed, applied once: the link marked paid (a compare-and-set, so a request
   * sent twice, or a webhook and a reconciliation that meet, record it once), then the order. A
   * payment that cannot go on the order (it was cancelled, or paid already) is kept on the link and
   * the owner told where to refund it.
   */
  async apply(conn: PayConnection, fact: PaymentFact, now: number): Promise<{ done: boolean; itemId: string | null }> {
    const row =
      (fact.linkId ? await this.rowByExternal(conn.id, fact.linkId) : null) ??
      (fact.ref ? await this.row(fact.ref) : null);
    if (!row || row.connectorId !== conn.id) return { done: false, itemId: null };
    // A test payment never pays a real order, nor a live one a test.
    if (fact.livemode !== row.livemode) return { done: false, itemId: row.itemId };
    if (fact.status === "pending") return { done: false, itemId: row.itemId };
    if (fact.status === "failed") return this.failed(conn, row, fact, now);
    const paid = await this.db.client.query({
      sql: `UPDATE connector_payments SET state = 'paid', payment_id = ?, method = ?, paid_amount = ?, paid_currency = ?,
                   dashboard_url = ?, paid_at = ?, claim_until = NULL, claimed_by = NULL, retry_at = NULL, checked_at = ?, updated_at = ?
             WHERE id = ? AND state <> 'paid'`,
      params: [
        fact.paymentId.slice(0, 200),
        fact.method?.slice(0, 40) ?? null,
        fact.amount?.value ?? null,
        fact.amount?.currency ?? null,
        fact.dashboardUrl?.slice(0, 500) ?? null,
        fact.paidAt ?? now,
        now,
        now,
        row.id,
      ],
      method: "run",
    });
    if (paid.changes !== 1) return { done: false, itemId: row.itemId };
    const order = await this.order(row.itemId);
    const amount = fact.amount ?? { value: row.amount, currency: row.currency };
    if (!order || !WANTS_LINK.has(order.state) || order.paid) {
      const why = !order
        ? "the order is gone"
        : order.paid || order.state === "paid" || order.state === "fulfilling" || order.state === "fulfilled"
          ? "the order was paid already"
          : `the order is ${order.state.replaceAll("_", " ")}`;
      await this.db.client.query({
        sql: "UPDATE connector_payments SET note = ?, updated_at = ? WHERE id = ?",
        params: [`paid after ${why}: refund it in ${providerOf(row.kind)} if it is not wanted`, now, row.id],
        method: "run",
      });
      await this.notice(row.id, order?.paid ? "paid_twice" : "paid_after", now);
      return { done: true, itemId: row.itemId };
    }
    try {
      await transitionItem(this.db, connectorCaller(conn.id, now, `paid:${row.id}`), {
        itemId: row.itemId,
        event: "record_payment",
        input: {
          paymentRef: fact.paymentId.slice(0, 200),
          amount,
          ...(fact.method ? { method: fact.method.slice(0, 40) } : {}),
        },
      });
    } catch (error) {
      // The row says paid, the order does not: the row is put back, so the platform's next word (or the
      // next reconciliation) records it, and the error is ours to read.
      await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'open', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND state = 'paid'`,
        params: [`not recorded: ${String((error as Error)?.message ?? error)}`.slice(0, 500), now, now, row.id],
        method: "run",
      });
      throw error;
    }
    if (amount.value !== order.total.value || amount.currency !== order.total.currency) {
      await this.notice(row.id, "amount_differs", now);
    }
    return { done: true, itemId: row.itemId };
  }

  /** A payment that did not go through on a link that is now spent: the order says so, and a new link follows. */
  private async failed(
    conn: PayConnection,
    row: PayRow,
    fact: PaymentFact,
    now: number,
  ): Promise<{ done: boolean; itemId: string | null }> {
    const spent = await this.db.client.query({
      sql: `UPDATE connector_payments SET state = 'failed', payment_id = ?, closed_at = ?, note = ?, updated_at = ?
             WHERE id = ? AND state IN ('open', 'creating')`,
      params: [fact.paymentId.slice(0, 200), now, "the payment did not go through", now, row.id],
      method: "run",
    });
    if (spent.changes !== 1) return { done: false, itemId: row.itemId };
    // A spent link is switched off too, so the customer cannot pay both it and the new one.
    await this.tellClosed(row, now);
    const order = await this.order(row.itemId);
    if (order?.state === "awaiting_payment" && order.paymentUrl === row.url) {
      try {
        await transitionItem(this.db, connectorCaller(conn.id, now, `failed:${row.id}`), {
          itemId: row.itemId,
          event: "payment_failed",
          input: { note: "The payment did not go through." },
        });
      } catch (error) {
        if (!(error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed")))
          throw error;
      }
    }
    // A new link is made straight away; the email about the failure waits for it (PAY_LINK_GRACE_MS).
    await ensureJob(this.db, PAY_LINK_KIND, `paylink:${row.itemId}:after-failure:${row.id}`, {
      now,
      payload: { itemId: row.itemId },
    });
    return { done: true, itemId: row.itemId };
  }

  /* --- the regular look ----------------------------------------------------------- */

  /**
   * What a webhook may have missed, for one connection, run with its five-minute sync: links still to
   * be closed on the platform, links whose making stopped half way, and open links asked about now and
   * then (often at first, then less: 10 minutes for two hours, hourly for two days, twice a day for
   * a fortnight, then no more), within a budget of calls.
   */
  async reconcile(conn: PayConnection, now: number): Promise<{ checked: number; paid: number; closed: number }> {
    let calls = 0;
    let paid = 0;
    let closed = 0;
    const { rows: closing } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments
             WHERE connector_id = ? AND state IN ('closed', 'failed') AND retry_at IS NOT NULL AND retry_at <= ? AND external_id IS NOT NULL
             ORDER BY retry_at LIMIT ?`,
      params: [conn.id, now, CHECKS_PER_RUN],
      method: "all",
    });
    for (const r of closing.map(rowOf)) {
      if (calls >= CHECKS_PER_RUN) break;
      calls++;
      if (await this.tellClosed(r, now)) closed++;
    }
    const { rows: stuck } = await this.db.client.query({
      sql: `SELECT item_id FROM connector_payments
             WHERE connector_id = ? AND state = 'creating' AND (claim_until IS NULL OR claim_until < ?)
               AND (retry_at IS NULL OR retry_at <= ?) LIMIT 5`,
      params: [conn.id, now, now],
      method: "all",
    });
    for (const r of stuck) {
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${String(r[0])}:resume:${Math.floor(now / 300_000)}`, {
        now,
        payload: { itemId: String(r[0]) },
      });
    }
    const { rows: open } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments
             WHERE connector_id = ? AND state = 'open' AND external_id IS NOT NULL
             ORDER BY COALESCE(checked_at, 0) LIMIT 50`,
      params: [conn.id],
      method: "all",
    });
    for (const r of open.map(rowOf)) {
      if (calls >= CHECKS_PER_RUN) break;
      const every = checkEvery(now - r.createdAt);
      if (every === null || (r.checkedAt !== null && now - r.checkedAt < every)) continue;
      calls++;
      try {
        const fact = await conn.payments.check(conn.ctx, { ref: r.id, externalId: r.externalId, itemId: r.itemId });
        await this.db.client.query({
          sql: "UPDATE connector_payments SET checked_at = ?, updated_at = ? WHERE id = ?",
          params: [now, now, r.id],
          method: "run",
        });
        if (fact && fact.status !== "pending") {
          const applied = await this.apply(conn, fact, now);
          if (applied.done && fact.status === "paid") paid++;
        }
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        if (error.code === "auth") {
          await this.host.failed(conn.id, error, now);
          break;
        }
        await this.db.client.query({
          sql: "UPDATE connector_payments SET checked_at = ?, updated_at = ? WHERE id = ?",
          params: [now, now, r.id],
          method: "run",
        });
      }
    }
    return { checked: calls, paid, closed };
  }

  /**
   * Disconnecting: every link still open is closed on the platform (best effort), since nothing here
   * would hear of a payment made on it any more. Paid links stay, as the record of where money went.
   */
  async closeAll(connectorId: string, now: number): Promise<number> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE connector_id = ? AND state IN ('creating', 'open')`,
      params: [connectorId],
      method: "all",
    });
    const live = rows.map(rowOf);
    const conn = await this.host.payConnection(connectorId, now);
    for (const r of live) {
      if (conn && r.externalId) {
        try {
          await conn.payments.closeLink(conn.ctx, { externalId: r.externalId });
        } catch {
          // A courtesy to the platform: the connection goes either way, and the owner was told the links stop.
        }
      }
    }
    await this.db.client.query({
      sql: `UPDATE connector_payments SET state = 'closed', closed_at = ?, retry_at = NULL, claim_until = NULL, claimed_by = NULL,
                   note = 'the payment platform was disconnected', updated_at = ?
             WHERE connector_id = ? AND state IN ('creating', 'open')`,
      params: [now, now, connectorId],
      method: "run",
    });
    return live.length;
  }

  /* --- telling the owner -------------------------------------------------------- */

  /** One email to the owner about one link, once per reason. */
  private async notice(rowId: string, reason: PayNoticeReason, now: number): Promise<void> {
    await this.db.batch([
      jobStatement(PAY_NOTICE_KIND, { payId: rowId, reason }, now, { dedupeKey: `paynotice:${rowId}:${reason}` }),
    ]);
  }

  /** The words of a notice, or null when it no longer applies. */
  async noticeText(
    rowId: string,
    reason: PayNoticeReason,
    appUrl: string,
  ): Promise<{ readonly subject: string; readonly text: string; readonly itemId: string } | null> {
    const row = await this.row(rowId);
    if (!row) return null;
    const provider = providerOf(row.kind);
    const ref = shortRef(row.itemId);
    const open = appUrl ? `${appUrl.replace(/\/+$/, "")}/items/${row.itemId}` : "";
    const money = (value: number | null, currency: string | null) =>
      value === null || currency === null ? "" : moneyIn({ value, currency }, "en");
    const refund = row.dashboardUrl
      ? `Refund it in ${provider}: ${row.dashboardUrl}`
      : `Refund it in your ${provider} dashboard.`;
    switch (reason) {
      case "paid_after": {
        const order = await this.order(row.itemId);
        const state = order ? (STATE_WORDS[order.state] ?? order.state.replaceAll("_", " ")) : "gone";
        return {
          itemId: row.itemId,
          subject: `A payment for order ${ref} needs you`,
          text: [
            `The customer paid ${money(row.paidAmount, row.paidCurrency)} for order ${ref} through ${provider}, but the order was ${state} by then, so it is not marked paid here.`,
            "",
            "The money is in your account. If it should not be, refund it there.",
            refund,
            ...(open ? ["", `The order: ${open}`] : []),
          ].join("\n"),
        };
      }
      case "paid_twice":
        return {
          itemId: row.itemId,
          subject: `Order ${ref} was paid twice`,
          text: [
            `A second payment of ${money(row.paidAmount, row.paidCurrency)} arrived for order ${ref} through ${provider}. The order was paid already.`,
            "",
            refund,
            ...(open ? ["", `The order: ${open}`] : []),
          ].join("\n"),
        };
      case "amount_differs": {
        const order = await this.order(row.itemId);
        return {
          itemId: row.itemId,
          subject: `Order ${ref} was paid a different amount`,
          text: [
            `Order ${ref} was paid ${money(row.paidAmount, row.paidCurrency)} through ${provider}, but it comes to ${order ? moneyIn(order.total, "en") : "another amount"}. It is marked paid with what was paid: settle the difference with the customer.`,
            ...(row.dashboardUrl ? ["", `The payment: ${row.dashboardUrl}`] : []),
            ...(open ? ["", `The order: ${open}`] : []),
          ].join("\n"),
        };
      }
      case "link_failed":
        if (row.state !== "error") return null;
        return {
          itemId: row.itemId,
          subject: `Order ${ref} has no payment link`,
          text: [
            `${provider} did not make a payment link for order ${ref}${row.lastError ? `: ${row.lastError}` : "."}`,
            "",
            `Ask for payment from the order in your inbox${open ? `: ${open}` : ""}, or connect ${provider} again in Settings → Integrations.`,
          ].join("\n"),
        };
    }
  }

  /* --- rows ----------------------------------------------------------------------- */

  private async row(id: string): Promise<PayRow | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE id = ?`,
      params: [id],
      method: "all",
    });
    return rows[0] ? rowOf(rows[0]) : null;
  }

  private async rowByExternal(connectorId: string, externalId: string): Promise<PayRow | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE connector_id = ? AND external_id = ?`,
      params: [connectorId, externalId],
      method: "all",
    });
    return rows[0] ? rowOf(rows[0]) : null;
  }

  private async rowsFor(itemId: string): Promise<PayRow[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE item_id = ? ORDER BY created_at, rowid`,
      params: [itemId],
      method: "all",
    });
    return rows.map(rowOf);
  }

  private async order(itemId: string): Promise<OrderFacts | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT i.id, i.state, i.payload, i.sandbox, i.legacy_promise, i.subject, p.contact
              FROM items i LEFT JOIN parties p ON p.id = i.party_id
             WHERE i.id = ? AND i.type = 'order'`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const payload = parseJson(r[2]) as {
      totalPrice?: { value?: unknown; currency?: unknown };
      paymentUrl?: unknown;
      paymentRef?: unknown;
      orderedItem?: { name?: unknown }[];
    };
    const contact = parseJson(r[6]) as { locale?: unknown } | null;
    const value = Number(payload.totalPrice?.value ?? 0);
    const state = String(r[1]);
    return {
      id: String(r[0]),
      state,
      total: {
        value: Number.isInteger(value) && value > 0 ? value : 0,
        currency: String(payload.totalPrice?.currency ?? "EUR").toUpperCase(),
      },
      paymentUrl: typeof payload.paymentUrl === "string" ? payload.paymentUrl : null,
      // Paid already: a payment recorded on it (by hand, or by another link).
      paid: typeof payload.paymentRef === "string" && ["paid", "fulfilling", "fulfilled", "completed"].includes(state),
      sandbox: Number(r[3] ?? 0) === 1,
      legacy: Number(r[4] ?? 0) === 1,
      subject: subjectIn({ type: "order", subject: r[5] === null ? null : String(r[5]), payload } as never, "en"),
      locale: typeof contact?.locale === "string" ? contact.locale : null,
    };
  }
}

interface OrderFacts {
  readonly id: string;
  readonly state: string;
  readonly total: Money;
  readonly paymentUrl: string | null;
  readonly paid: boolean;
  readonly sandbox: boolean;
  readonly legacy: boolean;
  readonly subject: string;
  readonly locale: string | null;
}

export type PayNoticeReason = "paid_after" | "paid_twice" | "amount_differs" | "link_failed";

/** An order's state, as the owner's email says it. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  cancelled: "cancelled",
  declined: "declined",
  expired: "expired",
  fulfilling: "being prepared",
  fulfilled: "marked fulfilled",
  completed: "completed",
  charged_back: "charged back",
};

/** The connector as the history records it: what moved the order, and the idempotency key that keeps it once. */
export function connectorCaller(connectorId: string, now: number, key?: string): Caller {
  return {
    actor: { kind: "connector", id: `connector:${connectorId}`, channel: "connector" },
    tier: "verified_principal",
    sandbox: false,
    now: () => now,
    ...(key ? { idempotency: { scope: `connector:${connectorId}`, key } } : {}),
  };
}

function viewOf(r: PayRow): PaymentView {
  return {
    id: r.id,
    kind: r.kind,
    provider: providerOf(r.kind),
    state: r.state,
    amount: { value: r.amount, currency: r.currency },
    url: r.state === "open" ? r.url : r.url && r.state === "paid" ? r.url : null,
    livemode: r.livemode,
    paid_at: r.paidAt,
    paid_amount:
      r.paidAmount !== null && r.paidCurrency !== null ? { value: r.paidAmount, currency: r.paidCurrency } : null,
    method: r.method,
    dashboard_url: r.dashboardUrl,
    error: r.state === "creating" || r.state === "error" ? r.lastError : null,
    note: r.note,
    created_at: r.createdAt,
    closed_at: r.closedAt,
  };
}

/** Five minutes doubling, at most six hours. */
function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(attempts - 1, 0), 6 * 3_600_000);
}

/** How often an open link is asked about, by its age; null once it is old enough to be left. */
function checkEvery(ageMs: number): number | null {
  const h = 3_600_000;
  if (ageMs < 10 * 60_000) return null;
  if (ageMs < 2 * h) return 10 * 60_000;
  if (ageMs < 48 * h) return h;
  if (ageMs < 15 * 24 * h) return 12 * h;
  return null;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
