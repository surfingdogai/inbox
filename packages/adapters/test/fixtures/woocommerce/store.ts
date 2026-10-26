import { hmacSha256Base64 } from "../../../src/connectors/hook-sign";
import { type FakePlatform, fakePlatform, json } from "../../fakes/platform";

/**
 * A made-up WooCommerce store for the connector's tests (ADR-032), answering as WooCommerce's REST API
 * v3 documents it (https://woocommerce.github.io/woocommerce-rest-api-docs/, read 20 October 2026) and
 * as its source behaves where the docs are silent:
 *
 * - keys: HTTP Basic or `consumer_key`/`consumer_secret` in the query; `woocommerce_rest_authentication_error`
 *   for a key it does not know or a read key that writes, `woocommerce_rest_cannot_view` for none at all
 *   (includes/rest-api/Authentication.php's behaviour);
 * - `/wp-json/<route>` with pretty permalinks, `/?rest_route=<route>` without, an HTML 404 otherwise;
 * - `_fields` (WordPress's global parameter), `X-WP-Total` and `X-WP-TotalPages`, `per_page` ≤ 100;
 * - orders: totals worked out as WooCommerce does on create and when lines change: each line's tax on
 *   its own total, unrounded; the order's tax rounded once; the total rounded to the store's decimals
 *   (`calculate_totals`); a line item needs a product or a SKU (orders v2 controller); `dp` sets the
 *   decimals of what is answered;
 * - webhooks: one topic each, pinged unsigned (`webhook_id=<id>`) when made, deliveries signed with the
 *   base64 HMAC-SHA-256 of the body (`X-WC-Webhook-Signature`), the whole resource as the body;
 * - the authorize endpoint: the key made, POSTed to `callback_url` as JSON, deleted unless that answers
 *   200, then the owner sent to `return_url` with `success` and `user_id` (includes/class-wc-auth.php);
 * - settings: `general` always; `tax` only while the store counts tax, as WooCommerce lists its tax
 *   settings page only then (`woocommerce_prices_include_tax`, "yes" or "no");
 * - `/data/countries/<cc>`: a country's code and its states, `{ code, name }`, as WooCommerce lists them
 *   (`WC_Countries::get_states`), an empty list for a country it has none for, 404 for no country;
 * - a webhook's delivery id made as WooCommerce makes it: of the webhook's id and the second it is sent
 *   (`get_new_delivery_id`), so two deliveries in one second share it.
 *
 * Ids and keys are made up; nothing here is any real store's. Keys are put together at run time, so no
 * file holds a string shaped like a real key.
 */

const fakeKey = (prefix: "ck" | "cs", seed: string) => [prefix, seed.repeat(40).slice(0, 40)].join("_");

export interface WooProduct {
  id: number;
  name: string;
  type: "simple" | "variable" | "grouped" | "external";
  status: "publish" | "draft" | "private" | "trash";
  sku: string;
  /** As WooCommerce writes it: "12.50", or "" for none. */
  price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: "instock" | "outofstock" | "onbackorder";
  purchasable: boolean;
  short_description: string;
  description: string;
  modified: number;
  variations?: WooVariation[];
  /** WooCommerce's "GTIN, UPC, EAN or ISBN" (9.2): as the owner typed it, "" for none. */
  global_unique_id?: string;
  /** The links to its pictures, the first its main one. */
  images?: string[];
}

export interface WooVariation {
  id: number;
  sku: string;
  price: string;
  status: "publish" | "private";
  purchasable: boolean;
  manage_stock: boolean | "parent";
  stock_quantity: number | null;
  stock_status: "instock" | "outofstock" | "onbackorder";
  attributes: { id: number; name: string; option: string }[];
  modified: number;
  global_unique_id?: string;
  /** The link to the variation's own picture, when it has one. */
  image?: string;
}

interface Line {
  id: number;
  kind: "line_items" | "fee_lines";
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  /** Before tax, in units, as given (WooCommerce keeps more decimals than it shows). */
  total: number;
  subtotal: number;
  taxable: boolean;
  meta: { key: string; value: string }[];
}

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  created: number;
  paid: number | null;
  completed: number | null;
  payment_method: string;
  transaction_id: string;
  billing: Record<string, string>;
  shipping: Record<string, string>;
  customer_note: string;
  lines: Line[];
  shipping_lines: Record<string, unknown>[];
  refunds: { id: number; reason: string; total: number }[];
  meta: { id: number; key: string; value: unknown }[];
  notes: { note: string; customer_note: boolean }[];
  order_key: string;
}

