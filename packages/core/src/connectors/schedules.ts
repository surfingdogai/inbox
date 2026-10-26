import type { Db } from "../db";
import type { ItemType, Money } from "../domain/types";
import type { PayPurpose } from "./sdk";

/**
 * Pay links beyond orders (ADR-036): an item type whose price is paid on a schedule — a stay's deposit
 * and its balance, a salon's deposit, a trade's stages — tells the payments side which entries want a
 * link now, and hears back what the platform says was paid. Orders keep their own path, unchanged
 * (`PaymentLinks.ensure`): one link for what the order comes to.
 *
 * The rules a source keeps to: an entry's amount and title come from the business's own terms (its
 * quote, its own words), never from what a customer's agent typed; the payments side makes one live
 * link per item and entry, closes a link whose entry no longer wants one (paid another way, changed,
 * the item ended), closes it on the platform when its window closes, and believes only what it read
 * back with the business's key. Nothing is ever refunded here: a payment the item cannot take any more
 * is the business's to refund in its own dashboard, and the source says so on the item.
 */

/** One entry of an item's schedule that wants a link now. */
export interface WantedLink {
  /** Unique per item: `deposit`, `balance`, `difference-2`. Never '' (an order's own link). */
  readonly scheduleId: string;
  readonly purpose: Exclude<PayPurpose, "pay" | "guarantee">;
  readonly amount: Money;
  /** When the link stops taking payments: the entry's pay window. */
  readonly expiresAt: number | null;
  /** What the customer sees on the platform's page: the business's own words and the reference. */
  readonly title: string;
}

/** What an item wants of links now. */
export interface ScheduledItem {
  readonly id: string;
  readonly type: ItemType;
  /** A test item: only a test key's connection makes its links. */
  readonly sandbox: boolean;
  /** The customer's language tag, for the platform's few words. */
  readonly locale: string | null;
  /** Its six-character reference, as the business's emails give it. */
  readonly reference: string;
  /** The entries that want a link now; a live link for any other entry is closed. */
  readonly links: readonly WantedLink[];
}

/** A payment read back from the platform on one of an item's schedule links. */
export interface ScheduledPayment {
  readonly itemId: string;
  readonly scheduleId: string;
  readonly purpose: PayPurpose;
  readonly amount: Money;
  readonly paymentId: string;
  readonly method?: string | undefined;
  readonly connectorId: string;
  readonly dashboardUrl?: string | undefined;
  readonly now: number;
}

/** What a source did with a payment: recorded it, or kept it for the owner to refund. */
export interface ScheduledOutcome {
  /** Recorded on the item (it confirmed, or the entry is paid). */
  readonly applied: boolean;
  /** For the job's note and, when not applied, the owner's: why. */
  readonly note: string;
}

export interface ScheduleSource {
  /** What the item wants of links now; null when it is gone or is not this source's. */
  wanted(db: Db, itemId: string, now: number): Promise<ScheduledItem | null>;
  /**
   * A payment on one of its links (the link is marked paid already, once). The source records it on the
   * item, or, when it came late (the item lapsed, the entry changed), claims again what it still can or
   * marks a refund owed for the business to make in its own dashboard.
   */
  paid(db: Db, payment: ScheduledPayment): Promise<ScheduledOutcome>;
  /** A link was made: where the customer pays, for the item to name (its status, its emails). */
  opened?(
    db: Db,
    link: { readonly itemId: string; readonly scheduleId: string; readonly url: string; readonly now: number },
  ): Promise<void>;
  /** A link is closed with nothing paid on it: its window passed, the platform said the payment failed. */
  closed?(
    db: Db,
    link: {
      readonly itemId: string;
      readonly scheduleId: string;
      readonly why: "expired" | "failed";
      readonly now: number;
    },
  ): Promise<void>;
}

const sources = new Map<ItemType, ScheduleSource>();

/** Registers the schedule source of an item type: one per type, the last one registered wins. */
export function registerScheduleSource(type: ItemType, source: ScheduleSource): void {
  sources.set(type, source);
}

/** The schedule source of an item type, if one is registered. */
export function scheduleSourceOf(type: ItemType): ScheduleSource | undefined {
  return sources.get(type);
}
