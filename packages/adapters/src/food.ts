import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type Caller,
  type Capabilities,
  confirmAllergensInput,
  getMenuInputSchema,
  importMenuInput,
  listOrderSlotsInputSchema,
  pauseInput,
  progressInput,
  setMenuItemInput,
  soldOutInput,
  tableRulesInput,
} from "@surfingdog/core";
import type { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { problemFrom } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * The food doors (ADR-036): `get_menu` and `list_order_slots` for a customer's agent (MCP and REST), and
 * the owner's menu, allergens, sold out today, tables, pause and progress. Generated from the same Zod
 * schemas on every door; what an agent is told speaks as the business.
 */

const ok = (text: string, structured: unknown): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured as Record<string, unknown>,
});

const failed = (error: unknown): CallToolResult => {
  const p = problemFrom(error);
  const fields = p.fields?.length ? ` Fix: ${p.fields.map((f) => `${f.path} (${f.problem})`).join(", ")}.` : "";
  return {
    content: [{ type: "text", text: `${p.title}: ${p.detail}${fields}` }],
    structuredContent: { error: p },
    isError: true,
  };
};

const nowOf = (caller: Caller) => (caller.now ? caller.now() : Date.now());

export const FOOD_INSTRUCTIONS = [
  "This business has a menu. get_menu lists it by section: each item's price, its options (option groups, min and max, what each choice adds, halves for half-and-half), its allergens with a status, dietary tags, an age limit, when it is served and whether it is sold out today.",
  "Allergens marked unconfirmed have not been checked by the business: tell your person to ask the business, never that a dish is free from anything; an order with such a dish waits for a person at the business.",
  "To order for a time, list_order_slots gives the slots of a day (and for delivery the zone, its fee and minimum); then create_order with payload.fulfil {method, slot.start}, each line's options [{groupId, choiceId, portion}] and a note, and a tip {percent} where get_business_profile's kitchen lists tips. Tables are bookings of the table service with partySize; a large party becomes a request for a price.",
].join(" ");

const sectionsText = (r: Awaited<ReturnType<Capabilities["food"]["getMenu"]>>) =>
  r.sections
    .map(
      (s) => `${s.name}: ${s.items.map((i) => `${i.name}${i.sold_out_today ? " (sold out today)" : ""}`).join(", ")}`,
    )
    .join(". ") || "Nothing on the menu now.";

export function registerPublicFoodTools(server: McpServer, caps: Capabilities, caller: Caller): void {
  server.registerTool(
    "get_menu",
    {
      title: "The menu",
      description:
        "The menu by section, with prices in minor units, options and what each adds, allergens with whether the business confirmed them (unconfirmed: ask the business), dietary tags, dayparts and today's sold-out items.",
      inputSchema: getMenuInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const r = await caps.food.getMenu(args, nowOf(caller));
        return ok(`${sectionsText(r)} ${r.words}`, r);
      } catch (error) {
        return failed(error);
      }
    },
  );
  server.registerTool(
    "list_order_slots",
    {
      title: "Slots to collect or have it delivered",
      description:
        "The slots of a day an order can still have (date, method pickup, delivery or dine_in), with places left, the earliest slot given the kitchen's time, and for delivery the zone the postal code or point falls in, its fee, minimum and time.",
      inputSchema: listOrderSlotsInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const r = await caps.food.listOrderSlots(args, nowOf(caller), caller.locale ?? "en");
        return ok(r.words, r);
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/** Whether the menu doors are offered: something is on the menu, or the kitchen takes orders for a time. */
export async function hasMenuDoors(caps: Capabilities): Promise<boolean> {
  return caps.food.offered();
}

export function foodPublicRoutes(app: Hono<CallerEnv>, caps: Capabilities, hook: never): void {
  app.get(
    "/menu",
    describeRoute({
      tags: ["public"],
      summary: "The menu, by section",
      description:
        "Prices in minor units, options and what each adds, allergens with their status (unconfirmed: ask the business), dietary tags, dayparts, sold out today.",
      responses: { 200: { description: "The menu" } },
    }),
    validator("query", getMenuInputSchema, hook),
    async (c) => {
      const caller = c.get("caller");
      return c.json(await caps.food.getMenu(c.req.valid("query"), nowOf(caller)), 200, { "Cache-Control": "no-store" });
    },
  );
  app.get(
    "/order-slots",
    describeRoute({
      tags: ["public"],
      summary: "Slots an order can have on a day",
      description: "date (YYYY-MM-DD), method; for delivery a postal_code with its country, or lat and lng.",
      responses: { 200: { description: "The slots" }, 422: { description: "Not a date, or not a method." } },
    }),
    validator(
      "query",
      z
        .object({
          date: z.iso.date(),
          method: z.enum(["pickup", "delivery", "dine_in"]).optional(),
          postal_code: z.string().min(1).max(20).optional(),
          country: z
            .string()
            .regex(/^[A-Za-z]{2}$/)
            .optional(),
          lat: z.coerce.number().min(-90).max(90).optional(),
          lng: z.coerce.number().min(-180).max(180).optional(),
        })
        .pipe(listOrderSlotsInputSchema),
      hook,
    ),
    async (c) => {
      const caller = c.get("caller");
      const lang = caller.locale ?? c.req.header("accept-language")?.slice(0, 2) ?? "en";
      return c.json(await caps.food.listOrderSlots(c.req.valid("query"), nowOf(caller), lang), 200, {
        "Cache-Control": "no-store",
      });
    },
  );
}

const NO_STORE = { "Cache-Control": "no-store" } as const;
const body = (description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(z.looseObject({})) } } },
});

