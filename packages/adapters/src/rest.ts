import {
  acceptOfferInput,
  acknowledgeReceiptInput,
  addFeedInput,
  applyPresetInput,
  type Caller,
  type Capabilities,
  cancelItemInput,
  checkAvailabilityInput,
  createApiKeyInput,
  createBookingInput,
  createOrderInput,
  createWebhookInput,
  declineOfferInput,
  deliveryIdInput,
  eraseCustomerInput,
  eventPatternSchema,
  fromZod,
  getItemInput,
  listDeliveriesInput,
  listEventsInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  type OnceOptions,
  presetKeySchema,
  productInput,
  profileInput,
  provideDetailsInput,
  replayMissingInput,
  replyInput,
  requestQuoteInput,
  ruleInput,
  sendMessageInput,
  serviceInput,
  setClosuresInput,
  setWeeklyInput,
  suggestTimeInput,
  testRuleInput,
  transitionItemInput,
  updateProductInput,
  updateRuleInput,
  updateServiceInput,
  updateSettingsInput,
  updateWebhookInput,
  verifyCustomerInput,
  withIdempotencyKey,
} from "@surfingdog/core";
import { type Context, Hono } from "hono";
import { type DescribeRouteOptions, describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { ownerOperation, routeScopes } from "./access";
import { problemResponse, unauthorized } from "./problem";
import * as R from "./responses";

/**
 * The REST door. Same operations as MCP, described for OpenAPI from the same Zod schemas.
 * Public routes mount at /v1, owner routes at /v1/owner behind an owner API key.
 */
export type CallerEnv = { Variables: { caller: Caller & { auth: { kind: "owner" | "agent" } | null } } };

const json = (description: string, schema?: z.ZodType, status: 200 | 201 = 200) => ({
  [status]: { description, ...(schema ? { content: { "application/json": { schema: resolver(schema) } } } : {}) },
  422: { description: "Invalid input: the problem document names the fields to fix." },
});

/** Every owner operation needs an owner key, an integration key, an OAuth token or the owner app's session. */
const OWNER_SECURITY = [{ ownerKey: [] }];

const IDEMPOTENCY_HEADER = {
  in: "header" as const,
  name: "Idempotency-Key",
  required: false,
  description:
    "Any string up to 200 characters, new for each new request. Sending the same key and body again returns the first answer (with Idempotent-Replayed: true) instead of doing it twice; the same key with a different body is refused. Keys are kept for 30 days.",
  schema: { type: "string" as const, maxLength: 200 },
};

/** An owner operation: security on every one, and the Idempotency-Key header on every write. */
function owner(spec: DescribeRouteOptions & { write?: boolean }) {
  const { write, ...rest } = spec;
  return describeRoute({
    ...rest,
    security: OWNER_SECURITY,
    ...(write ? { parameters: [IDEMPOTENCY_HEADER] } : {}),
    responses: {
      ...rest.responses,
      401: { description: "No owner credentials: send an owner key, an integration key or an OAuth token." },
      403: { description: "Not allowed: the problem document says why." },
    },
  });
}

type Issue = { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] | undefined };

/** The validator hands the hook a Standard Schema issues array; turn it into a problem document. */
const hook = (result: { success: boolean; error?: unknown }, c: Parameters<typeof problemResponse>[0]) => {
  if (result.success) return undefined;
  const raw = result.error;
  const issues: Issue[] = Array.isArray(raw)
    ? (raw as Issue[])
    : ((raw as { issues?: Issue[] } | undefined)?.issues ?? []);
  const fields = issues.map((i) => {
    const path = (i.path ?? []).map((p) => (typeof p === "object" && p !== null ? String(p.key) : String(p))).join(".");
    return { path, problem: /received undefined/i.test(i.message) ? "missing" : "invalid", message: i.message };
  });
  const missing = fields.filter((f) => f.problem === "missing").map((f) => f.path);
  return c.json(
    {
      type: "https://surfingdog.ai/problems/invalid_input",
      title: "Invalid input",
      status: 422,
      code: "invalid_input",
      detail: missing.length
        ? `Missing: ${missing.join(", ")}. Add them and retry with the same idempotency key.`
        : `Invalid input: ${fields.map((f) => `${f.path} ${f.message}`).join("; ") || "see fields"}`,
      fields,
    },
    422,
    { "Content-Type": "application/problem+json" },
  );
};

// ---- query strings: strings in, typed values out, and every parameter in /openapi.json ----------

const limitQuery = z.coerce.number().int().min(1).max(100).default(50);
const boolQuery = z.stringbool();
/** `types=booking.*,order.*`, or `types` repeated. */
const listQuery = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    z.array(item).min(1).max(50),
  );

export const listServicesQuery = listServicesInput.extend({ limit: limitQuery });
export const listProductsQuery = listProductsInput.extend({ limit: limitQuery });
export const listItemsQuery = listItemsInput.extend({
  needs_human: boolQuery.optional(),
  mail_failed: boolQuery.optional().describe("Only items with an email that could not be sent."),
  open_only: boolQuery.default(true).describe("Hide closed items."),
  sandbox: boolQuery.default(false),
  limit: limitQuery,
});
export const listEventsQuery = listEventsInput.extend({
  limit: limitQuery,
  types: listQuery(eventPatternSchema)
    .optional()
    .describe('Only these event types, patterns allowed: "booking.*,order.record_payment", or types repeated.'),
});
export const listDeliveriesQuery = listDeliveriesInput.extend({ limit: limitQuery });

