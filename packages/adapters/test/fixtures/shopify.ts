import { hmacSha256Base64 } from "../../src/connectors/hook-sign";
import { type FakePlatform, fakePlatform, json } from "../fakes/platform";

/**
 * A made-up Shopify shop for the Shopify connector's tests (ADR-031), answering as the Admin API
 * 2026-10 documents it, over the base's fake platform (so the inbox's own connector client, with its
 * https-only, public-host and redirect checks, is the one used). No real shop is ever called; ids,
 * names and keys are made up, and keys are put together at run time so no file holds a string shaped
 * like a real one (a secret scanner would rightly stop that push).
 *
 * Shapes, each from Shopify's own documentation (20 October 2026):
 * - token (client credentials): `{access_token, scope, expires_in: 86399}`;
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 *   and its error `shop_not_permitted`.
 * - token (authorization code, `expiring=1`): `{access_token, scope, expires_in, refresh_token,
 *   refresh_token_expires_in}`;
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 * - GraphQL answers with `extensions.cost` (`requestedQueryCost`, `actualQueryCost`, `throttleStatus`)
 *   and, when throttled, `errors[].extensions.code = "THROTTLED"`;
 *   https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
 * - `draftOrderCreate` (and its `userErrors`, "Add at least 1 product"), `draftOrderDelete` ("Draft
 *   order not found"), `webhookSubscriptionCreate` (`{id, topic, uri}`), `webhookSubscriptionDelete`;
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate
 * - webhook deliveries: the REST resource as the body, cut to the subscription's `includeFields`, with
 *   `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id`,
 *   `X-Shopify-Event-Id`, `X-Shopify-API-Version`;
 *   https://shopify.dev/docs/apps/build/webhooks/delivery-structure
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/WebhookSubscriptionInput
 * - protected customer data withheld: the field null, with "This app is not approved to access the
 *   Order object." in `errors` and HTTP 200; https://shopify.dev/docs/apps/launch/protected-customer-data
 * - orders older than 60 days are not shown without `read_all_orders`;
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/queries/order
 *
 * The shops rotate the world: a florist in Oaxaca (MXN, prices with tax, the default), a florist in
 * Toronto (CAD, tax added at checkout), a café in Osaka (JPY, counted in whole yen).
 */

const fake = (...parts: string[]) => parts.join("_");
export const CLIENT_ID = "FAKEc1d2e3f4a5b6c7d8e9f0a1b2c3d4";
export const CLIENT_SECRET = fake("shpss", "FAKEFAKEFAKE7e2c9b4a1d6f3e8c5b2a9d4f");
export const LEGACY_TOKEN = fake("shpat", "FAKEFAKEFAKE3b8e1c6a9d2f5b8e1c4a7d0");
export const OPERATOR = {
  clientId: "FAKEoperatorAppClientId0000000001",
  clientSecret: fake("shpss", "FAKEOPERATOR0000secret0000000001"),
};

export interface FakeVariant {
  id: number;
  productId: number;
  title: string;
  sku: string | null;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number;
  tracked: boolean;
  policy: "DENY" | "CONTINUE";
  updatedAt: number;
}

export interface FakeProduct {
  id: number;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  description: string;
  updatedAt: number;
}

export interface FakeDraft {
  id: number;
  input: Record<string, unknown>;
  status: "OPEN" | "INVOICE_SENT" | "COMPLETED";
  /** Reads left before Shopify says it has worked out the total (`ready`). */
  notReadyFor: number;
  tags: string[];
  total: number;
  currency: string;
  orderId: number | null;
}

export interface FakeOrder {
  id: number;
  draftId: number | null;
  test: boolean;
  tags: string[];
  financial: "PAID" | "PENDING" | "AUTHORIZED" | "PARTIALLY_REFUNDED" | "REFUNDED";
  fulfillment: "UNFULFILLED" | "FULFILLED";
  cancelledAt: string | null;
  received: number;
  refunded: number;
  currency: string;
  gateway: string;
  processedAt: string;
  fulfillments: {
    status: "SUCCESS" | "CANCELLED";
    displayStatus: string | null;
    deliveredAt: string | null;
    createdAt: string;
    tracking: { company: string; number: string; url: string } | null;
  }[];
}

