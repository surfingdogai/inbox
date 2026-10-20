import { hmacSha256Base64, verifyBase64Hmac } from "@surfingdog/adapters";
import {
  type CatalogueProduct,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  field,
  type OrderFact,
  type PaymentFact,
  type RunContext,
  type ShopOrder,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { type FakePlatform, fakePlatform, json } from "../../../packages/adapters/test/fakes/platform";

/**
 * A made-up shop platform for the shared base's tests (ADR-026): a store with an API key, a paged
 * catalogue, orders paid at its own checkout, signed webhooks and a key it can hand over itself. It is
 * no real platform and copies none: each track proves its own platform against fixtures written from
 * that platform's documentation. This one proves what every shop connector leans on: the catalogue
 * upsert, the shop's total rule, webhook intake by a connection's own address, the posted key, and
 * disconnecting. Its businesses are a bakery in Nairobi (KES) and a café in Melbourne (AUD).
 */

export interface ShopProduct {
  id: string;
  name: string;
  sku: string | null;
  /** Hundredths; null for a product the shop gives no price. */
  price: number | null;
  stock: number | null;
  published: boolean;
  modifiedAt: number;
}

export interface ShopOrderRecord {
  id: string;
  ref: string;
  status: "pending" | "paid" | "cancelled" | "fulfilled" | "delivered";
  total: number;
  currency: string;
  /** What the inbox sent, kept as the shop would keep it. */
  sent: ShopOrder;
  paymentId: string | null;
  paidAt: number | null;
}

export interface FakeShop {
  readonly platform: FakePlatform;
  readonly host: string;
  readonly key: { value: string };
  readonly currency: string;
  /** Tax the shop adds on top of the lines, as a fraction (0.16): none by default. */
  taxRate: number;
  readonly products: ShopProduct[];
  readonly orders: Map<string, ShopOrderRecord>;
  readonly webhooks: Map<string, { url: string; secret: string; topics: readonly string[] }>;
}

export function fakeShop(opts: { host?: string; currency?: string; key?: string; pageSize?: number } = {}): FakeShop {
  const host = opts.host ?? "kibanda.example.com";
  const base = `https://${host}`;
  const pageSize = opts.pageSize ?? 2;
  const platform = fakePlatform();
  const shop: FakeShop = {
    platform,
    host,
    key: { value: opts.key ?? "kb_live_0f9c2d1e" },
    currency: opts.currency ?? "KES",
    taxRate: 0,
    products: [],
    orders: new Map(),
    webhooks: new Map(),
  };
  const authed = (req: { headers: Headers }) => req.headers.get("authorization") === `Bearer ${shop.key.value}`;
  let n = 0;
  platform
    .on("GET", `${base}/api/me`, (req) =>
      authed(req)
        ? json({ id: `store_${host}`, name: "Kibanda Bakery", currency: shop.currency })
        : json({ error: "bad key" }, 401),
    )
    .on("GET", `${base}/api/products`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      const since = Number(req.url.searchParams.get("since") ?? "");
      const list = shop.products.filter((p) => !Number.isFinite(since) || since === 0 || p.modifiedAt >= since);
      const start = Number(req.url.searchParams.get("cursor") ?? 0);
      const page = list.slice(start, start + pageSize);
      return json({
        products: page,
        next: start + pageSize < list.length ? String(start + pageSize) : null,
      });
    })
    .on("POST", `${base}/api/orders`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      const ref = req.headers.get("idempotency-key") ?? "";
      const existing = [...shop.orders.values()].find((o) => o.ref === ref);
      if (existing) return json(view(existing));
      const sent = JSON.parse(req.body) as ShopOrder;
      const lines = sent.lines.reduce((sum, l) => sum + l.unit.value * l.quantity, 0);
      const total = lines + Math.round(lines * shop.taxRate);
      const id = `ord_${++n}`;
      const order: ShopOrderRecord = {
        id,
        ref,
        status: "pending",
        total,
        currency: shop.currency,
        sent,
        paymentId: null,
        paidAt: null,
      };
      shop.orders.set(id, order);
      return json(view(order), 201);
    })
    .on("GET", `${base}/api/orders/:id`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      const order = shop.orders.get(req.params.id ?? "");
      return order ? json(view(order)) : json({ error: "no such order" }, 404);
    })
    .on("DELETE", `${base}/api/orders/:id`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      const order = shop.orders.get(req.params.id ?? "");
      if (!order) return json({ error: "no such order" }, 404);
      if (order.status === "pending") order.status = "cancelled";
      return json(view(order));
    })
    .on("POST", `${base}/api/webhooks`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      const body = JSON.parse(req.body) as { url: string; topics: string[] };
      const id = `wh_${++n}`;
      const secret = `whsec_kb_${n}_${Math.random().toString(36).slice(2, 10)}`;
      shop.webhooks.set(id, { url: body.url, secret, topics: body.topics });
      return json({ id, secret }, 201);
    })
    .on("DELETE", `${base}/api/webhooks/:id`, (req) => {
      if (!authed(req)) return json({ error: "bad key" }, 401);
      shop.webhooks.delete(req.params.id ?? "");
      return new Response(null, { status: 204 });
    });
  const view = (o: ShopOrderRecord) => ({
    id: o.id,
    ref: o.ref,
    status: o.status,
    total: { value: o.total, currency: o.currency },
    pay_url: `${base}/checkout/${o.id}`,
    dashboard_url: `${base}/admin/orders/${o.id}`,
    payment_id: o.paymentId,
    paid_at: o.paidAt,
  });
  return shop;
}

