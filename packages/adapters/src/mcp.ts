import { type CallToolResult, createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  acknowledgeReceiptInput,
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
  getItemStatusInput,
  listDeliveriesInput,
  listEventsInput,
  listItemsInput,
  listProductsInput,
  listServicesInput,
  productIdInput,
  productInput,
  profileInput,
  replayMissingInput,
  replyInput,
  requestQuoteInput,
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
  webhookIdInput,
} from "@surfingdog/core";
import { z } from "zod";
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
  "Every refusal names the exact fields to fix; repair the input and retry with the same idempotency_key.",
].join(" ");

export const OWNER_INSTRUCTIONS = [
  "You are working this business's inbox on the owner's behalf. list_items shows what needs a person; get_item shows the full story;",
  "transition_item moves an item with one of the events its view lists; reply speaks to the customer, or with internal=true leaves a note.",
  "Never invent facts about availability or prices: read them first.",
  "To connect another system to this inbox, create_webhook registers a URL that receives every event, signed; list_events is the same stream by polling, for anything that cannot receive one.",
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
          return { text: humanOf(r), structured: r };
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
          return { text: humanOf(r), structured: r };
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
          return { text: humanOf(r), structured: r };
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
          return { text: v.human, structured: v };
        }),
    );
    server.registerTool(
      "cancel_item",
      {
        title: "Cancel",
        description: "Cancel an item you created, within the business's cancellation window.",
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
            text: "view" in r ? humanOf(r as { view: { human: string } }) : (r as { human: string }).human,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "acknowledge_receipt",
      {
        title: "Acknowledge a receipt",
        description:
          "Counter-sign a receipt this item earned, so both sides hold it. Read the item to find its receipts; then send a compact JWS signed with your own Ed25519 key — header {alg:'EdDSA', typ:'sdi-receipt-ack+jws', jwk:<your public jwk>}, payload {rcp:<receipt id>, iat:<unix seconds>}. The instance verifies it against the key you carry and keeps it. Acknowledging twice is harmless.",
        inputSchema: acknowledgeReceiptInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.acknowledgeReceipt(caller, args);
          return {
            text: `Receipt ${r.id} (${r.kind}) acknowledged at ${r.acknowledged_at}.`,
            structured: r,
          };
        }),
    );
    return server;
  });
}