export interface WooWebhook {
  id: number;
  name: string;
  topic: string;
  delivery_url: string;
  secret: string;
  status: "active" | "paused" | "disabled";
}

export interface FakeWooStore {
  readonly platform: FakePlatform;
  readonly host: string;
  readonly base: string;
  readonly keys: Map<string, { secret: string; permissions: "read" | "write" | "read_write"; description: string }>;
  readonly products: WooProduct[];
  readonly orders: Map<number, WooOrder>;
  readonly webhooks: Map<number, WooWebhook>;
  /** Pings the store sent when a webhook was made: where, and the body. */
  readonly pings: { url: string; body: string }[];
  /** The countries whose states the store was asked for, in order. */
  readonly countriesAsked: string[];
  settings: {
    name: string;
    currency: string;
    calcTaxes: boolean;
    pricesIncludeTax: boolean;
    /** One standard rate for every line, as a fraction (0.18). */
    rate: number;
    decimals: number;
  };
  /** Faults a store's host can have. */
  quirks: { plainPermalinks: boolean; dropsAuthHeader: boolean; noWooCommerce: boolean; firewallPage: boolean };
  /** The pair the store made by hand in its admin, for the keys way. */
  readonly manual: { readonly key: string; readonly secret: string };
  /** Turns a key pair into one the store knows, with a permission. */
  addKey(key: string, secret: string, permissions?: "read" | "write" | "read_write"): void;
  /** The customer pays at the store's checkout, with a gateway. */
  pay(id: number, gateway?: string, transaction?: string): void;
  complete(id: number, tracking?: Record<string, string>): void;
  refund(id: number, amount: number): void;
  setStatus(id: number, status: string): void;
  /** A signed delivery of a webhook's topic about a resource, as the store sends one. */
  delivery(
    topic: string,
    resourceId: number,
    opts?: { tamper?: boolean; deliveryId?: string },
  ): Promise<SignedDelivery>;
  /**
   * The owner approves on the store's Approve page: the key made, POSTed to the callback by `post`
   * (the inbox), deleted unless it answered 200, and where the owner's browser is sent.
   */
  approve(
    authorizeUrl: string,
    post: (url: string, body: string) => Response | Promise<Response>,
    opts?: { deny?: boolean; permissions?: "read" | "read_write" },
  ): Promise<{ location: string; posted: number | null }>;
}

