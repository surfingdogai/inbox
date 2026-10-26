import {
  ConnectorError,
  type KnownLink,
  minorUnits,
  type OrderFact,
  type PayLink,
  type PayLinkRequest,
  type PaymentFact,
  type PaymentsHandler,
  type PostalAddress,
  type RefundFact,
  type RunContext,
  type ShopOrder,
} from "@surfingdog/core";
import { call, decimal, type Keys, metaOf, minorOf, plain, type Store } from "./api";
import { isoGmt } from "./catalogue";
import { extraOf, keysOf, markOf, storeOf } from "./state";

/**
 * Orders the inbox accepts, written into the business's own WooCommerce store and paid at its own
 * checkout (ADR-030 §2, ADR-032 §4). The store is the business's: the customer's name, email, phone and
 * address go there, and only what fulfilling needs (`ShopOrder`).
 *
 * - **Made pending**, at the inbox's prices: each line a product or variation of the store's own
 *   catalogue (`product_id`/`variation_id`, `subtotal`/`total`), and a line the store has no product
 *   for as a fee line (WooCommerce takes a product line only with a product or a SKU,
 *   https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-orders-v2-controller.php).
 *   Meta `_sdi_ref` (the inbox's id for the link), `_sdi_mark` (a mark only this inbox can make) and
 *   `_sdi_reference` (the order's reference in the business's emails). A REST order is never cancelled
 *   by WooCommerce's stock hold, which cancels checkout orders only (`wc_cancel_unpaid_orders`).
 * - **The pay link is the order's own** `payment_url`: the store's order-pay page and its own payment
 *   gateways. No money passes the inbox; no card details either.
 * - **Tax.** WooCommerce adds tax to a line's total. A store whose prices include tax would charge it
 *   twice, so the lines are written again without it, at the rate the store itself applied, to come
 *   to what the customer accepted. A store whose prices exclude tax adds it on top: its total is then
 *   not the customer's, and the link is held for the owner to propose it (ADR-030 §2).
 * - **Paid** means the store, asked with the key, says `processing` or `completed` with `date_paid`;
 *   cash on delivery only once `completed`. **Fulfilled** is `completed`; **cancelled** is
 *   `cancelled`, the bin, or gone; **refunded** is the store's refunds on the order.
 * - **Safe to ask again.** Before making an order, the store's last orders are looked through for the
 *   one this inbox made under the same id, so a retry after a lost answer makes no second order.
 * - **The region as the store knows it.** WooCommerce matches a state's tax rates on its code (ON, MH,
 *   SP), and an address's region is free text: it is written as the store's own code for it, found by
 *   code or name in the store's list for the country (`/wc/v3/data/countries/<cc>`), and left out when
 *   the store lists the country's states and none is it, as WooCommerce does for a place it does not know.
 *
 * https://woocommerce.github.io/woocommerce-rest-api-docs/#create-an-order,
 * https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties.
 */

type Raw = Record<string, unknown>;

/** What the inbox reads of an order: never the billing or shipping details it wrote. */
const ORDER_FIELDS =
  "id,status,currency,total,total_tax,prices_include_tax,date_paid_gmt,date_completed_gmt,payment_method,payment_url,line_items,fee_lines,refunds,meta_data";

/** How far back the store's orders are looked through for one this inbox made and did not hear back about. */
const FIND_WINDOW_MS = 3 * 86_400_000;
/** The most a list of orders is read up to: a store too old for `include_meta` sends all their meta. */
const ORDERS_MAX_BYTES = 8 * 1024 * 1024;
/** How long a store's list of a country's states is kept, by store and country. */
const STATES_TTL_MS = 6 * 3_600_000;
const statesKept = new Map<string, { readonly at: number; readonly states: readonly State[] }>();

interface State {
  readonly code: string;
  readonly name: string;
}

