import {
  type CatalogueProduct,
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  decimalAmount,
  field,
  type HookEvent,
  type HookFact,
  type InboundRequest,
  isHundredthsCurrency,
  type KnownLink,
  minorAmount,
  type OAuthClient,
  type OrderFact,
  type PayAmount,
  type PayLink,
  type PayLinkRequest,
  type PaymentFact,
  type PostalAddress,
  type RunContext,
  type ShopOrder,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { verifyBase64Hmac } from "../hook-sign";
import {
  type AdminTarget,
  admin,
  adminUrl,
  clientCredentials,
  exchangeCode,
  type Grant,
  realSleep,
  refreshGrant,
  SHOPIFY_API_VERSION,
  SHOPIFY_SCOPES,
  type Sleep,
  shopDomainOf,
  storeProblem,
  userErrors,
} from "./admin";
import {
  DRAFT_CREATE,
  DRAFT_DELETE,
  DRAFT_FIND,
  DRAFT_READ,
  DRAFTS_COMPLETED,
  HOOK_CREATE,
  HOOK_DELETE,
  HOOKS,
  ORDER_READ,
  PRODUCTS_CHANGED,
  SHOP,
  VARIANTS,
} from "./queries";

export { forgetBuckets, MAX_WAIT_MS, SHOPIFY_API_VERSION, SHOPIFY_SCOPES, shopDomainOf } from "./admin";

/**
 * Shopify (ADR-028): messages, quotes and receipts for a Shopify shop, beside the checkout Shopify
 * already gives it. The shop's own Storefront MCP and checkout (UCP) stay Shopify's: agents are sent
 * there to buy what is in the cart, and come to the inbox for a question, a quote, a booking and the
 * signed receipt. What the connector adds:
 *
 * - **The catalogue comes in**: every variant, priced in the shop's currency, in stock when Shopify
 *   counts it, on sale when its product is active and the variant can be sold (ADR-026 §3).
 * - **An accepted order or quote becomes a draft order** in the shop, at the prices the customer
 *   accepted, and the draft's own checkout (`invoiceUrl`) is the link to pay: the customer pays on
 *   Shopify, to the business, with the shop's own payment methods. The inbox never calls
 *   `draftOrderInvoiceSend`: the business's own email from the inbox carries the link, so the
 *   customer is told once, in the business's words (ADR-026 §1).
 * - **What Shopify says became of it** (paid, fulfilled, delivered, refunded, a draft deleted) reaches
 *   the inbox by webhook at the connection's own address, signed (`X-Shopify-Hmac-Sha256`, base64
 *   HMAC-SHA-256 of the body under the app's client secret), and is always read back with the key
 *   before anything is believed. Polling every few minutes is the source of truth.
 *
 * The owner connects with the app they make for their own shop in Shopify's Dev Dashboard: its
 * Client ID and Client secret, for a token by the client credentials grant that lasts 24 hours and is
 * asked for again before it lapses. An app made in the shop's admin before 2026 still works with its
 * Admin API access token, under More options. "Sign in with Shopify" needs a Shopify app of whoever
 * runs the server (`SHOPIFY_CLIENT_ID`/`_SECRET`); without one it says "set up" on one's own server
 * and "Soon" on a hosted inbox.
 *
 * Everything is the GraphQL Admin API in version 2026-10, every call within the shop's cost-based
 * rate limit (`admin.ts`). Documents are in `queries.ts`. The docs cited are the ones Shopify
 * published on 20 October 2026; answers are read leniently, so a field added later changes nothing.
 */

/**
 * The webhooks the inbox asks for, by the header Shopify sends (`X-Shopify-Topic`) and the topic it
 * is made with. Each needs only the scopes asked for (`read_orders`, `read_products`,
 * `read_draft_orders` within `write_draft_orders`):
 * https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic
 */
export const SHOPIFY_TOPICS: Readonly<Record<string, string>> = {
  "orders/paid": "ORDERS_PAID",
  "orders/fulfilled": "ORDERS_FULFILLED",
  "orders/updated": "ORDERS_UPDATED",
  "orders/cancelled": "ORDERS_CANCELLED",
  "refunds/create": "REFUNDS_CREATE",
  "draft_orders/delete": "DRAFT_ORDERS_DELETE",
  "products/create": "PRODUCTS_CREATE",
  "products/update": "PRODUCTS_UPDATE",
  "products/delete": "PRODUCTS_DELETE",
  "app/uninstalled": "APP_UNINSTALLED",
};

/** What every draft the inbox makes is tagged with, and the tag that names its link. */
const TAG = "sdi";
const refTag = (ref: string) => `${TAG}-${ref}`;
const HOUR_MS = 3_600_000;
const DEV_DASHBOARD = "https://dev.shopify.com/dashboard/";
const DOCS = "https://surfingdog.ai/docs/connectors/shopify/";

/** The shop's address, with or without https, or the admin's address: never a format to guess. */
function storeField() {
  return field(
    z
      .string()
      .trim()
      .min(1)
      .max(300)
      .superRefine((v, ctx) => {
        const problem = storeProblem(v);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    {
      label: "Shop address",
      input: "text",
      placeholder: "your-shop.myshopify.com",
      help: "Shopify shows it under Settings → Domains. Your admin's address works too.",
      autocomplete: "off",
    },
  );
}

export const shopifyForm = z.object({
  store: storeField(),
  client_id: field(
    z
      .string()
      .trim()
      .min(16, "a Shopify Client ID is 32 letters and numbers")
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/, "a Shopify Client ID is letters and numbers"),
    {
      label: "Client ID",
      help: "From an app you make for this inbox, in Shopify's Dev Dashboard:",
      steps: [
        "Create app → Start from Dev Dashboard, and name it after this inbox.",
        "Versions: App URL https://shopify.dev/apps/default-app-home; scopes read_products, read_orders, write_draft_orders. Release.",
        "Install app, on this shop.",
        "App settings → Credentials: copy the Client ID and the Client secret.",
      ],
      link: { href: DEV_DASHBOARD, text: "Open the Dev Dashboard" },
      autocomplete: "off",
    },
  ),
  client_secret: secretField(
    z
      .string()
      .trim()
      .min(16)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/, "a Shopify Client secret is letters, numbers and underscores"),
    { label: "Client secret", placeholder: "shpss_…" },
  ),
  access_token: secretField(
    z
      .string()
      .trim()
      .regex(/^shpat_[A-Za-z0-9]{16,}$/, "an Admin API access token starts with shpat_")
      .optional(),
    {
      label: "Admin API access token",
      help: "Only for an app made in your Shopify admin before 2026: its access token, with its API key and API secret key above.",
      placeholder: "shpat_…",
      advanced: true,
    },
  ),
});

/* --- what Shopify answers ------------------------------------------------------------ */

interface Money {
  readonly amount?: unknown;
  readonly currencyCode?: unknown;
}
interface MoneyBag {
  readonly presentmentMoney?: Money | null;
}
interface FulfillmentNode {
  readonly status?: unknown;
  readonly displayStatus?: unknown;
  readonly deliveredAt?: unknown;
  readonly createdAt?: unknown;
  readonly trackingInfo?: readonly { readonly company?: unknown; readonly number?: unknown; readonly url?: unknown }[];
}
interface OrderNode {
  readonly id?: unknown;
  readonly test?: unknown;
  readonly tags?: unknown;
  readonly cancelledAt?: unknown;
  readonly displayFinancialStatus?: unknown;
  readonly displayFulfillmentStatus?: unknown;
  readonly fullyPaid?: unknown;
  readonly processedAt?: unknown;
  readonly paymentGatewayNames?: unknown;
  readonly legacyResourceId?: unknown;
  readonly totalReceivedSet?: MoneyBag | null;
  readonly totalRefundedSet?: MoneyBag | null;
  readonly fulfillments?: readonly FulfillmentNode[] | null;
}
interface DraftNode {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly ready?: unknown;
  readonly invoiceUrl?: unknown;
  readonly legacyResourceId?: unknown;
  readonly tags?: unknown;
  readonly totalPriceSet?: MoneyBag | null;
  readonly order?: OrderNode | null;
}
interface VariantNode {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly sku?: unknown;
  readonly price?: unknown;
  readonly availableForSale?: unknown;
  readonly inventoryQuantity?: unknown;
  readonly inventoryPolicy?: unknown;
  readonly inventoryItem?: { readonly tracked?: unknown } | null;
  readonly product?: ProductNode | null;
}
interface ProductNode {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly description?: unknown;
  readonly variants?: { readonly nodes?: readonly VariantNode[] } | null;
}
interface ShopAnswer {
  readonly shop?: {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly myshopifyDomain?: unknown;
    readonly currencyCode?: unknown;
    readonly taxesIncluded?: unknown;
    readonly primaryDomain?: { readonly url?: unknown } | null;
    readonly plan?: { readonly partnerDevelopment?: unknown } | null;
  } | null;
  readonly currentAppInstallation?: { readonly accessScopes?: readonly { readonly handle?: unknown }[] } | null;
}
interface Hook {
  readonly id: string;
  readonly topic: string;
  readonly uri: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function gid(kind: string, v: unknown): string | null {
  const s = str(v);
  return new RegExp(`^gid://shopify/${kind}/\\d+$`).test(s) ? s : null;
}

/** Shopify's money (a decimal string and a code) in hundredths; null when it is not an amount this inbox holds. */
function moneyOf(m: Money | null | undefined): PayAmount | null {
  const currency = str(m?.currencyCode).toUpperCase();
  const value = minorAmount(str(m?.amount));
  if (value === null || !/^[A-Z]{3}$/.test(currency) || !isHundredthsCurrency(currency)) return null;
  return { value, currency };
}

function tagsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
  return typeof v === "string" ? v.split(",").map((t) => t.trim()) : [];
}

/** The inbox's own id for the link, from the tag it put on its draft (Shopify keeps tags in any case). */
function refOf(tags: unknown): string | null {
  for (const t of tagsOf(tags)) {
    const m = /^sdi-([0-9a-z]{26})$/i.exec(t.trim());
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}

function timeOf(v: unknown): number | null {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
}

/* --- the connection ----------------------------------------------------------------- */

type Way = "keys" | "token" | "oauth";

interface Options {
  /** The Shopify app of whoever runs the server, for "Sign in with Shopify"; null without one. */
  readonly client?: OAuthClient | null | undefined;
  /** A hosted inbox, whose app is the host's own and on its way: "Soon" rather than "set up". */
  readonly hosted?: boolean | undefined;
  /** How the connector waits for Shopify's bucket to refill: tests give one that does not. */
  readonly sleep?: Sleep | undefined;
}

function shopOf(ctx: Pick<RunContext, "extra">): string {
  const shop = str(ctx.extra.shop);
  if (!shopDomainOf(shop))
    throw new ConnectorError("config", "The shop's address is not there. Connect Shopify again.");
  return shop;
}

export function shopifyConnector(
  client: OAuthClient | null = null,
  opts: Omit<Options, "client"> = {},
): ConnectorDefinition {
  const sleep = opts.sleep ?? realSleep;
  const operator = client?.clientId && client.clientSecret ? client : null;

  /** Tokens asked for during a run, by the secret the run began with, so one run asks once. */
  const renewedIn = new WeakMap<object, { readonly token: string; readonly expiresAt: string }>();

  /** The key webhooks are signed with: the app's client secret, the owner's own or the operator's. */
  const signingKey = (ctx: Pick<RunContext, "secret">): string =>
    ctx.secret.way === "oauth" ? (operator?.clientSecret ?? "") : (ctx.secret.client_secret ?? "");

  /**
   * An access token for the run: the one kept while it has more than a minute left, else a new one
   * (the client credentials grant, or a sign-in's refresh token), kept sealed for the next run.
   */
  async function tokenOf(ctx: RunContext, fresh = false): Promise<string> {
    const s = ctx.secret;
    const way = (s.way ?? "keys") as Way;
    // A token asked for in this run already: `ctx.secret` is what the run began with.
    const renewed = renewedIn.get(s);
    const expiresAt = Number(renewed?.expiresAt ?? s.expires_at ?? "");
    const current = renewed?.token ?? s.access_token ?? "";
    if (way === "token") {
      if (!current) throw new ConnectorError("auth", "The Shopify access token is not there. Connect Shopify again.");
      return current;
    }
    if (!fresh && current && (!Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt - 60_000 > ctx.now)) {
      return current;
    }
    const shop = shopOf(ctx);
    let grant: Grant;
    if (way === "oauth") {
      if (!operator) throw new ConnectorError("config", "This server's Shopify app is not set up any more.");
      if (!s.refresh_token) {
        if (current) return current;
        throw new ConnectorError("auth", "Shopify no longer takes this inbox's sign-in. Sign in with Shopify again.");
      }
      grant = await refreshGrant(ctx.http, shop, operator, s.refresh_token, ctx.now);
    } else {
      if (!s.client_id || !s.client_secret) {
        throw new ConnectorError("auth", "The Shopify app's keys are not there. Connect Shopify again.");
      }
      grant = await clientCredentials(
        ctx.http,
        shop,
        { clientId: s.client_id, clientSecret: s.client_secret },
        ctx.now,
      );
    }
    const kept = {
      ...s,
      access_token: grant.accessToken,
      expires_at: grant.expiresAt === null ? "" : String(grant.expiresAt),
      ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
    };
    await ctx.saveSecret(kept);
    renewedIn.set(s, { token: grant.accessToken, expiresAt: kept.expires_at });
    return grant.accessToken;
  }

  /** A call with the run's token; a token Shopify no longer takes is asked for again, once. */
  async function call<T>(ctx: RunContext, doc: Parameters<typeof admin>[1], variables: Record<string, unknown> = {}) {
    const target = (token: string): AdminTarget => ({ http: ctx.http, shop: shopOf(ctx), token, sleep });
    try {
      return await admin<T>(target(await tokenOf(ctx)), doc, variables);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "auth" || ctx.secret.way === "token") throw error;
      return admin<T>(target(await tokenOf(ctx, true)), doc, variables);
    }
  }

  /* --- connecting ------------------------------------------------------------------ */

  /**
   * What every way of connecting ends in: the shop read with the token, the access checked, and the
   * webhooks made at the connection's own address (or left for later).
   */
  async function connected(
    ctx: ConnectContext,
    shop: string,
    way: Way,
    secret: Record<string, string>,
    grantScopes: readonly string[],
  ): Promise<Connected> {
    const target: AdminTarget = { http: ctx.http, shop, token: secret.access_token ?? "", sleep };
    const info = await admin<ShopAnswer>(target, SHOP);
    const s = info.shop;
    const externalId = gid("Shop", s?.id);
    if (!s || !externalId) throw new ConnectorError("bad_response", "Shopify did not say which shop this is.");
    const currency = str(s.currencyCode).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || !isHundredthsCurrency(currency)) {
      throw new ConnectorError(
        "config",
        `This inbox counts money in hundredths, and ${str(s.name) || shop} sells in ${currency || "another currency"}, which is not. It cannot be connected yet.`,
        { field: "store" },
      );
    }
    // What the shop approved; a token's own `scope` is the app version's, which a shop may not have
    // approved yet, and is used only when the installation does not say.
    const installed = (info.currentAppInstallation?.accessScopes ?? []).map((a) => str(a?.handle)).filter(Boolean);
    const scopes = new Set(installed.length > 0 ? installed : grantScopes);
    const missing = SHOPIFY_SCOPES.filter((scope) => !scopes.has(scope));
    if (missing.length > 0) {
      throw new ConnectorError(
        "config",
        `The app is missing ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} on the app's Versions page, release, and approve it in Shopify.`,
        { field: way === "oauth" ? "store" : "client_id" },
      );
    }
    const domain = str(s.myshopifyDomain).toLowerCase();
    const home = shopDomainOf(domain) ?? shop;
    const storefront = /^https:\/\//.test(str(s.primaryDomain?.url)) ? str(s.primaryDomain?.url) : `https://${home}`;
    const name = str(s.name).trim().slice(0, 120) || home;
    const previous = hooksOf(ctx.previous?.extra ?? {}).map((h) => h.id);
    let made: { hooks: Hook[]; created: string[]; stale: string[] } = { hooks: [], created: [], stale: [] };
    let webhook: "added" | "pending" | "none" = "none";
    if (ctx.hookUrl && ctx.hooksLive !== false) {
      made = await ensureHooks({ ...target, shop: home }, ctx.hookUrl, previous);
      webhook = "added";
    } else if (ctx.hookUrl) {
      // A hosted inbox before it goes live answers only its owner: webhooks made now would fail, and
      // Shopify removes a subscription after eight failures. They are made once it is live.
      webhook = "pending";
    }
    const removeAll = async (ids: readonly string[]) => {
      for (const id of ids) await removeHook({ ...target, shop: home }, id);
    };
    return {
      account: `${name} · ${home}`,
      externalId,
      secret: { ...secret, way },
      extra: {
        shop: home,
        storefront,
        currency,
        taxes_included: s.taxesIncluded === true,
        api_version: SHOPIFY_API_VERSION,
        webhook,
        hooks: made.hooks.map(({ id, topic }) => ({ id, topic })),
        ...(webhook === "added" && ctx.hookUrl ? { hook_origin: originOf(ctx.hookUrl) } : {}),
      },
      calendars: [],
      destinations: [],
      defaults: { busy: [], destination: null },
      // A development shop takes test orders only (Shopify's Bogus Gateway): its links are for test items.
      mode: s.plan?.partnerDevelopment === true ? "test" : "live",
      settle: async (kept) => {
        try {
          // Refused after all: what was just made goes. Kept: what the inbox made before, elsewhere, goes.
          await removeAll(kept ? made.stale : made.created);
        } catch {
          // Best effort: what is left is found and tidied on the next refresh.
        }
      },
    };
  }

  async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
    const shop = shopDomainOf(String(input.store ?? ""));
    if (!shop) throw new ConnectorError("config", storeProblem(String(input.store ?? "")) ?? "", { field: "store" });
    const clientId = String(input.client_id ?? "");
    const clientSecret = String(input.client_secret ?? "");
    const pasted = String(input.access_token ?? "");
    if (pasted) {
      // An app made in the admin before 2026: its token does not lapse, and its API secret key signs webhooks.
      return connected(
        ctx,
        shop,
        "token",
        { client_id: clientId, client_secret: clientSecret, access_token: pasted },
        [],
      );
    }
    const grant = await clientCredentials(ctx.http, shop, { clientId, clientSecret }, ctx.now);
    return connected(
      ctx,
      shop,
      "keys",
      {
        client_id: clientId,
        client_secret: clientSecret,
        access_token: grant.accessToken,
        expires_at: grant.expiresAt === null ? "" : String(grant.expiresAt),
      },
      grant.scopes,
    );
  }

  /* --- webhooks the inbox makes ------------------------------------------------------ */

  /**
   * The webhooks the inbox made, by id and topic. Never their address: it holds the connection's own
   * token, which the inbox keeps only sealed (ADR-026 §4). Where they point is known by its origin.
   */
  function hooksOf(extra: Readonly<Record<string, unknown>>): { id: string; topic: string }[] {
    const raw = Array.isArray(extra.hooks) ? (extra.hooks as unknown[]) : [];
    return raw
      .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
      .map((h) => ({ id: str(h.id), topic: str(h.topic) }))
      .filter((h) => h.id !== "");
  }

  function originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  /**
   * Every topic the inbox asks for, at `url`: what is there already is kept, what is missing is made
   * (one Shopify removed after failed deliveries comes back here). What this inbox made before
   * (`made`, by id) and points elsewhere now, or what points at another of its addresses for Shopify,
   * is named `stale`, to go once the connection is kept.
   */
  async function ensureHooks(t: AdminTarget, url: string, made: readonly string[]) {
    const listed = await admin<{ webhookSubscriptions?: { nodes?: readonly Record<string, unknown>[] } }>(t, HOOKS);
    const all: Hook[] = (listed.webhookSubscriptions?.nodes ?? [])
      .map((n) => ({ id: str(n.id), topic: str(n.topic), uri: str(n.uri) }))
      .filter((h) => h.id !== "");
    const here = all.filter((h) => h.uri === url);
    const created: string[] = [];
    const hooks: Hook[] = [...here];
    for (const topic of Object.values(SHOPIFY_TOPICS)) {
      if (here.some((h) => h.topic === topic)) continue;
      const answer = await admin<{
        webhookSubscriptionCreate?: { webhookSubscription?: Record<string, unknown> | null; userErrors?: unknown };
      }>(t, HOOK_CREATE, { topic, webhookSubscription: { uri: url } });
      const sub = answer.webhookSubscriptionCreate?.webhookSubscription;
      const id = str(sub?.id);
      if (!id) {
        throw new ConnectorError(
          "refused",
          `Shopify did not make the ${topic} webhook: ${userErrors(answer.webhookSubscriptionCreate) ?? "no reason given"}`,
        );
      }
      created.push(id);
      hooks.push({ id, topic, uri: url });
    }
    const prefix = `${originOf(url)}/v1/hooks/shopify/`;
    const ours = new Set(made);
    const stale = all.filter((h) => h.uri !== url && (ours.has(h.id) || h.uri.startsWith(prefix))).map((h) => h.id);
    return { hooks, created, stale };
  }

  async function removeHook(t: AdminTarget, id: string): Promise<void> {
    try {
      await admin(t, HOOK_DELETE, { id });
    } catch (error) {
      // Gone already, or the access was withdrawn: nothing is left to remove with this key.
      if (error instanceof ConnectorError && (error.code === "auth" || error.code === "not_found")) return;
      throw error;
    }
  }

  /* --- the catalogue ------------------------------------------------------------------ */

  function productOf(
    v: VariantNode,
    product: ProductNode | null | undefined,
    currency: string,
  ): CatalogueProduct | null {
    const id = gid("ProductVariant", v.id);
    if (!id || !product) return null;
    const title = str(product.title).trim();
    const variant = str(v.title).trim();
    const tracked = v.inventoryItem?.tracked === true;
    const quantity = Number(v.inventoryQuantity);
    const value = minorAmount(str(v.price));
    return {
      externalId: id,
      // A product with one variant has "Default Title" as its variant's.
      name: variant && variant !== "Default Title" ? `${title} – ${variant}` : title || variant || "Product",
      description: str(product.description).trim() || null,
      sku: str(v.sku).trim() || null,
      price: value === null ? null : { value, currency },
      // Counted only when Shopify tracks it and stops selling at none; a variant sold past none is not counted.
      stock: tracked && v.inventoryPolicy === "DENY" && Number.isFinite(quantity) ? Math.max(0, quantity) : null,
      available: product.status === "ACTIVE" && v.availableForSale === true,
    };
  }

  type PageInfo = { readonly hasNextPage?: unknown; readonly endCursor?: unknown } | undefined;
  const next = (info: PageInfo, prefix: string): string | null =>
    info?.hasNextPage === true && str(info.endCursor) ? `${prefix}${str(info.endCursor)}` : null;

  /**
   * One page: a full pass reads every variant (`f:`); what changed since reads the variants changed
   * (`v:`), then the products changed with their variants (`p:`), since a product's own change is not
   * always its variants'.
   */
  async function page(ctx: RunContext, p: { readonly cursor: string | null; readonly since: number | null }) {
    const currency = str(ctx.extra.currency);
    const cursor = p.cursor ?? "";
    if (p.since === null || cursor.startsWith("f:")) {
      const after = cursor.startsWith("f:") ? cursor.slice(2) || null : null;
      const data = await call<{ productVariants?: { nodes?: VariantNode[]; pageInfo?: PageInfo } }>(ctx, VARIANTS, {
        first: 100,
        after,
        query: null,
      });
      const nodes = data.productVariants?.nodes ?? [];
      return {
        products: nodes.map((v) => productOf(v, v.product, currency)).filter((x): x is CatalogueProduct => x !== null),
        cursor: next(data.productVariants?.pageInfo, "f:"),
      };
    }
    const query = `updated_at:>'${new Date(p.since).toISOString()}'`;
    if (!cursor.startsWith("p:")) {
      const after = cursor.startsWith("v:") ? cursor.slice(2) || null : null;
      const data = await call<{ productVariants?: { nodes?: VariantNode[]; pageInfo?: PageInfo } }>(ctx, VARIANTS, {
        first: 100,
        after,
        query,
      });
      const nodes = data.productVariants?.nodes ?? [];
      return {
        products: nodes.map((v) => productOf(v, v.product, currency)).filter((x): x is CatalogueProduct => x !== null),
        cursor: next(data.productVariants?.pageInfo, "v:") ?? "p:",
      };
    }
    const after = cursor.slice(2) || null;
    const data = await call<{ products?: { nodes?: ProductNode[]; pageInfo?: PageInfo } }>(ctx, PRODUCTS_CHANGED, {
      first: 10,
      after,
      query,
    });
    const products: CatalogueProduct[] = [];
    for (const product of data.products?.nodes ?? []) {
      for (const v of product.variants?.nodes ?? []) {
        const made = productOf(v, product, currency);
        if (made) products.push(made);
      }
    }
    return { products, cursor: next(data.products?.pageInfo, "p:") };
  }

  /* --- orders: drafts the inbox makes -------------------------------------------------- */

  /** A postal address as Shopify takes it; the region only when it is a code ("ON", "MH"). */
  function addressOf(a: PostalAddress | null, name: string | null, phone: string | null) {
    if (!a) return undefined;
    const [first, last] = splitName(name);
    const region = (a.addressRegion ?? "").trim();
    return {
      ...(a.streetAddress ? { address1: a.streetAddress } : {}),
      ...(a.addressLocality ? { city: a.addressLocality } : {}),
      ...(/^[A-Za-z0-9]{1,3}$/.test(region) ? { provinceCode: region.toUpperCase() } : {}),
      ...(a.postalCode ? { zip: a.postalCode } : {}),
      ...(a.addressCountry && /^[A-Z]{2}$/.test(a.addressCountry) ? { countryCode: a.addressCountry } : {}),
      ...(first ? { firstName: first } : {}),
      ...(last ? { lastName: last } : {}),
      ...(phone ? { phone } : {}),
    };
  }

  /** A name as written, cut before its last word for Shopify's two fields: the label prints it back whole. */
  function splitName(name: string | null): [string | null, string | null] {
    const n = (name ?? "").trim().replace(/\s+/g, " ");
    if (!n) return [null, null];
    const at = n.lastIndexOf(" ");
    return at > 0 ? [n.slice(0, at), n.slice(at + 1)] : [null, n];
  }

  /** A phone number only in the form Shopify takes (E.164); anything else is left out, not guessed at. */
  function e164(phone: string | null): string | null {
    const p = (phone ?? "").replace(/[\s().-]/g, "");
    return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
  }

  /** The words a draft's shipping line carries at the shop's checkout, in the customer's language. */
  const SHIPPING_WORDS: Readonly<Record<string, { readonly delivery: string; readonly pickup: string }>> = {
    en: { delivery: "Delivery", pickup: "Pickup" },
    es: { delivery: "Envío", pickup: "Recogida" },
    pt: { delivery: "Entrega", pickup: "Retirada" },
    fr: { delivery: "Livraison", pickup: "Retrait" },
    de: { delivery: "Lieferung", pickup: "Abholung" },
    it: { delivery: "Consegna", pickup: "Ritiro" },
    nl: { delivery: "Bezorging", pickup: "Afhalen" },
  };

  /**
   * The draft as Shopify takes it: the shop's own variants at the prices the customer accepted
   * (`priceOverride`), the inbox's other lines as custom ones, the customer's details for fulfilling,
   * and a shipping line of nothing for an order to deliver or collect, so the shop's checkout adds no
   * rate the customer did not accept (a delivery fee is one of the order's own lines). Discounts are
   * not added at checkout either: the customer pays what they accepted. Tax is the shop's to add;
   * when it does, the shop's total differs and the link is held (ADR-026 §2).
   */
  function draftInput(request: PayLinkRequest, order: ShopOrder) {
    const currency = order.total.currency;
    const physical = order.delivery === "delivery" || order.delivery === "pickup";
    const lineItems = order.lines.map((l) => {
      const variantId = gid("ProductVariant", l.externalId);
      const price = { amount: decimalAmount(l.unit), currencyCode: currency };
      return variantId
        ? { variantId, quantity: l.quantity, priceOverride: price }
        : {
            title: l.name.slice(0, 255) || request.title,
            quantity: l.quantity,
            originalUnitPriceWithCurrency: price,
            requiresShipping: order.delivery === "delivery",
            taxable: true,
            ...(l.sku ? { sku: l.sku.slice(0, 255) } : {}),
          };
    });
    const phone = e164(order.customer.phone);
    const words = SHIPPING_WORDS[(order.customer.language || "en").slice(0, 2).toLowerCase()] ?? SHIPPING_WORDS.en;
    const note = [
      `Inbox order ${request.reference}.`,
      order.delivery === "pickup" ? "To collect." : order.delivery === "delivery" ? "To deliver." : "",
      order.when ? `Wanted: ${order.when}.` : "",
      // The customer's own words, marked as theirs: nothing else is made of them.
      order.note ? `The customer wrote: “${order.note}”` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      lineItems,
      presentmentCurrencyCode: currency,
      tags: [TAG, refTag(request.ref)],
      note: note.slice(0, 5_000),
      acceptAutomaticDiscounts: false,
      allowDiscountCodesInCheckout: false,
      ...(order.customer.email ? { email: order.customer.email } : {}),
      ...(phone ? { phone } : {}),
      ...(order.shipping ? { shippingAddress: addressOf(order.shipping, order.customer.name, phone) } : {}),
      ...(order.billing ? { billingAddress: addressOf(order.billing, order.customer.name, phone) } : {}),
      ...(physical && words
        ? {
            shippingLine: {
              title: order.delivery === "pickup" ? words.pickup : words.delivery,
              priceWithCurrency: { amount: "0.00", currencyCode: currency },
            },
          }
        : {}),
    };
  }

  function linkOf(ctx: RunContext, draft: DraftNode): PayLink {
    const externalId = gid("DraftOrder", draft.id);
    const url = str(draft.invoiceUrl);
    if (!externalId || !/^https:\/\//.test(url)) {
      throw new ConnectorError("bad_response", "Shopify made the draft order but did not say where it is paid.");
    }
    const total = moneyOf(draft.totalPriceSet?.presentmentMoney);
    const legacy = str(draft.legacyResourceId) || String(draft.legacyResourceId ?? "");
    return {
      externalId,
      url,
      ...(total ? { total } : {}),
      ...(legacy ? { dashboardUrl: adminUrl(shopOf(ctx), `/draft_orders/${encodeURIComponent(legacy)}`) } : {}),
    };
  }

  /**
   * A draft is ready once Shopify has worked out its taxes and total (`ready`); until then its total
   * is not the one the customer would pay. Asked a few times, a moment apart, then left for a retry.
   */
  async function whenReady(ctx: RunContext, draft: DraftNode): Promise<DraftNode> {
    let current = draft;
    for (let i = 0; i < 3 && current.ready === false; i++) {
      await sleep(500 * (i + 1));
      const read = await call<{ draftOrder?: DraftNode | null }>(ctx, DRAFT_READ, { id: current.id });
      if (!read.draftOrder) break;
      current = read.draftOrder;
    }
    if (current.ready === false) {
      throw new ConnectorError("unreachable", "Shopify is still working out the draft order's total.", {
        retryAfterMs: 30_000,
      });
    }
    return current;
  }

  async function findDraft(ctx: RunContext, ref: string): Promise<DraftNode | null> {
    const found = await call<{ draftOrders?: { nodes?: DraftNode[] } }>(ctx, DRAFT_FIND, {
      query: `tag:'${refTag(ref)}'`,
    });
    const draft = found.draftOrders?.nodes?.[0];
    return draft && refOf(draft.tags) === ref.toUpperCase() ? draft : null;
  }

  async function createLink(ctx: RunContext, request: PayLinkRequest): Promise<PayLink> {
    const order = request.order;
    if (!order) throw new ConnectorError("config", "A Shopify draft order needs the order's lines.");
    if (order.lines.length === 0) throw new ConnectorError("refused", "The order has no lines to write into Shopify.");
    if (order.lines.length > 499) throw new ConnectorError("refused", "Shopify takes at most 499 lines on one order.");
    const currency = order.total.currency;
    if (currency !== request.amount.currency || order.lines.some((l) => l.unit.currency !== currency)) {
      throw new ConnectorError("refused", "The order's lines are not all in one currency.");
    }
    // Made already, by a run that stopped before it noted the draft: the same one, never a second.
    const existing = await findDraft(ctx, request.ref);
    if (existing) return linkOf(ctx, await whenReady(ctx, existing));
    const made = await call<{ draftOrderCreate?: { draftOrder?: DraftNode | null; userErrors?: unknown } }>(
      ctx,
      DRAFT_CREATE,
      { input: draftInput(request, order) },
    );
    const draft = made.draftOrderCreate?.draftOrder;
    if (!draft) {
      throw new ConnectorError(
        "refused",
        `Shopify did not make the draft order: ${userErrors(made.draftOrderCreate) ?? "no reason given"}`,
      );
    }
    return linkOf(ctx, await whenReady(ctx, draft));
  }

  async function readDraft(ctx: RunContext, id: string | null): Promise<DraftNode | null> {
    if (!gid("DraftOrder", id)) return null;
    const read = await call<{ draftOrder?: DraftNode | null }>(ctx, DRAFT_READ, { id });
    return read.draftOrder ?? null;
  }

  /** Closes a draft nobody paid: it is deleted, the one way Shopify gives. A completed one is the shop's order now. */
  async function closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void> {
    const draft = await readDraft(ctx, link.externalId);
    if (!draft || draft.status === "COMPLETED") return;
    const gone = await call<{ draftOrderDelete?: { deletedId?: unknown; userErrors?: unknown } }>(ctx, DRAFT_DELETE, {
      input: { id: link.externalId },
    });
    const problem = userErrors(gone.draftOrderDelete);
    if (!str(gone.draftOrderDelete?.deletedId) && problem && !/not found/i.test(problem)) {
      throw new ConnectorError("refused", `Shopify did not delete the draft order: ${problem}`);
    }
  }

  /** How it was paid, in a receipt's words, when Shopify's gateway says. */
  function methodOf(order: OrderNode): string | undefined {
    const names = Array.isArray(order.paymentGatewayNames) ? order.paymentGatewayNames.map(str) : [];
    if (names.includes("shopify_payments")) return "card";
    if (names.some((n) => /paypal/i.test(n))) return "paypal";
    return undefined;
  }

  const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

  function paymentOf(ctx: RunContext, draft: DraftNode, order: OrderNode): PaymentFact | null {
    const orderId = gid("Order", order.id);
    if (!orderId) return null;
    const paid = PAID.has(str(order.displayFinancialStatus)) || order.fullyPaid === true;
    const legacy = str(order.legacyResourceId) || String(order.legacyResourceId ?? "");
    return {
      // Authorised and not captured, or a manual payment still to come: the money is not the business's yet.
      status: paid ? "paid" : "pending",
      linkId: gid("DraftOrder", draft.id),
      ref: refOf(draft.tags),
      paymentId: orderId,
      amount: moneyOf(order.totalReceivedSet?.presentmentMoney),
      ...(methodOf(order) ? { method: methodOf(order) } : {}),
      ...(timeOf(order.processedAt) !== null ? { paidAt: timeOf(order.processedAt) ?? undefined } : {}),
      ...(legacy ? { dashboardUrl: adminUrl(shopOf(ctx), `/orders/${encodeURIComponent(legacy)}`) } : {}),
      livemode: order.test !== true,
    };
  }

  /** What the order the draft became says, as facts the inbox follows, in the order they happen. */
  function orderFacts(ctx: RunContext, draft: DraftNode, order: OrderNode): OrderFact[] {
    const linkId = gid("DraftOrder", draft.id);
    const ref = refOf(draft.tags);
    const paid = PAID.has(str(order.displayFinancialStatus)) || order.fullyPaid === true;
    const facts: OrderFact[] = [];
    if (!paid) {
      if (order.cancelledAt) facts.push({ linkId, ref, state: "cancelled", at: timeOf(order.cancelledAt) ?? ctx.now });
      return facts;
    }
    const done = (order.fulfillments ?? []).filter((f) => f.status === "SUCCESS");
    if (str(order.displayFulfillmentStatus) === "FULFILLED" && done.length > 0) {
      const first = done[0];
      const t = first?.trackingInfo?.[0];
      const tracking = {
        ...(str(t?.url).startsWith("https://") ? { url: str(t?.url).slice(0, 300) } : {}),
        ...(str(t?.number) ? { number: str(t?.number).slice(0, 100) } : {}),
        ...(str(t?.company) ? { carrier: str(t?.company).slice(0, 100) } : {}),
      };
      facts.push({
        linkId,
        ref,
        state: "fulfilled",
        at: timeOf(first?.createdAt) ?? ctx.now,
        ...(Object.keys(tracking).length > 0 ? { tracking } : {}),
      });
      const delivered = done.map((f) => (f.displayStatus === "DELIVERED" ? (timeOf(f.deliveredAt) ?? ctx.now) : null));
      if (delivered.every((d) => d !== null)) {
        facts.push({ linkId, ref, state: "delivered", at: Math.max(...(delivered as number[])) });
      }
    }
    const refunded = moneyOf(order.totalRefundedSet?.presentmentMoney);
    if (refunded && refunded.value > 0) facts.push({ linkId, ref, state: "refunded", at: ctx.now, refunded });
    return facts;
  }

  async function check(ctx: RunContext, link: KnownLink): Promise<PaymentFact[]> {
    const draft = await readDraft(ctx, link.externalId);
    if (!draft?.order || draft.status !== "COMPLETED") return [];
    const fact = paymentOf(ctx, draft, draft.order);
    return fact && fact.status === "paid" ? [fact] : [];
  }

  /**
   * What became of the draft, asked of Shopify: deleted before anyone paid is cancelled; once paid,
   * fulfilled, delivered or refunded. One fact an answer: when Shopify holds several, each is given
   * in turn, an hour apart (the inbox asks paid orders hourly), and the inbox takes the ones it can.
   */
  async function orderState(ctx: RunContext, link: KnownLink): Promise<OrderFact | null> {
    if (!gid("DraftOrder", link.externalId)) return null;
    const draft = await readDraft(ctx, link.externalId);
    if (!draft) return { linkId: link.externalId, ref: link.ref, state: "cancelled", at: ctx.now };
    if (!draft.order) return null;
    const facts = orderFacts(ctx, draft, draft.order);
    if (facts.length === 0) return null;
    return facts[Math.floor(ctx.now / HOUR_MS) % facts.length] ?? null;
  }

  /* --- webhooks Shopify sends ---------------------------------------------------------- */

  /**
   * A delivery: its signature over the exact bytes, under the app's client secret, in constant time;
   * then the ids it names. The body is Shopify's, signed, so it may say an order is not one of the
   * inbox's (not from a draft) and spare a read; it is never believed about what happened.
   * https://shopify.dev/docs/apps/build/webhooks/subscribe/https
   * https://shopify.dev/docs/apps/build/webhooks/delivery-structure
   */
  async function verify(ctx: RunContext, request: InboundRequest): Promise<HookEvent | null> {
    const ok = await verifyBase64Hmac(signingKey(ctx), request.body, request.headers.get("x-shopify-hmac-sha256"));
    if (!ok) throw new ConnectorError("refused", "The Shopify signature does not check out.");
    const topic = (request.headers.get("x-shopify-topic") ?? "").trim().toLowerCase();
    const eventId = (request.headers.get("x-shopify-webhook-id") ?? "").trim().slice(0, 200);
    const from = (request.headers.get("x-shopify-shop-domain") ?? "").trim().toLowerCase();
    // Another shop's delivery, or a topic not asked for: nothing for this connection.
    if (!Object.hasOwn(SHOPIFY_TOPICS, topic) || (from && from !== str(ctx.extra.shop))) return null;
    if (!eventId) throw new ConnectorError("refused", "A Shopify delivery with no id.");
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(request.body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const numeric = (v: unknown) =>
      typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? String(v) : "";
    const refs: string[] = [];
    if (topic.startsWith("orders/")) {
      // An order that did not come from a draft is not one the inbox made.
      if (typeof body.source_name === "string" && body.source_name !== "shopify_draft_order") return null;
      const id =
        gid("Order", body.admin_graphql_api_id) ??
        (numeric(body.id) ? `gid://shopify/Order/${numeric(body.id)}` : null);
      if (id) refs.push(id);
    } else if (topic === "refunds/create") {
      if (numeric(body.order_id)) refs.push(`gid://shopify/Order/${numeric(body.order_id)}`);
    } else if (topic === "draft_orders/delete") {
      if (numeric(body.id)) refs.push(`gid://shopify/DraftOrder/${numeric(body.id)}`);
    } else if (topic.startsWith("products/")) {
      const id =
        gid("Product", body.admin_graphql_api_id) ??
        (numeric(body.id) ? `gid://shopify/Product/${numeric(body.id)}` : null);
      if (id) refs.push(id);
    }
    return { eventId, topic, refs };
  }

  /** The draft an order came from: by the tag it kept, else among the inbox's latest completed drafts. */
  async function draftOfOrder(ctx: RunContext, order: OrderNode): Promise<DraftNode | null> {
    const ref = refOf(order.tags);
    if (ref) {
      const found = await findDraft(ctx, ref);
      if (found && str(found.order?.id) === str(order.id)) return found;
    }
    const recent = await call<{ draftOrders?: { nodes?: DraftNode[] } }>(ctx, DRAFTS_COMPLETED);
    const match = (recent.draftOrders?.nodes ?? []).find((d) => str(d.order?.id) === str(order.id));
    return match ? { ...match, order } : null;
  }

  async function read(ctx: RunContext, event: HookEvent): Promise<HookFact[]> {
    const topic = event.topic;
    if (topic.startsWith("products/")) return [{ kind: "catalogue", externalIds: "all" }];
    if (topic === "app/uninstalled") {
      // Never the body's word: the access is asked for again, and only a refusal means it was withdrawn.
      try {
        await call(ctx, SHOP);
        return [];
      } catch (error) {
        if (error instanceof ConnectorError && (error.code === "auth" || error.code === "config")) {
          return [{ kind: "revoked" }];
        }
        throw error;
      }
    }
    const facts: HookFact[] = [];
    for (const ref of event.refs.slice(0, 5)) {
      if (topic === "draft_orders/delete") {
        const id = gid("DraftOrder", ref);
        if (id && !(await readDraft(ctx, id))) {
          facts.push({ kind: "order", fact: { linkId: id, ref: null, state: "cancelled", at: ctx.now } });
        }
        continue;
      }
      const id = gid("Order", ref);
      if (!id) continue;
      const read = await call<{ order?: OrderNode | null }>(ctx, ORDER_READ, { id });
      const order = read.order;
      if (!order) continue;
      const draft = await draftOfOrder(ctx, order);
      if (!draft) continue;
      const payment = paymentOf(ctx, draft, order);
      if (payment && payment.status === "paid") facts.push({ kind: "payment", fact: payment });
      for (const fact of orderFacts(ctx, draft, order)) facts.push({ kind: "order", fact });
    }
    return facts;
  }

  /* --- keeping it right ---------------------------------------------------------------- */

  /**
   * Every few hours, and when the inbox's address moved or it went live: the shop read again (its name
   * and currency), the access checked, and the webhooks put right at the connection's address. One
   * Shopify removed after deliveries kept failing is made again; what pointed elsewhere goes.
   */
  async function refresh(ctx: RunContext) {
    const info = await call<ShopAnswer>(ctx, SHOP);
    const s = info.shop;
    const shop = shopOf(ctx);
    const name = str(s?.name).trim().slice(0, 120) || shop;
    const extra: Record<string, unknown> = { ...ctx.extra };
    const currency = str(s?.currencyCode).toUpperCase();
    if (/^[A-Z]{3}$/.test(currency)) extra.currency = currency;
    if (/^https:\/\//.test(str(s?.primaryDomain?.url))) extra.storefront = str(s?.primaryDomain?.url);
    extra.taxes_included = s?.taxesIncluded === true;
    if (ctx.hookUrl && ctx.hooksLive !== false) {
      const target: AdminTarget = { http: ctx.http, shop, token: await tokenOf(ctx), sleep };
      const made = await ensureHooks(
        target,
        ctx.hookUrl,
        hooksOf(ctx.extra).map((h) => h.id),
      );
      for (const id of made.stale) await removeHook(target, id);
      extra.webhook = "added";
      extra.hooks = made.hooks.map(({ id, topic }) => ({ id, topic }));
      extra.hook_origin = originOf(ctx.hookUrl);
    }
    return { account: `${name} · ${shop}`, calendars: [], destinations: [], extra };
  }

  /** Read again now: webhooks still to make now that the inbox is live, or an address that moved. */
  function stale(ctx: RunContext): boolean {
    if (!ctx.hookUrl || ctx.hooksLive === false) return false;
    if (ctx.extra.webhook !== "added") return true;
    return ctx.extra.hook_origin !== originOf(ctx.hookUrl);
  }

  /** The webhooks the inbox made go. The app stays in the shop: the owner uninstalls it there. */
  async function disconnect(ctx: RunContext): Promise<void> {
    const hooks = hooksOf(ctx.extra);
    if (hooks.length === 0) return;
    const target: AdminTarget = { http: ctx.http, shop: shopOf(ctx), token: await tokenOf(ctx), sleep };
    for (const h of hooks) await removeHook(target, h.id);
  }

  /* --- signing in with the operator's app ---------------------------------------------- */

  const before = z.object({ store: storeField() });

  return {
    kind: "shopify",
    title: "Shopify",
    group: "shops",
    capabilities: ["catalogue", "shop_orders", "pay_links"],
    auth: "form",
    form: shopifyForm,
    note: "Your products come in. Accepted orders and quotes become draft orders, paid at your own Shopify checkout.",
    disconnectNote: "To end its access too, uninstall the app in Shopify: Settings → Apps.",
    presets: [
      {
        id: "oauth",
        label: "Sign in with Shopify",
        values: {},
        auth: "oauth",
        action: "Sign in with Shopify",
        consent: "Shopify will ask to let this inbox read your products and orders, and make draft orders.",
        ready: () =>
          operator ? true : "No Shopify app is set up on this server (SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).",
        whenNotReady: opts.hosted
          ? { status: "soon" }
          : {
              status: "setup",
              hint: "Add your Shopify app's SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET to this server.",
              href: DOCS,
            },
      },
    ],
    oauth: {
      before,
      authorizeUrl({ redirectUri, state, input }) {
        const shop = shopDomainOf(String(input?.store ?? ""));
        if (!operator || !shop) throw new ConnectorError("config", "Shopify cannot be signed in to here.");
        const q = new URLSearchParams({
          client_id: operator.clientId,
          scope: SHOPIFY_SCOPES.join(","),
          redirect_uri: redirectUri,
          state,
        });
        return `https://${shop}/admin/oauth/authorize?${q.toString()}`;
      },
      async exchange(ctx, { code, input }) {
        const shop = shopDomainOf(String(input?.store ?? ""));
        if (!operator || !shop) throw new ConnectorError("config", "Shopify cannot be signed in to here.");
        const grant = await exchangeCode(ctx.http, shop, operator, code, ctx.now);
        return connected(
          ctx,
          shop,
          "oauth",
          {
            access_token: grant.accessToken,
            expires_at: grant.expiresAt === null ? "" : String(grant.expiresAt),
            ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
          },
          grant.scopes,
        );
      },
    },
    connect,
    refresh,
    stale,
    disconnect,
    catalogue: { page },
    hooks: { topics: Object.keys(SHOPIFY_TOPICS), verify, read },
    payments: {
      createLink,
      closeLink,
      check,
      orderState,
      // Shopify is told by webhook at the connection's own address (`hooks`), never at the kind's.
      receive: async () => null,
      dashboardUrl: (ctx) => {
        const shop = str(ctx.extra.shop);
        return shopDomainOf(shop) ? adminUrl(shop, "/orders") : "https://admin.shopify.com/";
      },
    },
  };
}