export interface SignedDelivery {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** Some of the states WooCommerce lists for a country (i18n/states.php), by its own codes. */
const STATES: Readonly<Record<string, readonly { code: string; name: string }[]>> = {
  BR: [
    { code: "RJ", name: "Rio de Janeiro" },
    { code: "SP", name: "S&atilde;o Paulo" },
    { code: "MG", name: "Minas Gerais" },
  ],
  CA: [
    { code: "ON", name: "Ontario" },
    { code: "QC", name: "Quebec" },
    { code: "BC", name: "British Columbia" },
  ],
  IN: [
    { code: "KA", name: "Karnataka" },
    { code: "MH", name: "Maharashtra" },
    { code: "TN", name: "Tamil Nadu" },
  ],
  JP: [
    { code: "JP13", name: "Tokyo" },
    { code: "JP27", name: "Osaka" },
  ],
  KE: [],
};

/** A WooCommerce error, as its REST API answers one. */
export function wooError(status: number, code: string, message: string): Response {
  return json({ code, message, data: { status } }, status);
}

export function fakeWooStore(
  opts: { host?: string; path?: string; name?: string; currency?: string; www?: boolean } = {},
): FakeWooStore {
  const host = opts.host ?? "pizzaria-bixiga.example.com";
  const path = opts.path ?? "";
  const base = `https://${opts.www ? "www." : ""}${host}${path}`;
  const platform = fakePlatform();
  const manual = { key: fakeKey("ck", "a1b2"), secret: fakeKey("cs", "c3d4") };
  let nextId = 900;
  const store: FakeWooStore = {
    platform,
    host,
    base,
    keys: new Map([[manual.key, { secret: manual.secret, permissions: "read_write", description: "Agent inbox" }]]),
    products: [],
    orders: new Map(),
    webhooks: new Map(),
    pings: [],
    countriesAsked: [],
    settings: {
      name: opts.name ?? "Pizzaria Bixiga",
      currency: opts.currency ?? "BRL",
      calcTaxes: false,
      pricesIncludeTax: false,
      rate: 0,
      decimals: 2,
    },
    quirks: { plainPermalinks: false, dropsAuthHeader: false, noWooCommerce: false, firewallPage: false },
    manual,
    addKey(key, secret, permissions = "read_write") {
      store.keys.set(key, { secret, permissions, description: "Agent inbox" });
    },
    pay(id, gateway = "stripe", transaction = `pi_${id}FAKE`) {
      const o = must(id);
      // Cash on delivery goes to processing at checkout too, and WooCommerce stamps date_paid all the same.
      o.status = "processing";
      o.payment_method = gateway;
      o.transaction_id = gateway === "cod" ? "" : transaction;
      o.paid = Date.now();
    },
    complete(id, tracking) {
      const o = must(id);
      o.status = "completed";
      o.completed = Date.now();
      if (o.paid === null) o.paid = Date.now();
      if (tracking) o.meta.push({ id: ++nextId, key: "_wc_shipment_tracking_items", value: [tracking] });
    },
    refund(id, amount) {
      const o = must(id);
      o.refunds.unshift({ id: ++nextId, reason: "", total: amount });
      const left = totals(o).total - o.refunds.reduce((s, r) => s + r.total, 0);
      if (left <= 0.000001) o.status = "refunded";
    },
    setStatus(id, status) {
      must(id).status = status;
    },
    async delivery(topic, resourceId, d = {}) {
      const hooks = [...store.webhooks.values()];
      const hook =
        hooks.find((w) => w.topic === topic && w.status === "active") ?? hooks.find((w) => w.topic === topic);
      if (!hook) throw new Error(`no webhook for ${topic}`);
      const resource = topic.startsWith("order.") ? orderView(must(resourceId), 2) : productById(resourceId);
      const body = JSON.stringify(resource);
      let signature = await hmacSha256Base64(hook.secret, body);
      if (d.tamper) signature = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
      const [resourceName, event] = topic.split(".");
      return {
        url: hook.delivery_url,
        body,
        headers: {
          "content-type": "application/json",
          "x-wc-webhook-source": `${base}/`,
          "x-wc-webhook-topic": topic,
          "x-wc-webhook-resource": resourceName ?? "",
          "x-wc-webhook-event": event ?? "",
          "x-wc-webhook-signature": signature,
          "x-wc-webhook-id": String(hook.id),
          // wp_hash( $webhook_id . strtotime( 'now' ) ): the same for every delivery of a webhook in one second.
          "x-wc-webhook-delivery-id":
            d.deliveryId ?? `${hook.id.toString(16)}${Math.floor(Date.now() / 1000).toString(16)}`.padEnd(32, "0"),
        },
      };
    },
    async approve(authorizeUrl, post, a = {}) {
      const url = new URL(authorizeUrl);
      if (url.host.replace(/^www\./, "") !== host || url.pathname !== `${path}/wc-auth/v1/authorize`) {
        throw new Error(`not this store's authorize endpoint: ${authorizeUrl}`);
      }
      const q = url.searchParams;
      for (const p of ["app_name", "scope", "user_id", "return_url", "callback_url"]) {
        if (!q.get(p)) throw new Error(`authorize without ${p}`);
      }
      if (!/^https:\/\//i.test(q.get("callback_url") ?? "")) throw new Error("The callback_url needs to be over SSL");
      const back = (success: 0 | 1) => {
        const to = new URL(q.get("return_url") ?? "");
        to.searchParams.set("success", String(success));
        to.searchParams.set("user_id", q.get("user_id") ?? "");
        return to.toString();
      };
      if (a.deny) return { location: back(0), posted: null };
      const key = fakeKey("ck", (++nextId).toString(16));
      const secret = fakeKey("cs", (++nextId).toString(16));
      const permissions = a.permissions ?? (q.get("scope") === "read_write" ? "read_write" : "read");
      store.keys.set(key, { secret, permissions, description: `${q.get("app_name")} - API (now)` });
      const answer = await post(
        q.get("callback_url") ?? "",
        JSON.stringify({
          key_id: nextId,
          user_id: q.get("user_id"),
          consumer_key: key,
          consumer_secret: secret,
          key_permissions: permissions,
        }),
      );
      if (answer.status !== 200) {
        // WooCommerce deletes the key it made when the callback does not answer 200.
        store.keys.delete(key);
        return { location: "", posted: answer.status };
      }
      return { location: back(1), posted: 200 };
    },
  };

  const must = (id: number): WooOrder => {
    const o = store.orders.get(id);
    if (!o) throw new Error(`no order ${id}`);
    return o;
  };

  const productById = (id: number): Record<string, unknown> => {
    for (const p of store.products) {
      if (p.id === id) return productView(p);
      const v = p.variations?.find((x) => x.id === id);
      if (v) return { ...variationView(v, p), parent_id: p.id };
    }
    return { id };
  };

  /* --- views, as WooCommerce answers them ------------------------------------------------------- */

  const gmt = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 19));
  const fixed = (n: number, dp: number) => (Math.round(n * 10 ** dp) / 10 ** dp).toFixed(dp);