/** WooCommerce's payment gateways, in the receipt's payment words (vocab/payments.json); others are left out. */
export const WOO_METHODS: Readonly<Record<string, string>> = {
  bacs: "bank_transfer",
  cod: "cash",
  paypal: "paypal",
  "ppcp-gateway": "paypal",
  "ppcp-credit-card-gateway": "card",
  "ppcp-card-button-gateway": "card",
  stripe: "card",
  stripe_cc: "card",
  stripe_sepa: "sepa",
  stripe_sepa_debit: "sepa",
  stripe_ideal: "ideal",
  stripe_bancontact: "bancontact",
  stripe_klarna: "klarna",
  stripe_afterpay_clearpay: "afterpay",
  stripe_affirm: "affirm",
  stripe_alipay: "alipay",
  stripe_wechat_pay: "wechat_pay",
  stripe_blik: "blik",
  stripe_multibanco: "multibanco",
  stripe_oxxo: "oxxo",
  stripe_cashapp: "cash_app",
  woocommerce_payments: "card",
  square_credit_card: "card",
  square_cash_app_pay: "cash_app",
  mollie_wc_gateway_creditcard: "card",
  mollie_wc_gateway_ideal: "ideal",
  mollie_wc_gateway_bancontact: "bancontact",
  mollie_wc_gateway_paypal: "paypal",
  mollie_wc_gateway_twint: "twint",
  mollie_wc_gateway_blik: "blik",
  mollie_wc_gateway_mbway: "mb_way",
  mollie_wc_gateway_multibanco: "multibanco",
  "woo-mercado-pago-basic": "mercado_pago",
  "woo-mercado-pago-custom": "card",
  "woo-mercado-pago-pix": "pix",
};

function methodOf(gateway: unknown): string | undefined {
  if (typeof gateway !== "string") return undefined;
  const exact = WOO_METHODS[gateway];
  if (exact) return exact;
  if (/^mollie_wc_gateway_klarna/.test(gateway)) return "klarna";
  if (/^woocommerce_payments_/.test(gateway)) {
    const rest = gateway.slice("woocommerce_payments_".length);
    return WOO_METHODS[`stripe_${rest}`];
  }
  return undefined;
}

function addressOf(a: PostalAddress | null): Record<string, string> {
  if (!a) return {};
  const out: Record<string, string> = {};
  if (a.streetAddress) out.address_1 = a.streetAddress;
  if (a.addressLocality) out.city = a.addressLocality;
  if (a.addressRegion) out.state = a.addressRegion;
  if (a.postalCode) out.postcode = a.postalCode;
  if (a.addressCountry) out.country = a.addressCountry.toUpperCase();
  return out;
}

