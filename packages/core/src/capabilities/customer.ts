import { eq } from "drizzle-orm";
import type { AccessCapabilities } from "../access/keys";
import { audienceFor, type BusinessFacts, businessFacts } from "../customer/audience";
import { confirmTermsMessage, copyFor, vars } from "../customer/copy";
import { type Audience, nextActions, offerSummary, waitingOn, whatOf, yourNoun } from "../customer/describe";
import { DISCLOSURE, privacyPage } from "../customer/disclosure";
import { dateText, dayText, localDate, moneyIn, shortRef, timeText, whenText, zoneName } from "../customer/format";
import { customerLang, langFromHeader } from "../customer/lang";
import {
  detailsSha,
  type LinkAction,
  type LinkRow,
  linkUsedStatement,
  siblingsOf,
  verifyLink,
} from "../customer/links";
import { type OfferTerms, type OpenOffer, openOffer } from "../customer/offer";
import type { CustomerPage, LinkActResult, PageField, PageLink } from "../customer/page";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { stopNetworks } from "../identity/stops";
import type { ReceiptCapabilities } from "../receipts/capabilities";
import { items } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { hashText } from "../util/canonical";
import { type Caller, isCustomer, nowOf, withIdempotencyKey } from "../write/caller";
import { findIdempotent } from "../write/common";
import { WriteError } from "../write/errors";
import { once } from "../write/idempotency";
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
  readonly kind: OpenOffer["kind"];
  readonly terms: OfferTerms;
  /** Send it back with the acceptance: the customer said yes to exactly these terms. */
  readonly terms_sha: string;
  readonly deadline: string | null;
  readonly obligation_to_pay: boolean;
  /** What to tell the customer, in the business's words. */
  readonly human: string;
}

/** The item as its customer sees it, and what it waits for. */
export interface CustomerItemView extends ItemView {
  /** The six characters the customer quotes back. */
  readonly reference: string;
  readonly offer: CustomerOffer | null;
  /** `you`: the business waits for the customer; `us`: the customer waits for the business; null once closed. */
  readonly waiting_on: "you" | "us" | null;
  readonly next: readonly { readonly action: string; readonly label: string }[];
}