  const productView = (p: WooProduct) => ({
    id: p.id,
    name: p.name,
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    permalink: `${base}/product/${p.id}/`,
    date_modified_gmt: gmt(p.modified),
    type: p.type,
    status: p.status,
    description: p.description,
    short_description: p.short_description,
    sku: p.sku,
    price: p.price,
    regular_price: p.price,
    sale_price: "",
    purchasable: p.purchasable,
    manage_stock: p.manage_stock,
    stock_quantity: p.stock_quantity,
    stock_status: p.stock_status,
    variations: (p.variations ?? []).map((v) => v.id),
    global_unique_id: p.global_unique_id ?? "",
    images: (p.images ?? []).map((src, i) => ({ id: p.id * 100 + i, src, name: "", alt: "" })),
    meta_data: [],
  });

  // A variation's page is its product's, with its options in the query, as WooCommerce links it.
  const variationView = (v: WooVariation, parent?: WooProduct) => ({
    id: v.id,
    ...(parent
      ? {
          permalink: `${base}/product/${parent.id}/?${v.attributes
            .map((a) => `attribute_${encodeURIComponent(a.name.toLowerCase())}=${encodeURIComponent(a.option)}`)
            .join("&")}`,
        }
      : {}),
    date_modified_gmt: gmt(v.modified),
    description: "",
    sku: v.sku,
    price: v.price,
    regular_price: v.price,
    status: v.status,
    purchasable: v.purchasable,
    manage_stock: v.manage_stock,
    stock_quantity: v.stock_quantity,
    stock_status: v.stock_status,
    attributes: v.attributes,
    global_unique_id: v.global_unique_id ?? "",
    image: v.image ? { id: v.id * 100, src: v.image, name: "", alt: "" } : null,
    meta_data: [],
  });

  const lineTax = (o: WooOrder, l: Line) =>
    store.settings.calcTaxes && l.taxable && o.currency === store.settings.currency ? l.total * store.settings.rate : 0;

  const totals = (o: WooOrder) => {
    const lines = o.lines.reduce((s, l) => s + l.total, 0);
    const tax =
      Math.round(o.lines.reduce((s, l) => s + lineTax(o, l), 0) * 10 ** store.settings.decimals) /
      10 ** store.settings.decimals;
    const total = Math.round((lines + tax) * 10 ** store.settings.decimals) / 10 ** store.settings.decimals;
    return { tax, total };
  };

  const lineView = (o: WooOrder, l: Line, dp: number) => {
    const tax = lineTax(o, l);
    const common = {
      id: l.id,
      name: l.name,
      total: fixed(l.total, dp),
      total_tax: fixed(tax, dp),
      taxes: tax > 0 ? [{ id: 1, total: fixed(tax, 6), subtotal: fixed(tax, 6) }] : [],
      meta_data: l.meta.map((m, i) => ({ id: l.id * 10 + i, key: m.key, value: m.value })),
    };
    return l.kind === "line_items"
      ? {
          ...common,
          product_id: l.product_id,
          variation_id: l.variation_id,
          quantity: l.quantity,
          subtotal: fixed(l.subtotal, dp),
          sku: "",
          price: l.quantity > 0 ? Number((l.total / l.quantity).toFixed(6)) : 0,
        }
      : { ...common, tax_status: l.taxable ? "taxable" : "none", tax_class: "" };
  };