const withIdem = (c: { req: { header: (n: string) => string | undefined } }, body: Record<string, unknown>) => ({
  ...body,
  idempotency_key: (body.idempotency_key as string | undefined) ?? c.req.header("idempotency-key"),
});

const created = <T extends { replayed: boolean }>(
  c: { json: (b: unknown, s: 200 | 201, h?: Record<string, string>) => Response },
  r: T,
) => c.json(r, r.replayed ? 200 : 201, r.replayed ? { "Idempotent-Replayed": "true" } : {});

export function publicRest(caps: Capabilities): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));

  app.get(
    "/business",
    describeRoute({
      tags: ["public"],
      summary: "The business profile",
      responses: json("Profile", R.businessProfileSchema),
    }),
    async (c) => {
      const profile = await caps.getBusinessProfile();
      return c.json(profile, 200, { "Cache-Control": "public, max-age=300" });
    },
  );

  app.get(
    "/services",
    describeRoute({
      tags: ["public"],
      summary: "Services with duration and price model. Pass next_cursor back as cursor for the next page.",
      responses: json("Services", R.pageOf(R.serviceSchema)),
    }),
    validator("query", listServicesQuery, hook),
    async (c) => {
      return c.json(await caps.listServices(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" });
    },
  );

  app.get(
    "/products",
    describeRoute({
      tags: ["public"],
      summary: "Products. Pass next_cursor back as cursor for the next page.",
      responses: json("Products", R.pageOf(R.productSchema)),
    }),
    validator("query", listProductsQuery, hook),
    async (c) => {
      return c.json(await caps.listProducts(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" });
    },
  );

  app.get(
    "/availability",
    describeRoute({
      tags: ["public"],
      summary: "Free slots for a service",
      description:
        "Free start times between from and to (at most 14 days). A time that has started, or that starts within the business's minimum notice, is not offered.",
      responses: json("Slots", R.slotsSchema),
    }),
    validator(
      "query",
      z.object(checkAvailabilityInput.shape).extend({ party_size: z.coerce.number().int().min(1).optional() }),
      hook,
    ),
    async (c) => {
      const caller = c.get("caller");
      return c.json(
        await caps.checkAvailability(c.req.valid("query"), { now: caller.now ? caller.now() : Date.now() }),
      );
    },
  );

  app.post(
    "/quotes",
    describeRoute({
      tags: ["public"],
      summary: "Request a quote",
      responses: json("Created", R.createResultSchema, 201),
    }),
    validator("json", requestQuoteInput, hook),
    async (c) => created(c, await caps.requestQuote(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/bookings",
    describeRoute({
      tags: ["public"],
      summary: "Request a booking",
      responses: json("Created", R.createResultSchema, 201),
    }),
    validator("json", createBookingInput, hook),
    async (c) => created(c, await caps.createBooking(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/orders",
    describeRoute({
      tags: ["public"],
      summary: "Place an order",
      responses: json("Created", R.createResultSchema, 201),
    }),
    validator("json", createOrderInput, hook),
    async (c) => created(c, await caps.createOrder(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.get(
    "/items/:id",
    describeRoute({
      tags: ["public"],
      summary: "Status of your item",
      description:
        "For the customer (an access token, or a pass the item recognises): the item in the business's words and language, with offer (what the business proposed and waits for you to answer, and its terms_sha), waiting_on, next, a six-character reference, and thread: the business's replies and the customer's messages, never its internal notes.",
      responses: json("Item", R.customerItemViewSchema),
    }),
    async (c) => {
      const access_token = c.req.query("access_token") ?? c.req.header("x-access-token");
      return c.json(
        await caps.getItemStatus(c.get("caller"), {
          item_id: c.req.param("id"),
          ...(access_token ? { access_token } : {}),
        }),
      );
    },
  );

  app.post(
    "/items/:id/cancel",
    describeRoute({
      tags: ["public"],
      summary: "Cancel your item",
      responses: json("Item", R.transitionResultSchema),
    }),
    validator("json", cancelItemInput.omit({ item_id: true }).partial(), hook),
    async (c) => {
      const body = c.req.valid("json");
      const access_token = body.access_token ?? c.req.header("x-access-token");
      return c.json(
        await caps.cancelItem(
          c.get("caller"),
          withIdem(c, { ...body, item_id: c.req.param("id"), ...(access_token ? { access_token } : {}) }) as never,
        ),
      );
    },
  );

  /** A customer's answer to what the business proposed: the access token from the body, the query or X-Access-Token. */
  const answer = <S extends z.ZodObject>(schema: S) => validator("json", schema.omit({ item_id: true }), hook);
  const withItem = (c: Context<CallerEnv>, body: Record<string, unknown>) => {
    const access_token =
      (body.access_token as string | undefined) ?? c.req.query("access_token") ?? c.req.header("x-access-token");
    return withIdem(c, { ...body, item_id: c.req.param("id"), ...(access_token ? { access_token } : {}) });
  };
  const ANSWER_ERRORS = {
    403: { description: "The item is someone else's: send its access token, or a pass it recognises." },
    409: {
      description:
        "confirm_terms (nothing was written: show your person details.summary and accept again with details.terms_sha), offer_changed (details.offer is the current proposal), no_offer, slot_taken, or guard_failed not_too_soon.",
    },
    410: { description: "offer_expired: the quote is no longer valid." },
  };

  app.post(
    "/items/:id/accept",
    describeRoute({
      tags: ["public"],
      summary: "Accept what the business proposed: another time, or a quote",
      description:
        "Binds your customer, so it takes the confirm step (ADR-018 §5): send terms_sha, the offer.terms_sha from GET /items/{id} that your person said yes to. Without it nothing is written and the answer is 409 confirm_terms with the terms to show them. An accepted time confirms the booking; an accepted quote creates the booking (confirmed) or the order (accepted) it was for, in linked.",
      responses: { ...json("Item", R.customerResultSchema), ...ANSWER_ERRORS },
    }),
    answer(acceptOfferInput),
    async (c) => c.json(await caps.customer.acceptOffer(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/items/:id/decline",
    describeRoute({
      tags: ["public"],
      summary: "Decline what the business proposed",
      description:
        "A time the business proposed: the booking request is closed, as your customer chose. A quote: the request is closed. Send reason for anything they want the business to know.",
      responses: { ...json("Item", R.customerResultSchema), ...ANSWER_ERRORS },
    }),
    answer(declineOfferInput),
    async (c) => c.json(await caps.customer.declineOffer(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/items/:id/counter",
    describeRoute({
      tags: ["public"],
      summary: "Ask for another time than the one the business proposed",
      description:
        "start_time must be one of the free times GET /availability lists; the end follows the service's length. The booking goes back to the business to confirm, with nothing held. 409 slot_taken when that time is not free.",
      responses: { ...json("Item", R.customerResultSchema), ...ANSWER_ERRORS },
    }),
    answer(suggestTimeInput),
    async (c) => c.json(await caps.customer.suggestTime(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/items/:id/details",
    describeRoute({
      tags: ["public"],
      summary: "Send the details the business asked for",
      description:
        "An item waiting on your details moves on (200). On any other item they are kept as your message for the business (202 with waiting_on: us). Never refused for the state the item is in.",
      responses: {
        ...json("Item", R.customerResultSchema),
        202: {
          description: "Kept as your message",
          content: { "application/json": { schema: resolver(R.customerResultSchema) } },
        },
        403: ANSWER_ERRORS[403],
      },
    }),
    answer(provideDetailsInput),
    async (c) => {
      const r = await caps.customer.provideDetails(c.get("caller"), withItem(c, c.req.valid("json")) as never);
      return c.json(r, "appended" in r ? 202 : 200);
    },
  );

  app.post(
    "/messages",
    describeRoute({
      tags: ["public"],
      summary: "Send a message, or reply on your item",
      responses: json("Created", R.createResultSchema, 201),
    }),
    validator("json", sendMessageInput, hook),
    async (c) => {
      const r = await caps.sendMessage(c.get("caller"), withIdem(c, c.req.valid("json")) as never);
      return "replayed" in r ? created(c, r) : c.json(r, 200);
    },
  );

  app.post(
    "/customers/verify",
    describeRoute({
      tags: ["public"],
      summary: "Prove you are a customer the business knows (one-time code)",
      description:
        "When an item's identity says recognised: weak, the customer gave the email of someone the business knows. Send {item_id, access_token} to have six digits emailed to that address (202 {sent_to}); send them back with code to be recognised (200 {recognised: strong}). 409 nothing_to_verify or already_verified; 422 bad_code or code_expired; 429 too_many_attempts.",
      responses: {
        200: { description: "Recognised", content: { "application/json": { schema: resolver(R.verifiedSchema) } } },
        202: { description: "Code sent", content: { "application/json": { schema: resolver(R.codeSentSchema) } } },
        409: { description: "Nothing to verify, or already verified." },
        422: { description: "Wrong or expired code, or invalid input." },
        429: { description: "Too many attempts or codes." },
      },
    }),
    validator("json", verifyCustomerInput, hook),
    async (c) => {
      const body = c.req.valid("json");
      const token = body.access_token ?? c.req.header("x-access-token");
      const r = await caps.verifyCustomer(c.get("caller"), { ...body, ...(token ? { access_token: token } : {}) });
      return c.json(r, "sent_to" in r ? 202 : 200);
    },
  );

  app.post(
    "/items/:id/receipt-ack",
    describeRoute({
      tags: ["public"],
      summary: "Counter-sign a receipt on your item",
      description:
        "Send a compact JWS signed with your agent's Ed25519 key: header {alg:'EdDSA', typ:'sdi-receipt-ack+jws', jwk:<public jwk>}, payload {rcp:<receipt id>, sha:<base64url(SHA-256(receipt jws))>, iat:<unix seconds>}. The receipt ids are on GET /items/{id}.",
      responses: json("Receipt", R.receiptViewSchema),
    }),
    validator("json", acknowledgeReceiptInput.omit({ item_id: true }), hook),
    async (c) => {
      const body = c.req.valid("json");
      const token = body.access_token ?? c.req.query("access_token") ?? c.req.header("x-access-token");
      // Parsed once more with the path param folded in, so the capability sees one typed input.
      const input = acknowledgeReceiptInput.parse({
        ...body,
        item_id: c.req.param("id"),
        ...(token ? { access_token: token } : {}),
      });
      return c.json(await caps.acknowledgeReceipt(c.get("caller"), input));
    },
  );

  return app;
}

export function ownerRest(caps: Capabilities): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));
  // Who may come in at all (an owner-side principal), then whether this principal's scopes cover
  // this operation: one check, from one static map, before any handler runs (ADR-004).
  app.use("*", async (c, next) => {
    const caller = c.get("caller");
    if (caller.auth?.kind !== "owner") return unauthorized(c);
    const operation = ownerOperation(c);
    if (operation) await caps.access.requireScope(caller, routeScopes(operation), operation);
    await next();
  });

  /**
   * A setup write, at most once per Idempotency-Key: the first answer is stored and a retry gets it
   * back with `Idempotent-Replayed: true`. The op name is the one the MCP tool uses, so a key sent
   * through REST and again through MCP is still one request.
   */
  const once = async <T>(
    c: Context<CallerEnv>,
    op: string,
    input: unknown,
    run: (caller: Caller) => Promise<T>,
    status: 200 | 201 = 200,
    opts?: OnceOptions,
    headers?: (result: T) => Record<string, string>,
  ): Promise<Response> => {
    const caller = withIdempotencyKey(c.get("caller"), c.req.header("idempotency-key"));
    const r = await caps.once(caller, op, input, () => run(caller), opts);
    return c.json(r.result, r.replayed ? 200 : status, {
      ...(headers ? headers(r.result) : {}),
      ...(r.replayed ? { "Idempotent-Replayed": "true" } : {}),
    });
  };
  const secret = (fields: readonly string[]): OnceOptions => ({ secret: { box: caps.secrets, fields } });

  app.get(
    "/items",
    owner({ tags: ["owner"], summary: "List items, newest change first", responses: json("Items", R.itemPageSchema) }),
    validator("query", listItemsQuery, hook),
    async (c) => c.json(await caps.listItems(c.get("caller"), c.req.valid("query"))),
  );

  app.get(
    "/items/:id",
    owner({
      tags: ["owner"],
      summary:
        "One item with its events (who caused each, and through which door), conversation, and every email about it with what became of it",
      responses: json("Item detail", R.itemDetailSchema),
    }),
    async (c) => c.json(await caps.getItem(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.post(
    "/items/:id/transitions",
    owner({
      tags: ["owner"],
      summary: "Move an item to its next state",
      responses: json("Item", R.transitionResultSchema),
      write: true,
    }),
    validator("json", transitionItemInput.omit({ item_id: true }), hook),
    async (c) =>
      c.json(
        await caps.transitionItem(
          c.get("caller"),
          withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
        ),
      ),
  );

  app.post(
    "/items/:id/replies",
    owner({
      tags: ["owner"],
      summary: "Reply to the customer or add a note",
      responses: json("Item", R.looseSchema),
      write: true,
    }),
    validator("json", replyInput.omit({ item_id: true }), hook),
    async (c) =>
      c.json(
        await caps.reply(c.get("caller"), withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never),
      ),
  );

  // ---- one customer: what the inbox holds about them, networks off, erasure ---------

  app.get(
    "/customers/:id",
    owner({
      tags: ["owner"],
      summary: "One customer: their parties, items, emails, and whether booking networks are off for them",
      description:
        "The customer is party.id on any of their items, and every party that is them: merged, or with the same email address (the same phone number only when they gave no email, and only records that gave none either). networks_off says since when booking networks are off for them and what each network already had.",
      responses: json("Customer", R.customerSummarySchema),
    }),
    async (c) => c.json(await caps.customers.summary(c.get("caller"), { party_id: String(c.req.param("id")) })),
  );

  app.get(
    "/customers/:id/export",
    owner({
      tags: ["owner"],
      summary: "Everything the inbox holds about one customer, as one JSON document",
      description:
        "Their parties, contacts, identities, network ids, agents, and every item with its events, conversation, emails and receipts. The owner's AI may export too. Never a pass, a key, an access token or a link.",
      responses: json("Customer export", R.looseSchema),
    }),
    async (c) => {
      const data = await caps.customers.export(c.get("caller"), { party_id: String(c.req.param("id")) });
      return c.json(data, 200, {
        "Content-Disposition": `attachment; filename="customer-${String(c.req.param("id")).slice(-6)}.json"`,
        "Cache-Control": "no-store",
      });
    },
  );

  app.post(
    "/customers/:id/networks-off",
    owner({
      tags: ["owner"],
      summary: "Stop using booking networks for one customer",
      description:
        "From now on no network is sent anything about them (no first contact, presentation, receipt or acknowledgement) and nothing a network said about them is read; their bookings, orders and emails are unchanged. The same as the customer's own link in their code email. A network cannot yet be asked to erase what it already has: networks_off lists it.",
      responses: json("Customer", R.customerSummarySchema),
      write: true,
    }),
    async (c) => {
      const body = z
        .object({ item_id: z.string().max(64).optional() })
        .catch({})
        .parse(await c.req.json().catch(() => ({})));
      return c.json(
        await caps.customers.stopNetworks(c.get("caller"), {
          party_id: String(c.req.param("id")),
          ...(body.item_id ? { item_id: body.item_id } : {}),
        }),
      );
    },
  );

  app.post(
    "/customers/:id/erase",
    owner({
      tags: ["owner"],
      summary: "Erase one customer's personal data (cannot be undone)",
      description:
        "Rewrites their names, email addresses, phone numbers, postal addresses, message text and the emails about them to a placeholder, and keeps the structure: item types, states, times, amounts, the event sequence and the receipts. Booking networks are switched off for them for good. Only the owner, signed in or with their own key, or a key given customers:erase; never the owner's AI. Without confirm, or with one that no longer matches, nothing is erased: 409 confirm_erase says what would be, and details.confirm is the value to send.",
      responses: json("Erased", R.eraseResultSchema),
      write: true,
    }),
    async (c) => {
      // A first call may carry no body at all: it is the one that asks what would be erased.
      const parsed = eraseCustomerInput.omit({ party_id: true }).safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) throw fromZod(parsed.error);
      const body = parsed.data;
      return c.json(
        await caps.customers.erase(c.get("caller"), {
          party_id: String(c.req.param("id")),
          ...(body.confirm ? { confirm: body.confirm } : {}),
        }),
      );
    },
  );

  app.get(
    "/mail",
    owner({
      tags: ["owner"],
      summary: "Whether this inbox can send email",
      description:
        "service: a mail service is set up that delivers (without one, every email is written to the log and shows as not sent); sender: there is an address to send from; links: emails can carry answer links (INBOX_SECRET_KEY and a public address are set).",
      responses: json("Mail", R.mailServiceSchema),
    }),
    async (c) => c.json(await caps.getMailStatus(c.get("caller"))),
  );

  app.get(
    "/settings",
    owner({
      tags: ["owner"],
      summary: "The settings document, secrets left out (named in redacted)",
      responses: json("Settings", R.settingsViewSchema),
    }),
    async (c) => c.json(await caps.getSettings(c.get("caller"))),
  );

  app.get(
    "/receipts",
    owner({
      tags: ["owner"],
      summary: "Whether this instance issues receipts, and how many it has",
      responses: json("Receipt status", R.looseSchema),
    }),
    async (c) => c.json(await caps.getReceiptStatus(c.get("caller"))),
  );

  app.get(
    "/networks",
    owner({
      tags: ["owner"],
      summary: "The networks this inbox reports to, and how each one is doing",
      description:
        "Every network in settings, switched on or not: what it is sent, whether it has verified this instance, the last ping it took, the last error in a few words, and how many receipts it has. Add, switch on or switch off a network with PUT /settings and `networks` keyed by origin; the owner's AI and integration keys may switch one off or share less with it, not switch one on, let it issue keys or share more.",
      responses: json("Networks", R.looseSchema),
    }),
    async (c) => c.json(await caps.getNetworks(c.get("caller"))),
  );

  app.put(
    "/settings",
    owner({
      tags: ["owner"],
      summary: "Change settings",
      description:
        "The document you send is merged over the current one: sections and keys left out keep their values, and null removes a key so its default applies again. Networks are a map keyed by https origin; adding one leaves the others as they are. The security section can only be changed by the owner in the owner app.",
      responses: json("Settings", R.settingsViewSchema),
      write: true,
    }),
    validator("json", updateSettingsInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "settings.update", input, (caller) => caps.updateSettings(caller, input));
    },
  );

  // ---- setup: profile, services, products, opening hours, rules ------------------

  app.get(
    "/profile",
    owner({ tags: ["setup"], summary: "Business profile", responses: json("Profile", R.profileSchema) }),
    async (c) => c.json(await caps.setup.getProfile(c.get("caller"))),
  );
  app.put(
    "/profile",
    owner({
      tags: ["setup"],
      summary: "Update the business profile",
      responses: json("Profile", R.profileSchema),
      write: true,
    }),
    validator("json", profileInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "profile.update", input, (caller) => caps.setup.updateProfile(caller, input));
    },
  );

  app.get(
    "/services",
    owner({
      tags: ["setup"],
      summary: "All services, archived included",
      responses: json("Services", R.listOf(R.serviceSchema)),
    }),
    async (c) => c.json({ items: await caps.setup.listServices(c.get("caller")) }),
  );
  app.post(
    "/services",
    owner({
      tags: ["setup"],
      summary: "Add a bookable service",
      description:
        "A fixed price is per booking unless price.per is person. Prices are the owner's: a service the owner's AI adds with a price is saved unpublished (active false) for the owner to check and publish.",
      responses: json("Service", R.serviceSchema, 201),
      write: true,
    }),
    validator("json", serviceInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "services.create", input, (caller) => caps.setup.createService(caller, input), 201);
    },
  );
  app.patch(
    "/services/:id",
    owner({
      tags: ["setup"],
      summary: "Change a service",
      description:
        "Only the fields you send change. Prices are the owner's: the owner's AI cannot change a price or publish a priced service (403, not_allowed).",
      responses: json("Service", R.serviceSchema),
      write: true,
    }),
    validator("json", updateServiceInput.omit({ service_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), service_id: String(c.req.param("id")) };
      return once(c, "services.update", input, (caller) => caps.setup.updateService(caller, input));
    },
  );
  app.delete(
    "/services/:id",
    owner({ tags: ["setup"], summary: "Archive a service", responses: json("Service", R.serviceSchema), write: true }),
    async (c) => {
      const input = { service_id: String(c.req.param("id")) };
      return once(c, "services.archive", input, (caller) => caps.setup.archiveService(caller, input));
    },
  );

  app.get(
    "/products",
    owner({
      tags: ["setup"],
      summary: "All products, archived included",
      responses: json("Products", R.listOf(R.productSchema)),
    }),
    async (c) => c.json({ items: await caps.setup.listProducts(c.get("caller")) }),
  );
  app.post(
    "/products",
    owner({
      tags: ["setup"],
      summary: "Add a product",
      description:
        "Prices are the owner's: a product the owner's AI adds is saved unpublished (active false) for the owner to check and publish.",
      responses: json("Product", R.productSchema, 201),
      write: true,
    }),
    validator("json", productInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "products.create", input, (caller) => caps.setup.createProduct(caller, input), 201);
    },
  );
  app.patch(
    "/products/:id",
    owner({
      tags: ["setup"],
      summary: "Change a product",
      description:
        "Only the fields you send change. Prices are the owner's: the owner's AI cannot change a price or publish a product (403, not_allowed).",
      responses: json("Product", R.productSchema),
      write: true,
    }),
    validator("json", updateProductInput.omit({ product_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), product_id: String(c.req.param("id")) };
      return once(c, "products.update", input, (caller) => caps.setup.updateProduct(caller, input));
    },
  );
  app.delete(
    "/products/:id",
    owner({ tags: ["setup"], summary: "Archive a product", responses: json("Product", R.productSchema), write: true }),
    async (c) => {
      const input = { product_id: String(c.req.param("id")) };
      return once(c, "products.archive", input, (caller) => caps.setup.archiveProduct(caller, input));
    },
  );

  app.get(
    "/availability",
    owner({
      tags: ["setup"],
      summary: "Opening hours, per-service overrides and closures",
      responses: json("Availability", R.availabilitySchema),
    }),
    async (c) => c.json(await caps.setup.getAvailability(c.get("caller"))),
  );
  app.put(
    "/availability",
    owner({
      tags: ["setup"],
      summary: "Set the weekly opening hours (business-wide or for one service)",
      responses: json("Availability", R.availabilitySchema),
      write: true,
    }),
    validator("json", setWeeklyInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "availability.weekly", input, (caller) => caps.setup.setWeekly(caller, input));
    },
  );
  app.delete(
    "/availability/:serviceId",
    owner({
      tags: ["setup"],
      summary: "Remove a service's own hours so it follows the business hours",
      responses: json("Availability", R.availabilitySchema),
      write: true,
    }),
    async (c) => {
      const input = { service_id: String(c.req.param("serviceId")) };
      return once(c, "availability.clear", input, (caller) => caps.setup.clearWeeklyOverride(caller, input));
    },
  );
  app.put(
    "/availability/closures",
    owner({
      tags: ["setup"],
      summary: "Replace the list of closed days",
      responses: json("Availability", R.availabilitySchema),
      write: true,
    }),
    validator("json", setClosuresInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "availability.closures", input, (caller) => caps.setup.setClosures(caller, input));
    },
  );

  app.get(
    "/rules",
    owner({
      tags: ["setup"],
      summary: "The rules, highest priority first, each with a plain-English summary",
      responses: json("Rules", R.listOf(R.ruleViewSchema)),
    }),
    async (c) => c.json({ items: await caps.setup.listRules(c.get("caller")) }),
  );
  app.get(
    "/rules/presets",
    owner({
      tags: ["setup"],
      summary: "Rule presets per kind of business",
      responses: json("Presets", R.listOf(R.looseSchema)),
    }),
    (c) => c.json({ items: caps.setup.listPresets(c.get("caller")) }),
  );
  app.post(
    "/rules/presets/:key",
    owner({
      tags: ["setup"],
      summary: "Apply a preset's rules",
      responses: json("Rules", R.listOf(R.ruleViewSchema)),
      write: true,
    }),
    validator("json", applyPresetInput.omit({ preset: true }), hook),
    async (c) => {
      const key = presetKeySchema.safeParse(c.req.param("key"));
      if (!key.success) return hook({ success: false, error: key.error }, c) as Response;
      const input = { ...c.req.valid("json"), preset: key.data };
      return once(c, "rules.preset", input, async (caller) => ({ items: await caps.setup.applyPreset(caller, input) }));
    },
  );
  app.post(
    "/rules/test",
    owner({
      tags: ["setup"],
      summary: "Evaluate a rule against an existing item without changing anything",
      responses: json("Test result", R.ruleTestSchema),
    }),
    validator("json", testRuleInput, hook),
    async (c) => c.json(await caps.setup.testRule(c.get("caller"), c.req.valid("json"))),
  );
  app.post(
    "/rules",
    owner({ tags: ["setup"], summary: "Add a rule", responses: json("Rule", R.ruleViewSchema, 201), write: true }),
    validator("json", ruleInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "rules.create", input, (caller) => caps.setup.createRule(caller, input), 201);
    },
  );
  app.patch(
    "/rules/:id",
    owner({
      tags: ["setup"],
      summary: "Change a rule (pass expected_version to avoid racing a colleague)",
      responses: json("Rule", R.ruleViewSchema),
      write: true,
    }),
    validator("json", updateRuleInput.omit({ rule_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), rule_id: String(c.req.param("id")) };
      return once(c, "rules.update", input, (caller) => caps.setup.updateRule(caller, input));
    },
  );
  app.delete(
    "/rules/:id",
    owner({ tags: ["setup"], summary: "Delete a rule", responses: json("Deleted", R.deletedSchema), write: true }),
    async (c) => {
      const input = { rule_id: String(c.req.param("id")) };
      return once(c, "rules.delete", input, (caller) => caps.setup.deleteRule(caller, input));
    },
  );
  // ---- integrations: where events go, and the cursor for everyone else -------------

  app.get(
    "/webhooks",
    owner({
      tags: ["integrations"],
      summary: "The endpoints events are sent to, each with a delivery summary. Never the secret.",
      responses: json("Webhooks", R.listOf(R.webhookViewSchema)),
    }),
    async (c) => c.json({ items: await caps.webhooks.listWebhooks(c.get("caller")) }),
  );
  app.post(
    "/webhooks",
    owner({
      tags: ["integrations"],
      summary: "Add an endpoint. The signing secret is in this response and in no other: store it now.",
      responses: json("Webhook and its secret", R.webhookWithSecretSchema, 201),
      write: true,
    }),
    validator("json", createWebhookInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      // `Location` names the new endpoint, which is what a webhook-trigger subscriber such as Power
      // Automate reads to unsubscribe later (DELETE on that path).
      return once(
        c,
        "webhooks.create",
        input,
        (caller) => caps.webhooks.createWebhook(caller, input),
        201,
        secret(["secret"]),
        (w) => ({ Location: `/v1/owner/webhooks/${w.id}` }),
      );
    },
  );
  app.patch(
    "/webhooks/:id",
    owner({
      tags: ["integrations"],
      summary: "Change an endpoint's URL, events, payload style or extra headers, or wake it after a failure run",
      responses: json("Webhook", R.webhookViewSchema),
      write: true,
    }),
    validator("json", updateWebhookInput.omit({ webhook_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), webhook_id: String(c.req.param("id")) };
      return once(c, "webhooks.update", input, (caller) => caps.webhooks.updateWebhook(caller, input));
    },
  );
  app.delete(
    "/webhooks/:id",
    owner({
      tags: ["integrations"],
      summary: "Remove an endpoint and its delivery log",
      responses: json("Deleted", R.deletedSchema),
      write: true,
    }),
    async (c) => {
      const input = { webhook_id: String(c.req.param("id")) };
      return once(c, "webhooks.delete", input, (caller) => caps.webhooks.deleteWebhook(caller, input));
    },
  );
  app.get(
    "/feeds",
    owner({
      tags: ["integrations"],
      summary: "The product feeds this inbox imports, with when each last ran and what went wrong",
      responses: json("Feeds", R.listOf(R.feedSchema)),
    }),
    async (c) => c.json({ items: await caps.feeds.list(c.get("caller")) }),
  );
  app.post(
    "/feeds",
    owner({
      tags: ["integrations"],
      summary: "Connect a product feed by URL. No credentials. The first import starts immediately.",
      description: "A feed sets prices, so the owner's AI cannot connect one (403, not_allowed).",
      responses: json("Feed", R.feedSchema, 201),
      write: true,
    }),
    validator("json", addFeedInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "feeds.add", input, (caller) => caps.feeds.add(caller, input), 201);
    },
  );
  app.get(
    "/feeds/:id",
    owner({ tags: ["integrations"], summary: "One feed", responses: json("Feed", R.feedSchema) }),
    async (c) => c.json(await caps.feeds.get(c.get("caller"), String(c.req.param("id")))),
  );
  app.post(
    "/feeds/:id/import",
    owner({
      tags: ["integrations"],
      summary: "Import now rather than waiting for the next scheduled run",
      responses: json("Queued", R.looseSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "feeds.import", { feed_id: id }, (caller) => caps.feeds.importNow(caller, id));
    },
  );
  app.delete(
    "/feeds/:id",
    owner({
      tags: ["integrations"],
      summary: "Disconnect a feed. Its products are deactivated, never deleted.",
      description: "A feed sets prices, so the owner's AI cannot disconnect one (403, not_allowed).",
      responses: json("Removed", R.looseSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "feeds.remove", { feed_id: id }, (caller) => caps.feeds.remove(caller, id));
    },
  );
  app.post(
    "/webhooks/:id/rotate-secret",
    owner({
      tags: ["integrations"],
      summary: "Mint a new signing secret, shown once. The old one keeps verifying for 24 hours.",
      responses: json("Webhook and its new secret", R.webhookWithSecretSchema),
      write: true,
    }),
    async (c) => {
      const input = { webhook_id: String(c.req.param("id")) };
      return once(
        c,
        "webhooks.rotate",
        input,
        (caller) => caps.webhooks.rotateWebhookSecret(caller, input),
        200,
        secret(["secret"]),
      );
    },
  );
  app.post(
    "/webhooks/:id/test",
    owner({
      tags: ["integrations"],
      summary:
        "Send a real, signed, clearly marked test delivery now, with the endpoint's extra headers, and report the HTTP status it got",
      responses: json("Test result", R.testEventResultSchema),
      write: true,
    }),
    async (c) => {
      const input = { webhook_id: String(c.req.param("id")) };
      return once(c, "webhooks.test", input, (caller) => caps.webhooks.sendTestEvent(caller, input));
    },
  );
  app.post(
    "/webhooks/:id/replay",
    owner({
      tags: ["integrations"],
      summary: "Re-queue every matching event since an instant that this endpoint never received",
      responses: json("Replay report", R.replayReportSchema),
      write: true,
    }),
    validator("json", replayMissingInput.omit({ webhook_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), webhook_id: String(c.req.param("id")) };
      return once(c, "webhooks.replay_missing", input, (caller) => caps.webhooks.replayMissing(caller, input));
    },
  );
  app.get(
    "/webhooks/:id/deliveries",
    owner({
      tags: ["integrations"],
      summary: "One endpoint's deliveries, newest first",
      responses: json("Deliveries", R.pageOf(R.deliveryViewSchema)),
    }),
    validator("query", listDeliveriesQuery.omit({ webhook_id: true }), hook),
    async (c) =>
      c.json(
        await caps.webhooks.listDeliveries(c.get("caller"), {
          ...c.req.valid("query"),
          webhook_id: String(c.req.param("id")),
        }),
      ),
  );
  app.get(
    "/deliveries",
    owner({
      tags: ["integrations"],
      summary: "Deliveries across every endpoint, newest first, keyset paginated",
      responses: json("Deliveries", R.pageOf(R.deliveryViewSchema)),
    }),
    validator("query", listDeliveriesQuery, hook),
    async (c) => c.json(await caps.webhooks.listDeliveries(c.get("caller"), c.req.valid("query"))),
  );
  app.post(
    "/deliveries/:id/replay",
    owner({
      tags: ["integrations"],
      summary: "Send one delivery again, on the row it already has",
      responses: json("Delivery", R.deliveryViewSchema),
      write: true,
    }),
    async (c) => {
      const input = deliveryIdInput.parse({ delivery_id: c.req.param("id") });
      return once(c, "deliveries.replay", input, (caller) => caps.webhooks.replayDelivery(caller, input));
    },
  );
  app.get(
    "/events",
    owner({
      tags: ["integrations"],
      summary:
        "The event stream, oldest first: every booking, order, quote and message event as the same thin event a webhook carries, with who caused it (data.actor), the door (data.channel) and whether it is a sandbox item. Pass the next_cursor of your last page as cursor. The stream trails live by a few seconds, which is what makes that cursor safe as a watermark. For anyone who cannot receive a webhook.",
      responses: json("Events and the next cursor", R.eventPageSchema),
    }),
    validator("query", listEventsQuery, hook),
    async (c) => c.json(await caps.webhooks.listEvents(c.get("caller"), c.req.valid("query"))),
  );

  // ---- keys: one named, scoped, revocable key per system that connects (ADR-004) ----------

  app.get(
    "/api-keys",
    owner({
      tags: ["keys"],
      summary:
        "The owner and integration keys, with their scopes, when each was last used, and every call each made outside its scopes; the AI apps' such calls too",
      responses: json("Keys", R.keyListSchema),
    }),
    async (c) => c.json(await caps.access.listKeys(c.get("caller"))),
  );
  app.post(
    "/api-keys",
    owner({
      tags: ["keys"],
      summary:
        "Create an integration key: named, scoped, revocable. The key is in this response and in no other: store it now.",
      description:
        "Give a preset (automation, shop_sync, calendar_sync, read_only) or scopes, or both. Only the owner in person creates keys: the owner's AI (over OAuth or the owner MCP) and integration keys get 403 not_allowed.",
      responses: json("The key, shown once", R.createdKeySchema, 201),
      write: true,
    }),
    validator("json", createApiKeyInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "keys.create", input, (caller) => caps.access.createKey(caller, input), 201, secret(["key"]));
    },
  );
  app.delete(
    "/api-keys/:id",
    owner({
      tags: ["keys"],
      summary: "Revoke a key, at once and for good",
      responses: json("Key", R.keyViewSchema),
      write: true,
    }),
    async (c) => {
      const input = { key_id: String(c.req.param("id")) };
      return once(c, "keys.revoke", input, (caller) => caps.access.revokeKey(caller, input));
    },
  );

  return app;
}
