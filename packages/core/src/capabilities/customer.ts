import { and, asc, eq } from "drizzle-orm";
import type { AccessCapabilities } from "../access/keys";
import { audienceFor, type BusinessFacts, businessFacts } from "../customer/audience";
import { confirmTermsMessage, copyFor, vars, type WithdrawalCopy, withdrawalCopy } from "../customer/copy";
import {
  type Audience,
  nextActions,
  offerSummary,
  orderLinesText,
  personalisedLine,
  statusSentence,
  waitingOn,
  whatOf,
  yourNoun,
} from "../customer/describe";
import { DISCLOSURE, privacyPage } from "../customer/disclosure";
import { dateText, dayText, localDate, moneyIn, shortRef, timeText, whenText, zoneName } from "../customer/format";
import { customerLang, langFromHeader } from "../customer/lang";
import {
  detailsSha,
  type LinkAction,
  type LinkRow,
  linkUsedStatement,
  siblingsOf,
  standingSha,
  verifyLink,
  withdrawSha,
} from "../customer/links";
import {
  bookingRequestTerms,
  changeTerms,
  isChangeable,
  moneyChanged,
  type OfferTerms,
  type OpenOffer,
  openChange,
  openOffer,
  orderRequestTerms,
  promiseTerms,
  termsSha,
  timeDeadline,
} from "../customer/offer";
import type { CustomerPage, LinkActResult, PageField, PageLink } from "../customer/page";
import type { Db } from "../db";
import { type Contact, type Item, type Money, type PayloadOf, payloadSchemas } from "../domain/types";
import { collectCarried } from "../identity/carried";
import { localStanding } from "../identity/context";
import { stopNetworks } from "../identity/stops";
import { lawOf } from "../negotiation/holidays";
import { agreedOf, legacyOfferId, offerRows, openOf } from "../negotiation/offers";
import { rewardsOf } from "../negotiation/rewards";
import { ORDER_SENT, type WithdrawalRight } from "../negotiation/withdrawal";
import type { ReceiptCapabilities } from "../receipts/capabilities";
import { items, parties, products, services } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import { hashText } from "../util/canonical";
import { type Caller, isCustomer, nowOf, withIdempotencyKey } from "../write/caller";
import { findIdempotent } from "../write/common";
import { WriteError } from "../write/errors";
import { once } from "../write/idempotency";
import { type PricingFor, priceFromCatalogue } from "../write/pricing";
import { openReturnOf, withdrawalFlagsOf, withdrawalOf } from "../write/returns";
import { appendThreadEntry } from "../write/thread";
import { type TransitionResult, transitionItem } from "../write/transition";
import { customerItem, type ItemRow, type ItemView, rowToItem, viewFor } from "../write/views";
import { findSlots } from "./availability";
import { type IdentityCapabilities, issuingNetworks } from "./identity";
import type * as T from "./types";

/**
 * The customer's side of what the business proposed (ADR-018 §5, §6), through every door: their
 * assistant (public REST and MCP), and the links in the business's email, which open a page the
 * inbox serves. Whatever the door, one transition does it, so the rules, the receipts and the
 * emails follow the same way.
 */

/** What the business has put to the customer, as the status door shows it. */
export interface CustomerOffer {
  /** Name it when you answer (`offer_id`); null for one made before offers had ids, until it gets one. */
  readonly id: string | null;
  readonly kind: OpenOffer["kind"];
  readonly terms: OfferTerms;
  /** Send it back with the acceptance: the customer said yes to exactly these terms. */
  readonly terms_sha: string;
  readonly deadline: string | null;
  readonly obligation_to_pay: boolean;
  /** What to tell the customer, in the business's words. */
  readonly human: string;
  /** What differs from what it answers or replaces, as paths into `terms` (`$.startTime`, `$.lines[0].quantity`). */
  readonly changes: readonly string[];
  /** `price_changed` whenever money changed: the person sees the new price before they accept (UCP, ACP). */
  readonly warnings: readonly CustomerOfferWarning[];
  /** `held` (we keep the time until they answer) or `unheld`, for a time; `withdrawable` when we may still withdraw it. */
  readonly disclosures: readonly string[];
  /** Its deadline has passed: it can no longer be accepted, though our sweep may not have closed it yet. */
  readonly expired: boolean;
}

export interface CustomerOfferWarning {
  readonly type: "warning";
  readonly code: "price_changed";
  readonly severity: "requires_buyer_review";
}

/** The item as its customer sees it, and what it waits for. */
export interface CustomerItemView extends ItemView {
  /** The six characters the customer quotes back. */
  readonly reference: string;
  readonly offer: CustomerOffer | null;
  /** The terms both sides last agreed, with their fingerprint; null before anything was agreed. */
  readonly agreed: { readonly terms: OfferTerms; readonly terms_sha: string } | null;
  /**
   * A change the customer asked for to what was agreed, while the business has not answered it: the
   * booking or the order as it would be, and until when it waits. What was agreed stands meanwhile.
   */
  readonly requested_change: {
    readonly terms: OfferTerms;
    readonly terms_sha: string;
    readonly until: string | null;
  } | null;
  /** `you`: the business waits for the customer; `us`: the customer waits for the business; null once closed. */
  readonly waiting_on: "you" | "us" | null;
  readonly next: readonly { readonly action: string; readonly label: string }[];
  /**
   * For a booking or an order: whether the customer may withdraw from it now (ADR-018 §7), until when
   * (null while the goods have not reached them), and the words for the link; why not, when not.
   */
  readonly withdrawal: CustomerWithdrawal | null;
  /** The returns and refunds of this booking or order, oldest first, each in the business's words. */
  readonly refunds: readonly {
    readonly item_id: string;
    readonly reference: string;
    readonly state: string;
    readonly human: string;
  }[];
}

export interface CustomerWithdrawal {
  readonly available: boolean;
  readonly until: string | null;
  /** "Withdraw from contract here", in the words of the law the business sells under. */
  readonly label: string;
  /** Why there is none: excepted (with the words why), the period ended, a business customer, not paid, begun. */
  readonly why?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * The statement a withdrawal sends, as the customer is shown it before they confirm (CRD art. 11a):
 * who, which contract, where their copy goes, and until when they may.
 */
export interface WithdrawalStatement {
  readonly text: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly contract: string;
  readonly reference: string;
  readonly lines?: readonly { readonly index: number; readonly quantity: number }[] | undefined;
  /** It will be a withdrawal; false: it will reach a person at the business as your message, or as a return. */
  readonly available: boolean;
  readonly until: string | null;
  readonly why?: string | undefined;
  readonly label: string;
  /** The button your person presses to send it. */
  readonly confirm: string;
}

export interface CustomerResult {
  readonly view: CustomerItemView;
  /** What an accepted quote became: the booking confirmed, or the order accepted. */
  readonly linked?: CustomerItemView | undefined;
  readonly replayed: boolean;
}

/**
 * A suggestion the business's people answer (a price of the customer's own, or one past the last
 * round), kept as the customer's message: never refused, and what the business proposed still stands.
 */
export interface PassedOnResult {
  readonly view: CustomerItemView;
  readonly waiting_on: "us";
  readonly appended: true;
  /** What to tell the customer, in the business's words. */
  readonly passed_on: string;
  readonly replayed: boolean;
}

interface Deps {
  readonly access: AccessCapabilities;
  readonly people: IdentityCapabilities;
  readonly receipts: ReceiptCapabilities;
  readonly secrets: SecretBox | null;
}

export class CustomerDoors {
  constructor(
    private readonly db: Db,
    private readonly deps: Deps,
  ) {}

  // ---- the status door -------------------------------------------------------

  /**
   * The customer's view of an item in the business's words and language: no flags of the
   * business's, the open offer with its fingerprint, who it waits on, what they can do next.
   */
  async present(item: Item, audience: Audience, now: number): Promise<CustomerItemView> {
    // A message put aside as spam reads as closed, all of it: its words, its buttons, what comes next.
    const seen = item.state === "spam" ? ({ ...item, state: "closed" } as Item) : item;
    const view = viewFor(seen, "customer_agent", undefined, undefined, audience);
    const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    const rows =
      item.type === "booking" || item.type === "order" || item.type === "quote_request"
        ? await offerRows(this.db, item.id)
        : [];
    const open = openOf(rows);
    const agreed = agreedOf(rows);
    const current = offer
      ? offerJson(
          offer,
          offerSummary(item, offer, audience),
          open?.termsSha === offer.termsSha ? open.changes : null,
          now,
        )
      : null;
    // The change they asked for, while we have not answered it.
    const asked = openChange(item)?.by === "customer" ? changeTerms(item) : null;
    const settings = await readSettings(this.db);
    const withdrawal = await this.withdrawalView(item, audience, settings, now);
    const refunds = item.type === "booking" || item.type === "order" ? await this.refundsFor(item, audience) : [];
    const sendBack =
      item.type === "order" &&
      ORDER_SENT.has(item.state) &&
      !refunds.some((r) => r.state === "requested" || r.state === "approved" || r.state === "goods_received");
    return {
      ...view,
      item: customerItem(item),
      reference: shortRef(item.id),
      offer: current,
      agreed: agreed ? { terms: agreed.terms, terms_sha: agreed.termsSha } : null,
      requested_change: asked
        ? {
            terms: asked,
            terms_sha:
              open?.kind === "change" && open.by === "customer" ? open.termsSha : await termsSha("change", asked),
            until:
              open?.kind === "change" && open.by === "customer" && open.validThrough !== null
                ? new Date(open.validThrough).toISOString()
                : null,
          }
        : null,
      waiting_on: waitingOn(item),
      // Past its deadline it can no longer be accepted, whether or not our sweep has closed it yet.
      next: nextActions(
        seen,
        view.transitions.map((t) => t.event),
        audience.lang,
        {
          withdraw: withdrawal?.available ? withdrawal.label : undefined,
          sendBack,
        },
      ).filter((n) => !(current?.expired && n.action === "accept_offer")),
      withdrawal,
      refunds,
    };
  }

  /** The right of withdrawal as the customer reads it: available or why not, until when, in the law's words. */
  private async withdrawalView(
    item: Item,
    audience: Audience,
    settings: Settings,
    now: number,
  ): Promise<CustomerWithdrawal | null> {
    if (item.type !== "booking" && item.type !== "order") return null;
    const right = await withdrawalOf(this.db, item, settings, now);
    // Nothing agreed yet, or the contract ended: nothing to say.
    if (right.why === "not_agreed") return null;
    const words = withdrawalCopy(audience.lang, lawOf(settings.commerce.legal.country));
    return {
      available: right.available,
      until: right.until !== null ? new Date(right.until).toISOString() : null,
      label: words.label,
      ...(right.why ? { why: right.why } : {}),
      ...(right.exception && right.exception !== "standard" ? { reason: words.except[right.exception] } : {}),
    };
  }

  /** The returns and refunds of a booking or an order, oldest first, each in the business's words. */
  private async refundsFor(item: Item, audience: Audience): Promise<CustomerItemView["refunds"]> {
    const rows = await this.db.orm
      .select()
      .from(items)
      .where(and(eq(items.linkedItemId, item.id), eq(items.type, "refund")))
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(20);
    return rows.map((row) => {
      const refund = rowToItem(row);
      return {
        item_id: refund.id,
        reference: shortRef(refund.id),
        state: refund.state,
        human: statusSentence(refund, audience),
      };
    });
  }

  // ---- the confirm step, before a priced request binds -----------------------

  /**
   * Who a customer's request is priced for (ADR-018 §4, Q3): the owner's rewards, and the customer's
   * standing as this inbox knows it (`localStanding`: no network is asked). Worked out once per request
   * and handed to both the confirm step and the create, so what the customer confirms is what is
   * written. Undefined when the owner has no reward, or for anyone but a customer.
   */
  async pricingFor(
    caller: Caller,
    carried: { readonly pass?: string | undefined; readonly key?: string | undefined },
  ): Promise<PricingFor | undefined> {
    if (!isCustomer(caller)) return undefined;
    const settings = await readSettings(this.db);
    const rewards = rewardsOf(settings.negotiation.rewards);
    if (rewards.length === 0) return undefined;
    let credentials: readonly string[] = [];
    try {
      credentials = collectCarried(carried.pass, carried.key, caller.carried).credentials;
    } catch {
      // What is wrong with what they carried, the create says in its own words.
    }
    const standing = await localStanding(this.db, settings, { partyId: caller.actor.partyId, credentials });
    return { rewards, standing };
  }