/** A place name as it is compared: no accents, no case, single spaces ("São Paulo" is "sao paulo"). */
function folded(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The store's states for a country (code and name); empty for a country it lists none for; null when it would not say. */
async function statesOf(ctx: RunContext, store: Store, keys: Keys, country: string): Promise<readonly State[] | null> {
  const key = `${store.base}|${country}`;
  const kept = statesKept.get(key);
  if (kept && ctx.now - kept.at < STATES_TTL_MS && ctx.now >= kept.at) return kept.states;
  try {
    const answer = await call(ctx.http, store, keys, "GET", `/wc/v3/data/countries/${country.toLowerCase()}`, {
      query: { _fields: "code,states" },
      maxBytes: 256 * 1024,
    });
    const list = (answer.json as { states?: unknown } | null)?.states;
    const states = (Array.isArray(list) ? (list as { code?: unknown; name?: unknown }[]) : [])
      .filter((x) => x && typeof x.code === "string" && x.code.trim())
      .map((x) => ({ code: String(x.code).trim(), name: plain(typeof x.name === "string" ? x.name : "") }));
    if (statesKept.size >= 500) statesKept.clear();
    statesKept.set(key, { at: ctx.now, states });
    return states;
  } catch (error) {
    if (error instanceof ConnectorError) return null;
    throw error;
  }
}

/**
 * The address with its region as the store's own code: matched by code or by name in the store's list
 * for the country, left out when the store lists the country's states and none matches, and kept as
 * written for a country it lists none for. When the store would not say, a region written as a code is
 * kept and a name is left out.
 */
async function storeAddress(
  ctx: RunContext,
  store: Store,
  keys: Keys,
  a: PostalAddress | null,
): Promise<PostalAddress | null> {
  const region = a?.addressRegion?.trim();
  const country = a?.addressCountry?.trim().toUpperCase();
  if (!a || !region) return a;
  const { addressRegion: _region, ...rest } = a;
  const looksLikeCode = /^[A-Za-z0-9]{1,3}$/.test(region);
  if (!country || !/^[A-Z]{2}$/.test(country))
    return looksLikeCode ? { ...rest, addressRegion: region.toUpperCase() } : rest;
  const states = await statesOf(ctx, store, keys, country);
  if (states === null) return looksLikeCode ? { ...rest, addressRegion: region.toUpperCase() } : rest;
  if (states.length === 0) return a;
  const want = folded(region);
  const found =
    states.find((s) => s.code.toUpperCase() === region.toUpperCase()) ??
    states.find((s) => folded(s.name) === want) ??
    states.find((s) => folded(`${country}-${s.code}`) === want);
  return found ? { ...rest, addressRegion: found.code } : rest;
}

/** The order as WooCommerce takes it, from what the inbox accepted. */
export function orderBody(order: ShopOrder, req: PayLinkRequest, mark: string): Raw {
  const line_items: Raw[] = [];
  const fee_lines: Raw[] = [];
  order.lines.forEach((l, i) => {
    const total = decimal(l.unit.value * l.quantity, l.unit.currency);
    const meta_data = [{ key: "_sdi_line", value: String(i) }];
    const m = /^(p|v):(\d{1,20})$/.exec(l.externalId ?? "");
    if (m) {
      line_items.push({
        [m[1] === "v" ? "variation_id" : "product_id"]: Number(m[2]),
        quantity: l.quantity,
        subtotal: total,
        total,
        meta_data,
      });
    } else {
      const name = (l.name || "Item").slice(0, 190);
      fee_lines.push({
        name: l.quantity > 1 ? `${l.quantity} × ${name}` : name,
        total,
        tax_status: "taxable",
        meta_data,
      });
    }
  });
  // A full name in one field: splitting it into first and last is wrong for most of the world's names.
  const who = order.customer;
  const billingAddress = order.billing ?? order.shipping;
  const billing: Raw = {
    first_name: who.name ?? "",
    last_name: "",
    ...(who.email ? { email: who.email } : {}),
    ...(who.phone ? { phone: who.phone } : {}),
    ...addressOf(billingAddress),
  };
  const shipping =
    order.shipping && order.delivery !== "pickup" && order.delivery !== "digital"
      ? { first_name: who.name ?? "", last_name: "", ...addressOf(order.shipping) }
      : null;
  return {
    status: "pending",
    currency: order.total.currency.toUpperCase(),
    set_paid: false,
    billing,
    ...(shipping ? { shipping } : {}),
    // The customer's own words, shown in WooCommerce as the customer's note, and as nothing else.
    ...(order.note ? { customer_note: order.note.slice(0, 2_000) } : {}),
    line_items,
    ...(fee_lines.length > 0 ? { fee_lines } : {}),
    ...(order.delivery === "pickup"
      ? { shipping_lines: [{ method_id: "local_pickup", method_title: "Pickup", total: "0.00" }] }
      : {}),
    meta_data: [
      { key: "_sdi_ref", value: req.ref },
      { key: "_sdi_mark", value: mark },
      { key: "_sdi_reference", value: req.reference },
    ],
  };
}

async function readOrder(ctx: RunContext, store: Store, keys: Keys, id: string): Promise<Raw | null> {
  if (!/^\d{1,20}$/.test(id)) return null;
  try {
    const answer = await call(ctx.http, store, keys, "GET", `/wc/v3/orders/${id}`, {
      query: { dp: 6, _fields: ORDER_FIELDS },
    });
    return answer.json && typeof answer.json === "object" ? (answer.json as Raw) : null;
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "not_found") return null;
    throw error;
  }
}