export interface CustomerResult {
  readonly view: CustomerItemView;
  /** What an accepted quote became: the booking confirmed, or the order accepted. */
  readonly linked?: CustomerItemView | undefined;
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
  async present(item: Item, audience: Audience): Promise<CustomerItemView> {
    // A message put aside as spam reads as closed, all of it: its words, its buttons, what comes next.
    const seen = item.state === "spam" ? ({ ...item, state: "closed" } as Item) : item;
    const view = viewFor(seen, "customer_agent", undefined, undefined, audience);
    const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    return {
      ...view,
      item: customerItem(item),
      reference: shortRef(item.id),
      offer: offer
        ? {
            kind: offer.kind,
            terms: offer.terms,
            terms_sha: offer.termsSha,
            deadline: offer.deadline,
            obligation_to_pay: offer.obligationToPay,
            human: offerSummary(item, offer, audience),
          }
        : null,
      waiting_on: waitingOn(item),
      next: nextActions(
        seen,
        view.transitions.map((t) => t.event),
        audience.lang,
      ),
    };
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
  async acceptOffer(caller: Caller, input: T.AcceptOfferInput): Promise<CustomerResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:accept_offer");
    const c = await this.customerCaller(caller, input);
    const hashInput = { door: "accept_offer", item_id: input.item_id, terms_sha: input.terms_sha ?? null };
    const replayed = await this.replayIfSeen(c, input.item_id, "accept", hashInput);
    if (replayed) return replayed;
    for (let attempt = 1; ; attempt++) {
      const row = await this.loadOwned(c, input.item_id);
      const item = rowToItem(row);
      const audience = await this.audienceOf(item, c);
      const words = copyFor(audience.lang);
      const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
      if (!offer) throw new WriteError("no_offer", words.problems.noOffer, { details: { state: item.state } });
      const summary = offerSummary(item, offer, audience);
      const current = offerJson(offer, summary);
      if (offer.kind === "quote" && offer.deadline && nowOf(c) > Date.parse(offer.deadline)) {
        throw new WriteError(
          "offer_expired",
          words.problems.offerExpired(
            vars({ validThrough: whenText(offer.deadline, audience.timezone, audience.lang) }),
          ),
          { details: { validThrough: offer.deadline } },
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
          event: "accept",
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

  /** The customer says no to what the business proposed: a booking's other time closes the request; a quote is declined. */
  async declineOffer(caller: Caller, input: T.DeclineOfferInput): Promise<CustomerResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:decline_offer");
    const c = await this.customerCaller(caller, input);
    const hashInput = { door: "decline_offer", item_id: input.item_id, reason: input.reason ?? null };
    const replayed = await this.replayIfSeen(c, input.item_id, "decline", hashInput);
    if (replayed) return replayed;
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    const event =
      item.type === "booking" && item.state === "proposed"
        ? "cancel"
        : item.type === "quote_request" && item.state === "quoted"
          ? "decline"
          : null;
    if (!event) {
      const audience = await this.audienceOf(item, c);
      throw new WriteError("no_offer", copyFor(audience.lang).problems.nothingToAnswer, {
        details: { state: item.state },
      });
    }
    const note = input.reason?.trim() ? { input: { note: input.reason.trim() }, reason: input.reason.trim() } : {};
    const r = await transitionItem(this.db, c, { itemId: item.id, event, ...note, hashInput });
    return this.result(r, c);
  }

  /** The customer asks for another time than the one we proposed: back to the business, nothing held. */
  async suggestTime(caller: Caller, input: T.SuggestTimeInput): Promise<CustomerResult> {
    await this.deps.access.requireScope(caller, ["inbox:write"], "public:suggest_time");
    const c = await this.customerCaller(caller, input);
    const hashInput = {
      door: "suggest_time",
      item_id: input.item_id,
      start_time: input.start_time,
      note: input.note ?? null,
    };
    const replayed = await this.replayIfSeen(c, input.item_id, "counter", hashInput);
    if (replayed) return replayed;
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    if (!(item.type === "booking" && item.state === "proposed")) {
      const audience = await this.audienceOf(item, c);
      throw new WriteError("no_offer", copyFor(audience.lang).problems.nothingToAnswer, {
        details: { state: item.state },
      });
    }
    const r = await transitionItem(this.db, c, {
      itemId: item.id,
      event: "counter",
      input: { startTime: input.start_time, ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
      hashInput,
    });
    return this.result(r, c);
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
    return { view: await this.present(result, audience), waiting_on: "us", replayed, appended: true };
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
        event = "accept";
        break;
      case "decline_time":
        event = "cancel";
        input = reason ? { note: reason } : undefined;
        break;
      case "decline_quote":
        event = "decline";
        input = reason ? { note: reason } : undefined;
        break;
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
          ...(event === "cancel" || event === "decline" ? (reason ? { reason } : {}) : {}),
          expectedVersion: expected,
          extraStatements: [linkUsedStatement(row.jti, now)],
          hashInput: { link: row.jti, event, input: input ?? null },
        });
        return { redirect: `/c/${token}` };
      } catch (error) {
        if (!(error instanceof WriteError)) throw error;
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
        if (row.action === "other_time" && again) {
          return this.pageFor(again, now, { error: error.message, status: 409, from: form.from });
        }
        return this.plain(ctx, 409, c.problems.slotTaken);
      case "guard_failed":
        if ((error.details as { guard?: unknown } | undefined)?.guard === "not_too_soon" && again) {
          if (row.action === "accept_time") {
            return this.pageFor(again, now, { error: words.acceptTime.tooLate, status: 409, picker: true });
          }
          if (row.action === "other_time") {
            return this.pageFor(again, now, { error: c.problems.notTooSoon, status: 409, from: form.from });
          }
        }
        return this.plain(ctx, 409, words.noLonger(vars({ status: status(item, audience) })));
      case "offer_expired":
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
    const offer = await openOffer(item, { minNoticeMin: audience.minNoticeMin });
    if (!offer || offer.termsSha !== row.termsSha) return this.plain(ctx, 409, words.offerChanged);
    // The link lives a day past the answer-by date, so the page can say why it is too late: a quote
    // that lapsed says so (a time we proposed says so beside the free times, in `pageFor`).
    if (offer.kind === "quote" && offer.deadline && now > Date.parse(offer.deadline)) return this.expiredPage(ctx);
    return null;
  }

  private expiredPage(ctx: LinkContext): CustomerPage {
    const { item, audience } = ctx;
    const words = copyFor(audience.lang).page;
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
        return this.pageFor(ctx, now, { error: words.acceptTime.tooLate, status: 410, picker: true });
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
      const rows = [
        ...(proposed ? [{ label: words.rows.when, value: whenText(proposed.startTime, tz, lang) }] : []),
        ...(price ? [{ label: words.rows.price, value: moneyIn(price, lang) }] : []),
        ...(proposed
          ? [
              {
                label: words.rows.answerBy,
                value: whenText(
                  new Date(Date.parse(proposed.startTime) - audience.minNoticeMin * 60_000).toISOString(),
                  tz,
                  lang,
                ),
              },
            ]
          : []),
      ];
      const note = await noteOf(this.db, item.id, "propose");
      if (row.action === "accept_time") {
        return {
          ...base,
          heading: words.acceptTime.heading,
          ...error,
          paragraphs: [words.acceptTime.lead(vars({ what })), words.acceptTime.unheld],
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
    } else if (row.action === "details" && item.state !== "needs_info") {
      text = words.details.done;
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
      });
      slots = r.slots.filter((s) => Date.parse(s.startTime) > now).slice(0, 40);
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
    const view = await this.present(r.view.item, await this.audienceOf(r.view.item, caller, facts));
    const linked = r.linked
      ? await this.present(r.linked.item, await this.audienceOf(r.linked.item, caller, facts))
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

function offerJson(offer: OpenOffer, human: string): CustomerOffer {
  return {
    kind: offer.kind,
    terms: offer.terms,
    terms_sha: offer.termsSha,
    deadline: offer.deadline,
    obligation_to_pay: offer.obligationToPay,
    human,
  };
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
    case "details":
      return item.state === "needs_info";
    case "networks_off":
      return true;
  }
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
