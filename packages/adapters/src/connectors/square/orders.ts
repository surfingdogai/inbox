import {
  ConnectorError,
  type KnownLink,
  type OrderFact,
  type PayLink,
  type PayLinkRequest,
  type PaymentFact,
  type PaymentsHandler,
  type PostalAddress,
  type RunContext,
  type ShopOrder,
} from "@surfingdog/core";
import { extraOf, locationOf } from "./account";
import { arr, fromSquare, msOf, obj, refusal, type SquareApi, type SquareEnv, str, toSquare } from "./api";

/**
 * Orders paid at the business's own Square checkout (ADR-026 §2, ADR-029). Each order the inbox
 * accepts becomes a Square order and its payment link in one call (`CreatePaymentLink` with an
 * `order`): items of the catalogue by their own id, at Square's price; anything else by name at the
 * inbox's; a pickup or a delivery as the order says. The link is Square's checkout in the business's
 * name, paid into its own account. Never an `app_fee_money`, never card details, never a share.
 *
 * Square's total is read back from the order it made: with the taxes the seller set in Square, it may
 * be more than the customer accepted, and the base then holds the link. Paid is a tender on the order
 * whose payment Square says is `COMPLETED`, read with the business's key; the order's reference is the
 * inbox's own id for the link, so the facts find it however they arrive. A link the inbox closes is
 * deleted, which cancels its order: so the order is read first, and a link that was paid meanwhile is
 * never deleted. Amounts are Square's smallest unit, kept here in hundredths (`fromSquare`, `toSquare`).
 *
 * - https://developer.squareup.com/docs/checkout-api/square-order-checkout
 * - https://developer.squareup.com/docs/checkout-api/optional-checkout-configurations
 * - https://developer.squareup.com/docs/checkout-api/manage-checkout#delete-a-payment-link
 * - https://developer.squareup.com/docs/orders-api/fulfillments
 * - https://developer.squareup.com/reference/square/payments-api/get-payment
 */

type Api = (ctx: RunContext) => Promise<SquareApi>;
type Obj = Record<string, unknown>;

/** The business's own Square Dashboard (or, for a Sandbox token, the Developer Console that opens it). */
export function dashboardOf(env: SquareEnv): string {
  return env === "sandbox" ? "https://developer.squareup.com/apps" : "https://app.squareup.com/dashboard";
}

/** The link's id and its order's, as one: deleting needs the first, reading back the second. */
function idsOf(externalId: string | null): { link: string; order: string } | null {
  const [link, order] = (externalId ?? "").split(":");
  return link && order ? { link, order } : null;
}

