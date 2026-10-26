import { eq } from "drizzle-orm";
import { businessFacts } from "../customer/audience";
import { moneyIn, oneLine } from "../customer/format";
import { type CustomerLang, customerLang } from "../customer/lang";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { randomToken, ulid } from "../ids";
import { agreedOf, offerRows } from "../negotiation/offers";
import { items } from "../schema/tables";
import { hashText } from "../util/canonical";
import { WriteError } from "../write/errors";
import { appendThreadEntry } from "../write/thread";
import { transitionItem } from "../write/transition";
import { rowToItem } from "../write/views";
import { connectorCaller, type PayConnection, type PayHost, type PaymentLinks, providerOf } from "./payments";
import { type AgentCharge, type AgentChargeFailure, ConnectorError } from "./sdk";

/**
 * A customer's assistant pays an accepted order directly (ADR-042), with a one-time token its platform
 * got for this business — a Stripe Shared Payment Token, scoped by the platform and Stripe to the
 * business's Stripe profile, an amount, a currency and an expiry — charged once, on the business's own
 * account, with the restricted key the owner gave. Paid is recorded on the order as a link's payment is
 * (ADR-023): by the connector, so the receipt, the customer's email and the closing of any link follow
 * the way they always do. The money never passes the inbox, nor Surfing Dog.
 *
 * The rules that shape it:
 * - **The owner's switch, in person.** Off until the owner switches it on, with the key's permission
 *   asked then (with a request that makes nothing) and the Stripe profile assistants get tokens for.
 * - **Accept, then charge, then record.** Only an order the business accepted (or its rules did), with
 *   no change waiting, is charged, and only for exactly its total under the terms the customer
 *   confirmed (`terms_sha`). Nothing the assistant says widens the token: what it echoes of the token's
 *   limits can only refuse.
 * - **Once.** One attempt in flight, or one paid, per order; one row per token (its hash); one
 *   PaymentIntent per row (the platform's idempotency key is the row's id). A retry is answered, never
 *   charged again, and two assistants paying at once make one charge.
 * - **Test keys for test orders.** A test order is charged only on the test connection, a real one only
 *   on the live one, so a test token never pays a real order.
 * - **Never the token.** It is used for the one call and kept only as its SHA-256; no customer details go
 *   to the platform from here.
 * - **Plain failures.** A decline charges nothing and leaves the order as it was; the assistant is told
 *   what to do next in a code, and its person in the business's words.
 */

/** The order states an assistant may pay in: accepted, asked to pay, or a payment that did not go through. */
const PAYABLE: ReadonlySet<string> = new Set(["accepted", "awaiting_payment", "payment_failed"]);
/** Paid, and what follows. */
const PAID: ReadonlySet<string> = new Set(["paid", "fulfilling", "fulfilled", "completed"]);
/** Before the business said yes: nothing is charged yet. */
const BEFORE: ReadonlySet<string> = new Set(["received", "needs_info", "proposed"]);
/** An attempt is the request's for this long, past the slowest platform answer. */
const CLAIM_MS = 2 * 60_000;
/** Declined attempts allowed per order and per inbox in a day: enough for a person, too few for card testing. */
export const DECLINES_PER_ORDER = 5;
export const DECLINES_PER_INBOX = 30;
const DAY_MS = 86_400_000;
/**
 * An attempt the platform never answered (it was down, or the request was cut) waits for a retry with
 * its token for two hours, past a token's own life (an hour, unless its platform set less), and is then
 * said to the owner, so it holds the order no longer. One that is processing is asked about for a day.
 */
const LOST_CREATING_MS = 2 * 3_600_000;
const LOST_PROCESSING_MS = DAY_MS;
/**
 * An attempt the platform never answered is looked up by the inbox's own id once this long has passed
 * (its search trails a new payment by up to a minute). Not found by `NEVER_MADE_MS`, it was never made:
 * the order is free for another token, and a retry with the same one asks again under the same key.
 */
const LOOK_AFTER_MS = 3 * 60_000;
const NEVER_MADE_MS = 15 * 60_000;
/** A processing payment is asked about at most this often. */
const CHECK_EVERY_MS = 4 * 60_000;
/** Calls one settling run makes. */
const SETTLE_PER_RUN = 10;
/** The ID Stripe gives a business's profile, which assistants' platforms get tokens for. */
export const AGENT_PROFILE_RE = /^profile_[A-Za-z0-9_]{6,120}$/;
/** What the token is, for an assistant reading it: the provider's own page. */
const SPT_SPEC = "https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens";

/** How a platform takes assistants' tokens: Stripe's shared payment tokens. */
const HANDLERS: Readonly<Record<string, { readonly handler: "stripe_spt"; readonly psp: string }>> = {
  stripe: { handler: "stripe_spt", psp: "stripe" },
};

export type AgentPayState = "creating" | "processing" | "paid" | "declined" | "failed" | "cancelled" | "unknown";

interface AgentRow {
  readonly id: string;
  readonly itemId: string;
  readonly connectorId: string;
  readonly kind: string;
  readonly amount: number;
  readonly currency: string;
  readonly livemode: boolean;
  readonly termsSha: string;
  readonly state: AgentPayState;
  readonly externalId: string | null;
  readonly method: string | null;
  readonly paidAmount: number | null;
  readonly paidCurrency: string | null;
  readonly dashboardUrl: string | null;
  readonly failure: string | null;
  readonly lastError: string | null;
  readonly note: string | null;
  readonly claimUntil: number | null;
  readonly checkedAt: number | null;
  readonly recordedAt: number | null;
  readonly createdAt: number;
  readonly paidAt: number | null;
}

const COLUMNS =
  "id, item_id, connector_id, kind, amount, currency, livemode, terms_sha, state, external_id, method, paid_amount, paid_currency, dashboard_url, failure, last_error, note, claim_until, checked_at, recorded_at, created_at, paid_at";

function rowOf(r: readonly unknown[]): AgentRow {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r[0]),
    itemId: String(r[1]),
    connectorId: String(r[2]),
    kind: String(r[3]),
    amount: Number(r[4]),
    currency: String(r[5]),
    livemode: Number(r[6]) === 1,
    termsSha: String(r[7]),
    state: String(r[8]) as AgentPayState,
    externalId: s(r[9]),
    method: s(r[10]),
    paidAmount: n(r[11]),
    paidCurrency: s(r[12]),
    dashboardUrl: s(r[13]),
    failure: s(r[14]),
    lastError: s(r[15]),
    note: s(r[16]),
    claimUntil: n(r[17]),
    checkedAt: n(r[18]),
    recordedAt: n(r[19]),
    createdAt: Number(r[20]),
    paidAt: n(r[21]),
  };
}

