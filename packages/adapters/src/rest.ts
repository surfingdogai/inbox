import {
  acceptOfferInput,
  acknowledgeReceiptInput,
  addFeedInput,
  applyPresetInput,
  authorizeInput,
  CATALOGUE_ITEMS_MAX,
  CATALOGUE_PAGE_MAX,
  CATALOGUE_SIGNATURE_HEADER,
  type Caller,
  type Capabilities,
  type CatalogueResponse,
  cancelItemInput,
  checkAvailabilityInput,
  connectInput,
  createApiKeyInput,
  createBookingInput,
  createOrderInput,
  createWebhookInput,
  declineOfferInput,
  deliveryIdInput,
  detectMailProvider,
  eraseCustomerInput,
  eventPatternSchema,
  fromZod,
  getItemInput,
  letDomainThroughInput,
  listDeliveriesInput,
  listEventsInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  MAIL_PROVIDER_NAMES,
  makeBusinessOfferInput,
  makeOfferInput,
  type OnceOptions,
  offerDraftInput,
  openReturnInput,
  presetKeySchema,
  productInput,
  profileInput,
  provideDetailsInput,
  removeSpamListEntryInput,
  replayMissingInput,
  replyInput,
  requestQuoteInput,
  requestReturnInput,
  ruleInput,
  sendMessageInput,
  serviceInput,
  setClosuresInput,
  setFloorsInput,
  setSpamFilterInput,
  setSpamModelInput,
  setupPlanSchema,
  setWeeklyInput,
  spamModelsInput,
  splitAddress,
  startSpamFilterInput,
  suggestTimeInput,
  testRuleInput,
  transitionItemInput,
  updateConnectionInput,
  updateProductInput,
  updateRuleInput,
  updateServiceInput,
  updateSettingsInput,
  updateWebhookInput,
  verifyCustomerInput,
  withdrawInput,
  withIdempotencyKey,
} from "@surfingdog/core";
import { type Context, Hono } from "hono";
import { type DescribeRouteOptions, describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { ownerOperation, PHONE_OPERATIONS, routeScopes } from "./access";
import { lookupMx } from "./connectors/dns";
import { foodOwnerRoutes, foodPublicRoutes } from "./food";
import { publicOrigin } from "./origin";
import { forbidden, problemResponse, unauthorized } from "./problem";
import * as R from "./responses";
import { stayOwnerRoutes, stayPublicRoutes } from "./stays";
import { tradesOwnerRoutes, tradesPublicRoutes } from "./trades";

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
export const listProductsQuery = listProductsInput.extend({
  limit: limitQuery,
  ids: listQuery(z.string().min(1).max(64))
    .optional()
    .describe("Only these products, by id: `ids=a,b`, at most 50. Read the live price of what a network showed you."),
});
/** `GET /v1/catalogue/changes`: where to start, and how many. */
export const catalogueChangesQuery = z.object({
  after: z.string().min(1).max(200).optional().describe("The next_cursor of the page before; leave it out to start."),
  limit: z.coerce.number().int().min(1).max(CATALOGUE_PAGE_MAX).default(CATALOGUE_PAGE_MAX),
});
export const catalogueItemsQuery = z.object({
  ids: listQuery(z.string().min(1).max(64)).describe(`At most ${CATALOGUE_ITEMS_MAX} product ids: ids=a,b.`),
});
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

/** A catalogue page as the inbox's door answers it: signed, cached as it says, or a 304 or a 404. */
function catalogueAnswer(c: Context, r: CatalogueResponse): Response {
  if (r.status === 304) return new Response(null, { status: 304, headers: { ETag: r.etag } });
  if (r.status === 404) {
    return c.json(
      {
        type: "https://surfingdog.ai/problems/not_listed",
        title: "Not listed",
        status: 404,
        code: "not_listed",
        detail:
          r.why === "cannot_sign"
            ? "This inbox cannot sign its catalogue, so it lists no products on networks. Its own doors list them: GET /v1/products."
            : "This business does not list its products on networks now. Its own doors list them: GET /v1/products.",
      },
      404,
      { "Content-Type": "application/problem+json", "Cache-Control": "public, max-age=60" },
    );
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": r.cacheControl,
      ETag: r.etag,
      [CATALOGUE_SIGNATURE_HEADER]: r.signature,
    },
  });
}