/** A phone number Square takes as it is: written with its country code. */
function phoneOf(raw: string | null): string | null {
  const p = (raw ?? "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
}

function addressOf(a: PostalAddress | null): Obj | null {
  if (!a?.streetAddress && !a?.addressLocality) return null;
  return {
    ...(a.streetAddress ? { address_line_1: a.streetAddress.slice(0, 500) } : {}),
    ...(a.addressLocality ? { locality: a.addressLocality.slice(0, 300) } : {}),
    ...(a.addressRegion ? { administrative_district_level_1: a.addressRegion.slice(0, 200) } : {}),
    ...(a.postalCode ? { postal_code: a.postalCode.slice(0, 12) } : {}),
    ...(a.addressCountry ? { country: a.addressCountry.toUpperCase() } : {}),
  };
}

/**
 * How the order is handed over: a pickup at its time, or as soon as it can be; a shipment to the
 * customer's address. A digital order, or one that does not say, has none: Square adds its own.
 */
function fulfillmentOf(order: ShopOrder, reference: string, now: number): Obj[] {
  const c = order.customer;
  const recipient: Obj = {
    // An erased customer is nobody: the order is named by its reference only.
    display_name: (c.name ?? `Order ${reference}`).slice(0, 255),
    ...(c.email ? { email_address: c.email } : {}),
    ...(phoneOf(c.phone) ? { phone_number: phoneOf(c.phone) } : {}),
  };
  if (order.delivery === "pickup") {
    const at = order.when ? Date.parse(order.when) : Number.NaN;
    const scheduled = Number.isFinite(at) && at > now;
    return [
      {
        type: "PICKUP",
        state: "PROPOSED",
        pickup_details: {
          recipient,
          // Without a time, as soon as it can be made: Square needs a time, and now is the honest one.
          schedule_type: scheduled ? "SCHEDULED" : "ASAP",
          pickup_at: new Date(scheduled ? at : now).toISOString(),
          ...(order.note ? { note: `From your customer: ${order.note}`.slice(0, 500) } : {}),
        },
      },
    ];
  }
  if (order.delivery === "delivery") {
    const address = addressOf(order.shipping);
    return [
      {
        type: "SHIPMENT",
        state: "PROPOSED",
        shipment_details: {
          recipient: { ...recipient, ...(address ? { address } : {}) },
          ...(order.note ? { shipping_note: `From your customer: ${order.note}`.slice(0, 500) } : {}),
        },
      },
    ];
  }
  return [];
}

async function orderOf(api: SquareApi, id: string): Promise<Obj | null> {
  const a = await api.call("GET", `/v2/orders/${encodeURIComponent(id)}`);
  if (a.status === 404) return null;
  if (a.status !== 200) throw refusal(a, "read an order");
  return obj(a.json.order);
}

/** Waiting to be paid: open or a draft, with no payment on it yet. */
function unpaid(order: Obj): boolean {
  return (order.state === "DRAFT" || order.state === "OPEN") && arr(order.tenders).length === 0;
}

/** An order the inbox made at this connection's location: its reference is the inbox's own id for the link. */
function ours(ctx: RunContext, order: Obj, ref?: string): boolean {
  const reference = str(order.reference_id);
  if (!reference || (ref !== undefined && reference !== ref)) return false;
  return typeof order.location_id === "string" && order.location_id in extraOf(ctx).locations;
}

/** How Square says it was paid, in the receipt's words. */
function methodOf(p: Obj): string | undefined {
  const source = str(p.source_type)?.toLowerCase();
  if (source === "wallet") return str(obj(p.wallet_details).brand)?.toLowerCase() ?? "wallet";
  return source ?? undefined;
}

/** The payments on an order that Square says went through, read back one by one. */
async function paidOf(api: SquareApi, ctx: RunContext, order: Obj, linkId: string | null): Promise<PaymentFact[]> {
  const out: PaymentFact[] = [];
  for (const t of arr(order.tenders).slice(0, 5)) {
    const id = str(t.payment_id) ?? str(t.id);
    if (!id) continue;
    const a = await api.call("GET", `/v2/payments/${encodeURIComponent(id)}`);
    if (a.status === 404) continue;
    if (a.status !== 200) throw refusal(a, "read a payment");
    const p = obj(a.json.payment);
    if (p.status !== "COMPLETED" || p.order_id !== order.id) continue;
    const paidAt = msOf(p.updated_at ?? p.created_at);
    out.push({
      status: "paid",
      linkId,
      ref: str(order.reference_id),
      paymentId: id,
      amount: moneyOf(obj(p.amount_money)),
      ...(methodOf(p) ? { method: methodOf(p) } : {}),
      ...(Number.isFinite(paidAt) ? { paidAt } : {}),
      dashboardUrl: dashboardOf(extraOf(ctx).env),
      livemode: extraOf(ctx).env === "production",
    });
  }
  return out;
}

/** An amount Square gives, in hundredths here; null when it is not one this inbox can hold. */
function moneyOf(m: Obj): { value: number; currency: string } | null {
  const currency = str(m.currency)?.toUpperCase();
  const value = currency ? fromSquare(m.amount, currency) : null;
  return currency && value !== null ? { value, currency } : null;
}

/** What Square refunded of the order's payments, in all; null for nothing. */
async function refundedOf(api: SquareApi, order: Obj): Promise<{ value: number; currency: string } | null> {
  let value = 0;
  let currency = "";
  for (const r of arr(order.refunds)) {
    if (r.status !== "COMPLETED") continue;
    const m = moneyOf(obj(r.amount_money));
    if (m) {
      value += m.value;
      currency = m.currency;
    }
  }
  if (value === 0) {
    // Refunds made from the payment's own page are on the payment.
    for (const t of arr(order.tenders).slice(0, 5)) {
      const id = str(t.payment_id);
      if (!id) continue;
      const a = await api.call("GET", `/v2/payments/${encodeURIComponent(id)}`);
      if (a.status !== 200) continue;
      const m = moneyOf(obj(obj(a.json.payment).refunded_money));
      if (m && m.value > 0) {
        value += m.value;
        currency = m.currency;
      }
    }
  }
  return value > 0 && currency ? { value, currency } : null;
}

/**
 * What became of the order: cancelled; refunded (`refunds`, only when asked: polling reads refunds per
 * payment instead); ready (a pickup prepared, a shipment sent, with its tracking); picked up. A webhook
 * (`all`) gives each that holds, applied one after the other. Polling gives one at a time, and a
 * pickup picked up is said as ready: the inbox moves an order on a step at a time, and what is said
 * after that comes with Square's webhook.
 */
async function factsOf(
  api: SquareApi,
  order: Obj,
  linkId: string | null,
  opts: { readonly all: boolean; readonly now: number },
): Promise<OrderFact[]> {
  const ref = str(order.reference_id);
  const at = msOf(order.updated_at);
  const base = { linkId, ref, at: Number.isFinite(at) ? at : opts.now };
  if (order.state === "CANCELED") return [{ ...base, state: "cancelled" }];
  const out: OrderFact[] = [];
  if (opts.all) {
    const refunded = await refundedOf(api, order);
    if (refunded) out.push({ ...base, state: "refunded", refunded });
  }
  const f = arr(order.fulfillments).find((x) => x.type === "PICKUP" || x.type === "SHIPMENT");
  if (f?.type === "PICKUP" && (f.state === "PREPARED" || f.state === "COMPLETED")) {
    out.push({ ...base, state: "fulfilled" });
    if (f.state === "COMPLETED" && opts.all) out.push({ ...base, state: "delivered" });
  }
  if (f?.type === "SHIPMENT" && f.state === "COMPLETED") {
    const d = obj(f.shipment_details);
    const tracking = {
      ...(str(d.tracking_url) ? { url: String(d.tracking_url) } : {}),
      ...(str(d.tracking_number) ? { number: String(d.tracking_number) } : {}),
      ...(str(d.carrier) ? { carrier: String(d.carrier) } : {}),
    };
    out.push({ ...base, state: "fulfilled", ...(Object.keys(tracking).length > 0 ? { tracking } : {}) });
  }
  return out;
}

export function ordersHandler(apiOf: Api): PaymentsHandler {
  return {
    async createLink(ctx, request: PayLinkRequest): Promise<PayLink> {
      const order = request.order;
      if (!order) throw new ConnectorError("config", "Square makes links for orders written into it only.");
      const location = locationOf(ctx);
      const currency = extraOf(ctx).locations[location]?.currency ?? null;
      if (currency !== request.amount.currency.toUpperCase()) {
        throw new ConnectorError(
          "config",
          `This Square location sells in ${currency ?? "another currency"}, and this order is in ${request.amount.currency}. Choose the location that sells in it.`,
        );
      }
      const lines = order.lines.map((l) => {
        // An item of the catalogue, at Square's own price for it here.
        if (l.externalId) return { catalog_object_id: l.externalId, quantity: String(l.quantity) };
        const amount = toSquare(l.unit.value, l.unit.currency);
        if (amount === null) {
          throw new ConnectorError(
            "config",
            `${l.name || "A line"} has a price Square cannot take in ${l.unit.currency}.`,
          );
        }
        return {
          name: (l.name || "Item").slice(0, 500),
          quantity: String(l.quantity),
          base_price_money: { amount, currency: l.unit.currency.toUpperCase() },
        };
      });
      if (lines.length === 0) throw new ConnectorError("config", "This order has no lines to write into Square.");
      const email = order.customer.email;
      const phone = phoneOf(order.customer.phone);
      const fulfillments = fulfillmentOf(order, request.reference, ctx.now);
      const api = await apiOf(ctx);
      const a = await api.call("POST", "/v2/online-checkout/payment-links", {
        // The inbox's own id for the link: a retry makes no second order.
        idempotency_key: request.ref,
        description: request.title.slice(0, 4_000),
        payment_note: request.title.slice(0, 500),
        order: {
          location_id: location,
          reference_id: request.ref,
          line_items: lines,
          // The taxes the seller set in Square: its total is then the shop's, which the base checks.
          pricing_options: { auto_apply_taxes: true, auto_apply_discounts: false },
          ...(fulfillments.length > 0 ? { fulfillments } : {}),
        },
        ...(email || phone
          ? {
              pre_populated_data: {
                ...(email ? { buyer_email: email } : {}),
                ...(phone ? { buyer_phone_number: phone } : {}),
              },
            }
          : {}),
      });
      if (a.status !== 200) throw refusal(a, "make the order and its link to pay");
      const link = obj(a.json.payment_link);
      const linkId = str(link.id);
      const url = str(link.url) ?? str(link.long_url);
      const orderId = str(link.order_id);
      if (!linkId || !url || !orderId)
        throw new ConnectorError("bad_response", "Square did not say which link it made.");
      // What Square counts the order at: on the answer, or read back (a retry's answer may not carry it).
      // Never a link without it: Square's tax may make it more than the customer accepted.
      let made = arr(obj(a.json.related_resources).orders).find((o) => o.id === orderId) ?? null;
      if (!made) made = await orderOf(api, orderId);
      const total = moneyOf(obj(made?.total_money));
      if (!total) throw new ConnectorError("bad_response", "Square did not say what the order comes to.");
      return { externalId: `${linkId}:${orderId}`, url, total, dashboardUrl: dashboardOf(extraOf(ctx).env) };
    },

    /**
     * Deleting a link cancels its order, paid or not (https://developer.squareup.com/docs/checkout-api/manage-checkout#delete-a-payment-link):
     * so the order is read first, and only one still waiting to be paid loses its link. One paid
     * meanwhile is left as it is, and `check` says so.
     */
    async closeLink(ctx, link) {
      const ids = idsOf(link.externalId);
      if (!ids) return;
      const api = await apiOf(ctx);
      const order = await orderOf(api, ids.order);
      if (!order || !unpaid(order)) return;
      const a = await api.call("DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(ids.link)}`);
      if (a.status === 200 || a.status === 404) return;
      throw refusal(a, "close the link to pay");
    },

    async check(ctx, link: KnownLink) {
      const ids = idsOf(link.externalId);
      if (!ids) return [];
      const api = await apiOf(ctx);
      const order = await orderOf(api, ids.order);
      if (!order || !ours(ctx, order, link.ref)) return [];
      return paidOf(api, ctx, order, link.externalId);
    },

    async orderState(ctx, link) {
      const ids = idsOf(link.externalId);
      if (!ids) return null;
      const api = await apiOf(ctx);
      const order = await orderOf(api, ids.order);
      if (!order || !ours(ctx, order, link.ref)) return null;
      return (await factsOf(api, order, link.externalId, { all: false, now: ctx.now }))[0] ?? null;
    },

    /** What Square refunded of a payment, made in the Square Dashboard: the inbox's refund is then done. */
    async refunded(ctx, payment) {
      const api = await apiOf(ctx);
      const a = await api.call("GET", `/v2/payments/${encodeURIComponent(payment.paymentId)}`);
      if (a.status === 404) return null;
      if (a.status !== 200) throw refusal(a, "read a payment");
      const p = obj(a.json.payment);
      const m = moneyOf(obj(p.refunded_money));
      if (!m || m.value <= 0) return null;
      const ids = Array.isArray(p.refund_ids) ? p.refund_ids.filter((x): x is string => typeof x === "string") : [];
      return { amount: m, refundIds: [...ids].reverse() };
    },

    async receive() {
      // Square tells each connection at its own address (`hooks`), never at the kind's.
      return null;
    },

    dashboardUrl(ctx) {
      return dashboardOf(extraOf(ctx).env);
    },
  };
}

/** What a webhook about an order, a payment or a refund names, read back: payments, then what became of it. */
export async function orderFacts(
  api: SquareApi,
  ctx: RunContext,
  orderId: string,
): Promise<({ kind: "payment"; fact: PaymentFact } | { kind: "order"; fact: OrderFact })[]> {
  const order = await orderOf(api, orderId);
  if (!order || !ours(ctx, order)) return [];
  const paid = (await paidOf(api, ctx, order, null)).map((fact) => ({ kind: "payment" as const, fact }));
  const states = (await factsOf(api, order, null, { all: true, now: ctx.now })).map((fact) => ({
    kind: "order" as const,
    fact,
  }));
  return [...paid, ...states];
}