export interface FakeShopify {
  readonly platform: FakePlatform;
  readonly shop: string;
  readonly info: {
    id: number;
    name: string;
    currency: string;
    taxesIncluded: boolean;
    primaryDomain: string;
    partnerDevelopment: boolean;
  };
  readonly client: { id: string; secret: string };
  /** The scopes the app was given on the shop. */
  scopes: string[];
  /** Tax added on top of the lines when prices do not include it, as a fraction. */
  taxRate: number;
  /** Tokens Shopify has handed out and still takes; one taken out is answered 401. */
  readonly tokens: Set<string>;
  grants: number;
  /** The organization the shop is in: a client credentials grant from another is `shop_not_permitted`. */
  sameOrganization: boolean;
  readonly products: Map<number, FakeProduct>;
  readonly variants: FakeVariant[];
  readonly drafts: Map<number, FakeDraft>;
  readonly orders: Map<number, FakeOrder>;
  readonly hooks: Map<string, { id: string; topic: string; uri: string; includeFields: string[] }>;
  /** Topics Shopify will not make a webhook for, with its words. */
  readonly refuseTopics: Set<string>;
  /** Shopify keeps orders from the app as protected customer data. */
  withheld: boolean;
  /** Orders processed before this are no longer shown to the app (the 60 days); null shows all. */
  ordersShownSince: number | null;
  /** Shopify's search has not caught up yet: a search by tag finds nothing. */
  searchLags: boolean;
  /** GraphQL operations asked, by name, with their variables. */
  readonly operations: { name: string; variables: Record<string, unknown>; token: string }[];
  /** The bucket Shopify reports; `throttle` answers THROTTLED that many times. */
  bucket: { maximum: number; available: number; restoreRate: number };
  throttle: number;
  /** The customer pays the draft's checkout: the draft completes and becomes a paid order. */
  pay(draftId: number, opts?: { test?: boolean; gateway?: string }): FakeOrder;
  /** A webhook delivery as Shopify sends it, signed with the app's client secret; `tamper` changes one character. */
  delivery(
    topic: string,
    body: Record<string, unknown>,
    opts?: { tamper?: boolean; secret?: string; webhookId?: string; shop?: string },
  ): Promise<{ url: string; body: string; headers: Record<string, string> }>;
}

const toGid = (kind: string, id: number) => `gid://shopify/${kind}/${id}`;
const fromGid = (v: unknown) =>
  Number(
    String(v ?? "")
      .split("/")
      .at(-1),
  );
const money = (cents: number, currency: string) => ({
  amount: (cents / 100).toFixed(2),
  currencyCode: currency,
});
const cents = (amount: unknown) => Math.round(Number(amount) * 100);