/**
 * A delivery as the shop sends one to the connection's own address, signed with base64 HMAC-SHA-256
 * over the body; `tamper` changes one character of the signature.
 */
export async function signed(
  shop: FakeShop,
  event: { id: string; topic: string; order?: string; extra?: Record<string, unknown> },
  tamper = false,
) {
  const hook = [...shop.webhooks.values()][0];
  if (!hook) throw new Error("no webhook made");
  const body = JSON.stringify({
    id: event.id,
    topic: event.topic,
    ...(event.order ? { order_id: event.order } : {}),
    // What a shop's body carries, which the inbox never keeps nor believes.
    customer: { email: "wanjiru@example.com", phone: "+254700000000" },
    ...event.extra,
  });
  let signature = await hmacSha256Base64(hook.secret, body);
  // One byte off: the last character of the signature changed.
  if (tamper) signature = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
  return { url: hook.url, body, headers: { "content-type": "application/json", "x-kibanda-signature": signature } };
}

const shopForm = z.object({
  store_url: field(z.string().trim().min(8).max(2048), {
    label: "Shop address",
    input: "url",
    prefill: "website",
    placeholder: "https://…",
  }),
  api_key: secretField(z.string().trim().min(8).max(200), {
    label: "API key",
    steps: ["In your shop: Settings → API → New key."],
  }),
});

const TOPICS = ["order.updated", "product.updated", "ping"] as const;