  const orderView = (o: WooOrder, dp: number) => {
    const t = totals(o);
    return {
      id: o.id,
      parent_id: 0,
      status: o.status,
      currency: o.currency,
      prices_include_tax: store.settings.pricesIncludeTax,
      date_created_gmt: gmt(o.created),
      date_paid_gmt: gmt(o.paid),
      date_completed_gmt: gmt(o.completed),
      total: fixed(t.total, dp),
      total_tax: fixed(t.tax, dp),
      customer_id: 0,
      order_key: o.order_key,
      billing: o.billing,
      shipping: o.shipping,
      payment_method: o.payment_method,
      transaction_id: o.transaction_id,
      customer_note: o.customer_note,
      created_via: "rest-api",
      line_items: o.lines.filter((l) => l.kind === "line_items").map((l) => lineView(o, l, dp)),
      fee_lines: o.lines.filter((l) => l.kind === "fee_lines").map((l) => lineView(o, l, dp)),
      shipping_lines: o.shipping_lines,
      refunds: o.refunds.map((r) => ({
        id: r.id,
        reason: r.reason,
        total: `-${fixed(r.total, dp)}`,
        total_tax: "0.00",
      })),
      meta_data: o.meta,
      payment_url: `${base}/checkout/order-pay/${o.id}/?pay_for_order=true&key=${o.order_key}`,
    };
  };