export function publicRest(caps: Capabilities, opts: { readonly baseUrl?: string | undefined } = {}): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));
  /** Who is asking for a catalogue page, as its signature names it: this inbox's domain, and the address asked. */
  const catalogueRequest = (c: Context) => {
    const origin = publicOrigin(c.req.raw, opts.baseUrl);
    const asked = new URL(c.req.url);
    return {
      domain: new URL(origin).hostname,
      url: `${origin}${asked.pathname}${asked.search}`,
      now: Date.now(),
      ifNoneMatch: c.req.header("if-none-match"),
    };
  };

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
      responses: json("Products", R.pageOf(R.publicProductSchema)),
    }),
    validator("query", listProductsQuery, hook),
    async (c) => {
      return c.json(await caps.listProducts(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" });
    },
  );

  app.get(
    "/catalogue/changes",
    describeRoute({
      tags: ["public"],
      summary: "The business's products for networks, signed: what changed, page by page",
      description:
        "For a network that lists the business's products (protocol §4.18). Every product in the order it last changed, listed (its public fields, a barcode only when it is a product's barcode, availability as in stock, out of stock or on sale, never a count) or withdrawn. Pass next_cursor as after for the next page; at next_cursor null the reader has it all, and asks from the after of that last page next time. Signed in the Catalogue-Signature header: a compact JWS (typ sdi-catalogue+jws) by a key the manifest publishes under receipt_keys, over iss (this inbox's domain), url (the address asked), body_sha256, as_of and rev. 404 not_listed while the business keeps its products off networks.",
      responses: {
        200: {
          description: "One page, signed",
          headers: {
            [CATALOGUE_SIGNATURE_HEADER]: { description: "Compact JWS over the page", schema: { type: "string" } },
          },
        },
        304: { description: "The page the reader holds (If-None-Match)" },
        404: { description: "not_listed: the business lists no products on networks now" },
        422: { description: "A cursor this feed did not give, or a limit past 500" },
      },
    }),
    validator("query", catalogueChangesQuery, hook),
    async (c) => catalogueAnswer(c, await caps.catalogue.changes(c.req.valid("query"), catalogueRequest(c))),
  );

  app.get(
    "/catalogue/items",
    describeRoute({
      tags: ["public"],
      summary: "Products for networks by id, signed",
      description: `At most ${CATALOGUE_ITEMS_MAX} products by id, as the feed has them, and the ids this inbox has no product for (missing). Signed as GET /v1/catalogue/changes is; never cached.`,
      responses: {
        200: { description: "The products, signed" },
        404: { description: "not_listed: the business lists no products on networks now" },
      },
    }),
    validator("query", catalogueItemsQuery, hook),
    async (c) => catalogueAnswer(c, await caps.catalogue.items(c.req.valid("query").ids, catalogueRequest(c))),
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
        await caps.checkAvailability(c.req.valid("query"), { now: caller.now ? caller.now() : Date.now(), caller }),
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
        "For the customer (an access token, or a pass the item recognises): the item in the business's words and language, with offer (what the business proposed and waits for you to answer, and its terms_sha; kind change for a change it asks for to a confirmed booking or an accepted order), agreed, requested_change (a change your person asked for that the business has not answered), waiting_on, next, a six-character reference, and thread: the business's replies and the customer's messages, never its internal notes.",
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
        "confirm_terms (nothing was written: show your person details.summary and accept again with details.terms_sha), offer_changed (details.offer is the current proposal: the offer_id you named was replaced, or the terms changed), no_offer, slot_taken, or guard_failed not_too_soon.",
    },
    410: {
      description: "offer_expired: what the business proposed can no longer be accepted (its date to answer passed).",
    },
  };
  const PASSED_ON = {
    202: {
      description:
        "Kept as your person's message for a person at the business, who answers it: a price of their own, a suggestion past the last round, or a change to what was agreed that it takes in person (past the changes it may have, or once payment was asked for and it changes the total). Never refused; what the business proposed, or what was agreed, still stands (passed_on says so).",
      content: { "application/json": { schema: resolver(R.passedOnResultSchema) } },
    },
  };
  const ACCEPT_PASSED_ON = {
    202: {
      description:
        "A yes to a change the business asked for that can no longer be made online (payment was asked for since and it changes the total, or it cannot be recorded just now): kept as your person's message for a person at the business, who answers it. Never refused; what was agreed stands until then (passed_on says so).",
      content: { "application/json": { schema: resolver(R.passedOnResultSchema) } },
    },
  };
  /** A counter, or a suggestion kept for a person (202). */
  const answeredOrPassedOn = (c: Context<CallerEnv>, r: object) => c.json(r, "passed_on" in r ? 202 : 200);

  const ACCEPT = {
    tags: ["public"],
    summary:
      "Accept what the business proposed: another time, a quote, changes to an order, or a change to what was agreed",
    description:
      "Binds your customer, so it takes the confirm step (ADR-018 §5): send terms_sha, the offer.terms_sha from GET /items/{id} that your person said yes to. Without it nothing is written and the answer is 409 confirm_terms with the terms to show them. Name the offer (offer_id, or the path's) and an answer to one the business has since replaced does nothing. An accepted time confirms the booking; accepted changes accept the order on them; an accepted quote creates the booking (confirmed) or the order (accepted) it was for, in linked; an accepted change (offer.kind change) moves the confirmed booking or changes the accepted order.",
    responses: { ...json("Item", R.customerResultSchema), ...ACCEPT_PASSED_ON, ...ANSWER_ERRORS },
  };
  const DECLINE = {
    tags: ["public"],
    summary: "Decline what the business proposed",
    description:
      "A time or changes the business proposed: the booking request or the order is closed, as your customer chose. A quote: the request is closed. A change the business asks for to a confirmed booking or an accepted order: it stays as agreed. A change your customer asked for (requested_change): it is taken back. Send reason (and reason_code) for anything they want the business to know.",
    responses: { ...json("Item", R.customerResultSchema), ...ANSWER_ERRORS },
  };

  app.post("/items/:id/accept", describeRoute(ACCEPT), answer(acceptOfferInput), async (c) =>
    answeredOrPassedOn(c, await caps.customer.acceptOffer(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );
  app.post(
    "/items/:id/offers/:offer/accept",
    describeRoute({ ...ACCEPT, summary: "Accept this offer of the business's" }),
    answer(acceptOfferInput.omit({ offer_id: true })),
    async (c) =>
      answeredOrPassedOn(
        c,
        await caps.customer.acceptOffer(
          c.get("caller"),
          withItem(c, { ...c.req.valid("json"), offer_id: c.req.param("offer") }) as never,
        ),
      ),
  );

  app.post("/items/:id/decline", describeRoute(DECLINE), answer(declineOfferInput), async (c) =>
    c.json(await caps.customer.declineOffer(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );
  app.post(
    "/items/:id/offers/:offer/decline",
    describeRoute({ ...DECLINE, summary: "Decline this offer of the business's" }),
    answer(declineOfferInput.omit({ offer_id: true })),
    async (c) =>
      c.json(
        await caps.customer.declineOffer(
          c.get("caller"),
          withItem(c, { ...c.req.valid("json"), offer_id: c.req.param("offer") }) as never,
        ),
      ),
  );

  app.post(
    "/items/:id/offers",
    describeRoute({
      tags: ["public"],
      summary: "Answer what the business proposed with your own terms",
      description:
        "Only what your person would change (terms): another start_time for a booking or a quote (a free time GET /availability lists, for a booking), other quantities for the lines of changes the business suggested to an order (by index; 0 drops one), another delivery_when, or how many (quantity) for a quote request. It goes back to the business as their request (200). On a confirmed booking or an accepted order it asks for a change to what was agreed — another start_time (the end keeps the booking's length), other quantities of the order's lines (by index in orderedItem) or another delivery_when — which stands as agreed until the business says yes (requested_change). A price of their own (total_price, unit_price) is not taken as an answer while the business sets its prices (GET /v1/business price_negotiable: false): it goes to a person there as their message, as do a note alone and a suggestion past the last round (202, passed_on); never refused, and what the business proposed, or what was agreed, still stands.",
      responses: { ...json("Item", R.customerResultSchema), ...PASSED_ON, ...ANSWER_ERRORS },
    }),
    answer(makeOfferInput),
    async (c) =>
      answeredOrPassedOn(c, await caps.customer.makeOffer(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/items/:id/counter",
    describeRoute({
      tags: ["public"],
      summary: "Ask for another time than the one the business proposed",
      description:
        "start_time must be one of the free times GET /availability lists; the end follows the service's length. The booking goes back to the business to confirm, with nothing held. On a confirmed booking it asks to move it, and it stays as agreed until the business says yes. 409 slot_taken when that time is not free; 202 passed_on past the last round, when a person answers it. The same as POST /items/{id}/offers with terms.start_time.",
      responses: { ...json("Item", R.customerResultSchema), ...PASSED_ON, ...ANSWER_ERRORS },
    }),
    answer(suggestTimeInput),
    async (c) =>
      answeredOrPassedOn(
        c,
        await caps.customer.suggestTime(c.get("caller"), withItem(c, c.req.valid("json")) as never),
      ),
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
    "/items/:id/withdraw",
    describeRoute({
      tags: ["public"],
      summary: "Withdraw from contract here: your customer withdraws from their booking or order",
      description:
        "Two steps (CRD art. 11a). Without confirm_withdrawal nothing is sent: the answer is 409 confirm_withdrawal with details.statement — who, which contract, where the copy goes, until when — to show your person. Send it again with confirm_withdrawal: true once they confirm: a booking paid for, or an order before its goods went out, is cancelled and what was paid is refunded (200, the refund in linked); once the goods reached them, they come back and are refunded (200, the return in linked); the business emails an acknowledgement. Never refused: where the period has ended or what was bought is excepted, it becomes a return under the business's own policy once the goods reached them (200), else your person's message for a person there (202 passed_on, saying why). GET /v1/items/{id} says whether the right runs (withdrawal).",
      responses: {
        ...json("Item", R.customerResultSchema),
        ...PASSED_ON,
        403: ANSWER_ERRORS[403],
        409: {
          description:
            "confirm_withdrawal (nothing was sent: show your person details.statement and send confirm_withdrawal: true), or wrong_state (nothing is agreed yet: cancel instead).",
        },
      },
    }),
    answer(withdrawInput),
    async (c) =>
      answeredOrPassedOn(c, await caps.customer.withdraw(c.get("caller"), withItem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/items/:id/returns",
    describeRoute({
      tags: ["public"],
      summary: "Send goods back: ask the business for a return",
      description:
        "On an order whose goods reached your customer: reason faulty, not_as_described or wrong_item (the legal guarantee: sending it back costs them nothing), or changed_mind (a withdrawal while the period runs, agreed at once; after it, a return under the business's own policy, which it answers). lines names which, by index in orderedItem, and how many; all of them when left out. The return is in linked (201); the business answers within its respondHours, by email and on GET /v1/items/{id} (refunds). 409 wrong_state before the goods went out (cancel instead), or guard_failed when a return of the order is open already.",
      responses: {
        201: {
          description: "The return, in linked",
          content: { "application/json": { schema: resolver(R.customerResultSchema) } },
        },
        403: ANSWER_ERRORS[403],
        409: {
          description:
            "wrong_state: nothing was sent yet; guard_failed no_open_return: one is open already; guard_failed nothing_to_return: what it names came back and was refunded already.",
        },
      },
    }),
    answer(requestReturnInput),
    async (c) =>
      c.json(await caps.customer.requestReturn(c.get("caller"), withItem(c, c.req.valid("json")) as never), 201),
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

  // A place to stay (ADR-037 §6.1): what is free, a quote, a request, a hold, a booking, a change.
  stayPublicRoutes(app, caps, hook as never);
  // Trades (ADR-039): whether a site is inside the area, a request's files uploaded first, the business's links to them.
  tradesPublicRoutes(app, caps, hook as never);
  // A kitchen (ADR-040): the menu, and the slots an order can have.
  foodPublicRoutes(app, caps, hook as never);
  return app;
}

export function ownerRest(caps: Capabilities, opts: { readonly baseUrl?: string | undefined } = {}): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));
  // Who may come in at all (an owner-side principal), then whether this principal's scopes cover
  // this operation: one check, from one static map, before any handler runs (ADR-004).
  app.use("*", async (c, next) => {
    const caller = c.get("caller");
    if (caller.auth?.kind !== "owner") return unauthorized(c);
    const operation = ownerOperation(c);
    // A phone answers the inbox; everything else is the owner app's on a computer (ADR-028).
    if (caller.principal?.via === "device" && !(operation && PHONE_OPERATIONS.has(operation)))
      return forbidden(c, "This is done in the owner app on a computer, not from the phone.");
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

  // ---- the spam filter (ADR-029) ----------------------------------------------------------
  // What it is, and what the owner does with it. Switching a filter, letting something in and the lists
  // are a person's, signed in: the capability says "Only you can change this, signed in." to anyone else.

  app.get(
    "/spam",
    owner({
      tags: ["owner"],
      summary: "The spam filter: its filters, learning weeks, counts, lists and the AI check's room",
      responses: json("Spam filter", z.looseObject({})),
    }),
    async (c) => c.json(await caps.spamStatus(c.get("caller"))),
  );

  app.put(
    "/spam/filters/:filter",
    owner({
      tags: ["owner"],
      summary: "Switch a spam filter on or off, or choose what it does (a person in person only)",
      responses: json("Spam filter", z.looseObject({})),
      write: true,
    }),
    validator("json", setSpamFilterInput.omit({ filter: true }), hook),
    async (c) =>
      c.json(
        await caps.setSpamFilter(c.get("caller"), {
          ...c.req.valid("json"),
          filter: setSpamFilterInput.shape.filter.parse(c.req.param("filter")),
        }),
      ),
  );

  app.post(
    "/spam/filters/:filter/start",
    owner({
      tags: ["owner"],
      summary: "End a filter's learning week now (basic for the free protection)",
      responses: json("Spam filter", z.looseObject({})),
      write: true,
    }),
    async (c) =>
      c.json(
        await caps.startSpamFilterNow(c.get("caller"), startSpamFilterInput.parse({ filter: c.req.param("filter") })),
      ),
  );

  app.post(
    "/spam/lists/domains",
    owner({
      tags: ["owner"],
      summary: "Let everyone at a company's domain through",
      responses: json("Added", z.looseObject({})),
      write: true,
    }),
    validator("json", letDomainThroughInput, hook),
    async (c) => c.json(await caps.letDomainThrough(c.get("caller"), c.req.valid("json"))),
  );

  app.delete(
    "/spam/lists",
    owner({
      tags: ["owner"],
      summary: "Remove a row from Let through or Always put aside",
      responses: json("Removed", z.looseObject({})),
      write: true,
    }),
    validator("json", removeSpamListEntryInput, hook),
    async (c) => c.json(await caps.removeSpamListEntry(c.get("caller"), c.req.valid("json"))),
  );

  // ---- Your AI model, on one's own server (ADR-029 §11.5): the key is the owner's, pasted in person ----

  app.get(
    "/spam/model",
    owner({
      tags: ["owner"],
      summary: "Your AI model: what reads for the spam filters here, and whether you may bring your own",
      responses: json("Your AI model", z.looseObject({})),
    }),
    async (c) => c.json(await caps.spamModel(c.get("caller"))),
  );

  app.post(
    "/spam/model/models",
    owner({
      tags: ["owner"],
      summary: "The provider's own list of models for a key (the key is used for the call, not kept)",
      responses: json("Models", z.looseObject({})),
      write: true,
    }),
    validator("json", spamModelsInput, hook),
    async (c) => c.json(await caps.spamModels(c.get("caller"), c.req.valid("json"))),
  );

  app.put(
    "/spam/model",
    owner({
      tags: ["owner"],
      summary: "Keep your own AI model and its key, sealed (a person in person only)",
      responses: json("Your AI model", z.looseObject({})),
      write: true,
    }),
    validator("json", setSpamModelInput, hook),
    async (c) => c.json(await caps.setSpamModel(c.get("caller"), c.req.valid("json"))),
  );

  app.post(
    "/spam/model/test",
    owner({
      tags: ["owner"],
      summary: "Two samples through your model: a sales pitch spotted, a customer asking a price let through",
      responses: json("Test", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.testSpamModel(c.get("caller"))),
  );

  app.delete(
    "/spam/model",
    owner({
      tags: ["owner"],
      summary: "Remove your AI model and its key",
      responses: json("Your AI model", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.removeSpamModel(c.get("caller"))),
  );

  app.post(
    "/items/:id/let-in",
    owner({
      tags: ["owner"],
      summary: "Let in a request the spam filter holds: it goes on, and its sender comes straight in from now on",
      responses: json("Let in", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.letIn(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.post(
    "/items/:id/looks-fine",
    owner({
      tags: ["owner"],
      summary: "Take the spam filter's label off a request, and let its sender through",
      responses: json("Looks fine", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.looksFine(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.post(
    "/items/:id/spam",
    owner({
      tags: ["owner"],
      summary: "Spam, on a request the filter holds: from Held to Spam",
      responses: json("Spam", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.markHeldSpam(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.post(
    "/items/:id/always-put-aside",
    owner({
      tags: ["owner"],
      summary: "Always put aside what this request's sender sends",
      responses: json("Added", z.looseObject({})),
      write: true,
    }),
    async (c) => c.json(await caps.alwaysPutAside(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  /** A transition answers 200, or 202 when what automation offered was kept as a draft for the owner. */
  const movedOrDrafted = (c: Context<CallerEnv>, r: { drafted?: unknown }) => c.json(r, r.drafted ? 202 : 200);

  app.post(
    "/items/:id/transitions",
    owner({
      tags: ["owner"],
      summary: "Move an item to its next state",
      description:
        "An offer (propose, quote, propose_change) from your AI, a rule or a key without money:write that is outside the limits you set is not sent: it is kept as a draft for you (202, drafted) and the item is marked for a person. An acceptance outside them is refused (422 outside_limits, details.breaches).",
      responses: {
        ...json("Item", R.transitionResultSchema),
        202: {
          description: "Kept as a draft for the owner, outside the limits they set: nothing was sent.",
          content: { "application/json": { schema: resolver(R.transitionResultSchema) } },
        },
      },
      write: true,
    }),
    validator("json", transitionItemInput.omit({ item_id: true }), hook),
    async (c) =>
      movedOrDrafted(
        c,
        await caps.transitionItem(
          c.get("caller"),
          withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
        ),
      ),
  );

  app.post(
    "/items/:id/returns",
    owner({
      tags: ["owner"],
      summary: "Open a return a customer asked for by email or phone, on their fulfilled order",
      description:
        "reason as the customer gave it, and note: what they asked, in their words (kept for you); entry_id (their message on the order) or asked_at (when they rang) dates it, so it is judged as of when they asked. A faulty item is under the legal guarantee; a change of mind within the period is a withdrawal, agreed at once; anything else is a return you answer (approve; reject only once the period to withdraw had ended when they asked). The return is in linked.",
      responses: json("Item", R.transitionResultSchema, 201),
      write: true,
    }),
    validator("json", openReturnInput.omit({ item_id: true }), hook),
    async (c) =>
      c.json(
        await caps.openReturn(
          c.get("caller"),
          withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
        ),
        201,
      ),
  );

  app.get(
    "/items/:id/offers",
    owner({
      tags: ["owner"],
      summary: "Every offer of an item: the customer's request, what you proposed, each answer, what was agreed",
      responses: json("Offers", R.offerListSchema),
    }),
    async (c) => c.json(await caps.listOffers(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.get(
    "/items/:id/payments",
    owner({
      tags: ["owner"],
      summary: "An order's pay links in your own Stripe or Mollie account, newest first, and what each came to",
      description:
        "Where the customer pays (url, while it is open; never a closed link), its state (creating, open, paid, failed, closed, error), what was paid and how (payment_id, method), and dashboard_url: the payment in your own Stripe or Mollie dashboard, where it is refunded. `none` says why an order that could have a link has none. Nothing about the customer and never a key.",
      responses: json("Payments", R.itemPaymentsSchema),
    }),
    async (c) => c.json(await caps.connectors.itemPayments(c.get("caller"), String(c.req.param("id")))),
  );
  app.post(
    "/items/:id/payments/shop-total",
    owner({
      tags: ["owner"],
      summary: "Propose the shop's total: the order at what your own shop counts, with its tax or delivery",
      description:
        "For an order whose link is held (state held, shop_total on its payment): your shop counts its tax or delivery on top of what the customer accepted, so the link was not sent. This proposes the shop's total to the customer as a change they accept or not (propose_change, with one line for what the shop adds); once they accept, the link goes. The owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Item", R.transitionResultSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "payments.shop_total", { item_id: id }, (caller) => caps.connectors.proposeShopTotal(caller, id));
    },
  );

  app.post(
    "/items/:id/offers",
    owner({
      tags: ["owner"],
      summary: "Make your offer: another time for a booking, changes to an order, a quote, a change to what was agreed",
      description:
        "The event the item's state takes (propose for a booking or an order, quote for a quote request, propose_change for a confirmed booking or an accepted order) with input as transition_item takes it, and every check it makes. It replaces what you proposed before, or answers the customer's request or suggestion. Catalogue lines go at the customer's price (the list price, or your reward for them). From your AI, a rule or a key without money:write, an offer outside the limits you set is kept as a draft for you (202, drafted) and nothing is sent.",
      responses: {
        ...json("Item", R.transitionResultSchema),
        202: {
          description: "Kept as a draft for the owner, outside the limits they set: nothing was sent.",
          content: { "application/json": { schema: resolver(R.transitionResultSchema) } },
        },
      },
      write: true,
    }),
    validator("json", makeBusinessOfferInput.omit({ item_id: true }), hook),
    async (c) =>
      movedOrDrafted(
        c,
        await caps.makeOffer(
          c.get("caller"),
          withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
        ),
      ),
  );

  app.post(
    "/items/:id/offers/draft/send",
    owner({
      tags: ["owner"],
      summary: "Send the draft your AI, a rule or another system made outside your limits, as it is",
      description:
        "The owner in person only (signed in, or a full owner key; never the owner's MCP), so an AI cannot send its own drafts. draft_id pins the draft you read. It is the transition the draft would have made, made now by you. 409 draft_stale when the item moved since the draft was made: make your own offer instead, or drop it.",
      responses: json("Item", R.transitionResultSchema),
      write: true,
    }),
    validator("json", offerDraftInput.omit({ item_id: true }), hook),
    async (c) =>
      c.json(
        await caps.sendOfferDraft(
          c.get("caller"),
          withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
        ),
      ),
  );

  app.delete(
    "/items/:id/offers/draft",
    owner({
      tags: ["owner"],
      summary: "Drop the item's draft, unsent",
      description:
        "The owner in person only, as sending one is (signed in, or a full owner key; never the owner's MCP or another system's key): a draft is how the owner hears what automation would have offered. ?draft_id= drops only that one, so a newer draft is never dropped by mistake.",
      responses: json("Dropped", z.object({ dropped: z.boolean() })),
      write: true,
    }),
    async (c) =>
      c.json(
        await caps.dropOfferDraft(
          c.get("caller"),
          offerDraftInput.parse({
            item_id: c.req.param("id"),
            ...(c.req.query("draft_id") ? { draft_id: c.req.query("draft_id") } : {}),
          }),
        ),
      ),
  );

  app.post(
    "/items/:id/replies",
    owner({
      tags: ["owner"],
      summary: "Reply to the customer or add a note",
      description:
        "From your AI or a key without money:write, a reply that names an amount of money neither the item's terms nor the catalogue hold, or something off a price, is not sent: it is kept as an internal note and the item is marked for you (202, held).",
      responses: json("Item", R.looseSchema),
      write: true,
    }),
    validator("json", replyInput.omit({ item_id: true }), hook),
    async (c) => {
      const r = await caps.reply(
        c.get("caller"),
        withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never,
      );
      // A reply from your AI or a key without money:write naming money you have not offered: kept as a note (202).
      return c.json(r, "held" in r && r.held ? 202 : 200);
    },
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

  // ---- the email channel (ADR-026) -----------------------------------------------------------

  app.get(
    "/email",
    owner({
      tags: ["owner"],
      summary: "The email channel: this inbox's own address, the addresses forwarded to it, and who emails are from",
      description:
        "inbound: the inbox's own address (each conversation is one of its plus addresses); forwards: the business's existing addresses forwarded here, each with its state (setup, confirm: the provider sent a confirmation, shown as it came, working, not_yet) and the last check; sending: who customers' emails are from, and sending from the business's own address where the host offers it, with the DNS rows to add; replies: where customers' replies go; owner_replies: alerts can be answered by email.",
      responses: json("Email channel", R.looseSchema),
    }),
    async (c) => c.json(await caps.email.status(c.get("caller"))),
  );

  app.get(
    "/email/provider",
    owner({
      tags: ["owner"],
      summary: "Which mail provider an address most likely lives at, from its domain and MX records",
      responses: json("Provider", R.looseSchema),
    }),
    validator("query", z.object({ address: z.string().max(320) }), hook),
    async (c) => {
      const address = c.req.valid("query").address.trim();
      const domain = splitAddress(address)?.domain ?? "";
      const http = caps.connectors.dnsHttp();
      const mx = domain && http && /^[a-z0-9.-]{1,253}\.[a-z]{2,}$/.test(domain) ? await lookupMx(http, domain) : [];
      const provider = detectMailProvider(address, mx);
      return c.json({ provider, name: MAIL_PROVIDER_NAMES[provider] });
    },
  );

  app.post(
    "/email/forwards",
    owner({
      tags: ["owner"],
      summary: "Add an address the business forwards to this inbox (the owner in person)",
      responses: json("Forward", R.looseSchema),
      write: true,
    }),
    validator("json", z.object({ address: z.string().max(320), provider: z.string().max(40) }), hook),
    async (c) => c.json(await caps.email.addForward(c.get("caller"), c.req.valid("json")), 201),
  );

  app.delete(
    "/email/forwards/:id",
    owner({
      tags: ["owner"],
      summary: "Stop expecting mail forwarded from an address",
      responses: json("Removed", R.looseSchema),
      write: true,
    }),
    async (c) => c.json(await caps.email.removeForward(c.get("caller"), String(c.req.param("id")))),
  );

  app.post(
    "/email/forwards/:id/check",
    owner({
      tags: ["owner"],
      summary: "Send a check to the business's own address: it comes back here if the forward works",
      responses: json("Forward", R.looseSchema),
      write: true,
    }),
    async (c) => c.json(await caps.email.checkForward(c.get("caller"), String(c.req.param("id"))), 202),
  );

  app.post(
    "/email/forwards/:id/confirmed",
    owner({
      tags: ["owner"],
      summary: "The owner dealt with the provider's forwarding confirmation: stop showing it",
      responses: json("Forward", R.looseSchema),
      write: true,
    }),
    async (c) => c.json(await caps.email.dismissConfirmation(c.get("caller"), String(c.req.param("id")))),
  );

  app.put(
    "/email/sender",
    owner({
      tags: ["owner"],
      summary: "Send customers' emails from the business's own address, through the host (null: stop)",
      description:
        "Only where the host sends this inbox's mail and offers it, and only for an address that forwards here and passed its check. The answer has the DNS rows to add; email goes from the address once they check out.",
      responses: json("Sender", R.looseSchema),
      write: true,
    }),
    validator("json", z.object({ address: z.string().max(320).nullable() }), hook),
    async (c) => c.json(await caps.email.requestSender(c.get("caller"), c.req.valid("json").address)),
  );

  app.post(
    "/email/sender/check",
    owner({
      tags: ["owner"],
      summary: "Look at the business's DNS rows for sending again now",
      responses: json("Sender", R.looseSchema),
      write: true,
    }),
    async (c) => c.json(await caps.email.checkSender(c.get("caller"))),
  );

  app.get(
    "/items/:id/attachments",
    owner({
      tags: ["owner"],
      summary: "What came attached to the item's emails, and what became of each file",
      responses: json("Attachments", R.looseSchema),
    }),
    async (c) => c.json({ attachments: await caps.email.attachments(c.get("caller"), String(c.req.param("id"))) }),
  );

  app.delete(
    "/attachments/:id",
    owner({
      tags: ["owner"],
      summary:
        "Delete one kept file (a person at the business): its bytes go, and the conversation says it was removed",
      responses: json("Removed", R.looseSchema),
      write: true,
    }),
    async (c) => c.json(await caps.email.removeAttachment(c.get("caller"), String(c.req.param("id")))),
  );

  app.get(
    "/attachments/:id",
    owner({
      tags: ["owner"],
      summary: "One attached file, to download (never shown in the page)",
      responses: {
        200: {
          description: "The file, always as a download.",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    }),
    async (c) => {
      const a = await caps.email.attachment(c.get("caller"), String(c.req.param("id")));
      // Always a download, never rendered here: a customer's file is not this app's page.
      const name = a.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      return new Response(a.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "private, no-store",
        },
      });
    },
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

  app.post(
    "/receipt-keys/rotate",
    owner({
      tags: ["owner"],
      summary: "Make a new receipt key: the one that signed until now signs nothing more from this inbox",
      description:
        "For when a copy of the key may be in the wrong hands (a download with receipt-keys.json that you did not make). The key receipts were signed with until now is retired and a new one signs from now on; the old one stays published, so every receipt it signed still verifies. The owner in person only: refused (403 owner_in_person) to the owner's AI and to integration keys, whatever their scopes. 409 wrong_state when this inbox has no receipt key yet, or no INBOX_SECRET_KEY. Send an Idempotency-Key to make a retry safe; without one, each call makes another key.",
      responses: json(
        "The key that was retired, and the one that signs now",
        z.object({ retired: z.array(z.string()), active: z.string() }),
      ),
      write: true,
    }),
    async (c) => once(c, "receipts.replace_key", {}, (caller) => caps.replaceReceiptKey(caller)),
  );

  app.get(
    "/networks",
    owner({
      tags: ["owner"],
      summary: "The networks this inbox reports to, and how each one is doing",
      description:
        "Every network in settings, switched on or not: what it is sent, whether it has verified this instance, the last ping it took, the last error in a few words, and how many receipts it has. `held` is set while the inbox's host holds every network off (a hosted inbox before it is live at the business's own address): `on_when_released` says whether the network comes back on then. The owner can choose that now, with PUT /settings and `networks.<origin>.resume` (or `enabled`, which while held means the same); it takes effect when the hold ends. `reportable` says whether a network could verify this inbox at its address now (an https origin on a public host, port 443). Add, switch on or switch off a network with PUT /settings and `networks` keyed by origin; the owner's AI and integration keys may switch one off or share less with it (held or not), not switch one on, let it issue keys or share more. POST /receipt-keys/rotate makes a new receipt key.",
      responses: json("Networks", R.looseSchema),
    }),
    async (c) => c.json(await caps.getNetworks(c.get("caller"))),
  );

  app.get(
    "/discovery",
    owner({
      tags: ["owner"],
      summary: "The lines that lead AI agents from the business's own site to this inbox",
      description:
        "Where they go (the business's own domain: its website in Settings) and where they point (this inbox's own host), and the lines themselves: a <link rel=\"agent-inbox\">, schema.org structured data, a line for llms.txt, a _agent-inbox TXT record, and the manifest to serve at the site's own /.well-known/agent-inbox.json (ADR-024).",
      responses: json("Discovery", R.looseSchema),
    }),
    async (c) => c.json(await caps.getDiscovery(c.get("caller"))),
  );
  app.post(
    "/discovery/check",
    owner({
      tags: ["owner"],
      summary: "Ask Surfing Dog's checker whether the lines are in place",
      description:
        "One call to the network's GET /v1/discovery/{domain}, when asked and never on its own: whether the inbox's DNS record and manifest answer, whether robots.txt keeps out an AI assistant, and which of the five ways lead an agent from the domain to the inbox, each missing one with its exact fix.",
      responses: json("The check", R.looseSchema),
    }),
    async (c) => c.json(await caps.checkDiscovery(c.get("caller"))),
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
  app.post(
    "/products/:id/barcode",
    owner({
      tags: ["setup"],
      summary: "Use the barcode your AI proposed for a product",
      description:
        "The owner's one tap on a barcode their AI proposed (gtinGiven, ADR-029): it becomes the product's barcode. The owner in person only (403 not_allowed for the owner's AI and integration keys); 409 wrong_state when there is no proposed barcode.",
      responses: json("Product", R.productSchema),
      write: true,
    }),
    async (c) => {
      const input = { product_id: String(c.req.param("id")) };
      return once(c, "products.barcode", input, (caller) => caps.setup.confirmBarcode(caller, input));
    },
  );

  app.get(
    "/catalogue",
    owner({
      tags: ["setup"],
      summary: "Your products on networks: the switch, what is listed, and what needs a look",
      description:
        "ADR-029. listed: the switch (Settings: catalogue.listed), on unless you switch it off; blocked: why it cannot work now (out_of_directory, cannot_sign, no_network) or null. counts: products listed, needing a look, kept off networks, off sale. products: only those with something to say, each note in plain words, with action confirm_barcode where one tap fixes it. sku_offer: imported products whose own code reads as a barcode and that have none, while the one-time offer stands; it is made only when the business's imported codes look like barcodes taken together (at least three pass the check digit, and nine in ten do). networks: each network switched on, whether it wants the products, whether it was told, how many it lists and holds back, and when it last checked.",
      responses: json("Catalogue", R.catalogueStatusSchema),
    }),
    async (c) => c.json(await caps.catalogueStatus(c.get("caller"))),
  );
  app.post(
    "/catalogue/sku-barcodes",
    owner({
      tags: ["setup"],
      summary: "Use imported products' codes that look like barcodes as their barcodes, or not now",
      description:
        "The owner's answer to the one-time offer (ADR-029): use true gives each imported product whose own code reads as a barcode, and that has none, that barcode; use false says not now. Either way the offer is not made again. The owner in person only.",
      responses: json("How many products got a barcode", z.object({ used: z.number().int() })),
      write: true,
    }),
    validator("json", z.object({ use: z.boolean() }), hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "catalogue.sku_barcodes", input, (caller) => caps.useSkusAsBarcodes(caller, input));
    },
  );

  app.get(
    "/catalogue/floors",
    owner({
      tags: ["setup"],
      summary: "Your lowest prices: what your AI, rules and other systems may go down to",
      description:
        "The owner in person only (signed in, or a full owner key): never the owner's AI, never an integration key, never a public door. A floor is on the same basis as the price: a product's per unit, a service's per booking, or per person when it is priced per person.",
      responses: json("Floors", R.floorsSchema),
    }),
    async (c) => c.json(await caps.setup.listFloors(c.get("caller"))),
  );
  app.put(
    "/catalogue/floors",
    owner({
      tags: ["setup"],
      summary: "Set or clear lowest prices, for products and services",
      description:
        "The owner in person only. Each entry names a product or a service and its floor in minor units; floor_minor null clears it. Automation never offers or accepts a catalogue line below the higher of the floor and the customer's price less negotiation.ai.maxDiscountPct.",
      responses: json("Floors", R.floorsSchema),
      write: true,
    }),
    validator("json", setFloorsInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "catalogue.floors", input, (caller) => caps.setup.setFloors(caller, input));
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
    "/setup/plan",
    owner({
      tags: ["setup"],
      summary: "Apply a setup plan, or say in sentences what it would do",
      description:
        "A business's setup as read from its site and checked by its owner: profile, opening hours, closed days, services (matched by name), the rules for its kind of business, and its public profile, kept out of every directory. Each part is written only when it differs, so applying the same plan again changes nothing. With dry_run=true nothing is written and the answer says what applying would do. A price goes in only with price_confirmed; a plan never holds products, feeds or legal details. Applying is the owner's in person (signed in, or a full owner key): never the owner's AI, never an integration key.",
      responses: json("What it does", R.setupPlanResultSchema),
      write: true,
    }),
    validator(
      "query",
      z.object({ dry_run: boolQuery.default(false).describe("Say what applying would do, and write nothing.") }),
      hook,
    ),
    validator("json", setupPlanSchema, hook),
    async (c) => {
      const plan = c.req.valid("json");
      if (c.req.valid("query").dry_run) {
        return c.json(await caps.applySetupPlan(c.get("caller"), plan, { dryRun: true }));
      }
      return once(c, "setup.plan", plan, (caller) => caps.applySetupPlan(caller, plan));
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
  // ---- integrations: calendars and the platforms to come (ADR-014, ADR-022) ----
  app.get(
    "/integrations",
    owner({
      tags: ["integrations"],
      summary:
        "What can be connected (calendars, Cal.com, Stripe, Mollie; what is being built marked soon) and what is connected",
      description:
        "Groups (Calendars, Payments, Shops and checkouts) in the order this inbox sees them, then each card with its ways in: the form to fill in (secret fields marked), a sign-in on the platform (with what it asks first, before), or a link the inbox makes (auth: link). A payment platform's way names the webhook address and events (hook) for an owner who adds the webhook by hand. Only what this release can connect says ready; what is being built says soon; nothing else is listed. Connections never carry a secret; a link a connection serves is shown to the owner in person only.",
      responses: json("Integrations", R.integrationsSchema),
    }),
    async (c) => c.json(await caps.connectors.integrations(c.get("caller"))),
  );
  app.post(
    "/integrations",
    owner({
      tags: ["integrations"],
      summary:
        "Connect with a form: a calendar's email and app password, its private link, Cal.com's API key, a Stripe restricted key or a Mollie API key",
      description:
        "Checked against the platform before anything is kept: wrong credentials answer 422 with the field to fix. Secrets are sealed with INBOX_SECRET_KEY and never returned. The first sync starts at once. With `connection_id`, connects that connection again in place (a new app password or key for the same account): only the secret fields are needed, and every choice is kept. Connecting is the owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Connection", R.connectionSchema, 201),
      write: true,
    }),
    validator("json", connectInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      // The answer is kept for a retry, but no hash of a password or a key beside it.
      return once(
        c,
        "integrations.connect",
        caps.connectors.withoutSecrets(input),
        (caller) => caps.connectors.connect(caller, input),
        201,
      );
    },
  );
  app.post(
    "/integrations/authorize",
    owner({
      tags: ["integrations"],
      summary: "Start a sign-in on the platform (Google), or an approval on the owner's own store: the address to open",
      description:
        "OAuth 2.0 with PKCE and offline access, valid for ten minutes. `preset` names the way when a card has more than one; `input` holds what the way asks first (`before`: a store's address). The platform sends the owner back to /oauth/connect/{kind}/callback, which connects (or connects again, for the same account, keeping its choices) and returns to the owner app; a store that sends the key itself POSTs it to /v1/hooks/{kind}/authorized first. The owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Where to sign in", R.authorizeSchema),
      write: true,
    }),
    validator("json", authorizeInput, hook),
    async (c) =>
      c.json(
        await caps.connectors.authorize(c.get("caller"), c.req.valid("json"), publicOrigin(c.req.raw, opts.baseUrl)),
      ),
  );
  app.get(
    "/integrations/:id",
    owner({ tags: ["integrations"], summary: "One connection", responses: json("Connection", R.connectionSchema) }),
    async (c) => c.json(await caps.connectors.get(c.get("caller"), String(c.req.param("id")))),
  );
  app.patch(
    "/integrations/:id",
    owner({
      tags: ["integrations"],
      summary:
        "Choose calendars, where bookings go and which services busy times apply to; pay links on or off; pause or resume",
      description:
        "What is chosen changes which times customers are offered, or whether accepted orders get a link to pay, so it is the owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Connection", R.connectionSchema),
      write: true,
    }),
    validator("json", updateConnectionInput, hook),
    async (c) => {
      const id = String(c.req.param("id"));
      const input = c.req.valid("json");
      return once(c, "integrations.update", { id, ...input }, (caller) => caps.connectors.update(caller, id, input));
    },
  );
  app.post(
    "/integrations/:id/sync",
    owner({
      tags: ["integrations"],
      summary: "Read busy times and write bookings now, rather than at the next five-minute sync",
      responses: json("Queued", R.looseSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "integrations.sync", { id }, (caller) => caps.connectors.syncNow(caller, id));
    },
  );
  app.post(
    "/integrations/:id/link",
    owner({
      tags: ["integrations"],
      summary: "Make a new link for a connection that serves one: the old link stops at once",
      description:
        "For a calendar link to share (a connection with auth: link): whoever holds the old link can no longer read it. The owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Connection", R.connectionSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "integrations.link", { id }, (caller) => caps.connectors.rotateLink(caller, id));
    },
  );
  app.delete(
    "/integrations/:id",
    owner({
      tags: ["integrations"],
      summary:
        "Disconnect. Busy times stop blocking at once; bookings already written stay in the calendar. A payment platform makes no new link at once; its links waiting to be paid are switched off on the platform (links_closed now, links_closing still to go, by a job within two hours), and its key and webhook stay until then so a payment on one is still recorded.",
      description: "The owner's, in person: the owner's AI and an integration key are refused (403).",
      responses: json("Removed", R.looseSchema),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "integrations.remove", { id }, (caller) => caps.connectors.remove(caller, id));
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
    "/connected-apps/:id",
    owner({
      tags: ["keys"],
      summary: "Disconnect an AI app",
      description:
        "Every token the app holds is revoked at once; to work the inbox again it must be connected again, through the consent page. Only the owner in person disconnects an app: the owner's AI and integration keys get 403 not_allowed.",
      responses: json("How many tokens were revoked", z.object({ disconnected: z.number().int() })),
      write: true,
    }),
    async (c) => {
      const input = { app_id: String(c.req.param("id")) };
      return once(c, "apps.disconnect", input, (caller) => caps.access.disconnectApp(caller, input));
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

  // A place to stay's setup (ADR-037 §6.2).
  stayOwnerRoutes(app, caps);
  // Trades (ADR-039): a request's files and its job tool.
  tradesOwnerRoutes(app, caps);
  // A kitchen (ADR-040): the menu, allergens, sold out, tables, pause, progress, orders taken elsewhere.
  foodOwnerRoutes(app, caps);
  return app;
}
