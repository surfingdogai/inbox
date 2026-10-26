import { businessFacts } from "../customer/audience";
import { moreLines } from "../customer/describe";
import { moneyIn, oneLine, shortRef } from "../customer/format";
import { type CustomerLang, customerLang } from "../customer/lang";
import type { Db } from "../db";
import type { ItemType, Money } from "../domain/types";
import { randomToken, ulid } from "../ids";
import { ensureJob } from "../jobs/schedule";
import { readSettings } from "../settings/schema";
import { isHundredthsCurrency, isWholeUnitCurrency } from "../util/locale";
import type { Caller } from "../write/caller";
import { jobStatement } from "../write/common";
import { WriteError } from "../write/errors";
import { transitionItem } from "../write/transition";
import { SHOP_CHARGES_SKU } from "./catalogue";
import { PAY_LINK_KIND, PAY_NOTICE_KIND } from "./pay-queue";
import { type ScheduledItem, scheduleSourceOf, type WantedLink } from "./schedules";
import {
  ConnectorError,
  type InboundRequest,
  type KnownLink,
  type OrderFact,
  type PayAmount,
  type PaymentFact,
  type PaymentsHandler,
  type PayPurpose,
  type RunContext,
} from "./sdk";
import { shopOrderOf } from "./shop";

/**
 * Getting paid through the business's own account (ADR-023). An order the inbox accepts gets a link
 * to pay in the business's own Stripe or Mollie account; the platform's signed word that it was
 * paid, checked again with the platform, marks it paid; refunds are made where the money is, in the
 * business's own dashboard. The money never passes the inbox, nor Surfing Dog.
 *
 * The rules that shape it:
 * - **One live link per order** (`connector_payments_live`). Two jobs that meet make one, never two,
 *   and only the job that holds a link's claim asks the platform for it.
 * - **Orders the connection is for.** An order accepted once the platform was connected, one the
 *   owner asks to pay without a link of their own, or one that has a link of ours already. An order
 *   accepted before keeps what it had (a business that is paid on delivery is never asked by surprise).
 * - **A link for what the order comes to.** None while a change to it waits for an answer; when the
 *   total changes, the link is closed on the platform and a new one sent; when the order ends
 *   without a payment, it is closed.
 * - **Only money this inbox counts right.** Every amount is in its currency's own minor unit
 *   (ADR-036), converted to the platform's by its adapter from a table with a test per currency; an
 *   order in a currency the platform has no test for (KWD on Stripe) gets no link, and the owner is
 *   told, never a link for a hundred times the order.
 * - **Nothing the request says is believed.** A webhook is checked by its signature (Stripe) or not
 *   at all (Mollie's per-link one carries only an id), and what it is about is always read back from
 *   the platform with the business's own key before anything is marked paid.
 * - **Test keys for test orders, live keys for real ones.** Nobody is asked for real money for a
 *   test, and no real order is marked paid with a test card.
 * - **A payment that cannot be recorded is said, not swallowed**: one paid after the order was
 *   cancelled, paid twice (on two links, or twice on one), is the owner's to refund, and they are
 *   told where.
 * - **A refusal stands until what it was about changes**: a link the platform would not make is not
 *   asked for again on every event, nor told to the owner twice; a new total, connection or currency,
 *   or the owner asking for payment, tries again.
 * - **The owner's own link stays theirs**: an order whose payment link the owner set is left alone.
 * - **A shop's total is the customer's, or nothing is sent** (ADR-030 §2): an order written into the
 *   business's own shop whose total the shop makes another (tax or delivery it adds itself) is held,
 *   never sent, and the owner is offered to propose the shop's total, which the customer accepts or
 *   not. Nobody is ever charged more than they accepted without a word.
 */

/** The order states that want a link: accepted, asked to pay, or a payment that did not go through. */
const WANTS_LINK: ReadonlySet<string> = new Set(["accepted", "awaiting_payment", "payment_failed"]);
/** A link being made is the job's for this long, past the slowest platform answer. */
const CLAIM_MS = 2 * 60_000;
/** Attempts at making one link before it is given up and the owner told. */
const MAX_ATTEMPTS = 8;
/** Platform calls one reconciliation run makes; the rest wait for the next. */
const CHECKS_PER_RUN = 10;
/** A request naming one of our links is read back at most this often: an unsigned nudge cannot make the inbox ask the platform on every POST. */
const NUDGE_EVERY_MS = 15_000;
/** Why a link was not made, for a platform that says nothing of currencies, in one not counted in hundredths. */
const NOT_HUNDREDTHS = "This currency is not counted in hundredths here, so no link was made.";

/**
 * Why no link can be made in this amount's currency on this platform, or null (ADR-036): the
 * platform's own word (`currencyProblem`, a table with a test per currency), or, for one that says
 * nothing of currencies, every currency but those counted in hundredths. A shop or till (`shop`,
 * capability `shop_orders`) also takes a currency with no minor unit (yen, won): it is written there
 * as a decimal in the shop's own currency (`decimalAmount`, "2800"), which is exact (ADR-032).
 */
export function linkCurrencyProblem(payments: PaymentsHandler, amount: Money, shop = false): string | null {
  if (payments.currencyProblem) {
    const why = payments.currencyProblem(amount);
    return why ? `${why.replace(/[.\s]+$/, "")}.` : null;
  }
  if (isHundredthsCurrency(amount.currency)) return null;
  return shop && isWholeUnitCurrency(amount.currency) ? null : NOT_HUNDREDTHS;
}
/** The note on a link closed because its connection was disconnected. */
const DISCONNECTED = "the payment platform was disconnected";
export type PayState = "creating" | "open" | "held" | "paid" | "failed" | "closed" | "error";

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
  /** What a shop said it comes to (ADR-030 §2), when it said. */
  readonly shopTotal: number | null;
  readonly shopCurrency: string | null;
  /** The entry of the item's payment schedule (ADR-036): '' for an order's own link. */
  readonly scheduleId: string;
  readonly purpose: PayPurpose;
  readonly expiresAt: number | null;
}

const COLUMNS =
  "id, connector_id, kind, item_id, amount, currency, livemode, state, external_id, url, payment_id, method, paid_amount, paid_currency, dashboard_url, claim_until, claimed_by, attempts, retry_at, checked_at, last_error, note, created_at, paid_at, closed_at, shop_total, shop_currency, schedule_id, purpose, expires_at";

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
    shopTotal: n(r[25]),
    shopCurrency: s(r[26]),
    scheduleId: String(r[27] ?? ""),
    purpose: (s(r[28]) ?? "pay") as PayPurpose,
    expiresAt: n(r[29]),
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
  /** When it was connected: orders accepted before keep what they had. */
  readonly createdAt: number;
  /** Being disconnected: it makes no new link, and still hears of payments on the ones it made. */
  readonly disconnecting: boolean;
  readonly payments: PaymentsHandler;
  readonly ctx: RunContext;
  /**
   * A shop or till (capability `shop_orders`, ADR-030 §2): its orders are written into it, told the
   * order (`PayLinkRequest.order`), and what it says the order comes to is checked. `source` is where
   * its products come from, so a line names the shop's own product.
   */
  readonly shop?: { readonly source: string } | null | undefined;
  /**
   * Whether it is told of payments only at this inbox's public address (Stripe's, Mollie's webhook):
   * without one, no link is made. A shop read back on every sync needs none.
   */
  readonly needsHookUrl?: boolean | undefined;
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
  /** A platform by name, as the owner knows it ("Stripe", "WooCommerce"): its connector's title. */
  title?(kind: string): string;
}

/** One link as the owner app shows it: never a secret, and nothing about the customer. */
export interface PaymentView {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  /** `held`: made in the shop and not sent, since the shop counts another total (`shop_total`). */
  readonly state: PayState;
  readonly amount: Money;
  /** Where the customer pays, while the link is open; never a link that is closed. */
  readonly url: string | null;
  readonly livemode: boolean;
  readonly paid_at: number | null;
  readonly paid_amount: Money | null;
  /** The platform's id for the payment (`pi_…`, `tr_…`): what a refund made in its dashboard is recorded against. */
  readonly payment_id: string | null;
  readonly method: string | null;
  /** The payment in the business's dashboard: where it is refunded. */
  readonly dashboard_url: string | null;
  readonly error: string | null;
  readonly note: string | null;
  readonly created_at: number;
  readonly closed_at: number | null;
  /**
   * What the shop says the order comes to, when it is not what the customer accepted (ADR-030 §2): the
   * link is held, and `propose` says whether the owner can propose it (it is more; a lower one is for
   * the owner to look into in the shop).
   */
  readonly shop_total: Money | null;
  readonly propose_shop_total: boolean;
}

/** What one notice to the owner is about, as its job carries it. */
export interface PayNotice {
  readonly payId?: string | undefined;
  readonly reason: PayNoticeReason;
  /** A second payment on a link already paid: that payment, not the first. */
  readonly paymentId?: string | undefined;
  readonly amount?: PayAmount | null | undefined;
  readonly dashboardUrl?: string | null | undefined;
  /** A connection disconnected: its platform, the orders left waiting on a closed link, and links not switched off. */
  readonly provider?: string | undefined;
  readonly waiting?: readonly string[] | undefined;
  readonly unclosed?: readonly string[] | undefined;
  readonly dashboard?: string | null | undefined;
}

const PROVIDER: Readonly<Record<string, string>> = { stripe: "Stripe", mollie: "Mollie" };
export const providerOf = (kind: string) => PROVIDER[kind] ?? kind;

/**
 * The words on the platform's page, in the customer's language, true whatever happened: the thanks
 * once they paid (a card or a bank payment still on its way alike), and the line on a link that is
 * closed (paid, the order changed or ended, or the platform was disconnected), which sends them to
 * the business's latest email rather than promising a new link.
 */
const PAGE_WORDS: Readonly<
  Record<
    CustomerLang,
    { order: string; thanks: (ref: string) => string; inactive: (b: string | null, ref: string) => string }
  >
> = {
  en: {
    order: "Order",
    thanks: (ref) => `Thank you for your payment for order ${ref}.`,
    inactive: (b, ref) =>
      `This link to pay is closed. ${b ? `${b}'s latest email` : "Our latest email"} about order ${ref} says what is still to pay, if anything.`,
  },
  pt: {
    order: "Encomenda",
    thanks: (ref) => `Obrigado pelo seu pagamento da encomenda ${ref}.`,
    inactive: (b, ref) =>
      `Este link de pagamento está fechado. ${b ? `O email mais recente de ${b}` : "O nosso email mais recente"} sobre a encomenda ${ref} diz o que falta pagar, se faltar alguma coisa.`,
  },
};

