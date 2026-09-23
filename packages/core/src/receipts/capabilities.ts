import type { Statement } from "@surfingdog/platform";
import type { ReceiptKind, ReceiptPayload } from "@surfingdog/spec";
import { receiptPayloadSchema } from "@surfingdog/spec";
import { asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { ulid } from "../ids";
import { networkReceiptStatements } from "../network/index";
import { items, parties, receipts, signingKeys } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { enabledNetworks, readSettings } from "../settings/schema";
import { hasActiveWebhook, webhookFanoutStatement } from "../write/common";
import { WriteError } from "../write/errors";
import type { ItemRow } from "../write/views";
import { createKeyStore, type KeyStore } from "./keys";
import { newNonce, type PublicJwk, peekAckReceiptId, ReceiptError, signReceipt, subjectHash, verifyAck } from "./sign";

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
  readonly kind: ReceiptKind;
  /** The compact JWS. Verifiable against `/.well-known/jwks.json` on the issuing instance. */
  readonly jws: string;
  /** The claims inside `jws`, decoded, for readers that do not want to. */
  readonly payload: ReceiptPayload;
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
  | { readonly outcome: "skipped"; readonly note: string };

type ReceiptRow = typeof receipts.$inferSelect;

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
   * Issues the `kind` receipt for an item, once. A second call — a retried job, a second runner —
   * finds the row and returns it; the unique index on (item, kind) settles the race between two
   * that arrive together.
   */
  async issue(itemId: string, kind: ReceiptKind, now: number = this.clock()): Promise<IssueOutcome> {
    const existing = await this.row(itemId, kind);
    if (existing) return { outcome: "already", receipt: view(existing) };

    const ready = this.readiness();
    if (!ready.ok) return { outcome: "skipped", note: ready.reason };

    const [item] = await this.db.orm.select().from(items).where(eq(items.id, itemId));
    if (!item) return { outcome: "skipped", note: `item ${itemId} no longer exists` };
    const flags = item.flags as { sandbox?: boolean };
    // A sandbox item is a rehearsal. A receipt for one would be a signed statement that something
    // happened when nothing did, and a network cannot tell it from the real thing.
    if (flags.sandbox) return { outcome: "skipped", note: "sandbox items never get a receipt" };

    const [party] = await this.db.orm
      .select({ contact: parties.contact })
      .from(parties)
      .where(eq(parties.id, item.partyId));
    const identity = identityOf(item.partyId, party?.contact);
    const box = this.secrets as SecretBox; // readiness() proved it above
    const sub = await subjectHash(await box.mac("receipt-subject"), identity);

    const key = await this.keys.active();
    const money = amountOf(item, kind);
    const payload = receiptPayloadSchema.parse({
      iss: this.issuer(),
      sub,
      itm: item.id,
      typ: item.type,
      knd: kind,
      iat: Math.floor(now / 1000),
      nonce: newNonce(),
      ...(money ? { amt: money } : {}),
      ...(paymentOf(item, kind) ? { pay: paymentOf(item, kind) } : {}),
    });
    const jws = await signReceipt(payload, key);

    const id = ulid(now);
    // The row and, when someone is listening, the webhook fanout for `<type>.receipt_issued` go in
    // one batch (ADR-015 §5): the event id is the receipt id, which is what `events_v1` shows.
    // A losing writer in the (item, kind) race inserts nothing, and its fanout job then finds an
    // event with the winner's id missing and stops — one line of noise, no duplicate delivery.
    const statements: Statement[] = [
      {
        sql: `INSERT INTO receipts (id, item_id, kind, jws, payload, kid, subject_hash, issued_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (item_id, kind) DO NOTHING`,
        params: [id, item.id, kind, jws, JSON.stringify(payload), key.kid, sub, now],
        method: "run",
      },
    ];
    if (await hasActiveWebhook(this.db)) {
      statements.push(webhookFanoutStatement({ id, type: `${item.type}.receipt_issued`, itemId: item.id }, now));
    }
    // Every network the owner switched on gets every receipt, so each directory can count what
    // was kept. Nothing about the customer travels: the receipt names them by pseudonym only. The
    // rows name the receipt by (item, kind), so a writer that loses the race queues the winner's.
    for (const network of enabledNetworks(await readSettings(this.db), "receipts")) {
      statements.push(...networkReceiptStatements(network, "issued", now, { itemId: item.id, kind }));
    }
    await this.db.batch(statements);
    const written = await this.row(itemId, kind);
    if (!written) throw new WriteError("internal", "the receipt was written and then could not be read back");
    return { outcome: written.jws === jws ? "issued" : "already", receipt: view(written) };
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
    for (const network of enabledNetworks(await readSettings(this.db), "receipts")) {
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

  private async row(itemId: string, kind: ReceiptKind): Promise<ReceiptRow | undefined> {
    const rows = await this.db.orm.select().from(receipts).where(eq(receipts.itemId, itemId));
    return rows.find((r) => r.kind === kind);
  }
}

function view(row: ReceiptRow): ReceiptView {
  return {
    id: row.id,
    kind: row.kind as ReceiptKind,
    jws: row.jws,
    payload: row.payload as ReceiptPayload,
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