/** Whether an order is one this inbox made: its `_sdi_ref`, and the mark only this inbox makes for it. */
async function ours(ctx: RunContext, wc: Raw, ref?: string): Promise<string | null> {
  const kept = metaOf(wc, "_sdi_ref");
  if (!kept || (ref && kept !== ref)) return null;
  return metaOf(wc, "_sdi_mark") === (await markOf(ctx, kept)) ? kept : null;
}

/** The order this inbox made under `ref` before, if it is among the store's last orders. */
async function findOrder(ctx: RunContext, store: Store, keys: Keys, ref: string): Promise<Raw | null> {
  const answer = await call(ctx.http, store, keys, "GET", "/wc/v3/orders", {
    query: {
      after: isoGmt(ctx.now - FIND_WINDOW_MS),
      dates_are_gmt: "true",
      per_page: 100,
      orderby: "date",
      order: "desc",
      include_meta: "_sdi_ref,_sdi_mark",
      _fields: "id,meta_data",
    },
    maxBytes: ORDERS_MAX_BYTES,
  });
  const list = Array.isArray(answer.json) ? (answer.json as Raw[]) : [];
  for (const wc of list) {
    if (metaOf(wc, "_sdi_ref") === ref && Number.isInteger(wc.id) && (await ours(ctx, wc, ref)) === ref) {
      return readOrder(ctx, store, keys, String(wc.id));
    }
  }
  return null;
}

interface Item {
  readonly kind: "line_items" | "fee_lines";
  readonly id: number;
  /** What the customer accepted for the line, in minor units. */
  readonly gross: number;
  /** What WooCommerce holds for it before tax, and the tax it added: in units, to six decimals. */
  readonly total: number;
  readonly tax: number;
}

function itemsOf(wc: Raw, order: ShopOrder): Item[] {
  const out: Item[] = [];
  for (const kind of ["line_items", "fee_lines"] as const) {
    const list = Array.isArray(wc[kind]) ? (wc[kind] as Raw[]) : [];
    for (const it of list) {
      const index = Number(metaOf(it, "_sdi_line"));
      const line = Number.isInteger(index) ? order.lines[index] : undefined;
      if (!line || !Number.isInteger(it.id)) continue;
      const taxes = Array.isArray(it.taxes) ? (it.taxes as { total?: unknown }[]) : [];
      out.push({
        kind,
        id: Number(it.id),
        gross: line.unit.value * line.quantity,
        total: Number(it.total ?? 0),
        tax: taxes.reduce((sum, t) => sum + (Number(t?.total) || 0), 0),
      });
    }
  }
  return out;
}

/**
 * A store whose prices include tax adds it again on top of the lines it is given: each line is
 * written again without it, at the rate the store itself applied to that line (its own tax over its
 * own total), so that with tax the order comes to what the customer accepted. A second pass puts a
 * rounding cent left over on the largest line. A store whose prices exclude tax is left as it
 * counts: its total goes back to the base, which holds the link (ADR-030 §2).
 */