export function fakeShopify(
  opts: {
    handle?: string;
    name?: string;
    currency?: string;
    taxesIncluded?: boolean;
    primaryDomain?: string;
    partnerDevelopment?: boolean;
  } = {},
): FakeShopify {
  const handle = opts.handle ?? "xochitl-flores";
  const shop = `${handle}.myshopify.com`;
  const base = `https://${shop}`;
  const platform = fakePlatform();
  let n = 1000;
  const s: FakeShopify = {
    platform,
    shop,
    info: {
      id: 64_120_557_901,
      name: opts.name ?? "Florería Xóchitl",
      currency: opts.currency ?? "MXN",
      taxesIncluded: opts.taxesIncluded ?? true,
      primaryDomain: opts.primaryDomain ?? "https://xochitl.example.mx",
      partnerDevelopment: opts.partnerDevelopment ?? false,
    },
    client: { id: CLIENT_ID, secret: CLIENT_SECRET },
    scopes: ["read_products", "read_orders", "write_draft_orders"],
    taxRate: 0,
    tokens: new Set([LEGACY_TOKEN]),
    grants: 0,
    sameOrganization: true,
    products: new Map(),
    variants: [],
    drafts: new Map(),
    orders: new Map(),
    hooks: new Map(),
    refuseTopics: new Set(),
    withheld: false,
    ordersShownSince: null,
    searchLags: false,
    operations: [],
    bucket: { maximum: 2000, available: 2000, restoreRate: 100 },
    throttle: 0,
    pay(draftId, o = {}) {
      const d = s.drafts.get(draftId);
      if (!d) throw new Error("no such draft");
      const id = ++n;
      const order: FakeOrder = {
        id,
        draftId,
        test: o.test ?? false,
        // Tags made on a draft are kept on its order.
        tags: [...d.tags],
        financial: "PAID",
        fulfillment: "UNFULFILLED",
        cancelledAt: null,
        received: d.total,
        refunded: 0,
        currency: d.currency,
        gateway: o.gateway ?? "shopify_payments",
        processedAt: "2026-10-20T14:05:00Z",
        fulfillments: [],
      };
      s.orders.set(id, order);
      d.status = "COMPLETED";
      d.orderId = id;
      return order;
    },
    async delivery(topic, body, o = {}) {
      const hook = [...s.hooks.values()].find((h) => h.topic === topic.toUpperCase().replace("/", "_"));
      // Shopify sends only the fields the subscription asked for.
      const fields = hook?.includeFields ?? [];
      const sent =
        fields.length > 0 ? Object.fromEntries(Object.entries(body).filter(([k]) => fields.includes(k))) : body;
      const raw = JSON.stringify(sent);
      let signature = await hmacSha256Base64(o.secret ?? s.client.secret, raw);
      if (o.tamper) signature = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
      return {
        url: hook?.uri ?? "",
        body: raw,
        headers: {
          "content-type": "application/json",
          "x-shopify-topic": topic,
          "x-shopify-hmac-sha256": signature,
          "x-shopify-shop-domain": o.shop ?? shop,
          "x-shopify-webhook-id": o.webhookId ?? `b54557e4-bdd9-4b37-8a5f-${String(++n).padStart(12, "0")}`,
          "x-shopify-event-id": `98880550-7158-44d4-b7cd-${String(n).padStart(12, "0")}`,
          "x-shopify-api-version": "2026-10",
          "x-shopify-triggered-at": "2026-10-20T14:05:01.118Z",
        },
      };
    },
  };

  const authed = (req: { headers: Headers }) => s.tokens.has(req.headers.get("x-shopify-access-token") ?? "");

  platform.on("POST", `${base}/admin/oauth/access_token`, (req) => {
    const p = new URLSearchParams(req.body);
    if (p.get("grant_type") === "client_credentials") {
      if (p.get("client_id") !== s.client.id || p.get("client_secret") !== s.client.secret) {
        return json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
      }
      if (!s.sameOrganization) {
        return json(
          {
            error: "shop_not_permitted",
            error_description: "Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.",
          },
          400,
        );
      }
      const token = fake("shpat", `FAKEcc${++s.grants}`.padEnd(32, "0"));
      s.tokens.add(token);
      return json({ access_token: token, scope: s.scopes.join(","), expires_in: 86399 });
    }
    if (p.get("grant_type") === "refresh_token") {
      if (p.get("client_id") !== OPERATOR.clientId || !String(p.get("refresh_token")).startsWith("shprt_")) {
        return json({ error: "invalid_request" }, 401);
      }
      const token = fake("shpat", `FAKErf${++s.grants}`.padEnd(32, "0"));
      s.tokens.add(token);
      return json({
        access_token: token,
        scope: s.scopes.join(","),
        expires_in: 3600,
        refresh_token: fake("shprt", `FAKErefresh${s.grants}`),
        refresh_token_expires_in: 7776000,
      });
    }
    if (p.get("code")) {
      if (
        p.get("client_id") !== OPERATOR.clientId ||
        p.get("code") !== "code-from-shopify" ||
        p.get("expiring") !== "1"
      ) {
        return json({ error: "invalid_request" }, 400);
      }
      const token = fake("shpat", `FAKEoa${++s.grants}`.padEnd(32, "0"));
      s.tokens.add(token);
      return json({
        access_token: token,
        scope: s.scopes.join(","),
        expires_in: 3600,
        refresh_token: fake("shprt", `FAKErefresh${s.grants}`),
        refresh_token_expires_in: 7776000,
      });
    }
    return json({ error: "invalid_request" }, 400);
  });

  const variantNode = (v: FakeVariant) => ({
    id: toGid("ProductVariant", v.id),
    title: v.title,
    sku: v.sku,
    price: v.price,
    availableForSale: v.availableForSale,
    inventoryQuantity: v.inventoryQuantity,
    inventoryPolicy: v.policy,
    inventoryItem: { tracked: v.tracked },
  });
  const productNode = (p: FakeProduct) => ({
    id: toGid("Product", p.id),
    title: p.title,
    status: p.status,
    description: p.description,
  });
  const orderNode = (o: FakeOrder) => ({
    id: toGid("Order", o.id),
    name: `#${o.id}`,
    test: o.test,
    tags: o.tags,
    cancelledAt: o.cancelledAt,
    displayFinancialStatus: o.financial,
    displayFulfillmentStatus: o.fulfillment,
    fullyPaid: o.financial !== "PENDING" && o.financial !== "AUTHORIZED",
    processedAt: o.processedAt,
    paymentGatewayNames: [o.gateway],
    legacyResourceId: String(o.id),
    totalReceivedSet: { presentmentMoney: money(o.received, o.currency) },
    totalRefundedSet: { presentmentMoney: money(o.refunded, o.currency) },
    fulfillments: o.fulfillments.map((f) => ({
      status: f.status,
      displayStatus: f.displayStatus,
      deliveredAt: f.deliveredAt,
      createdAt: f.createdAt,
      trackingInfo: f.tracking ? [f.tracking] : [],
    })),
  });
  /** An order the app may see: not withheld, and within the days Shopify shows. */
  const shown = (o: FakeOrder | undefined) =>
    o && !s.withheld && (s.ordersShownSince === null || Date.parse(o.processedAt) >= s.ordersShownSince)
      ? o
      : undefined;
  const withheldError = {
    message:
      "This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.",
    extensions: { code: "ACCESS_DENIED" },
  };
  const draftNode = (d: FakeDraft) => {
    const ready = d.notReadyFor <= 0;
    if (!ready) d.notReadyFor--;
    const order = shown(d.orderId ? s.orders.get(d.orderId) : undefined);
    return {
      id: toGid("DraftOrder", d.id),
      name: `#D${d.id}`,
      status: d.status,
      ready,
      invoiceUrl: `${base}/64120557901/invoices/inv${d.id}fake`,
      legacyResourceId: String(d.id),
      tags: d.tags,
      // Before it is ready, the total is the lines alone: the tax is still being worked out.
      totalPriceSet: { presentmentMoney: money(ready ? d.total : linesOf(d), d.currency) },
      order: order ? orderNode(order) : null,
    };
  };
  const linesOf = (d: FakeDraft) =>
    ((d.input.lineItems ?? []) as Record<string, unknown>[]).reduce((sum, l) => {
      const price = (l.priceOverride ?? l.originalUnitPriceWithCurrency) as { amount: string } | undefined;
      return sum + cents(price?.amount) * Number(l.quantity);
    }, 0);
  const page = <T>(list: T[], first: number, after: unknown) => {
    const start = after ? Number(String(after).replace(/^c/, "")) : 0;
    const nodes = list.slice(start, start + first);
    const end = start + nodes.length;
    return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? `c${end}` : null } };
  };
  const since = (query: unknown) => {
    const m = /updated_at:>'([^']+)'/.exec(String(query ?? ""));
    return m?.[1] ? Date.parse(m[1]) : null;
  };

  const ops: Record<string, (v: Record<string, unknown>) => unknown> = {
    InboxShop: () => ({
      shop: {
        id: toGid("Shop", s.info.id),
        name: s.info.name,
        myshopifyDomain: shop,
        currencyCode: s.info.currency,
        taxesIncluded: s.info.taxesIncluded,
        primaryDomain: { url: s.info.primaryDomain },
        plan: { partnerDevelopment: s.info.partnerDevelopment },
      },
      currentAppInstallation: { accessScopes: s.scopes.map((handle) => ({ handle })) },
    }),
    InboxVariants: (v) => {
      const after = since(v.query);
      const list = s.variants
        .filter((x) => after === null || x.updatedAt > after)
        .sort((a, b) => a.id - b.id)
        .map((x) => ({ ...variantNode(x), product: productNode(s.products.get(x.productId) as FakeProduct) }));
      return { productVariants: page(list, Number(v.first), v.after) };
    },
    InboxProductsChanged: (v) => {
      const after = since(v.query);
      const list = [...s.products.values()]
        .filter((p) => after === null || p.updatedAt > after)
        .sort((a, b) => a.id - b.id)
        .map((p) => ({
          ...productNode(p),
          variants: {
            nodes: s.variants
              .filter((x) => x.productId === p.id)
              .slice(0, 25)
              .map(variantNode),
          },
        }));
      return { products: page(list, Number(v.first), v.after) };
    },
    InboxDraftCreate: (v) => {
      const input = v.input as Record<string, unknown>;
      const lines = (input.lineItems ?? []) as Record<string, unknown>[];
      if (lines.length === 0) {
        return {
          draftOrderCreate: { draftOrder: null, userErrors: [{ message: "Add at least 1 product", field: null }] },
        };
      }
      for (const l of lines) {
        if (l.variantId && !s.variants.some((x) => toGid("ProductVariant", x.id) === l.variantId)) {
          return {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{ message: "Product with ID was not found", field: ["lineItems", "0", "variantId"] }],
            },
          };
        }
      }
      const id = ++n;
      const d: FakeDraft = {
        id,
        input,
        status: "OPEN",
        notReadyFor: 1,
        tags: (input.tags as string[]) ?? [],
        total: 0,
        currency: String(input.presentmentCurrencyCode ?? s.info.currency),
        orderId: null,
      };
      const subtotal = linesOf(d);
      d.total = s.info.taxesIncluded ? subtotal : subtotal + Math.round(subtotal * s.taxRate);
      s.drafts.set(id, d);
      return { draftOrderCreate: { draftOrder: draftNode(d), userErrors: [] } };
    },
    InboxDraft: (v) => {
      const d = s.drafts.get(fromGid(v.id));
      return { draftOrder: d ? draftNode(d) : null };
    },
    InboxDraftFind: (v) => {
      const tag = /tag:'([^']+)'/.exec(String(v.query))?.[1]?.toLowerCase();
      const found = s.searchLags
        ? undefined
        : [...s.drafts.values()].find((d) => d.tags.some((t) => t.toLowerCase() === tag));
      return { draftOrders: { nodes: found ? [draftNode(found)] : [] } };
    },
    InboxDraftsCompleted: () => ({
      draftOrders: {
        nodes: [...s.drafts.values()]
          .filter((d) => d.status === "COMPLETED" && d.tags.includes("inbox"))
          .sort((a, b) => b.id - a.id)
          .slice(0, 25)
          .map((d) => ({
            id: toGid("DraftOrder", d.id),
            tags: d.tags,
            order: d.orderId ? { id: toGid("Order", d.orderId) } : null,
          })),
      },
    }),
    InboxDraftDelete: (v) => {
      const id = fromGid((v.input as { id?: unknown }).id);
      if (!s.drafts.has(id)) {
        return {
          draftOrderDelete: { deletedId: null, userErrors: [{ field: ["id"], message: "Draft order not found" }] },
        };
      }
      s.drafts.delete(id);
      return { draftOrderDelete: { deletedId: toGid("DraftOrder", id), userErrors: [] } };
    },
    InboxOrder: (v) => {
      const o = shown(s.orders.get(fromGid(v.id)));
      return { order: o ? orderNode(o) : null };
    },
    InboxHooks: () => ({ webhookSubscriptions: { nodes: [...s.hooks.values()] } }),
    InboxHookCreate: (v) => {
      const input = v.webhookSubscription as { uri?: unknown; includeFields?: unknown };
      const uri = String(input.uri ?? "");
      const topic = String(v.topic);
      if (s.refuseTopics.has(topic)) {
        return {
          webhookSubscriptionCreate: {
            webhookSubscription: null,
            userErrors: [{ field: ["topic"], message: `Topic ${topic} is not available for this app` }],
          },
        };
      }
      if ([...s.hooks.values()].some((h) => h.topic === topic && h.uri === uri)) {
        return {
          webhookSubscriptionCreate: {
            webhookSubscription: null,
            userErrors: [
              {
                field: ["webhookSubscription", "callbackUrl"],
                message: "Address for this topic has already been taken",
              },
            ],
          },
        };
      }
      const id = toGid("WebhookSubscription", 8_589_934_000 + ++n);
      const includeFields = Array.isArray(input.includeFields) ? input.includeFields.map(String) : [];
      const hook = { id, topic, uri, includeFields };
      s.hooks.set(id, hook);
      return { webhookSubscriptionCreate: { webhookSubscription: hook, userErrors: [] } };
    },
    InboxHookDelete: (v) => {
      const id = String(v.id);
      const had = s.hooks.delete(id);
      return {
        webhookSubscriptionDelete: had
          ? { deletedWebhookSubscriptionId: id, userErrors: [] }
          : {
              deletedWebhookSubscriptionId: null,
              userErrors: [{ field: ["id"], message: "Webhook subscription does not exist" }],
            },
      };
    },
  };

  platform.on("POST", `${base}/admin/api/2026-10/graphql.json`, (req) => {
    if (!authed(req))
      return json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
    const { query, variables } = JSON.parse(req.body) as { query: string; variables?: Record<string, unknown> };
    const name = /^(?:query|mutation)\s+(\w+)/.exec(query.trim())?.[1] ?? "";
    s.operations.push({ name, variables: variables ?? {}, token: req.headers.get("x-shopify-access-token") ?? "" });
    const extensions = {
      cost: {
        requestedQueryCost: 302,
        actualQueryCost: 12,
        throttleStatus: {
          maximumAvailable: s.bucket.maximum,
          currentlyAvailable: s.bucket.available,
          restoreRate: s.bucket.restoreRate,
        },
      },
    };
    if (s.throttle > 0) {
      s.throttle--;
      return json({
        errors: [
          {
            message: "Throttled",
            extensions: { code: "THROTTLED", documentation: "https://shopify.dev/api/usage/rate-limits" },
          },
        ],
        extensions,
      });
    }
    const op = ops[name];
    if (!op) return json({ errors: [{ message: `Unknown operation ${name}` }] });
    if (name.startsWith("InboxDraft") && !s.scopes.includes("write_draft_orders")) {
      return json({
        data: null,
        errors: [{ message: "Access denied for draftOrders field.", extensions: { code: "ACCESS_DENIED" } }],
        extensions,
      });
    }
    const data = op(variables ?? {}) as Record<string, unknown>;
    // An order withheld as protected customer data: the field is null, with Shopify's error, HTTP 200.
    const orderAsked = name === "InboxOrder" || name === "InboxDraft" || name === "InboxDraftFind";
    if (s.withheld && orderAsked && [...s.orders.values()].length > 0) {
      return json({
        data,
        errors: [{ ...withheldError, path: [Object.keys(data)[0] ?? "order", "order"] }],
        extensions,
      });
    }
    return json({ data, extensions });
  });

  return s;
}