/** The test shop's connector, written against the SDK as a track writes its own. */
export function fakeShopConnector(kind = "kibanda"): ConnectorDefinition {
  const call = async (
    ctx: Pick<RunContext, "http">,
    store: string,
    key: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ConnectorHttpResponse> => {
    const res = await ctx.http.request({
      method,
      url: `${store}${path}`,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) throw new ConnectorError("auth", "The shop did not take the key.", { field: "api_key" });
    if (res.status === 429) throw new ConnectorError("rate_limited", "The shop asked this inbox to wait.");
    if (res.status >= 500) throw new ConnectorError("unreachable", "The shop is not answering properly.");
    return res;
  };
  const store = (ctx: Pick<RunContext, "extra">) => String(ctx.extra.store ?? "");
  const orderOf = async (ctx: RunContext, id: string) => {
    const res = await call(ctx, store(ctx), ctx.secret.api_key ?? "", "GET", `/api/orders/${encodeURIComponent(id)}`);
    if (res.status === 404) throw new ConnectorError("not_found", "That order is not in the shop.");
    return JSON.parse(res.text) as {
      id: string;
      ref: string;
      status: string;
      total: { value: number; currency: string };
      payment_id: string | null;
      paid_at: number | null;
      dashboard_url: string;
    };
  };
  const paidFact = (o: Awaited<ReturnType<typeof orderOf>>): PaymentFact | null =>
    o.status === "paid" || o.status === "fulfilled" || o.status === "delivered"
      ? {
          status: "paid",
          linkId: o.id,
          ref: o.ref,
          paymentId: o.payment_id ?? `pay_${o.id}`,
          amount: o.total,
          method: "card",
          paidAt: o.paid_at ?? undefined,
          dashboardUrl: o.dashboard_url,
          livemode: true,
        }
      : null;
  const orderFact = (o: Awaited<ReturnType<typeof orderOf>>, now: number): OrderFact | null =>
    o.status === "cancelled"
      ? { linkId: o.id, ref: o.ref, state: "cancelled", at: now }
      : o.status === "fulfilled"
        ? { linkId: o.id, ref: o.ref, state: "fulfilled", at: now, tracking: { carrier: "Sendy", number: "KE1234" } }
        : o.status === "delivered"
          ? { linkId: o.id, ref: o.ref, state: "delivered", at: now }
          : null;
  return {
    kind,
    title: "Kibanda Shop",
    group: "shops",
    capabilities: ["catalogue", "shop_orders", "pay_links"],
    auth: "form",
    form: shopForm,
    disconnectNote: "Remove the key in your shop: Settings → API.",
    async connect(ctx, input) {
      const url = String(input.store_url ?? "").replace(/\/+$/, "");
      const key = String(input.api_key ?? "");
      let res: ConnectorHttpResponse;
      try {
        res = await call(ctx, url, key, "GET", "/api/me", undefined, {});
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "config") {
          throw new ConnectorError("config", error.message, { field: "store_url" });
        }
        throw error;
      }
      if (res.status !== 200)
        throw new ConnectorError("config", "That is not a shop this inbox knows.", { field: "store_url" });
      const me = JSON.parse(res.text) as { id: string; name: string; currency: string };
      let hookId: string | null = null;
      let hookSecret = "";
      if (ctx.hookUrl && ctx.hooksLive !== false) {
        const made = JSON.parse(
          (await call(ctx, url, key, "POST", "/api/webhooks", { url: ctx.hookUrl, topics: TOPICS })).text,
        ) as {
          id: string;
          secret: string;
        };
        hookId = made.id;
        hookSecret = made.secret;
      }
      return {
        account: me.name,
        externalId: me.id,
        secret: { api_key: key, hook_secret: hookSecret },
        extra: { store: url, hookId, currency: me.currency },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      };
    },
    catalogue: {
      async page(ctx, p) {
        const q = new URLSearchParams();
        if (p.cursor) q.set("cursor", p.cursor);
        if (p.since !== null) q.set("since", String(p.since));
        const res = await call(ctx, store(ctx), ctx.secret.api_key ?? "", "GET", `/api/products?${q}`);
        const body = JSON.parse(res.text) as { products: ShopProduct[]; next: string | null };
        const products: CatalogueProduct[] = body.products.map((s) => ({
          externalId: `p:${s.id}`,
          name: s.name,
          description: null,
          sku: s.sku,
          price: s.price === null ? null : { value: s.price, currency: String(ctx.extra.currency ?? "") },
          stock: s.stock,
          available: s.published,
        }));
        return { products, cursor: body.next };
      },
    },
    hooks: {
      topics: TOPICS,
      async verify(ctx, request) {
        const ok = await verifyBase64Hmac(
          ctx.secret.hook_secret ?? "",
          request.body,
          request.headers.get("x-kibanda-signature"),
        );
        if (!ok) throw new ConnectorError("refused", "The signature does not check out.");
        const body = JSON.parse(request.body) as { id?: string; topic?: string; order_id?: string };
        if (body.topic === "ping") return null;
        return {
          eventId: String(body.id ?? ""),
          topic: String(body.topic ?? ""),
          refs: body.order_id ? [body.order_id] : [],
        };
      },
      async read(ctx, event) {
        if (event.topic === "product.updated") return [{ kind: "catalogue", externalIds: "all" }];
        const facts = [];
        for (const ref of event.refs) {
          const order = await orderOf(ctx, ref);
          const paid = paidFact(order);
          if (paid) facts.push({ kind: "payment" as const, fact: paid });
          const fact = orderFact(order, ctx.now);
          if (fact) facts.push({ kind: "order" as const, fact });
        }
        return facts;
      },
    },
    payments: {
      async createLink(ctx, request) {
        if (!request.order) throw new ConnectorError("config", "A shop order needs the order.");
        const res = await call(ctx, store(ctx), ctx.secret.api_key ?? "", "POST", "/api/orders", request.order, {
          "idempotency-key": request.ref,
        });
        const o = JSON.parse(res.text) as {
          id: string;
          pay_url: string;
          total: { value: number; currency: string };
          dashboard_url: string;
        };
        return { externalId: o.id, url: o.pay_url, total: o.total, dashboardUrl: o.dashboard_url };
      },
      async closeLink(ctx, link) {
        await call(
          ctx,
          store(ctx),
          ctx.secret.api_key ?? "",
          "DELETE",
          `/api/orders/${encodeURIComponent(link.externalId)}`,
        );
      },
      async check(ctx, link) {
        if (!link.externalId) return [];
        const paid = paidFact(await orderOf(ctx, link.externalId));
        return paid ? [paid] : [];
      },
      async orderState(ctx, link) {
        if (!link.externalId) return null;
        return orderFact(await orderOf(ctx, link.externalId), ctx.now);
      },
      async receive() {
        return null;
      },
      dashboardUrl(ctx) {
        return `${String(ctx.extra.store ?? "")}/admin`;
      },
    },
    async disconnect(ctx) {
      const id = ctx.extra.hookId;
      if (typeof id === "string")
        await call(ctx, store(ctx), ctx.secret.api_key ?? "", "DELETE", `/api/webhooks/${id}`);
    },
  };
}
