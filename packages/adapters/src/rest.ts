import {
  applyPresetInput,
  type Caller,
  type Capabilities,
  cancelItemInput,
  checkAvailabilityInput,
  createBookingInput,
  createOrderInput,
  createWebhookInput,
  deliveryIdInput,
  getItemInput,
  listDeliveriesInput,
  listEventsInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  presetKeySchema,
  productInput,
  profileInput,
  replayMissingInput,
  replyInput,
  requestQuoteInput,
  ruleInput,
  sendMessageInput,
  serviceInput,
  setClosuresInput,
  setWeeklyInput,
  testRuleInput,
  transitionItemInput,
  updateProductInput,
  updateRuleInput,
  updateServiceInput,
  updateSettingsInput,
  updateWebhookInput,
} from "@surfingdog/core";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { problemResponse, unauthorized } from "./problem";

/**
 * The REST door. Same operations as MCP, described for OpenAPI from the same Zod schemas.
 * Public routes mount at /v1, owner routes at /v1/owner behind an owner API key.
 */
export type CallerEnv = { Variables: { caller: Caller & { auth: { kind: "owner" | "agent" } | null } } };

const json = (description: string, schema?: z.ZodType) => ({
  200: { description, ...(schema ? { content: { "application/json": { schema: resolver(schema) } } } : {}) },
  422: { description: "Invalid input: the problem document names the fields to fix." },
});

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

