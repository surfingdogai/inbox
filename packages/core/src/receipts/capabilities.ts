import type { Statement } from "@surfingdog/platform";
import type { InboxOutcomeCode, ReceiptKind, ReceiptPayload, ReceiptPayloadV2 } from "@surfingdog/spec";
import { PROMISE_KINDS, receiptPayloadSchema, receiptPayloadV2Schema } from "@surfingdog/spec";
import { asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { OfferTerms } from "../customer/offer";
import type { Db } from "../db";
import { CUSTOMER_ACTORS, type Money } from "../domain/types";
import { identityPending } from "../identity/pending";
import { itemStopped } from "../identity/stops";
import { ulid } from "../ids";
import { itemAmended } from "../negotiation/changes";
import { appliesV6, networkReceiptStatements, networkRulesOf, type ReceiptRef, takesV6 } from "../network/index";
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
  termsKeyFor,
  trmOf,
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
  /** A promise (`confirmed`, `paid`, `accepted`), the `outcome` that closed one, or a change both sides agreed to it (`amended`). */
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
  /** The agreed change an `amended` receipt records (ADR-017 Amendment 3); required for that kind. */
  readonly offerId?: string | undefined;
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
    /**
     * The `iss` of every receipt: `INBOX_PUBLIC_URL`, else the Inbox address in Settings. A job has
     * no request to derive it from.
     */
    private readonly baseUrl: string | undefined,
    private readonly clock: () => number = Date.now,
  ) {
    this.keys = createKeyStore(db, secrets, clock);
  }

  /**
   * Whether this instance can issue receipts, and if not, the one sentence that says why. The
   * setup screen and the job note both use it, so an owner hears the same reason in both places.
   */
  readiness(settings?: Settings): { ok: true } | { ok: false; reason: string } {
    if (!this.secrets) {
      return {
        ok: false,
        reason:
          "INBOX_SECRET_KEY is not set, so the signing key could only be stored in the clear; no receipt is issued.",
      };
    }
    if (!this.issuer(settings)) {
      return {
        ok: false,
        reason:
          "This inbox has no public address yet (INBOX_PUBLIC_URL, or the Inbox address in Settings), so a receipt could not name its issuer; none is issued.",
      };
    }
    return { ok: true };
  }

  /**
   * The issuer every receipt names: `INBOX_PUBLIC_URL` with no trailing slash, else the origin of the
   * Inbox address in Settings (which the owner's first sign-in fills in), else none.
   */
  issuer(settings?: Settings): string | null {
    if (this.baseUrl) return this.baseUrl.replace(/\/+$/, "");
    const typed = settings?.notifications.appUrl;
    if (!typed) return null;
    try {
      return new URL(typed).origin;
    } catch {
      return null;
    }
  }

  /**
   * Issues the `kind` receipt for an item, once — for an `outcome`, once per outcome; for an
   * `amended`, once per agreed change. A second call (a retried job, a second runner) finds the row
   * and returns it; the unique index on (item, kind, outcome, change) settles the race between two
   * that arrive together.
   *
   * Bookings and orders a customer made carry claims v2 (ADR-017 §3.2): `ver`, `due`, a booking's
   * `end`, the networks' presentations as `per`, and on an outcome its code, `ref` to the item's
   * earliest promise and `aut`. An outcome or an amendment whose item has no promise yet issues that
   * promise first, and an outcome each agreed change without its receipt. Items the business made
   * itself keep v1 promises and record no outcomes and no changes (§3.1). Since rules version 6
   * (ADR-017 Amendment 3): a change both sides agreed is an `amended` receipt with the new dates,
   * the terms' fingerprint (`trm`) and who accepted it (`acc`), and outcomes carry the latest
   * amendment's dates; a refund of such a booking or order has receipts of its own (`typ: refund`),
   * its promise when its date is fixed and its outcome when it is paid or dropped; and a promise
   * carries `trm` when every network it goes to takes version 6.
   */
  async issue(
    itemId: string,
    kind: ReceiptKind,
    now: number = this.clock(),
    opts: IssueOptions = {},
  ): Promise<IssueOutcome> {
    const outcome = kind === "outcome" ? (opts.outcome ?? null) : null;
    if (kind === "outcome" && !outcome) return { outcome: "skipped", note: "an outcome receipt needs its outcome" };
    const offerId = kind === "amended" ? (opts.offerId ?? "") : "";
    if (kind === "amended" && !offerId) {
      return { outcome: "skipped", note: "an amended receipt names the change it records" };
    }
    const existing = await this.row(itemId, kind, outcome ?? "", offerId);
    if (existing) return { outcome: "already", receipt: view(existing) };

    const settings = await readSettings(this.db);
    const ready = this.readiness(settings);
    if (!ready.ok) return { outcome: "skipped", note: ready.reason };

    const [item] = await this.db.orm.select().from(items).where(eq(items.id, itemId));
    if (!item) return { outcome: "skipped", note: `item ${itemId} no longer exists` };
    const flags = item.flags as { sandbox?: boolean };
    // A sandbox item is a rehearsal. A receipt for one would be a signed statement that something
    // happened when nothing did, and a network cannot tell it from the real thing.
    if (flags.sandbox) return { outcome: "skipped", note: "sandbox items never get a receipt" };
    // Promised before outcomes were recorded (0008): made under the rules of the day, closed by hand.
    if ((kind === "outcome" || kind === "amended") && item.legacyPromise === 1) {
      return {
        outcome: "skipped",
        note: `this ${item.type} was promised before outcomes were recorded, so it records no ${kind === "outcome" ? "outcome" : "change"} (R18)`,
      };
    }

    const skip = await this.eligibility(item, kind, outcome);
    if (skip) return { outcome: "skipped", note: skip };
    const v2 = item.type === "refund" || (await this.v2Item(item.id, item.type));
    // A promise names the person each network presented for the item (`per`). While a first
    // contact is still waiting for a network's answer it waits too, for at most fifteen minutes
    // from the item's creation, and then goes without (§3.2).
    if (
      v2 &&
      isPromise(kind) &&
      now - item.createdAt < PROMISE_WAITS_FOR_IDENTITY_MS &&
      (await identityPending(this.db, item.id))
    ) {
      return {
        outcome: "deferred",
        note: "waiting for a network to answer the first contact, so the promise can name the person",
      };
    }

    // An outcome or an amendment closes or moves the item's earliest promise; an item that has none
    // yet (its promise job failed, or it was promised before receipts were on) gets it first, dated
    // by its own event.
    let promises = await this.promisesOf(item.id);
    if ((kind === "outcome" || kind === "amended") && promises.length === 0) {
      const first = await this.firstPromiseEvent(item, outcome, opts.eventId);
      if (!first)
        return {
          outcome: "skipped",
          note: `this ${item.type} never made a promise, so no ${kind} closes or moves one`,
        };
      const made = await this.issue(item.id, first.kind, now, { eventId: first.eventId });
      if (made.outcome === "skipped" || made.outcome === "deferred") return made;
      promises = await this.promisesOf(item.id);
    }
    // An outcome reads the latest agreed dates, so each agreed change has its receipt before it.
    if (kind === "outcome" && item.type !== "refund") {
      for (const change of await this.changesWithoutReceipt(item.id)) {
        const made = await this.issue(item.id, "amended", now, { offerId: change.id, eventId: change.eventId });
        if (made.outcome === "deferred") return made;
      }
    }
    const earliest = promises[0];

    const [party] = await this.db.orm
      .select({ contact: parties.contact })
      .from(parties)
      .where(eq(parties.id, item.partyId));
    const identity = identityOf(item.partyId, party?.contact);
    const box = this.secrets as SecretBox; // readiness() proved it above
    const sub = await subjectHash(await box.mac("receipt-subject"), identity);

    const at = Math.floor((opts.eventId ? ((await this.eventTime(opts.eventId)) ?? now) : now) / 1000);
    // A network takes the latest amendment by `iat`, then nonce (Amendment 3): two changes agreed in
    // one second, or an event clock a second behind, must still sort in the order they were agreed.
    const { iat, nonce } =
      kind === "amended" ? await this.amendmentOrder(item.id, offerId, at) : { iat: at, nonce: newNonce() };
    const base = {
      iss: this.issuer(settings),
      sub,
      itm: item.id,
      typ: item.type,
      knd: kind,
      iat,
      nonce,
    };
    // Which networks it goes to: decided before the claims, since a promise's `trm` depends on them.
    const targets = await this.networksFor(settings, item.id, kind, v2);
    let payload: ReceiptPayload | ReceiptPayloadV2;
    if (!v2) {
      const money = amountOf(item, kind);
      const pay = paymentOf(item, kind);
      payload = receiptPayloadSchema.parse({ ...base, ...(money ? { amt: money } : {}), ...(pay ? { pay } : {}) });
    } else {
      const claims: Record<string, unknown> = { ...base, ver: 2 };
      const per = await this.perOf(item.id);
      if (kind === "amended") {
        // A change both sides agreed (ADR-017 Amendment 3): the promise's new dates, the fingerprint of
        // the terms agreed, and who said yes to them.
        const change = await this.agreedChange(item.id, offerId);
        if (!change) return { outcome: "skipped", note: `no agreed change ${offerId} on this ${item.type}` };
        // The dates in force once this change is agreed: the earliest promise's, moved by every change
        // agreed up to and including it, in order — so one that names no delivery date keeps the date
        // the change before it named, not the one first promised.
        let dates = datesOf(item, earliest ?? { iat }, settings);
        for (const terms of await this.agreedChangeTermsUpTo(item.id, offerId))
          dates = changeDates(item.type, terms, dates);
        claims.due = dates.due;
        if (dates.end !== undefined) claims.end = dates.end;
        claims.ref = (earliest?.payload as { nonce?: unknown } | undefined)?.nonce;
        claims.trm = await trmOf(await termsKeyFor(await box.mac("receipt-terms"), offerId), change.termsSha);
        claims.acc = change.by === "business" ? "customer" : "business";
      } else {
        // Every receipt of the item agrees on its dates: the latest agreed change's, else the earliest
        // promise's; the first promise works them out from the item (§3.2) — from the terms agreed
        // before any change, when it is signed only after one (its job failed, or it waited for a
        // first contact's answer): it says what was promised when it was made, and the amendments
        // say how it moved.
        const latest = kind === "outcome" ? await this.latestAmendment(item.id) : undefined;
        const agreed = item.type === "booking" || item.type === "order" ? await this.agreedOffer(item.id) : null;
        const promised =
          !earliest && agreed && (await itemAmended(this.db, item.id)) ? asAgreed(item, agreed.terms) : item;
        const dates = datesOf(promised, latest ?? earliest ?? { iat }, settings);
        claims.due = dates.due;
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
          // The terms both sides agreed, only where every network the promise goes to reads them.
          if (agreed?.termsSha && targets.length > 0) {
            const rules = await networkRulesOf(this.db, targets);
            if (targets.every((n) => takesV6(rules.get(n)))) {
              claims.trm = await trmOf(await termsKeyFor(await box.mac("receipt-terms"), agreed.id), agreed.termsSha);
            }
          }
        }
      }
      // A refund's receipts and an amendment are about the business's promise, not the person: they
      // name no presentation. They still carry the customer's pseudonym (`sub`), the same as the
      // order's, which a network needs to weigh repeat evidence per customer (ADR-017 §5, R7), so it
      // can tell a return is theirs: what protects the customer is that none of it counts (A3.5).
      if (per.length && item.type !== "refund" && kind !== "amended") claims.per = per;
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
    // A losing writer in the (item, kind, outcome, change) race inserts nothing, and its fanout job
    // then finds an event with the winner's id missing and stops — one line of noise, no duplicate.
    const statements: Statement[] = [
      {
        sql: `INSERT INTO receipts (id, item_id, kind, outcome, offer_id, jws, payload, kid, subject_hash, issued_at, sha)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (item_id, kind, outcome, offer_id) DO NOTHING`,
        params: [id, item.id, kind, outcome ?? "", offerId, jws, JSON.stringify(payload), key.kid, sub, now, sha],
        method: "run",
      },
    ];
    if (await hasActiveWebhook(this.db)) {
      statements.push(webhookFanoutStatement({ id, type: `${item.type}.receipt_issued`, itemId: item.id }, now));
    }
    // Every network the owner switched on gets every receipt, so each directory can count what
    // was kept; which of them a network is sent is the publisher's call, by the rules it applies.
    // Nothing about the customer travels: the receipt names them by pseudonym only. The rows name
    // the receipt by (item, kind, outcome, change), so a writer that loses the race queues the winner's.
    const ref: ReceiptRef = { itemId: item.id, kind, outcome: outcome ?? "", offerId };
    // A customer who asked the business not to use booking networks: the receipt is theirs to hold,
    // and no network is sent it (the founder, 23 September 2026).
    for (const network of targets) {
      statements.push(...networkReceiptStatements(network, "issued", now, ref));
    }
    await this.db.batch(statements);
    const written = await this.row(itemId, kind, outcome ?? "", offerId);
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
    const dated = (row.payload as { ver?: unknown } | null)?.ver === 2;
    for (const network of await this.networksFor(
      await readSettings(this.db),
      row.itemId,
      row.kind as ReceiptKind,
      dated,
    )) {
      statements.push(...networkReceiptStatements(network, "acknowledged", now, { id: row.id }));
    }
    await this.db.batch(statements);
    const [after] = await this.db.orm.select().from(receipts).where(eq(receipts.id, row.id));
    if (!after) throw new WriteError("internal", "the receipt vanished while it was being acknowledged");
    return view(after);
  }

  /** For the owner: readiness plus counts, one query each, nothing about any customer. */
  async status(): Promise<ReceiptStatus> {
    const settings = await readSettings(this.db);
    const ready = this.readiness(settings);
    const [keys, issued, acked] = await Promise.all([
      this.db.orm.select({ n: count() }).from(signingKeys).where(isNull(signingKeys.retiredAt)),
      this.db.orm.select({ n: count() }).from(receipts),
      this.db.orm.select({ n: count() }).from(receipts).where(isNotNull(receipts.ackAt)),
    ]);
    return {
      ready: ready.ok,
      reason: ready.ok ? null : ready.reason,
      issuer: this.issuer(settings),
      keys: Number(keys[0]?.n ?? 0),
      issued: Number(issued[0]?.n ?? 0),
      acknowledged: Number(acked[0]?.n ?? 0),
    };
  }

  /** What `/.well-known/jwks.json` serves and the manifest embeds under `receipt_keys`. */
  async jwks(): Promise<{ keys: PublicJwk[] }> {
    return { keys: await this.keys.published() };
  }

  private async row(itemId: string, kind: ReceiptKind, outcome = "", offerId = ""): Promise<ReceiptRow | undefined> {
    const rows = await this.db.orm.select().from(receipts).where(eq(receipts.itemId, itemId));
    return rows.find((r) => r.kind === kind && r.outcome === outcome && r.offerId === offerId);
  }

  /**
   * Why this item earns no `kind` receipt, or null when it does. Bookings and orders a customer made
   * carry claims v2 and every kind; those the business made itself keep v1 promises (§3.1). A refund
   * follows the booking or order it refunds (ADR-017 Amendment 3): its promise and its outcome when
   * a customer made that one, else nothing.
   */
  private async eligibility(
    item: ItemRow,
    kind: ReceiptKind,
    outcome: InboxOutcomeCode | null,
  ): Promise<string | null> {
    if (item.type === "refund") {
      const refunded = item.linkedItemId
        ? (
            await this.db.orm
              .select({ id: items.id, type: items.type })
              .from(items)
              .where(eq(items.id, item.linkedItemId))
          )[0]
        : undefined;
      if (!refunded || !(await this.v2Item(refunded.id, refunded.type))) {
        return "the business made what this refunds itself, so its refund records no receipt (ADR-017 §3.1)";
      }
      // Nothing was paid (on delivery, on account), so nothing is owed back: a refund of nothing
      // promises nothing (A3.5), and a kept outcome for it would be reputation had for free.
      const owed = (item.payload as { amount?: unknown }).amount;
      if (!isMoney(owed) || owed.value <= 0)
        return "this refund owes nothing, so it promises nothing and records no receipt";
      if (kind !== "accepted" && kind !== "outcome")
        return `a refund's receipts are its promise and its outcome, not ${kind}`;
      return null;
    }
    if ((kind === "accepted" || kind === "outcome" || kind === "amended") && !(await this.v2Item(item.id, item.type))) {
      return item.type === "booking" || item.type === "order"
        ? `the business made this ${item.type} itself, so it records no ${kind === "outcome" ? outcome : kind} receipt (ADR-017 §3.1)`
        : `a ${item.type} promises nothing, so it has no ${kind} receipt`;
    }
    return null;
  }

  /** Whether a booking or an order carries claims v2: a customer, or a shop's connector, made it. */
  private async v2Item(itemId: string, type: string): Promise<boolean> {
    return (type === "booking" || type === "order") && V2_CREATORS.has(await this.creatorOf(itemId));
  }

  /** The changes both sides agreed to the item's promise that have no receipt yet, oldest first. */
  private async changesWithoutReceipt(itemId: string): Promise<{ id: string; eventId: string | undefined }[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT o.id, o.closed_event_id FROM item_offers o
             WHERE o.item_id = ? AND o.kind = 'change' AND o.status = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.item_id = o.item_id AND r.kind = 'amended' AND r.offer_id = o.id)
             ORDER BY o.rev`,
      params: [itemId],
      method: "all",
    });
    return rows.map((r) => ({ id: String(r[0]), eventId: r[1] === null ? undefined : String(r[1]) }));
  }

  /** An agreed change to the item's promise: its terms, their fingerprint, and whose it was. */
  private async agreedChange(
    itemId: string,
    offerId: string,
  ): Promise<{ terms: OfferTerms; termsSha: string; by: string } | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT terms, terms_sha, by FROM item_offers
             WHERE id = ? AND item_id = ? AND kind = 'change' AND status = 'accepted'`,
      params: [offerId, itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const terms = (typeof r[0] === "string" ? JSON.parse(r[0]) : r[0]) as OfferTerms;
    return { terms, termsSha: String(r[1]), by: String(r[2]) };
  }

  /**
   * The offer both sides last agreed that made the promise — never a change to it, which its own
   * amendment names — with its terms and their fingerprint (null when that is not one), if the item's
   * offers say.
   */
  private async agreedOffer(
    itemId: string,
  ): Promise<{ id: string; terms: OfferTerms; termsSha: string | null } | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT id, terms, terms_sha FROM item_offers
             WHERE item_id = ? AND kind <> 'change' AND status = 'accepted' ORDER BY rev DESC LIMIT 1`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const terms = (typeof r[1] === "string" ? JSON.parse(r[1]) : r[1]) as OfferTerms;
    const sha = typeof r[2] === "string" && /^[A-Za-z0-9_-]{43}$/.test(r[2]) ? r[2] : null;
    return { id: String(r[0]), terms, termsSha: sha };
  }

  /** The terms of every change both sides agreed to the item's promise, in order, up to and including this one. */
  private async agreedChangeTermsUpTo(itemId: string, offerId: string): Promise<OfferTerms[]> {
    const { rows } = await this.db.client.query({
      sql: `SELECT id, terms FROM item_offers WHERE item_id = ? AND kind = 'change' AND status = 'accepted'
               AND rev <= (SELECT rev FROM item_offers WHERE id = ? AND item_id = ?)
             ORDER BY rev`,
      params: [itemId, offerId, itemId],
      method: "all",
    });
    return rows.map((r) => (typeof r[1] === "string" ? JSON.parse(r[1]) : r[1]) as OfferTerms);
  }

  /**
   * The `iat` and nonce of the amendment for one agreed change, so that a network ordering the item's
   * amendments by `iat`, then nonce, finds them in the order they were agreed: never dated before a
   * change agreed earlier, and when in the same second, a nonce after theirs and before any agreed
   * later. `at` is the moment of acceptance, in Unix seconds.
   */
  private async amendmentOrder(itemId: string, offerId: string, at: number): Promise<{ iat: number; nonce: string }> {
    const { rows } = await this.db.client.query({
      sql: `SELECT o.rev, json_extract(r.payload, '$.iat'), json_extract(r.payload, '$.nonce'),
                   (SELECT m.rev FROM item_offers m WHERE m.id = ? AND m.item_id = ?)
              FROM receipts r JOIN item_offers o ON o.id = r.offer_id AND o.item_id = r.item_id
             WHERE r.item_id = ? AND r.kind = 'amended'`,
      params: [offerId, itemId, itemId],
      method: "all",
    });
    const mine = Number(rows[0]?.[3]);
    const others = rows.map((r) => ({ rev: Number(r[0]), iat: Number(r[1]), nonce: String(r[2]) }));
    const before = others.filter((o) => o.rev < mine);
    const iat = Math.max(at, ...before.map((o) => o.iat));
    const lower = before
      .filter((o) => o.iat === iat)
      .map((o) => o.nonce)
      .sort()
      .at(-1);
    const upper = others
      .filter((o) => o.rev > mine && o.iat === iat)
      .map((o) => o.nonce)
      .sort()[0];
    const nonce = nonceBetween(lower, upper);
    if (nonce) return { iat, nonce };
    // No nonce between them (two adjacent 128-bit values): a second later still follows every earlier one.
    return { iat: lower === undefined ? iat : iat + 1, nonce: newNonce() };
  }

  /** The item's latest amendment: the greatest `iat`, then nonce, as a network reads them (Amendment 3). */
  private async latestAmendment(itemId: string): Promise<ReceiptRow | undefined> {
    const rows = await this.db.orm.select().from(receipts).where(eq(receipts.itemId, itemId));
    const claims = (r: ReceiptRow) => r.payload as { iat?: number; nonce?: string };
    return rows
      .filter((r) => r.kind === "amended")
      .sort(
        (a, b) =>
          Number(claims(a).iat ?? 0) - Number(claims(b).iat ?? 0) ||
          String(claims(a).nonce ?? "").localeCompare(String(claims(b).nonce ?? "")),
      )
      .at(-1);
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

  /**
   * The kind of the item's first promise and the event that made it: a confirmation, an acceptance;
   * for a refund, the event that fixed the date it must be paid by (its creation, an approval, the
   * goods' arrival), or — paid before any fixed it — the payment itself. A refund dropped before
   * its date was fixed promised nothing.
   */
  private async firstPromiseEvent(
    item: ItemRow,
    outcome: InboxOutcomeCode | null,
    causedBy: string | undefined,
  ): Promise<{ kind: ReceiptKind; eventId: string } | null> {
    if (item.type === "refund") {
      if (typeof (item.payload as { refundDue?: unknown }).refundDue === "string") {
        const { rows } = await this.db.client.query({
          sql: `SELECT id FROM item_events WHERE item_id = ?
                  AND ((event = 'create' AND to_state = 'approved') OR event IN ('approve', 'goods_back'))
                ORDER BY seq DESC LIMIT 1`,
          params: [item.id],
          method: "all",
        });
        const eventId = rows[0]?.[0];
        return eventId === undefined ? null : { kind: "accepted", eventId: String(eventId) };
      }
      const paid = outcome === "refund.honoured" || outcome === "refund.late";
      return paid && causedBy ? { kind: "accepted", eventId: causedBy } : null;
    }
    const promised =
      item.type === "booking"
        ? { kind: "confirmed" as const, state: "confirmed" }
        : item.type === "order"
          ? { kind: "accepted" as const, state: "accepted" }
          : null;
    if (!promised) return null;
    const { rows } = await this.db.client.query({
      sql: "SELECT id FROM item_events WHERE item_id = ? AND to_state = ? ORDER BY seq LIMIT 1",
      params: [item.id, promised.state],
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
   * for an outcome or an amendment — also one that stopped taking them after it was sent the item's
   * promise, which is owed what closes or moves it (ADR-017 §3.2). A promise both sides changed goes
   * only to a network that applies rules version 6 (ADR-017 Amendment 3): any other would hold the
   * business to the date first agreed (a promise that names no date, claims v1, goes as before).
   * What version 6 added goes to every one, and waits for a network that does not take it yet, as
   * claims v2 wait (the publisher).
   */
  private async networksFor(
    settings: Settings,
    itemId: string,
    kind: ReceiptKind,
    /** Whether the receipt names a date a network holds the business to (claims v2). */
    dated: boolean,
  ): Promise<string[]> {
    if (await itemStopped(this.db, itemId)) return [];
    const networks = new Set(enabledNetworks(settings, "receipts"));
    if (kind === "outcome" || kind === "amended") {
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
    if (kind === "amended" || (dated && (await itemAmended(this.db, itemId)))) {
      const rules = await networkRulesOf(this.db, [...networks]);
      for (const n of [...networks]) if (!appliesV6(rules.get(n))) networks.delete(n);
    }
    return [...networks].sort();
  }
}

const isPromise = (kind: ReceiptKind) => (PROMISE_KINDS as readonly string[]).includes(kind);

const NONCE = /^[0-9a-f]{32}$/;
const NONCE_MAX = (1n << 128n) - 1n;

/**
 * A fresh random nonce strictly after `lower` and before `upper` (either may be absent), in the same
 * 32 lowercase hex digits `newNonce` writes, so it sorts between them as text and as a number. Drawn
 * inside the gap itself, never by retrying whole draws: a neighbour near either end of the range
 * would otherwise leave a draw little chance to land in it. Null when nothing fits between them, or
 * a neighbour is not a nonce of ours.
 */
function nonceBetween(lower: string | undefined, upper: string | undefined): string | null {
  if ((lower !== undefined && !NONCE.test(lower)) || (upper !== undefined && !NONCE.test(upper))) return null;
  const lo = lower === undefined ? 0n : BigInt(`0x${lower}`) + 1n;
  const hi = upper === undefined ? NONCE_MAX : BigInt(`0x${upper}`) - 1n;
  if (lo > hi) return null;
  const drawn = BigInt(`0x${newNonce()}`) % (hi - lo + 1n);
  return (lo + drawn).toString(16).padStart(32, "0");
}

/**
 * When a promise is due after a change both sides agreed, in Unix seconds: a booking's new start and
 * end; an order's new delivery date, else when it was due before (a change of quantities does not
 * move an order agreed with no date).
 */
function changeDates(
  type: string,
  terms: OfferTerms,
  before: { due: number; end?: number },
): { due: number; end?: number } {
  const seconds = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  };
  if (type === "booking") {
    const due = seconds(terms.startTime) ?? before.due;
    const end = seconds(terms.endTime);
    return end === undefined ? { due } : { due, end };
  }
  return { due: seconds(terms.delivery?.when) ?? before.due };
}

/**
 * The item as it stood on these agreed terms: a booking's times, an order's delivery (none when the
 * terms name none), for a promise signed only after a change moved them.
 */
function asAgreed(item: ItemRow, terms: OfferTerms): ItemRow {
  const payload = { ...(item.payload as Record<string, unknown>) };
  if (item.type === "booking") {
    if (terms.startTime) payload.startTime = terms.startTime;
    if (terms.endTime) payload.endTime = terms.endTime;
  } else if (item.type === "order") {
    if (terms.delivery) payload.delivery = terms.delivery;
    else delete payload.delivery;
  }
  return { ...item, payload } as ItemRow;
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
  const p = item.payload as {
    startTime?: string;
    endTime?: string;
    delivery?: { when?: string };
    refundDue?: string;
  };
  const seconds = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  };
  // A refund is due when it must be paid by; paid before any date was fixed, when it was paid.
  if (item.type === "refund") return { due: seconds(p.refundDue) ?? iat };
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

/**
 * The value the receipt attests, when the item states one. Never derived, never summed here. A
 * refund's promise attests what is owed.
 */
function amountOf(item: ItemRow, kind: ReceiptKind): Money | undefined {
  const p = item.payload as Record<string, unknown>;
  if (item.type === "refund") return isMoney(p.amount) ? p.amount : undefined;
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