/** The line "Propose the shop's total" adds, in the customer's language: what the shop adds itself. */
const SHOP_CHARGES_NAME: Readonly<Record<CustomerLang, string>> = {
  en: "Tax and charges",
  pt: "Impostos e encargos",
};

export class PaymentLinks {
  constructor(private readonly host: PayHost) {}

  private get db(): Db {
    return this.host.db;
  }

  /** A platform by the name the owner knows it by. */
  private provider(kind: string): string {
    return this.host.title?.(kind) ?? providerOf(kind);
  }

  /* --- the owner's view ------------------------------------------------------ */

  async forItem(itemId: string): Promise<PaymentView[]> {
    const { rows } = await this.db.client.query({
      // Newest first: by when each was made, then as written (rowid), since two can share a millisecond.
      sql: `SELECT ${COLUMNS} FROM connector_payments WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      params: [itemId],
      method: "all",
    });
    return rows.map(rowOf).map((r) => viewOf(r, this.provider(r.kind)));
  }

  /**
   * Why an order that could have a link has none, in one quiet line for the owner, or null: a key of
   * the other mode only, links switched off, accepted before the platform was connected, or a change
   * waiting for an answer. Nothing to say for an order with a link (its row says it), or none to want.
   */
  async whyNone(itemId: string, now: number): Promise<string | null> {
    const order = await this.order(itemId);
    if (!order || !WANTS_LINK.has(order.state) || order.total.value <= 0 || order.legacy || order.paid) return null;
    if (order.paymentUrl !== null) return null;
    if ((await this.rowsFor(itemId)).length > 0) return null;
    const all = (await this.host.payConnections(now)).filter((c) => !c.disconnecting);
    if (all.length === 0) return null;
    const mode = order.sandbox ? "test" : "live";
    const ofMode = all.filter((c) => c.mode === mode);
    if (ofMode.length === 0) {
      const other = all[0] as PayConnection;
      return mode === "live"
        ? `No link: ${this.provider(other.kind)} is connected with a test key, which makes links only for orders made in Test mode.`
        : `No link: ${this.provider(other.kind)} is connected with a live key, which makes links only for real orders.`;
    }
    const conn = ofMode.find((c) => c.payOn && c.status !== "disabled");
    if (!conn) return `No link: links to pay are off for ${this.provider((ofMode[0] as PayConnection).kind)}.`;
    if (order.changeOpen) return "No link yet: a change to the order waits for an answer.";
    if (!(await this.eligible(order, [], conn))) {
      return `No link: the order was accepted before ${this.provider(conn.kind)} was connected. Ask for payment to send one.`;
    }
    return null;
  }

  /** Whether the order's payment link (`payload.paymentUrl`) is one of ours, which the owner app shows as the platform's. */
  async ownsOrderLink(itemId: string): Promise<boolean> {
    const { rows } = await this.db.client.query({
      sql: `SELECT 1 FROM items i JOIN connector_payments p ON p.item_id = i.id AND p.url = json_extract(i.payload, '$.paymentUrl')
             WHERE i.id = ? LIMIT 1`,
      params: [itemId],
      method: "all",
    });
    return rows.length > 0;
  }

  /** Whether the connection has a link waiting to be paid. */
  async hasOpen(connectorId: string): Promise<boolean> {
    const { rows } = await this.db.client.query({
      sql: "SELECT 1 FROM connector_payments WHERE connector_id = ? AND state = 'open' LIMIT 1",
      params: [connectorId],
      method: "all",
    });
    return rows.length > 0;
  }

  /** Counts for a connection's tile: links waiting, paid, orders without one, and links still to switch off. */
  async counts(connectorId: string): Promise<{
    open: number;
    paid: number;
    failing: number;
    closing: number;
    held: number;
    lastPaidAt: number | null;
  }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END), SUM(CASE WHEN state = 'paid' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN state IN ('closed', 'failed') AND retry_at IS NOT NULL AND external_id IS NOT NULL THEN 1 ELSE 0 END),
                   MAX(paid_at), SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END)
              FROM connector_payments WHERE connector_id = ?`,
      params: [connectorId],
      method: "all",
    });
    // Orders, not rows: one that still waits to be paid, whose newest link is one the platform did not
    // make (or is still being tried), with nothing live or paid since.
    const { rows: failing } = await this.db.client.query({
      sql: `SELECT COUNT(DISTINCT p.item_id) FROM connector_payments p JOIN items i ON i.id = p.item_id
             WHERE p.connector_id = ? AND p.state IN ('creating', 'error') AND p.last_error IS NOT NULL
               AND i.state IN ('accepted', 'awaiting_payment', 'payment_failed')
               AND NOT EXISTS (SELECT 1 FROM connector_payments q WHERE q.item_id = p.item_id
                                 AND q.state IN ('open', 'held', 'paid') AND q.created_at >= p.created_at)`,
      params: [connectorId],
      method: "all",
    });
    const r = rows[0] ?? [];
    return {
      open: Number(r[0] ?? 0),
      paid: Number(r[1] ?? 0),
      failing: Number(failing[0]?.[0] ?? 0),
      closing: Number(r[2] ?? 0),
      held: Number(r[4] ?? 0),
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
    // An item paid on a schedule (a stay's deposit and balance): its source says what wants a link.
    if (!order) return this.ensureScheduled(itemId, now);
    const rows = await this.rowsFor(itemId);
    const live = rows.find((r) => r.state === "creating" || r.state === "open" || r.state === "held") ?? null;
    const connections = (await this.host.payConnections(now)).filter(
      (c) => c.status !== "disabled" && c.payOn && !c.disconnecting,
    );
    const conn = connections.find((c) => c.mode === (order.sandbox ? "test" : "live")) ?? null;
    const ours = new Set(rows.map((r) => r.url).filter((u): u is string => u !== null));
    // The owner set a link of their own: it is theirs, and ours goes.
    const foreign = order.paymentUrl !== null && !ours.has(order.paymentUrl);
    // An order paid in a trade's stages (ADR-034 §4) gets no link for the whole: the business asks for each.
    const want =
      WANTS_LINK.has(order.state) && order.total.value > 0 && !order.legacy && !foreign && !order.paid && !order.staged
        ? order.total
        : null;

    if (!want) {
      if (live) {
        const why = foreign
          ? "the owner gave the order a payment link of their own"
          : order.staged
            ? "the order is paid in stages, each asked for by the business"
            : order.paid
              ? "the order was paid"
              : `the order is ${order.state.replaceAll("_", " ")}`;
        return this.close(live, why, now);
      }
      return "nothing to do";
    }
    // What the order comes to is not settled while a change to it waits: its answer queues this again.
    if (order.changeOpen) return "waits for the change";
    if (!conn) {
      // Nothing takes this order (paused, pay links off, or only a key of the other mode): a link already
      // made keeps working, and none is made.
      return order.sandbox ? "no test-mode payment connection" : "no live payment connection";
    }
    if (live) {
      // A link of another connection that is still there keeps working while the order comes to it.
      const other = live.connectorId === conn.id ? conn : await this.host.payConnection(live.connectorId, now);
      const liveConn = other && !other.disconnecting ? other : null;
      const same = live.amount === want.value && live.currency === want.currency && liveConn !== null;
      if (same && liveConn && live.state === "open") return this.request(order, live, liveConn, now);
      if (same && liveConn && live.state === "creating") return this.make(order, live, liveConn, now, depth);
      // Held: the shop counts another total, and the owner decides. A new total (the customer accepted
      // the shop's) closes it below, and a new one is made for it.
      if (same && liveConn && live.state === "held") return "held: the shop counts another total; the owner decides";
      const closed = await this.close(
        live,
        live.connectorId === conn.id ? "the order's total changed" : "another payment account took over",
        now,
      );
      if (closed === "held") return "held";
    } else if (!(await this.eligible(order, rows, conn))) {
      return `not ours: accepted before ${this.provider(conn.kind)} was connected, and not asked to pay since`;
    }
    // A refusal stands until what it was about changes, or the owner asks for payment again.
    const last = rows.at(-1);
    if (
      !live &&
      last?.state === "error" &&
      last.connectorId === conn.id &&
      last.amount === want.value &&
      last.currency === want.currency
    ) {
      const askedAt = (await this.history(order.id)).askedAt;
      if (askedAt === null || askedAt <= last.createdAt) {
        return `no link: ${last.lastError ?? "the platform would not make it"}`;
      }
    }
    // Every amount is in its currency's own minor unit (ADR-036), and the platform's adapter converts it
    // from a table with a test per currency: one it has no test for gets no link, said with the reason.
    const currencyWhy = linkCurrencyProblem(conn.payments, want, Boolean(conn.shop));
    if (currencyWhy) return this.refuse(order, conn, want, currencyWhy, now);
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
   * Whether the connection is for this order: it was accepted once the platform was connected, or a
   * person asked for its payment since without a link of their own, or it has a link of ours already
   * (one waiting, failed or refused). An order accepted before keeps what it had.
   */
  private async eligible(order: OrderFacts, rows: readonly PayRow[], conn: PayConnection): Promise<boolean> {
    if (rows.some((r) => r.state === "creating" || r.state === "open" || r.state === "failed" || r.state === "error")) {
      return true;
    }
    const h = await this.history(order.id);
    return (
      (h.acceptedAt !== null && h.acceptedAt >= conn.createdAt) || (h.askedAt !== null && h.askedAt >= conn.createdAt)
    );
  }

  /** When the order was accepted, and when a person last asked for its payment (not the connector). */
  private async history(itemId: string): Promise<{ acceptedAt: number | null; askedAt: number | null }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT (SELECT MIN(created_at) FROM item_events WHERE item_id = ? AND to_state = 'accepted'),
                   (SELECT MAX(created_at) FROM item_events WHERE item_id = ? AND event = 'request_payment' AND actor_kind <> 'connector')`,
      params: [itemId, itemId],
      method: "all",
    });
    const r = rows[0] ?? [];
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { acceptedAt: n(r[0]), askedAt: n(r[1]) };
  }

  /** No link, said once: a row that says why, and one email to the owner. */
  private async refuse(order: OrderFacts, conn: PayConnection, want: Money, why: string, now: number): Promise<string> {
    const id = ulid(now);
    await this.db.client.query({
      sql: `INSERT INTO connector_payments
              (id, connector_id, kind, item_id, amount, currency, livemode, state, last_error, last_error_at, closed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?, ?, ?)`,
      params: [
        id,
        conn.id,
        conn.kind,
        order.id,
        want.value,
        want.currency,
        conn.mode === "live" ? 1 : 0,
        why,
        now,
        now,
        now,
        now,
      ],
      method: "run",
    });
    await this.linkFailed(id, order.id, why, now);
    return `no link: ${why}`;
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
    const lang: CustomerLang = customerLang(order.locale, facts.languages) === "pt" ? "pt" : "en";
    const words = PAGE_WORDS[lang];
    const reference = shortRef(order.id);
    const business = oneLine(facts.name) || null;
    const title = (await this.titleOf(order, lang, reference, words.order)).slice(0, 250);
    const hookUrl = conn.ctx.hookUrl ? `${conn.ctx.hookUrl}?ref=${encodeURIComponent(row.id)}` : "";
    try {
      if (!conn.ctx.hookUrl && conn.needsHookUrl !== false) {
        throw new ConnectorError(
          "config",
          "This inbox does not know its own public https address (INBOX_PUBLIC_URL, or the Inbox address in Settings), so the payment platform could not tell it of payments.",
        );
      }
      const shopOrder = conn.shop
        ? await shopOrderOf(this.db, order.id, { source: conn.shop.source, languages: facts.languages })
        : null;
      if (conn.shop && !shopOrder) throw new ConnectorError("config", "This order cannot be written into the shop.");
      const link = await conn.payments.createLink(conn.ctx, {
        ref: row.id,
        itemId: order.id,
        amount: { value: row.amount, currency: row.currency },
        title,
        reference,
        language: lang,
        thanks: words.thanks(reference),
        inactive: words.inactive(business, reference),
        hookUrl,
        ...(shopOrder ? { order: shopOrder } : {}),
      });
      // The shop's total is the customer's, or the link is not sent (ADR-030 §2): the tax or delivery a
      // shop adds itself is the owner's to propose, never a higher charge the customer did not accept.
      const shopTotal = link.total;
      if (shopTotal && (shopTotal.value !== row.amount || shopTotal.currency.toUpperCase() !== row.currency)) {
        const held = await this.db.client.query({
          sql: `UPDATE connector_payments SET state = 'held', external_id = ?, url = ?, dashboard_url = ?, shop_total = ?,
                       shop_currency = ?, claim_until = NULL, claimed_by = NULL, attempts = attempts + 1, retry_at = NULL,
                       last_error = NULL, last_error_at = NULL, note = ?, updated_at = ?
                 WHERE id = ? AND claimed_by = ? AND state = 'creating'`,
          params: [
            link.externalId,
            link.url,
            link.dashboardUrl?.slice(0, 500) ?? null,
            shopTotal.value,
            shopTotal.currency.toUpperCase(),
            `not sent: ${this.provider(conn.kind)} counts ${moneyIn({ value: shopTotal.value, currency: shopTotal.currency.toUpperCase() }, "en")}`,
            now,
            row.id,
            token,
          ],
          method: "run",
        });
        if (held.changes !== 1) return "lost: another job took over this link";
        await this.host.worked(conn.id, now);
        await this.notice(row.id, "shop_total", now);
        return `held: ${this.provider(conn.kind)} counts another total`;
      }
      const kept = await this.db.client.query({
        // Never asked about yet (`checked_at` stays empty): its first word from the platform is read at once.
        sql: `UPDATE connector_payments SET state = 'open', external_id = ?, url = ?, claim_until = NULL, claimed_by = NULL,
                     attempts = attempts + 1, retry_at = NULL, last_error = NULL, last_error_at = NULL,
                     dashboard_url = COALESCE(?, dashboard_url), shop_total = ?, shop_currency = ?, updated_at = ?
               WHERE id = ? AND claimed_by = ? AND state = 'creating'`,
        params: [
          link.externalId,
          link.url,
          link.dashboardUrl?.slice(0, 500) ?? null,
          link.total?.value ?? null,
          link.total ? link.total.currency.toUpperCase() : null,
          now,
          row.id,
          token,
        ],
        method: "run",
      });
      if (kept.changes !== 1) return "lost: another job took over this link";
      await this.host.worked(conn.id, now);
      // The order may have changed while the platform answered: it is looked at again, once, as it is now.
      if (depth >= 1) {
        const fresh = await this.row(row.id);
        const again = await this.order(order.id);
        if (again?.changeOpen) return "made; waits for the change";
        return fresh ? this.request(again, fresh, conn, now) : "gone";
      }
      return `made a ${this.provider(conn.kind)} link; ${await this.ensureOnce(order.id, now, depth + 1)}`;
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
        const message = error.message.slice(0, 500);
        await this.db.client.query({
          sql: `UPDATE connector_payments SET state = 'error', claim_until = NULL, claimed_by = NULL, attempts = ?,
                       last_error = ?, last_error_at = ?, closed_at = ?, updated_at = ?
                 WHERE id = ? AND claimed_by = ?`,
          params: [attempts, message, now, now, now, row.id, token],
          method: "run",
        });
        await this.linkFailed(row.id, order.id, message, now);
        return `given up: ${error.message}`;
      }
      const retryAt = now + (error.retryAfterMs ?? retryDelay(attempts));
      await this.releaseClaim(row.id, token, error.message, retryAt, now, attempts);
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${order.id}:retry:${row.id}:${attempts}`, {
        now,
        runAt: retryAt,
        payload: { itemId: order.id },
      });
      return `failed, tried again at ${new Date(retryAt).toISOString()}: ${error.message}`;
    }
  }

  /**
   * What the customer sees on the platform's page and the business's statement: the catalogue's own
   * names for its products ("Sourdough and 2 more"), never words a customer's agent typed (a name,
   * an address), and the order's reference; "Order 4F2K9Q" when a line is not from the catalogue.
   */
  private async titleOf(order: OrderFacts, lang: CustomerLang, reference: string, noun: string): Promise<string> {
    const ids = order.productIds;
    const plain = `${noun} ${reference}`;
    if (ids.length === 0 || ids.some((id) => id === null)) return plain;
    const { rows } = await this.db.client.query({
      sql: `SELECT id, name FROM products WHERE id IN (${ids.map(() => "?").join(", ")})`,
      params: ids as string[],
      method: "all",
    });
    const names = new Map(rows.map((r) => [String(r[0]), oneLine(String(r[1] ?? ""))]));
    const first = names.get(ids[0] as string);
    if (!first || ids.some((id) => !names.get(id as string))) return plain;
    const named = ids.length > 1 ? moreLines(first, ids.length - 1, lang) : first;
    return `${named} (${reference})`;
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
      return `asked to pay at the ${this.provider(conn.kind)} link`;
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
    // A card-hold page closes on the platform by itself (within a day): nothing to switch off there.
    const tell = row.externalId !== null && row.purpose !== "guarantee";
    const done = await this.db.client.query({
      sql: `UPDATE connector_payments SET state = 'closed', closed_at = ?, note = ?, claim_until = NULL, claimed_by = NULL,
                   retry_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('creating', 'open', 'held')`,
      params: [now, why.slice(0, 200), tell ? now : null, now, row.id],
      method: "run",
    });
    if (done.changes !== 1) return "already closed";
    if (!tell) return `closed: ${why}`;
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

  /**
   * A link of ours the order was asked to pay at is closed while the order still waits (the payment on
   * it did not go through, or the platform was disconnected): the order no longer names it, so neither
   * the customer's agent nor the next email sends anyone to a link that takes no payment.
   */
  private async dropOrderLink(itemId: string, url: string | null): Promise<void> {
    if (!url) return;
    await this.db.client.query({
      sql: `UPDATE items SET payload = json_remove(payload, '$.paymentUrl')
             WHERE id = ? AND type = 'order' AND state IN ('accepted', 'awaiting_payment', 'payment_failed')
               AND json_extract(payload, '$.paymentUrl') = ?`,
      params: [itemId, url],
      method: "run",
    });
  }

  /* --- links on a payment schedule (ADR-036) ------------------------------------ */

  /** The item's type, or null when there is no such item. */
  private async itemType(itemId: string): Promise<ItemType | null> {
    const { rows } = await this.db.client.query({
      sql: "SELECT type FROM items WHERE id = ?",
      params: [itemId],
      method: "all",
    });
    return rows[0] ? (String(rows[0][0]) as ItemType) : null;
  }

  /**
   * Makes an item's schedule links match what its source wants now: one live link per entry that wants
   * one, for its amount and window; any other closed. Orders never come here.
   */
  private async ensureScheduled(itemId: string, now: number): Promise<string> {
    const type = await this.itemType(itemId);
    const source = type ? scheduleSourceOf(type) : undefined;
    if (!type || !source) return "not an order";
    const item = await source.wanted(this.db, itemId, now);
    const rows = (await this.rowsFor(itemId)).filter((r) => r.scheduleId !== "" && r.purpose !== "guarantee");
    const live = rows.filter((r) => r.state === "creating" || r.state === "open");
    const notes: string[] = [];
    // A link no entry wants as it stands now is closed: paid another way, changed, or the item ended.
    for (const r of live) {
      const w = item?.links.find((l) => l.scheduleId === r.scheduleId);
      const same = w && w.amount.value === r.amount && w.amount.currency === r.currency;
      if (!same)
        notes.push(await this.close(r, w ? `the ${r.purpose} changed` : `the ${r.purpose} is no longer due`, now));
    }
    if (!item || item.links.length === 0) return notes.join("; ") || "nothing to do";
    const conn =
      (await this.host.payConnections(now)).find(
        (c) => c.status !== "disabled" && c.payOn && !c.disconnecting && c.mode === (item.sandbox ? "test" : "live"),
      ) ?? null;
    for (const w of item.links) {
      if (w.expiresAt !== null && w.expiresAt <= now) continue;
      if (rows.some((r) => r.scheduleId === w.scheduleId && r.state === "paid")) continue;
      const open = (await this.rowsFor(itemId)).find(
        (r) =>
          r.scheduleId === w.scheduleId &&
          (r.state === "creating" || r.state === "open") &&
          r.amount === w.amount.value &&
          r.currency === w.amount.currency,
      );
      if (open?.state === "open") continue;
      if (!conn) {
        notes.push(item.sandbox ? "no test-mode payment connection" : "no live payment connection");
        continue;
      }
      if (open?.state === "creating") {
        const other = open.connectorId === conn.id ? conn : await this.host.payConnection(open.connectorId, now);
        notes.push(other ? await this.makeScheduled(item, w, open, other, now) : "held");
        continue;
      }
      // A refusal stands until what it was about changes.
      const last = rows.filter((r) => r.scheduleId === w.scheduleId).at(-1);
      if (last?.state === "error" && last.amount === w.amount.value && last.currency === w.amount.currency) {
        notes.push(`no ${w.purpose} link: ${last.lastError ?? "the platform would not make it"}`);
        continue;
      }
      const why = linkCurrencyProblem(conn.payments, w.amount, Boolean(conn.shop));
      if (why) {
        notes.push(await this.refuseScheduled(item, w, conn, why, now));
        continue;
      }
      const id = ulid(now);
      const token = randomToken(12);
      const inserted = await this.db.client.query({
        sql: `INSERT OR IGNORE INTO connector_payments
                (id, connector_id, kind, item_id, amount, currency, livemode, state, claim_until, claimed_by,
                 schedule_id, purpose, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          conn.id,
          conn.kind,
          itemId,
          w.amount.value,
          w.amount.currency,
          conn.mode === "live" ? 1 : 0,
          now + CLAIM_MS,
          token,
          w.scheduleId,
          w.purpose,
          w.expiresAt,
          now,
          now,
        ],
        method: "run",
      });
      if (inserted.changes !== 1) {
        notes.push(`held: another job is making the ${w.purpose} link`);
        continue;
      }
      const row = await this.row(id);
      notes.push(row ? await this.makeScheduled(item, w, row, conn, now, token) : "held");
    }
    return notes.join("; ") || "links open";
  }

  /** No link for one entry, said once: a row that says why, and one email to the owner. */
  private async refuseScheduled(
    item: ScheduledItem,
    w: WantedLink,
    conn: PayConnection,
    why: string,
    now: number,
  ): Promise<string> {
    const id = ulid(now);
    await this.db.client.query({
      sql: `INSERT INTO connector_payments
              (id, connector_id, kind, item_id, amount, currency, livemode, state, last_error, last_error_at, closed_at,
               schedule_id, purpose, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        conn.id,
        conn.kind,
        item.id,
        w.amount.value,
        w.amount.currency,
        conn.mode === "live" ? 1 : 0,
        why,
        now,
        now,
        w.scheduleId,
        w.purpose,
        w.expiresAt,
        now,
        now,
      ],
      method: "run",
    });
    await this.linkFailed(id, item.id, why, now);
    return `no ${w.purpose} link: ${why}`;
  }

  /** Asks the platform for one entry's link, under the row's claim, as `make` does for an order's. */
  private async makeScheduled(
    item: ScheduledItem,
    w: WantedLink,
    row: PayRow,
    conn: PayConnection,
    now: number,
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
      if (claimed.changes !== 1) return `held: another job is making the ${w.purpose} link`;
    }
    const settings = await readSettings(this.db);
    const facts = await businessFacts(this.db, settings);
    const lang: CustomerLang = customerLang(item.locale, facts.languages) === "pt" ? "pt" : "en";
    const words = PAGE_WORDS[lang];
    const business = oneLine(facts.name) || null;
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
        itemId: item.id,
        amount: { value: row.amount, currency: row.currency },
        title: oneLine(w.title).slice(0, 250),
        reference: item.reference,
        language: lang,
        thanks: words.thanks(item.reference),
        inactive: words.inactive(business, item.reference),
        hookUrl,
        purpose: w.purpose,
        scheduleId: w.scheduleId,
        ...(w.expiresAt !== null ? { expiresAt: w.expiresAt } : {}),
      });
      const kept = await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'open', external_id = ?, url = ?, claim_until = NULL, claimed_by = NULL,
                     attempts = attempts + 1, retry_at = NULL, last_error = NULL, last_error_at = NULL, updated_at = ?
               WHERE id = ? AND claimed_by = ? AND state = 'creating'`,
        params: [link.externalId, link.url, now, row.id, token],
        method: "run",
      });
      if (kept.changes !== 1) return "lost: another job took over this link";
      await this.host.worked(conn.id, now);
      const source = scheduleSourceOf(item.type);
      await source?.opened?.(this.db, { itemId: item.id, scheduleId: w.scheduleId, url: link.url, now });
      return `made a ${providerOf(conn.kind)} ${w.purpose} link`;
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
        const message = error.message.slice(0, 500);
        await this.db.client.query({
          sql: `UPDATE connector_payments SET state = 'error', claim_until = NULL, claimed_by = NULL, attempts = ?,
                       last_error = ?, last_error_at = ?, closed_at = ?, updated_at = ?
                 WHERE id = ? AND claimed_by = ?`,
          params: [attempts, message, now, now, now, row.id, token],
          method: "run",
        });
        await this.linkFailed(row.id, item.id, message, now);
        return `given up: ${error.message}`;
      }
      const retryAt = now + (error.retryAfterMs ?? retryDelay(attempts));
      await this.releaseClaim(row.id, token, error.message, retryAt, now, attempts);
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${item.id}:retry:${row.id}:${attempts}`, {
        now,
        runAt: retryAt,
        payload: { itemId: item.id },
      });
      return `failed, tried again at ${new Date(retryAt).toISOString()}: ${error.message}`;
    }
  }

  /**
   * What the platform confirmed on a schedule link, applied once: the link marked paid (compare-and-set),
   * then the item's source records it — or, for a payment the item can no longer take, keeps it for the
   * owner to refund in their own dashboard, and says so.
   */
  private async applyScheduled(
    conn: PayConnection,
    row: PayRow,
    fact: PaymentFact,
    now: number,
  ): Promise<{ done: boolean; itemId: string | null }> {
    const type = await this.itemType(row.itemId);
    const source = type ? scheduleSourceOf(type) : undefined;
    if (fact.status === "failed") {
      const spent = await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'failed', payment_id = ?, closed_at = ?, note = ?, updated_at = ?
               WHERE id = ? AND state IN ('open', 'creating')`,
        params: [fact.paymentId.slice(0, 200), now, "the payment did not go through", now, row.id],
        method: "run",
      });
      if (spent.changes !== 1) return { done: false, itemId: row.itemId };
      await this.tellClosed(row, now);
      await source?.closed?.(this.db, { itemId: row.itemId, scheduleId: row.scheduleId, why: "failed", now });
      await ensureJob(this.db, PAY_LINK_KIND, `paylink:${row.itemId}:after-failure:${row.id}`, {
        now,
        payload: { itemId: row.itemId },
      });
      return { done: true, itemId: row.itemId };
    }
    const before = row.state;
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
    if (paid.changes !== 1) return this.paidAgain(row, fact, now);
    const amount = fact.amount ?? { value: row.amount, currency: row.currency };
    if (!source) {
      await this.notePaidAfter(row, "the item takes no payments here any more", now);
      return { done: true, itemId: row.itemId };
    }
    let outcome: { applied: boolean; note: string };
    try {
      outcome = await source.paid(this.db, {
        itemId: row.itemId,
        scheduleId: row.scheduleId,
        purpose: row.purpose,
        amount,
        paymentId: fact.paymentId.slice(0, 200),
        ...(fact.method ? { method: fact.method.slice(0, 40) } : {}),
        ...(fact.dashboardUrl ? { dashboardUrl: fact.dashboardUrl.slice(0, 500) } : {}),
        connectorId: conn.id,
        now,
      });
    } catch (error) {
      // The link says paid and the item does not: put the link back as it was, for the next word.
      await this.db.client.query({
        sql: `UPDATE connector_payments SET state = ?, payment_id = NULL, method = NULL, paid_amount = NULL, paid_currency = NULL,
                     dashboard_url = NULL, paid_at = NULL, last_error = ?, last_error_at = ?, updated_at = ?
               WHERE id = ? AND state = 'paid'`,
        params: [before, `not recorded: ${String((error as Error)?.message ?? error)}`.slice(0, 500), now, now, row.id],
        method: "run",
      });
      throw error;
    }
    if (!outcome.applied) await this.notePaidAfter(row, outcome.note, now);
    if (amount.value !== row.amount || amount.currency !== row.currency)
      await this.notice(row.id, "amount_differs", now);
    return { done: true, itemId: row.itemId };
  }

  /** A payment kept on its link for the owner to refund, said on the link and told once. */
  private async notePaidAfter(row: PayRow, why: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE connector_payments SET note = ?, updated_at = ? WHERE id = ?",
      params: [
        `paid after ${why}: refund it in ${providerOf(row.kind)} if it is not wanted`.slice(0, 500),
        now,
        row.id,
      ],
      method: "run",
    });
    await this.notice(row.id, "paid_after", now);
  }

  /**
   * Schedule links whose window has closed, for one connection: asked once more for a payment made at
   * the last moment, then closed on the platform, and the item's source told. Answers the calls made.
   */
  private async lapse(conn: PayConnection, now: number, budget: number): Promise<number> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments
             WHERE connector_id = ? AND state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
             ORDER BY expires_at LIMIT ?`,
      params: [conn.id, now, budget],
      method: "all",
    });
    let calls = 0;
    for (const r of rows.map(rowOf)) {
      if (calls >= budget) break;
      calls++;
      try {
        const facts = await conn.payments.check(conn.ctx, { ref: r.id, externalId: r.externalId, itemId: r.itemId });
        for (const fact of facts) if (fact.status !== "pending") await this.apply(conn, fact, now);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        // The platform cannot be asked now: the window is the item's, and it closes all the same.
      }
      const current = await this.row(r.id);
      if (current?.state !== "open") continue;
      await this.close(current, `its window to pay closed`, now);
      const type = await this.itemType(r.itemId);
      const source = type ? scheduleSourceOf(type) : undefined;
      await source?.closed?.(this.db, { itemId: r.itemId, scheduleId: r.scheduleId, why: "expired", now });
    }
    return calls;
  }

  /* --- a card to hold a booking (ADR-036) ------------------------------------------ */

  /**
   * Whether card holds are on for a connection: the owner switched them on in person, once the key
   * had what they need (`setGuarantees`).
   */
  private async guaranteesOn(connectorId: string): Promise<boolean> {
    const { rows } = await this.db.client.query({
      sql: "SELECT json_extract(config_public, '$.guarantees') FROM connectors WHERE id = ?",
      params: [connectorId],
      method: "all",
    });
    return Number(rows[0]?.[0] ?? 0) === 1;
  }

  /**
   * Switches card holds on or off for a connection. On asks the key, then and only then, for what holds
   * need, and refuses with the platform's own names for what it lacks. The caller is the owner in person.
   */
  async setGuarantees(
    connectorId: string,
    on: boolean,
    now: number,
  ): Promise<{ readonly on: boolean; readonly missing: readonly string[] }> {
    const conn = await this.host.payConnection(connectorId, now);
    if (!conn) throw new WriteError("not_found", "no such payment connection");
    if (on) {
      if (!conn.payments.createGuarantee || !conn.payments.guaranteePermissions) {
        throw new WriteError("invalid_input", `${providerOf(conn.kind)} cannot hold a card here.`, {
          fields: [{ path: "on", problem: "invalid", message: "this platform takes no card holds" }],
        });
      }
      const missing = await conn.payments.guaranteePermissions(conn.ctx);
      if (missing.length > 0) return { on: false, missing };
    }
    await this.db.client.query({
      sql: "UPDATE connectors SET config_public = json_set(config_public, '$.guarantees', json(?)), updated_at = ? WHERE id = ?",
      params: [on ? "true" : "false", now, connectorId],
      method: "run",
    });
    return { on, missing: [] };
  }

  /**
   * The page where the customer saves a card to hold their booking, made when they open the inbox's own
   * link: an open one is given again while it lasts, else a new one on the connection of the item's
   * mode whose card holds are on. Null, with why, when none can be made.
   */
  async openGuarantee(
    request: {
      readonly itemId: string;
      readonly sandbox: boolean;
      readonly currency: string;
      readonly reference: string;
      readonly language: string;
      readonly returnUrl: string;
      readonly cancelUrl: string;
      /** How long the platform's page stays open: 30 minutes to 24 hours on Stripe. */
      readonly ttlMs: number;
    },
    now: number,
  ): Promise<{ readonly url: string; readonly expiresAt: number } | { readonly refused: string }> {
    const rows = (await this.rowsFor(request.itemId)).filter((r) => r.purpose === "guarantee");
    if (rows.some((r) => r.state === "paid")) return { refused: "A card already holds this booking." };
    const open = rows.find((r) => r.state === "open" && r.url && (r.expiresAt ?? 0) > now + 60_000);
    if (open?.url) return { url: open.url, expiresAt: open.expiresAt ?? now };
    for (const r of rows.filter((x) => x.state === "open")) await this.close(r, "a new page was made", now);
    const conns = (await this.host.payConnections(now)).filter(
      (c) =>
        c.status !== "disabled" &&
        !c.disconnecting &&
        c.mode === (request.sandbox ? "test" : "live") &&
        c.payments.createGuarantee !== undefined,
    );
    let conn: PayConnection | null = null;
    for (const c of conns) if (await this.guaranteesOn(c.id)) conn = c;
    if (!conn?.payments.createGuarantee) return { refused: "Card holds are not switched on for this business." };
    const id = ulid(now);
    const ttl = Math.min(24 * 3_600_000, Math.max(30 * 60_000, request.ttlMs));
    try {
      const made = await conn.payments.createGuarantee(conn.ctx, {
        ref: id,
        itemId: request.itemId,
        currency: request.currency,
        reference: request.reference,
        language: request.language,
        returnUrl: request.returnUrl,
        cancelUrl: request.cancelUrl,
        expiresAt: now + ttl,
      });
      await this.db.client.query({
        sql: `INSERT INTO connector_payments
                (id, connector_id, kind, item_id, amount, currency, livemode, state, external_id, url, attempts,
                 schedule_id, purpose, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, ?, ?, 'open', ?, ?, 1, 'guarantee', 'guarantee', ?, ?, ?)`,
        params: [
          id,
          conn.id,
          conn.kind,
          request.itemId,
          request.currency.toUpperCase(),
          conn.mode === "live" ? 1 : 0,
          made.externalId,
          made.url,
          made.expiresAt,
          now,
          now,
        ],
        method: "run",
      });
      return { url: made.url, expiresAt: made.expiresAt };
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      if (error.code === "auth" || error.code === "config") await this.host.failed(conn.id, error, now);
      return { refused: error.message };
    }
  }

  /**
   * Whether the customer saved the card, read back with the key: once it is, the hold is recorded on the
   * item by its source (a hold of nothing, `purpose: guarantee`). Answers whether it is held now.
   */
  async checkGuarantee(itemId: string, now: number): Promise<boolean> {
    const rows = (await this.rowsFor(itemId)).filter((r) => r.purpose === "guarantee");
    if (rows.some((r) => r.state === "paid")) return true;
    for (const r of rows.filter((x) => x.state === "open" && x.externalId)) {
      const conn = await this.host.payConnection(r.connectorId, now);
      if (!conn?.payments.guaranteeFact || !r.externalId) continue;
      let fact: Awaited<ReturnType<NonNullable<PaymentsHandler["guaranteeFact"]>>>;
      try {
        fact = await conn.payments.guaranteeFact(conn.ctx, { externalId: r.externalId });
      } catch (error) {
        if (error instanceof ConnectorError) continue;
        throw error;
      }
      await this.checked(r.id, now);
      if (!fact || fact.livemode !== r.livemode) continue;
      if (fact.status === "expired") {
        await this.close(r, "the page to save a card closed", now);
        continue;
      }
      if (fact.status !== "saved") continue;
      const saved = await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'paid', payment_id = ?, dashboard_url = ?, paid_at = ?, checked_at = ?, updated_at = ?
               WHERE id = ? AND state = 'open'`,
        params: [
          fact.customerId?.slice(0, 200) ?? r.externalId,
          fact.dashboardUrl?.slice(0, 500) ?? null,
          now,
          now,
          now,
          r.id,
        ],
        method: "run",
      });
      if (saved.changes !== 1) return true;
      const type = await this.itemType(itemId);
      const source = type ? scheduleSourceOf(type) : undefined;
      const outcome = await source?.paid(this.db, {
        itemId,
        scheduleId: "guarantee",
        purpose: "guarantee",
        amount: { value: 0, currency: r.currency },
        paymentId: fact.customerId?.slice(0, 200) ?? r.externalId,
        ...(fact.dashboardUrl ? { dashboardUrl: fact.dashboardUrl.slice(0, 500) } : {}),
        connectorId: r.connectorId,
        now,
      });
      if (outcome && !outcome.applied) await this.notePaidAfter(r, outcome.note, now);
      return true;
    }
    return false;
  }

  /** Card-hold pages still open, for one connection, read back as each falls due. Answers the calls made. */
  private async guarantees(conn: PayConnection, now: number, budget: number): Promise<number> {
    const { rows } = await this.db.client.query({
      sql: `SELECT DISTINCT item_id FROM connector_payments
             WHERE connector_id = ? AND state = 'open' AND purpose = 'guarantee'
               AND (checked_at IS NULL OR checked_at < ?) LIMIT ?`,
      params: [conn.id, now - FIRST_DAY_EVERY_MS, budget],
      method: "all",
    });
    for (const r of rows) await this.checkGuarantee(String(r[0]), now);
    return rows.length;
  }

  /* --- what the platform says -------------------------------------------------- */

  /**
   * A request a platform sent to `POST /v1/hooks/<kind>`. A request naming one of our links (`ref`,
   * Mollie's per-link webhook) is handed to that link's connection only, and read back at most every
   * few seconds; any other to each connection of the kind until one's signature checks out. Answers
   * the HTTP status to send back: 200 when it was read (or is not ours), 400 when no signature
   * checked out, 503 when the platform could not be asked back (the platform sends it again).
   */
  async receive(
    kind: string,
    request: InboundRequest,
    now: number,
  ): Promise<{
    readonly status: 200 | 400 | 404 | 503;
    readonly body: Record<string, unknown>;
    readonly retryAfterS?: number | undefined;
  }> {
    const ref = request.query.get("ref");
    let candidates: PayConnection[];
    let nudged: PayRow | null = null;
    if (ref) {
      const row = await this.row(ref);
      if (!row || row.kind !== kind)
        return { status: 200, body: { ok: true, handled: 0, note: "not a link of this inbox" } };
      // An unsigned nudge names a link anyone who saw the address can name: the platform is asked about
      // it at most every few seconds, and a nudge in between is asked to come again (the platform
      // sends its own again; one made up is never read).
      if (
        row.checkedAt !== null &&
        now - row.checkedAt < NUDGE_EVERY_MS &&
        !request.headers.has("x-mollie-signature")
      ) {
        return {
          status: 503,
          body: { error: "unavailable", detail: "Asked about a moment ago: send it again shortly." },
          retryAfterS: Math.ceil(NUDGE_EVERY_MS / 1000),
        };
      }
      const conn = await this.host.payConnection(row.connectorId, now);
      if (!conn) return { status: 200, body: { ok: true, handled: 0, note: "that connection is gone" } };
      candidates = [conn];
      nudged = row;
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
      } finally {
        if (nudged && !request.headers.has("x-mollie-signature")) await this.checked(nudged.id, now);
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

  private async checked(id: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE connector_payments SET checked_at = ?, updated_at = ? WHERE id = ?",
      params: [now, now, id],
      method: "run",
    });
  }

  /**
   * What the platform confirmed, applied once: the link marked paid (a compare-and-set, so a request
   * sent twice, or a webhook and a reconciliation that meet, record it once), then the order. A
   * payment that cannot go on the order (it was cancelled, or paid already, or it is a second one on
   * a link paid already) is kept on the link and the owner told where to refund it.
   */
  async apply(conn: PayConnection, fact: PaymentFact, now: number): Promise<{ done: boolean; itemId: string | null }> {
    const row =
      (fact.linkId ? await this.rowByExternal(conn.id, fact.linkId) : null) ??
      (fact.ref ? await this.row(fact.ref) : null);
    if (!row || row.connectorId !== conn.id) return { done: false, itemId: null };
    // A test payment never pays a real order, nor a live one a test.
    if (fact.livemode !== row.livemode) return { done: false, itemId: row.itemId };
    if (fact.status === "pending") return { done: false, itemId: row.itemId };
    if (row.scheduleId !== "") return this.applyScheduled(conn, row, fact, now);
    if (fact.status === "failed") return this.failed(conn, row, fact, now);
    const before = row.state;
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
    if (paid.changes !== 1) return this.paidAgain(row, fact, now);
    const order = await this.order(row.itemId);
    const amount = fact.amount ?? { value: row.amount, currency: row.currency };
    if (!order || !WANTS_LINK.has(order.state) || order.paid) return this.paidAfter(row, order, now);
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
      // The order moved on between the read and the write (cancelled, paid by hand): the payment is
      // the owner's to settle, as one that came after.
      if (error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed")) {
        return this.paidAfter(row, await this.order(row.itemId), now);
      }
      // The row says paid, the order does not: the row is put back exactly as it was, so the platform's
      // next word (or the next reconciliation) records it, and the error is ours to read.
      await this.db.client.query({
        sql: `UPDATE connector_payments SET state = ?, payment_id = NULL, method = NULL, paid_amount = NULL, paid_currency = NULL,
                     dashboard_url = NULL, paid_at = NULL, last_error = ?, last_error_at = ?, updated_at = ?
               WHERE id = ? AND state = 'paid'`,
        params: [before, `not recorded: ${String((error as Error)?.message ?? error)}`.slice(0, 500), now, now, row.id],
        method: "run",
      });
      throw error;
    }
    if (amount.value !== order.total.value || amount.currency !== order.total.currency) {
      await this.notice(row.id, "amount_differs", now);
    }
    return { done: true, itemId: row.itemId };
  }

  /** A payment the order cannot take (it was cancelled, or paid already): kept on the link, and the owner told. */
  private async paidAfter(
    row: PayRow,
    order: OrderFacts | null,
    now: number,
  ): Promise<{ done: boolean; itemId: string | null }> {
    const twice =
      order !== null &&
      (order.paid || order.state === "paid" || order.state === "fulfilling" || order.state === "fulfilled");
    const why = !order
      ? "the order is gone"
      : twice
        ? "the order was paid already"
        : `the order is ${order.state.replaceAll("_", " ")}`;
    await this.db.client.query({
      sql: "UPDATE connector_payments SET note = ?, updated_at = ? WHERE id = ?",
      params: [`paid after ${why}: refund it in ${this.provider(row.kind)} if it is not wanted`, now, row.id],
      method: "run",
    });
    await this.notice(row.id, twice ? "paid_twice" : "paid_after", now);
    return { done: true, itemId: row.itemId };
  }

  /**
   * A paid link the platform says took another payment as well (two checkouts begun before the first
   * was paid): the owner is told once per payment, with that payment's own amount and page.
   */
  private async paidAgain(
    row: PayRow,
    fact: PaymentFact,
    now: number,
  ): Promise<{ done: boolean; itemId: string | null }> {
    const current = await this.row(row.id);
    const paymentId = fact.paymentId.slice(0, 200);
    if (current?.state !== "paid" || !current.paymentId || current.paymentId === paymentId) {
      return { done: false, itemId: row.itemId };
    }
    const seen = await this.db.client.query({
      sql: `INSERT OR IGNORE INTO connector_events (id, connector_id, external_id, topic, received_at, status, item_id, handled_at, raw)
            VALUES (?, ?, ?, 'payment.again', ?, 'handled', ?, ?, ?)`,
      params: [
        ulid(now),
        row.connectorId,
        `again:${paymentId}`,
        now,
        row.itemId,
        now,
        JSON.stringify({ ...fact, dashboardUrl: undefined }),
      ],
      method: "run",
    });
    if (seen.changes === 0) return { done: false, itemId: row.itemId };
    await this.notice(row.id, "paid_twice", now, {
      paymentId,
      amount: fact.amount,
      dashboardUrl: fact.dashboardUrl ?? null,
    });
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
    // The order no longer sends anyone to the spent link, the email about the failure included.
    await this.dropOrderLink(row.itemId, row.url);
    // A new link is made straight away; the email about the failure waits for it (PAY_LINK_GRACE_MS).
    await ensureJob(this.db, PAY_LINK_KIND, `paylink:${row.itemId}:after-failure:${row.id}`, {
      now,
      payload: { itemId: row.itemId },
    });
    return { done: true, itemId: row.itemId };
  }

  /* --- what a shop says became of an order (ADR-030 §2) -------------------------------- */

  /**
   * A shop's word on an order it made for the inbox, read back with the business's key: fulfilled
   * and delivered move the order on, by the connector; cancelled before it was paid closes the link and
   * leaves the order to the owner (a shop cancels unpaid orders on its own, a stock hold that ran out,
   * and the customer is never told their order ended for that); refunded marks done a refund the inbox
   * owes, when it covers it. Once each: what the order already shows is not done again.
   */
  async applyOrder(
    conn: PayConnection,
    fact: OrderFact,
    now: number,
  ): Promise<{ done: boolean; itemId: string | null }> {
    const row =
      (fact.linkId ? await this.rowByExternal(conn.id, fact.linkId) : null) ??
      (fact.ref ? await this.row(fact.ref) : null);
    if (!row || row.connectorId !== conn.id) return { done: false, itemId: null };
    const caller = (what: string) => connectorCaller(conn.id, now, `${what}:${row.id}`);
    const quietly = async (run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        return true;
      } catch (error) {
        // The order moved on (fulfilled by hand, cancelled): what the shop says is history then.
        if (error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed")) return false;
        throw error;
      }
    };
    switch (fact.state) {
      case "cancelled": {
        if (row.state !== "open" && row.state !== "held" && row.state !== "creating")
          return { done: false, itemId: row.itemId };
        const closed = await this.db.client.query({
          sql: `UPDATE connector_payments SET state = 'closed', closed_at = ?, note = ?, claim_until = NULL, claimed_by = NULL,
                       retry_at = NULL, updated_at = ?
                 WHERE id = ? AND state IN ('creating', 'open', 'held')`,
          params: [now, `cancelled in ${this.provider(conn.kind)}`, now, row.id],
          method: "run",
        });
        if (closed.changes !== 1) return { done: false, itemId: row.itemId };
        await this.dropOrderLink(row.itemId, row.url);
        await this.notice(row.id, "shop_cancelled", now);
        return { done: true, itemId: row.itemId };
      }
      case "fulfilled": {
        const order = await this.order(row.itemId);
        if (!order || !["accepted", "paid", "fulfilling"].includes(order.state))
          return { done: false, itemId: row.itemId };
        const t = fact.tracking;
        const tracking = t
          ? [t.carrier, t.number, t.url].filter((v): v is string => typeof v === "string" && v !== "")
          : [];
        const done = await quietly(() =>
          transitionItem(this.db, caller("fulfilled"), {
            itemId: row.itemId,
            event: "fulfil",
            input: tracking.length > 0 ? { note: `Tracking: ${tracking.join(" ").slice(0, 400)}` } : {},
          }),
        );
        return { done, itemId: row.itemId };
      }
      case "delivered": {
        const order = await this.order(row.itemId);
        if (!order || (order.state !== "fulfilled" && order.state !== "completed"))
          return { done: false, itemId: row.itemId };
        const done = await quietly(() =>
          transitionItem(this.db, caller("delivered"), {
            itemId: row.itemId,
            event: "record_delivery",
            input: { deliveredAt: new Date(fact.at).toISOString() },
          }),
        );
        return { done, itemId: row.itemId };
      }
      case "refunded": {
        const amount = fact.refunded;
        if (!amount || row.state !== "paid") return { done: false, itemId: row.itemId };
        const { rows } = await this.db.client.query({
          sql: `SELECT id, json_extract(payload, '$.amount.value'), json_extract(payload, '$.amount.currency')
                  FROM items WHERE linked_item_id = ? AND type = 'refund' AND state IN ('approved', 'goods_received')
                 ORDER BY created_at LIMIT 5`,
          params: [row.itemId],
          method: "all",
        });
        let done = false;
        for (const r of rows) {
          const owed = { value: Number(r[1] ?? 0), currency: String(r[2] ?? "").toUpperCase() };
          if (owed.value <= 0 || owed.currency !== amount.currency.toUpperCase() || amount.value < owed.value) continue;
          done =
            (await quietly(() =>
              transitionItem(this.db, connectorCaller(conn.id, now, `refunded:${String(r[0])}`), {
                itemId: String(r[0]),
                event: "refund",
                input: { paymentRef: (row.paymentId ?? row.externalId ?? row.id).slice(0, 200), amount: owed },
              }),
            )) || done;
        }
        return { done, itemId: row.itemId };
      }
    }
  }

  /**
   * What "Propose the shop's total" proposes (ADR-030 §2): the order's lines as they are, and one line
   * for what the shop adds (its tax or delivery), so the total is the shop's. The owner sends it as a
   * change the customer accepts or not (ADR-018 §3.2); the shop is told only the product lines, and adds
   * the rest itself. Null when the order has no held link the owner can propose a total for.
   */
  async shopTotalChange(itemId: string): Promise<{
    readonly orderedItem: readonly {
      productId?: string;
      sku?: string;
      name: string;
      quantity: number;
      price: Money;
    }[];
    readonly shopTotal: Money;
    readonly provider: string;
    readonly lang: CustomerLang;
  } | null> {
    const held = (await this.rowsFor(itemId)).find((r) => r.state === "held");
    if (!held || held.shopTotal === null || held.shopCurrency !== held.currency || held.shopTotal <= held.amount)
      return null;
    const { rows } = await this.db.client.query({
      sql: `SELECT i.payload, p.contact FROM items i LEFT JOIN parties p ON p.id = i.party_id WHERE i.id = ? AND i.type = 'order'`,
      params: [itemId],
      method: "all",
    });
    const payload = (parseJson(rows[0]?.[0]) ?? {}) as { orderedItem?: Record<string, unknown>[]; totalPrice?: Money };
    const contact = parseJson(rows[0]?.[1]) as { locale?: unknown } | null;
    if (!Array.isArray(payload.orderedItem) || payload.totalPrice?.value !== held.amount) return null;
    const settings = await readSettings(this.db);
    const facts = await businessFacts(this.db, settings);
    const lang =
      customerLang(typeof contact?.locale === "string" ? contact.locale : null, facts.languages) === "pt" ? "pt" : "en";
    let charges = held.shopTotal - held.amount;
    const lines: { productId?: string; sku?: string; name: string; quantity: number; price: Money }[] = [];
    for (const l of payload.orderedItem) {
      const price = l.price as Money | undefined;
      const quantity = Number(l.quantity);
      if (!price || !Number.isInteger(quantity) || quantity < 1) return null;
      // A charges line from an earlier proposal is folded into the new one.
      if (l.sku === SHOP_CHARGES_SKU && typeof l.productId !== "string") {
        charges += price.value * quantity;
        continue;
      }
      lines.push({
        ...(typeof l.productId === "string" ? { productId: l.productId } : {}),
        ...(typeof l.sku === "string" ? { sku: l.sku } : {}),
        name: String(l.name ?? "").slice(0, 200) || "Item",
        quantity,
        price: { value: price.value, currency: price.currency },
      });
    }
    lines.push({
      sku: SHOP_CHARGES_SKU,
      name: SHOP_CHARGES_NAME[lang],
      quantity: 1,
      price: { value: charges, currency: held.currency },
    });
    return {
      orderedItem: lines,
      shopTotal: { value: held.shopTotal, currency: held.shopCurrency },
      provider: this.provider(held.kind),
      lang,
    };
  }

  /* --- the regular look ----------------------------------------------------------- */

  /**
   * What a webhook may have missed, for one connection, run with its five-minute sync, within a budget
   * of calls: links still to be closed on the platform, links whose making stopped half way, open links
   * asked about as each falls due (every sync for their first day, hourly to two days, twice a day to
   * a fortnight, then daily for as long as they are open), and, where the key may read them, refunds
   * made in the dashboard for a refund the inbox owes.
   */
  async reconcile(
    conn: PayConnection,
    now: number,
  ): Promise<{ checked: number; paid: number; closed: number; refunded: number }> {
    let calls = 0;
    let paid = 0;
    let closed = 0;
    let refunded = 0;
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
    // Only the links due now: one not due never holds a place another needs. Links of the last two days
    // first (a customer who just paid is waiting to hear), then the older ones, soonest due first.
    const { rows: open } = await this.db.client.query({
      sql: `SELECT * FROM (
              SELECT ${COLUMNS}, COALESCE(checked_at, created_at) + CASE
                       WHEN ? - created_at < ${DAY_MS} THEN ${FIRST_DAY_EVERY_MS}
                       WHEN ? - created_at < ${2 * DAY_MS} THEN ${HOUR_MS}
                       WHEN ? - created_at < ${15 * DAY_MS} THEN ${12 * HOUR_MS}
                       ELSE ${DAY_MS} END AS due
                FROM connector_payments WHERE connector_id = ? AND state = 'open' AND external_id IS NOT NULL
                 AND purpose <> 'guarantee')
             WHERE due <= ? ORDER BY CASE WHEN created_at > ? THEN 0 ELSE 1 END, due LIMIT ?`,
      params: [now, now, now, conn.id, now, now - 2 * DAY_MS, CHECKS_PER_RUN],
      method: "all",
    });
    for (const r of open.map(rowOf)) {
      if (calls >= CHECKS_PER_RUN) break;
      calls++;
      try {
        const known = { ref: r.id, externalId: r.externalId, itemId: r.itemId };
        const facts = await conn.payments.check(conn.ctx, known);
        await this.checked(r.id, now);
        let settled = false;
        for (const fact of facts) {
          if (fact.status === "pending") continue;
          const applied = await this.apply(conn, fact, now);
          if (applied.done && fact.status === "paid") paid++;
          if (applied.done) settled = true;
        }
        // A shop's order not paid yet may have been cancelled there (a stock hold that ran out).
        if (!settled && conn.payments.orderState && calls < CHECKS_PER_RUN) {
          calls++;
          const fact = await conn.payments.orderState(conn.ctx, known);
          if (fact?.state === "cancelled") await this.applyOrder(conn, fact, now);
        }
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        if (error.code === "auth") {
          await this.host.failed(conn.id, error, now);
          break;
        }
        await this.checked(r.id, now);
      }
    }
    // A shop's orders (ADR-030 §2): what became of the ones waiting, and of the paid ones until they end.
    if (conn.payments.orderState && calls < CHECKS_PER_RUN) {
      calls += await this.orderStates(conn, now, CHECKS_PER_RUN - calls);
    }
    // Schedule links whose pay window closed, and card-hold pages still waiting (ADR-036).
    if (calls < CHECKS_PER_RUN) calls += await this.lapse(conn, now, CHECKS_PER_RUN - calls);
    if (calls < CHECKS_PER_RUN && conn.payments.guaranteeFact) {
      calls += await this.guarantees(conn, now, CHECKS_PER_RUN - calls);
    }
    if (conn.payments.refunded && calls < CHECKS_PER_RUN) {
      refunded = await this.refunds(conn, now, CHECKS_PER_RUN - calls);
    }
    return { checked: calls, paid, closed, refunded };
  }

  /**
   * A shop asked what became of its orders, within a budget of calls: links waiting to be paid (or held)
   * on every look, since a shop cancels unpaid orders on its own; paid ones hourly while the order is
   * still being fulfilled. Answers how many calls it made.
   */
  private async orderStates(conn: PayConnection, now: number, budget: number): Promise<number> {
    const read = conn.payments.orderState;
    if (!read) return 0;
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS.split(", ")
        .map((c) => `p.${c}`)
        .join(", ")} FROM connector_payments p JOIN items i ON i.id = p.item_id
             WHERE p.connector_id = ? AND p.external_id IS NOT NULL
               AND (p.state = 'held' OR (p.state = 'paid' AND i.state IN ('paid', 'fulfilling', 'fulfilled')
                    AND (p.checked_at IS NULL OR p.checked_at < ?)))
             ORDER BY COALESCE(p.checked_at, 0) LIMIT ?`,
      params: [conn.id, now - HOUR_MS, budget],
      method: "all",
    });
    let calls = 0;
    for (const r of rows.map(rowOf)) {
      if (calls >= budget) break;
      calls++;
      try {
        const fact = await read(conn.ctx, { ref: r.id, externalId: r.externalId, itemId: r.itemId, paidAt: r.paidAt });
        await this.checked(r.id, now);
        if (fact) await this.applyOrder(conn, fact, now);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        await this.checked(r.id, now);
        if (error.code === "auth") {
          await this.host.failed(conn.id, error, now);
          break;
        }
      }
    }
    return calls;
  }

  /**
   * Refunds the inbox owes on orders paid through this connection, asked of the platform hourly: once
   * the dashboard refunded what is owed, the refund is marked done by the connector, against the
   * platform's own refund id. Answers how many were marked.
   */
  private async refunds(conn: PayConnection, now: number, budget: number): Promise<number> {
    const read = conn.payments.refunded;
    if (!read) return 0;
    const { rows } = await this.db.client.query({
      sql: `SELECT p.id, p.payment_id, r.id, json_extract(r.payload, '$.amount.value'), json_extract(r.payload, '$.amount.currency')
              FROM connector_payments p JOIN items r ON r.linked_item_id = p.item_id AND r.type = 'refund'
             WHERE p.connector_id = ? AND p.state = 'paid' AND p.payment_id IS NOT NULL AND p.livemode = ?
               AND r.state IN ('approved', 'goods_received')
               AND (p.checked_at IS NULL OR p.checked_at < ?)
             ORDER BY COALESCE(p.checked_at, 0) LIMIT ?`,
      params: [conn.id, conn.mode === "live" ? 1 : 0, now - HOUR_MS, budget],
      method: "all",
    });
    let marked = 0;
    for (const r of rows) {
      const payId = String(r[0]);
      const owed = { value: Number(r[3] ?? 0), currency: String(r[4] ?? "").toUpperCase() };
      try {
        const fact = await read(conn.ctx, { paymentId: String(r[1]) });
        await this.checked(payId, now);
        if (!fact || fact.amount.currency !== owed.currency || fact.amount.value < owed.value || owed.value <= 0)
          continue;
        await transitionItem(this.db, connectorCaller(conn.id, now, `refunded:${String(r[2])}`), {
          itemId: String(r[2]),
          event: "refund",
          input: { paymentRef: (fact.refundIds[0] ?? String(r[1])).slice(0, 200), amount: owed },
        });
        marked++;
      } catch (error) {
        if (error instanceof WriteError) continue;
        if (!(error instanceof ConnectorError)) throw error;
        await this.checked(payId, now);
        if (error.code === "auth") {
          await this.host.failed(conn.id, error, now);
          break;
        }
      }
    }
    return marked;
  }

  /* --- disconnecting ---------------------------------------------------------------- */

  /**
   * One step of disconnecting: up to `limit` live links closed here and switched off on the platform,
   * and the ones the platform could not be told yet told again. The connection, its key and its
   * webhook stay until none is left, so a payment made on a link in the meantime is still recorded.
   * Answers how many it closed and how many are left to switch off.
   */
  async closeForDisconnect(connectorId: string, now: number, limit: number): Promise<{ closed: number; left: number }> {
    // A link being made right now is left to its job, which makes no more for this connection: the
    // next step finds it made, and switches it off.
    const { rows: live } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments
             WHERE connector_id = ? AND (state IN ('open', 'held') OR (state = 'creating' AND (claim_until IS NULL OR claim_until < ?)))
             ORDER BY created_at LIMIT ?`,
      params: [connectorId, now, limit],
      method: "all",
    });
    let calls = 0;
    let closed = 0;
    for (const r of live.map(rowOf)) {
      const done = await this.db.client.query({
        sql: `UPDATE connector_payments SET state = 'closed', closed_at = ?, note = ?, claim_until = NULL, claimed_by = NULL,
                     retry_at = CASE WHEN external_id IS NULL THEN NULL ELSE ? END, updated_at = ?
               WHERE id = ? AND state IN ('creating', 'open', 'held')`,
        params: [now, DISCONNECTED, now, now, r.id],
        method: "run",
      });
      if (done.changes !== 1) continue;
      closed++;
      await this.dropOrderLink(r.itemId, r.url);
      if (r.externalId) {
        calls++;
        await this.tellClosed(r, now);
      }
    }
    const { rows: telling } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM connector_payments
             WHERE connector_id = ? AND state IN ('closed', 'failed') AND retry_at IS NOT NULL AND external_id IS NOT NULL
             ORDER BY retry_at LIMIT ?`,
      params: [connectorId, Math.max(limit - calls, 0)],
      method: "all",
    });
    for (const r of telling.map(rowOf)) await this.tellClosed(r, now);
    const { rows: left } = await this.db.client.query({
      sql: `SELECT COUNT(*) FROM connector_payments WHERE connector_id = ?
               AND (state IN ('creating', 'open', 'held') OR (state IN ('closed', 'failed') AND retry_at IS NOT NULL AND external_id IS NOT NULL))`,
      params: [connectorId],
      method: "all",
    });
    return { closed, left: Number(left[0]?.[0] ?? 0) };
  }

  /**
   * What the owner is told once a connection is gone: the orders still waiting to be paid whose link
   * went with it (to ask again), and the links that could not be switched off on the platform (to
   * switch off in its dashboard). Null when there is nothing to tell.
   */
  async disconnectNotice(connectorId: string, kind: string, dashboard: string | null): Promise<PayNotice | null> {
    const { rows: waiting } = await this.db.client.query({
      sql: `SELECT DISTINCT p.item_id FROM connector_payments p JOIN items i ON i.id = p.item_id
             WHERE p.connector_id = ? AND p.state = 'closed' AND p.note = ?
               AND i.state IN ('accepted', 'awaiting_payment', 'payment_failed')
               AND NOT EXISTS (SELECT 1 FROM connector_payments q WHERE q.item_id = p.item_id AND q.state IN ('creating', 'open', 'held', 'paid'))
             LIMIT 50`,
      params: [connectorId, DISCONNECTED],
      method: "all",
    });
    const { rows: unclosed } = await this.db.client.query({
      sql: `SELECT url FROM connector_payments
             WHERE connector_id = ? AND state IN ('closed', 'failed') AND retry_at IS NOT NULL AND external_id IS NOT NULL AND url IS NOT NULL
             LIMIT 50`,
      params: [connectorId],
      method: "all",
    });
    if (waiting.length === 0 && unclosed.length === 0) return null;
    return {
      reason: "disconnected",
      provider: this.provider(kind),
      waiting: waiting.map((r) => String(r[0])),
      unclosed: unclosed.map((r) => String(r[0])),
      dashboard,
    };
  }

  /** Nothing more is tried for a connection that is gone: no link of it waits to be told. */
  async forget(connectorId: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: `UPDATE connector_payments SET retry_at = NULL, updated_at = ? WHERE connector_id = ? AND retry_at IS NOT NULL`,
      params: [now, connectorId],
      method: "run",
    });
  }

  /* --- telling the owner -------------------------------------------------------- */

  /** One email to the owner about one link, once per reason (or per payment, for a second one). */
  private async notice(
    rowId: string,
    reason: PayNoticeReason,
    now: number,
    extra: Omit<PayNotice, "reason" | "payId"> = {},
    dedupeKey = `paynotice:${rowId}:${reason}${extra.paymentId ? `:${extra.paymentId}` : ""}`,
  ): Promise<void> {
    await this.db.batch([jobStatement(PAY_NOTICE_KIND, { payId: rowId, reason, ...extra }, now, { dedupeKey })]);
  }

  /** A link the platform would not make: told once per order and reason, however many times it was tried. */
  private async linkFailed(rowId: string, itemId: string, why: string, now: number): Promise<void> {
    await this.notice(rowId, "link_failed", now, {}, `paynotice:${itemId}:link_failed:${hashOf(why)}`);
  }

  /** A notice for a connection that is gone: carried whole by its job, since its rows go with it. */
  async noticeDisconnected(connectorId: string, notice: PayNotice, now: number): Promise<void> {
    await this.db.batch([
      jobStatement(PAY_NOTICE_KIND, notice, now, { dedupeKey: `paynotice:${connectorId}:disconnected` }),
    ]);
  }

  /** The words of a notice, or null when it no longer applies. */
  async noticeText(
    notice: PayNotice,
    appUrl: string,
  ): Promise<{ readonly subject: string; readonly text: string; readonly itemId: string | null } | null> {
    const base = appUrl ? appUrl.replace(/\/+$/, "") : "";
    if (notice.reason === "disconnected") {
      const provider = notice.provider ?? "The payment platform";
      const waiting = notice.waiting ?? [];
      const unclosed = notice.unclosed ?? [];
      const lines: string[] = [`${provider} is disconnected from your inbox.`];
      if (waiting.length > 0) {
        lines.push(
          "",
          waiting.length === 1
            ? `This order was waiting to be paid at a ${provider} link, which no longer works. Ask for payment again from the order:`
            : `These orders were waiting to be paid at a ${provider} link, which no longer works. Ask for payment again from each order:`,
          ...waiting.map((id) => `- ${shortRef(id)}${base ? `: ${base}/items/${id}` : ""}`),
        );
      }
      if (unclosed.length > 0) {
        lines.push(
          "",
          `${unclosed.length === 1 ? "This link" : "These links"} could not be switched off in ${provider}, so a payment there is not recorded here. Switch ${unclosed.length === 1 ? "it" : "them"} off in your ${provider} dashboard${notice.dashboard ? ` (${notice.dashboard})` : ""}:`,
          ...unclosed.map((u) => `- ${u}`),
        );
      }
      return { itemId: null, subject: `${provider} is disconnected`, text: lines.join("\n") };
    }
    if (!notice.payId) return null;
    const row = await this.row(notice.payId);
    if (!row) return null;
    const reason = notice.reason;
    const provider = this.provider(row.kind);
    const ref = shortRef(row.itemId);
    const open = base ? `${base}/items/${row.itemId}` : "";
    const money = (value: number | null, currency: string | null) =>
      value === null || currency === null ? "" : moneyIn({ value, currency }, "en");
    // A second payment on a link paid already is that payment, not the first.
    const second = notice.paymentId !== undefined;
    const paidValue = second ? (notice.amount?.value ?? null) : row.paidAmount;
    const paidCurrency = second ? (notice.amount?.currency ?? null) : row.paidCurrency;
    const page = second ? (notice.dashboardUrl ?? null) : row.dashboardUrl;
    const refund = page ? `Refund it in ${provider}: ${page}` : `Refund it in your ${provider} dashboard.`;
    switch (reason) {
      case "paid_after": {
        const order = await this.order(row.itemId);
        const state = order ? (STATE_WORDS[order.state] ?? order.state.replaceAll("_", " ")) : "gone";
        return {
          itemId: row.itemId,
          subject: `A payment for order ${ref} needs you`,
          text: [
            `The customer paid ${money(paidValue, paidCurrency)} for order ${ref} through ${provider}, but the order was ${state} by then, so it is not marked paid here.`,
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
            `A second payment of ${money(paidValue, paidCurrency)} arrived for order ${ref} through ${provider}. The order was paid already.`,
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
      case "shop_total": {
        if (row.state !== "held" || row.shopTotal === null || row.shopCurrency === null) return null;
        const shop = moneyIn({ value: row.shopTotal, currency: row.shopCurrency }, "en");
        const agreed = moneyIn({ value: row.amount, currency: row.currency }, "en");
        const more = row.shopCurrency === row.currency && row.shopTotal > row.amount;
        return {
          itemId: row.itemId,
          subject: `Order ${ref}: ${provider} counts another total`,
          text: [
            `${provider} counts order ${ref} at ${shop}, with the tax or delivery it adds. The customer accepted ${agreed}, so the link to pay was not sent.`,
            "",
            more
              ? `Propose the shop's total from the order${open ? ` (${open})` : ""}: the customer accepts it or not, and the link goes once they do. Or change the shop's tax or delivery settings and ask for payment again.`
              : `Check the order's prices and taxes in ${provider}, then ask for payment again from the order${open ? `: ${open}` : "."}`,
          ].join("\n"),
        };
      }
      case "shop_cancelled":
        return {
          itemId: row.itemId,
          subject: `Order ${ref} was cancelled in ${provider}`,
          text: [
            `The order ${provider} made for order ${ref} was cancelled there before it was paid, so its link to pay no longer works.`,
            "",
            `The order is still open in your inbox. Ask for payment again to send a new link, or cancel it there${open ? `: ${open}` : "."}`,
          ].join("\n"),
        };
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
      sql: `SELECT i.id, i.state, i.payload, i.sandbox, i.legacy_promise, p.contact
              FROM items i LEFT JOIN parties p ON p.id = i.party_id
             WHERE i.id = ? AND i.type = 'order'`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const payload = (parseJson(r[2]) ?? {}) as {
      totalPrice?: { value?: unknown; currency?: unknown };
      paymentUrl?: unknown;
      paymentRef?: unknown;
      orderedItem?: { productId?: unknown }[];
      change?: unknown;
      schedule?: unknown;
    };
    const contact = parseJson(r[5]) as { locale?: unknown } | null;
    const value = Number(payload.totalPrice?.value ?? 0);
    const state = String(r[1]);
    const lines = Array.isArray(payload.orderedItem) ? payload.orderedItem : [];
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
      changeOpen: payload.change !== undefined && payload.change !== null,
      staged: Array.isArray(payload.schedule) && payload.schedule.length > 0,
      productIds: lines.map((l) => (typeof l?.productId === "string" && l.productId ? l.productId : null)),
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
  /** A change to the order waits for an answer: what it comes to is not settled. */
  readonly changeOpen: boolean;
  /** Paid in a trade's stages (ADR-034 §4): the business asks for each; no link for the whole. */
  readonly staged: boolean;
  /** Each line's catalogue product, or null for a line named by whoever ordered. */
  readonly productIds: readonly (string | null)[];
  readonly locale: string | null;
}

export type PayNoticeReason =
  | "paid_after"
  | "paid_twice"
  | "amount_differs"
  | "link_failed"
  | "disconnected"
  /** A shop counts another total than the customer accepted: the link was not sent (ADR-030 §2). */
  | "shop_total"
  /** A shop cancelled an order it made for the inbox, unpaid: the link is closed, the order is the owner's. */
  | "shop_cancelled";

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

function viewOf(r: PayRow, provider: string): PaymentView {
  const differs =
    r.shopTotal !== null && r.shopCurrency !== null && (r.shopTotal !== r.amount || r.shopCurrency !== r.currency);
  return {
    id: r.id,
    kind: r.kind,
    provider,
    state: r.state,
    amount: { value: r.amount, currency: r.currency },
    url: r.state === "open" ? r.url : null,
    livemode: r.livemode,
    paid_at: r.paidAt,
    paid_amount:
      r.paidAmount !== null && r.paidCurrency !== null ? { value: r.paidAmount, currency: r.paidCurrency } : null,
    payment_id: r.state === "paid" ? r.paymentId : null,
    method: r.method,
    dashboard_url: r.dashboardUrl,
    error: r.state === "creating" || r.state === "error" ? r.lastError : null,
    note: r.note,
    created_at: r.createdAt,
    closed_at: r.closedAt,
    shop_total: differs ? { value: r.shopTotal as number, currency: r.shopCurrency as string } : null,
    propose_shop_total:
      r.state === "held" && differs && r.shopCurrency === r.currency && (r.shopTotal as number) > r.amount,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** An open link's first day: asked about on each five-minute sync (a little under, so no sync passes it by). */
const FIRST_DAY_EVERY_MS = 4 * 60_000;

/** Five minutes doubling, at most six hours. */
function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(attempts - 1, 0), 6 * HOUR_MS);
}

/** A short, stable fingerprint of a text, for a dedupe key (FNV-1a): never for anything secret. */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
