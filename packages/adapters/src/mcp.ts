import { type CallToolResult, createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import {
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
  customerSummary,
  deliveryIdInput,
  getItemInput,
  getItemStatusInput,
  type IdentityAnswer,
  listDeliveriesInput,
  listEventsInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  type OnceOptions,
  productIdInput,
  productInput,
  profileInput,
  replayMissingInput,
  replyInput,
  requestQuoteInput,
  revokeApiKeyInput,
  ruleIdInput,
  ruleInput,
  sendMessageInput,
  serviceIdInput,
  serviceInput,
  setClosuresInput,
  setWeeklyInput,
  testRuleInput,
  transitionItemInput,
  updateSettingsInput,
  updateWebhookInput,
  verifyCustomerInput,
  webhookIdInput,
  withIdempotencyKey,
} from "@surfingdog/core";
import { z } from "zod";
import { TOOL_SCOPES } from "./access";
import { problemFrom } from "./problem";

/**
 * The MCP doors: a public server any customer agent may use, and an owner server behind a key or
 * OAuth. Stateless per request (spec 2026-07-28); tools are generated from the same Zod schemas
 * as REST, so an agent gets identical answers whichever door it takes.
 */
export interface McpDeps {
  readonly caps: Capabilities;
  readonly version: string;
}

export const PUBLIC_INSTRUCTIONS = [
  "This is a business's typed inbox. Start with get_business_profile, then list_services or list_products.",
  "For a booking: check_availability, then create_booking with an idempotency_key you generate and keep.",
  "Keep the access_token in a create result: it is the only way to read (get_item_status) or cancel that item later.",
  "If you carry a pass for the person (sdpass1_…), send it in `pass` on every call, and keep any pass a result hands you (identity.passes). The person is writing to this business and may never have heard of passes: speak to them of the business. The guide: https://surfingdog.ai/for-agents.md.",
  "Every refusal names the exact fields to fix; repair the input and retry with the same idempotency_key.",
].join(" ");

export const OWNER_INSTRUCTIONS = [
  "You are working this business's inbox on the owner's behalf. list_items shows what needs a person; get_item shows the full story;",
  "transition_item moves an item with one of the events its view lists; reply speaks to the customer, or with internal=true leaves a note.",
  "Never invent facts about availability or prices: read them first.",
  "To connect another system to this inbox, create_webhook registers a URL that receives every event, signed; list_events is the same stream by polling, for anything that cannot receive one. Every event says who caused it (data.actor), so a sync can skip its own writes.",
  "A system that has to call this inbox gets its own key: create_api_key, named after the system and as narrow as it needs, once the owner has allowed it in Settings → Keys. Send an idempotency_key with every write, so a retry never does it twice.",
].join(" ");

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

async function run(fn: () => Promise<{ text: string; structured: unknown }>): Promise<CallToolResult> {
  try {
    const r = await fn();
    return ok(r.text, r.structured);
  } catch (error) {
    return failed(error);
  }
}

const humanOf = (r: { view: { human: string }; accessToken?: string | undefined; replayed?: boolean }) =>
  `${r.view.human}${r.accessToken ? ` Access token (keep it): ${r.accessToken}.` : ""}${r.replayed ? " (Same request as before; nothing new was created.)" : ""}`;

/**
 * The end of a create or status text (ADR-017 §8.4): many assistants read only a tool result's
 * text, so the pass to keep, and what to do on a weak match, are said in words there too. It is
 * said to the assistant: the person asked a business for something, and nothing here is theirs to
 * be told, except, when the network knows them, the code a business once emailed them.
 */
export function identityText(identity: IdentityAnswer | undefined, name: string | undefined): string {
  if (!identity) return "";
  const who = name?.trim() || "this person";
  const lines: string[] = [];
  for (const n of identity.networks) {
    if (n.state === "person_exists") {
      lines.push(
        `${hostOf(n.network)} already knows ${who}: if a business emailed them a code for their assistant (sdkey1_…), send it as key next time.`,
      );
    }
  }
  // The text ends with what to keep and what to do (ADR-017 §8.4).
  for (const p of identity.passes) {
    lines.push(`Keep this pass for ${who}: ${p.pass} (network ${hostOf(p.network)}).`);
  }
  if (identity.recognised === "weak") lines.push("Ask the person for the emailed code and call verify_customer.");
  return lines.length ? ` ${lines.join(" ")}` : "";
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function callerOf(ctx: { authInfo?: { extra?: Record<string, unknown> } | undefined }): Caller {
  const caller = ctx.authInfo?.extra?.caller as Caller | undefined;
  if (!caller) throw new Error("MCP handler called without a caller; mount it through mountDoors()");
  return caller;
}

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;
const writes = { readOnlyHint: false, idempotentHint: true, destructiveHint: false } as const;

export function createPublicMcpHandler({ caps, version }: McpDeps): McpHttpHandler {
  return createMcpHandler((ctx) => {
    const caller = callerOf(ctx);
    const server = new McpServer({ name: "surfingdog-inbox", version }, { instructions: PUBLIC_INSTRUCTIONS });

    server.registerTool(
      "get_business_profile",
      {
        title: "Business profile",
        description: "Name, time zone, currency, languages and the item types this business accepts.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        run(async () => {
          const p = await caps.getBusinessProfile();
          return {
            text: `${p.name} (${p.timezone}, ${p.currency}) accepts: ${p.item_types.join(", ")}.`,
            structured: p,
          };
        }),
    );
    server.registerTool(
      "list_services",
      {
        title: "Services",
        description: "Bookable services with duration and price model.",
        inputSchema: listServicesInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const page = await caps.listServices(args);
          return {
            text:
              page.items.map((s) => `${s.name} (${s.durationMin} min, id ${s.id})`).join("; ") || "No services yet.",
            structured: page,
          };
        }),
    );
    server.registerTool(
      "list_products",
      {
        title: "Products",
        description: "Orderable products with prices in minor units.",
        inputSchema: listProductsInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const page = await caps.listProducts(args);
          return {
            text:
              page.items.map((p) => `${p.name} ${p.price.value / 100} ${p.price.currency} (id ${p.id})`).join("; ") ||
              "No products yet.",
            structured: page,
          };
        }),
    );
    server.registerTool(
      "check_availability",
      {
        title: "Check availability",
        description: "Free start times for a service between two instants (at most 14 days).",
        inputSchema: checkAvailabilityInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const r = await caps.checkAvailability(args);
          return {
            text: r.slots.length
              ? `${r.slots.length} free slots for ${r.service.name}; first ${r.slots[0]?.startTime}.`
              : `No free slots for ${r.service.name} in that window.`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "request_quote",
      {
        title: "Request a quote",
        description: "Ask for a price on something custom. Creates a quote_request item.",
        inputSchema: requestQuoteInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.requestQuote(caller, args);
          return { text: `${humanOf(r)}${identityText(r.identity, args.contact?.name)}`, structured: r };
        }),
    );
    server.registerTool(
      "create_booking",
      {
        title: "Request a booking",
        description:
          "Request a service at a time. Check availability first. Returns the item and, if you have no account, an access_token.",
        inputSchema: createBookingInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.createBooking(caller, args);
          return { text: `${humanOf(r)}${identityText(r.identity, args.contact?.name)}`, structured: r };
        }),
    );
    server.registerTool(
      "create_order",
      {
        title: "Place an order",
        description: "Order products. Prices are in minor units.",
        inputSchema: createOrderInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.createOrder(caller, args);
          return { text: `${humanOf(r)}${identityText(r.identity, args.contact?.name)}`, structured: r };
        }),
    );
    server.registerTool(
      "get_item_status",
      {
        title: "Item status",
        description: "The current state of an item you created, and what you may do next.",
        inputSchema: getItemStatusInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const v = await caps.getItemStatus(caller, args);
          return { text: `${v.human}${identityText(v.identity, undefined)}`, structured: v };
        }),
    );
    server.registerTool(
      "cancel_item",
      {
        title: "Cancel",
        description:
          "Cancel an item you created. After the business's cancellation window, a confirmed booking is cancelled late where the business records late cancellations (it may count against the customer), and refused where it does not.",
        inputSchema: cancelItemInput,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      },
      (args) =>
        run(async () => {
          const r = await caps.cancelItem(caller, args);
          return { text: humanOf(r), structured: r };
        }),
    );
    server.registerTool(
      "send_message",
      {
        title: "Send a message",
        description: "Start a conversation, or reply on an item you own.",
        inputSchema: sendMessageInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.sendMessage(caller, args);
          return {
            text:
              "view" in r
                ? `${humanOf(r as { view: { human: string } })}${identityText((r as { identity?: IdentityAnswer }).identity, args.contact?.name)}`
                : (r as { human: string }).human,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "acknowledge_receipt",
      {
        title: "Acknowledge a receipt",
        description:
          "Counter-sign a receipt this item earned, so both sides hold it. Read the item to find its receipts; then send a compact JWS signed with your own Ed25519 key — header {alg:'EdDSA', typ:'sdi-receipt-ack+jws', jwk:<your public jwk>}, payload {rcp:<receipt id>, sha:<base64url(SHA-256(receipt jws))>, iat:<unix seconds>}. The instance verifies it against the key you carry and keeps it. Acknowledging twice is harmless.",
        inputSchema: acknowledgeReceiptInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.acknowledgeReceipt(caller, args);
          return {
            text: r.forwarded
              ? `Receipt ${r.id} (${r.kind}): your signed acknowledgement went to ${r.forwarded.length} network(s).`
              : `Receipt ${r.id} (${r.kind}) acknowledged at ${r.acknowledged_at}.`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "verify_customer",
      {
        title: "Prove a known customer",
        description:
          "When a result says identity.recognised is weak, the person gave the email of a customer the business knows. Call this with item_id and access_token to email them six digits; ask the person for the code and call it again with code. Then the business recognises them.",
        inputSchema: verifyCustomerInput,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      (args) =>
        run(async () => {
          const r = await caps.verifyCustomer(caller, args);
          return {
            text:
              "sent_to" in r
                ? `A code was emailed to ${r.sent_to}. Ask the person for it, then call verify_customer again with code.`
                : "Recognised: the business knows this customer now.",
            structured: r,
          };
        }),
    );
    return server;
  });
}

/** Every owner write takes one; the same key again returns the first answer instead of doing it twice. */
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Any string, new for each new request. Retrying with the same key returns the first answer instead of doing it twice; the same key through REST's Idempotency-Key header is the same request.",
  );
const keyed = <S extends z.ZodRawShape>(schema: z.ZodObject<S>) => schema.extend({ idempotency_key: idempotencyKey });

const again = (replayed: boolean) => (replayed ? " (Same request as before: nothing was done twice.)" : "");

export function createOwnerMcpHandler({ caps, version }: McpDeps): McpHttpHandler {
  return createMcpHandler((ctx) => {
    const caller = callerOf(ctx);
    const server = new McpServer({ name: "surfingdog-inbox-owner", version }, { instructions: OWNER_INSTRUCTIONS });

    /**
     * Every owner tool runs through here: the caller's scopes are checked against the tool's entry
     * in `TOOL_SCOPES` first (recorded, and refused when the owner enforces scopes), then the tool.
     */
    const guarded = (name: string, fn: () => Promise<{ text: string; structured: unknown }>) =>
      run(async () => {
        await caps.access.requireScope(caller, TOOL_SCOPES[name] ?? ["*"], `mcp:${name}`);
        return fn();
      });
    /** A setup write at most once per idempotency_key, under the same op name REST uses. */
    const once = <T>(
      key: string | undefined,
      op: string,
      input: unknown,
      fn: (c: Caller) => Promise<T>,
      opts?: OnceOptions,
    ) => {
      const c = withIdempotencyKey(caller, key);
      return caps.once(c, op, input, () => fn(c), opts);
    };
    const secret = (fields: readonly string[]): OnceOptions => ({ secret: { box: caps.secrets, fields } });

    server.registerTool(
      "list_items",
      {
        title: "List items",
        description:
          "Items in the inbox, newest first. Filter by type, state, needs_human, or search the conversation with q.",
        inputSchema: listItemsInput,
        annotations: readOnly,
      },
      (args) =>
        guarded("list_items", async () => {
          const page = await caps.listItems(caller, args);
          return {
            text: page.items.map((v) => `${v.item.id}: ${v.human}`).join("\n") || "Nothing needs you.",
            structured: page,
          };
        }),
    );
    server.registerTool(
      "get_item",
      {
        title: "Get item",
        description:
          "One item with its typed fields, event history (each event says who caused it — by — and through which door), conversation and the valid next transitions.",
        inputSchema: getItemInput,
        annotations: readOnly,
      },
      (args) =>
        guarded("get_item", async () => {
          const d = await caps.getItem(caller, args);
          // Who the customer is to the business and to each network that presented them (ADR-017 §8.2).
          const who = customerSummary(d.customer);
          return {
            text: `${d.human}${who ? ` Customer: ${who}` : ""} Next: ${d.transitions.map((t) => `${t.event} (${t.label})`).join(", ") || "nothing"}.`,
            structured: d,
          };
        }),
    );
    server.registerTool(
      "transition_item",
      {
        title: "Transition item",
        description:
          "Fire one of the events listed on the item (confirm, propose, decline, quote, …). Pass expected_version to avoid racing a colleague, and an idempotency_key so a retry does not fire it twice.",
        inputSchema: transitionItemInput,
        annotations: writes,
      },
      (args) =>
        guarded("transition_item", async () => {
          const r = await caps.transitionItem(caller, args);
          return { text: humanOf(r), structured: r };
        }),
    );
    // ---- setup: what the business is, offers, when it is open, what agents may do ----
    server.registerTool(
      "get_profile",
      {
        title: "Get business profile",
        description: "Name, domain, time zone, currency and languages of this business.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("get_profile", async () => {
          const p = await caps.setup.getProfile(caller);
          return {
            text: `${p.name || "(unnamed)"} · ${p.timezone} · ${p.currency} · ${p.languages.join(", ")}${p.domain ? ` · ${p.domain}` : ""}`,
            structured: p,
          };
        }),
    );
    server.registerTool(
      "update_profile",
      {
        title: "Update business profile",
        description:
          "Change the name, domain, time zone (IANA), currency or languages. Only the fields you pass change.",
        inputSchema: keyed(profileInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("update_profile", async () => {
          const r = await once(idempotency_key, "profile.update", input, (c) => caps.setup.updateProfile(c, input));
          return { text: `Profile updated.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "list_services",
      {
        title: "List services",
        description:
          "Every bookable service with duration, buffers, capacity, slot granularity and price, archived ones included.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_services", async () => {
          const items = await caps.setup.listServices(caller);
          return {
            text:
              items
                .map(
                  (s) =>
                    `${s.id}: ${s.name}, ${s.durationMin} min, capacity ${s.capacity}${s.active ? "" : " (archived)"}`,
                )
                .join("\n") || "No services yet.",
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "upsert_service",
      {
        title: "Add or change a service",
        description:
          "Without service_id: creates a service (name required; duration 60 min, capacity 1, slots every 15 min by default). With service_id: changes only the fields you pass. Send an idempotency_key so a retry does not create it twice.",
        inputSchema: serviceInput
          .partial()
          .extend({ service_id: z.string().optional(), idempotency_key: idempotencyKey }),
        annotations: writes,
      },
      (args) =>
        guarded("upsert_service", async () => {
          const { service_id, idempotency_key, ...rest } = args;
          if (service_id) {
            const input = { ...rest, service_id };
            const r = await once(idempotency_key, "services.update", input, (c) => caps.setup.updateService(c, input));
            return {
              text: `Updated service ${r.result.name} (${r.result.id}).${again(r.replayed)}`,
              structured: r.result,
            };
          }
          const input = serviceInput.parse(rest);
          const r = await once(idempotency_key, "services.create", input, (c) => caps.setup.createService(c, input));
          return {
            text: `Created service ${r.result.name} (${r.result.id}).${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "archive_service",
      {
        title: "Archive a service",
        description: "Hides a service from customers and agents; existing bookings keep it.",
        inputSchema: keyed(serviceIdInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("archive_service", async () => {
          const r = await once(idempotency_key, "services.archive", input, (c) => caps.setup.archiveService(c, input));
          return { text: `Service archived.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "list_products",
      {
        title: "List products",
        description: "Every product with price and stock, archived ones included.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_products", async () => {
          const items = await caps.setup.listProducts(caller);
          return {
            text:
              items
                .map(
                  (p) =>
                    `${p.id}: ${p.name} ${(p.price.value / 100).toFixed(2)} ${p.price.currency}${p.stock === null ? "" : `, stock ${p.stock}`}${p.active ? "" : " (archived)"}`,
                )
                .join("\n") || "No products yet.",
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "upsert_product",
      {
        title: "Add or change a product",
        description:
          "Without product_id: creates a product (name and price required, price in minor units). With product_id: changes only the fields you pass. Send an idempotency_key so a retry does not create it twice.",
        inputSchema: productInput
          .partial()
          .extend({ product_id: z.string().optional(), idempotency_key: idempotencyKey }),
        annotations: writes,
      },
      (args) =>
        guarded("upsert_product", async () => {
          const { product_id, idempotency_key, ...rest } = args;
          if (product_id) {
            const input = { ...rest, product_id };
            const r = await once(idempotency_key, "products.update", input, (c) => caps.setup.updateProduct(c, input));
            return {
              text: `Updated product ${r.result.name} (${r.result.id}).${again(r.replayed)}`,
              structured: r.result,
            };
          }
          const input = productInput.parse(rest);
          const r = await once(idempotency_key, "products.create", input, (c) => caps.setup.createProduct(c, input));
          return {
            text: `Created product ${r.result.name} (${r.result.id}).${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "archive_product",
      {
        title: "Archive a product",
        description: "Hides a product from customers and agents.",
        inputSchema: keyed(productIdInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("archive_product", async () => {
          const r = await once(idempotency_key, "products.archive", input, (c) => caps.setup.archiveProduct(c, input));
          return { text: `Product archived.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "get_availability",
      {
        title: "Get opening hours",
        description: "Weekly opening hours in the business time zone, per-service overrides and closed days.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("get_availability", async () => {
          const a = await caps.setup.getAvailability(caller);
          const days = Object.entries(a.weekly)
            .map(([d, w]) => `${d} ${(w ?? []).map(([o, c]) => `${o}-${c}`).join(", ") || "closed"}`)
            .join("; ");
          return {
            text: `${a.timezone}: ${days}${a.closures.length ? `. Closed: ${a.closures.map((c) => `${c.from}..${c.to}`).join(", ")}` : ""}`,
            structured: a,
          };
        }),
    );
    server.registerTool(
      "set_opening_hours",
      {
        title: "Set opening hours",
        description:
          'Replace the weekly opening hours, e.g. {"weekly": {"mon": [["09:00","18:00"]], "sat": [["09:00","13:00"]]}}. Days you leave out are closed. Pass service_id to override the hours for one service only.',
        inputSchema: keyed(setWeeklyInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("set_opening_hours", async () => {
          const r = await once(idempotency_key, "availability.weekly", input, (c) => caps.setup.setWeekly(c, input));
          return { text: `Opening hours saved.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "clear_service_hours",
      {
        title: "Clear a service's own hours",
        description: "Removes the per-service opening hours so the service follows the business hours again.",
        inputSchema: keyed(serviceIdInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("clear_service_hours", async () => {
          const r = await once(idempotency_key, "availability.clear", input, (c) =>
            caps.setup.clearWeeklyOverride(c, input),
          );
          return { text: `The service follows the business hours again.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "set_closures",
      {
        title: "Set closed days",
        description:
          "Replace the list of closed days (holidays, a closed week), as YYYY-MM-DD ranges in the business time zone. No bookings are offered on those days.",
        inputSchema: keyed(setClosuresInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("set_closures", async () => {
          const r = await once(idempotency_key, "availability.closures", input, (c) =>
            caps.setup.setClosures(c, input),
          );
          return { text: `Closed days saved.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "list_rules",
      {
        title: "List rules",
        description:
          "The automation rules, highest priority first, each with a plain-English summary of when it fires and what it does.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_rules", async () => {
          const items = await caps.setup.listRules(caller);
          return {
            text:
              items
                .map((r) => `${r.id} [${r.enabled ? "on" : "off"}, priority ${r.priority}] ${r.name}: ${r.summary}`)
                .join("\n") || "No rules yet. Try list_rule_presets.",
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "list_rule_presets",
      {
        title: "List rule presets",
        description:
          "Ready-made rule sets per kind of business (appointments, trades & quotes, shop), with what each rule does.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_rule_presets", async () => {
          const items = caps.setup.listPresets(caller);
          return {
            text: items
              .map((p) => `${p.key} (${p.name}):\n${p.rules.map((r) => `  - ${r.name}: ${r.summary}`).join("\n")}`)
              .join("\n"),
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "apply_rule_preset",
      {
        title: "Apply a rule preset",
        description: "Adds a preset's rules; replace=true removes the existing rules first.",
        inputSchema: keyed(applyPresetInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("apply_rule_preset", async () => {
          const r = await once(idempotency_key, "rules.preset", input, async (c) => ({
            items: await caps.setup.applyPreset(c, input),
          }));
          return { text: `${r.result.items.length} rules now active.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "upsert_rule",
      {
        title: "Add or change a rule",
        description:
          "A rule is JSON: on (triggers such as item.created, thread.inbound, item.transitioned:confirm), if (conditions: all/any/not, {path, op, value} over item.*, party.*, event.*, or fn slot_is_free / within_business_hours / party_verified / text_has_keywords), actions (transition, set_flags, reply, enqueue, stop). Without rule_id it creates; with rule_id it changes the fields you pass. Use test_rule first.",
        inputSchema: ruleInput.partial().extend({
          rule_id: z.string().optional(),
          expected_version: z.number().int().min(1).optional(),
          idempotency_key: idempotencyKey,
        }),
        annotations: writes,
      },
      (args) =>
        guarded("upsert_rule", async () => {
          const { rule_id, expected_version, idempotency_key, ...rest } = args;
          if (rule_id) {
            const input = { ...rest, rule_id, ...(expected_version !== undefined ? { expected_version } : {}) };
            const r = await once(idempotency_key, "rules.update", input, (c) => caps.setup.updateRule(c, input));
            return {
              text: `Updated rule ${r.result.name}: ${r.result.summary}${again(r.replayed)}`,
              structured: r.result,
            };
          }
          const input = ruleInput.parse(rest);
          const r = await once(idempotency_key, "rules.create", input, (c) => caps.setup.createRule(c, input));
          return {
            text: `Created rule ${r.result.name}: ${r.result.summary}${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "delete_rule",
      {
        title: "Delete a rule",
        description: "Removes a rule for good.",
        inputSchema: keyed(ruleIdInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("delete_rule", async () => {
          const r = await once(idempotency_key, "rules.delete", input, (c) => caps.setup.deleteRule(c, input));
          return { text: `Rule deleted.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "test_rule",
      {
        title: "Test a rule",
        description:
          "Evaluates a rule's conditions against an existing item and says whether it would fire and what it would do, and what it would hold back: a rule that reads a customer's record can only help them. Pass the rule's name to have it named. Changes nothing.",
        inputSchema: testRuleInput,
        annotations: readOnly,
      },
      (args) =>
        guarded("test_rule", async () => {
          const r = await caps.setup.testRule(caller, args);
          const held = r.skipped?.length ? ` ${r.skipped.map((l) => `${l}.`).join(" ")}` : "";
          return {
            text: r.matched
              ? `Would fire on ${r.item.type} ${r.item.id}: ${r.would.join(", then ") || "nothing"}.${held}`
              : `Would not fire on ${r.item.type} ${r.item.id} (${r.summary}).`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "reply",
      {
        title: "Reply",
        description: "Send a reply to the customer, or an internal note with internal=true.",
        inputSchema: replyInput,
        annotations: writes,
      },
      (args) =>
        guarded("reply", async () => {
          const r = await caps.reply(caller, args);
          return {
            text: "view" in r ? (r as { view: { human: string } }).view.human : (r as { human: string }).human,
            structured: r,
          };
        }),
    );
    // ---- integrations: where events go, and the cursor for everyone else ----
    server.registerTool(
      "list_webhooks",
      {
        title: "List webhook endpoints",
        description:
          "Every URL this inbox sends events to, with what it subscribes to, the names of its extra headers, whether it is active, how its deliveries are going, and its last error. The signing secret and the header values are never returned by this tool, or any other.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_webhooks", async () => {
          const items = await caps.webhooks.listWebhooks(caller);
          return {
            text:
              items
                .map(
                  (w) =>
                    `${w.id} ${w.url} [${w.active ? "active" : "inactive"}, ${w.payload_style}] events ${w.events.join(", ")}${w.headers.length ? `; headers ${w.headers.join(", ")}` : ""}; ${w.deliveries.delivered} delivered, ${w.deliveries.pending} pending, ${w.deliveries.failed} failed${w.last_error ? `; last error: ${w.last_error}` : ""}`,
                )
                .join("\n") || "No endpoints yet. create_webhook adds one.",
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "create_webhook",
      {
        title: "Add a webhook endpoint",
        description:
          'Registers an https URL. From then on this inbox POSTs every event you subscribe to — a booking requested or confirmed, an order paid, a quote sent, a message arriving — signed with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature), retried for a day if the URL is down, and replayable afterwards. Every event says who caused it (data.actor: kind, id, and the key or AI app\'s name) and through which door (data.channel), so a sync can skip its own writes. It works with Zapier, n8n, Make, a Slack bot or any server; there is nothing to register and no OAuth. For a receiver that checks a header instead of the signature (n8n, Make, Pipedream), pass headers, e.g. {"Authorization": "Bearer …"}: up to 5, sealed, never shown again. THE SIGNING SECRET IS IN THIS RESPONSE AND IN NO OTHER: show it to the person and tell them to store it now, because no tool can ever read it back — it can only be replaced with rotate_webhook_secret. payload_style thin (the default) sends only a pointer — item id, type, state, version, URL, actor, channel and sandbox; full also sends the customer\'s data to that address, so only choose it when the person understands that.',
        inputSchema: keyed(createWebhookInput),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      ({ idempotency_key, ...input }) =>
        guarded("create_webhook", async () => {
          const r = await once(
            idempotency_key,
            "webhooks.create",
            input,
            (c) => caps.webhooks.createWebhook(c, input),
            secret(["secret"]),
          );
          const w = r.result;
          return {
            text: w.secret
              ? `Endpoint ${w.id} created for ${w.url} (${w.events.join(", ")}, ${w.payload_style}). Signing secret, shown once and never again — store it now: ${w.secret}${again(r.replayed)}`
              : `Endpoint ${w.id} was created by an earlier call with this idempotency key; its secret was shown then. If it was lost, rotate_webhook_secret gives a new one.`,
            structured: w,
          };
        }),
    );
    server.registerTool(
      "update_webhook",
      {
        title: "Change a webhook endpoint",
        description:
          "Changes the URL, the events, the payload style or the extra headers (merged: a name with null removes it), or turns an endpoint off and on. An endpoint that failed for five days straight is deactivated automatically, never deleted; setting active=true after fixing the address clears the failure run, and replay_missing_webhook_deliveries then sends what it missed.",
        inputSchema: keyed(updateWebhookInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("update_webhook", async () => {
          const r = await once(idempotency_key, "webhooks.update", input, (c) => caps.webhooks.updateWebhook(c, input));
          const w = r.result;
          return {
            text: `Endpoint ${w.id} now ${w.active ? "active" : "inactive"} for ${w.url}.${again(r.replayed)}`,
            structured: w,
          };
        }),
    );
    server.registerTool(
      "rotate_webhook_secret",
      {
        title: "Rotate a webhook's signing secret",
        description:
          "Mints a new signing secret and returns it ONCE. The previous secret keeps verifying for 24 hours, so the receiver can be updated without dropping an event. Use this when a secret was lost or may have leaked. Only one previous secret is kept — rotating again before the 24 hours are up drops the secret the receiver still holds and every delivery starts failing verification, so update and redeploy the receiver between rotations.",
        inputSchema: keyed(webhookIdInput),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
      },
      ({ idempotency_key, ...input }) =>
        guarded("rotate_webhook_secret", async () => {
          const r = await once(
            idempotency_key,
            "webhooks.rotate",
            input,
            (c) => caps.webhooks.rotateWebhookSecret(c, input),
            secret(["secret"]),
          );
          const w = r.result;
          return {
            text: w.secret
              ? `New signing secret for ${w.id}, shown once — store it now: ${w.secret}. The old secret keeps working until ${w.previous_secret_until}.${again(r.replayed)}`
              : `The secret was rotated by an earlier call with this idempotency key and shown then.`,
            structured: w,
          };
        }),
    );
    server.registerTool(
      "delete_webhook",
      {
        title: "Remove a webhook endpoint",
        description:
          "Removes an endpoint and its delivery log for good. To pause one instead, update_webhook with active=false.",
        inputSchema: keyed(webhookIdInput),
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      },
      ({ idempotency_key, ...input }) =>
        guarded("delete_webhook", async () => {
          const r = await once(idempotency_key, "webhooks.delete", input, (c) => caps.webhooks.deleteWebhook(c, input));
          return { text: `Endpoint removed.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "send_test_event",
      {
        title: "Send a test delivery",
        description:
          "Delivers one real, signed, clearly marked test event to an endpoint right now, with the endpoint's extra headers, and reports the HTTP status it answered with. The quickest way to find out whether a URL, its header check and its signature verification actually work. Every call is another POST and another row in the delivery log, so it is not free to repeat.",
        inputSchema: keyed(webhookIdInput),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      ({ idempotency_key, ...input }) =>
        guarded("send_test_event", async () => {
          const res = await once(idempotency_key, "webhooks.test", input, (c) => caps.webhooks.sendTestEvent(c, input));
          const r = res.result;
          return {
            text: r.delivered
              ? `Delivered: HTTP ${r.status} in ${r.duration_ms} ms.${again(res.replayed)}`
              : `Not delivered: ${r.error}${r.status === null ? "" : ` (HTTP ${r.status})`} after ${r.duration_ms} ms.${again(res.replayed)}`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "list_webhook_deliveries",
      {
        title: "List webhook deliveries",
        description:
          "What was sent where, newest first: the event type, whether it was delivered, how many attempts it took, the last HTTP status and error, how long it took, and when the next attempt is due if it is still failing. Pass the next_cursor from the previous page to continue.",
        inputSchema: listDeliveriesInput,
        annotations: readOnly,
      },
      (args) =>
        guarded("list_webhook_deliveries", async () => {
          const page = await caps.webhooks.listDeliveries(caller, args);
          return {
            text:
              page.items
                .map(
                  (d) =>
                    `${d.id} ${d.event_type} → ${d.webhook_id}: ${d.status}, ${d.attempts} attempt(s)${d.last_status === null ? "" : `, HTTP ${d.last_status}`}${d.last_error ? `, ${d.last_error}` : ""}${d.next_attempt_at ? `, next ${d.next_attempt_at}` : ""}`,
                )
                .join("\n") || "No deliveries yet.",
            structured: page,
          };
        }),
    );
    server.registerTool(
      "replay_webhook_delivery",
      {
        title: "Replay one delivery",
        description:
          "Sends one delivery again on the row it already has, so the receiver sees the same webhook-id and can deduplicate. Use it after fixing the receiving end.",
        inputSchema: keyed(deliveryIdInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("replay_webhook_delivery", async () => {
          const r = await once(idempotency_key, "deliveries.replay", input, (c) =>
            caps.webhooks.replayDelivery(c, input),
          );
          return {
            text: `Delivery ${r.result.id} (${r.result.event_type}) queued to send again.${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "replay_missing_webhook_deliveries",
      {
        title: "Replay everything an endpoint missed",
        description:
          "Queues every event since an instant that this endpoint should have received and did not — the fix after a wrong URL, an outage, or an endpoint added after the fact. Already delivered events are left alone, so nothing arrives twice. One call scans at most 500 events; if the answer comes back truncated, call it again with the same `since` and `after` set to the `next_after` it gave you.",
        inputSchema: keyed(replayMissingInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("replay_missing_webhook_deliveries", async () => {
          const res = await once(idempotency_key, "webhooks.replay_missing", input, (c) =>
            caps.webhooks.replayMissing(c, input),
          );
          const r = res.result;
          return {
            text: `${r.queued} of ${r.matched} matching events queued for ${r.webhook_id}${r.truncated ? `; there were more — call it again with after=${r.next_after}` : ""}.${again(res.replayed)}`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "list_events",
      {
        title: "Read the event stream",
        description:
          "Every event this inbox has ever produced, oldest first, in the same shape a webhook carries: id, type (like booking.confirm, order.record_payment, message.create), timestamp, and data with the item's id, type, state, version and URL, who caused it (actor: kind, id and the key or AI app's name — skip events whose actor is your own key to avoid echo loops), the door it came through (channel) and whether it is a sandbox item. This is the polling alternative to a webhook, for anything that cannot receive one. Keep the next_cursor you get back and pass it as cursor next time to read only what is new; the order is stable and an event is never returned twice. The stream trails live by a few seconds, which is what makes the cursor safe to treat as a watermark. An empty page returns next_cursor null — keep the cursor you already have.",
        inputSchema: listEventsInput,
        annotations: readOnly,
      },
      (args) =>
        guarded("list_events", async () => {
          const page = await caps.webhooks.listEvents(caller, args);
          return {
            text:
              page.events
                .map(
                  (e) =>
                    `${e.id} ${e.type} ${e.timestamp} ${e.data.type} ${e.data.id} (${e.data.state}) by ${e.data.actor.kind}${e.data.actor.name ? ` "${e.data.actor.name}"` : ""}${e.data.channel ? ` via ${e.data.channel}` : ""}${e.data.sandbox ? " [sandbox]" : ""}`,
                )
                .join("\n") || "No events after that cursor.",
            structured: page,
          };
        }),
    );
    // ---- product feeds: a catalogue from a URL the shop already publishes ----
    server.registerTool(
      "list_feeds",
      {
        title: "List product feeds",
        description:
          "The product feeds this inbox imports (a Shopify, WooCommerce, Wix or Squarespace product feed, or any CSV or Google Merchant XML at a URL), each with how many products it holds, when it last ran and its last error.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_feeds", async () => {
          const items = await caps.feeds.list(caller);
          return {
            text:
              items
                .map(
                  (f) =>
                    `${f.id} ${f.name} ${f.url} [${f.status}] ${f.product_count} products${f.last_error ? `; last error: ${f.last_error}` : ""}`,
                )
                .join("\n") || "No feeds yet. add_feed connects one.",
            structured: { items },
          };
        }),
    );
    server.registerTool(
      "add_feed",
      {
        title: "Connect a product feed",
        description:
          "Connects a product feed by its URL — no password, no app to install — and starts the first import now; after that it refreshes on its own. Products that leave the feed are taken off sale, never deleted, unless deactivate_missing is false.",
        inputSchema: keyed(addFeedInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("add_feed", async () => {
          const r = await once(idempotency_key, "feeds.add", input, (c) => caps.feeds.add(c, input));
          return {
            text: `Feed ${r.result.id} (${r.result.name}) connected; the first import is running.${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "import_feed_now",
      {
        title: "Import a feed now",
        description: "Runs a feed's import now rather than waiting for the next scheduled run.",
        inputSchema: z.object({ feed_id: z.string().min(1), idempotency_key: idempotencyKey }),
        annotations: writes,
      },
      ({ idempotency_key, feed_id }) =>
        guarded("import_feed_now", async () => {
          const r = await once(idempotency_key, "feeds.import", { feed_id }, (c) => caps.feeds.importNow(c, feed_id));
          return { text: `Import of ${feed_id} queued.${again(r.replayed)}`, structured: r.result };
        }),
    );
    server.registerTool(
      "remove_feed",
      {
        title: "Disconnect a product feed",
        description: "Disconnects a feed. Its products are taken off sale, never deleted.",
        inputSchema: z.object({ feed_id: z.string().min(1), idempotency_key: idempotencyKey }),
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      },
      ({ idempotency_key, feed_id }) =>
        guarded("remove_feed", async () => {
          const r = await once(idempotency_key, "feeds.remove", { feed_id }, (c) => caps.feeds.remove(c, feed_id));
          return {
            text: `Feed disconnected; ${r.result.deactivated} products taken off sale, none deleted.${again(r.replayed)}`,
            structured: r.result,
          };
        }),
    );
    server.registerTool(
      "get_settings",
      {
        title: "Get settings",
        description:
          "The settings document and its version. Secrets are never returned: one that is set reads (redacted), and its path is listed in redacted. Writing the document back as read keeps it.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("get_settings", async () => {
          const s = await caps.getSettings(caller);
          return { text: `Settings version ${s.version}.`, structured: s };
        }),
    );
    server.registerTool(
      "get_networks",
      {
        title: "Networks and how they are doing",
        description:
          "The networks this inbox reports to, each with whether it is on, what it shares, whether it gives first-time customers a key (issue), whether it has verified this inbox, the last ping it took, the last error, the rules it applies, the business's own standing there (from the last signed ping) and how many receipts it has published. To add, switch on or switch off a network, use update_settings with networks keyed by origin.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("get_networks", async () => {
          const r = await caps.getNetworks(caller);
          return {
            text:
              r.networks
                .map(
                  (n) =>
                    `${n.origin}: ${n.enabled ? "on" : "off"}${n.enabled ? `, ${n.registration}` : ""}${n.last_ping_at ? `, last ping ${n.last_ping_at}` : ""}${n.failing_since ? `, not answering since ${n.failing_since}` : ""}${n.last_error ? `, last error: ${JSON.stringify(n.last_error)}` : ""}${n.enabled && n.issue ? ", gives first-time customers a key" : ""}${n.standing ? `; your standing: ${n.standing.tier}, score ${n.standing.score}${n.standing.ranked ? ", ranked" : ""} (as of ${n.standing.at})` : ""}; receipts ${n.receipts.published} published, ${n.receipts.queued} queued, ${n.receipts.refused} refused`,
                )
                .join("\n") || "No networks in settings.",
            structured: r,
          };
        }),
    );
    server.registerTool(
      "update_settings",
      {
        title: "Update settings",
        description:
          'Change settings. Send only the sections and keys you want to change: anything left out keeps its value, and null removes a key so its default applies again. Networks are a map keyed by https origin: {"networks": {"https://network.example.com": {"enabled": true}}} adds or switches on that one and leaves the others alone; {"enabled": false} switches it off. Send expected_version from get_settings so a concurrent change is refused rather than overwritten. The security section is the owner\'s alone and cannot be changed here.',
        inputSchema: keyed(updateSettingsInput),
        annotations: writes,
      },
      ({ idempotency_key, ...input }) =>
        guarded("update_settings", async () => {
          const r = await once(idempotency_key, "settings.update", input, (c) => caps.updateSettings(c, input));
          return { text: `Settings saved as version ${r.result.version}.${again(r.replayed)}`, structured: r.result };
        }),
    );
    // ---- keys: one named, scoped, revocable key per system the owner connects ----
    server.registerTool(
      "list_api_keys",
      {
        title: "List keys",
        description:
          "The owner's keys and the integration keys minted for other systems: name, scopes, when each was last used, whether it is active, and every call each made outside its scopes (and the AI apps' such calls). Never a key itself.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        guarded("list_api_keys", async () => {
          const r = await caps.access.listKeys(caller);
          return {
            text:
              r.items
                .map(
                  (k) =>
                    `${k.id} "${k.name}" ${k.hint} [${k.active ? "active" : "revoked or expired"}] ${k.scopes.join(" ")}${k.last_used_at ? `; last used ${k.last_used_at}` : "; never used"}${k.refusals.length ? `; ${k.refusals.reduce((n, x) => n + x.count, 0)} call(s) outside its scopes` : ""}`,
                )
                .join("\n") || "No keys yet.",
            structured: r,
          };
        }),
    );
    server.registerTool(
      "create_api_key",
      {
        title: "Create an integration key",
        description:
          'Mints a named, scoped, revocable key for one other system (Zapier, a shop, a till, a form plugin) to call this inbox with, as a Bearer token on /v1/owner or /mcp/owner. Only works once the owner has switched on "Let my AI create keys" in Settings → Keys; otherwise ask them to, or to create the key there. Use a preset (automation, shop_sync, calendar_sync, read_only) or the narrowest scopes that work; never settings:write. THE KEY IS IN THIS RESPONSE AND IN NO OTHER: give it to the person or paste it into the system now. Name it after the system, so the owner can revoke it later.',
        inputSchema: keyed(createApiKeyInput),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      ({ idempotency_key, ...input }) =>
        guarded("create_api_key", async () => {
          const r = await once(
            idempotency_key,
            "keys.create",
            input,
            (c) => caps.access.createKey(c, input),
            secret(["key"]),
          );
          const k = r.result;
          return {
            text: k.key
              ? `Key "${k.name}" (${k.id}) created with ${k.scopes.join(" ")}. Shown once and never again — store it now: ${k.key}${again(r.replayed)}`
              : `Key "${k.name}" (${k.id}) was created by an earlier call with this idempotency key and shown then. If it was lost, revoke it and create another.`,
            structured: k,
          };
        }),
    );
    server.registerTool(
      "revoke_api_key",
      {
        title: "Revoke an integration key",
        description:
          "Revokes an integration key at once and for good: the system using it stops getting in. Needs the owner's leave, like create_api_key, and works only on keys an AI made; the keys the owner made can only be revoked by the owner, in Settings → Keys.",
        inputSchema: keyed(revokeApiKeyInput),
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      },
      ({ idempotency_key, ...input }) =>
        guarded("revoke_api_key", async () => {
          const r = await once(idempotency_key, "keys.revoke", input, (c) => caps.access.revokeKey(c, input));
          return { text: `Key "${r.result.name}" revoked.${again(r.replayed)}`, structured: r.result };
        }),
    );
    return server;
  });
}
