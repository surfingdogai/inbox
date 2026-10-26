import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { type Caller, type Capabilities, stayInputs as I, WriteError, withIdempotencyKey } from "@surfingdog/core";
import type { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import { problemFrom } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * The stays doors (ADR-037 §6): the guest's assistant's tools on the public MCP and REST, and the
 * owner's on the owner MCP and REST. Generated from the same Zod schemas, so an agent gets the same
 * answer whichever door it takes. Every answer speaks as the property; nothing names another travel
 * service. Registered only on an inbox that is a place to stay.
 */

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;
const writes = { readOnlyHint: false, idempotentHint: true, destructiveHint: false } as const;

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

/** The terms to show the person before they are bound is the question to put to them, not a failure. */
const confirmOr = (error: unknown, nothing: string): CallToolResult => {
  if (error instanceof WriteError && (error.code === "confirm_terms" || error.code === "offer_changed")) {
    return ok(`${nothing} ${error.message}`, { confirm: error.details });
  }
  return failed(error);
};

async function run(fn: () => Promise<{ text: string; structured: unknown }>, nothing = ""): Promise<CallToolResult> {
  try {
    const r = await fn();
    return ok(r.text, r.structured);
  } catch (error) {
    return nothing ? confirmOr(error, nothing) : failed(error);
  }
}

/** Whether the inbox takes stays at all: the stays tools are registered only then. */
export async function takesStays(caps: Capabilities): Promise<boolean> {
  const setup = await caps.stays.setup({
    actor: { kind: "system", id: "doors", channel: "system" },
    tier: "verified_principal",
    sandbox: false,
  });
  return setup.properties.some((p) => p.active);
}

export const STAY_INSTRUCTIONS =
  "This is a place to stay. get_property gives its rooms, rates, policies and how it confirms; check_stay_availability gives what is free for dates and guests. A room marked instant comes with an offer: hold_stay holds it, and book_stay books it with the terms_sha your person confirmed. Other rooms are on request: request_stay sends the request, and the property answers with its own quote, which accept_offer takes with its terms_sha. Prices include every tax and fee. cancel_item on a confirmed stay answers with the fee first (fee_sha).";

export function registerPublicStayTools(server: McpServer, caps: Capabilities, caller: Caller): void {
  server.registerTool(
    "get_property",
    {
      title: "The place to stay",
      description:
        "Room types (capacity, beds, size, amenities, photos), rate plans (meal, refundable, how a stay is secured, the policy in words), extras, taxes and fees, check-in and check-out, children, pets, house rules, how to find it, how it confirms stays and how soon it answers.",
      inputSchema: I.getPropertyInput,
      annotations: readOnly,
    },
    (args) =>
      run(async () => {
        const p = await caps.stays.property(caller, args);
        return {
          text: `${p.name}: ${p.rooms.length} room type(s); check-in from ${p.check_in_from}, check-out by ${p.check_out_until}. ${p.confirmation}`,
          structured: p,
        };
      }),
  );
  server.registerTool(
    "check_stay_availability",
    {
      title: "What is free",
      description:
        "Free rooms and prices at this property for your dates and guests. Instant rooms come with an offer you can hold and book; others are on request and the property answers within the time it states. Prices include every tax and fee.",
      inputSchema: I.checkStayAvailabilityInput,
      annotations: readOnly,
    },
    (args) =>
      run(async () => {
        const a = await caps.stays.availability(caller, args);
        const free = a.options.filter((o) => o.status !== "unavailable").length;
        return { text: `${free} of ${a.options.length} option(s) for ${a.nights} night(s). ${a.words}`, structured: a };
      }),
  );
  server.registerTool(
    "quote_stay",
    {
      title: "Price a stay",
      description:
        "A firm offer for these rooms and dates when the property can confirm at once, else its estimate and how soon it answers. Send an offer_id you were given to learn whether its totals changed.",
      inputSchema: I.quoteStayInput,
      annotations: readOnly,
    },
    (args) =>
      run(async () => {
        const q = await caps.stays.quote(caller, args);
        return { text: q.offer ? `${q.offer.summary} ${q.words}` : q.words, structured: q };
      }),
  );
  server.registerTool(
    "request_stay",
    {
      title: "Request a stay",
      description:
        "Send a request for these dates, rooms and guests to the property, which answers with its own quote. Needs the guest's contact and their consent. Keep the access_token: it reads, accepts and cancels this stay later.",
      inputSchema: I.requestStayInput,
      annotations: writes,
    },
    (args) =>
      run(async () => {
        const r = await caps.stays.request(caller, args);
        return { text: `${r.words} Reference ${r.view.item.id.slice(-6).toUpperCase()}.`, structured: r };
      }),
  );
  server.registerTool(
    "hold_stay",
    {
      title: "Hold an instant room",
      description:
        "Hold an instant room from check_stay_availability or quote_stay (offer_id) for the property's hold time, at its offer. Then book_stay with the terms_sha your person confirmed. A room that is not instant is refused: send request_stay instead.",
      inputSchema: I.holdStayInput,
      annotations: writes,
    },
    (args) =>
      run(async () => {
        const r = await caps.stays.hold(caller, args);
        return { text: `${r.words}${r.summary ? ` ${r.summary}` : ""}`, structured: r };
      }),
  );
  server.registerTool(
    "book_stay",
    {
      title: "Book a held stay",
      description:
        "Book a stay you hold, once your person said yes to its terms: send the hold's terms_sha. Without it nothing is booked and you get the terms. Answers confirmed, or awaiting_payment with the link and its deadline (get_item_status, stay.payments).",
      inputSchema: I.bookStayInput,
      annotations: writes,
    },
    (args) =>
      run(async () => {
        const r = await caps.stays.book(caller, args);
        return { text: r.words, structured: r };
      }, "Nothing is booked yet."),
  );
  server.registerTool(
    "change_stay",
    {
      title: "Ask to change a stay",
      description:
        "Ask the property for other dates or rooms on a confirmed stay. Without terms_sha you get the new total and what it means to pay or get back; with it the request goes to the property, and the stay stays as it is until the property says yes.",
      inputSchema: I.changeStayInput,
      annotations: writes,
    },
    (args) =>
      run(async () => {
        const r = await caps.stays.change(caller, args);
        return { text: "Asked. The stay stays as it is until the property answers.", structured: r };
      }, "Nothing is asked yet."),
  );
}

type Guarded = (name: string, fn: () => Promise<{ text: string; structured: unknown }>) => Promise<CallToolResult>;

/** The owner's stays tools, each checked against its scopes by the owner door's `guarded`. */
export function registerOwnerStayTools(server: McpServer, caps: Capabilities, caller: Caller, guarded: Guarded): void {
  const tool = (
    name: string,
    title: string,
    description: string,
    schema: z.ZodObject,
    write: boolean,
    fn: (args: Record<string, unknown>, c: Caller) => Promise<{ text: string; structured: unknown }>,
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: schema, annotations: write ? writes : readOnly },
      (args) =>
        guarded(name, () =>
          fn(
            args as Record<string, unknown>,
            withIdempotencyKey(caller, (args as { idempotency_key?: string }).idempotency_key),
          ),
        ),
    );
  const done = (structured: unknown, text = "Saved.") => ({ text, structured });
  tool(
    "get_property_setup",
    "The place to stay",
    "The property with its rooms, rates, policies, taxes and fees, extras, rooms kept for direct guests, closed nights, mapped calendars and its sentence on how it confirms.",
    z.object({ property_id: z.string().optional() }),
    false,
    async (a, c) => {
      const s = await caps.stays.setup(c, a.property_id as string | undefined);
      return done(
        s,
        s.setup
          ? `${s.setup.property.name}: ${s.setup.rooms.length} room type(s), ${s.setup.plans.length} rate(s). ${s.setup.sentence}`
          : "No property yet.",
      );
    },
  );
  tool(
    "upsert_property",
    "Property",
    "Create or change the property. How it confirms (mode, instant), its registration and its system are the owner's alone, in the app.",
    I.upsertPropertyInput,
    true,
    async (a, c) => done(await caps.stays.upsertProperty(c, a)),
  );
  tool(
    "upsert_room_type",
    "Room type",
    "Create or change a room type: how many like it, who it sleeps, beds, size, amenities, photos.",
    I.upsertRoomTypeInput,
    true,
    async (a, c) => done(await caps.stays.upsertRoomType(c, a)),
  );
  tool(
    "archive_room_type",
    "Archive a room type",
    "Stop offering a room type; stays that had it keep it.",
    z.object({ id: z.string().min(1) }),
    true,
    async (a, c) => done(await caps.stays.archiveRoomType(c, a)),
  );
  tool(
    "upsert_rate_plan",
    "Rate plan",
    "Create or change a rate plan: name, meal, minimum stay. Its policy, deposit and card hold are the owner's alone, in the app; a rate you make waits for the owner to offer it.",
    I.upsertRatePlanInput,
    true,
    async (a, c) => done(await caps.stays.upsertRatePlan(c, a)),
  );
  tool(
    "set_rates",
    "Prices",
    "The price per night of a room type on a rate: the base, or a season (from_date, to_date), for some weekdays. Once rates are offered, prices are the owner's.",
    I.setRatesInput,
    true,
    async (a, c) => done(await caps.stays.setRates(c, a)),
  );
  tool(
    "set_stay_fees",
    "Taxes and fees",
    "Every tax and fee, all at once: guests always see the full price with these in it. Real tax rates are the property's own.",
    I.setStayFeesInput,
    true,
    async (a, c) => done(await caps.stays.setFees(c, a)),
  );
  tool(
    "upsert_stay_extra",
    "Extra",
    "An extra guests may add, from the on-property list only (breakfast, parking, cot, late check-out, pets…).",
    I.upsertStayExtraInput,
    true,
    async (a, c) => done(await caps.stays.upsertExtra(c, a)),
  );
  tool(
    "set_allotment",
    "Rooms kept for direct guests",
    "The owner's alone, in person: rooms kept for direct guests and closed on every other channel.",
    I.setAllotmentInput,
    true,
    async (a, c) => done(await caps.stays.setAllotment(c, a)),
  );
  tool(
    "close_nights",
    "Close nights",
    "Close nights for a room type or the whole property, or open them again (reopen).",
    I.closeNightsInput,
    true,
    async (a, c) => done(await caps.stays.closeNights(c, a)),
  );
  tool(
    "get_nights",
    "Nights",
    "Room types by days: stays, holds, rooms kept, another calendar's hints, closed nights.",
    I.nightsInput,
    false,
    async (a, c) => done(await caps.stays.nights(c, a), "The nights, room by room."),
  );
  tool(
    "draft_stay_quote",
    "Draft a quote",
    "A quote from the rates for a request, worked out and shown, never sent: send it with transition_item quote.",
    I.draftQuoteInput,
    false,
    async (a, c) => {
      const r = await caps.stays.draftQuote(c, a);
      return done(
        r,
        r.quote ? `Total ${r.quote.total.value} ${r.quote.currency} (minor units).` : `No quote: ${r.reason}`,
      );
    },
  );
  tool(
    "get_today",
    "Today",
    "Who arrives, who leaves and who is in, with what is still to pay at the property.",
    z.object({ property_id: z.string().optional(), date: z.iso.date().optional() }),
    false,
    async (a, c) => {
      const t = await caps.stays.today(c, a);
      return done(t, `${t.arriving.length} arriving, ${t.leaving.length} leaving, ${t.in_house.length} in house.`);
    },
  );
  tool(
    "map_calendar",
    "A calendar for a room",
    "A calendar link as the nights another channel took for one room type: hints only, never a confirmation.",
    z.object({
      connector_id: z.string().min(1),
      room_type_id: z.string().min(1).nullable(),
      units: z.int().min(1).max(500).default(1),
    }),
    true,
    async (a, c) => done(await caps.stays.mapCalendar(c, a)),
  );
  tool(
    "property_sync_now",
    "Read the system again",
    "Read the property's own system into the availability cache now.",
    z.object({ property_id: z.string().optional() }),
    true,
    async (a, c) => done(await caps.stays.syncNow(c, a), "Read again."),
  );
}