  /**
   * The confirm step (ADR-018 §5; CRD art. 8(2)): a consumer's request that carries a price binds them
   * only once they confirmed its summary — what, when, from whom, the total, the right of withdrawal —
   * by sending back its `terms_sha`. Without it, or with one for other terms, nothing is written and
   * the answer is `409 confirm_terms` with the summary to show them. True when the request was
   * confirmed; false when nothing needed confirming (a business customer, nothing priced yet, a retry).
   * The request is priced for this customer (`pricing`), so the summary holds their price — the owner's
   * reward for their record included, with its notice.
   */
  async confirmCreate(
    caller: Caller,
    type: "booking" | "order",
    input: {
      readonly payload: unknown;
      readonly contact?: Contact | undefined;
      readonly terms_sha?: string | undefined;
    },
    pricing?: PricingFor,
  ): Promise<boolean> {
    if (!isCustomer(caller)) return false;
    // A retry is answered from what was stored, whatever the terms have become since.
    if (caller.idempotency && (await findIdempotent(this.db, caller.idempotency))) return input.terms_sha !== undefined;
    const settings = await readSettings(this.db);
    if (settings.commerce.customers === "businesses") return false;
    const parsed = payloadSchemas[type].safeParse(input.payload);
    // The create says what is wrong with it, in its own words.
    if (!parsed.success) return false;
    const now = nowOf(caller);
    if (type === "booking" && Date.parse((parsed.data as PayloadOf<"booking">).startTime) <= now) return false;
    const priced = await priceFromCatalogue(this.db, type, parsed.data as Record<string, unknown>, pricing);
    // A price a person has still to set binds nobody yet: the confirm step comes with ours.
    if (priced.unpriced) return false;
    const total = priced.payload.totalPrice as Money | undefined;
    if (!total || total.value <= 0) return false;
    const terms =
      type === "booking"
        ? bookingRequestTerms(priced.payload as PayloadOf<"booking">)
        : orderRequestTerms(priced.payload as PayloadOf<"order">);
    const sha = await termsSha(type === "booking" ? "time" : "order", terms);
    if (input.terms_sha === sha) return true;
    const audience = await audienceFor(this.db, {
      locale: input.contact?.locale ?? caller.locale ?? null,
      settings,
    });
    const summary = await this.confirmSummary(type, priced.payload, audience, settings, now);
    const personalised = (priced.payload as { personalised?: unknown }).personalised !== undefined;
    throw new WriteError("confirm_terms", confirmTermsMessage(summary, sha), {
      details: {
        summary,
        terms_sha: sha,
        obligation_to_pay: true,
        terms,
        // The price is theirs alone, chosen by automated decision: the summary says so (ADR-018 §5).
        ...(personalised ? { disclosures: ["personalised_price"] } : {}),
        ...(input.terms_sha ? { changed: true } : {}),
      },
    });
  }

  /**
   * What a customer confirms before a priced request binds them, in the business's words and their
   * language: the thing and the time or the lines, the total, who we are, the right of withdrawal or
   * why there is none, and that confirming means paying.
   */
  private async confirmSummary(
    type: "booking" | "order",
    payload: Record<string, unknown>,
    a: Audience,
    settings: Settings,
    now: number,
  ): Promise<string> {
    const c = copyFor(a.lang);
    const law = lawOf(settings.commerce.legal.country);
    const words = withdrawalCopy(a.lang, law);
    const total = moneyIn(payload.totalPrice as Money, a.lang);
    const days = String(settings.returns.days);
    const main =
      type === "booking"
        ? c.confirmStep.booking(
            vars({
              what: `"${(payload as PayloadOf<"booking">).reservationFor.name}"`,
              when: whenText((payload as PayloadOf<"booking">).startTime, a.timezone, a.lang),
              total,
            }),
          )
        : c.confirmStep.order(
            vars({ summary: orderLinesText((payload as PayloadOf<"order">).orderedItem, a.lang), total }),
          );
    const legal = settings.commerce.legal;
    const trader = legal.legalName.trim()
      ? c.confirmStep.trader(vars({ business: legal.legalName.trim(), address: legal.address.trim() }))
      : "";
    const flags = await withdrawalFlagsOf(this.db, type, payload);
    const excepted = flags.find((f) => f !== "standard") as keyof typeof words.except | undefined;
    const start = type === "booking" ? Date.parse((payload as PayloadOf<"booking">).startTime) : Number.NaN;
    const withdrawal = excepted
      ? words.except[excepted]
      : type === "order"
        ? words.lineGoods(vars({ days }))
        : `${words.lineService(vars({ days }))}${start - now < settings.returns.days * 86_400_000 ? ` ${words.startsEarly}` : ""}`;
    return [main, personalisedLine(payload, a), trader, withdrawal, c.confirmStep.obligation(vars({ total }))]
      .filter(Boolean)
      .join(" ");
  }

  // ---- withdrawal and returns ------------------------------------------------

  /**
   * "Withdraw from contract here" (ADR-018 §7; CRD art. 11a): without `confirm_withdrawal`, nothing
   * is sent and the answer is the statement to show the customer (`confirm_withdrawal`); with it, the
   * withdrawal — the booking or order ends, or its goods come back — and an acknowledgement by email.
   * Never refused: where the right has run out, or the goods are excepted, it becomes a return under
   * our policy once they have them, and otherwise their message for a person, and says why.
   */
  async withdraw(caller: Caller, input: T.WithdrawInput): Promise<CustomerResult | PassedOnResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:withdraw_from_contract");
    const c = await this.customerCaller(caller, input);
    const hashInput = {
      door: "withdraw_from_contract",
      item_id: input.item_id,
      lines: input.lines ?? null,
      note: input.note ?? null,
    };
    // A retry: answered from what was stored, whichever way the first went.
    let appendOnly = false;
    if (input.confirm_withdrawal && c.idempotency && (await findIdempotent(this.db, c.idempotency))) {
      for (const event of ["withdraw", "request_return"]) {
        try {
          return this.result(await transitionItem(this.db, c, { itemId: input.item_id, event, hashInput }), c);
        } catch (error) {
          if (!(error instanceof WriteError && error.code === "idempotency_mismatch")) throw error;
        }
      }
      appendOnly = true;
    }
    const settings = await readSettings(this.db);
    const law = lawOf(settings.commerce.legal.country);
    for (let attempt = 1; ; attempt++) {
      const row = await this.loadOwned(c, input.item_id);
      const item = rowToItem(row);
      const audience = await this.audienceOf(item, c);
      const words = withdrawalCopy(audience.lang, law);
      const right =
        item.type === "booking" || item.type === "order" ? await withdrawalOf(this.db, item, settings, nowOf(c)) : null;
      if (!right || right.why === "not_agreed") {
        throw new WriteError("wrong_state", copyFor(audience.lang).returns.problems.notAgreed, {
          details: { state: item.state },
        });
      }
      const statement = await this.statementOf(item, audience, words, right, input.lines);
      if (!input.confirm_withdrawal) {
        throw new WriteError(
          "confirm_withdrawal",
          `Nothing is sent yet. Show your person this, and send confirm_withdrawal: true once they confirm (${statement.confirm}): ${statement.text}`,
          { details: { statement } },
        );
      }
      const said = {
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        ...(input.lines?.length ? { lines: input.lines } : {}),
      };
      if (right.available && !appendOnly) {
        try {
          const r = await transitionItem(this.db, c, {
            itemId: item.id,
            event: "withdraw",
            ...(Object.keys(said).length ? { input: said } : {}),
            expectedVersion: item.version,
            hashInput,
          });
          return this.result(r, c);
        } catch (error) {
          if (error instanceof WriteError && error.code === "version_conflict" && attempt < 3) continue;
          // The period ended between our read and the write: judged as below.
          if (!(error instanceof WriteError && error.code === "guard_failed" && guardOf(error) === "withdrawal_open")) {
            throw error;
          }
        }
      }
      // Once the goods reached them, a return under our own policy, which we answer.
      if (
        !appendOnly &&
        item.type === "order" &&
        ORDER_SENT.has(item.state) &&
        !(await openReturnOf(this.db, item.id))
      ) {
        try {
          const r = await transitionItem(this.db, c, {
            itemId: item.id,
            event: "request_return",
            input: { reasonCode: "changed_mind", ...said },
            expectedVersion: item.version,
            hashInput,
          });
          return this.result(r, c);
        } catch (error) {
          if (error instanceof WriteError && error.code === "version_conflict" && attempt < 3) continue;
          throw error;
        }
      }
      // Otherwise their message, for a person to answer: never refused.
      const text = [statement.text, input.note?.trim() ?? ""].filter(Boolean).join("\n\n");
      const { result, replayed } = await once(this.db, c, "public.withdraw_from_contract", hashInput, async () => {
        await appendThreadEntry(this.db, c, item, text, "in");
        return item;
      });
      const fresh = await this.audienceOf(result, c);
      return {
        view: await this.present(result, fresh, nowOf(c)),
        waiting_on: "us",
        appended: true,
        passed_on: words.passedOn(vars({ status: statement.why ?? "" })),
        replayed,
      };
    }
  }

  /** The statement a withdrawal sends, prefilled from what we know of the customer and the contract. */
  private async statementOf(
    item: Item,
    audience: Audience,
    words: WithdrawalCopy,
    right: WithdrawalRight,
    lines: readonly { readonly index: number; readonly quantity: number }[] | undefined,
  ): Promise<WithdrawalStatement> {
    const what = whatOf(item, audience.lang) || copyFor(audience.lang).yourNoun[item.type];
    const ref = shortRef(item.id);
    const [party] = await this.db.orm
      .select({ contact: parties.contact, name: parties.displayName })
      .from(parties)
      .where(eq(parties.id, item.partyId));
    const contact = (party?.contact ?? null) as { email?: unknown; name?: unknown } | null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const why =
      right.why === "excepted" && right.exception && right.exception !== "standard"
        ? words.except[right.exception]
        : right.why && right.why !== "not_agreed"
          ? words.noRight(vars({ yourNoun: copyFor(audience.lang).yourNoun[item.type] }))
          : undefined;
    return {
      text: words.statement(vars({ what, ref })),
      name: str(contact?.name) ?? str(party?.name),
      email: str(contact?.email),
      contract: `${what}, ${ref}`,
      reference: ref,
      ...(lines?.length ? { lines } : {}),
      available: right.available,
      until: right.until !== null ? new Date(right.until).toISOString() : null,
      ...(why ? { why } : {}),
      label: words.label,
      confirm: words.confirm,
    };
  }