/** The owner's switch on a connection, as its config holds it. */
export interface AgentPaySettings {
  readonly on: boolean;
  readonly profile: string | null;
  /** Why the inbox switched it off itself (the key lost the permission); null otherwise. */
  readonly stopped: string | null;
}

/** What an assistant needs to pay an order directly, on the status door (`payment.agent`). */
export interface AgentPayOffer {
  readonly handler: "stripe_spt";
  readonly psp: string;
  /** The business's profile on the provider: what the assistant's platform gets the token for. */
  readonly business_profile: string;
  readonly environment: "livemode" | "testmode";
  /** Exactly what is charged, in the currency's own minor unit (ISO 4217). */
  readonly amount: Money;
  /** The same, as the provider counts it (Stripe writes ISK in hundredths): the token's limit. */
  readonly platform_amount: { readonly value: number; readonly currency: string } | null;
  /** The terms the customer confirmed: send it back with the token. */
  readonly terms_sha: string;
  /** What the token is for: this order. */
  readonly binding_id: string;
  readonly spec: string;
}

/** An order's payment as its customer's assistant reads it (`payment` on the status door). */
export interface OrderPayment {
  readonly state: "due" | "processing" | "paid";
  readonly amount: Money;
  /** The business's link to pay, while one is open: for the person, when the assistant cannot pay. */
  readonly payment_url: string | null;
  /** How the assistant pays it itself, when the business takes that; null otherwise. */
  readonly agent: AgentPayOffer | null;
  /** What to tell the person, in the business's words and language. */
  readonly human: string;
}

/** One payment by an assistant, as the owner app shows it: never the token, nothing about the customer. */
export interface AgentPaymentView {
  readonly id: string;
  readonly via: "agent";
  readonly provider: string;
  readonly state: AgentPayState;
  readonly amount: Money;
  readonly livemode: boolean;
  readonly payment_id: string | null;
  readonly method: string | null;
  readonly paid_amount: Money | null;
  readonly paid_at: number | null;
  /** The payment in the business's own dashboard: where it is refunded. */
  readonly dashboard_url: string | null;
  /** Why it did not go through, as the assistant was told; the platform's own words are in `error`. */
  readonly failure: string | null;
  readonly error: string | null;
  readonly note: string | null;
  readonly created_at: number;
}

export interface PayOrderRequest {
  readonly itemId: string;
  readonly termsSha: string;
  readonly token: string;
  /** What the assistant's platform says the token allows: it can only refuse, never widen what Stripe holds it to. */
  readonly allowance?:
    | { readonly max_amount: number; readonly currency: string; readonly expires_at?: string | undefined }
    | undefined;
  readonly door: "mcp" | "rest";
}

export interface PayOrderOutcome {
  /** `paid`: the money is the business's and the order says so. `processing`: the platform settles it later. */
  readonly state: "paid" | "processing";
  readonly amount: Money;
}

interface OrderFacts {
  readonly id: string;
  readonly state: string;
  readonly total: Money;
  readonly sandbox: boolean;
  readonly changeOpen: boolean;
  readonly paymentUrl: string | null;
  readonly locale: string | null;
  readonly createdAt: number;
}

/** The words the customer reads about paying, through their assistant, in the business's voice. */
const WORDS: Readonly<
  Record<
    CustomerLang,
    {
      readonly payNow: (b: string | null, amount: string) => string;
      readonly due: (amount: string) => string;
      readonly processing: (amount: string) => string;
      readonly paid: (amount: string) => string;
      readonly declined: string;
      readonly confirm: (link: boolean) => string;
      readonly label: string;
    }
  >
> = {
  en: {
    payNow: (b, amount) => (b ? `You can pay ${b} now: ${amount}.` : `You can pay now: ${amount}.`),
    due: (amount) => `${amount} to pay.`,
    processing: (amount) => `Your payment of ${amount} is on its way.`,
    paid: (amount) => `Paid, thank you: ${amount}.`,
    declined: "The payment did not go through: the card was declined. Nothing was charged.",
    confirm: (link) =>
      link
        ? "Your card asks you to confirm this payment yourself: pay at this link."
        : "Your card asks you to confirm this payment yourself. Nothing was charged.",
    label: "Pay now",
  },
  pt: {
    payNow: (b, amount) => (b ? `Pode pagar a ${b} agora: ${amount}.` : `Pode pagar agora: ${amount}.`),
    due: (amount) => `${amount} por pagar.`,
    processing: (amount) => `O seu pagamento de ${amount} está a caminho.`,
    paid: (amount) => `Pago, obrigado: ${amount}.`,
    declined: "O pagamento não foi feito: o cartão foi recusado. Nada foi cobrado.",
    confirm: (link) =>
      link
        ? "O seu cartão pede que confirme este pagamento: pague neste link."
        : "O seu cartão pede que confirme este pagamento. Nada foi cobrado.",
    label: "Pagar agora",
  },
};

/** Every sentence above, for the customer-copy check. */
export function agentPayWords(lang: CustomerLang): string[] {
  const w = WORDS[lang];
  return [
    w.payNow("Fjordbrød Bakery", "kr 189,00"),
    w.payNow(null, "kr 189,00"),
    w.due("kr 189,00"),
    w.processing("kr 189,00"),
    w.paid("kr 189,00"),
    w.declined,
    w.confirm(true),
    w.confirm(false),
    w.label,
  ];
}

/** The label of the status door's `next` entry for paying, in the customer's language. */
export const payNowLabel = (lang: CustomerLang) => WORDS[lang].label;

export class AgentPayments {
  constructor(
    private readonly host: PayHost,
    private readonly links: PaymentLinks,
  ) {}

  private get db(): Db {
    return this.host.db;
  }

  /* --- the owner's switch ---------------------------------------------------------- */