// ---- REST -------------------------------------------------------------------------

const withIdem = (c: { req: { header: (n: string) => string | undefined } }, body: Record<string, unknown>) => ({
  ...body,
  idempotency_key: (body.idempotency_key as string | undefined) ?? c.req.header("idempotency-key"),
});

const hookOf =
  (hook: (r: { success: boolean; error?: unknown }, c: never) => Response | undefined) =>
  (r: { success: boolean; error?: unknown }, c: unknown) =>
    hook(r, c as never);

const queryOf = (schema: z.ZodObject) =>
  z.preprocess((q) => {
    const o = { ...(q as Record<string, unknown>) };
    for (const k of ["adults", "rooms"]) if (typeof o[k] === "string") o[k] = Number(o[k]);
    if (typeof o.children_ages === "string")
      o.children_ages = o.children_ages ? String(o.children_ages).split(",").map(Number) : [];
    return o;
  }, schema);

/** The guest's REST doors for stays, mounted at /v1 beside the others. */
export function stayPublicRoutes(
  app: Hono<CallerEnv>,
  caps: Capabilities,
  hook: (r: { success: boolean; error?: unknown }, c: never) => Response | undefined,
): void {
  const h = hookOf(hook);
  const created = <T extends { replayed: boolean }>(
    c: { json: (b: unknown, s: 200 | 201, h?: Record<string, string>) => Response },
    r: T,
  ) => c.json(r, r.replayed ? 200 : 201, r.replayed ? { "Idempotent-Replayed": "true" } : {});
  app.get("/property", describeRoute({ tags: ["stays"], summary: "The place to stay" }), async (c) =>
    c.json(
      await caps.stays.property(c.get("caller"), { ...(c.req.query("id") ? { property_id: c.req.query("id") } : {}) }),
      200,
      {
        "Cache-Control": "public, max-age=60",
      },
    ),
  );
  app.get(
    "/stays/availability",
    describeRoute({ tags: ["stays"], summary: "What is free for dates and guests" }),
    validator("query", queryOf(I.checkStayAvailabilityInput), h),
    async (c) => c.json(await caps.stays.availability(c.get("caller"), c.req.valid("query"))),
  );
  app.post(
    "/stays/quotes",
    describeRoute({ tags: ["stays"], summary: "Price a stay: an offer when it confirms at once, else the estimate" }),
    validator("json", I.quoteStayInput, h),
    async (c) => c.json(await caps.stays.quote(c.get("caller"), c.req.valid("json"))),
  );
  app.post(
    "/stays",
    describeRoute({ tags: ["stays"], summary: "Request a stay" }),
    validator("json", I.requestStayInput, h),
    async (c) => created(c, await caps.stays.request(c.get("caller"), withIdem(c, c.req.valid("json")))),
  );
  app.post(
    "/stays/holds",
    describeRoute({ tags: ["stays"], summary: "Hold an instant room" }),
    validator("json", I.holdStayInput, h),
    async (c) => created(c, await caps.stays.hold(c.get("caller"), withIdem(c, c.req.valid("json")))),
  );
  app.post(
    "/stays/book",
    describeRoute({ tags: ["stays"], summary: "Book a held stay on the terms your person confirmed" }),
    validator("json", I.bookStayInput, h),
    async (c) => c.json(await caps.stays.book(c.get("caller"), withIdem(c, c.req.valid("json")))),
  );
  app.post(
    "/stays/:id/change",
    describeRoute({ tags: ["stays"], summary: "Ask to change a confirmed stay" }),
    validator("json", I.changeStayInput.omit({ item_id: true }), h),
    async (c) =>
      c.json(
        await caps.stays.change(c.get("caller"), withIdem(c, { ...c.req.valid("json"), item_id: c.req.param("id") })),
      ),
  );
}

