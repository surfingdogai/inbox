import type { Statement } from "@surfingdog/platform";
import type { InboxOutcomeCode, ReceiptKind, ReceiptPayload, ReceiptPayloadV2 } from "@surfingdog/spec";
import { PROMISE_KINDS, receiptPayloadSchema, receiptPayloadV2Schema } from "@surfingdog/spec";
import { asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { CUSTOMER_ACTORS, type Money } from "../domain/types";
import { identityPending } from "../identity/pending";
import { ulid } from "../ids";
import { networkReceiptStatements, type ReceiptRef } from "../network/index";
import { items, parties, receipts, signingKeys } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { enabledNetworks, readSettings, type Settings } from "../settings/schema";
import { hasActiveWebhook, webhookFanoutStatement } from "../write/common";
import { WriteError } from "../write/errors";
import type { ItemRow } from "../write/views";
import { createKeyStore, type KeyStore } from "./keys";
import {
  newNonce,
  type PublicJwk,
  peekAckReceiptId,
  ReceiptError,
  receiptSha,
  signReceipt,
  subjectHash,
  verifyAck,
} from "./sign";

/**
 * Receipts (ADR-016): the signed record an instance issues when an item reaches a state that
 * matters, and the counter-signature a customer's agent adds to say it holds the same one.
 *
 * Issuing runs in a job, after the transition that caused it, so a confirmation is never held up
 * by a signature and never lost to one: the job row is written in the same batch as the event, and
 * this class is what the job handler calls.
 */

/** What a door returns: the receipt itself plus the two facts about it the JWS does not carry. */
export interface ReceiptView {
  readonly id: string;
  /** A promise (`confirmed`, `paid`, `accepted`) or the `outcome` that closed one. */
  readonly kind: ReceiptKind;
  /** The outcome an `outcome` receipt records (ADR-017 §3), e.g. `booking.completed`; null on a promise. */
  readonly outcome: InboxOutcomeCode | null;
  /** The compact JWS. Verifiable against `/.well-known/jwks.json` on the issuing instance. */
  readonly jws: string;
  /** The claims inside `jws`, decoded, for readers that do not want to. `ver: 2` marks claims v2. */
  readonly payload: ReceiptPayload | ReceiptPayloadV2;
  readonly issued_at: string;
  /** When the customer's agent counter-signed it, or null while it has not. */
  readonly acknowledged_at: string | null;
}

/** What the owner's Settings page shows: can this instance sign, and what has it signed so far. */
export interface ReceiptStatus {
  readonly ready: boolean;
  /** The one sentence that says why not, or null when it can. */
  readonly reason: string | null;
  readonly issuer: string | null;
  readonly keys: number;
  readonly issued: number;
  readonly acknowledged: number;
}

export type IssueOutcome =
  | { readonly outcome: "issued"; readonly receipt: ReceiptView }
  | { readonly outcome: "already"; readonly receipt: ReceiptView }
  | { readonly outcome: "skipped"; readonly note: string }
  /** The item's person is still being asked for (ADR-017 §3.2): try again in a minute. */
  | { readonly outcome: "deferred"; readonly note: string };

/** How long a promise waits for its item's first contact to be answered, so it can name the person (§3.2). */
export const PROMISE_WAITS_FOR_IDENTITY_MS = 15 * 60_000;

/** What an issue job knows beyond the item and the kind. */
export interface IssueOptions {
  /** The outcome an `outcome` receipt records; required for that kind, refused for the others. */
  readonly outcome?: InboxOutcomeCode | undefined;
  /** Nobody decided it (the sweep, a rule): `aut: 1` on the outcome. */
  readonly aut?: boolean | undefined;
  /** The event that caused the receipt: its time is the receipt's `iat` (ADR-017 §3.1). */
  readonly eventId?: string | undefined;
}

type ReceiptRow = typeof receipts.$inferSelect;

/** Who may create an item whose receipts carry claims v2: customers, and a shop's connector. */
const V2_CREATORS: ReadonlySet<string> = new Set([...CUSTOMER_ACTORS, "connector"]);

const DAY_S = 86_400;

export class ReceiptCapabilities {
  readonly keys: KeyStore;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
    /** The `iss` of every receipt: `INBOX_PUBLIC_URL`. A job has no request to derive it from. */
    private readonly baseUrl: string | undefined,
    private readonly clock: () => number = Date.now,
  ) {
    this.keys = createKeyStore(db, secrets, clock);
  }

  /**
   * Whether this instance can issue receipts, and if not, the one sentence that says why. The
   * setup screen and the job note both use it, so an owner hears the same reason in both places.
   */
  readiness(): { ok: true } | { ok: false; reason: string } {
    if (!this.secrets) {
      return {
        ok: false,
        reason:
          "INBOX_SECRET_KEY is not set, so the signing key could only be stored in the clear; no receipt is issued.",
      };
    }
    if (!this.baseUrl) {
      return {
        ok: false,
        reason: "INBOX_PUBLIC_URL is not set, so a receipt could not name its issuer; none is issued.",
      };
    }
    return { ok: true };
  }

  /** The issuer every receipt names: the public origin, no trailing slash. */
  issuer(): string | null {
    return this.baseUrl ? this.baseUrl.replace(/\/+$/, "") : null;
  }

  /**
   * Issues the `kind` receipt for an item, once — for an `outcome`, once per outcome. A second call
   * (a retried job, a second runner) finds the row and returns it; the unique index on (item, kind,
   * outcome) settles the race between two that arrive together.
   *
   * Bookings and orders a customer made carry claims v2 (ADR-017 §3.2): `ver`, `due`, a booking's
   * `end`, the networks' presentations as `per`, and on an outcome its code, `ref` to the item's
   * earliest promise and `aut`. An outcome whose item has no promise yet issues that promise first.
   * Items the business made itself keep v1 promises and record no outcomes (§3.1).
   */
  async issue(
    itemId: string,
    kind: ReceiptKind,
    now: number = this.clock(),
    opts: IssueOptions = {},
  ): Promise<IssueOutcome> {
    const outcome = kind === "outcome" ? (opts.outcome ?? null) : null;
    if (kind === "outcome" && !outcome) return { outcome: "skipped", note: "an outcome receipt needs its outcome" };
    const existing = await this.row(itemId, kind, outcome ?? "");
    if (existing) return { outcome: "already", receipt: view(existing) };

    const ready = this.readiness();
    if (!ready.ok) return { outcome: "skipped", note: ready.reason };

    const [item] = await this.db.orm.select().from(items).where(eq(items.id, itemId));
    if (!item) return { outcome: "skipped", note: `item ${itemId} no longer exists` };
    const flags = item.flags as { sandbox?: boolean };
    // A sandbox item is a rehearsal. A receipt for one would be a signed statement that something
    // happened when nothing did, and a network cannot tell it from the real thing.
    if (flags.sandbox) return { outcome: "skipped", note: "sandbox items never get a receipt" };
    // Promised before outcomes were recorded (0008): made under the rules of the day, closed by hand.
    if (kind === "outcome" && item.legacyPromise === 1) {
      return {
        outcome: "skipped",
        note: `this ${item.type} was promised before outcomes were recorded, so it records no outcome (R18)`,
      };
    }

    const v2 = (item.type === "booking" || item.type === "order") && V2_CREATORS.has(await this.creatorOf(item.id));
    if (!v2 && (kind === "accepted" || kind === "outcome")) {
      return {
        outcome: "skipped",
        note:
          item.type === "booking" || item.type === "order"
            ? `the business made this ${item.type} itself, so it records no ${kind === "outcome" ? outcome : kind} receipt (ADR-017 §3.1)`
            : `a ${item.type} promises nothing, so it has no ${kind} receipt`,
      };
    }
    const settings = await readSettings(this.db);

    // A promise names the person each network presented for the item (`per`). While a first
    // contact is still waiting for a network's answer it waits too, for at most fifteen minutes
    // from the item's creation, and then goes without (§3.2).
    if (
      v2 &&
      kind !== "outcome" &&
      now - item.createdAt < PROMISE_WAITS_FOR_IDENTITY_MS &&
      (await identityPending(this.db, item.id))
    ) {
      return {
        outcome: "deferred",
        note: "waiting for a network to answer the first contact, so the promise can name the person",
      };
    }

    // An outcome closes the item's earliest promise; an item that has none yet (its promise job
    // failed, or it was promised before receipts were on) gets it first, dated by its own event.
    let promises = await this.promisesOf(item.id);
    if (kind === "outcome" && promises.length === 0) {
      const first = await this.firstPromiseEvent(item.id, item.type);
      if (!first)
        return { outcome: "skipped", note: `this ${item.type} never made a promise, so no outcome closes one` };
      const made = await this.issue(item.id, first.kind, now, { eventId: first.eventId });
      if (made.outcome === "skipped" || made.outcome === "deferred") return made;
      promises = await this.promisesOf(item.id);
    }
    const earliest = promises[0];

    const [party] = await this.db.orm
      .select({ contact: parties.contact })
      .from(parties)
      .where(eq(parties.id, item.partyId));
    const identity = identityOf(item.partyId, party?.contact);
    const box = this.secrets as SecretBox; // readiness() proved it above
    const sub = await subjectHash(await box.mac("receipt-subject"), identity);

    const iat = Math.floor((opts.eventId ? ((await this.eventTime(opts.eventId)) ?? now) : now) / 1000);
    const base = {
      iss: this.issuer(),
      sub,
      itm: item.id,
      typ: item.type,
      knd: kind,
      iat,
      nonce: newNonce(),
    };
    let payload: ReceiptPayload | ReceiptPayloadV2;
    if (!v2) {
      const money = amountOf(item, kind);
      const pay = paymentOf(item, kind);
      payload = receiptPayloadSchema.parse({ ...base, ...(money ? { amt: money } : {}), ...(pay ? { pay } : {}) });
    } else {
      // The item's due and end come from its earliest promise, so every receipt of the item agrees
      // on them; the first promise works them out from the item (§3.2).
      const dates = earliest ? datesOf(item, earliest, settings) : datesOf(item, { iat }, settings);
      const per = await this.perOf(item.id);
      const claims: Record<string, unknown> = { ...base, ver: 2, due: dates.due };
      if (dates.end !== undefined) claims.end = dates.end;
      if (kind === "outcome") {
        claims.out = outcome;
        claims.ref = (earliest?.payload as { nonce?: unknown } | undefined)?.nonce;
        if (opts.aut) claims.aut = 1;
      } else {
        const money = amountOf(item, kind);
        const pay = paymentOf(item, kind);
        if (money) claims.amt = money;
        if (pay) claims.pay = pay;
      }
      if (per.length) claims.per = per;
      const parsed = receiptPayloadV2Schema.safeParse(claims);
      if (!parsed.success) {
        return {
          outcome: "skipped",
          note: `the ${kind} receipt's claims do not hold: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        };
      }
      payload = parsed.data;
    }

    const key = await this.keys.active();
    const jws = await signReceipt(payload, key);
    const sha = await receiptSha(jws);

    const id = ulid(now);
    // The row and, when someone is listening, the webhook fanout for `<type>.receipt_issued` go in
    // one batch (ADR-015 §5): the event id is the receipt id, which is what `events_v1` shows.
    // A losing writer in the (item, kind, outcome) race inserts nothing, and its fanout job then
    // finds an event with the winner's id missing and stops — one line of noise, no duplicate.
    const statements: Statement[] = [
      {
        sql: `INSERT INTO receipts (id, item_id, kind, outcome, jws, payload, kid, subject_hash, issued_at, sha)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (item_id, kind, outcome) DO NOTHING`,
        params: [id, item.id, kind, outcome ?? "", jws, JSON.stringify(payload), key.kid, sub, now, sha],
        method: "run",
      },
    ];
    if (await hasActiveWebhook(this.db)) {
      statements.push(webhookFanoutStatement({ id, type: `${item.type}.receipt_issued`, itemId: item.id }, now));
    }
    // Every network the owner switched on gets every receipt, so each directory can count what
    // was kept; which of them a network is sent is the publisher's call, by the rules it applies.
    // Nothing about the customer travels: the receipt names them by pseudonym only. The rows name
    // the receipt by (item, kind, outcome), so a writer that loses the race queues the winner's.
    const ref: ReceiptRef = { itemId: item.id, kind, outcome: outcome ?? "" };
    for (const network of await this.networksFor(settings, item.id, kind)) {
      statements.push(...networkReceiptStatements(network, "issued", now, ref));
    }
    await this.db.batch(statements);
    const written = await this.row(itemId, kind, outcome ?? "");
    if (!written) throw new WriteError("internal", "the receipt was written and then could not be read back");
    return { outcome: written.jws === jws ? "issued" : "already", receipt: view(written) };
  }

  /** base64url(SHA-256(jws)): how a network names a receipt (ADR-017 §3.4). */
  async shaOf(receiptId: string): Promise<string> {
    const [row] = await this.db.orm
      .select({ sha: receipts.sha, jws: receipts.jws })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    if (!row) throw new WriteError("not_found", "no such receipt");
    return row.sha ?? (await receiptSha(row.jws));
  }

  /** The receipts on one item, oldest first. Empty for an item that has not earned one. */
  async forItem(itemId: string): Promise<ReceiptView[]> {
    const rows = await this.db.orm
      .select()
      .from(receipts)
      .where(eq(receipts.itemId, itemId))
      .orderBy(asc(receipts.issuedAt));
    return rows.map(view);
  }

  /**
   * Records the customer agent's counter-signature. The caller has already proved the item is
   * theirs; this checks that the acknowledgement is well-formed, fresh, signed by the key it
   * carries, and about a receipt on this very item — and then keeps it. A second acknowledgement
   * of an acknowledged receipt changes nothing and returns what is there: the first one is the
   * one both sides hold.
   */
  async acknowledge(
    item: Pick<ItemRow, "id">,
    counterSignature: string,
    opts: { now?: number | undefined; receipt?: string | undefined } = {},
  ): Promise<ReceiptView> {
    const now = opts.now ?? this.clock();
    const rcp = peekAckReceiptId(counterSignature);
    if (!rcp)
      throw new WriteError(
        "invalid_input",
        "the counter-signature must be a compact JWS whose payload names the receipt in `rcp`",
      );
    const [row] = await this.db.orm.select().from(receipts).where(eq(receipts.id, rcp));
    if (!row || row.itemId !== item.id) {
      throw new WriteError("not_found", "no such receipt on this item", { details: { receipt_id: rcp } });
    }
    if (opts.receipt !== undefined && opts.receipt !== row.jws) {
      throw new WriteError(
        "invalid_input",
        "`receipt` is not the receipt this item holds; send the JWS the instance returned, or omit it",
      );
    }
    try {
      await verifyAck(counterSignature, { receiptId: row.id, receiptJws: row.jws, now });
    } catch (error) {
      if (error instanceof ReceiptError) {
        throw new WriteError("invalid_input", `the counter-signature was refused: ${error.message}`, {
          details: { reason: error.code },
        });
      }
      throw error;
    }
    if (row.ackJws) return view(row);

    const statements: Statement[] = [
      {
        sql: "UPDATE receipts SET ack_jws = ?, ack_at = ? WHERE id = ? AND ack_jws IS NULL",
        params: [counterSignature, now, row.id],
        method: "run",
      },
    ];
    if (await hasActiveWebhook(this.db)) {
      // `events_v1` names the acknowledgement `<receipt id>:ack`, so that is the event id here.
      const [it] = await this.db.orm.select({ type: items.type }).from(items).where(eq(items.id, row.itemId));
      if (it) {
        statements.push(
          webhookFanoutStatement(
            { id: `${row.id}:ack`, type: `${it.type}.receipt_acknowledged`, itemId: row.itemId },
            now,
          ),
        );
      }
    }
    for (const network of await this.networksFor(await readSettings(this.db), row.itemId, row.kind as ReceiptKind)) {
      statements.push(...networkReceiptStatements(network, "acknowledged", now, { id: row.id }));
    }
    await this.db.batch(statements);
    const [after] = await this.db.orm.select().from(receipts).where(eq(receipts.id, row.id));
    if (!after) throw new WriteError("internal", "the receipt vanished while it was being acknowledged");
    return view(after);
  }

  /** For the owner: readiness plus counts, one query each, nothing about any customer. */
  async status(): Promise<ReceiptStatus> {
    const ready = this.readiness();
    const [keys, issued, acked] = await Promise.all([
      this.db.orm.select({ n: count() }).from(signingKeys).where(isNull(signingKeys.retiredAt)),
      this.db.orm.select({ n: count() }).from(receipts),
      this.db.orm.select({ n: count() }).from(receipts).where(isNotNull(receipts.ackAt)),
    ]);
    return {
      ready: ready.ok,
      reason: ready.ok ? null : ready.reason,
      issuer: this.issuer(),
      keys: Number(keys[0]?.n ?? 0),
      issued: Number(issued[0]?.n ?? 0),
      acknowledged: Number(acked[0]?.n ?? 0),
    };
  }

  /** What `/.well-known/jwks.json` serves and the manifest embeds under `receipt_keys`. */
  async jwks(): Promise<{ keys: PublicJwk[] }> {
    return { keys: await this.keys.published() };
  }

  private async row(itemId: string, kind: ReceiptKind, outcome = ""): Promise<ReceiptRow | undefined> {
    const rows = await this.db.orm.select().from(receipts).where(eq(receipts.itemId, itemId));
    return rows.find((r) => r.kind === kind && r.outcome === outcome);
  }

  /** The item's promises, earliest first: by `iat`, then nonce, as a network orders them (§3.3). */
  private async promisesOf(itemId: string): Promise<ReceiptRow[]> {
    const rows = await this.db.orm.select().from(receipts).where(eq(receipts.itemId, itemId));
    const claims = (r: ReceiptRow) => r.payload as { iat?: number; nonce?: string };
    return rows
      .filter((r) => (PROMISE_KINDS as readonly string[]).includes(r.kind))
      .sort(
        (a, b) =>
          Number(claims(a).iat ?? 0) - Number(claims(b).iat ?? 0) ||
          String(claims(a).nonce ?? "").localeCompare(String(claims(b).nonce ?? "")),
      );
  }

  /** The kind of the item's first promise and the event that made it: a confirmation, an acceptance. */
  private async firstPromiseEvent(
    itemId: string,
    type: string,
  ): Promise<{ kind: ReceiptKind; eventId: string } | null> {
    const promised =
      type === "booking"
        ? { kind: "confirmed" as const, state: "confirmed" }
        : type === "order"
          ? { kind: "accepted" as const, state: "accepted" }
          : null;
    if (!promised) return null;
    const { rows } = await this.db.client.query({
      sql: "SELECT id FROM item_events WHERE item_id = ? AND to_state = ? ORDER BY seq LIMIT 1",
      params: [itemId, promised.state],
      method: "all",
    });
    const eventId = rows[0]?.[0];
    return eventId === undefined ? null : { kind: promised.kind, eventId: String(eventId) };
  }

  /** Who created the item: the actor kind on its first event. */
  private async creatorOf(itemId: string): Promise<string> {
    const { rows } = await this.db.client.query({
      sql: "SELECT actor_kind FROM item_events WHERE item_id = ? AND seq = 1",
      params: [itemId],
      method: "all",
    });
    return rows[0]?.[0] === undefined ? "" : String(rows[0][0]);
  }

  private async eventTime(eventId: string): Promise<number | null> {
    const { rows } = await this.db.client.query({
      sql: "SELECT created_at FROM item_events WHERE id = ?",
      params: [eventId],
      method: "all",
    });
    const at = rows[0]?.[0];
    return at === undefined || at === null ? null : Number(at);
  }

  /** `per`: each network's presentation for the item, at most eight, each named by its host. */
  private async perOf(itemId: string): Promise<{ n: string; p: string }[]> {
    const { rows } = await this.db.client.query({
      sql: "SELECT network, presentation_id FROM item_presentations WHERE item_id = ? AND presentation_id <> '' ORDER BY network LIMIT 8",
      params: [itemId],
      method: "all",
    });
    const per: { n: string; p: string }[] = [];
    for (const r of rows) {
      // A stored link that stood in while a network was unreachable has no presentation to name.
      if (!/^[A-Za-z0-9_-]{22}$/.test(String(r[1]))) continue;
      try {
        per.push({ n: new URL(String(r[0])).host, p: String(r[1]) });
      } catch {
        // Not an origin: never written by this inbox, and never sent.
      }
    }
    return per;
  }

  /**
   * The networks a receipt of this item goes to: every one switched on that takes receipts, and —
   * for an outcome — also one that stopped taking them after it was sent the item's promise, which
   * is owed the outcome that closes it (ADR-017 §3.2).
   */
  private async networksFor(settings: Settings, itemId: string, kind: ReceiptKind): Promise<string[]> {
    const networks = new Set(enabledNetworks(settings, "receipts"));
    if (kind === "outcome") {
      const { rows } = await this.db.client.query({
        sql: `SELECT DISTINCT p.network FROM network_publications p JOIN receipts r ON r.id = p.receipt_id
               WHERE r.item_id = ? AND r.kind <> 'outcome' AND p.stage = 'issued' AND p.state = 'published'`,
        params: [itemId],
        method: "all",
      });
      for (const r of rows) {
        const network = String(r[0]);
        if (settings.networks[network]?.enabled) networks.add(network);
      }
    }
    return [...networks].sort();
  }
}

/**
 * When the item is due and, for a booking, when it ends, in Unix seconds (ADR-017 §3.2): a
 * booking's start and end; an order's delivery time, else its promise's `iat` plus
 * `orders.dueDays`. A v2 promise already says, and is copied; a v1 promise is worked out again.
 */
function datesOf(
  item: ItemRow,
  promise: { payload?: unknown; iat?: number },
  settings: Settings,
): { due: number; end?: number } {
  const claims = (promise.payload ?? {}) as { ver?: unknown; due?: unknown; end?: unknown; iat?: unknown };
  if (claims.ver === 2 && typeof claims.due === "number") {
    return typeof claims.end === "number" ? { due: claims.due, end: claims.end } : { due: claims.due };
  }
  const iat = Number(promise.iat ?? claims.iat ?? 0);
  const p = item.payload as { startTime?: string; endTime?: string; delivery?: { when?: string } };
  const seconds = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  };
  if (item.type === "booking") {
    const due = seconds(p.startTime) ?? iat;
    const end = seconds(p.endTime);
    return end === undefined ? { due } : { due, end };
  }
  return { due: seconds(p.delivery?.when) ?? iat + settings.orders.dueDays * DAY_S };
}

function view(row: ReceiptRow): ReceiptView {
  return {
    id: row.id,
    kind: row.kind as ReceiptKind,
    outcome: row.outcome ? (row.outcome as InboxOutcomeCode) : null,
    jws: row.jws,
    payload: row.payload as ReceiptPayload | ReceiptPayloadV2,
    issued_at: new Date(row.issuedAt).toISOString(),
    acknowledged_at: row.ackAt === null ? null : new Date(row.ackAt).toISOString(),
  };
}

/**
 * What the pseudonym is made from. An email or a phone number links a returning customer across
 * their items; a party with neither is linked only to itself, which is still a true statement,
 * just a lonelier one.
 */
function identityOf(partyId: string, contact: unknown): string {
  const c = (contact ?? {}) as { email?: unknown; phone?: unknown };
  if (typeof c.email === "string" && c.email.trim()) return `email:${c.email.trim().toLowerCase()}`;
  if (typeof c.phone === "string") {
    const digits = c.phone.replace(/[^0-9]/g, "");
    if (digits.length >= 6) return `phone:${digits}`;
  }
  return `party:${partyId}`;
}

/** The value the receipt attests, when the item states one. Never derived, never summed here. */
function amountOf(item: ItemRow, kind: ReceiptKind): Money | undefined {
  const p = item.payload as Record<string, unknown>;
  if (item.type === "order" && kind === "paid" && isMoney(p.paidAmount)) return p.paidAmount;
  if (isMoney(p.totalPrice)) return p.totalPrice;
  return undefined;
}

function paymentOf(item: ItemRow, kind: ReceiptKind): string | undefined {
  if (item.type !== "order" || kind !== "paid") return undefined;
  const method = (item.payload as { paymentMethod?: unknown }).paymentMethod;
  return typeof method === "string" && method.length > 0 && method.length <= 40 ? method : undefined;
}

function isMoney(v: unknown): v is Money {
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isInteger((v as Money).value) &&
    (v as Money).value >= 0 &&
    typeof (v as Money).currency === "string" &&
    (v as Money).currency.length === 3
  );
}