async function settleTotals(ctx: RunContext, store: Store, keys: Keys, wc: Raw, order: ShopOrder): Promise<Raw> {
  let current = wc;
  const currency = order.total.currency;
  // Minor units to the store's own decimals: a hundredth of a euro, a whole yen (ADR-036).
  const unit = 10 ** (minorUnits(currency) ?? 2);
  for (let pass = 0; pass < 2; pass++) {
    const total = minorOf(current.total, currency);
    if (total === null || total === order.total.value) return current;
    const tax = minorOf(current.total_tax, currency) ?? 0;
    if (current.prices_include_tax !== true || tax <= 0) return current;
    const items = itemsOf(current, order).filter((i) => i.total > 0 && i.tax > 0);
    if (items.length === 0) return current;
    const nets = new Map<Item, number>();
    if (pass === 0) {
      for (const i of items) nets.set(i, i.gross / unit / (1 + i.tax / i.total));
    } else {
      const left = order.total.value - total;
      // More than a cent a line is not rounding: what the store counts is left for the owner.
      if (Math.abs(left) > items.length) return current;
      const largest = [...items].sort((a, b) => b.gross - a.gross)[0] as Item;
      nets.set(largest, largest.total + left / unit / (1 + largest.tax / largest.total));
    }
    const body: Record<string, Raw[]> = {};
    for (const [i, net] of nets) {
      const amount = Math.max(0, net).toFixed(6);
      const list = body[i.kind] ?? [];
      list.push(i.kind === "line_items" ? { id: i.id, subtotal: amount, total: amount } : { id: i.id, total: amount });
      body[i.kind] = list;
    }
    const answer = await call(ctx.http, store, keys, "PUT", `/wc/v3/orders/${String(current.id)}`, {
      query: { dp: 6, _fields: ORDER_FIELDS },
      body,
    });
    current = (answer.json ?? current) as Raw;
  }
  return current;
}

function linkOf(store: Store, wc: Raw): PayLink {
  const id = Number(wc.id);
  const url = typeof wc.payment_url === "string" ? wc.payment_url : "";
  let pay: URL | null = null;
  try {
    pay = new URL(url);
  } catch {
    pay = null;
  }
  if (!Number.isInteger(id) || !pay) {
    throw new ConnectorError("bad_response", "Your shop made the order but did not say where it is paid.");
  }
  if (pay.protocol !== "https:") {
    throw new ConnectorError(
      "refused",
      "Your shop's checkout is not on https, so its link to pay was not sent. Set WordPress's address to https.",
    );
  }
  const currency = typeof wc.currency === "string" ? wc.currency.toUpperCase() : "";
  const total = minorOf(wc.total, currency);
  return {
    externalId: String(id),
    url: pay.toString(),
    ...(total !== null && /^[A-Z]{3}$/.test(currency) ? { total: { value: total, currency } } : {}),
    dashboardUrl: orderPage(store, id),
  };
}

/** The order in the business's WordPress admin (WooCommerce sends it on to the orders screen it uses). */
export function orderPage(store: Store, id: number | string): string {
  return `${store.base}/wp-admin/post.php?post=${encodeURIComponent(String(id))}&action=edit`;
}

async function createLink(ctx: RunContext, req: PayLinkRequest): Promise<PayLink> {
  const order = req.order;
  if (!order) throw new ConnectorError("config", "A WooCommerce order needs the order's lines.");
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  const currency = order.total.currency.toUpperCase();
  const sells = extraOf(ctx).currency;
  if (sells && sells !== currency) {
    throw new ConnectorError(
      "refused",
      `Your shop sells in ${sells}, and this order is in ${currency}, so it was not written into the shop.`,
    );
  }
  const mark = await markOf(ctx, req.ref);
  let wc = await findOrder(ctx, store, keys, req.ref);
  if (!wc) {
    const placed: ShopOrder = {
      ...order,
      shipping: await storeAddress(ctx, store, keys, order.shipping),
      billing: await storeAddress(ctx, store, keys, order.billing),
    };
    const made = await call(ctx.http, store, keys, "POST", "/wc/v3/orders", {
      query: { dp: 6, _fields: ORDER_FIELDS },
      body: orderBody(placed, req, mark),
    });
    wc = (made.json ?? {}) as Raw;
    await noteOn(ctx, store, keys, wc.id, order, req.reference);
  }
  return linkOf(store, await settleTotals(ctx, store, keys, wc, order));
}