export function createOwnerMcpHandler({ caps, version }: McpDeps): McpHttpHandler {
  return createMcpHandler((ctx) => {
    const caller = callerOf(ctx);
    const server = new McpServer({ name: "surfingdog-inbox-owner", version }, { instructions: OWNER_INSTRUCTIONS });

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
        run(async () => {
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
        description: "One item with its typed fields, event history, conversation and the valid next transitions.",
        inputSchema: getItemInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const d = await caps.getItem(caller, args);
          return {
            text: `${d.human} Next: ${d.transitions.map((t) => `${t.event} (${t.label})`).join(", ") || "nothing"}.`,
            structured: d,
          };
        }),
    );
    server.registerTool(
      "transition_item",
      {
        title: "Transition item",
        description:
          "Fire one of the events listed on the item (confirm, propose, decline, quote, …). Pass expected_version to avoid racing a colleague.",
        inputSchema: transitionItemInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
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
        run(async () => {
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
        inputSchema: profileInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({ text: "Profile updated.", structured: await caps.setup.updateProfile(caller, args) })),
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
        run(async () => {
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
          "Without service_id: creates a service (name required; duration 60 min, capacity 1, slots every 15 min by default). With service_id: changes only the fields you pass.",
        inputSchema: serviceInput.partial().extend({ service_id: z.string().optional() }),
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const { service_id, ...rest } = args;
          const row = service_id
            ? await caps.setup.updateService(caller, { ...rest, service_id })
            : await caps.setup.createService(caller, serviceInput.parse(rest));
          return { text: `${service_id ? "Updated" : "Created"} service ${row.name} (${row.id}).`, structured: row };
        }),
    );
    server.registerTool(
      "archive_service",
      {
        title: "Archive a service",
        description: "Hides a service from customers and agents; existing bookings keep it.",
        inputSchema: serviceIdInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({ text: "Service archived.", structured: await caps.setup.archiveService(caller, args) })),
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
        run(async () => {
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
          "Without product_id: creates a product (name and price required, price in minor units). With product_id: changes only the fields you pass.",
        inputSchema: productInput.partial().extend({ product_id: z.string().optional() }),
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const { product_id, ...rest } = args;
          const row = product_id
            ? await caps.setup.updateProduct(caller, { ...rest, product_id })
            : await caps.setup.createProduct(caller, productInput.parse(rest));
          return { text: `${product_id ? "Updated" : "Created"} product ${row.name} (${row.id}).`, structured: row };
        }),
    );
    server.registerTool(
      "archive_product",
      {
        title: "Archive a product",
        description: "Hides a product from customers and agents.",
        inputSchema: productIdInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({ text: "Product archived.", structured: await caps.setup.archiveProduct(caller, args) })),
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
        run(async () => {
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
        inputSchema: setWeeklyInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({ text: "Opening hours saved.", structured: await caps.setup.setWeekly(caller, args) })),
    );
    server.registerTool(
      "clear_service_hours",
      {
        title: "Clear a service's own hours",
        description: "Removes the per-service opening hours so the service follows the business hours again.",
        inputSchema: serviceIdInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({
          text: "The service follows the business hours again.",
          structured: await caps.setup.clearWeeklyOverride(caller, args),
        })),
    );
    server.registerTool(
      "set_closures",
      {
        title: "Set closed days",
        description:
          "Replace the list of closed days (holidays, a closed week), as YYYY-MM-DD ranges in the business time zone. No bookings are offered on those days.",
        inputSchema: setClosuresInput,
        annotations: writes,
      },
      (args) =>
        run(async () => ({ text: "Closed days saved.", structured: await caps.setup.setClosures(caller, args) })),
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
        run(async () => {
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
        run(async () => {
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
        inputSchema: applyPresetInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const items = await caps.setup.applyPreset(caller, args);
          return { text: `${items.length} rules now active.`, structured: { items } };
        }),
    );
    server.registerTool(
      "upsert_rule",
      {
        title: "Add or change a rule",
        description:
          "A rule is JSON: on (triggers such as item.created, thread.inbound, item.transitioned:confirm), if (conditions: all/any/not, {path, op, value} over item.*, party.*, event.*, or fn slot_is_free / within_business_hours / party_verified / text_has_keywords), actions (transition, set_flags, reply, enqueue, stop). Without rule_id it creates; with rule_id it changes the fields you pass. Use test_rule first.",
        inputSchema: ruleInput
          .partial()
          .extend({ rule_id: z.string().optional(), expected_version: z.number().int().min(1).optional() }),
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const { rule_id, expected_version, ...rest } = args;
          const row = rule_id
            ? await caps.setup.updateRule(caller, {
                ...rest,
                rule_id,
                ...(expected_version !== undefined ? { expected_version } : {}),
              })
            : await caps.setup.createRule(caller, ruleInput.parse(rest));
          return { text: `${rule_id ? "Updated" : "Created"} rule ${row.name}: ${row.summary}`, structured: row };
        }),
    );
    server.registerTool(
      "delete_rule",
      {
        title: "Delete a rule",
        description: "Removes a rule for good.",
        inputSchema: ruleIdInput,
        annotations: writes,
      },
      (args) => run(async () => ({ text: "Rule deleted.", structured: await caps.setup.deleteRule(caller, args) })),
    );
    server.registerTool(
      "test_rule",
      {
        title: "Test a rule",
        description:
          "Evaluates a rule's conditions against an existing item and says whether it would fire and what it would do. Changes nothing.",
        inputSchema: testRuleInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const r = await caps.setup.testRule(caller, args);
          return {
            text: r.matched
              ? `Would fire on ${r.item.type} ${r.item.id}: ${r.would.join(", then ")}.`
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
        run(async () => {
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
          "Every URL this inbox sends events to, with what it subscribes to, whether it is active, how its deliveries are going, and its last error. The signing secret is never returned by this tool, or any other.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        run(async () => {
          const items = await caps.webhooks.listWebhooks(caller);
          return {
            text:
              items
                .map(
                  (w) =>
                    `${w.id} ${w.url} [${w.active ? "active" : "inactive"}, ${w.payload_style}] events ${w.events.join(", ")}; ${w.deliveries.delivered} delivered, ${w.deliveries.pending} pending, ${w.deliveries.failed} failed${w.last_error ? `; last error: ${w.last_error}` : ""}`,
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
          "Registers an https URL. From then on this inbox POSTs every event you subscribe to — a booking requested or confirmed, an order paid, a quote sent, a message arriving — signed with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature), retried for a day if the URL is down, and replayable afterwards. It works with Zapier, n8n, Make, a Slack bot or any server; there is nothing to register and no OAuth. THE SIGNING SECRET IS IN THIS RESPONSE AND IN NO OTHER: show it to the person and tell them to store it now, because no tool can ever read it back — it can only be replaced with rotate_webhook_secret. payload_style thin (the default) sends only a pointer — item id, type, state, version and URL; full also sends the customer's data to that address, so only choose it when the person understands that.",
        inputSchema: createWebhookInput,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      (args) =>
        run(async () => {
          const w = await caps.webhooks.createWebhook(caller, args);
          return {
            text: `Endpoint ${w.id} created for ${w.url} (${w.events.join(", ")}, ${w.payload_style}). Signing secret, shown once and never again — store it now: ${w.secret}`,
            structured: w,
          };
        }),
    );
    server.registerTool(
      "update_webhook",
      {
        title: "Change a webhook endpoint",
        description:
          "Changes the URL, the events, the payload style, or turns an endpoint off and on. An endpoint that failed for five days straight is deactivated automatically, never deleted; setting active=true after fixing the address clears the failure run, and replay_missing_webhook_deliveries then sends what it missed.",
        inputSchema: updateWebhookInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const w = await caps.webhooks.updateWebhook(caller, args);
          return { text: `Endpoint ${w.id} now ${w.active ? "active" : "inactive"} for ${w.url}.`, structured: w };
        }),
    );
    server.registerTool(
      "rotate_webhook_secret",
      {
        title: "Rotate a webhook's signing secret",
        description:
          "Mints a new signing secret and returns it ONCE. The previous secret keeps verifying for 24 hours, so the receiver can be updated without dropping an event. Use this when a secret was lost or may have leaked. Only one previous secret is kept — rotating again before the 24 hours are up drops the secret the receiver still holds and every delivery starts failing verification, so update and redeploy the receiver between rotations.",
        inputSchema: webhookIdInput,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
      },
      (args) =>
        run(async () => {
          const w = await caps.webhooks.rotateWebhookSecret(caller, args);
          return {
            text: `New signing secret for ${w.id}, shown once — store it now: ${w.secret}. The old secret keeps working until ${w.previous_secret_until}.`,
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
        inputSchema: webhookIdInput,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      },
      (args) =>
        run(async () => ({ text: "Endpoint removed.", structured: await caps.webhooks.deleteWebhook(caller, args) })),
    );
    server.registerTool(
      "send_test_event",
      {
        title: "Send a test event",
        description:
          "Delivers one real, signed, clearly marked test event to an endpoint right now and reports the HTTP status it answered with. The quickest way to find out whether a URL and its signature verification actually work. Every call is another POST and another row in the delivery log, so it is not free to repeat.",
        inputSchema: webhookIdInput,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
      },
      (args) =>
        run(async () => {
          const r = await caps.webhooks.sendTestEvent(caller, args);
          return {
            text: r.delivered
              ? `Delivered: HTTP ${r.status} in ${r.duration_ms} ms.`
              : `Not delivered: ${r.error}${r.status === null ? "" : ` (HTTP ${r.status})`} after ${r.duration_ms} ms.`,
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
        run(async () => {
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
        inputSchema: deliveryIdInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const d = await caps.webhooks.replayDelivery(caller, args);
          return { text: `Delivery ${d.id} (${d.event_type}) queued to send again.`, structured: d };
        }),
    );
    server.registerTool(
      "replay_missing_webhook_deliveries",
      {
        title: "Replay everything an endpoint missed",
        description:
          "Queues every event since an instant that this endpoint should have received and did not — the fix after a wrong URL, an outage, or an endpoint added after the fact. Already delivered events are left alone, so nothing arrives twice. One call scans at most 500 events; if the answer comes back truncated, call it again with the same `since` and `after` set to the `next_after` it gave you.",
        inputSchema: replayMissingInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const r = await caps.webhooks.replayMissing(caller, args);
          return {
            text: `${r.queued} of ${r.matched} matching events queued for ${r.webhook_id}${r.truncated ? `; there were more — call it again with after=${r.next_after}` : ""}.`,
            structured: r,
          };
        }),
    );
    server.registerTool(
      "list_events",
      {
        title: "Read the event stream",
        description:
          "Every event this inbox has ever produced, oldest first, in the same shape a webhook carries: id, type (like booking.confirm, order.record_payment, message.create), timestamp, and data with the item's id, type, state, version and URL. This is the polling alternative to a webhook, for anything that cannot receive one. Keep the next_cursor you get back and pass it as cursor next time to read only what is new; the order is stable and an event is never returned twice. The stream trails live by a few seconds, which is what makes the cursor safe to treat as a watermark. An empty page returns next_cursor null — keep the cursor you already have.",
        inputSchema: listEventsInput,
        annotations: readOnly,
      },
      (args) =>
        run(async () => {
          const page = await caps.webhooks.listEvents(caller, args);
          return {
            text:
              page.events
                .map((e) => `${e.id} ${e.type} ${e.timestamp} ${e.data.type} ${e.data.id} (${e.data.state})`)
                .join("\n") || "No events after that cursor.",
            structured: page,
          };
        }),
    );
    server.registerTool(
      "get_settings",
      {
        title: "Get settings",
        description: "The settings document and its version.",
        inputSchema: z.object({}),
        annotations: readOnly,
      },
      () =>
        run(async () => {
          const s = await caps.getSettings(caller);
          return { text: `Settings version ${s.version}.`, structured: s };
        }),
    );
    server.registerTool(
      "update_settings",
      {
        title: "Update settings",
        description: "Replace the settings document. Send expected_version from get_settings.",
        inputSchema: updateSettingsInput,
        annotations: writes,
      },
      (args) =>
        run(async () => {
          const s = await caps.updateSettings(caller, args);
          return { text: `Settings saved as version ${s.version}.`, structured: s };
        }),
    );
    return server;
  });
}