export function foodOwnerRoutes(app: Hono<CallerEnv>, caps: Capabilities): void {
  app.get(
    "/menu",
    describeRoute({
      tags: ["owner"],
      summary: "Settings → Menu: every product, its place on the menu, and what a person confirms",
      security: [{ ownerKey: [] }],
      responses: body("The menu"),
    }),
    async (c) => c.json(await caps.food.ownerMenu(c.get("caller")), 200, NO_STORE),
  );
  app.put(
    "/menu/items/:id",
    describeRoute({
      tags: ["owner"],
      summary: "Put a product on the menu, change its place there, or take it off (menu: null)",
      description: "A person's, in the app. Allergens that changed are unconfirmed again.",
      security: [{ ownerKey: [] }],
      responses: body("The item"),
    }),
    validator("json", setMenuItemInput.omit({ product_id: true })),
    async (c) =>
      c.json(
        await caps.food.setMenuItem(c.get("caller"), { product_id: c.req.param("id") ?? "", ...c.req.valid("json") }),
        200,
        NO_STORE,
      ),
  );
  app.post(
    "/menu/items/:id/allergens/confirm",
    describeRoute({
      tags: ["owner"],
      summary: "Confirm an item's allergens, exactly as shown (their fingerprint)",
      description: "The owner or staff, signed in to the app: never their AI, never another system's key.",
      security: [{ ownerKey: [] }],
      responses: body("The item"),
    }),
    validator("json", confirmAllergensInput.omit({ product_id: true })),
    async (c) =>
      c.json(
        await caps.food.confirmAllergens(c.get("caller"), {
          product_id: c.req.param("id") ?? "",
          ...c.req.valid("json"),
        }),
        200,
        NO_STORE,
      ),
  );
  app.post(
    "/menu/items/:id/sold-out",
    describeRoute({
      tags: ["owner"],
      summary: "Sold out today, or back on sale",
      description: "Back on sale tomorrow by itself.",
      security: [{ ownerKey: [] }],
      responses: body("The item"),
    }),
    validator("json", soldOutInput.omit({ product_id: true })),
    async (c) =>
      c.json(
        await caps.food.setSoldOut(c.get("caller"), { product_id: c.req.param("id") ?? "", ...c.req.valid("json") }),
        200,
        NO_STORE,
      ),
  );
  app.post(
    "/menu/import",
    describeRoute({
      tags: ["owner"],
      summary: "Keep items from a connected tool's menu, read again from the tool",
      description: "A person's. Prices are the business's own, as its tool has them; allergens arrive unconfirmed.",
      security: [{ ownerKey: [] }],
      responses: body("How many were kept"),
    }),
    validator("json", importMenuInput),
    async (c) => c.json(await caps.food.importMenu(c.get("caller"), c.req.valid("json")), 200, NO_STORE),
  );
  app.put(
    "/services/:id/tables",
    describeRoute({
      tags: ["owner"],
      summary: "A service's tables: covers in people, the largest party, a deposit, covers set aside, a policy",
      security: [{ ownerKey: [] }],
      responses: body("The rules"),
    }),
    validator("json", tableRulesInput.omit({ service_id: true })),
    async (c) =>
      c.json(
        await caps.food.setTableRules(c.get("caller"), { service_id: c.req.param("id") ?? "", ...c.req.valid("json") }),
        200,
        NO_STORE,
      ),
  );
  app.get(
    "/kitchen",
    describeRoute({
      tags: ["owner"],
      summary: "Whether orders are taken now, and paused until when",
      security: [{ ownerKey: [] }],
      responses: body("The kitchen now"),
    }),
    async (c) => c.json(await caps.food.kitchenNow(c.get("caller")), 200, NO_STORE),
  );
  app.post(
    "/kitchen/pause",
    describeRoute({
      tags: ["owner"],
      summary: "Pause orders for 15, 30 or 60 minutes or the rest of the day, or resume",
      description: "Any person at the business. Agents are told when orders start again.",
      security: [{ ownerKey: [] }],
      responses: body("Paused until"),
    }),
    validator("json", pauseInput),
    async (c) => c.json(await caps.food.pause(c.get("caller"), c.req.valid("json")), 200, NO_STORE),
  );
  app.post(
    "/items/:id/progress",
    describeRoute({
      tags: ["owner"],
      summary: "An order's progress: preparing, ready, out for delivery",
      description: "Starts fulfilment first when the order is accepted or paid. The machine is unchanged.",
      security: [{ ownerKey: [] }],
      responses: body("The order"),
    }),
    validator("json", progressInput),
    async (c) =>
      c.json(await caps.food.setProgress(c.get("caller"), c.req.param("id") ?? "", c.req.valid("json")), 200, NO_STORE),
  );
  app.get(
    "/pos-orders",
    describeRoute({
      tags: ["owner"],
      summary: "Orders taken in your own ordering system, for your eyes only (no customer details)",
      security: [{ ownerKey: [] }],
      responses: body("Orders taken elsewhere"),
    }),
    async (c) => c.json(await caps.food.ordersElsewhere(c.get("caller")), 200, NO_STORE),
  );
}