/** A private note on the order, for the business: where it came from, and what the order says of delivery. */
async function noteOn(ctx: RunContext, store: Store, keys: Keys, id: unknown, order: ShopOrder, reference: string) {
  if (!Number.isInteger(id)) return;
  const how =
    order.delivery === "pickup"
      ? "Pickup"
      : order.delivery === "delivery"
        ? "Delivery"
        : order.delivery === "digital"
          ? "Digital"
          : null;
  const parts = [
    `Order ${reference} from your agent inbox.`,
    how ? `${how}${order.when ? `, ${order.when}` : ""}.` : "",
  ];
  try {
    await call(ctx.http, store, keys, "POST", `/wc/v3/orders/${String(id)}/notes`, {
      query: { _fields: "id" },
      body: { note: parts.filter(Boolean).join(" "), customer_note: false },
    });
  } catch (error) {
    // A courtesy to the business: the order is made either way.
    if (!(error instanceof ConnectorError)) throw error;
  }
}

/**
 * The link is no longer wanted (the order changed or ended, or was paid another way): an order the
 * store still waits to be paid for (`pending`, `failed`) is cancelled there, which WooCommerce emails
 * nobody about; one paid or on its way meanwhile is left alone, and found paid on the next look.
 */
async function closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void> {
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  const wc = await readOrder(ctx, store, keys, link.externalId);
  if (!wc || !(await ours(ctx, wc))) return;
  if (wc.status !== "pending" && wc.status !== "failed") return;
  await call(ctx.http, store, keys, "PUT", `/wc/v3/orders/${link.externalId}`, {
    query: { _fields: "id,status" },
    body: { status: "cancelled" },
  });
}

function gmtOf(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) return null;
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(at) ? at : null;
}

function paidFact(store: Store, wc: Raw, ref: string): PaymentFact | null {
  const status = String(wc.status ?? "");
  // Cash on delivery is "processing" before anyone has paid (WooCommerce stamps `date_paid` then all
  // the same): it is paid once the order is completed, when the cash was taken.
  const cash = wc.payment_method === "cod";
  const paidAt = cash ? gmtOf(wc.date_completed_gmt) : gmtOf(wc.date_paid_gmt);
  const paid = cash ? status === "completed" : (status === "processing" || status === "completed") && paidAt !== null;
  if (!paid) return null;
  const currency = typeof wc.currency === "string" ? wc.currency.toUpperCase() : "";
  const value = minorOf(wc.total, currency);
  const method = methodOf(wc.payment_method);
  return {
    status: "paid",
    linkId: String(wc.id),
    ref,
    paymentId: `order-${String(wc.id)}`,
    amount: value !== null && /^[A-Z]{3}$/.test(currency) ? { value, currency } : null,
    ...(method ? { method } : {}),
    ...(paidAt !== null ? { paidAt } : {}),
    dashboardUrl: orderPage(store, String(wc.id)),
    // A store has no test mode of its own: a gateway's sandbox pays nothing, and the order says so.
    livemode: true,
  };
}

/** Where a shipment can be followed, when the Shipment Tracking extension recorded one (its `_wc_shipment_tracking_items`). */
function trackingOf(wc: Raw): OrderFact["tracking"] {
  const list = Array.isArray(wc.meta_data) ? (wc.meta_data as { key?: unknown; value?: unknown }[]) : [];
  const items = list.find((m) => m?.key === "_wc_shipment_tracking_items")?.value;
  const last = Array.isArray(items) ? (items.at(-1) as Raw | undefined) : undefined;
  if (!last || typeof last !== "object") return undefined;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  const number = text(last.tracking_number);
  const carrier = text(last.custom_tracking_provider) ?? text(last.tracking_provider);
  const link = text(last.custom_tracking_link);
  const url = link && /^https:\/\//i.test(link) ? link : undefined;
  if (!number && !url) return undefined;
  return { ...(number ? { number } : {}), ...(carrier ? { carrier } : {}), ...(url ? { url } : {}) };
}

function stateFact(wc: Raw, ref: string, now: number): OrderFact | null {
  const status = String(wc.status ?? "");
  if (status === "cancelled" || status === "trash") return { linkId: String(wc.id), ref, state: "cancelled", at: now };
  if (status === "completed") {
    const tracking = trackingOf(wc);
    return {
      linkId: String(wc.id),
      ref,
      state: "fulfilled",
      at: gmtOf(wc.date_completed_gmt) ?? now,
      ...(tracking ? { tracking } : {}),
    };
  }
  return null;
}