  /**
   * The customer asks to send goods back (ADR-018 §3.4): faulty, not as described or the wrong item
   * (the legal guarantee), or a change of mind — a withdrawal while the period runs, else under our own
   * policy. A return, linked to the order; the order stands as fulfilled.
   */
  async requestReturn(caller: Caller, input: T.RequestReturnInput): Promise<CustomerResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:request_return");
    const c = await this.customerCaller(caller, input);
    const hashInput = {
      door: "request_return",
      item_id: input.item_id,
      reason: input.reason,
      lines: input.lines ?? null,
      wants: input.wants ?? null,
      note: input.note ?? null,
    };
    const replayed = await this.replayIfSeen(c, input.item_id, "request_return", hashInput);
    if (replayed) return replayed;
    for (let attempt = 1; ; attempt++) {
      const item = rowToItem(await this.loadOwned(c, input.item_id));
      if (item.type !== "order" || !ORDER_SENT.has(item.state)) {
        const audience = await this.audienceOf(item, c);
        throw new WriteError("wrong_state", copyFor(audience.lang).returns.problems.nothingToReturn, {
          details: { state: item.state },
        });
      }
      try {
        const r = await transitionItem(this.db, c, {
          itemId: item.id,
          event: "request_return",
          input: {
            reasonCode: input.reason,
            ...(input.lines?.length ? { lines: input.lines } : {}),
            ...(input.wants ? { wants: input.wants } : {}),
            ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          },
          expectedVersion: item.version,
          hashInput,
        });
        return this.result(r, c);
      } catch (error) {
        if (error instanceof WriteError && error.code === "version_conflict" && attempt < 3) continue;
        throw error;
      }
    }
  }

  /** Who the item's customer is spoken to as: their language, what we asked, who closed it. */
  async audienceOf(item: Item, caller?: Caller, facts?: BusinessFacts): Promise<Audience> {
    const [question, closer] = await Promise.all([
      item.state === "needs_info" ? noteOf(this.db, item.id, "request_info") : Promise.resolve(null),
      item.closedAt !== null ? lastEvent(this.db, item.id) : Promise.resolve(null),
    ]);
    return audienceFor(this.db, {
      locale: caller?.locale,
      partyId: item.partyId,
      question: question ?? undefined,
      closedByCustomer:
        closer !== null && (isCustomerKind(closer.actorKind) || closer.event.startsWith("record_cancel")),
      facts,
    });
  }

  /**
   * The page the code email links to (ADR-017 §2.1): the networks this inbox asks for a first-time
   * customer's code, what they keep, what it is for and how to stop, in the business's name. The
   * language the link names, else the browser's, else the business's first.
   */
  async privacy(opts: { readonly lang?: string | null; readonly acceptLanguage?: string | null } = {}) {
    const facts = await businessFacts(this.db);
    const lang =
      opts.lang === "pt" || opts.lang === "en"
        ? opts.lang
        : (langFromHeader(opts.acceptLanguage) ?? customerLang(null, facts.languages));
    return privacyPage({
      lang,
      business: facts.name,
      networks: await issuingNetworks(this.db, await readSettings(this.db)),
    });
  }

  // ---- the assistant door ----------------------------------------------------

  /**
   * The customer says yes to what the business proposed: another time for a booking, or a quote.
   * Without the fingerprint of the terms they were shown, nothing is written (`confirm_terms`, with
   * the terms); with another fingerprint, nothing either (`offer_changed`, with the current terms).
   */
  async acceptOffer(caller: Caller, input: T.AcceptOfferInput): Promise<CustomerResult | PassedOnResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:accept_offer");
    const c = await this.customerCaller(caller, input);
    const hashInput = { door: "accept_offer", item_id: input.item_id, terms_sha: input.terms_sha ?? null };
    try {
      const replayed = await this.replayIfSeen(c, input.item_id, "accept", hashInput);
      if (replayed) return replayed;
    } catch (error) {
      if (!(error instanceof WriteError && error.code === "idempotency_mismatch")) throw error;
      // A retry of a yes that went to a person (below): the same answer again, or, for another
      // request under the same key, the mismatch.
      return this.acceptancePassedOn(c, rowToItem(await this.loadOwned(c, input.item_id)), hashInput, "");
    }
    for (let attempt = 1; ; attempt++) {
      const row = await this.loadOwned(c, input.item_id);
      const item = rowToItem(row);
      const audience = await this.audienceOf(item, c);
      const words = copyFor(audience.lang);
      const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
      if (!offer) throw new WriteError("no_offer", words.problems.noOffer, { details: { state: item.state } });
      const summary = offerSummary(item, offer, audience);
      const current = offerJson(offer, summary, null, nowOf(c));
      if (input.offer_id && input.offer_id !== (offer.id ?? legacyOfferId(item.id))) {
        throw new WriteError("offer_changed", words.problems.offerChanged(vars({ summary })), {
          details: { offer: current },
        });
      }
      const lapsed = lapsedAt(item, offer, audience.minNoticeMin);
      if (lapsed && nowOf(c) > Date.parse(lapsed)) {
        const at = whenText(lapsed, audience.timezone, audience.lang);
        throw new WriteError(
          "offer_expired",
          offer.kind === "quote"
            ? words.problems.offerExpired(vars({ validThrough: at }))
            : offer.kind === "order"
              ? words.problems.changesLapsed(vars({ deadline: at }))
              : offer.kind === "change"
                ? words.problems.changeLapsed(vars({ deadline: at }))
                : words.problems.timeLapsed(vars({ deadline: at })),
          { details: { validThrough: lapsed } },
        );
      }
      if (!input.terms_sha) {
        throw new WriteError("confirm_terms", confirmTermsMessage(summary, offer.termsSha), {
          details: { summary, terms_sha: offer.termsSha, obligation_to_pay: offer.obligationToPay, offer: current },
        });
      }
      if (input.terms_sha !== offer.termsSha) {
        throw new WriteError("offer_changed", words.problems.offerChanged(vars({ summary })), {
          details: { offer: current },
        });
      }
      try {
        const r = await transitionItem(this.db, c, {
          itemId: item.id,
          // A change we asked for to what was agreed is accepted as a change: the promise moves.
          event: offer.kind === "change" ? "accept_change" : "accept",
          expectedVersion: item.version,
          hashInput,
        });
        return this.result(r, c);
      } catch (error) {
        // The item moved between our read and the write: read it again and judge afresh.
        if (error instanceof WriteError && error.code === "version_conflict" && attempt < 3) continue;
        // Our change can no longer be made online — payment was asked for since and it moves the
        // total, or a network now holds the promise — so their yes goes to a person as their
        // message, never refused; what was agreed stands until a person answers (ADR-018 §3.2).
        if (
          offer.kind === "change" &&
          error instanceof WriteError &&
          error.code === "guard_failed" &&
          ACCEPT_PASSED_ON.has(guardOf(error))
        ) {
          return this.acceptancePassedOn(c, item, hashInput, acceptanceText(offer, audience));
        }
        throw error;
      }
    }
  }

  /** A yes to our change a person takes: kept as the customer's message, once, and they are told so. */
  private async acceptancePassedOn(c: Caller, item: Item, hashInput: unknown, said: string): Promise<PassedOnResult> {
    const { result, replayed } = await once(this.db, c, "public.accept_offer", hashInput, async () => {
      await appendThreadEntry(this.db, c, item, said, "in");
      return item;
    });
    const fresh = await this.audienceOf(result, c);
    return {
      view: await this.present(result, fresh, nowOf(c)),
      waiting_on: "us",
      appended: true,
      passed_on: changePassedOn(result, fresh),
      replayed,
    };
  }

  /** The customer says no to what the business proposed: a booking's other time closes the request; a quote is declined. */
  async declineOffer(caller: Caller, input: T.DeclineOfferInput): Promise<CustomerResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:decline_offer");
    const c = await this.customerCaller(caller, input);
    const hashInput = {
      door: "decline_offer",
      item_id: input.item_id,
      reason: input.reason ?? null,
      ...(input.offer_id ? { offer_id: input.offer_id } : {}),
      ...(input.reason_code ? { reason_code: input.reason_code } : {}),
    };
    const replayed = await this.replayIfSeen(c, input.item_id, "decline", hashInput);
    if (replayed) return replayed;
    for (let attempt = 1; ; attempt++) {
      const row = await this.loadOwned(c, input.item_id);
      const item = rowToItem(row);
      // Their no to a time or to changes we proposed closes their request, as they chose; to a quote,
      // declines it. To a change we asked for to what was agreed, it keeps what was agreed; on a change
      // of their own, it takes it back.
      const change = openChange(item);
      const event =
        (item.type === "booking" || item.type === "order") && item.state === "proposed"
          ? "cancel"
          : item.type === "quote_request" && item.state === "quoted"
            ? "decline"
            : change
              ? change.by === "business"
                ? "decline_change"
                : "retract_change"
              : null;
      if (!event) {
        const audience = await this.audienceOf(item, c);
        throw new WriteError("no_offer", copyFor(audience.lang).problems.nothingToAnswer, {
          details: { state: item.state },
        });
      }
      if (event === "retract_change") await this.assertOwnChangePinned(c, item, input.offer_id);
      else await this.assertOfferPinned(c, item, input.offer_id);
      const said = input.reason?.trim();
      try {
        // Written only on the item as it was checked: a no to one offer never closes the next.
        const r = await transitionItem(this.db, c, {
          itemId: item.id,
          event,
          ...(said || input.reason_code
            ? {
                input: {
                  ...(said ? { note: said } : {}),
                  ...(input.reason_code ? { reasonCode: input.reason_code } : {}),
                },
              }
            : {}),
          ...(said ? { reason: said } : {}),
          expectedVersion: item.version,
          hashInput,
        });
        return this.result(r, c);
      } catch (error) {
        // The item moved between our read and the write: read it again and judge afresh.
        if (error instanceof WriteError && error.code === "version_conflict" && attempt < 3) continue;
        throw error;
      }
    }
  }

  /**
   * The customer asks for another time than the one we proposed: back to the business, nothing held.
   * Past the last round it goes to a person as their message, and what we proposed still stands.
   */
  async suggestTime(caller: Caller, input: T.SuggestTimeInput): Promise<CustomerResult | PassedOnResult> {
    return this.makeOffer(caller, {
      item_id: input.item_id,
      terms: { start_time: input.start_time },
      ...(input.note ? { note: input.note } : {}),
      ...(input.access_token ? { access_token: input.access_token } : {}),
      ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
      ...(input.pass ? { pass: input.pass } : {}),
      ...(input.key ? { key: input.key } : {}),
      door: "suggest_time",
    });
  }

  /**
   * The customer's own terms in answer to what we proposed (ADR-018 §2, §6): another time, other
   * quantities, another delivery date, back to the business as their request. A price of their own
   * (price counters are off, Q1), a change we cannot take as a request, or one past the last round
   * goes to a person as their message (`passed_on`): never refused, and what we proposed stands.
   */
  async makeOffer(
    caller: Caller,
    input: T.MakeOfferInput & { readonly door?: "suggest_time" },
  ): Promise<CustomerResult | PassedOnResult> {
    const door = input.door ?? "make_offer";
    await this.deps.access.requireScope(caller, ["inbox:write"], `public:${door}`);
    const c = await this.customerCaller(caller, input);
    const hashInput =
      door === "suggest_time"
        ? {
            door,
            item_id: input.item_id,
            start_time: input.terms.start_time ?? null,
            note: input.note ?? null,
          }
        : {
            door,
            item_id: input.item_id,
            offer_id: input.offer_id ?? null,
            terms: input.terms,
            note: input.note ?? null,
            reason_code: input.reason_code ?? null,
          };
    // A retry: answered from what was stored, whichever way the first answer went.
    let appendOnly = false;
    if (c.idempotency && (await findIdempotent(this.db, c.idempotency))) {
      try {
        const replayed = await this.replayIfSeen(c, input.item_id, "counter", hashInput);
        if (replayed) return replayed;
      } catch (error) {
        if (!(error instanceof WriteError && error.code === "idempotency_mismatch")) throw error;
        appendOnly = true;
      }
    }
    const t = input.terms;
    let item: Item;
    let audience: Audience;
    let offer: OpenOffer;
    /** The promise stands as agreed while a person reads what the customer asked to change. */
    let promise = false;
    for (let attempt = 1; ; attempt++) {
      item = rowToItem(await this.loadOwned(c, input.item_id));
      audience = await this.audienceOf(item, c);
      if (isChangeable(item)) {
        // A change to what was agreed: their other time, quantities or delivery date.
        if (door === "suggest_time" && item.type !== "booking") {
          throw new WriteError("no_offer", copyFor(audience.lang).problems.nothingToAnswer, {
            details: { state: item.state },
          });
        }
        await this.assertChangePinned(c, item, input.offer_id);
        const moved = await this.changeOf(c, item, input, t, hashInput, appendOnly);
        offer = standingOffer(item);
        promise = true;
        if (moved === null) break;
        if (moved !== "retry") return moved;
        if (attempt >= 3) throw new WriteError("version_conflict", "the item changed while we answered it: try again");
        continue;
      }
      const found = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
      if (!found || (door === "suggest_time" && found.kind !== "time")) {
        throw new WriteError("no_offer", copyFor(audience.lang).problems.nothingToAnswer, {
          details: { state: item.state },
        });
      }
      offer = found;
      await this.assertOfferPinned(c, item, input.offer_id, offer);
      const moved = await this.counterOf(c, item, offer, input, t, hashInput, appendOnly);
      if (moved === null) break;
      if (moved !== "retry") return moved;
      // The item moved between our read and the write: read it again and judge afresh.
      if (attempt >= 3) throw new WriteError("version_conflict", "the item changed while we answered it: try again");
    }
    const said = suggestionText(t, input.note, offer, audience);
    if (!said) {
      throw new WriteError(
        "invalid_input",
        "Say what your person would change (terms.start_time, terms.lines, terms.quantity, terms.delivery_when or terms.total_price), or what they want to tell the business (note).",
        {
          fields: [{ path: "terms", problem: "missing", message: "at least one change" }],
        },
      );
    }
    const { result, replayed } = await once(this.db, c, `public.${door}`, hashInput, async () => {
      await appendThreadEntry(this.db, c, item, said, "in");
      return item;
    });
    const fresh = await this.audienceOf(result, c);
    // What we proposed stands until its date: once that has passed, nothing is said to stand.
    const stands = offer.deadline !== null && Date.parse(offer.deadline) > nowOf(c);
    const deadline = stands && offer.deadline ? whenText(offer.deadline, fresh.timezone, fresh.lang) : "";
    return {
      view: await this.present(result, fresh, nowOf(c)),
      waiting_on: "us",
      appended: true,
      passed_on: promise ? changePassedOn(result, fresh) : copyFor(fresh.lang).problems.passedOn(vars({ deadline })),
      replayed,
    };
  }

  /**
   * The customer's change to what was agreed, as their request to the business, when it is one we
   * can take as one: another time for a booking; quantities or a delivery date for an order. Null when
   * it is for a person to read — a price, a party size, past the last round or the changes the promise
   * may have, one a network holding it could not take, a new total once payment was asked for;
   * "retry" when the item moved meanwhile.
   */
  private async changeOf(
    c: Caller,
    item: Item,
    input: T.MakeOfferInput,
    t: T.MakeOfferInput["terms"],
    hashInput: unknown,
    appendOnly: boolean,
  ): Promise<CustomerResult | "retry" | null> {
    const note = input.note?.trim() ? { note: input.note.trim() } : {};
    const reason = input.reason_code ? { reasonCode: input.reason_code } : {};
    const priced = t.total_price !== undefined || (t.lines ?? []).some((l) => l.unit_price !== undefined);
    let change: Record<string, unknown> | null = null;
    if (!priced && !appendOnly) {
      if (
        item.type === "booking" &&
        t.start_time &&
        t.party_size === undefined &&
        !t.lines &&
        !t.quantity &&
        !t.delivery_when
      ) {
        change = { startTime: t.start_time, ...note, ...reason };
      } else if (
        item.type === "order" &&
        (t.lines?.length || t.delivery_when) &&
        !t.start_time &&
        !t.quantity &&
        t.party_size === undefined
      ) {
        change = {
          ...(t.lines?.length ? { lines: t.lines.map((l) => ({ index: l.index, quantity: l.quantity })) } : {}),
          ...(t.delivery_when ? { deliveryWhen: t.delivery_when } : {}),
          ...note,
          ...reason,
        };
      }
    }
    if (!change) return null;
    try {
      // Written only on the item as it was checked: a change named for one offer never lands on the next.
      const r = await transitionItem(this.db, c, {
        itemId: item.id,
        event: "propose_change",
        input: change,
        expectedVersion: item.version,
        hashInput,
      });
      return this.result(r, c);
    } catch (error) {
      if (error instanceof WriteError && error.code === "version_conflict") return "retry";
      if (error instanceof WriteError && error.code === "guard_failed" && PASSED_ON_GUARDS.has(guardOf(error))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The customer's own terms as their request, when they are something we can take as one: another
   * time, quantities, a delivery date, how many or for when. Null when it is for a person to read
   * (a price, a change we cannot take, past the last round); "retry" when the item moved meanwhile.
   */
  private async counterOf(
    c: Caller,
    item: Item,
    offer: OpenOffer,
    input: T.MakeOfferInput,
    t: T.MakeOfferInput["terms"],
    hashInput: unknown,
    appendOnly: boolean,
  ): Promise<CustomerResult | "retry" | null> {
    const note = input.note?.trim() ? { note: input.note.trim() } : {};
    const reason = input.reason_code ? { reasonCode: input.reason_code } : {};
    const priced = t.total_price !== undefined || (t.lines ?? []).some((l) => l.unit_price !== undefined);
    // What becomes their request: a time for a booking; quantities or delivery for an order; how many
    // or for when for a quote. Anything else is for a person to read.
    let counter: Record<string, unknown> | null = null;
    /** The catalogue lines they suggest a price of their own for, counted against how often they may. */
    let pricedRefs: string[] = [];
    if (priced && !appendOnly) {
      // A price of their own is their answer only while the owner takes price counters (Q1), on what may
      // be haggled, and within how often one customer may: else a person reads it. Never refused.
      const asked = await this.priceCounter(c, item, offer, t);
      if (asked) {
        pricedRefs = asked.refs;
        counter =
          offer.kind === "time"
            ? {
                startTime: t.start_time ?? offer.terms.startTime,
                totalPrice: t.total_price,
                ...note,
                ...reason,
              }
            : {
                lines: (t.lines ?? []).map((l) => ({
                  index: l.index,
                  quantity: l.quantity,
                  ...(l.unit_price ? { unitPrice: l.unit_price } : {}),
                })),
                ...(t.delivery_when ? { deliveryWhen: t.delivery_when } : {}),
                ...note,
                ...reason,
              };
      }
    }
    if (!priced && !appendOnly) {
      if (
        offer.kind === "time" &&
        t.start_time &&
        t.party_size === undefined &&
        !t.lines &&
        !t.quantity &&
        !t.delivery_when
      ) {
        counter = { startTime: t.start_time, ...note, ...reason };
      } else if (
        offer.kind === "order" &&
        (t.lines?.length || t.delivery_when) &&
        !t.start_time &&
        !t.quantity &&
        t.party_size === undefined
      ) {
        counter = {
          ...(t.lines?.length ? { lines: t.lines.map((l) => ({ index: l.index, quantity: l.quantity })) } : {}),
          ...(t.delivery_when ? { deliveryWhen: t.delivery_when } : {}),
          ...note,
          ...reason,
        };
      } else if (
        offer.kind === "quote" &&
        (t.quantity || t.start_time) &&
        !t.lines &&
        !t.delivery_when &&
        t.party_size === undefined
      ) {
        counter = {
          ...(t.quantity ? { quantity: t.quantity } : {}),
          ...(t.start_time ? { startTime: t.start_time } : {}),
          ...note,
          ...reason,
        };
      }
    }
    if (counter) {
      try {
        // Written only on the item as it was checked: an answer named for one offer never answers the next.
        const r = await transitionItem(this.db, c, {
          itemId: item.id,
          event: "counter",
          input: counter,
          expectedVersion: item.version,
          hashInput,
          ...(pricedRefs.length ? { meta: { priced: pricedRefs } } : {}),
        });
        return this.result(r, c);
      } catch (error) {
        if (error instanceof WriteError && error.code === "version_conflict") return "retry";
        // Past the last round: a person answers it, as the customer's message.
        const rounds =
          error instanceof WriteError &&
          error.code === "guard_failed" &&
          (error.details as { guard?: unknown } | undefined)?.guard === "round_left";
        if (!rounds) throw error;
      }
    }
    return null;
  }

  /**
   * Whether the customer's own price, answering what we proposed, is their counter (ADR-018 §4, Q1):
   * the owner takes price counters; it answers a time we proposed (a total, the time kept or another)
   * or changes to an order (unit prices by line, and nothing but lines and a delivery date); nothing it
   * prices is marked not to be haggled; and the customer — their party, the assistant that signs for
   * them, or their device — has fewer than `negotiation.perCustomer.open` other negotiations on price
   * open and has suggested a price for each of these fewer than `perCustomer.priceCounters` times in
   * `perCustomer.days`. Null when a person reads it instead; never refused. What it names for counting:
   * `service:<id>`, `product:<id>`.
   */
  private async priceCounter(
    c: Caller,
    item: Item,
    offer: OpenOffer,
    t: T.MakeOfferInput["terms"],
  ): Promise<{ refs: string[] } | null> {
    const settings = await readSettings(this.db);
    const n = settings.negotiation;
    if (!n.priceCounters) return null;
    const refs: string[] = [];
    if (offer.kind === "time" && item.type === "booking") {
      if (t.total_price === undefined || t.lines || t.quantity || t.delivery_when || t.party_size !== undefined) {
        return null;
      }
      const serviceId = item.payload.reservationFor.serviceId;
      const [svc] = await this.db.orm
        .select({ negotiable: services.negotiable })
        .from(services)
        .where(eq(services.id, serviceId));
      if (svc?.negotiable === 0) return null;
      refs.push(`service:${serviceId}`);
    } else if (offer.kind === "order" && item.type === "order") {
      if (t.total_price !== undefined || !t.lines?.length || t.start_time || t.quantity || t.party_size !== undefined) {
        return null;
      }
      const offered = offer.terms.lines ?? [];
      const ids = t.lines.flatMap((l) => {
        const id = l.unit_price ? offered[l.index]?.productId : undefined;
        return id ? [id] : [];
      });
      for (const id of [...new Set(ids)]) {
        const [p] = await this.db.orm
          .select({ negotiable: products.negotiable })
          .from(products)
          .where(eq(products.id, id));
        if (p?.negotiable === 0) return null;
        refs.push(`product:${id}`);
      }
    } else {
      // A quote is the business's price for what the catalogue does not price: a person answers another.
      return null;
    }
    const since = nowOf(c) - n.perCustomer.days * 86_400_000;
    const [row] = await this.db.orm
      .select({ partyId: items.partyId, thumbprint: items.agentThumbprint })
      .from(items)
      .where(eq(items.id, item.id));
    const who = `(i.party_id = ? OR (? IS NOT NULL AND i.agent_thumbprint = ?) OR e.actor_id = ?)`;
    const whoParams = [row?.partyId ?? "", row?.thumbprint ?? null, row?.thumbprint ?? null, c.actor.id];
    for (const ref of refs) {
      const { rows } = await this.db.client.query({
        sql: `SELECT COUNT(*) FROM item_events e JOIN items i ON i.id = e.item_id
               WHERE e.event = 'counter' AND e.created_at >= ?
                 AND EXISTS (SELECT 1 FROM json_each(e.meta, '$.priced') j WHERE j.value = ?)
                 AND ${who}`,
        params: [since, ref, ...whoParams],
        method: "all",
      });
      if (Number(rows[0]?.[0] ?? 0) >= n.perCustomer.priceCounters) return null;
    }
    const { rows: open } = await this.db.client.query({
      sql: `SELECT COUNT(DISTINCT i.id) FROM item_events e JOIN items i ON i.id = e.item_id
             WHERE e.event = 'counter' AND json_extract(e.meta, '$.priced') IS NOT NULL AND i.id <> ?
               AND i.closed_at IS NULL
               AND EXISTS (SELECT 1 FROM item_offers o WHERE o.item_id = i.id AND o.status = 'open')
               AND ${who}`,
      params: [item.id, ...whoParams],
      method: "all",
    });
    if (Number(open[0]?.[0] ?? 0) >= n.perCustomer.open) return null;
    return { refs };
  }

  /**
   * The customer answers what the business asked. An item waiting on their details moves on
   * (`provide_info`, ADR-018 N14); on any other item the answer is kept as their message, for the
   * business to read. Never refused for the state it is in.
   */
  async provideDetails(
    caller: Caller,
    input: T.ProvideDetailsInput,
  ): Promise<CustomerResult | { view: CustomerItemView; waiting_on: "us"; replayed: boolean; appended: true }> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:provide_details");
    const c = await this.customerCaller(caller, input);
    const hashInput = { door: "provide_details", item_id: input.item_id, details: input.details };
    // A retry: answered from what was stored, whichever way the first answer went.
    let appendOnly = false;
    if (c.idempotency && (await findIdempotent(this.db, c.idempotency))) {
      try {
        const replayed = await this.replayIfSeen(c, input.item_id, "provide_info", hashInput);
        if (replayed) return replayed;
      } catch (error) {
        if (!(error instanceof WriteError && error.code === "idempotency_mismatch")) throw error;
        appendOnly = true;
      }
    }
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    if (item.state === "needs_info" && !appendOnly) {
      const r = await transitionItem(this.db, c, {
        itemId: item.id,
        event: "provide_info",
        input: { note: input.details },
        hashInput,
      });
      return this.result(r, c);
    }
    const { result, replayed } = await once(this.db, c, "public.provide_details", hashInput, async () => {
      // Put aside as spam: kept where the business put it, and nobody is told.
      if (item.state === "spam") {
        await appendThreadEntry(this.db, c, item, input.details, "in", undefined, { quiet: true });
        return item;
      }
      if (item.type === "message" && item.state !== "open") {
        const r = await transitionItem(this.db, c, {
          itemId: item.id,
          event: "reopen",
          input: { note: input.details },
        });
        return r.view.item;
      }
      await appendThreadEntry(this.db, c, item, input.details, "in");
      return item;
    });
    const audience = await this.audienceOf(result, c);
    return { view: await this.present(result, audience, nowOf(c)), waiting_on: "us", replayed, appended: true };
  }

  // ---- links in the business's email -----------------------------------------

  /** The page a link opens. It only shows: nothing a GET does is written. */
  async linkView(
    token: string,
    opts: { readonly now: number; readonly from?: string | undefined; readonly acceptLanguage?: string | null },
  ): Promise<CustomerPage> {
    const ctx = await this.linkContext(token, opts.acceptLanguage ?? null);
    if ("page" in ctx) return ctx.page;
    if (ctx.row.action === "networks_off") return this.networksPage(ctx, opts.now);
    return this.pageFor(ctx, opts.now, { from: opts.from });
  }

  /**
   * A POST from the page: checked against what the page showed (the terms and the item's version),
   * then one transition, which also marks the link used. Answers a redirect to the page, which then
   * shows what was done, or a page that says why not.
   */
  async linkAct(
    token: string,
    form: Readonly<Record<string, string | undefined>>,
    opts: { readonly now: number; readonly acceptLanguage?: string | null },
  ): Promise<LinkActResult> {
    const ctx = await this.linkContext(token, opts.acceptLanguage ?? null);
    if ("page" in ctx) return { page: ctx.page };
    const { row, item, audience } = ctx;
    const now = opts.now;
    const words = copyFor(audience.lang).page;
    if (row.action === "networks_off") return this.stopFromLink(ctx, form, now);
    if (row.usedAt !== null)
      return { page: this.plain(ctx, 409, words.alreadyDone(vars({ status: status(item, audience) }))) };
    const blocked = await this.blocked(ctx, now);
    if (blocked) return { page: blocked };
    const terms = form.terms ?? "";
    const version = Number(form.v);
    // A scanner, a script, a form that did not come from this page: nothing is done.
    if (!terms || !Number.isInteger(version) || version < 1) {
      return { page: await this.pageFor(ctx, now, { error: words.notSent, status: 422 }) };
    }
    if (terms !== row.termsSha) return { page: this.plain(ctx, 409, words.offerChanged) };

    let event: string;
    let input: Record<string, unknown> | undefined;
    const reason = (form.reason ?? form.note ?? "").trim().slice(0, 2_000);
    switch (row.action) {
      case "accept_time":
      case "accept_quote":
      case "accept_order":
        event = "accept";
        break;
      case "decline_time":
      case "decline_order":
        event = "cancel";
        input = reason ? { note: reason } : undefined;
        break;
      case "decline_quote":
        event = "decline";
        input = reason ? { note: reason } : undefined;
        break;
      case "accept_change":
        event = "accept_change";
        break;
      case "keep_as_is":
        event = "decline_change";
        input = reason ? { note: reason } : undefined;
        break;
      case "change_time": {
        const start = form.start ?? "";
        if (!start || !Number.isFinite(Date.parse(start))) {
          return {
            page: await this.pageFor(ctx, now, { error: words.otherTime.nothingChosen, status: 422, from: form.from }),
          };
        }
        event = "propose_change";
        input = { startTime: new Date(Date.parse(start)).toISOString(), ...(reason ? { note: reason } : {}) };
        break;
      }
      case "other_time": {
        const start = form.start ?? "";
        if (!start || !Number.isFinite(Date.parse(start))) {
          return {
            page: await this.pageFor(ctx, now, { error: words.otherTime.nothingChosen, status: 422, from: form.from }),
          };
        }
        event = "counter";
        input = { startTime: new Date(Date.parse(start)).toISOString(), ...(reason ? { note: reason } : {}) };
        break;
      }
      case "details": {
        const details = (form.details ?? "").trim();
        if (!details) return { page: await this.pageFor(ctx, now, { error: words.details.empty, status: 422 }) };
        event = "provide_info";
        input = { note: details.slice(0, 5_000) };
        break;
      }
      case "withdraw":
        event = "withdraw";
        input = reason ? { note: reason } : undefined;
        break;
    }
    const caller: Caller = {
      actor: { kind: "customer_human", id: `link:${row.jti}`, partyId: item.partyId, channel: "action_link" },
      tier: "verified_principal",
      sandbox: item.flags.sandbox,
      locale: audience.lang,
      idempotency: { scope: "link", key: `link:${row.jti}` },
      now: () => now,
    };
    let expected = version;
    for (let attempt = 1; ; attempt++) {
      try {
        await transitionItem(this.db, caller, {
          itemId: item.id,
          event,
          ...(input ? { input } : {}),
          ...(event === "cancel" || event === "decline" || event === "decline_change"
            ? reason
              ? { reason }
              : {}
            : {}),
          expectedVersion: expected,
          extraStatements: [linkUsedStatement(row.jti, now)],
          hashInput: { link: row.jti, event, input: input ?? null },
        });
        return { redirect: `/c/${token}` };
      } catch (error) {
        if (!(error instanceof WriteError)) throw error;
        // Past the last round, the time they chose goes to a person as their message; so does a change
        // the promise cannot take by asking (too many, or where a network holds it).
        if (
          error.code === "guard_failed" &&
          ((guardOf(error) === "round_left" && (row.action === "other_time" || row.action === "change_time")) ||
            (PASSED_ON_GUARDS.has(guardOf(error)) && row.action === "change_time"))
        ) {
          return { page: await this.passOn(ctx, caller, String(input?.startTime ?? ""), reason) };
        }
        // Their yes to our change, which can no longer be made online: a person takes it, never refused.
        if (error.code === "guard_failed" && row.action === "accept_change" && ACCEPT_PASSED_ON.has(guardOf(error))) {
          return { page: await this.passOnAcceptance(ctx, caller) };
        }
        // A withdrawal that can no longer be made online: a return we answer, once the goods reached
        // them, else their statement for a person. Never refused.
        if (error.code === "guard_failed" && row.action === "withdraw" && guardOf(error) === "withdrawal_open") {
          if (item.type === "order" && ORDER_SENT.has(item.state) && !(await openReturnOf(this.db, item.id))) {
            await transitionItem(this.db, caller, {
              itemId: item.id,
              event: "request_return",
              input: { reasonCode: "changed_mind", ...(reason ? { note: reason } : {}) },
              extraStatements: [linkUsedStatement(row.jti, now)],
              hashInput: { link: row.jti, event: "request_return" },
            });
            return { redirect: `/c/${token}` };
          }
          return { page: await this.passOnWithdrawal(ctx, caller, reason) };
        }
        const fresh = await this.linkContext(token, opts.acceptLanguage ?? null);
        const again = "page" in fresh ? null : fresh;
        // The item moved (a flag, a note) but what the customer answered stands: answer it as it is now.
        if (error.code === "version_conflict" && again && attempt < 3 && !(await this.blocked(again, now))) {
          expected = again.item.version;
          continue;
        }
        return { page: await this.refusal(error, row, ctx, again, now, form) };
      }
    }
  }

  /**
   * The page the code email's link opens: the booking network explained, in the business's name and
   * the customer's language, with one button that stops it for them — or, once they have, since when.
   */
  private async networksPage(
    ctx: LinkContext,
    now: number,
    opts: { readonly error?: string; readonly status?: CustomerPage["status"] } = {},
  ): Promise<CustomerPage> {
    const { row, item, audience } = ctx;
    if (now > row.expiresAt) return this.plain(ctx, 410, copyFor(audience.lang).page.linkExpired);
    const { rows } = await this.db.client.query({
      sql: `SELECT MIN(p.networks_off_at) FROM parties p
             WHERE p.id = ? OR p.id = (SELECT merged_into FROM parties WHERE id = ?)`,
      params: [item.partyId, item.partyId],
      method: "all",
    });
    const since = rows[0]?.[0];
    const stopped =
      since === null || since === undefined
        ? null
        : dateText(new Date(Number(since)).toISOString(), audience.timezone, audience.lang);
    const page = privacyPage({
      lang: audience.lang,
      business: ctx.business,
      networks: await issuingNetworks(this.db, await readSettings(this.db)),
      mine: {
        stopped,
        form: {
          hidden: { terms: row.termsSha, stop: "1" },
          fields: [],
          button: DISCLOSURE[audience.lang].privacy.stopButton,
        },
      },
    });
    const words = copyFor(audience.lang).page;
    return {
      ...page,
      status: opts.status ?? 200,
      ...(opts.error ? { error: opts.error } : {}),
      footer: words.footer(vars({ business: ctx.business, ref: shortRef(item.id) })).replace(/^ · /, ""),
      help: words.help,
    };
  }

  /**
   * The customer switches the booking network off for themselves, from the code email's link: every
   * party that is them, their email and phone, from now on (`identity/stops.ts`). A POST that did not
   * come from the page (no `stop`) does nothing; stopping twice changes nothing.
   */
  private async stopFromLink(
    ctx: LinkContext,
    form: Readonly<Record<string, string | undefined>>,
    now: number,
  ): Promise<LinkActResult> {
    const { row, item, audience } = ctx;
    if (now > row.expiresAt) return { page: this.plain(ctx, 410, copyFor(audience.lang).page.linkExpired) };
    if (form.stop !== "1" || form.terms !== row.termsSha) {
      return {
        page: await this.networksPage(ctx, now, { error: copyFor(audience.lang).page.notSent, status: 422 }),
      };
    }
    await stopNetworks(
      this.db,
      {
        partyId: item.partyId,
        via: "customer",
        itemId: item.id,
        note: "The customer asked us, from the link in their code email, not to use booking networks for them. Nothing more about them goes to any network.",
      },
      now,
    );
    await this.db.client.query(linkUsedStatement(row.jti, now));
    return { redirect: `/c/${ctx.token}` };
  }

  /** Why a POST from the page did not act, as the page that says so. */
  private async refusal(
    error: WriteError,
    row: LinkRow,
    ctx: LinkContext,
    again: LinkContext | null,
    now: number,
    form: Readonly<Record<string, string | undefined>>,
  ): Promise<CustomerPage> {
    const { item, audience } = ctx;
    const c = copyFor(audience.lang);
    const words = c.page;
    switch (error.code) {
      case "slot_taken":
        if (row.action === "accept_time" && again) {
          return this.pageFor(again, now, { error: words.acceptTime.slotTaken, status: 409, picker: true });
        }
        if ((row.action === "other_time" || row.action === "change_time") && again) {
          return this.pageFor(again, now, { error: error.message, status: 409, from: form.from });
        }
        return this.plain(ctx, 409, c.problems.slotTaken);
      case "guard_failed":
        if ((error.details as { guard?: unknown } | undefined)?.guard === "not_too_soon" && again) {
          if (row.action === "accept_time") {
            return this.pageFor(again, now, { error: words.acceptTime.tooLate, status: 409, picker: true });
          }
          if (row.action === "other_time" || row.action === "change_time") {
            return this.pageFor(again, now, { error: c.problems.notTooSoon, status: 409, from: form.from });
          }
        }
        return this.plain(ctx, 409, words.noLonger(vars({ status: status(item, audience) })));
      case "offer_expired":
        if (row.action === "accept_time" && again) {
          return this.pageFor(again, now, { error: error.message, status: 410, picker: true });
        }
        return this.expiredPage(ctx);
      case "invalid_input":
        return this.pageFor(ctx, now, { error: error.message, status: 422, from: form.from });
      case "version_conflict":
      case "wrong_state":
      case "idempotency_mismatch": {
        const blockedNow = again ? await this.blocked(again, now) : null;
        if (blockedNow) return blockedNow;
        return this.plain(ctx, 409, words.alreadyDone(vars({ status: status(again ? again.item : item, audience) })));
      }
      default:
        return this.plain(ctx, 500, words.error);
    }
  }

  // ---- the page, as data -----------------------------------------------------

  private async linkContext(
    token: string,
    acceptLanguage: string | null,
  ): Promise<LinkContext | { page: CustomerPage }> {
    const facts = await businessFacts(this.db);
    const business = facts.name || facts.domain || "";
    const row = await verifyLink(this.db, this.deps.secrets, token);
    const [itemRow] = row ? await this.db.orm.select().from(items).where(eq(items.id, row.itemId)) : [];
    if (!row || !itemRow) {
      const lang = langFromHeader(acceptLanguage) ?? customerLang(null, facts.languages);
      const p = copyFor(lang).page;
      return {
        page: {
          status: 404,
          lang,
          business,
          heading: p.invalid,
          footer: business,
          help: p.help,
        },
      };
    }
    const item = rowToItem(itemRow);
    const audience = { ...(await this.audienceOf(item, undefined, facts)), lang: row.lang };
    return { row, item, audience, business, token };
  }

  /** Why this link cannot act now, as a page; null when it can. */
  private async blocked(ctx: LinkContext, now: number): Promise<CustomerPage | null> {
    const { row, item, audience } = ctx;
    const words = copyFor(audience.lang).page;
    if (now > row.expiresAt) return this.expiredPage(ctx);
    if (!stateAllows(row.action, item)) {
      return this.plain(ctx, 409, words.noLonger(vars({ status: status(item, audience) })));
    }
    if (row.action === "details") {
      return row.termsSha === (await detailsSha(this.db, item.id)) ? null : this.plain(ctx, 409, words.replaced);
    }
    // A withdrawal link is bound to the contract, whatever changes in it; whether the right still runs
    // is the page's to say (and never a refusal: past it, the customer's words go to a person).
    if (row.action === "withdraw")
      return row.termsSha === withdrawSha(item.id) ? null : this.plain(ctx, 409, words.replaced);
    // Asking for another time is bound to the booking as the email found it: once it changed, a newer
    // email has the link.
    if (row.action === "change_time") {
      return row.termsSha === (await standingSha(item)) ? null : this.plain(ctx, 409, words.replaced);
    }
    const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    if (!offer || offer.termsSha !== row.termsSha) return this.plain(ctx, 409, words.offerChanged);
    // The link lives a day past the answer-by date, so the page can say why it is too late: a quote
    // or changes that lapsed say so (a time we proposed says so beside the free times, in `pageFor`).
    if (offer.kind !== "time" && offer.deadline && now > Date.parse(offer.deadline)) return this.expiredPage(ctx);
    return null;
  }

  private expiredPage(ctx: LinkContext): CustomerPage {
    const { item, audience } = ctx;
    const words = copyFor(audience.lang).page;
    const pointer = (item.payload as { offer?: { by: string; status: string; validThrough?: string } }).offer;
    if (
      (ctx.row.action === "accept_change" || ctx.row.action === "keep_as_is") &&
      pointer?.by === "business" &&
      pointer.status === "open" &&
      pointer.validThrough
    ) {
      return this.plain(
        ctx,
        410,
        words.acceptChange.lapsed(
          vars({
            deadline: whenText(pointer.validThrough, audience.timezone, audience.lang),
            yourNoun: yourNoun(item.type, audience.lang),
          }),
        ),
      );
    }
    const until =
      item.type === "order" && item.payload.offer?.by === "business" ? item.payload.offer.validThrough : undefined;
    if (item.type === "order" && until) {
      return this.plain(
        ctx,
        410,
        words.acceptOrder.lapsed(vars({ deadline: whenText(until, audience.timezone, audience.lang) })),
      );
    }
    if (item.type === "quote_request" && item.payload.quote) {
      return this.plain(
        ctx,
        410,
        words.acceptQuote.expired(
          vars({ validThrough: whenText(item.payload.quote.validThrough, audience.timezone, audience.lang) }),
        ),
      );
    }
    return this.plain(ctx, 410, words.linkExpired);
  }

  private plain(ctx: LinkContext, code: CustomerPage["status"], heading: string, paragraphs?: string[]): CustomerPage {
    const words = copyFor(ctx.audience.lang).page;
    return {
      status: code,
      lang: ctx.audience.lang,
      business: ctx.business,
      heading,
      ...(paragraphs?.length ? { paragraphs } : {}),
      footer: words.footer(vars({ business: ctx.business, ref: shortRef(ctx.item.id) })).replace(/^ · /, ""),
      help: words.help,
    };
  }

  private async pageFor(
    ctx: LinkContext,
    now: number,
    opts: {
      readonly error?: string | undefined;
      readonly status?: CustomerPage["status"] | undefined;
      readonly from?: string | undefined;
      /** Offer the free times instead: the time we proposed has gone. */
      readonly picker?: boolean | undefined;
    } = {},
  ): Promise<CustomerPage> {
    const { row, item, audience } = ctx;
    const c = copyFor(audience.lang);
    const words = c.page;
    const what = whatOf(item, audience.lang);
    const tz = audience.timezone;
    const lang = audience.lang;
    if (row.usedAt !== null) return this.donePage(ctx);
    if (!opts.error) {
      const blocked = await this.blocked(ctx, now);
      if (blocked) return blocked;
    }
    // Past the answer-by date a time can no longer be accepted online: the page says so, and offers
    // the free times instead.
    if (row.action === "accept_time" && !opts.error && !opts.picker) {
      const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
      if (offer?.deadline && now > Date.parse(offer.deadline)) {
        // Past its validity, it says until when it could be taken; past the notice, that it is too close.
        const lapsed = offer ? lapsedAt(item, offer, audience.minNoticeMin) : null;
        const error =
          lapsed && now > Date.parse(lapsed)
            ? words.acceptTime.lapsed(vars({ deadline: whenText(lapsed, audience.timezone, audience.lang) }))
            : words.acceptTime.tooLate;
        return this.pageFor(ctx, now, { error, status: 410, picker: true });
      }
    }
    const base = this.plain(ctx, opts.status ?? 200, "");
    const hidden = { terms: row.termsSha, v: String(item.version) };
    const siblings = this.deps.secrets
      ? await siblingsOf(this.db, this.deps.secrets, row)
      : new Map<LinkAction, string>();
    const link = (action: LinkAction, label: string): PageLink[] => {
      const t = siblings.get(action);
      return t ? [{ label, href: `/c/${t}` }] : [];
    };
    const error = opts.error ? { error: opts.error } : {};

    if (row.action === "accept_time" || row.action === "decline_time" || row.action === "other_time") {
      const b = item as Extract<Item, { type: "booking" }>;
      const proposed = b.payload.proposed;
      const price = proposed?.totalPrice ?? b.payload.totalPrice;
      if (row.action === "other_time" || opts.picker) {
        const target = row.action === "other_time" ? null : siblings.get("other_time");
        if (opts.picker && !target) return { ...base, heading: opts.error ?? words.acceptTime.slotTaken };
        // The picker posts to the email's "Pick another time" link, whichever page shows it.
        const path = `/c/${target ?? ctx.token}`;
        const times = await this.freeTimes(b, now, audience, opts.from, path);
        const form =
          times.field.kind === "times" && times.field.days.length === 0
            ? undefined
            : {
                ...(target ? { action: path } : {}),
                hidden: target
                  ? await this.hiddenFor(target, item)
                  : { ...hidden, ...(opts.from ? { from: opts.from } : {}) },
                fields: [times.field, textarea("note", words.otherTime.note, false, 2_000)],
                button: words.otherTime.button,
              };
        return {
          ...base,
          heading: words.otherTime.heading,
          ...error,
          paragraphs: [
            words.otherTime.lead(vars({ what, zone: zoneName(tz, lang) })),
            ...(form ? [] : [words.otherTime.noneFree]),
          ],
          ...(form ? { form } : {}),
          nav: times.nav,
          ...(row.action === "other_time"
            ? { links: { items: [...link("accept_time", c.labels.accept), ...link("decline_time", c.labels.decline)] } }
            : {}),
        };
      }
      const deadline = timeDeadline(b, audience.minNoticeMin);
      const rows = [
        ...(proposed ? [{ label: words.rows.when, value: whenText(proposed.startTime, tz, lang) }] : []),
        ...(price ? [{ label: words.rows.price, value: moneyIn(price, lang) }] : []),
        ...(deadline ? [{ label: words.rows.answerBy, value: whenText(deadline, tz, lang) }] : []),
      ];
      const note = await noteOf(this.db, item.id, "propose");
      if (row.action === "accept_time") {
        return {
          ...base,
          heading: words.acceptTime.heading,
          ...error,
          paragraphs: [
            words.acceptTime.lead(vars({ what })),
            b.payload.offer?.held ? words.acceptTime.held : words.acceptTime.unheld,
            ...(b.payload.offer?.binding === false ? [c.withdrawable] : []),
          ],
          rows,
          ...(note ? { quote: note } : {}),
          form: {
            hidden,
            fields: [],
            button: (price?.value ?? 0) > 0 ? words.acceptTime.buttonPriced : words.acceptTime.buttonFree,
          },
          links: {
            lead: words.acceptTime.notThisTime,
            items: [...link("other_time", c.labels.otherTime), ...link("decline_time", c.labels.decline)],
          },
        };
      }
      return {
        ...base,
        heading: words.declineTime.heading,
        ...error,
        paragraphs: [words.declineTime.body(vars({ what }))],
        rows,
        form: {
          hidden,
          fields: [textarea("reason", words.declineTime.reason, false, 2_000)],
          button: words.declineTime.button,
        },
        links: { items: [...link("other_time", c.labels.otherTime), ...link("accept_time", c.labels.accept)] },
      };
    }

    if (row.action === "accept_quote" || row.action === "decline_quote") {
      const q = (item as Extract<Item, { type: "quote_request" }>).payload.quote;
      if (!q) return this.plain(ctx, 409, words.offerChanged);
      const rows = [
        ...q.lines.map((l) => ({
          label: `${l.quantity} × ${l.name}`,
          value: moneyIn({ value: l.price.value * l.quantity, currency: l.price.currency }, lang),
        })),
        { label: words.rows.total, value: moneyIn(q.totalPrice, lang) },
        ...(q.creates === "booking" && q.startTime
          ? [{ label: words.rows.when, value: whenText(q.startTime, tz, lang) }]
          : []),
        { label: words.rows.validUntil, value: whenText(q.validThrough, tz, lang) },
      ];
      if (row.action === "accept_quote") {
        return {
          ...base,
          heading: words.acceptQuote.heading,
          ...error,
          paragraphs: [words.acceptQuote.lead(vars({ what }))],
          rows,
          ...(q.notes ? { quote: q.notes } : {}),
          form: {
            hidden,
            fields: [],
            button: q.totalPrice.value > 0 ? words.acceptQuote.buttonPriced : words.acceptQuote.buttonFree,
          },
          links: { items: link("decline_quote", c.labels.decline) },
        };
      }
      return {
        ...base,
        heading: words.declineQuote.heading,
        ...error,
        paragraphs: [words.declineQuote.body(vars({ what }))],
        rows,
        form: {
          hidden,
          fields: [textarea("reason", words.declineTime.reason, false, 2_000)],
          button: words.declineQuote.button,
        },
        links: { items: link("accept_quote", c.labels.accept) },
      };
    }

    if (row.action === "accept_order" || row.action === "decline_order") {
      const o = item as Extract<Item, { type: "order" }>;
      const p = o.payload.proposed;
      if (!p) return this.plain(ctx, 409, words.offerChanged);
      const until = o.payload.offer?.by === "business" ? o.payload.offer.validThrough : undefined;
      const rows = [
        ...p.orderedItem.map((l) => ({
          label: `${l.quantity} × ${l.name}`,
          value: moneyIn({ value: l.price.value * l.quantity, currency: l.price.currency }, lang),
        })),
        { label: words.rows.total, value: moneyIn(p.totalPrice, lang) },
        ...(p.delivery?.when ? [{ label: words.rows.delivery, value: whenText(p.delivery.when, tz, lang) }] : []),
        ...(until ? [{ label: words.rows.answerBy, value: whenText(until, tz, lang) }] : []),
      ];
      const note = await noteOf(this.db, item.id, "propose");
      if (row.action === "accept_order") {
        return {
          ...base,
          heading: words.acceptOrder.heading,
          ...error,
          paragraphs: [
            words.acceptOrder.lead(vars({ what })),
            ...(o.payload.offer?.binding === false ? [c.withdrawable] : []),
          ],
          rows,
          ...(note ? { quote: note } : {}),
          form: {
            hidden,
            fields: [],
            button: p.totalPrice.value > 0 ? words.acceptOrder.buttonPriced : words.acceptOrder.buttonFree,
          },
          links: { items: link("decline_order", c.labels.decline) },
        };
      }
      return {
        ...base,
        heading: words.declineOrder.heading,
        ...error,
        paragraphs: [words.declineOrder.body(vars({ what }))],
        rows,
        form: {
          hidden,
          fields: [textarea("reason", words.declineTime.reason, false, 2_000)],
          button: words.declineOrder.button,
        },
        links: { items: link("accept_order", c.labels.accept) },
      };
    }

    if (row.action === "change_time" && item.type === "booking") {
      // The free times the booking could move to (its own places aside), then their request.
      const at = whenText(item.payload.startTime, tz, lang);
      const times = await this.freeTimes(item, now, audience, opts.from, `/c/${ctx.token}`, {
        exceptItemId: item.id,
        skip: item.payload.startTime,
      });
      const form =
        times.field.kind === "times" && times.field.days.length === 0
          ? undefined
          : {
              hidden: { ...hidden, ...(opts.from ? { from: opts.from } : {}) },
              fields: [times.field, textarea("note", words.otherTime.note, false, 2_000)],
              button: words.changeTime.button,
            };
      return {
        ...base,
        heading: words.changeTime.heading,
        ...error,
        paragraphs: [
          words.changeTime.lead(vars({ what, when: at, zone: zoneName(tz, lang) })),
          ...(form ? [] : [words.otherTime.noneFree]),
        ],
        ...(form ? { form } : {}),
        nav: times.nav,
      };
    }

    if (row.action === "accept_change" || row.action === "keep_as_is") {
      // What was agreed, beside what we would change it to.
      const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
      if (offer?.kind !== "change") return this.plain(ctx, 409, words.offerChanged);
      const terms = offer.terms;
      const noun = yourNoun(item.type, lang);
      const note = await noteOf(this.db, item.id, "propose_change");
      const rows =
        item.type === "booking"
          ? [
              { label: words.rows.now, value: whenText(item.payload.startTime, tz, lang) },
              ...(terms.startTime ? [{ label: words.rows.instead, value: whenText(terms.startTime, tz, lang) }] : []),
              ...(terms.totalPrice ? [{ label: words.rows.price, value: moneyIn(terms.totalPrice, lang) }] : []),
            ]
          : [
              ...(terms.lines ?? []).map((l) => ({
                label: `${l.quantity} × ${l.name}`,
                value: moneyIn({ value: l.price.value * l.quantity, currency: l.price.currency }, lang),
              })),
              ...(terms.totalPrice ? [{ label: words.rows.total, value: moneyIn(terms.totalPrice, lang) }] : []),
              ...(terms.delivery?.when
                ? [{ label: words.rows.delivery, value: whenText(terms.delivery.when, tz, lang) }]
                : []),
            ];
      const until = offer.deadline ? [{ label: words.rows.answerBy, value: whenText(offer.deadline, tz, lang) }] : [];
      if (row.action === "accept_change") {
        return {
          ...base,
          heading: words.acceptChange.heading,
          ...error,
          paragraphs: [
            words.acceptChange.lead(vars({ what, yourNoun: noun })),
            ...(item.type === "booking" && item.payload.offer?.held ? [words.acceptTime.held] : []),
            ...(offer.withdrawable ? [c.withdrawable] : []),
          ],
          rows: [...rows, ...until],
          ...(note ? { quote: note } : {}),
          form: {
            hidden,
            fields: [],
            // A change that asks more of them binds them to pay it; one that does not only confirms.
            button: offer.obligationToPay ? words.acceptChange.buttonPriced : words.acceptChange.buttonFree,
          },
          links: { items: link("keep_as_is", c.labels.keepAsIs) },
        };
      }
      return {
        ...base,
        heading: words.keepAsIs.heading,
        ...error,
        paragraphs: [
          words.keepAsIs.body(
            vars({
              what,
              yourNoun: noun,
              when: item.type === "booking" ? whenText(item.payload.startTime, tz, lang) : "",
            }),
          ),
        ],
        rows: [...rows, ...until],
        form: {
          hidden,
          fields: [textarea("reason", words.declineTime.reason, false, 2_000)],
          button: words.keepAsIs.button,
        },
        links: { items: link("accept_change", c.labels.acceptChange) },
      };
    }

    if (row.action === "withdraw") {
      const settings = await readSettings(this.db);
      const w = withdrawalCopy(lang, lawOf(settings.commerce.legal.country));
      const right = await withdrawalOf(this.db, item, settings, now);
      const statement = await this.statementOf(item, audience, w, right, undefined);
      const rowsOf = [
        ...(statement.name ? [{ label: w.page.name, value: statement.name }] : []),
        { label: w.page.contract, value: statement.contract },
        ...(statement.email ? [{ label: w.page.email, value: statement.email }] : []),
      ];
      // Past the period, or excepted: what they write still reaches us, and a person answers.
      return {
        ...base,
        heading: w.page.heading,
        ...error,
        paragraphs: right.available
          ? [
              w.page.lead,
              ...(statement.until ? [w.until(vars({ deadline: whenText(statement.until, tz, lang) }))] : []),
            ]
          : [statement.why ?? w.noRight(vars({ yourNoun: yourNoun(item.type, lang) })), w.page.stillSend],
        rows: rowsOf,
        quote: statement.text,
        form: {
          hidden,
          fields: [textarea("reason", w.page.note, false, 2_000)],
          button: w.confirm,
        },
      };
    }

    // details
    const question = audience.question ?? (await noteOf(this.db, item.id, "request_info"));
    return {
      ...base,
      heading: words.details.heading,
      ...error,
      paragraphs: [words.details.lead(vars({ what, yourNoun: yourNoun(item.type, lang) }))],
      ...(question ? { quote: question } : {}),
      form: { hidden, fields: [textarea("details", words.details.label, true, 5_000)], button: words.details.button },
    };
  }

  /** What a used link shows: what was done, while it still stands; else how the item stands now. */
  private async donePage(ctx: LinkContext): Promise<CustomerPage> {
    const { row, item, audience } = ctx;
    const words = copyFor(audience.lang).page;
    const what = whatOf(item, audience.lang);
    const tz = audience.timezone;
    const lang = audience.lang;
    let text: string | null = null;
    if (row.action === "accept_time" && item.type === "booking" && item.state === "confirmed") {
      text = words.acceptTime.done(vars({ what, when: whenText(item.payload.startTime, tz, lang) }));
    } else if (row.action === "decline_time" && item.state === "cancelled_by_customer") {
      text = words.declineTime.done;
    } else if (row.action === "other_time" && item.type === "booking" && item.state === "requested") {
      text = words.otherTime.done(vars({ when: whenText(item.payload.startTime, tz, lang) }));
    } else if (row.action === "accept_quote" && item.state === "accepted" && item.linkedItemId) {
      const [linkedRow] = await this.db.orm.select().from(items).where(eq(items.id, item.linkedItemId));
      const linked = linkedRow ? rowToItem(linkedRow) : null;
      if (linked?.type === "booking") {
        text = words.acceptQuote.doneBooking(
          vars({
            what: whatOf(linked, lang),
            when: whenText(linked.payload.startTime, tz, lang),
            total: linked.payload.totalPrice ? moneyIn(linked.payload.totalPrice, lang) : "",
          }),
        );
      } else if (linked?.type === "order") {
        text = words.acceptQuote.doneOrder(
          vars({ what: whatOf(linked, lang), total: moneyIn(linked.payload.totalPrice, lang) }),
        );
      }
    } else if (row.action === "decline_quote" && item.state === "declined") {
      text = words.declineQuote.done(vars({ what }));
    } else if (row.action === "accept_order" && item.type === "order" && item.state === "accepted") {
      text = words.acceptOrder.done(vars({ what, total: moneyIn(item.payload.totalPrice, lang) }));
    } else if (row.action === "decline_order" && item.state === "cancelled") {
      text = words.declineOrder.done;
    } else if (row.action === "accept_change" && isChangeable(item)) {
      text =
        item.type === "booking"
          ? words.acceptChange.doneTime(
              vars({ what, yourNoun: yourNoun(item.type, lang), when: whenText(item.payload.startTime, tz, lang) }),
            )
          : item.type === "order"
            ? words.acceptChange.doneOrder(vars({ what, total: moneyIn(item.payload.totalPrice, lang) }))
            : null;
    } else if (row.action === "keep_as_is" && isChangeable(item)) {
      text = words.keepAsIs.done(vars({ what, yourNoun: yourNoun(item.type, lang) }));
    } else if (row.action === "change_time" && item.type === "booking" && item.payload.change?.by === "customer") {
      text = words.changeTime.done(
        vars({
          what,
          when: whenText(item.payload.startTime, tz, lang),
          newWhen: whenText(item.payload.change.startTime, tz, lang),
        }),
      );
    } else if (row.action === "details" && item.state !== "needs_info") {
      text = words.details.done;
    } else if (row.action === "withdraw" && row.usedAt !== null) {
      const settings = await readSettings(this.db);
      const w = withdrawalCopy(lang, lawOf(settings.commerce.legal.country));
      text = w.page.done(vars({ when: whenText(new Date(row.usedAt).toISOString(), tz, lang) }));
    }
    return this.plain(ctx, 200, text ?? words.alreadyDone(vars({ status: status(item, audience) })));
  }

  /** The free times for a week from `from` (or now), grouped by day, at most forty. */
  private async freeTimes(
    item: Extract<Item, { type: "booking" }>,
    now: number,
    audience: Audience,
    from: string | undefined,
    path: string,
    /** For a booking that moves: its own places are free to it, and its own time is not offered. */
    moving: { readonly exceptItemId: string; readonly skip: string } | undefined = undefined,
  ): Promise<{ field: PageField; nav: PageLink[] }> {
    const words = copyFor(audience.lang).page.otherTime;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? Date.parse(`${from}T00:00:00Z`) : Number.NaN;
    const today = Date.parse(`${localDate(now, audience.timezone)}T00:00:00Z`);
    const startDay = Number.isFinite(day) && day > today ? day : today;
    const windowStart = Math.max(startDay, now + audience.minNoticeMin * 60_000 + 60_000);
    const windowEnd = startDay + 7 * 86_400_000 + 12 * 3_600_000;
    let slots: { startTime: string }[] = [];
    try {
      const r = await findSlots(this.db, {
        serviceId: item.payload.reservationFor.serviceId,
        from: new Date(windowStart).toISOString(),
        to: new Date(Math.max(windowEnd, windowStart + 3_600_000)).toISOString(),
        timezone: audience.timezone,
        limit: 200,
        now,
        minNoticeMin: audience.minNoticeMin,
        ...(moving ? { exceptItemId: moving.exceptItemId } : {}),
      });
      const own = moving ? Date.parse(moving.skip) : Number.NaN;
      slots = r.slots.filter((s) => Date.parse(s.startTime) > now && Date.parse(s.startTime) !== own).slice(0, 40);
    } catch {
      slots = [];
    }
    const days: { day: string; times: { value: string; label: string }[] }[] = [];
    for (const s of slots) {
      const label = dayText(s.startTime, audience.timezone, audience.lang);
      let group = days.find((d) => d.day === label);
      if (!group) {
        group = { day: label, times: [] };
        days.push(group);
      }
      group.times.push({ value: s.startTime, label: timeText(s.startTime, audience.timezone, audience.lang) });
    }
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const nav: PageLink[] = [
      ...(startDay > today ? [{ label: words.earlier, href: `${path}?from=${iso(startDay - 7 * 86_400_000)}` }] : []),
      { label: words.later, href: `${path}?from=${iso(startDay + 7 * 86_400_000)}` },
    ];
    return {
      field: { kind: "times", name: "start", label: words.heading, days, empty: words.noneFree },
      nav,
    };
  }

  /** The hidden fields of another link's form: its terms and the item's version. */
  private async hiddenFor(token: string, item: Item): Promise<Record<string, string>> {
    const row = await verifyLink(this.db, this.deps.secrets, token);
    return { terms: row?.termsSha ?? "", v: String(item.version) };
  }

  /** A time chosen on the page, past the last round: kept as the customer's message for a person. */
  private async passOn(ctx: LinkContext, caller: Caller, start: string, note: string): Promise<CustomerPage> {
    const { item, audience } = ctx;
    const promise = isChangeable(item);
    const offer = promise ? standingOffer(item) : await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    const said = offer ? suggestionText({ start_time: start }, note, offer, audience) : note;
    if (said) {
      await once(this.db, caller, "public.link_suggestion", { link: ctx.row.jti, start, note }, async () => {
        await appendThreadEntry(this.db, caller, item, said, "in");
        return true;
      });
    }
    if (promise) return this.plain(ctx, 200, changePassedOn(item, audience));
    const stands = offer?.deadline && Date.parse(offer.deadline) > nowOf(caller) ? offer.deadline : null;
    const deadline = stands ? whenText(stands, audience.timezone, audience.lang) : "";
    return this.plain(ctx, 200, copyFor(audience.lang).page.passedOn(vars({ deadline })));
  }

  /** Their yes to our change from the page, which a person takes: kept as their message, once. */
  private async passOnAcceptance(ctx: LinkContext, caller: Caller): Promise<CustomerPage> {
    const { item, audience } = ctx;
    const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    if (offer?.kind === "change") {
      await once(this.db, caller, "public.link_acceptance", { link: ctx.row.jti }, async () => {
        await appendThreadEntry(this.db, caller, item, acceptanceText(offer, audience), "in");
        return true;
      });
    }
    return this.plain(ctx, 200, changePassedOn(item, audience));
  }

  /**
   * A withdrawal sent from the page that can no longer be made online (the period ended, or what was
   * bought is excepted): their statement and words, kept for a person to answer, once.
   */
  private async passOnWithdrawal(ctx: LinkContext, caller: Caller, note: string): Promise<CustomerPage> {
    const { item, audience } = ctx;
    const settings = await readSettings(this.db);
    const w = withdrawalCopy(audience.lang, lawOf(settings.commerce.legal.country));
    const right = await withdrawalOf(this.db, item, settings, nowOf(caller));
    const statement = await this.statementOf(item, audience, w, right, undefined);
    const text = [statement.text, note].filter(Boolean).join("\n\n");
    await once(this.db, caller, "public.link_withdrawal", { link: ctx.row.jti }, async () => {
      await appendThreadEntry(this.db, caller, item, text, "in");
      return true;
    });
    await this.db.client.query(linkUsedStatement(ctx.row.jti, nowOf(caller)));
    return this.plain(ctx, 200, w.passedOn(vars({ status: statement.why ?? "" })));
  }

  /** An answer that names an offer the business has since replaced does nothing: `offer_changed`, with the current one. */
  private async assertOfferPinned(
    c: Caller,
    item: Item,
    offerId: string | undefined,
    known?: OpenOffer,
  ): Promise<void> {
    if (!offerId) return;
    const audience = await this.audienceOf(item, c);
    const offer = known ?? (await openOffer(item, { minNoticeMin: audience.minNoticeMin }));
    if (offer && offerId === (offer.id ?? legacyOfferId(item.id))) return;
    const summary = offer ? offerSummary(item, offer, audience) : "";
    throw new WriteError("offer_changed", copyFor(audience.lang).problems.offerChanged(vars({ summary })), {
      details: { offer: offer ? offerJson(offer, summary) : null },
    });
  }

  /**
   * An answer that names an offer on a promise: the change open on it, or, with none open, what was
   * agreed. One the item has moved on from since does nothing (`offer_changed`, with what is open now).
   */
  private async assertChangePinned(c: Caller, item: Item, offerId: string | undefined): Promise<void> {
    if (!offerId) return;
    const pointer = (item.payload as { offer?: { id: string } }).offer;
    if (pointer?.id === offerId) return;
    await this.assertOfferPinned(c, item, offerId);
  }

  /** Taking back their own change, named: only that change, while it is open. */
  private async assertOwnChangePinned(c: Caller, item: Item, offerId: string | undefined): Promise<void> {
    if (!offerId) return;
    const pointer = (item.payload as { offer?: { id: string; status: string } }).offer;
    if (pointer?.id === offerId && pointer.status === "open") return;
    const audience = await this.audienceOf(item, c);
    throw new WriteError("offer_changed", copyFor(audience.lang).problems.noChange, { details: { offer: null } });
  }

  // ---- helpers ---------------------------------------------------------------

  private async customerCaller(
    caller: Caller,
    input: {
      readonly item_id: string;
      readonly access_token?: string | undefined;
      readonly idempotency_key?: string | undefined;
      readonly pass?: string | undefined;
      readonly key?: string | undefined;
    },
  ): Promise<Caller> {
    const { caller: recognised } = await this.deps.people.recognise(caller, input);
    const keyed = withIdempotencyKey(recognised, input.idempotency_key);
    return input.access_token ? { ...keyed, accessToken: input.access_token } : keyed;
  }

  /** A retry of a request already answered gets the same answer, whatever the item has done since. */
  private async replayIfSeen(
    c: Caller,
    itemId: string,
    event: string,
    hashInput: unknown,
  ): Promise<CustomerResult | null> {
    if (!c.idempotency || !(await findIdempotent(this.db, c.idempotency))) return null;
    const r = await transitionItem(this.db, c, { itemId, event, hashInput });
    return this.result(r, c);
  }

  private async result(r: TransitionResult, caller: Caller): Promise<CustomerResult> {
    const facts = await businessFacts(this.db);
    const view = await this.present(r.view.item, await this.audienceOf(r.view.item, caller, facts), nowOf(caller));
    const linked = r.linked
      ? await this.present(r.linked.item, await this.audienceOf(r.linked.item, caller, facts), nowOf(caller))
      : undefined;
    return { view, ...(linked ? { linked } : {}), replayed: r.replayed };
  }

  private async loadOwned(caller: Caller, itemId: string): Promise<ItemRow> {
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
}

interface LinkContext {
  readonly row: LinkRow;
  readonly item: Item;
  readonly audience: Audience;
  readonly business: string;
  readonly token: string;
}

function offerJson(
  offer: OpenOffer,
  human: string,
  changes: readonly string[] | null = null,
  now: number | null = null,
): CustomerOffer {
  const changed = changes ?? [];
  return {
    id: offer.id,
    kind: offer.kind,
    terms: offer.terms,
    terms_sha: offer.termsSha,
    deadline: offer.deadline,
    obligation_to_pay: offer.obligationToPay,
    human,
    changes: changed,
    warnings: moneyChanged(changed)
      ? [{ type: "warning", code: "price_changed", severity: "requires_buyer_review" }]
      : [],
    disclosures: [
      // A time: ours, or a change of a booking to another time.
      ...(offer.kind === "time" || (offer.kind === "change" && offer.terms.startTime)
        ? [offer.held ? "held" : "unheld"]
        : []),
      ...(offer.withdrawable ? ["withdrawable"] : []),
      // Its price was chosen for them, and `human` says so beside the list price (ADR-018 §5).
      ...(offer.personalised ? ["personalised_price"] : []),
    ],
    expired: now !== null && offer.deadline !== null && now > Date.parse(offer.deadline),
  };
}

/**
 * Until when what we proposed could be accepted, as far as its own validity goes: a quote's, the
 * changes to an order's, a time's (not the notice before it starts, which the write says itself).
 */
function lapsedAt(item: Item, offer: OpenOffer, minNoticeMin: number): string | null {
  if (offer.kind === "quote") return offer.deadline;
  const p = (item.payload as { offer?: { by: string; status: string; validThrough?: string } }).offer;
  const valid = p?.by === "business" && p.status === "open" ? p.validThrough : undefined;
  if (!valid || offer.kind !== "time") return valid ?? null;
  // A time's start less the notice is the write's to say (too close, or started), in its own words.
  const bound = Date.parse(String(offer.terms.startTime)) - minNoticeMin * 60_000;
  return Date.parse(valid) < bound ? valid : null;
}

/**
 * A suggestion for a person to read, in the customer's words and language: what they would change,
 * then what they wrote. Empty when it changes nothing and says nothing.
 */
function suggestionText(t: T.MakeOfferInput["terms"], note: string | undefined, offer: OpenOffer, a: Audience): string {
  const pt = a.lang === "pt";
  const money = (m: Money) => moneyIn(m, a.lang);
  const parts: string[] = [];
  if (t.start_time) parts.push(whenText(t.start_time, a.timezone, a.lang));
  if (t.party_size !== undefined) parts.push(pt ? `${t.party_size} pessoas` : `${t.party_size} people`);
  if (t.quantity !== undefined) parts.push(pt ? `quantidade ${t.quantity}` : `quantity ${t.quantity}`);
  for (const l of t.lines ?? []) {
    const name = offer.terms.lines?.[l.index]?.name ?? `#${l.index + 1}`;
    parts.push(`${l.quantity} × ${name}${l.unit_price ? ` (${money(l.unit_price)})` : ""}`);
  }
  if (t.delivery_when) parts.push(`${pt ? "entrega" : "delivery"} ${whenText(t.delivery_when, a.timezone, a.lang)}`);
  if (t.total_price) parts.push(`${pt ? "total" : "total"} ${money(t.total_price)}`);
  const said = note?.trim();
  // Words alone ("could you do it for less?") are theirs to send too: a person reads them.
  if (parts.length === 0) return said ?? "";
  return `${pt ? "Gostaria de" : "I would like"}: ${parts.join("; ")}.${said ? `\n\n${said}` : ""}`;
}

function stateAllows(action: LinkAction, item: Item): boolean {
  switch (action) {
    case "accept_time":
    case "decline_time":
    case "other_time":
      return item.type === "booking" && item.state === "proposed";
    case "accept_quote":
    case "decline_quote":
      return item.type === "quote_request" && item.state === "quoted";
    case "accept_order":
    case "decline_order":
      return item.type === "order" && item.state === "proposed";
    case "accept_change":
    case "keep_as_is":
      return isChangeable(item) && openChange(item)?.by === "business";
    case "change_time":
      return item.type === "booking" && isChangeable(item);
    case "details":
      return item.state === "needs_info";
    case "networks_off":
      return true;
    case "withdraw":
      return (
        (item.type === "booking" && item.state === "confirmed") ||
        (item.type === "order" &&
          ["accepted", "awaiting_payment", "payment_failed", "paid", "fulfilling", "fulfilled", "completed"].includes(
            item.state,
          ))
      );
  }
}

/** Guards past which a customer's change goes to a person as their message: never refused. */
const PASSED_ON_GUARDS: ReadonlySet<string> = new Set(["round_left", "changes_left", "amendments_live", "total_fixed"]);

/**
 * Guards past which the customer's yes to our change goes to a person as their message: the change
 * can no longer be made online (payment asked for since, and it moves the total; a network now
 * holds the promise), which is ours to sort out, not theirs to be refused.
 */
const ACCEPT_PASSED_ON: ReadonlySet<string> = new Set(["amendments_live", "total_fixed"]);

/** Their yes to our change, as their message for a person: in their language, the terms they said yes to. */
function acceptanceText(offer: OpenOffer, a: Audience): string {
  const pt = a.lang === "pt";
  const t = offer.terms;
  const parts: string[] = [];
  if (t.startTime) parts.push(whenText(t.startTime, a.timezone, a.lang));
  for (const l of t.lines ?? []) parts.push(`${l.quantity} × ${l.name}`);
  if (t.delivery?.when) parts.push(`${pt ? "entrega" : "delivery"} ${whenText(t.delivery.when, a.timezone, a.lang)}`);
  if (t.totalPrice) parts.push(`total ${moneyIn(t.totalPrice, a.lang)}`);
  return `${pt ? "Aceito a alteração que sugeriram" : "I accept the change you suggested"}: ${parts.join("; ")}.`;
}

function guardOf(error: WriteError): string {
  const guard = (error.details as { guard?: unknown } | undefined)?.guard;
  return typeof guard === "string" ? guard : "";
}

/** The promise as it stands, as what a suggestion for a person is read against (its lines, by index). */
function standingOffer(item: Item): OpenOffer {
  return {
    kind: "change",
    terms: promiseTerms(item) ?? {},
    termsSha: "",
    deadline: null,
    obligationToPay: false,
    id: null,
    held: false,
    withdrawable: false,
  };
}

/** That their change went to a person, and the promise stands as agreed, in the business's words. */
function changePassedOn(item: Item, a: Audience): string {
  const c = copyFor(a.lang);
  return c.problems.changePassedOn(
    vars({
      yourNoun: c.yourNoun[item.type],
      when: item.type === "booking" ? whenText(item.payload.startTime, a.timezone, a.lang) : "",
    }),
  );
}

function status(item: Item, audience: Audience): string {
  return viewFor(item, "customer_human", undefined, undefined, audience).human;
}

function textarea(name: string, label: string, required: boolean, maxLength: number): PageField {
  return { kind: "textarea", name, label, required, maxLength };
}

function isCustomerKind(kind: string): boolean {
  return kind === "customer_agent" || kind === "customer_human";
}

/** The business's own words written with the latest `event` (the note with a proposal, the question it asked). */
export async function noteOf(db: Db, itemId: string, event: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: `SELECT t.body_text FROM thread_entries t
           WHERE t.item_id = ? AND t.direction = 'out'
             AND t.created_at = (SELECT MAX(e.created_at) FROM item_events e WHERE e.item_id = ? AND e.event = ?)
           ORDER BY t.id DESC LIMIT 1`,
    params: [itemId, itemId, event],
    method: "all",
  });
  const text = rows[0]?.[0];
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

async function lastEvent(db: Db, itemId: string): Promise<{ event: string; actorKind: string } | null> {
  const { rows } = await db.client.query({
    sql: "SELECT event, actor_kind FROM item_events WHERE item_id = ? ORDER BY seq DESC LIMIT 1",
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  return r ? { event: String(r[0]), actorKind: String(r[1]) } : null;
}