/** The owner's AI and keys: progress and sold out, never allergens, prices or the kitchen's promises. */
export function registerOwnerFoodTools(
  server: McpServer,
  caps: Capabilities,
  caller: Caller,
  guarded: (name: string, fn: () => Promise<{ text: string; structured: unknown }>) => Promise<CallToolResult>,
): void {
  server.registerTool(
    "set_order_progress",
    {
      title: "Say how far an order is",
      description:
        "preparing, ready or out_for_delivery, with eta_at when you know it. Starts fulfilment of an accepted or paid order first. The customer's agent reads it on the order.",
      inputSchema: progressInput.extend({ item_id: z.string().min(1).max(64) }),
    },
    (args) =>
      guarded("set_order_progress", async () => {
        const { item_id, ...rest } = args;
        const item = await caps.food.setProgress(caller, item_id, rest);
        return { text: `The order is ${rest.stage.replaceAll("_", " ")}.`, structured: { item } };
      }),
  );
  server.registerTool(
    "set_sold_out",
    {
      title: "Sold out today",
      description: "Mark a menu item sold out today (back on sale tomorrow by itself), or back on sale now.",
      inputSchema: soldOutInput,
    },
    (args) =>
      guarded("set_sold_out", async () => {
        const r = await caps.food.setSoldOut(caller, args);
        return { text: `${r.product.name} is ${r.sold_out_today ? "sold out today" : "on sale"}.`, structured: r };
      }),
  );
}