/** Query strings are strings; the schemas want booleans and numbers. */
function coerceQuery(q: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else if (/^\d+$/.test(v) && ["limit", "party_size", "expected_version"].includes(k)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

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
    describeRoute({ tags: ["public"], summary: "The business profile", responses: json("Profile") }),
    async (c) => {
      const profile = await caps.getBusinessProfile();
      return c.json(profile, 200, { "Cache-Control": "public, max-age=300" });
    },
  );

  app.get(
    "/services",
    describeRoute({ tags: ["public"], summary: "Services with duration and price model", responses: json("Services") }),
    validator("query", listServicesInput, hook),
    async (c) => {
      return c.json(await caps.listServices(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" });
    },
  );

  app.get(
    "/products",
    describeRoute({ tags: ["public"], summary: "Products", responses: json("Products") }),
    validator("query", listProductsInput, hook),
    async (c) => {
      return c.json(await caps.listProducts(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" });
    },
  );

  app.get(
    "/availability",
    describeRoute({ tags: ["public"], summary: "Free slots for a service", responses: json("Slots") }),
    validator(
      "query",
      z.object(checkAvailabilityInput.shape).extend({ party_size: z.coerce.number().int().min(1).optional() }),
      hook,
    ),
    async (c) => c.json(await caps.checkAvailability(c.req.valid("query"))),
  );

  app.post(
    "/quotes",
    describeRoute({ tags: ["public"], summary: "Request a quote", responses: json("Created") }),
    validator("json", requestQuoteInput, hook),
    async (c) => created(c, await caps.requestQuote(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/bookings",
    describeRoute({ tags: ["public"], summary: "Request a booking", responses: json("Created") }),
    validator("json", createBookingInput, hook),
    async (c) => created(c, await caps.createBooking(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.post(
    "/orders",
    describeRoute({ tags: ["public"], summary: "Place an order", responses: json("Created") }),
    validator("json", createOrderInput, hook),
    async (c) => created(c, await caps.createOrder(c.get("caller"), withIdem(c, c.req.valid("json")) as never)),
  );

  app.get(
    "/items/:id",
    describeRoute({ tags: ["public"], summary: "Status of your item", responses: json("Item") }),
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
    describeRoute({ tags: ["public"], summary: "Cancel your item", responses: json("Item") }),
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

  app.post(
    "/messages",
    describeRoute({ tags: ["public"], summary: "Send a message, or reply on your item", responses: json("Created") }),
    validator("json", sendMessageInput, hook),
    async (c) => {
      const r = await caps.sendMessage(c.get("caller"), withIdem(c, c.req.valid("json")) as never);
      return "replayed" in r ? created(c, r) : c.json(r, 200);
    },
  );

  app.post(
    "/items/:id/receipt-ack",
    describeRoute({
      tags: ["public"],
      summary: "Counter-sign a receipt (the next release)",
      responses: { 501: { description: "Not yet" } },
    }),
    (c) =>
      c.json(
        {
          type: "https://surfingdog.ai/problems/not_implemented",
          title: "Not implemented",
          status: 501,
          code: "not_implemented",
          detail: "Receipts arrive in the next release.",
        },
        501,
      ),
  );

  return app;
}

export function ownerRest(caps: Capabilities): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));
  app.use("*", async (c, next) => {
    if (c.get("caller").auth?.kind !== "owner") return unauthorized(c);
    await next();
  });

  app.get("/items", describeRoute({ tags: ["owner"], summary: "List items", responses: json("Items") }), async (c) => {
    const parsed = listItemsInput.safeParse(coerceQuery(c.req.query()));
    if (!parsed.success) return hook({ success: false, error: parsed.error }, c) as Response;
    return c.json(await caps.listItems(c.get("caller"), parsed.data));
  });

  app.get(
    "/items/:id",
    describeRoute({
      tags: ["owner"],
      summary: "One item with its events and conversation",
      responses: json("Item detail"),
    }),
    async (c) => c.json(await caps.getItem(c.get("caller"), getItemInput.parse({ item_id: c.req.param("id") }))),
  );

  app.post(
    "/items/:id/transitions",
    describeRoute({ tags: ["owner"], summary: "Move an item to its next state", responses: json("Item") }),
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
    describeRoute({ tags: ["owner"], summary: "Reply to the customer or add a note", responses: json("Item") }),
    validator("json", replyInput.omit({ item_id: true }), hook),
    async (c) =>
      c.json(
        await caps.reply(c.get("caller"), withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") }) as never),
      ),
  );

  app.get(
    "/settings",
    describeRoute({ tags: ["owner"], summary: "The settings document", responses: json("Settings") }),
    async (c) => c.json(await caps.getSettings(c.get("caller"))),
  );

  app.put(
    "/settings",
    describeRoute({ tags: ["owner"], summary: "Replace the settings document", responses: json("Settings") }),
    validator("json", updateSettingsInput, hook),
    async (c) => c.json(await caps.updateSettings(c.get("caller"), c.req.valid("json"))),
  );

  // ---- setup: profile, services, products, opening hours, rules ------------------

  app.get(
    "/profile",
    describeRoute({ tags: ["setup"], summary: "Business profile", responses: json("Profile") }),
    async (c) => c.json(await caps.setup.getProfile(c.get("caller"))),
  );
  app.put(
    "/profile",
    describeRoute({ tags: ["setup"], summary: "Update the business profile", responses: json("Profile") }),
    validator("json", profileInput, hook),
    async (c) => c.json(await caps.setup.updateProfile(c.get("caller"), c.req.valid("json"))),
  );

  app.get(
    "/services",
    describeRoute({ tags: ["setup"], summary: "All services, archived included", responses: json("Services") }),
    async (c) => c.json({ items: await caps.setup.listServices(c.get("caller")) }),
  );
  app.post(
    "/services",
    describeRoute({ tags: ["setup"], summary: "Add a bookable service", responses: json("Service") }),
    validator("json", serviceInput, hook),
    async (c) => c.json(await caps.setup.createService(c.get("caller"), c.req.valid("json")), 201),
  );
  app.patch(
    "/services/:id",
    describeRoute({ tags: ["setup"], summary: "Change a service", responses: json("Service") }),
    validator("json", updateServiceInput.omit({ service_id: true }), hook),
    async (c) =>
      c.json(
        await caps.setup.updateService(c.get("caller"), {
          ...c.req.valid("json"),
          service_id: String(c.req.param("id")),
        }),
      ),
  );
  app.delete(
    "/services/:id",
    describeRoute({ tags: ["setup"], summary: "Archive a service", responses: json("Service") }),
    async (c) => c.json(await caps.setup.archiveService(c.get("caller"), { service_id: String(c.req.param("id")) })),
  );

  app.get(
    "/products",
    describeRoute({ tags: ["setup"], summary: "All products, archived included", responses: json("Products") }),
    async (c) => c.json({ items: await caps.setup.listProducts(c.get("caller")) }),
  );
  app.post(
    "/products",
    describeRoute({ tags: ["setup"], summary: "Add a product", responses: json("Product") }),
    validator("json", productInput, hook),
    async (c) => c.json(await caps.setup.createProduct(c.get("caller"), c.req.valid("json")), 201),
  );
  app.patch(
    "/products/:id",
    describeRoute({ tags: ["setup"], summary: "Change a product", responses: json("Product") }),
    validator("json", updateProductInput.omit({ product_id: true }), hook),
    async (c) =>
      c.json(
        await caps.setup.updateProduct(c.get("caller"), {
          ...c.req.valid("json"),
          product_id: String(c.req.param("id")),
        }),
      ),
  );
  app.delete(
    "/products/:id",
    describeRoute({ tags: ["setup"], summary: "Archive a product", responses: json("Product") }),
    async (c) => c.json(await caps.setup.archiveProduct(c.get("caller"), { product_id: String(c.req.param("id")) })),
  );

  app.get(
    "/availability",
    describeRoute({
      tags: ["setup"],
      summary: "Opening hours, per-service overrides and closures",
      responses: json("Availability"),
    }),
    async (c) => c.json(await caps.setup.getAvailability(c.get("caller"))),
  );
  app.put(
    "/availability",
    describeRoute({
      tags: ["setup"],
      summary: "Set the weekly opening hours (business-wide or for one service)",
      responses: json("Availability"),
    }),
    validator("json", setWeeklyInput, hook),
    async (c) => c.json(await caps.setup.setWeekly(c.get("caller"), c.req.valid("json"))),
  );
  app.delete(
    "/availability/:serviceId",
    describeRoute({
      tags: ["setup"],
      summary: "Remove a service's own hours so it follows the business hours",
      responses: json("Availability"),
    }),
    async (c) =>
      c.json(await caps.setup.clearWeeklyOverride(c.get("caller"), { service_id: String(c.req.param("serviceId")) })),
  );
  app.put(
    "/availability/closures",
    describeRoute({ tags: ["setup"], summary: "Replace the list of closed days", responses: json("Availability") }),
    validator("json", setClosuresInput, hook),
    async (c) => c.json(await caps.setup.setClosures(c.get("caller"), c.req.valid("json"))),
  );

  app.get(
    "/rules",
    describeRoute({
      tags: ["setup"],
      summary: "The rules, highest priority first, each with a plain-English summary",
      responses: json("Rules"),
    }),
    async (c) => c.json({ items: await caps.setup.listRules(c.get("caller")) }),
  );
  app.get(
    "/rules/presets",
    describeRoute({ tags: ["setup"], summary: "Rule presets per kind of business", responses: json("Presets") }),
    (c) => c.json({ items: caps.setup.listPresets(c.get("caller")) }),
  );
  app.post(
    "/rules/presets/:key",
    describeRoute({ tags: ["setup"], summary: "Apply a preset's rules", responses: json("Rules") }),
    validator("json", applyPresetInput.omit({ preset: true }), hook),
    async (c) => {
      const key = presetKeySchema.safeParse(c.req.param("key"));
      if (!key.success) return hook({ success: false, error: key.error }, c) as Response;
      return c.json({
        items: await caps.setup.applyPreset(c.get("caller"), { ...c.req.valid("json"), preset: key.data }),
      });
    },
  );
  app.post(
    "/rules/test",
    describeRoute({
      tags: ["setup"],
      summary: "Evaluate a rule against an existing item without changing anything",
      responses: json("Test result"),
    }),
    validator("json", testRuleInput, hook),
    async (c) => c.json(await caps.setup.testRule(c.get("caller"), c.req.valid("json"))),
  );
  app.post(
    "/rules",
    describeRoute({ tags: ["setup"], summary: "Add a rule", responses: json("Rule") }),
    validator("json", ruleInput, hook),
    async (c) => c.json(await caps.setup.createRule(c.get("caller"), c.req.valid("json")), 201),
  );
  app.patch(
    "/rules/:id",
    describeRoute({
      tags: ["setup"],
      summary: "Change a rule (pass expected_version to avoid racing a colleague)",
      responses: json("Rule"),
    }),
    validator("json", updateRuleInput.omit({ rule_id: true }), hook),
    async (c) =>
      c.json(
        await caps.setup.updateRule(c.get("caller"), { ...c.req.valid("json"), rule_id: String(c.req.param("id")) }),
      ),
  );
  app.delete(
    "/rules/:id",
    describeRoute({ tags: ["setup"], summary: "Delete a rule", responses: json("Deleted") }),
    async (c) => c.json(await caps.setup.deleteRule(c.get("caller"), { rule_id: String(c.req.param("id")) })),
  );
  // ---- integrations: where events go, and the cursor for everyone else -------------

  app.get(
    "/webhooks",
    describeRoute({
      tags: ["integrations"],
      summary: "The endpoints events are sent to, each with a delivery summary. Never the secret.",
      responses: json("Webhooks"),
    }),
    async (c) => c.json({ items: await caps.webhooks.listWebhooks(c.get("caller")) }),
  );
  app.post(
    "/webhooks",
    describeRoute({
      tags: ["integrations"],
      summary: "Add an endpoint. The signing secret is in this response and in no other: store it now.",
      responses: json("Webhook and its secret"),
    }),
    validator("json", createWebhookInput, hook),
    async (c) => c.json(await caps.webhooks.createWebhook(c.get("caller"), c.req.valid("json")), 201),
  );
  app.patch(
    "/webhooks/:id",
    describeRoute({
      tags: ["integrations"],
      summary: "Change an endpoint's URL, events, payload style, or wake it after a failure run",
      responses: json("Webhook"),
    }),
    validator("json", updateWebhookInput.omit({ webhook_id: true }), hook),
    async (c) =>
      c.json(
        await caps.webhooks.updateWebhook(c.get("caller"), {
          ...c.req.valid("json"),
          webhook_id: String(c.req.param("id")),
        }),
      ),
  );
  app.delete(
    "/webhooks/:id",
    describeRoute({
      tags: ["integrations"],
      summary: "Remove an endpoint and its delivery log",
      responses: json("Deleted"),
    }),
    async (c) => c.json(await caps.webhooks.deleteWebhook(c.get("caller"), { webhook_id: String(c.req.param("id")) })),
  );
  app.post(
    "/webhooks/:id/rotate-secret",
    describeRoute({
      tags: ["integrations"],
      summary: "Mint a new signing secret, shown once. The old one keeps verifying for 24 hours.",
      responses: json("Webhook and its new secret"),
    }),
    async (c) =>
      c.json(await caps.webhooks.rotateWebhookSecret(c.get("caller"), { webhook_id: String(c.req.param("id")) })),
  );
  app.post(
    "/webhooks/:id/test",
    describeRoute({
      tags: ["integrations"],
      summary: "Send a real, signed, clearly marked test event now and report the HTTP status it got",
      responses: json("Test result"),
    }),
    async (c) => c.json(await caps.webhooks.sendTestEvent(c.get("caller"), { webhook_id: String(c.req.param("id")) })),
  );
  app.post(
    "/webhooks/:id/replay",
    describeRoute({
      tags: ["integrations"],
      summary: "Re-queue every matching event since an instant that this endpoint never received",
      responses: json("Replay report"),
    }),
    validator("json", replayMissingInput.omit({ webhook_id: true }), hook),
    async (c) =>
      c.json(
        await caps.webhooks.replayMissing(c.get("caller"), {
          ...c.req.valid("json"),
          webhook_id: String(c.req.param("id")),
        }),
      ),
  );
  app.get(
    "/webhooks/:id/deliveries",
    describeRoute({
      tags: ["integrations"],
      summary: "One endpoint's deliveries, newest first",
      responses: json("Deliveries"),
    }),
    async (c) => {
      const parsed = listDeliveriesInput.safeParse({
        ...coerceQuery(c.req.query()),
        webhook_id: String(c.req.param("id")),
      });
      if (!parsed.success) return hook({ success: false, error: parsed.error }, c) as Response;
      return c.json(await caps.webhooks.listDeliveries(c.get("caller"), parsed.data));
    },
  );
  app.get(
    "/deliveries",
    describeRoute({
      tags: ["integrations"],
      summary: "Deliveries across every endpoint, newest first, keyset paginated",
      responses: json("Deliveries"),
    }),
    async (c) => {
      const parsed = listDeliveriesInput.safeParse(coerceQuery(c.req.query()));
      if (!parsed.success) return hook({ success: false, error: parsed.error }, c) as Response;
      return c.json(await caps.webhooks.listDeliveries(c.get("caller"), parsed.data));
    },
  );
  app.post(
    "/deliveries/:id/replay",
    describeRoute({
      tags: ["integrations"],
      summary: "Send one delivery again, on the row it already has",
      responses: json("Delivery"),
    }),
    async (c) =>
      c.json(
        await caps.webhooks.replayDelivery(c.get("caller"), deliveryIdInput.parse({ delivery_id: c.req.param("id") })),
      ),
  );
  app.get(
    "/events",
    describeRoute({
      tags: ["integrations"],
      summary:
        "The event stream, oldest first: every booking, order, quote and message event as the same thin event a webhook carries. Pass the next_cursor of your last page as cursor. The stream trails live by a few seconds, which is what makes that cursor safe as a watermark. For anyone who cannot receive a webhook.",
      responses: json("Events and the next cursor"),
    }),
    async (c) => {
      const types = c.req.queries("types");
      const parsed = listEventsInput.safeParse({
        ...coerceQuery(c.req.query()),
        ...(types?.length ? { types: types.flatMap((t) => t.split(",")).filter(Boolean) } : {}),
      });
      if (!parsed.success) return hook({ success: false, error: parsed.error }, c) as Response;
      return c.json(await caps.webhooks.listEvents(c.get("caller"), parsed.data));
    },
  );

  return app;
}