  async settingsOf(connectorId: string): Promise<AgentPaySettings> {
    const { rows } = await this.db.client.query({
      sql: `SELECT json_extract(config_public, '$.agentPay'), json_extract(config_public, '$.agentProfile'),
                   json_extract(config_public, '$.agentPayStopped')
              FROM connectors WHERE id = ?`,
      params: [connectorId],
      method: "all",
    });
    const r = rows[0] ?? [];
    return {
      on: Number(r[0] ?? 0) === 1,
      profile: typeof r[1] === "string" && r[1] ? r[1] : null,
      stopped: typeof r[2] === "string" && r[2] ? r[2] : null,
    };
  }

  /** Whether a connection's platform takes assistants' tokens here at all. */
  takes(kind: string, payments: PayConnection["payments"] | undefined): boolean {
    return Boolean(HANDLERS[kind] && payments?.chargeToken && payments.agentPayPermissions);
  }

  /**
   * Switches assistants' direct payments on or off for a connection, and sets the profile they pay. On
   * asks the key, then and only then, for the permission it needs (with a request that makes nothing),
   * and answers with what it lacks, writing nothing; a profile is needed. Off takes effect at once. The
   * caller is the owner in person: never their AI, never a key (`ConnectorCapabilities.update`).
   */
  async setAgentPay(
    connectorId: string,
    change: { readonly on?: boolean | undefined; readonly profile?: string | undefined },
    now: number,
  ): Promise<{ readonly on: boolean; readonly missing: readonly string[] }> {
    const conn = await this.host.payConnection(connectorId, now);
    if (!conn) throw new WriteError("not_found", "no such payment connection");
    const current = await this.settingsOf(connectorId);
    if (!this.takes(conn.kind, conn.payments)) {
      throw new WriteError("invalid_input", `${providerOf(conn.kind)} takes no payments from assistants here.`, {
        fields: [{ path: "agent_pay", problem: "invalid", message: "this platform takes no payments from assistants" }],
      });
    }
    const profile = change.profile?.trim();
    if (profile !== undefined && !AGENT_PROFILE_RE.test(profile)) {
      throw new WriteError("invalid_input", "A Stripe profile ID starts with profile_.", {
        fields: [{ path: "agent_profile", problem: "invalid", message: "starts with profile_" }],
      });
    }
    const on = change.on ?? current.on;
    const nextProfile = profile ?? current.profile;
    if (on && !nextProfile) {
      throw new WriteError("invalid_input", "Give the Stripe profile ID assistants pay you through.", {
        fields: [{ path: "agent_profile", problem: "missing", message: "your Stripe profile ID (profile_…)" }],
      });
    }
    if (on && (!current.on || change.on === true)) {
      const missing = await this.probe(conn);
      if (missing.length > 0) return { on: false, missing };
    }
    await this.db.client.query({
      sql: `UPDATE connectors SET config_public = json_set(config_public, '$.agentPay', json(?), '$.agentProfile', ?,
                   '$.agentPayAt', ?, '$.agentPayStopped', NULL), updated_at = ? WHERE id = ?`,
      params: [on ? "true" : "false", nextProfile ?? null, now, now, connectorId],
      method: "run",
    });
    return { on, missing: [] };
  }