function refundsOf(wc: Raw): RefundFact | null {
  const list = Array.isArray(wc.refunds) ? (wc.refunds as Raw[]) : [];
  const currency = typeof wc.currency === "string" ? wc.currency.toUpperCase() : "";
  let total = 0;
  const ids: number[] = [];
  for (const r of list) {
    const value = minorOf(r.total, currency);
    if (value === null || !Number.isInteger(r.id)) continue;
    total += Math.abs(value);
    ids.push(Number(r.id));
  }
  if (total <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount: { value: total, currency }, refundIds: ids.sort((a, b) => b - a).map(String) };
}

/** Everything a read-back says of one order this inbox made: paid, then fulfilled or cancelled, then refunded. */
export async function factsOf(
  ctx: RunContext,
  id: string,
): Promise<readonly ({ kind: "payment"; fact: PaymentFact } | { kind: "order"; fact: OrderFact })[]> {
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  const wc = await readOrder(ctx, store, keys, id);
  // Gone from the store: whatever link was made for it is no good now.
  if (!wc) return [{ kind: "order", fact: { linkId: id, ref: null, state: "cancelled", at: ctx.now } }];
  const ref = await ours(ctx, wc);
  if (!ref) return [];
  const out: ({ kind: "payment"; fact: PaymentFact } | { kind: "order"; fact: OrderFact })[] = [];
  const paid = paidFact(store, wc, ref);
  if (paid) out.push({ kind: "payment", fact: paid });
  const state = stateFact(wc, ref, ctx.now);
  if (state) out.push({ kind: "order", fact: state });
  // Refunded in full, WooCommerce says `refunded`: no longer paid, its refunds are read all the same.
  const status = String(wc.status ?? "");
  const refunds =
    paid || status === "processing" || status === "completed" || status === "refunded" ? refundsOf(wc) : null;
  if (refunds) {
    out.push({
      kind: "order",
      fact: { linkId: String(wc.id), ref, state: "refunded", at: ctx.now, refunded: refunds.amount },
    });
  }
  return out;
}

async function check(ctx: RunContext, link: KnownLink): Promise<readonly PaymentFact[]> {
  if (!link.externalId) return [];
  const store = storeOf(ctx);
  const wc = await readOrder(ctx, store, keysOf(ctx), link.externalId);
  if (!wc) return [];
  const ref = await ours(ctx, wc, link.ref || undefined);
  if (!ref) return [];
  const paid = paidFact(store, wc, ref);
  return paid ? [paid] : [];
}

async function orderState(ctx: RunContext, link: KnownLink): Promise<OrderFact | null> {
  if (!link.externalId) return null;
  const wc = await readOrder(ctx, storeOf(ctx), keysOf(ctx), link.externalId);
  if (!wc) return { linkId: link.externalId, ref: link.ref || null, state: "cancelled", at: ctx.now };
  const ref = await ours(ctx, wc, link.ref || undefined);
  return ref ? stateFact(wc, ref, ctx.now) : null;
}

async function refunded(ctx: RunContext, payment: { readonly paymentId: string }): Promise<RefundFact | null> {
  const m = /^order-(\d{1,20})$/.exec(payment.paymentId);
  if (!m) return null;
  const wc = await readOrder(ctx, storeOf(ctx), keysOf(ctx), m[1] as string);
  if (!wc || !(await ours(ctx, wc))) return null;
  return refundsOf(wc);
}

export const payments: PaymentsHandler = {
  createLink,
  closeLink,
  check,
  orderState,
  refunded,
  // Told by webhooks at the connection's own address (`hooks`), never at /v1/hooks/woocommerce.
  receive: async () => null,
  dashboardUrl: (ctx) => {
    const store = typeof ctx.extra.store === "string" ? ctx.extra.store : "";
    return store ? `${store}/wp-admin/edit.php?post_type=shop_order` : "";
  },
};
