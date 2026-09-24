import type { MailOut } from "@surfingdog/platform";
import { and, desc, eq, gt, inArray, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { AccessCapabilities } from "../access/keys";
import { assertNoLeak, PUBLISHED, stringsIn } from "../access/leaks";
import { isOwnerOrSystem, mayDirectDataOut, ownerOnlyError } from "../access/outbound";
import { effectiveWrittenBy, isAutomated } from "../customer/mail";
import type { Db } from "../db";
import type { Item } from "../domain/types";
import { networksStopped } from "../identity/stops";
import type { IdentityAnswer } from "../identity/types";
import { mailForItem, senderOf } from "../jobs/mail-log";
import { type NetworkView, networkStartStatements, networkViews } from "../network/index";
import { ReceiptCapabilities, type ReceiptStatus, type ReceiptView } from "../receipts/capabilities";
import {
  business,
  itemEvents,
  items,
  parties,
  partyContacts,
  products,
  services,
  settings as settingsTable,
  threadEntries,
} from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { changedSettings, DATA_OUT_SETTINGS, OWNER_ONLY_SETTINGS, openedNetworks } from "../settings/guard";
import { mergeSettings, patchPaths } from "../settings/merge";
import { prepareSettingsWrite, syncLegacyPair } from "../settings/patch";
import {
  isPlainObject,
  parseStoredSettings,
  REDACTED_SECRET,
  readSettings,
  reportsTo,
  SECRET_SETTINGS_PATHS,
  SETTINGS_SCHEMA_VERSION,
  type Settings,
  settingsWriteSchema,
} from "../settings/schema";
import { hashText } from "../util/canonical";
import {
  type Caller,
  type EventActor,
  eventActor,
  isCustomer,
  isOwnerAssistant,
  isOwnerInPerson,
  nowOf,
  permissionKind,
  withIdempotencyKey,
} from "../write/caller";
import { hiddenTransitions } from "../write/corrections";
import type { CreateResult } from "../write/create";
import { type FieldProblem, fromZod, WriteError } from "../write/errors";
import { type OnceOptions, type OnceResult, once } from "../write/idempotency";
import { appendThreadEntry } from "../write/thread";
import { type TransitionResult, transitionItem } from "../write/transition";
import { customerItem, type ItemView, type PartyView, rowToItem, viewFor } from "../write/views";
import { findSlots, type Slot } from "./availability";
import { CustomerDoors, type CustomerItemView } from "./customer";
import { CustomerData } from "./customers";
import { FeedCapabilities } from "./feeds";
import { type CustomerView, IdentityCapabilities } from "./identity";
import { SetupCapabilities } from "./setup";
import type * as T from "./types";
import { WebhookCapabilities } from "./webhooks";

/**
 * The capability set: the eleven public and the owner operations, implemented once. Adapters
 * (REST, MCP, A2A, email, form, …) only translate; they never touch storage or policy.
 */
export interface BusinessProfile {
  readonly name: string;
  readonly domain: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: readonly string[];
  readonly item_types: readonly string[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

/**
 * A customer's view of their item (the status door): the item as they see it, what we proposed and
 * who we wait on (`CustomerItemView`), its receipts, and who the inbox takes them for.
 */
export interface ItemStatus extends ItemView {
  readonly identity: IdentityAnswer;
  readonly reference?: string;
  readonly offer?: CustomerItemView["offer"];
  readonly waiting_on?: CustomerItemView["waiting_on"];
  readonly next?: CustomerItemView["next"];
  /**
   * The conversation as the customer has it: what they wrote and what the business wrote to them,
   * oldest first, the last fifty — never the business's internal notes. `automated` marks what a
   * rule or the business's assistant sent.
   */
  readonly thread?: readonly CustomerThreadEntry[];
}

export interface CustomerThreadEntry {
  readonly from: "you" | "us";
  readonly text: string;
  readonly at: string;
  readonly automated?: true;
}

/** An email the inbox sent, or tried to, about an item: what the owner's app lists under "Emails". */
export interface MailView {
  readonly id: string;
  readonly recipient: "customer" | "owner";
  readonly template: string;
  readonly subject: string;
  /** The text as sent, each answer link cut short (`cutLinks`): it opens nothing for whoever reads it here. */
  readonly body: string;
  /** queued | sent | retrying | failed | skipped: never `sent` before the mail service took it. */
  readonly status: string;
  /** Why it was not sent: no_address, no_sender, no_service, test_item. */
  readonly skip_reason: string | null;
  readonly last_error: string | null;
  readonly attempts: number;
  readonly sent_at: string | null;
  readonly created_at: string;
  /** The reply it carries, when it is one. */
  readonly entry_id: string | null;
}

/** What became of the email a reply went out in. */
export interface EntryDelivery {
  readonly status: string;
  readonly sent_at: string | null;
  readonly last_error: string | null;
  readonly skip_reason: string | null;
}

export interface ItemDetail extends ItemView {
  /** Who is asking, as the owner sees it (ADR-017 §8.2): the match, the history, the networks, the agent. */
  readonly customer?: CustomerView | undefined;
  readonly events: readonly {
    seq: number;
    event: string;
    from: string | null;
    to: string;
    /** `kind:id`, as it always was. */
    actor: string;
    /** Who caused it: the actor's kind and id, and the name of the key or AI app when there is one. */
    by: EventActor;
    /** The door it came through: `rest`, `mcp_owner`, `owner_ui`, `email`, … */
    channel: string | null;
    reason: string | null;
    at: string;
  }[];
  readonly thread: readonly {
    id: string;
    direction: string;
    channel: string;
    actor: string;
    body: string;
    at: string;
    /** For a reply to the customer: what became of its email. Absent where no email carried it. */
    delivery?: EntryDelivery;
  }[];
  /** Every email about the item, to the customer and to the owner, and what became of each. */
  readonly mail: readonly MailView[];
}

/** The settings document as a read returns it: secrets masked, and named in `redacted`. */
export interface SettingsView {
  readonly doc: Settings;
  readonly version: number;
  /** Settings paths that hold a secret this read masks as `REDACTED_SECRET`, e.g. `email.inboundSecret`. */
  readonly redacted: readonly string[];
}

export class Capabilities {
  /** The owner's setup: profile, services, products, opening hours, rules. */
  readonly setup: SetupCapabilities;

  /** Where events go, and the cursor a developer polls when it cannot receive one (ADR-015). */
  readonly webhooks: WebhookCapabilities;

  /** Product feeds: the one integration that needs no credentials at all (ADR-015 §7.3). */
  readonly feeds: FeedCapabilities;

  /** Signed receipts and their acknowledgements (ADR-016). Issued by a job, read by every door. */
  readonly receipts: ReceiptCapabilities;

  /** Keys and scopes (ADR-004): integration keys, and the one scope check every owner door calls. */
  readonly access: AccessCapabilities;

  /**
   * People and customers (ADR-017 §2, §8): what agents carry, first keys, customers the business
   * already knows, one-time codes. The host plugs in the network calls (`people.attachPort`) and the
   * mail codes go out by (`people.attachMail`).
   */
  readonly people: IdentityCapabilities;

  /**
   * Seals connector credentials and webhook secrets (ADR-015 §2). Null when the instance has no
   * `INBOX_SECRET_KEY`: everything else works, and anything that would store a secret refuses
   * through `requireSecretBox`.
   */
  readonly secrets: SecretBox | null;

  /**
   * The customer's answers to what the business proposed (ADR-018 §5, §6): accept, decline, another
   * time, the details asked for — by their assistant, or by the links in the business's email.
   */
  readonly customer: CustomerDoors;

  /**
   * One customer's data for the owner: what it holds about them (export), switching booking networks
   * off for them, and erasing them — the owner's alone.
   */
  readonly customers: CustomerData;

  private readonly baseUrl: string | undefined;
  private mail: MailOut | null = null;

  /** How email goes out: kept to say in Settings whether it does, and handed on for one-time codes. */
  attachMail(mail: MailOut | null): void {
    this.mail = mail;
    this.people.attachMail(mail);
  }

  /**
   * Whether this inbox can email at all (`service`: a mail service that delivers, not a log), has an
   * address to send from (`sender`), and can put answer links in its emails (`links`: a secret to
   * sign them and a public address for them to open). Settings shows a banner when one is missing.
   */
  async getMailStatus(caller: Caller): Promise<{ service: boolean; sender: boolean; links: boolean }> {
    requireBusiness(caller);
    const settings = await readSettings(this.db);
    const facts = await this.getBusinessProfile();
    const publicUrl = this.baseUrl ?? settings.notifications.appUrl ?? "";
    return {
      service: this.mail !== null && this.mail.delivers !== false,
      sender: senderOf(settings, { transport: this.mail?.sender, publicUrl, business: facts.name }) !== null,
      links: this.secrets !== null && publicUrl.length > 0,
    };
  }

  constructor(
    private readonly db: Db,
    secrets: SecretBox | null = null,
    /**
     * This instance's public URL (`INBOX_PUBLIC_URL`), when the host knows it. It is what an
     * event's `data.url` hangs off, and the delivery job resolves it the same way, so the URL in a
     * webhook body and the URL in `GET /v1/owner/events` are the same string for the same event.
     */
    baseUrl?: string | undefined,
    /**
     * How far behind live the developer event cursor reads (`EVENT_SETTLE_MS`). Only a test that
     * writes an event and polls for it in the same tick ever passes zero.
     */
    eventSettleMs?: number | undefined,
  ) {
    this.setup = new SetupCapabilities(db);
    this.feeds = new FeedCapabilities(db);
    this.secrets = secrets;
    this.webhooks = new WebhookCapabilities(db, secrets, undefined, baseUrl, eventSettleMs);
    this.receipts = new ReceiptCapabilities(db, secrets, baseUrl);
    this.access = new AccessCapabilities(db);
    this.people = new IdentityCapabilities(db, secrets);
    this.baseUrl = baseUrl;
    this.customers = new CustomerData(db);
    this.customer = new CustomerDoors(db, {
      access: this.access,
      people: this.people,
      receipts: this.receipts,
      secrets,
    });
  }

  /**
   * Runs one of the owner's writes at most once per idempotency key (`write/idempotency.ts`): the
   * caller's key, when it carries one, is reserved, the write runs, and a retry gets the stored
   * answer with `replayed: true`. Item writes do not need this; their answer is stored in the
   * batch that makes them.
   */
  once<T>(
    caller: Caller,
    op: string,
    input: unknown,
    run: () => Promise<T>,
    opts?: OnceOptions,
  ): Promise<OnceResult<T>> {
    return once(this.db, caller, op, input, run, opts);
  }

  // ---- public ----------------------------------------------------------------

  async getBusinessProfile(): Promise<BusinessProfile> {
    const [row] = await this.db.orm.select().from(business).limit(1);
    const s = await readSettings(this.db);
    return {
      name: row?.name || s.business.name,
      domain: row?.domain ?? null,
      timezone: row?.timezone ?? s.business.timezone,
      currency: row?.currency ?? s.business.currency,
      languages: row?.languages?.length ? row.languages : s.business.languages,
      item_types: ["message", "quote_request", "booking", "order"],
    };
  }

  /**
   * Active services in the order the owner gave them. `next_cursor` is the id of the last service on
   * the page; passed back as `cursor`, the next page starts right after it (keyset on sort, name, id).
   */
  async listServices(input: T.ListServicesInput): Promise<Page<typeof services.$inferSelect>> {
    const conditions: SQL[] = [eq(services.active, 1)];
    if (input.cursor) {
      const [c] = await this.db.orm
        .select({ sort: services.sort, name: services.name, id: services.id })
        .from(services)
        .where(eq(services.id, input.cursor));
      if (!c) throw badCursor();
      conditions.push(
        or(
          gt(services.sort, c.sort),
          and(eq(services.sort, c.sort), gt(services.name, c.name)),
          and(eq(services.sort, c.sort), eq(services.name, c.name), gt(services.id, c.id)),
        ) ?? sql`1`,
      );
    }
    const rows = await this.db.orm
      .select()
      .from(services)
      .where(and(...conditions))
      .orderBy(services.sort, services.name, services.id)
      .limit(input.limit + 1);
    return page(rows, input.limit, (r) => r.id);
  }

  /** Active products by name; the cursor works as for services (keyset on name, id). */
  async listProducts(input: T.ListProductsInput): Promise<Page<typeof products.$inferSelect>> {
    const conditions: SQL[] = [eq(products.active, 1)];
    if (input.q) conditions.push(sql`lower(${products.name}) LIKE ${`%${input.q.toLowerCase()}%`}`);
    if (input.cursor) {
      const [c] = await this.db.orm
        .select({ name: products.name, id: products.id })
        .from(products)
        .where(eq(products.id, input.cursor));
      if (!c) throw badCursor();
      conditions.push(or(gt(products.name, c.name), and(eq(products.name, c.name), gt(products.id, c.id))) ?? sql`1`);
    }
    const rows = await this.db.orm
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(products.name, products.id)
      .limit(input.limit + 1);
    return page(rows, input.limit, (r) => r.id);
  }

  /**
   * The free times in a window, as a customer may book them: none that has started, and none inside
   * the minimum notice (`booking.minNoticeMin`). `now` is the caller's clock (tests pin it).
   */
  async checkAvailability(
    input: T.CheckAvailabilityInput,
    opts: { readonly now?: number } = {},
  ): Promise<{ service: { id: string; name: string; durationMin: number }; slots: Slot[] }> {
    const [profile, settings] = await Promise.all([this.getBusinessProfile(), readSettings(this.db)]);
    return findSlots(this.db, {
      serviceId: input.service_id,
      from: input.from,
      to: input.to,
      timezone: profile.timezone,
      now: opts.now ?? Date.now(),
      minNoticeMin: settings.booking.minNoticeMin,
    });
  }

  requestQuote(caller: Caller, input: T.RequestQuoteInput): Promise<CreateResult> {
    return this.people.create(
      withIdempotencyKey(caller, input.idempotency_key),
      { type: "quote_request", payload: input.payload, contact: input.contact, message: input.message },
      input,
    );
  }

  /**
   * A booking request. What the agent carried for its person is presented to the networks first;
   * with an email and nothing carried, each network that issues is asked for a first key (ADR-017
   * §2.1). The answer's `identity` says who the inbox takes the customer for.
   */
  createBooking(caller: Caller, input: T.CreateBookingInput): Promise<CreateResult> {
    return this.people.create(
      withIdempotencyKey(caller, input.idempotency_key),
      { type: "booking", payload: input.payload, contact: input.contact, message: input.message },
      input,
    );
  }

  createOrder(caller: Caller, input: T.CreateOrderInput): Promise<CreateResult> {
    return this.people.create(
      withIdempotencyKey(caller, input.idempotency_key),
      { type: "order", payload: input.payload, contact: input.contact, message: input.message },
      input,
    );
  }

  async getItemStatus(caller: Caller, input: T.GetItemStatusInput): Promise<ItemStatus> {
    await this.access.requireScope(caller, ["inbox:read"], "public:get_item_status");
    const { caller: c, presented } = await this.people.recognise(caller, input);
    const row = await this.loadOwned(withToken(c, input.access_token), input.item_id);
    const receipts = await this.receipts.forItem(row.id);
    // The item's first passes go back to its creator (its access token, or the agent key it was
    // made with); a pass alone gets back only what it presented; the business, none of them.
    const creator =
      (caller.actor.partyId !== undefined && caller.actor.partyId === row.partyId) ||
      (input.access_token !== undefined &&
        row.accessTokenHash !== null &&
        (await hashText(input.access_token)) === row.accessTokenHash);
    const item = rowToItem(row);
    // A customer reads it in the business's words and language, with what we proposed and who we wait on.
    const view = isCustomer(caller)
      ? await this.customer.present(item, await this.customer.audienceOf(item, c))
      : viewFor(item, permissionKind(caller));
    return {
      ...view,
      // The business's replies reach a customer who came through an assistant too, not only by email.
      ...(isCustomer(caller) ? { thread: await customerThread(this.db, row.id) } : {}),
      receipts,
      // A key presented here was exchanged for a pass: this answer is the one that hands it back.
      identity: await this.people.answer(
        row.id,
        { presented },
        !isCustomer(caller) ? "business" : creator ? "creator" : "presenter",
      ),
    };
  }

  /**
   * One-time codes for a customer the business already knows (ADR-017 §8.2): without `code`, six
   * digits go to the address it has for them (`202 {sent_to}`); with it, the code is checked and the
   * customer recognised (`{recognised: "strong"}`).
   */
  async verifyCustomer(
    caller: Caller,
    input: T.VerifyCustomerInput,
  ): Promise<{ sent_to: string; test?: true } | { recognised: "strong" }> {
    await this.access.requireScope(caller, ["inbox:write"], "public:verify_customer");
    const row = await this.loadOwned(withToken(caller, input.access_token), input.item_id);
    return this.people.verify(
      { itemId: row.id, partyId: row.partyId, match: row.customerMatch, possiblePartyId: row.possiblePartyId },
      input.code,
      nowOf(caller),
      // A test item emails nobody: its code is left on the item instead.
      { test: rowToItem(row).flags.sandbox },
    );
  }

  /**
   * The customer cancels. A confirmed booking whose cancellation window has closed is cancelled
   * late (`cancel_late`, ADR-017 §3.1) where the owner records late cancellations
   * (`booking.lateCancellation: "record"`), and refused as before where they do not.
   */
  async cancelItem(caller: Caller, input: T.CancelItemInput): Promise<TransitionResult> {
    await this.access.requireScope(caller, ["inbox:write"], "public:cancel_item");
    const { caller: recognised } = await this.people.recognise(caller, input);
    const c = withToken(withIdempotencyKey(recognised, input.idempotency_key), input.access_token);
    const r = await this.cancelOnce(c, input);
    if (!isCustomer(c)) return r;
    // The customer reads their cancelled item as they read it at the status door: none of our flags.
    return { ...r, view: { ...r.view, item: customerItem(r.view.item) } };
  }

  private async cancelOnce(c: Caller, input: T.CancelItemInput): Promise<TransitionResult> {
    const note = input.reason ? { input: { note: input.reason }, reason: input.reason } : {};
    try {
      return await transitionItem(this.db, c, { itemId: input.item_id, event: "cancel", ...note });
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      const closed =
        error.code === "guard_failed" &&
        (error.details as { guard?: unknown } | undefined)?.guard === "within_cancellation_window" &&
        (await readSettings(this.db)).booking.lateCancellation === "record";
      // A retried request whose first try was the late cancellation: its key is stored for
      // `cancel_late`, so that is the request to replay.
      const retried = error.code === "idempotency_mismatch" && c.idempotency !== undefined;
      if (!closed && !retried) throw error;
      return transitionItem(this.db, c, { itemId: input.item_id, event: "cancel_late", ...note });
    }
  }

  /**
   * A new conversation, or a reply on an item the caller owns (which reopens an answered message).
   * `automatic`: the email door found it is an automatic reply (an out-of-office): it is kept on the
   * item and moves nothing, since nobody answered anything.
   */
  async sendMessage(
    caller: Caller,
    input: T.SendMessageInput,
    opts: { readonly automatic?: boolean } = {},
  ): Promise<CreateResult | TransitionResult | ItemView> {
    const c = withToken(withIdempotencyKey(caller, input.idempotency_key), input.access_token);
    if (!input.item_id) {
      return this.people.create(
        c,
        {
          type: "message",
          payload: { text: input.body, subject: input.subject },
          contact: input.contact,
          message: input.body,
          messageId: input.message_id,
        },
        input,
      );
    }
    await this.access.requireScope(caller, ["inbox:write"], "public:send_message");
    const row = await this.loadOwned(c, input.item_id);
    const item = rowToItem(row);
    const customer = isCustomer(c);
    // A message the business put aside as spam stays there: what its sender writes is kept, nobody
    // is told, and they read it as closed — never "spam", never our flags.
    if (customer && item.state === "spam") {
      await appendThreadEntry(this.db, c, item, input.body, "in", input.message_id, { quiet: true });
      return this.customer.present(item, await this.customer.audienceOf(item, c));
    }
    // Only the customer's own words: an automatic reply from their mailbox moves nothing (below).
    const moves = !opts.automatic;
    if (item.type === "message" && item.state !== "open" && moves) {
      return this.asCustomerSees(
        c,
        await transitionItem(this.db, c, {
          itemId: item.id,
          event: "reopen",
          input: { note: input.body },
          ...(input.message_id ? { messageId: input.message_id } : {}),
        }),
      );
    }
    // The customer answers what we asked, however they send it (ADR-018 N14): the item moves on.
    if (customer && item.state === "needs_info" && moves) {
      return this.asCustomerSees(
        c,
        await transitionItem(this.db, c, {
          itemId: item.id,
          event: "provide_info",
          input: { note: input.body },
          ...(input.message_id ? { messageId: input.message_id } : {}),
        }),
      );
    }
    await this.appendEntry(c, item, input.body, "in", input.message_id);
    if (!customer) return viewFor(item, permissionKind(caller));
    return this.customer.present(item, await this.customer.audienceOf(item, c));
  }

  /** A transition's answer as its customer reads it: the business's words, none of its flags. */
  private async asCustomerSees(c: Caller, r: TransitionResult): Promise<TransitionResult> {
    if (!isCustomer(c)) return r;
    return { ...r, view: await this.customer.present(r.view.item, await this.customer.audienceOf(r.view.item, c)) };
  }

  /**
   * The customer's agent counter-signs a receipt it was handed (ADR-016). Ownership of the item is
   * proved the same way as reading it — the party on the caller, or the access token the creator
   * received — and the acknowledgement itself is checked by the receipt capability.
   */
  async acknowledgeReceipt(
    caller: Caller,
    input: T.AcknowledgeReceiptInput,
  ): Promise<ReceiptView & { forwarded?: { network: string; presentation: string }[] }> {
    await this.access.requireScope(caller, ["inbox:write"], "public:acknowledge_receipt");
    if ((input.counter_signature === undefined) === (input.receipt_id === undefined)) {
      throw new WriteError("invalid_input", "send counter_signature, or receipt_id in a signed request", {
        fields: [{ path: "counter_signature", problem: "missing", message: "one of counter_signature or receipt_id" }],
      });
    }
    // A signature is forwarded to a network once: an acknowledgement by `receipt_id` spends it on
    // the acknowledgement, so it is not presented as a request first (the item is the caller's by
    // its access token or key).
    const recognised = input.receipt_id === undefined ? (await this.people.recognise(caller, input)).caller : caller;
    const row = await this.loadOwned(withToken(recognised, input.access_token), input.item_id);
    if (input.counter_signature !== undefined) {
      return this.receipts.acknowledge(row, input.counter_signature, { now: nowOf(caller), receipt: input.receipt });
    }
    // An agent that signs its requests instead of counter-signing (ADR-017 §3.4): its signature,
    // with the pass reference it carries, goes to the network as the acknowledgement.
    const receipt = (await this.receipts.forItem(row.id)).find((r) => r.id === input.receipt_id);
    if (!receipt) throw new WriteError("not_found", "no such receipt on this item");
    // Forwarding is a network call about the customer: not for one who asked us not to make them.
    if (await networksStopped(this.db, { partyIds: [row.partyId] })) {
      throw new WriteError(
        "not_allowed",
        "You asked us not to use the booking network, so we do not pass acknowledgements on to it. The receipt stays yours; send counter_signature to acknowledge it here.",
        { details: { reason: "networks_off" } },
      );
    }
    const sha = await this.receipts.shaOf(receipt.id);
    const forwarded = await this.people.forwardAck(recognised, input, sha);
    return { ...receipt, forwarded };
  }

  // ---- owner -----------------------------------------------------------------

  async listItems(caller: Caller, input: T.ListItemsInput): Promise<Page<ItemView>> {
    requireBusiness(caller);
    const conditions = [eq(items.sandbox, input.sandbox ? 1 : 0)];
    if (input.type) conditions.push(eq(items.type, input.type));
    if (input.state) conditions.push(eq(items.state, input.state));
    if (input.needs_human !== undefined) conditions.push(eq(items.needsHuman, input.needs_human ? 1 : 0));
    if (input.open_only && !input.state) conditions.push(sql`${items.closedAt} IS NULL`);
    // "Email not sent": one that failed for good, or one to the customer that was never sent (no
    // address, nothing to send from, no mail service, the day's acknowledgements used) — but a test
    // item's, which is never sent by design.
    if (input.mail_failed) {
      conditions.push(
        sql`${items.id} IN (SELECT item_id FROM outbound_mail WHERE item_id IS NOT NULL
              AND (status = 'failed'
                OR (status = 'skipped' AND recipient = 'customer' AND COALESCE(skip_reason, '') <> 'test_item')))`,
      );
    }
    if (input.q) {
      const match = ftsQuery(input.q);
      const inText = sql`${items.id} IN (SELECT item_id FROM search_fts WHERE search_fts MATCH ${match})`;
      // The six characters every email to the customer carries as its reference: the id's last six.
      const ref = input.q.trim().toUpperCase();
      conditions.push(
        /^[0-9A-HJKMNP-TV-Z]{6}$/.test(ref) ? (or(inText, sql`${items.id} LIKE ${`%${ref}`}`) ?? inText) : inText,
      );
    }
    if (input.cursor) {
      const c = decodeCursor(input.cursor);
      conditions.push(
        or(lt(items.updatedAt, c.updatedAt), and(eq(items.updatedAt, c.updatedAt), lt(items.id, c.id))) ?? sql`1`,
      );
    }
    const rows = await this.db.orm
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(input.limit + 1);
    const partyViews = await this.partyViews(rows.map((r) => r.partyId));
    const listed = rows.map((r) => ({ item: rowToItem(r), legacyPromise: r.legacyPromise }));
    const hidden = await hiddenTransitions(this.db, listed, await readSettings(this.db), nowOf(caller));
    const views = listed.map(({ item }) =>
      viewFor(item, permissionKind(caller), partyViews.get(item.partyId), hidden.get(item.id)),
    );
    const last = rows[input.limit - 1];
    return {
      items: views.slice(0, input.limit),
      next_cursor: rows.length > input.limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
    };
  }

  /** For the Settings page: can this instance issue receipts, and how many has it. */
  getReceiptStatus(caller: Caller): Promise<ReceiptStatus> {
    requireBusiness(caller);
    return this.receipts.status();
  }

  async getItem(caller: Caller, input: T.GetItemInput): Promise<ItemDetail> {
    requireBusiness(caller);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw new WriteError("not_found", "no such item");
    const item = rowToItem(row);
    const [events, thread, partyViews, receipts, hidden, mail] = await Promise.all([
      this.db.orm.select().from(itemEvents).where(eq(itemEvents.itemId, item.id)).orderBy(itemEvents.seq),
      this.db.orm
        .select()
        .from(threadEntries)
        .where(eq(threadEntries.itemId, item.id))
        .orderBy(threadEntries.createdAt),
      this.partyViews([row.partyId]),
      this.receipts.forItem(item.id),
      // The one-time corrections that can no longer be made are not offered (ADR-017 §3).
      readSettings(this.db).then((settings) =>
        hiddenTransitions(this.db, [{ item, legacyPromise: row.legacyPromise }], settings, nowOf(caller)),
      ),
      mailForItem(this.db, item.id),
    ]);
    const delivery = new Map<string, EntryDelivery>();
    for (const m of mail) {
      if (m.entryId && m.recipient === "customer") {
        delivery.set(m.entryId, {
          status: m.status,
          sent_at: m.sentAt === null ? null : new Date(m.sentAt).toISOString(),
          last_error: m.lastError,
          skip_reason: m.skipReason,
        });
      }
    }
    return {
      ...viewFor(item, permissionKind(caller), partyViews.get(row.partyId), hidden.get(item.id)),
      receipts,
      customer: await this.people.customerView(row),
      events: events.map((e) => ({
        seq: e.seq,
        event: e.event,
        from: e.fromState,
        to: e.toState,
        actor: `${e.actorKind}:${e.actorId}`,
        by: eventActor(e.actorKind, e.actorId, metaString(e.meta, "actor_name")),
        channel: metaString(e.meta, "channel") ?? row.channel,
        reason: e.reason,
        at: new Date(e.createdAt).toISOString(),
      })),
      thread: thread.map((t) => ({
        id: t.id,
        direction: t.direction,
        channel: t.channel,
        actor: `${t.actorKind}:${t.actorId ?? ""}`,
        body: t.bodyText,
        at: new Date(t.createdAt).toISOString(),
        ...(delivery.has(t.id) ? { delivery: delivery.get(t.id) as EntryDelivery } : {}),
      })),
      mail: mail.map((m) => ({
        id: m.id,
        recipient: m.recipient,
        template: m.template,
        subject: m.subject,
        body: m.bodyText,
        status: m.status,
        skip_reason: m.skipReason,
        last_error: m.lastError,
        attempts: m.attempts,
        sent_at: m.sentAt === null ? null : new Date(m.sentAt).toISOString(),
        created_at: new Date(m.createdAt).toISOString(),
        entry_id: m.entryId,
      })),
    };
  }

  /**
   * The owner moves an item. A customer's cancellation the owner records after the window had
   * closed when the customer asked is recorded as late (`record_cancel_late`), where the owner
   * records late cancellations — as the customer's own door would have (ADR-017 §3.1).
   */
  async transitionItem(caller: Caller, input: T.TransitionItemInput): Promise<TransitionResult> {
    requireBusiness(caller);
    // The owner's AI's words on a transition can reach the customer: none of another's (`access/leaks.ts`).
    if (isOwnerAssistant(caller)) {
      const [owned] = await this.db.orm
        .select({ partyId: items.partyId })
        .from(items)
        .where(eq(items.id, input.item_id));
      if (owned) await assertNoLeak(this.db, caller, owned.partyId, [...stringsIn(input.input), input.reason ?? ""]);
    }
    const c = withIdempotencyKey(caller, input.idempotency_key);
    const writtenBy = effectiveWrittenBy(caller, input.written_by);
    const request = {
      itemId: input.item_id,
      event: input.event,
      ...(input.input ? { input: input.input } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expected_version !== undefined ? { expectedVersion: input.expected_version } : {}),
      ...(writtenBy ? { writtenBy } : {}),
    };
    if (input.event !== "record_cancel") return transitionItem(this.db, c, request);
    try {
      return await transitionItem(this.db, c, request);
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      const late =
        error.code === "guard_failed" &&
        (error.details as { guard?: unknown } | undefined)?.guard === "asked_within_window";
      // A retried request whose first try was the late one: its key is stored for `record_cancel_late`.
      const retried = error.code === "idempotency_mismatch" && c.idempotency !== undefined;
      if (!late && !retried) throw error;
      return transitionItem(this.db, c, { ...request, event: "record_cancel_late" });
    }
  }

  /** A reply to the customer (answers an open message) or an internal note. */
  async reply(caller: Caller, input: T.ReplyInput): Promise<TransitionResult | ItemView> {
    requireBusiness(caller);
    const [row] = await this.db.orm.select().from(items).where(eq(items.id, input.item_id));
    if (!row) throw new WriteError("not_found", "no such item");
    const item = rowToItem(row);
    // A reply from the owner's AI names no other customer and carries no secret (`access/leaks.ts`).
    if (!input.internal) await assertNoLeak(this.db, caller, row.partyId, [input.body]);
    // Who wrote it, as the request says: an email nobody typed says it was sent automatically.
    const writtenBy = effectiveWrittenBy(caller, input.written_by);
    if (!input.internal && item.type === "message" && item.state === "open") {
      return transitionItem(this.db, withIdempotencyKey(caller, input.idempotency_key), {
        itemId: item.id,
        event: "answer",
        input: { note: input.body },
        ...(writtenBy ? { writtenBy } : {}),
      });
    }
    // Not a transition, so not stored in a batch: the key is held around the append instead, and a
    // retried note is written once.
    const keyed = withIdempotencyKey(caller, input.idempotency_key);
    const { result } = await once(
      this.db,
      keyed,
      "items.reply",
      { item_id: input.item_id, body: input.body, internal: input.internal, written_by: writtenBy },
      async () => {
        await appendThreadEntry(this.db, caller, item, input.body, input.internal ? "note" : "out", undefined, {
          writtenBy,
        });
        const hidden = await hiddenTransitions(
          this.db,
          [{ item, legacyPromise: row.legacyPromise }],
          await readSettings(this.db),
          nowOf(caller),
        );
        return viewFor(item, permissionKind(caller), undefined, hidden.get(item.id));
      },
    );
    return result;
  }

  /**
   * The settings document and its version, with every secret masked (`SECRET_SETTINGS_PATHS`,
   * shown as `REDACTED_SECRET`) and named in `redacted`: the owner's AI reads this, and a secret it
   * can read is a secret every connected tool can read. A secret is only ever written; writing the
   * document back as read, or without it, keeps it.
   */
  async getSettings(caller: Caller): Promise<SettingsView> {
    requireBusiness(caller);
    const [row] = await this.db.orm
      .select({ doc: settingsTable.doc, version: settingsTable.version })
      .from(settingsTable)
      .limit(1);
    // Leniently, like every other reader: a stored value this version rejects is shown as its
    // default, and the owner app saving the page writes only what the owner changed.
    return redact(parseStoredSettings(row?.doc ?? {}).settings, row?.version ?? 0);
  }

  /**
   * A merge, never a replace (`settings/merge.ts`): the caller's changes are laid over the stored
   * document as it was written — not over what this version parsed out of it — and that raw
   * document is what is stored. So a section, a key or a network the caller left out keeps its
   * value, a key only a newer version knows survives, and no default is written back as if it had
   * been chosen. The result is checked along the paths the caller changed; a stored value that
   * was valid once and is not now does not block a change to something else.
   */
  async updateSettings(caller: Caller, input: T.UpdateSettingsInput): Promise<SettingsView> {
    requireBusiness(caller);
    const now = nowOf(caller);
    const [row] = await this.db.orm
      .select({ doc: settingsTable.doc, version: settingsTable.version })
      .from(settingsTable)
      .limit(1);
    const stored = row && isPlainObject(row.doc) ? row.doc : {};
    let doc = withoutMaskedSecrets(input.doc);
    // `security` is the owner's own: whether scopes are enforced, and where security reports go.
    // An AI, or a key handed to another system, must not be able to change either.
    // Sending it back unchanged is not a change: a client that writes back the whole document it
    // read (every read has the section) keeps working, and the section is left as it is stored.
    if (Object.hasOwn(doc, "security") && (!isOwnerInPerson(caller) || caller.actor.channel === "mcp_owner")) {
      const { security, ...rest } = doc;
      const current = parseStoredSettings(stored).settings.security;
      const wanted = parseStoredSettings(mergeSettings(stored, { security })).settings.security;
      if (JSON.stringify(current) !== JSON.stringify(wanted)) {
        throw new WriteError(
          "not_allowed",
          "Only the owner can change the security settings, signed in to the owner app (Settings → Keys). Nothing was changed; tell the owner what you suggest.",
          {
            details: { reason: "owner_in_person", ask_owner: true, where: "Settings → Keys" },
            fields: [{ path: "doc.security", problem: "invalid", message: "only the owner in person can change this" }],
          },
        );
      }
      doc = rest;
    }
    const prepared = prepareSettingsWrite(stored, doc);
    if ("problems" in prepared) {
      throw new WriteError("invalid_input", `Invalid input: ${describeProblems(prepared.problems)}`, {
        fields: prepared.problems,
      });
    }
    const merged = mergeSettings(prepared.base, prepared.patch) as Record<string, unknown>;
    merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
    syncLegacyPair(merged);
    const checked = settingsWriteSchema.safeParse(merged);
    if (!checked.success) {
      const changed = patchPaths(prepared.patch);
      const issues = checked.error.issues.filter((issue) => {
        const at = issue.path.map(String);
        return changed.some((p) => startsWith(at, p) || startsWith(p, at));
      });
      if (issues.length) throw fromZod(new z.ZodError(issues), "doc");
    }
    const json = JSON.stringify(merged);
    // What is stored is what was sent, unknown keys included, so its size is bounded here.
    if (json.length > MAX_SETTINGS_BYTES) {
      throw new WriteError("invalid_input", `the settings document would be over ${MAX_SETTINGS_BYTES / 1024} KB`, {
        fields: [{ path: "doc", problem: "invalid", message: "too large" }],
      });
    }
    const before = parseStoredSettings(stored).settings;
    const after = parseStoredSettings(merged).settings;
    // Where this inbox sends email, alerts and events, and who it trusts, are never the owner's AI's
    // to change: it reads what customers write, and a customer can write "send everything to me"
    // (`access/outbound.ts`, `settings/guard.ts`). Sending a value back unchanged changes nothing.
    const redirected = changedSettings(before, after, DATA_OUT_SETTINGS);
    if (redirected.length && !mayDirectDataOut(caller, "settings:write")) {
      throw ownerOnlyError(`change ${redirected.join(", ")}`, "Settings", {
        scope: "settings:write",
        fields: redirected.map((path) => ({
          path: `doc.${path}`,
          message: "only the owner in person, or a key the owner gave settings:write, can change this",
        })),
      });
    }
    const trusted = changedSettings(before, after, OWNER_ONLY_SETTINGS);
    if (trusted.length && !isOwnerOrSystem(caller)) {
      throw ownerOnlyError(`change ${trusted.join(", ")}`, "Settings", {
        fields: trusted.map((path) => ({ path: `doc.${path}`, message: "only the owner in person can change this" })),
      });
    }
    // The business's name signs every email and heads its public profile: words every customer
    // reads, which carry no customer's details from the owner's AI (`access/leaks.ts`).
    if (after.business.name !== before.business.name) {
      await assertNoLeak(this.db, caller, PUBLISHED, [after.business.name]);
    }
    // A network switched on is sent customers' email addresses once it answers this inbox's ping
    // (Tiago, 23 September 2026): which networks may have them, and what each is sent, is for a
    // person at the business to decide. The owner's AI, or a key handed to another system, may
    // switch one off or share less with it, never switch one on, let it issue keys, or share more.
    if (isOwnerAssistant(caller) || caller.principal?.keyKind === "integration") {
      const opened = openedNetworks(before, after);
      if (opened.length) {
        throw new WriteError(
          "not_allowed",
          "Only the owner can switch a network on or let it have more, signed in to the owner app (Settings → Networks): a network is sent customers' email addresses. Nothing was changed; tell the owner what you suggest.",
          {
            details: { reason: "owner_in_person", ask_owner: true, where: "Settings → Networks" },
            fields: opened.map((path) => ({
              path: `doc.${path}`,
              problem: "invalid" as const,
              message: "only the owner in person can switch a network on or share more with it",
            })),
          },
        );
      }
    }
    let version: number;
    if (!row) {
      await this.db.client.query({
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', ?, ?, 1, ?)",
        params: [SETTINGS_SCHEMA_VERSION, json, now],
        method: "run",
      });
      version = 1;
    } else {
      const expected = input.expected_version ?? row.version;
      const res = await this.db.client.query({
        sql: "UPDATE settings SET doc = ?, version = version + 1, updated_at = ? WHERE id = 'singleton' AND version = ?",
        params: [json, now, expected],
        method: "run",
      });
      if (res.changes !== 1)
        throw new WriteError("version_conflict", "settings changed since you read them", {
          details: { currentVersion: row.version },
        });
      version = expected + 1;
    }
    // A network just switched on hears from this inbox now, not at the top of the next hour: its
    // ping, and its publisher, which queues every receipt already issued (ADR-017 §8.1). Losing
    // this insert costs nothing but the wait: the hourly tick queues the same jobs by the same keys.
    const started = Object.entries(after.networks).filter(
      ([origin, entry]) => reportsTo(entry) && !reportsTo(before.networks[origin]),
    );
    if (started.length) {
      await this.db.batch(started.flatMap(([origin, entry]) => networkStartStatements(origin, entry, now)));
    }
    return redact(after, version);
  }

  /**
   * Keeps `origin` as the Inbox address (`notifications.appUrl`) when the host has no public URL of
   * its own (`INBOX_PUBLIC_URL`) and none is set yet: the owner's sign-in calls it with the https
   * address they opened their link at. Receipts, links in emails and networks read the Inbox address
   * when there is no request to take one from, so an instance deployed with one click, where nobody
   * typed an address, still has one. Never overwrites: the owner changes it in Settings.
   */
  async rememberInboxAddress(origin: string, now: number = Date.now()): Promise<boolean> {
    if (this.baseUrl) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "https:") return false;
    const [row] = await this.db.orm
      .select({ doc: settingsTable.doc, version: settingsTable.version })
      .from(settingsTable)
      .limit(1);
    if (parseStoredSettings(row?.doc ?? {}).settings.notifications.appUrl) return false;
    const system: Caller = {
      actor: { kind: "system", id: "sign-in", channel: "system" },
      tier: "verified_principal",
      sandbox: false,
      now: () => now,
    };
    try {
      await this.updateSettings(system, {
        doc: { notifications: { appUrl: url.origin } },
        ...(row ? { expected_version: row.version } : {}),
      });
      return true;
    } catch (error) {
      // Someone saved the settings at the same moment: theirs stands, and the next sign-in tries again.
      if (error instanceof WriteError && error.code === "version_conflict") return false;
      throw error;
    }
  }

  /** Every network in settings, switched on or not, with how it is going and what it has been sent. */
  async getNetworks(caller: Caller): Promise<{ networks: NetworkView[] }> {
    requireBusiness(caller);
    return { networks: await networkViews(this.db, await readSettings(this.db)) };
  }

  // ---- helpers ---------------------------------------------------------------

  /** Who is behind each item, for the business side: name, contact, and whether any identity is verified. */
  private async partyViews(ids: readonly string[]): Promise<Map<string, PartyView>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, PartyView>();
    if (unique.length === 0) return out;
    const [rows, verified] = await Promise.all([
      this.db.orm.select().from(parties).where(inArray(parties.id, unique)),
      this.db.orm
        .select({ partyId: partyContacts.partyId })
        .from(partyContacts)
        .where(and(inArray(partyContacts.partyId, unique), isNotNull(partyContacts.verifiedAt))),
    ]);
    const verifiedIds = new Set(verified.map((v) => v.partyId));
    for (const p of rows) {
      const contact = (p.contact ?? {}) as { email?: string; phone?: string; name?: string };
      out.set(p.id, {
        id: p.id,
        name: p.displayName ?? contact.name ?? null,
        kind: p.kind,
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        verified: verifiedIds.has(p.id),
      });
    }
    return out;
  }

  /**
   * The item, if the caller may touch it through a public door: a customer only their own, by
   * party or access token; an owner-side caller any item, which is why the public reads and writes
   * on an existing item also check the owner-side caller's scopes (`inbox:read`, `inbox:write`) —
   * a key must not reach through the public door what the owner door would refuse it.
   */
  private async loadOwned(caller: Caller, itemId: string) {
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

  private appendEntry(
    caller: Caller,
    item: Item,
    body: string,
    direction: "in" | "out" | "note",
    messageId?: string | undefined,
  ): Promise<void> {
    return appendThreadEntry(this.db, caller, item, body, direction, messageId);
  }
}

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function redact(settings: Settings, version: number): SettingsView {
  const doc = structuredClone(settings) as unknown as Record<string, Record<string, unknown> | undefined>;
  const redacted: string[] = [];
  for (const [section, key] of SECRET_SETTINGS_PATHS) {
    const s = doc[section];
    if (s && s[key] !== undefined) {
      // Masked, not removed: the key keeps its place and type for every client of the old shape.
      s[key] = REDACTED_SECRET;
      redacted.push(`${section}.${key}`);
    }
  }
  return { doc: doc as unknown as Settings, version, redacted };
}

/** A write that carries a secret as a read masked it means "keep it": that value is left out. */
function withoutMaskedSecrets(doc: Record<string, unknown>): Record<string, unknown> {
  let out = doc;
  for (const [section, key] of SECRET_SETTINGS_PATHS) {
    const s = out[section];
    if (isPlainObject(s) && s[key] === REDACTED_SECRET) {
      const { [key]: _masked, ...rest } = s;
      out = { ...out, [section]: rest };
    }
  }
  return out;
}

function badCursor(): WriteError {
  return new WriteError("invalid_input", "invalid cursor", {
    fields: [{ path: "cursor", problem: "invalid", message: "pass the next_cursor of the previous page" }],
  });
}

function withToken(caller: Caller, token: string | undefined): Caller {
  return token ? { ...caller, accessToken: token } : caller;
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "owner operations need an owner or staff principal");
}

function page<R>(rows: R[], limit: number, id: (r: R) => string): Page<R> {
  const last = rows[limit - 1];
  return { items: rows.slice(0, limit), next_cursor: rows.length > limit && last ? id(last) : null };
}

function encodeCursor(c: { updatedAt: number; id: string }): string {
  return btoa(`${c.updatedAt}|${c.id}`);
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const [updatedAt, id] = atob(cursor).split("|");
    if (!updatedAt || !id) throw new Error("bad cursor");
    return { updatedAt: Number(updatedAt), id };
  } catch {
    throw new WriteError("invalid_input", "invalid cursor", {
      fields: [{ path: "cursor", problem: "invalid", message: "not a cursor from this API" }],
    });
  }
}