/** The owner's REST doors for stays, below /v1/owner. */
export function stayOwnerRoutes(app: Hono<CallerEnv>, caps: Capabilities): void {
  const body = async (c: { req: { json: () => Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };
  const caller = (c: { get: (k: "caller") => Caller; req: { header: (n: string) => string | undefined } }) =>
    withIdempotencyKey(c.get("caller"), c.req.header("idempotency-key"));
  app.get("/property", async (c) => c.json(await caps.stays.setup(c.get("caller"), c.req.query("id"))));
  app.put("/property", async (c) => c.json(await caps.stays.upsertProperty(caller(c), await body(c))));
  app.post("/property/rooms", async (c) => c.json(await caps.stays.upsertRoomType(caller(c), await body(c))));
  app.delete("/property/rooms/:id", async (c) =>
    c.json(await caps.stays.archiveRoomType(caller(c), { id: c.req.param("id") })),
  );
  app.post("/property/rate-plans", async (c) => c.json(await caps.stays.upsertRatePlan(caller(c), await body(c))));
  app.put("/property/rates", async (c) => c.json(await caps.stays.setRates(caller(c), await body(c))));
  app.put("/property/fees", async (c) => c.json(await caps.stays.setFees(caller(c), await body(c))));
  app.post("/property/extras", async (c) => c.json(await caps.stays.upsertExtra(caller(c), await body(c))));
  app.put("/property/allotments", async (c) => c.json(await caps.stays.setAllotment(caller(c), await body(c))));
  app.put("/property/closures", async (c) => c.json(await caps.stays.closeNights(caller(c), await body(c))));
  app.put("/property/calendars", async (c) => c.json(await caps.stays.mapCalendar(caller(c), await body(c))));
  app.get("/property/nights", async (c) =>
    c.json(
      await caps.stays.nights(c.get("caller"), {
        ...(c.req.query("property_id") ? { property_id: c.req.query("property_id") } : {}),
        ...(c.req.query("from") ? { from: c.req.query("from") } : {}),
        ...(c.req.query("days") ? { days: Number(c.req.query("days")) } : {}),
      }),
    ),
  );
  app.get("/property/today", async (c) =>
    c.json(await caps.stays.today(c.get("caller"), { ...(c.req.query("date") ? { date: c.req.query("date") } : {}) })),
  );
  app.post("/property/sync", async (c) => c.json(await caps.stays.syncNow(caller(c), await body(c))));
  app.get("/property/system/:connectorId", async (c) =>
    c.json(await caps.stays.systemProperties(c.get("caller"), { connector_id: c.req.param("connectorId") })),
  );
  app.post("/property/system", async (c) => c.json(await caps.stays.mapSystem(caller(c), await body(c))));
  app.post("/stays/:id/draft-quote", async (c) =>
    c.json(
      await caps.stays.draftQuote(c.get("caller"), { ...((await body(c)) as object), item_id: c.req.param("id") }),
    ),
  );
}