  private async probe(conn: PayConnection): Promise<readonly string[]> {
    try {
      return (await conn.payments.agentPayPermissions?.(conn.ctx)) ?? [];
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new WriteError("invalid_input", error.message, {
          fields: [{ path: "agent_pay", problem: "invalid", message: error.message }],
        });
      }
      throw error;
    }
  }

  /** The connection that takes assistants' payments for orders of this mode, opened, with its profile. */
  private async connectionFor(
    mode: "live" | "test",
    now: number,
  ): Promise<{ readonly conn: PayConnection; readonly profile: string } | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT id, json_extract(config_public, '$.agentProfile') FROM connectors
             WHERE kind <> 'feed' AND status <> 'disabled' AND json_extract(config_public, '$.agentPay') = 1
               AND json_extract(config_public, '$.disconnectingAt') IS NULL AND json_extract(config_public, '$.mode') = ?
             ORDER BY created_at DESC LIMIT 3`,
      params: [mode],
      method: "all",
    });
    for (const r of rows) {
      const profile = typeof r[1] === "string" ? r[1] : "";
      if (!AGENT_PROFILE_RE.test(profile)) continue;
      const conn = await this.host.payConnection(String(r[0]), now);
      if (conn && this.takes(conn.kind, conn.payments)) return { conn, profile };
    }
    return null;
  }

  /** Whether any connection takes assistants' payments now: the profile says so (`acp_delegated`), the public MCP has the tool. */
  async anyOn(): Promise<boolean> {
    const { rows } = await this.db.client.query({
      sql: `SELECT 1 FROM connectors WHERE kind <> 'feed' AND status <> 'disabled'
              AND json_extract(config_public, '$.agentPay') = 1 AND json_extract(config_public, '$.disconnectingAt') IS NULL
              AND json_extract(config_public, '$.agentProfile') IS NOT NULL LIMIT 1`,
      params: [],
      method: "all",
    });
    return rows.length > 0;
  }

  /** How many orders assistants paid through this connection. */
  async paidCount(connectorId: string): Promise<number> {
    const { rows } = await this.db.client.query({
      sql: "SELECT COUNT(*) FROM agent_payments WHERE connector_id = ? AND state = 'paid'",
      params: [connectorId],
      method: "all",
    });
    return Number(rows[0]?.[0] ?? 0);
  }

  /* --- what the status door says --------------------------------------------------- */

  /**
   * An order's payment as its customer's assistant reads it: what it comes to and whether it is due,
   * on its way or paid; the business's link while one is open; and, when the business takes payments
   * from assistants and the order can be paid now, how (`agent`). Null before the order is accepted,
   * and for one that comes to nothing.
   */
  async paymentOf(itemId: string, agreedSha: string | null, now: number): Promise<OrderPayment | null> {
    const order = await this.order(itemId);
    if (!order || order.total.value <= 0) return null;
    if (!PAYABLE.has(order.state) && !PAID.has(order.state)) return null;
    const { lang, business } = await this.voice(order);
    const amount = moneyIn(order.total, lang);
    const w = WORDS[lang];
    if (PAID.has(order.state)) {
      return { state: "paid", amount: order.total, payment_url: null, agent: null, human: w.paid(amount) };
    }
    const rows = await this.rowsFor(itemId);
    if (rows.some((r) => r.state === "processing" || r.state === "creating")) {
      return {
        state: "processing",
        amount: order.total,
        payment_url: null,
        agent: null,
        human: w.processing(amount),
      };
    }
    const agent = order.changeOpen || !agreedSha ? null : await this.offerFor(order, agreedSha, now);
    return {
      state: "due",
      amount: order.total,
      payment_url: order.paymentUrl,
      agent,
      human: agent ? w.payNow(business, amount) : w.due(amount),
    };
  }

  private async offerFor(order: OrderFacts, agreedSha: string, now: number): Promise<AgentPayOffer | null> {
    const found = await this.connectionFor(order.sandbox ? "test" : "live", now);
    if (!found) return null;
    const { conn, profile } = found;
    if (conn.payments.currencyProblem?.(order.total)) return null;
    const handler = HANDLERS[conn.kind];
    if (!handler) return null;
    return {
      handler: handler.handler,
      psp: handler.psp,
      business_profile: profile,
      environment: conn.mode === "live" ? "livemode" : "testmode",
      amount: order.total,
      platform_amount: conn.payments.platformAmount?.(order.total) ?? null,
      terms_sha: agreedSha,
      binding_id: order.id,
      spec: SPT_SPEC,
    };
  }

  /* --- paying ---------------------------------------------------------------------- */

  /**
   * An assistant pays an order with its platform's one-time token. Every check is made before the
   * platform is asked anything; then the attempt is claimed (one in flight per order, one per token),
   * charged once, and a payment that went through is recorded on the order by the connector. The
   * caller is the order's own customer (`Capabilities.payOrder`).
   */
  async pay(req: PayOrderRequest, now: number): Promise<PayOrderOutcome> {
    const order = await this.order(req.itemId);
    if (!order) throw new WriteError("not_found", "no such order", { details: { item_id: req.itemId } });
    this.checkState(order, now);
    const found = await this.connectionFor(order.sandbox ? "test" : "live", now);
    if (!found) {
      throw unavailable(
        (await this.anyOn()) ? "no_connection" : "off",
        order.sandbox
          ? "This business takes no payment from assistants for test orders. Give your person payment_url instead."
          : "This business takes no payment from assistants. Give your person payment_url instead.",
      );
    }
    const { conn } = found;
    const agreed = agreedOf(await offerRows(this.db, order.id));
    if (!agreed || agreed.termsSha !== req.termsSha) {
      throw new WriteError(
        "terms_changed",
        "These are not the terms the order stands on now: read get_item_status, show your person the order as it is, and pay with its agreed.terms_sha on their yes, with a token for its total.",
        { details: { terms_sha: agreed?.termsSha ?? null, amount: order.total } },
      );
    }
    const currencyWhy = conn.payments.currencyProblem?.(order.total) ?? null;
    if (currencyWhy) {
      throw unavailable("currency", `This business takes no payment from assistants in ${order.total.currency}.`);
    }
    if (req.allowance) this.checkAllowance(req.allowance, order.total, conn, now);
    const credential = await hashText(`spt:${req.token}`);
    const seen = await this.rowByCredential(credential);
    if (seen) return this.again(seen, req, order, conn, now);
    await this.checkAttempts(order.id, now);
    // The attempt, claimed: one in flight or paid per order (`agent_payments_live`), one per token.
    const id = ulid(now);
    const claim = randomToken(12);
    const inserted = await this.db.client.query({
      sql: `INSERT OR IGNORE INTO agent_payments
              (id, item_id, connector_id, kind, handler, door, amount, currency, livemode, terms_sha, credential_sha,
               state, claim_until, claimed_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?)`,
      params: [
        id,
        order.id,
        conn.id,
        conn.kind,
        HANDLERS[conn.kind]?.handler ?? conn.kind,
        req.door,
        order.total.value,
        order.total.currency,
        conn.mode === "live" ? 1 : 0,
        req.termsSha,
        credential,
        now + CLAIM_MS,
        claim,
        now,
        now,
      ],
      method: "run",
    });
    if (inserted.changes !== 1) {
      const again = await this.rowByCredential(credential);
      if (again) return this.again(again, req, order, conn, now);
      // Another attempt holds the order: one on its way, or one that went through a moment ago.
      if ((await this.rowsFor(order.id)).some((r) => r.state === "paid")) {
        throw new WriteError("already_paid", "This order is paid already: there is nothing to pay.", {
          details: { state: "paid" },
        });
      }
      throw inProgress();
    }
    const row = await this.row(id);
    if (!row) throw inProgress();
    return this.charge(row, req.token, order, conn, claim, now);
  }

  private checkState(order: OrderFacts, now: number): void {
    if (PAID.has(order.state)) {
      throw new WriteError("already_paid", "This order is paid already: there is nothing to pay.", {
        details: { state: order.state },
      });
    }
    if (BEFORE.has(order.state)) {
      const fresh = now - order.createdAt < 60_000 && order.state === "received";
      throw new WriteError(
        "not_accepted_yet",
        order.state === "received"
          ? "The business has not accepted this order yet, and nothing is charged before it does: read get_item_status again shortly."
          : "This order waits for your person's answer before it can be paid: read get_item_status.",
        {
          details: {
            waiting_on: order.state === "received" ? "us" : "you",
            ...(fresh ? { retry_after_s: 2 } : {}),
          },
        },
      );
    }
    if (!PAYABLE.has(order.state)) {
      throw new WriteError(
        "wrong_state",
        `This order is ${order.state.replaceAll("_", " ")}: there is nothing to pay.`,
        {
          details: { state: order.state },
        },
      );
    }
    if (order.changeOpen) {
      throw new WriteError(
        "change_pending",
        "A change to this order waits for an answer, so what it comes to is not settled: pay once it is answered.",
      );
    }
    if (order.total.value <= 0)
      throw unavailable("zero_total", "This order comes to nothing: there is nothing to pay.");
  }

  /** What the assistant echoes of the token can only refuse: the same currency, enough for the total, not expired. */
  private checkAllowance(
    allowance: NonNullable<PayOrderRequest["allowance"]>,
    total: Money,
    conn: PayConnection,
    now: number,
  ): void {
    const platform = conn.payments.platformAmount?.(total) ?? { value: total.value, currency: total.currency };
    if (allowance.currency.toLowerCase() !== total.currency.toLowerCase() || allowance.max_amount < platform.value) {
      throw new WriteError(
        "token_limit",
        `The token allows less than this order's total, or another currency: get one for ${platform.value} ${platform.currency.toLowerCase()} (payment.agent.platform_amount).`,
        { details: { platform_amount: platform } },
      );
    }
    if (allowance.expires_at !== undefined && Date.parse(allowance.expires_at) <= now) {
      throw new WriteError("token_expired", "The token has expired: get a new one for this order.");
    }
  }

  private async checkAttempts(itemId: string, now: number): Promise<void> {
    const { rows } = await this.db.client.query({
      sql: `SELECT SUM(CASE WHEN item_id = ? THEN 1 ELSE 0 END), COUNT(*) FROM agent_payments
             WHERE state IN ('declined', 'cancelled') AND created_at > ?`,
      params: [itemId, now - DAY_MS],
      method: "all",
    });
    const order = Number(rows[0]?.[0] ?? 0);
    const inbox = Number(rows[0]?.[1] ?? 0);
    if (order >= DECLINES_PER_ORDER || inbox >= DECLINES_PER_INBOX) {
      throw new WriteError(
        "too_many_attempts",
        "Too many payments for this order did not go through today: give your person payment_url instead.",
      );
    }
  }

  /** A token sent before: answered as it went, or, for an attempt left unanswered, charged again under the same key. */
  private async again(
    row: AgentRow,
    req: PayOrderRequest,
    order: OrderFacts,
    conn: PayConnection,
    now: number,
  ): Promise<PayOrderOutcome> {
    if (row.itemId !== order.id) {
      throw new WriteError("token_used", "This token was used for another order: get a new one for this order.");
    }
    switch (row.state) {
      case "paid":
        return { state: "paid", amount: { value: row.amount, currency: row.currency } };
      case "processing":
        return { state: "processing", amount: { value: row.amount, currency: row.currency } };
      case "creating": {
        if (row.claimUntil !== null && row.claimUntil > now) throw inProgress();
        // Left unanswered (the platform was down, or the request was cut): asked again under the same
        // idempotency key, so the platform answers what it did, and charges nothing twice.
        if (row.connectorId !== conn.id || row.termsSha !== req.termsSha) throw inProgress();
        const claim = randomToken(12);
        const taken = await this.db.client.query({
          sql: `UPDATE agent_payments SET claim_until = ?, claimed_by = ?, updated_at = ?
                 WHERE id = ? AND state = 'creating' AND (claim_until IS NULL OR claim_until < ?)`,
          params: [now + CLAIM_MS, claim, now, row.id, now],
          method: "run",
        });
        if (taken.changes !== 1) throw inProgress();
        return this.charge(row, req.token, order, conn, claim, now);
      }
      case "failed": {
        // Never made (the platform did not answer, and has no charge of ours under its id): asked again
        // under the same key, so a charge the platform made after all is answered, never made twice.
        if (row.failure !== "lost" || row.connectorId !== conn.id || row.termsSha !== req.termsSha) {
          throw this.failureError((row.failure ?? "declined") as AgentChargeFailure, order, await this.voice(order));
        }
        const claim = randomToken(12);
        let taken: { changes: number };
        try {
          taken = await this.db.client.query({
            sql: `UPDATE agent_payments SET state = 'creating', failure = NULL, claim_until = ?, claimed_by = ?, updated_at = ?
                   WHERE id = ? AND state = 'failed' AND failure = 'lost'`,
            params: [now + CLAIM_MS, claim, now, row.id],
            method: "run",
          });
        } catch (error) {
          // Another attempt holds the order now (`agent_payments_live`).
          if (String(error).includes("UNIQUE")) throw inProgress();
          throw error;
        }
        if (taken.changes !== 1) throw inProgress();
        return this.charge(row, req.token, order, conn, claim, now);
      }
      default:
        throw this.failureError((row.failure ?? "declined") as AgentChargeFailure, order, await this.voice(order));
    }
  }

  private async charge(
    row: AgentRow,
    token: string,
    order: OrderFacts,
    conn: PayConnection,
    claim: string,
    now: number,
  ): Promise<PayOrderOutcome> {
    const charge = conn.payments.chargeToken;
    if (!charge) throw unavailable("off", "This business takes no payment from assistants.");
    const title = (await this.links.chargeTitle(order.id)) ?? `Order ${row.id.slice(-6).toUpperCase()}`;
    let answer: AgentCharge;
    try {
      answer = await charge(conn.ctx, {
        ref: row.id,
        itemId: order.id,
        amount: order.total,
        token,
        title,
        reference: order.id.slice(-6).toUpperCase(),
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      return this.platformFailed(row, conn, claim, error, now);
    }
    const voice = await this.voice(order);
    switch (answer.status) {
      case "succeeded":
        await this.paid(row, conn, answer, now, claim);
        return { state: "paid", amount: order.total };
      case "processing": {
        await this.settleRow(row.id, claim, now, {
          state: "processing",
          externalId: answer.externalId,
          dashboardUrl: answer.dashboardUrl ?? null,
        });
        return { state: "processing", amount: order.total };
      }
      case "requires_action": {
        // Delegated authentication is not taken here: the charge is stopped, so it is never taken later,
        // and the person pays at the business's link instead.
        if (answer.externalId && conn.payments.cancelCharge) {
          await conn.payments.cancelCharge(conn.ctx, { externalId: answer.externalId }).catch(() => undefined);
        }
        await this.settleRow(row.id, claim, now, {
          state: "cancelled",
          externalId: answer.externalId,
          failure: "authentication_required",
          lastError: "the card asked its holder to confirm the payment",
        });
        throw this.failureError("authentication_required", order, voice);
      }
      default: {
        const code = answer.failure?.code ?? "declined";
        await this.settleRow(row.id, claim, now, {
          state: code === "declined" || code === "authentication_required" ? "declined" : "failed",
          externalId: answer.externalId,
          failure: code,
          lastError: [answer.failure?.platformCode, answer.failure?.message].filter(Boolean).join(": ") || null,
        });
        throw this.failureError(code, order, voice, await this.declinesLeft(order.id, now));
      }
    }
  }

  /** The platform could not be asked, or refused the key: said to the assistant as what to do next. */
  private async platformFailed(
    row: AgentRow,
    conn: PayConnection,
    claim: string,
    error: ConnectorError,
    now: number,
  ): Promise<never> {
    if (error.code === "unreachable" || error.code === "rate_limited") {
      // Left creating, unclaimed: the same token and idempotency key ask again, and the platform answers
      // what it did with the first, so nothing is charged twice.
      await this.db.client.query({
        sql: `UPDATE agent_payments SET claim_until = NULL, claimed_by = NULL, last_error = ?, last_error_at = ?, updated_at = ?
               WHERE id = ? AND claimed_by = ?`,
        params: [error.message.slice(0, 500), now, now, row.id, claim],
        method: "run",
      });
      throw new WriteError(
        "platform_unavailable",
        "The payment platform did not answer: retry shortly with the same token and idempotency_key. It is never charged twice.",
        { details: { retry_after_s: Math.max(2, Math.ceil((error.retryAfterMs ?? 5_000) / 1000)) } },
      );
    }
    await this.settleRow(row.id, claim, now, { state: "failed", failure: "connection", lastError: error.message });
    if (error.code === "config" || error.code === "auth") {
      // The key no longer may: switched off, said on the connection and to the owner once.
      const why =
        error.code === "auth"
          ? "Stripe no longer takes this key."
          : "Stripe stopped taking payments from assistants for your inbox: the key no longer has PaymentIntents: Write. Assistants are sent your payment link.";
      await this.db.client.query({
        sql: `UPDATE connectors SET config_public = json_set(config_public, '$.agentPay', json('false'), '$.agentPayStopped', ?),
                     updated_at = ? WHERE id = ?`,
        params: [why, now, conn.id],
        method: "run",
      });
      await this.host.failed(conn.id, new ConnectorError("config", why), now);
      throw unavailable(
        "connection",
        "This business takes no payment from assistants just now. Give your person payment_url instead.",
      );
    }
    throw unavailable(
      "refused",
      "The payment platform would not take this payment: give your person payment_url instead.",
    );
  }

  private async declinesLeft(itemId: string, now: number): Promise<number> {
    const { rows } = await this.db.client.query({
      sql: "SELECT COUNT(*) FROM agent_payments WHERE item_id = ? AND state IN ('declined', 'cancelled') AND created_at > ?",
      params: [itemId, now - DAY_MS],
      method: "all",
    });
    return Math.max(0, DECLINES_PER_ORDER - Number(rows[0]?.[0] ?? 0));
  }

  private failureError(
    code: AgentChargeFailure | string,
    order: OrderFacts,
    voice: { readonly lang: CustomerLang },
    attemptsLeft?: number,
  ): WriteError {
    const w = WORDS[voice.lang];
    switch (code) {
      case "authentication_required":
        return new WriteError(
          "authentication_required",
          order.paymentUrl
            ? "The card asks its holder to confirm this payment, which cannot be done here: nothing was charged. Give your person payment_url."
            : "The card asks its holder to confirm this payment, which cannot be done here: nothing was charged. Ask your person for another way to pay.",
          { details: { payment_url: order.paymentUrl, human: w.confirm(order.paymentUrl !== null) } },
        );
      case "token_invalid":
        return new WriteError(
          "token_invalid",
          "The payment platform does not know this token for this business: get a new one for payment.agent.business_profile, in payment.agent.environment.",
        );
      case "token_expired":
        return new WriteError("token_expired", "The token has expired: get a new one for this order.");
      case "token_used":
        return new WriteError("token_used", "The token was used or revoked: get a new one for this order.");
      case "token_limit":
        return new WriteError(
          "token_limit",
          "The token allows less than this order's total, or another currency: get one for payment.agent.platform_amount.",
        );
      case "connection":
        return unavailable(
          "connection",
          "This business takes no payment from assistants just now. Give your person payment_url instead.",
        );
      default:
        return new WriteError(
          "payment_declined",
          "The card was declined, and nothing was charged: ask your person for another card, and pay with a new token.",
          { details: { human: w.declined, ...(attemptsLeft !== undefined ? { attempts_left: attemptsLeft } : {}) } },
        );
    }
  }

  /**
   * A charge that went through: the attempt marked paid (a compare-and-set, so a retry and a sync that
   * meet record it once), then the payment on the order, by the connector, which issues the receipt and
   * the customer's email, and closes any link. A payment the order cannot take (it was cancelled or paid
   * meanwhile) is kept on the attempt and the owner told where to refund it.
   */
  private async paid(row: AgentRow, conn: PayConnection, charge: AgentCharge, now: number, claim?: string) {
    const amount = charge.amount ?? { value: row.amount, currency: row.currency };
    const marked = await this.db.client.query({
      sql: `UPDATE agent_payments SET state = 'paid', external_id = COALESCE(?, external_id), method = ?, paid_amount = ?,
                   paid_currency = ?, dashboard_url = COALESCE(?, dashboard_url), paid_at = ?, claim_until = NULL, claimed_by = NULL,
                   checked_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('creating', 'processing')${claim ? " AND (claimed_by = ? OR claimed_by IS NULL)" : ""}`,
      params: [
        charge.externalId,
        charge.method?.slice(0, 40) ?? null,
        amount.value,
        amount.currency,
        charge.dashboardUrl?.slice(0, 500) ?? null,
        now,
        now,
        now,
        row.id,
        ...(claim ? [claim] : []),
      ],
      method: "run",
    });
    if (marked.changes !== 1) return;
    await this.record(
      { ...row, state: "paid", externalId: charge.externalId ?? row.externalId, method: charge.method ?? null },
      conn.id,
      amount,
      now,
    );
  }

  /** The payment on the order, once: by the connector, as a link's is. */
  private async record(row: AgentRow, connectorId: string, amount: Money, now: number): Promise<void> {
    const paymentRef = (row.externalId ?? row.id).slice(0, 200);
    try {
      await transitionItem(this.db, connectorCaller(connectorId, now, `agentpay:${row.id}`), {
        itemId: row.itemId,
        event: "record_payment",
        input: { paymentRef, amount, ...(row.method ? { method: row.method.slice(0, 40) } : {}) },
      });
    } catch (error) {
      if (error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed")) {
        await this.paidAfter(row, now);
        return;
      }
      // Ours to settle: the attempt stays paid and unrecorded, and the next sync records it.
      await this.db.client.query({
        sql: "UPDATE agent_payments SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
        params: [`not recorded: ${String((error as Error)?.message ?? error)}`.slice(0, 500), now, now, row.id],
        method: "run",
      });
      return;
    }
    await this.db.client.query({
      sql: "UPDATE agent_payments SET recorded_at = ?, updated_at = ? WHERE id = ? AND recorded_at IS NULL",
      params: [now, now, row.id],
      method: "run",
    });
  }

  /** A payment the order could not take (cancelled, or paid another way meanwhile): kept, and the owner told where to refund it. */
  private async paidAfter(row: AgentRow, now: number): Promise<void> {
    const provider = providerOf(row.kind);
    const fresh = await this.row(row.id);
    const where = fresh?.dashboardUrl ? ` ${fresh.dashboardUrl}` : "";
    const note = `Paid by the customer's assistant after the order could no longer take it: refund it in ${provider} if it is not wanted.`;
    const updated = await this.db.client.query({
      sql: "UPDATE agent_payments SET note = ?, recorded_at = ?, updated_at = ? WHERE id = ? AND note IS NULL",
      params: [note, now, now, row.id],
      method: "run",
    });
    if (updated.changes !== 1) return;
    const [item] = await this.db.orm.select().from(items).where(eq(items.id, row.itemId));
    if (!item) return;
    await appendThreadEntry(
      this.db,
      connectorCaller(row.connectorId, now),
      rowToItem(item),
      `${note}${where}`.slice(0, 1000),
      "note",
    );
  }

  private async settleRow(
    id: string,
    claim: string | null,
    now: number,
    to: {
      readonly state: AgentPayState;
      readonly externalId?: string | null;
      readonly dashboardUrl?: string | null;
      readonly failure?: string;
      readonly lastError?: string | null;
    },
  ): Promise<void> {
    await this.db.client.query({
      sql: `UPDATE agent_payments SET state = ?, external_id = COALESCE(?, external_id), dashboard_url = COALESCE(?, dashboard_url),
                   failure = COALESCE(?, failure), last_error = COALESCE(?, last_error),
                   last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END,
                   claim_until = NULL, claimed_by = NULL, checked_at = ?, updated_at = ?
             WHERE id = ?${claim ? " AND claimed_by = ?" : ""}`,
      params: [
        to.state,
        to.externalId ?? null,
        to.dashboardUrl ?? null,
        to.failure ?? null,
        to.lastError?.slice(0, 500) ?? null,
        to.lastError ?? null,
        now,
        now,
        now,
        id,
        ...(claim ? [claim] : []),
      ],
      method: "run",
    });
  }

  /* --- after the request: what the platform settles later ---------------------- */

  /**
   * On each sync: payments that were processing, asked of the platform until it says; paid ones not yet
   * on their order, recorded; an attempt the platform never answered, asked again under its key for a
   * day, then said to the owner. Answers how many calls it made.
   */
  async settle(conn: PayConnection, now: number): Promise<number> {
    const read = conn.payments.agentCharge;
    let calls = 0;
    const { rows: unrecorded } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE connector_id = ? AND state = 'paid' AND recorded_at IS NULL LIMIT 5`,
      params: [conn.id],
      method: "all",
    });
    for (const r of unrecorded.map(rowOf)) {
      await this.record(r, conn.id, { value: r.paidAmount ?? r.amount, currency: r.paidCurrency ?? r.currency }, now);
    }
    if (!read) return calls;
    const { rows: open } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments
             WHERE connector_id = ? AND state = 'processing' AND external_id IS NOT NULL
               AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?`,
      params: [conn.id, now - CHECK_EVERY_MS, SETTLE_PER_RUN],
      method: "all",
    });
    for (const r of open.map(rowOf)) {
      calls++;
      let charge: AgentCharge | null;
      try {
        charge = await read(conn.ctx, { externalId: r.externalId as string });
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        await this.checkedAt(r.id, now);
        continue;
      }
      if (!charge || charge.livemode !== r.livemode) {
        await this.checkedAt(r.id, now);
        continue;
      }
      if (charge.status === "succeeded") await this.paid(r, conn, charge, now);
      else if (charge.status === "failed" || charge.status === "canceled") await this.failedLater(r, conn, charge, now);
      else await this.checkedAt(r.id, now);
    }
    // An attempt the platform never answered: looked up by our own id, then settled as it stands, or
    // let go as never made, so the order is free for another token.
    if (conn.payments.findCharge) {
      const { rows: unanswered } = await this.db.client.query({
        sql: `SELECT ${COLUMNS} FROM agent_payments
               WHERE connector_id = ? AND state = 'creating' AND external_id IS NULL
                 AND (claim_until IS NULL OR claim_until < ?) AND created_at < ?
                 AND (checked_at IS NULL OR checked_at < ?) ORDER BY created_at LIMIT ?`,
        params: [conn.id, now, now - LOOK_AFTER_MS, now - CHECK_EVERY_MS, SETTLE_PER_RUN],
        method: "all",
      });
      for (const r of unanswered.map(rowOf)) {
        if (calls >= SETTLE_PER_RUN) break;
        calls++;
        await this.lookUp(conn, r, now);
      }
    }
    // An attempt nobody heard back about: unknown, and the owner told where to look.
    const { rows: lost } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE connector_id = ?
               AND ((state = 'creating' AND created_at < ?) OR (state = 'processing' AND created_at < ?))
               AND (claim_until IS NULL OR claim_until < ?) LIMIT 5`,
      params: [conn.id, now - LOST_CREATING_MS, now - LOST_PROCESSING_MS, now],
      method: "all",
    });
    for (const r of lost.map(rowOf)) {
      const changed = await this.db.client.query({
        sql: `UPDATE agent_payments SET state = 'unknown', note = ?, updated_at = ? WHERE id = ? AND state IN ('creating', 'processing')`,
        params: [`${providerOf(r.kind)} never said whether this payment went through: check it there.`, now, r.id],
        method: "run",
      });
      if (changed.changes !== 1) continue;
      const [item] = await this.db.orm.select().from(items).where(eq(items.id, r.itemId));
      if (item) {
        await appendThreadEntry(
          this.db,
          connectorCaller(conn.id, now),
          rowToItem(item),
          `A payment from the customer's assistant for this order did not finish. Check it in ${providerOf(r.kind)}.`,
          "note",
        );
      }
    }
    return calls;
  }

  /** An attempt the platform never answered, looked up by the inbox's own id for it. */
  private async lookUp(conn: PayConnection, row: AgentRow, now: number): Promise<void> {
    let found: AgentCharge | null;
    try {
      found = (await conn.payments.findCharge?.(conn.ctx, { ref: row.id })) ?? null;
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      await this.checkedAt(row.id, now);
      return;
    }
    if (!found || found.livemode !== row.livemode) {
      if (now - row.createdAt < NEVER_MADE_MS) {
        await this.checkedAt(row.id, now);
        return;
      }
      await this.db.client.query({
        sql: `UPDATE agent_payments SET state = 'failed', failure = 'lost', last_error = ?, last_error_at = ?, checked_at = ?,
                     updated_at = ? WHERE id = ? AND state = 'creating' AND external_id IS NULL`,
        params: [`${providerOf(row.kind)} made no payment for this attempt`, now, now, now, row.id],
        method: "run",
      });
      return;
    }
    switch (found.status) {
      case "succeeded":
        await this.paid(row, conn, found, now);
        return;
      case "processing":
        await this.settleRow(row.id, null, now, {
          state: "processing",
          externalId: found.externalId,
          dashboardUrl: found.dashboardUrl ?? null,
        });
        return;
      case "requires_action":
        if (found.externalId) {
          await conn.payments.cancelCharge?.(conn.ctx, { externalId: found.externalId }).catch(() => undefined);
        }
        await this.settleRow(row.id, null, now, {
          state: "cancelled",
          externalId: found.externalId,
          failure: "authentication_required",
          lastError: "the card asked its holder to confirm the payment",
        });
        return;
      default: {
        const code = found.failure?.code ?? "declined";
        await this.settleRow(row.id, null, now, {
          state: code === "declined" || code === "authentication_required" ? "declined" : "failed",
          externalId: found.externalId,
          failure: code,
          lastError: [found.failure?.platformCode, found.failure?.message].filter(Boolean).join(": ") || null,
        });
      }
    }
  }

  /** A payment that was processing and did not go through: the order says so, as a link's failure does. */
  private async failedLater(row: AgentRow, conn: PayConnection, charge: AgentCharge, now: number): Promise<void> {
    const changed = await this.db.client.query({
      sql: `UPDATE agent_payments SET state = 'failed', failure = ?, last_error = ?, last_error_at = ?, checked_at = ?, updated_at = ?
             WHERE id = ? AND state = 'processing'`,
      params: [
        charge.failure?.code ?? "declined",
        [charge.failure?.platformCode, charge.failure?.message].filter(Boolean).join(": ").slice(0, 500) || null,
        now,
        now,
        now,
        row.id,
      ],
      method: "run",
    });
    if (changed.changes !== 1) return;
    const order = await this.order(row.itemId);
    if (order?.state !== "awaiting_payment" && order?.state !== "accepted") return;
    try {
      await transitionItem(this.db, connectorCaller(conn.id, now, `agentfailed:${row.id}`), {
        itemId: row.itemId,
        event: "payment_failed",
        input: { note: "The payment did not go through." },
      });
    } catch (error) {
      if (!(error instanceof WriteError && (error.code === "wrong_state" || error.code === "not_allowed"))) throw error;
    }
  }

  private async checkedAt(id: string, now: number): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE agent_payments SET checked_at = ?, updated_at = ? WHERE id = ?",
      params: [now, now, id],
      method: "run",
    });
  }

  /* --- the owner's view ------------------------------------------------------------ */

  async forItem(itemId: string): Promise<AgentPaymentView[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      params: [itemId],
      method: "all",
    });
    return rows.map(rowOf).map((r) => ({
      id: r.id,
      via: "agent" as const,
      provider: this.host.title?.(r.kind) ?? providerOf(r.kind),
      state: r.state,
      amount: { value: r.amount, currency: r.currency },
      livemode: r.livemode,
      payment_id: r.state === "paid" ? r.externalId : null,
      method: r.method,
      paid_amount:
        r.paidAmount !== null && r.paidCurrency !== null ? { value: r.paidAmount, currency: r.paidCurrency } : null,
      paid_at: r.paidAt,
      dashboard_url: r.dashboardUrl,
      failure: r.failure,
      error: r.state === "paid" ? null : r.lastError,
      note: r.note,
      created_at: r.createdAt,
    }));
  }

  /* --- rows ------------------------------------------------------------------------ */

  private async row(id: string): Promise<AgentRow | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE id = ?`,
      params: [id],
      method: "all",
    });
    return rows[0] ? rowOf(rows[0]) : null;
  }

  private async rowByCredential(sha: string): Promise<AgentRow | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE credential_sha = ?`,
      params: [sha],
      method: "all",
    });
    return rows[0] ? rowOf(rows[0]) : null;
  }

  private async rowsFor(itemId: string): Promise<AgentRow[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT ${COLUMNS} FROM agent_payments WHERE item_id = ? ORDER BY created_at, rowid`,
      params: [itemId],
      method: "all",
    });
    return rows.map(rowOf);
  }

  private async voice(order: OrderFacts): Promise<{ readonly lang: CustomerLang; readonly business: string | null }> {
    const facts = await businessFacts(this.db);
    return { lang: customerLang(order.locale, facts.languages), business: oneLine(facts.name) || null };
  }

  private async order(itemId: string): Promise<OrderFacts | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT i.id, i.state, i.payload, i.sandbox, p.contact, i.created_at
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
      change?: unknown;
    };
    const contact = parseJson(r[4]) as { locale?: unknown } | null;
    const value = Number(payload.totalPrice?.value ?? 0);
    return {
      id: String(r[0]),
      state: String(r[1]),
      total: {
        value: Number.isInteger(value) && value > 0 ? value : 0,
        currency: String(payload.totalPrice?.currency ?? "EUR").toUpperCase(),
      },
      sandbox: Number(r[3] ?? 0) === 1,
      changeOpen: payload.change !== undefined && payload.change !== null,
      paymentUrl: typeof payload.paymentUrl === "string" ? payload.paymentUrl : null,
      locale: typeof contact?.locale === "string" ? contact.locale : null,
      createdAt: Number(r[5] ?? 0),
    };
  }
}

function unavailable(reason: string, message: string): WriteError {
  return new WriteError("agent_pay_unavailable", message, { details: { reason } });
}

function inProgress(): WriteError {
  return new WriteError(
    "in_progress",
    "Another payment for this order is on its way: read get_item_status shortly, or retry with the same idempotency_key.",
    { details: { retry_after_s: 5 } },
  );
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