/** Never pass user text to FTS raw: tokenise, quote, prefix-match. */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"*`).join(" ");
}

const MAX_SETTINGS_BYTES = 64 * 1024;

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((p, i) => path[i] === p);
}

function describeProblems(problems: readonly FieldProblem[]): string {
  return problems.map((p) => `${p.path} ${p.message}`).join("; ");
}

/**
 * The conversation as the customer has it (the status door): what they wrote and what we wrote to
 * them, oldest first, the last fifty. Never an internal note.
 */
async function customerThread(db: Db, itemId: string): Promise<CustomerThreadEntry[]> {
  const { rows } = await db.client.query({
    sql: `SELECT direction, body_text, created_at, actor_kind, channel, written_by FROM (
            SELECT direction, body_text, created_at, actor_kind, channel, written_by, id FROM thread_entries
             WHERE item_id = ? AND direction IN ('in', 'out')
             ORDER BY created_at DESC, id DESC LIMIT 50)
          ORDER BY created_at, id`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    from: r[0] === "in" ? "you" : "us",
    text: String(r[1] ?? ""),
    at: new Date(Number(r[2])).toISOString(),
    ...(r[0] === "out" &&
    isAutomated(String(r[3]), r[4] === null ? null : String(r[4]), r[5] === null ? null : String(r[5]))
      ? { automated: true as const }
      : {}),
  }));
}