/** A florist's catalogue: two products, one with two variants, one tracked, one a draft, one priced in whole pesos. */
export function stockFlorist(s: FakeShopify, at = Date.parse("2026-10-19T09:00:00Z")): void {
  s.products.set(7_001, {
    id: 7_001,
    title: "Ramo de cempasúchil",
    status: "ACTIVE",
    description: "Marigolds, wrapped.",
    updatedAt: at,
  });
  s.products.set(7_002, { id: 7_002, title: "Arreglo de mesa", status: "ACTIVE", description: "", updatedAt: at });
  s.products.set(7_003, { id: 7_003, title: "Corona (próximamente)", status: "DRAFT", description: "", updatedAt: at });
  s.variants.push(
    {
      id: 41_001,
      productId: 7_001,
      title: "Default Title",
      sku: "CEM-RAMO",
      price: "450.00",
      availableForSale: true,
      inventoryQuantity: 12,
      tracked: true,
      policy: "DENY",
      updatedAt: at,
    },
    {
      id: 41_002,
      productId: 7_002,
      title: "Chico",
      sku: "MESA-S",
      price: "680.00",
      availableForSale: true,
      inventoryQuantity: 0,
      tracked: false,
      policy: "DENY",
      updatedAt: at,
    },
    {
      id: 41_003,
      productId: 7_002,
      title: "Grande",
      sku: "MESA-L",
      price: "1250.50",
      availableForSale: true,
      inventoryQuantity: -3,
      tracked: true,
      policy: "CONTINUE",
      updatedAt: at,
    },
    {
      id: 41_004,
      productId: 7_003,
      title: "Default Title",
      sku: null,
      price: "2100.00",
      availableForSale: false,
      inventoryQuantity: 0,
      tracked: true,
      policy: "DENY",
      updatedAt: at,
    },
  );
}

/** An order as Shopify's `orders/*` webhooks carry it (the REST resource, cut to what matters here). */
export function orderBody(order: FakeOrder, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: order.id,
    admin_graphql_api_id: toGid("Order", order.id),
    source_name: order.draftId ? "shopify_draft_order" : "web",
    tags: order.tags.join(", "),
    financial_status: order.financial.toLowerCase(),
    // What a body carries about the customer, which the inbox never keeps nor believes.
    email: "itzel.hernandez@example.mx",
    phone: "+529511234567",
    ...extra,
  };
}

export { fromGid, toGid };