  /** WordPress's `_fields`: only the top-level fields asked for. */
  const only = (body: unknown, fields: string | null): unknown => {
    if (!fields) return body;
    const keep = new Set(fields.split(",").map((f) => f.trim().split(".")[0]));
    const pick = (o: unknown) =>
      o && typeof o === "object" && !Array.isArray(o)
        ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => keep.has(k)))
        : o;
    return Array.isArray(body) ? body.map(pick) : pick(body);
  };

  const paged = (list: unknown[], q: URLSearchParams, fields: string | null) => {
    const perPage = Math.min(100, Math.max(1, Number(q.get("per_page") ?? 10)));
    const page = Math.max(1, Number(q.get("page") ?? 1));
    const pages = Math.ceil(list.length / perPage);
    return json(only(list.slice((page - 1) * perPage, page * perPage), fields), 200, {
      "x-wp-total": String(list.length),
      "x-wp-totalpages": String(pages),
    });
  };

  /* --- writing an order, as the orders controller does ------------------------------------------ */

  const lineOf = (raw: Record<string, unknown>, kind: Line["kind"], existing?: Line): Line | Response => {
    if (kind === "line_items" && !existing) {
      const pid = Number(raw.product_id ?? 0);
      const vid = Number(raw.variation_id ?? 0);
      if (!pid && !vid && !raw.sku) {
        return wooError(400, "woocommerce_rest_required_product_reference", "Product ID or SKU is required.");
      }
      const product = store.products.find((p) => p.id === pid || p.variations?.some((v) => v.id === vid));
      if (!product)
        return wooError(
          400,
          "woocommerce_rest_invalid_product_id",
          "Product ID provided is not associated with any product.",
        );
    }
    if (kind === "fee_lines" && !existing && !raw.name) {
      return wooError(400, "woocommerce_rest_invalid_fee_item", "Fee name is required.");
    }
    const parent = store.products.find((p) => p.variations?.some((v) => v.id === Number(raw.variation_id)));
    const line: Line = existing ?? {
      id: ++nextId,
      kind,
      name:
        typeof raw.name === "string"
          ? raw.name
          : (store.products.find((p) => p.id === Number(raw.product_id))?.name ?? parent?.name ?? "Item"),
      product_id: parent ? parent.id : Number(raw.product_id ?? 0),
      variation_id: Number(raw.variation_id ?? 0),
      quantity: Number(raw.quantity ?? 1),
      total: 0,
      subtotal: 0,
      taxable: kind === "line_items" || raw.tax_status !== "none",
      meta: [],
    };
    if (raw.total !== undefined) line.total = Number(raw.total);
    if (raw.subtotal !== undefined) line.subtotal = Number(raw.subtotal);
    else if (raw.total !== undefined && kind === "line_items" && !existing) line.subtotal = line.total;
    if (raw.quantity !== undefined) line.quantity = Number(raw.quantity);
    if (Array.isArray(raw.meta_data)) {
      for (const m of raw.meta_data as { key: string; value: unknown }[])
        line.meta.push({ key: m.key, value: String(m.value) });
    }
    return line;
  };

  const route = async (method: string, r: string, q: URLSearchParams, body: string, headers: Headers) => {
    const fields = q.get("_fields");
    const dp = q.has("dp") ? Number(q.get("dp")) : store.settings.decimals;
    if (r === "/" && method === "GET") {
      return json(
        only(
          {
            name: store.settings.name,
            description: "",
            url: base,
            home: base,
            namespaces: ["wp/v2", ...(store.quirks.noWooCommerce ? [] : ["wc/v3", "wc-telemetry"])],
          },
          fields,
        ),
      );
    }
    if (!r.startsWith("/wc/v3/") || store.quirks.noWooCommerce) {
      return wooError(404, "rest_no_route", "No route was found matching the URL and request method.");
    }
    // Who is asking: HTTP Basic, or the pair in the query.
    let key = q.get("consumer_key");
    let secret = q.get("consumer_secret");
    const auth = headers.get("authorization") ?? "";
    if (!store.quirks.dropsAuthHeader && auth.startsWith("Basic ")) {
      const [k, s] = atob(auth.slice(6)).split(":");
      key = k ?? null;
      secret = s ?? null;
    }
    if (!key) {
      return wooError(401, "woocommerce_rest_cannot_view", "Sorry, you cannot list resources.");
    }
    const known = store.keys.get(key);
    if (!known) return wooError(401, "woocommerce_rest_authentication_error", "Consumer key is invalid.");
    if (known.secret !== secret)
      return wooError(401, "woocommerce_rest_authentication_error", "Consumer secret is invalid.");
    if (method !== "GET" && known.permissions === "read") {
      return wooError(
        401,
        "woocommerce_rest_authentication_error",
        "The API key provided does not have write permissions.",
      );
    }
    const parts = r.split("/").filter(Boolean).slice(2);
    const [what, idRaw, sub] = parts;
    const id = Number(idRaw);
    if (what === "settings" && idRaw === "general" && method === "GET") {
      return json(
        only(
          [
            { id: "woocommerce_store_address", label: "Address line 1", value: "Rua 13 de Maio, 100" },
            { id: "woocommerce_currency", label: "Currency", value: store.settings.currency },
            {
              id: "woocommerce_calc_taxes",
              label: "Enable tax rates and calculations",
              value: store.settings.calcTaxes ? "yes" : "no",
            },
            {
              id: "woocommerce_price_num_decimals",
              label: "Number of decimals",
              value: String(store.settings.decimals),
            },
          ],
          fields,
        ),
      );
    }
    if (what === "settings" && idRaw === "tax" && method === "GET") {
      if (!store.settings.calcTaxes) {
        return wooError(404, "rest_setting_setting_group_invalid", "Invalid setting group.");
      }
      const setting = {
        id: "woocommerce_prices_include_tax",
        label: "Prices entered with tax",
        type: "radio",
        default: "no",
        value: store.settings.pricesIncludeTax ? "yes" : "no",
      };
      if (sub === "woocommerce_prices_include_tax") return json(only(setting, fields));
      if (!sub) return json(only([setting], fields));
      return wooError(404, "rest_setting_setting_invalid", "Invalid setting.");
    }
    if (what === "data" && idRaw === "countries" && method === "GET") {
      const cc = (sub ?? "").toUpperCase();
      const states = STATES[cc];
      if (!states)
        return wooError(
          404,
          "woocommerce_rest_data_invalid_location",
          "There are no locations matching these parameters.",
        );
      store.countriesAsked.push(cc);
      return json(only({ code: cc, name: cc, states }, fields));
    }
    if (what === "products" && !idRaw && method === "GET") {
      const status = q.get("status") ?? "any";
      const after = q.get("modified_after");
      const since = after ? Date.parse(`${after}Z`) : null;
      const list = store.products
        .filter((p) => (status === "any" ? p.status !== "trash" : p.status === status))
        .filter((p) => since === null || p.modified > since)
        .sort((a, b) => a.id - b.id)
        .map(productView);
      return paged(list, q, fields);
    }
    if (what === "products" && sub === "variations" && method === "GET") {
      const p = store.products.find((x) => x.id === id);
      if (!p) return wooError(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
      return paged(
        (p.variations ?? []).map((v) => variationView(v, p)),
        q,
        fields,
      );
    }
    if (what === "orders" && !idRaw && method === "GET") {
      const after = q.get("after");
      const since = after ? Date.parse(`${after}Z`) : null;
      const list = [...store.orders.values()]
        .filter((o) => o.status !== "trash" && (since === null || o.created > since))
        .sort((a, b) => b.created - a.created || b.id - a.id)
        .map((o) => orderView(o, dp));
      return paged(list, q, fields);
    }
    if (what === "orders" && !idRaw && method === "POST") {
      const input = JSON.parse(body) as Record<string, unknown>;
      const lines: Line[] = [];
      for (const kind of ["line_items", "fee_lines"] as const) {
        for (const raw of (input[kind] as Record<string, unknown>[] | undefined) ?? []) {
          const line = lineOf(raw, kind);
          if (line instanceof Response) return line;
          lines.push(line);
        }
      }
      const billing = (input.billing ?? {}) as Record<string, string>;
      if (billing.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(billing.email)) {
        return wooError(400, "rest_invalid_param", "Invalid parameter(s): billing");
      }
      const o: WooOrder = {
        id: ++nextId,
        status: typeof input.status === "string" ? input.status : "pending",
        currency: typeof input.currency === "string" ? input.currency : store.settings.currency,
        created: Date.now(),
        paid: null,
        completed: null,
        payment_method: "",
        transaction_id: "",
        billing,
        shipping: (input.shipping ?? {}) as Record<string, string>,
        customer_note: typeof input.customer_note === "string" ? input.customer_note : "",
        lines,
        shipping_lines: (input.shipping_lines as Record<string, unknown>[] | undefined) ?? [],
        refunds: [],
        meta: ((input.meta_data as { key: string; value: unknown }[] | undefined) ?? []).map((m) => ({
          id: ++nextId,
          key: m.key,
          value: m.value,
        })),
        notes: [],
        order_key: `wc_order_${(nextId * 7919).toString(36)}`,
      };
      store.orders.set(o.id, o);
      return json(only(orderView(o, dp), fields), 201);
    }
    if (what === "orders" && idRaw && !sub) {
      const o = store.orders.get(id);
      if (!o || (o.status === "trash" && method !== "GET")) {
        return wooError(404, "woocommerce_rest_shop_order_invalid_id", "Invalid ID.");
      }
      if (method === "GET") return json(only(orderView(o, dp), fields));
      if (method === "PUT") {
        const input = JSON.parse(body) as Record<string, unknown>;
        for (const kind of ["line_items", "fee_lines"] as const) {
          for (const raw of (input[kind] as Record<string, unknown>[] | undefined) ?? []) {
            const existing = o.lines.find((l) => l.id === Number(raw.id) && l.kind === kind);
            const line = lineOf(raw, kind, existing);
            if (line instanceof Response) return line;
            if (!existing) o.lines.push(line);
          }
        }
        if (typeof input.status === "string") o.status = input.status;
        return json(only(orderView(o, dp), fields));
      }
    }
    if (what === "orders" && sub === "notes" && method === "POST") {
      const o = store.orders.get(id);
      if (!o) return wooError(404, "woocommerce_rest_shop_order_invalid_id", "Invalid ID.");
      const input = JSON.parse(body) as { note: string; customer_note?: boolean };
      o.notes.push({ note: input.note, customer_note: input.customer_note === true });
      return json(only({ id: ++nextId, note: input.note, customer_note: input.customer_note === true }, fields), 201);
    }
    if (what === "webhooks" && !idRaw && method === "GET") {
      const search = (q.get("search") ?? "").toLowerCase();
      const list = [...store.webhooks.values()]
        .filter((w) => !search || w.name.toLowerCase().includes(search))
        .map((w) => ({ id: w.id, name: w.name, status: w.status, topic: w.topic, delivery_url: w.delivery_url }));
      return paged(list, q, fields);
    }
    if (what === "webhooks" && !idRaw && method === "POST") {
      const input = JSON.parse(body) as Record<string, string>;
      if (!input.topic || !input.delivery_url)
        return wooError(400, "rest_missing_callback_param", "Missing parameter(s): topic, delivery_url");
      const w: WooWebhook = {
        id: ++nextId,
        name: input.name ?? "Webhook",
        topic: input.topic,
        delivery_url: input.delivery_url,
        secret: input.secret ?? "generated",
        status: "active",
      };
      store.webhooks.set(w.id, w);
      // Pinged once, unsigned, when made.
      store.pings.push({ url: w.delivery_url, body: `webhook_id=${w.id}` });
      return json(
        only({ id: w.id, name: w.name, status: w.status, topic: w.topic, delivery_url: w.delivery_url }, fields),
        201,
      );
    }
    if (what === "webhooks" && idRaw) {
      const w = store.webhooks.get(id);
      if (!w) return wooError(404, "woocommerce_rest_webhook_invalid_id", "Invalid ID.");
      if (method === "PUT") {
        const input = JSON.parse(body) as Record<string, string>;
        if (input.delivery_url) w.delivery_url = input.delivery_url;
        if (input.secret) w.secret = input.secret;
        if (input.status) w.status = input.status as WooWebhook["status"];
        if (input.name) w.name = input.name;
        return json(only({ id: w.id, status: w.status }, fields));
      }
      if (method === "DELETE") {
        if (q.get("force") !== "true")
          return wooError(501, "woocommerce_rest_trash_not_supported", "Webhooks do not support trashing.");
        store.webhooks.delete(id);
        return json(only({ id: w.id }, fields));
      }
    }
    return wooError(404, "rest_no_route", "No route was found matching the URL and request method.");
  };

  const htmlPage = (status: number) =>
    new Response("<!doctype html><title>Not found</title><p>Nothing here.</p>", {
      status,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });

  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    for (const served of opts.www ? [host, `www.${host}`] : [host]) {
      platform.on(method, `https://${served}/*`, async (req) => {
        // A site whose WordPress address is www.: the bare host sends everyone there.
        if (opts.www && req.url.host === host) {
          return new Response(null, {
            status: 301,
            headers: { location: `https://www.${host}${req.url.pathname}${req.url.search}` },
          });
        }
        const q = req.url.searchParams;
        const p = req.url.pathname;
        if (store.quirks.firewallPage) return htmlPage(200);
        let r: string | null = null;
        if (p.startsWith(`${path}/wp-json`)) {
          if (store.quirks.plainPermalinks) return htmlPage(404);
          r = p.slice(`${path}/wp-json`.length) || "/";
        } else if ((p === `${path}/` || p === path) && q.has("rest_route")) {
          r = q.get("rest_route") ?? "/";
        }
        if (r === null) return htmlPage(404);
        return route(method, r, q, req.body, req.headers);
      });
    }
  }
  return store;
}

/** A simple product, as the store's admin makes one; modified a minute ago unless said otherwise. */
export function simple(id: number, name: string, price: string, extra: Partial<WooProduct> = {}): WooProduct {
  return {
    id,
    name,
    type: "simple",
    status: "publish",
    sku: "",
    price,
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    purchasable: price !== "",
    short_description: "",
    description: "",
    modified: Date.now() - 60_000,
    ...extra,
  };
}

/** A variable product with its variations. */
export function variable(
  id: number,
  name: string,
  variations: WooVariation[],
  extra: Partial<WooProduct> = {},
): WooProduct {
  return { ...simple(id, name, "", { purchasable: false }), type: "variable", variations, ...extra };
}

export function variation(id: number, option: string, price: string, extra: Partial<WooVariation> = {}): WooVariation {
  return {
    id,
    sku: "",
    price,
    status: "publish",
    purchasable: price !== "",
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    attributes: [{ id: 1, name: "Tamanho", option }],
    modified: Date.now() - 60_000,
    ...extra,
  };
}
