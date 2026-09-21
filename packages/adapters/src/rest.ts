import {
  type Caller,
  type Capabilities,
  cancelItemInput,
  checkAvailabilityInput,
  createBookingInput,
  createOrderInput,
  getItemInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  replyInput,
  requestQuoteInput,
  sendMessageInput,
  transitionItemInput,
  updateSettingsInput,
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

  return app;
}
