import { hmacSha256Base64 } from "../../src/connectors/hook-sign";
import { type FakePlatform, type FakeRequest, fakePlatform, json } from "../fakes/platform";

/**
 * A made-up Square seller, answering as Square's API documents it, for the Square connector's tests
 * (ADR-029). No real Square is called. Every shape is written from Square's own examples:
 *
 * - Locations, booking profiles, services, availability, bookings:
 *   https://developer.squareup.com/docs/bookings-api/use-the-api
 * - Booking webhooks: https://developer.squareup.com/docs/bookings-api/use-webhooks
 * - Catalogue: https://developer.squareup.com/docs/catalog-api/search-catalog-objects
 * - Payment links with an order: https://developer.squareup.com/docs/checkout-api/square-order-checkout
 *   and deleting one: https://developer.squareup.com/docs/checkout-api/manage-checkout
 * - Fulfillments: https://developer.squareup.com/docs/orders-api/fulfillments
 * - Webhook subscriptions: https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api
 * - Signatures: https://developer.squareup.com/docs/webhooks/step3validate
 * - OAuth: https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens
 *
 * The sellers rotate the world: a salon in Toronto that charges in Canadian dollars and adds Ontario's
 * HST when asked to, a café in Melbourne, a shop in Osaka that sells in yen. Their customers' names are
 * from many languages.
 */

export const PRODUCTION = "https://connect.squareup.com";
export const SANDBOX = "https://connect.squareupsandbox.com";
/** A production personal access token, as the Developer Console shows one. */
export const TOKEN = "EAAAl4Rk7cQ2vJ9mWx1nT5pZ8sB3dF6gH0jK2LqY4uI7oPa1";
export const SANDBOX_TOKEN = "EAAAEf2tR6yU8iO0pA3sD5fG7hJ9kL1zX3cV5bN7mQ9wE1rT";
export const CLIENT = { clientId: "sq0idp-7Hk2nQ4tLw9Xr1Cz5Bv8Mj", clientSecret: "sq0csp-Yt5Re3Wq1Pl9Ok7Ij5Uh3Gf1Dx" };
export const OAUTH_CODE = "sq0cgp-Zx8Cv6Bn4Mq2Wr0Ty8Ui6Op";

const DAY = 86_400_000;

export interface FakeBooking {
  id: string;
  version: number;
  status: "ACCEPTED" | "PENDING" | "CANCELLED_BY_CUSTOMER" | "CANCELLED_BY_SELLER";
  start: number;
  minutes: number;
  location: string;
  customer: string;
  service: string;
  team: string;
  customerNote?: string;
  sellerNote?: string;
}

export interface FakeOrder {
  id: string;
  version: number;
  location: string;
  reference: string | null;
  state: "DRAFT" | "OPEN" | "COMPLETED" | "CANCELED";
  lines: Record<string, unknown>[];
  total: number;
  currency: string;
  fulfillments: Record<string, unknown>[];
  tenders: { id: string; payment_id: string; amount: number }[];
  refunds: { id: string; status: string; amount: number }[];
  updatedAt: string;
  sent: Record<string, unknown>;
}

export interface FakeSquareOptions {
  readonly seller?: "toronto" | "melbourne" | "osaka";
  /** Square Appointments on (Free: buyer-level), on with Plus (seller-level), or off. */
  readonly appointments?: "free" | "plus" | "off";
  readonly locationPhone?: string | null;
}

export interface FakeSquare {
  readonly platform: FakePlatform;
  readonly merchantId: string;
  readonly location: string;
  readonly currency: string;
  /** Tax Square adds on top of each line (additive), as a fraction: none unless a test sets it. */
  taxRate: number;
  readonly tokens: { production: string; sandbox: string };
  readonly bookings: Map<string, FakeBooking>;
  readonly customers: Map<string, Record<string, unknown>>;
  readonly orders: Map<string, FakeOrder>;
  readonly links: Map<string, { id: string; orderId: string; url: string; request: Record<string, unknown> }>;
  readonly payments: Map<string, Record<string, unknown>>;
  readonly subscriptions: Map<string, Record<string, unknown>>;
  /** Items of the catalogue, as `SearchCatalogObjects` answers them; tests change them. */
  readonly items: Record<string, unknown>[];
  /** Stock counts at the location, by variation id. */
  readonly stock: Map<string, { quantity: number; at: string }>;
  /** Times the seller is busy that no booking of the inbox explains (another booking, a break), by team member. */
  readonly blocked: { team: string; start: number; end: number }[];
  /** Pays an order through its link, as a customer at Square's checkout. */
  pay(orderId: string, opts?: { method?: "CARD" | "WALLET" }): string;
  /** Marks the order's fulfillment as the seller does in Square (`PREPARED`, `COMPLETED`). */
  fulfil(orderId: string, state: "PREPARED" | "COMPLETED", tracking?: Record<string, string>): void;
  /** A refund made in the Square Dashboard, of part or all of the order's payment. */
  refund(orderId: string, amount: number): string;
  /** A signed delivery as Square sends it to a subscription; `tamper` changes one character. */
  event(
    type: string,
    data: Record<string, unknown>,
    opts?: { tamper?: boolean; eventId?: string; merchant?: string },
  ): Promise<{ url: string; body: string; headers: Record<string, string> }>;
}

const SELLERS = {
  toronto: {
    merchant: "MLR7T0R0NT0SAL0N",
    name: "Salon Lumière",
    location: "L7TOR0NT0QUEENW",
    locationName: "Queen Street West",
    currency: "CAD",
    timezone: "America/Toronto",
    phone: "+1 416-555-0142",
    other: { id: "L8TOR0NT0DANFRT", name: "Danforth", currency: "CAD" },
  },
  melbourne: {
    merchant: "MLR3MELB0URNECAF",
    name: "Laneway Café",
    location: "L3MELB0URNEFLND",
    locationName: "Flinders Lane",
    currency: "AUD",
    timezone: "Australia/Melbourne",
    phone: "+61 3 9555 0198",
    other: { id: "L4MELB0URNEFTZR", name: "Fitzroy", currency: "AUD" },
  },
  osaka: {
    merchant: "MLR5OSAKAKITCHEN",
    name: "Osaka Kitchenware",
    location: "L5OSAKASHINSAIB",
    locationName: "心斎橋",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    phone: "+81 6-5555-0123",
    other: { id: "L6OSAKAUMEDA000", name: "梅田", currency: "JPY" },
  },
} as const;

/** The salon's services: a cut, a colour and a beard trim, each taken by its own team members. */
function services(currency: string): Record<string, unknown>[] {
  const service = (
    id: string,
    name: string,
    variations: { id: string; name: string; minutes: number; price: number; team: string[]; fee?: number }[],
  ) => ({
    type: "ITEM",
    id,
    updated_at: "2026-09-01T10:00:00.000Z",
    version: 1756720800000,
    is_deleted: false,
    present_at_all_locations: true,
    item_data: {
      name,
      variations: variations.map((v) => ({
        type: "ITEM_VARIATION",
        id: v.id,
        version: 1756720800000,
        is_deleted: false,
        present_at_all_locations: true,
        item_variation_data: {
          item_id: id,
          name: v.name,
          pricing_type: "FIXED_PRICING",
          price_money: { amount: v.price, currency },
          service_duration: v.minutes * 60_000,
          available_for_booking: true,
          team_member_ids: v.team,
          ...(v.fee ? { no_show_fee: { amount: v.fee, currency } } : {}),
        },
      })),
      product_type: "APPOINTMENTS_SERVICE",
    },
  });
  return [
    service("SVCHAIRCUT000000", "Haircut", [
      { id: "VARHAIRCUT45MIN0", name: "Regular", minutes: 45, price: 6_500, team: ["TM_amelie", "TM_kwame"] },
    ]),
    service("SVCCOLOUR0000000", "Colour", [
      { id: "VARCOLOURFULL120", name: "Full", minutes: 120, price: 16_000, team: ["TM_amelie"] },
      { id: "VARCOLOURROOTS60", name: "Roots", minutes: 60, price: 9_000, team: ["TM_amelie"] },
    ]),
    service("SVCBEARD00000000", "Beard trim", [
      { id: "VARBEARDTRIM30M0", name: "Regular", minutes: 30, price: 3_000, team: ["TM_kwame"] },
    ]),
    // A service with a cancellation fee: Square refuses those through its API.
    service("SVCBRIDAL0000000", "Bridal styling", [
      { id: "VARBRIDAL180MIN0", name: "Regular", minutes: 180, price: 40_000, team: ["TM_amelie"], fee: 10_000 },
    ]),
  ];
}

type Obj = Record<string, unknown>;

function variationOf(
  id: string,
  item: string,
  name: string,
  currency: string,
  price: number | null,
  extra: Obj = {},
): Obj {
  return {
    type: "ITEM_VARIATION",
    id,
    version: 1759300000000,
    is_deleted: false,
    present_at_all_locations: true,
    item_variation_data: {
      item_id: item,
      name,
      ...(price === null
        ? { pricing_type: "VARIABLE_PRICING" }
        : { pricing_type: "FIXED_PRICING", price_money: { amount: price, currency } }),
      sellable: true,
      ...extra,
    },
  };
}

function itemOf(id: string, name: string, type: string, variations: Obj[], data: Obj = {}, top: Obj = {}): Obj {
  return {
    type: "ITEM",
    id,
    updated_at: "2026-10-01T06:00:00.000Z",
    version: 1759300000000,
    is_deleted: false,
    present_at_all_locations: true,
    item_data: { name, product_type: type, variations, ...data },
    ...top,
  };
}

/** The café's catalogue: drinks in two sizes, a cake counted in stock, and items the inbox must not sell. */
export function cafeItems(currency: string, location: string, other: string): Obj[] {
  const v = (id: string, item: string, name: string, price: number | null, extra: Obj = {}) =>
    variationOf(id, item, name, currency, price, extra);
  return [
    itemOf(
      "ITMFLATWHITE0000",
      "Flat white",
      "FOOD_AND_BEV",
      [
        v("VARFLATWHITEREG0", "ITMFLATWHITE0000", "Regular", 500, { sku: "FW-R" }),
        v("VARFLATWHITELRG0", "ITMFLATWHITE0000", "Large", 580, {
          sku: "FW-L",
          // Its own price at the other location.
          location_overrides: [{ location_id: other, price_money: { amount: 620, currency } }],
        }),
      ],
      { description_plaintext: "Double ristretto, steamed milk." },
    ),
    itemOf("ITMBANANABREAD00", "Banana bread", "FOOD_AND_BEV", [
      v("VARBANANABREAD00", "ITMBANANABREAD00", "Regular", 650, {
        sku: "BB-1",
        track_inventory: true,
        location_overrides: [{ location_id: location, track_inventory: true }],
      }),
    ]),
    // Priced at the till: never a guessed price.
    itemOf("ITMSEASONALTART0", "Seasonal tart", "FOOD_AND_BEV", [
      v("VARSEASONALTART0", "ITMSEASONALTART0", "Regular", null),
    ]),
    // Sold out here today.
    itemOf("ITMLAMINGTON0000", "Lamington", "FOOD_AND_BEV", [
      v("VARLAMINGTON0000", "ITMLAMINGTON0000", "Regular", 450, {
        location_overrides: [{ location_id: location, sold_out: true }],
      }),
    ]),
    // Archived in Square.
    itemOf(
      "ITMOLDMUFFIN0000",
      "Old muffin",
      "FOOD_AND_BEV",
      [v("VAROLDMUFFIN0000", "ITMOLDMUFFIN0000", "Regular", 400)],
      {
        is_archived: true,
      },
    ),
    // Sold only at the other location.
    itemOf(
      "ITMFITZROYONLY00",
      "Fitzroy toastie",
      "FOOD_AND_BEV",
      [v("VARFITZROYONLY00", "ITMFITZROYONLY00", "Regular", 1_200)],
      {},
      { present_at_all_locations: false, present_at_location_ids: [other] },
    ),
    // A gift card is not an order line.
    itemOf("ITMGIFTCARD00000", "Gift card", "GIFT_CARD", [v("VARGIFTCARD00000", "ITMGIFTCARD00000", "Regular", 5_000)]),
  ];
}

/** The salon's shelf: what it sells beside its services. */
function salonItems(currency: string, location: string): Obj[] {
  return [
    itemOf("ITMARGANSHAMPOO0", "Argan shampoo", "REGULAR", [
      variationOf("VARARGANSHAMP250", "ITMARGANSHAMPOO0", "250 ml", currency, 2_800, {
        sku: "ARG-250",
        track_inventory: true,
        location_overrides: [{ location_id: location, track_inventory: true }],
      }),
    ]),
    itemOf("ITMBEARDOIL00000", "Beard oil", "REGULAR", [
      variationOf("VARBEARDOIL30ML0", "ITMBEARDOIL00000", "Regular", currency, 2_200, { sku: "BO-30" }),
    ]),
  ];
}

/** The Osaka shop's shelf, in yen: Square counts it in whole yen. */
function kitchenItems(currency: string): Obj[] {
  return [
    itemOf("ITMSANTOKU000000", "三徳包丁 Santoku", "REGULAR", [
      variationOf("VARSANTOKU165MM0", "ITMSANTOKU000000", "165 mm", currency, 12_800, { sku: "SNT-165" }),
    ]),
    itemOf("ITMDONABE0000000", "土鍋 Donabe", "REGULAR", [
      variationOf("VARDONABE2PERS00", "ITMDONABE0000000", "2 people", currency, 6_800, { sku: "DNB-2" }),
    ]),
  ];
}

export function fakeSquare(opts: FakeSquareOptions = {}): FakeSquare {
  const seller = SELLERS[opts.seller ?? "toronto"];
  const appointments = opts.appointments ?? "free";
  const platform = fakePlatform();
  const tokens = { production: TOKEN, sandbox: SANDBOX_TOKEN };
  let n = 0;
  const id = (prefix: string) => `${prefix}${String(++n).padStart(6, "0")}${"X".repeat(10)}`.slice(0, 22);
  const idempotent = new Map<string, Response>();
  const nowIso = () => new Date().toISOString();

  const sq: FakeSquare = {
    platform,
    merchantId: seller.merchant,
    location: seller.location,
    currency: seller.currency,
    taxRate: 0,
    tokens,
    bookings: new Map(),
    customers: new Map(),
    orders: new Map(),
    links: new Map(),
    payments: new Map(),
    subscriptions: new Map(),
    items:
      opts.seller === "melbourne"
        ? cafeItems(seller.currency, seller.location, seller.other.id)
        : opts.seller === "osaka"
          ? kitchenItems(seller.currency)
          : salonItems(seller.currency, seller.location),
    stock: new Map([
      ["VARBANANABREAD00", { quantity: 12, at: "2026-10-20T05:00:00Z" }],
      ["VARARGANSHAMP250", { quantity: 7, at: "2026-10-20T05:00:00Z" }],
    ]),
    blocked: [],
    pay(orderId, payOpts = {}) {
      const order = sq.orders.get(orderId);
      if (!order) throw new Error(`no order ${orderId}`);
      const paymentId = id("PAY");
      const paidAt = nowIso();
      sq.payments.set(paymentId, {
        id: paymentId,
        created_at: paidAt,
        updated_at: paidAt,
        amount_money: { amount: order.total, currency: order.currency },
        total_money: { amount: order.total, currency: order.currency },
        status: "COMPLETED",
        source_type: payOpts.method ?? "CARD",
        ...(payOpts.method === "WALLET"
          ? { wallet_details: { status: "CAPTURED", brand: "APPLE_PAY" } }
          : { card_details: { status: "CAPTURED", card: { card_brand: "VISA", last_4: "1111" } } }),
        location_id: order.location,
        order_id: order.id,
        receipt_url: `https://squareup.com/receipt/preview/${paymentId}`,
      });
      order.tenders.push({ id: id("TND"), payment_id: paymentId, amount: order.total });
      order.state = order.fulfillments.length > 0 ? "OPEN" : "COMPLETED";
      order.version++;
      order.updatedAt = paidAt;
      return paymentId;
    },
    fulfil(orderId, state, tracking) {
      const order = sq.orders.get(orderId);
      const f = order?.fulfillments[0];
      if (!order || !f) throw new Error("no fulfillment");
      f.state = state;
      if (tracking && f.type === "SHIPMENT") f.shipment_details = { ...(f.shipment_details as object), ...tracking };
      if (state === "COMPLETED") order.state = "COMPLETED";
      order.version++;
      order.updatedAt = nowIso();
    },
    refund(orderId, amount) {
      const order = sq.orders.get(orderId);
      const tender = order?.tenders[0];
      if (!order || !tender) throw new Error("nothing paid");
      const refundId = `${tender.payment_id}_${id("RF")}`;
      order.refunds.push({ id: refundId, status: "COMPLETED", amount });
      const p = sq.payments.get(tender.payment_id);
      if (p) {
        const had = Number((p.refunded_money as { amount?: number } | undefined)?.amount ?? 0);
        p.refunded_money = { amount: had + amount, currency: order.currency };
        p.refund_ids = [...((p.refund_ids as string[] | undefined) ?? []), refundId];
      }
      order.version++;
      order.updatedAt = nowIso();
      return refundId;
    },
    async event(type, data, eventOpts = {}) {
      const sub = [...sq.subscriptions.values()][0];
      if (!sub) throw new Error("no subscription made");
      const body = JSON.stringify({
        merchant_id: eventOpts.merchant ?? seller.merchant,
        type,
        event_id: eventOpts.eventId ?? crypto.randomUUID(),
        created_at: nowIso(),
        data,
      });
      let signature = await hmacSha256Base64(String(sub.signature_key), `${String(sub.notification_url)}${body}`);
      if (eventOpts.tamper)
        signature = `${signature.slice(0, 3)}${signature[3] === "A" ? "B" : "A"}${signature.slice(4)}`;
      return {
        url: String(sub.notification_url),
        body,
        headers: { "content-type": "application/json", "x-square-hmacsha256-signature": signature },
      };
    },
  };

  const base = (env: "production" | "sandbox") => (env === "sandbox" ? SANDBOX : PRODUCTION);
  const authed = (req: FakeRequest, env: "production" | "sandbox") =>
    req.headers.get("authorization") === `Bearer ${tokens[env]}`;
  const unauthorized = () =>
    json(
      {
        errors: [
          { category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." },
        ],
      },
      401,
    );
  const bad = (detail: string, field?: string) =>
    json(
      { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail, ...(field ? { field } : {}) }] },
      400,
    );
  const notFound = () =>
    json({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "Not found." }] }, 404);
  const once = (key: unknown, make: () => Response): Response => {
    if (typeof key !== "string" || !key) return make();
    const had = idempotent.get(key);
    if (had) return had.clone();
    const res = make();
    idempotent.set(key, res.clone());
    return res;
  };

  const locations = () => [
    {
      id: seller.location,
      name: seller.locationName,
      timezone: seller.timezone,
      status: "ACTIVE",
      merchant_id: seller.merchant,
      currency: seller.currency,
      business_name: seller.name,
      type: "PHYSICAL",
      ...(opts.locationPhone === null ? {} : { phone_number: opts.locationPhone ?? seller.phone }),
    },
    {
      id: seller.other.id,
      name: seller.other.name,
      status: "ACTIVE",
      merchant_id: seller.merchant,
      currency: seller.other.currency,
      business_name: seller.name,
      type: "PHYSICAL",
    },
    { id: "LCLOSED000000000", name: "Closed pop-up", status: "INACTIVE", currency: seller.currency },
  ];

  const bookingView = (b: FakeBooking) => ({
    id: b.id,
    version: b.version,
    status: b.status,
    created_at: "2026-10-20T14:00:00Z",
    updated_at: nowIso(),
    location_id: b.location,
    customer_id: b.customer,
    ...(b.customerNote !== undefined ? { customer_note: b.customerNote } : {}),
    ...(appointments === "plus" && b.sellerNote !== undefined ? { seller_note: b.sellerNote } : {}),
    start_at: new Date(b.start).toISOString().replace(".000Z", "Z"),
    all_day: false,
    appointment_segments: [
      {
        duration_minutes: b.minutes,
        service_variation_id: b.service,
        team_member_id: b.team,
        service_variation_version: 1756720800000,
        any_team_member: false,
      },
    ],
    location_type: "BUSINESS_LOCATION",
  });

  const svcList = services(seller.currency);
  const variationOf = (vid: string) => {
    for (const s of svcList) {
      const v = ((s.item_data as { variations: Record<string, unknown>[] }).variations ?? []).find((x) => x.id === vid);
      if (v) return v.item_variation_data as { service_duration: number; team_member_ids: string[] };
    }
    return null;
  };
  /** Open 10:00 to 18:00 in Toronto (14:00–22:00 UTC in October), every day; slots every 15 minutes. */
  const open = (day: number) => ({ start: day + 14 * 3_600_000, end: day + 22 * 3_600_000 });
  const busyFor = (team: string, start: number, end: number, except?: string) =>
    [...sq.bookings.values()].some(
      (b) =>
        b.id !== except &&
        b.team === team &&
        (b.status === "ACCEPTED" || b.status === "PENDING") &&
        b.start < end &&
        b.start + b.minutes * 60_000 > start,
    ) || sq.blocked.some((x) => x.team === team && x.start < end && x.end > start);

  for (const env of ["production", "sandbox"] as const) {
    const b = base(env);
    const guard = (handler: (req: FakeRequest) => Response | Promise<Response>) => (req: FakeRequest) =>
      authed(req, env) ? handler(req) : unauthorized();
    platform
      .on(
        "GET",
        `${b}/v2/merchants/me`,
        guard(() =>
          json({
            merchant: {
              id: seller.merchant,
              business_name: seller.name,
              country: seller.currency === "CAD" ? "CA" : seller.currency === "AUD" ? "AU" : "JP",
              language_code: seller.currency === "CAD" ? "fr-CA" : seller.currency === "AUD" ? "en-AU" : "ja-JP",
              currency: seller.currency,
              status: "ACTIVE",
              main_location_id: seller.location,
            },
          }),
        ),
      )
      .on(
        "GET",
        `${b}/v2/locations`,
        guard(() => json({ locations: locations() })),
      )
      .on(
        "GET",
        `${b}/v2/bookings/business-booking-profile`,
        guard(() =>
          appointments === "off"
            ? json({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "Not found." }] }, 404)
            : json({
                business_booking_profile: {
                  seller_id: seller.merchant,
                  created_at: "2026-01-12T16:38:24Z",
                  booking_enabled: true,
                  customer_timezone_choice: "BUSINESS_LOCATION_TIMEZONE",
                  booking_policy: "ACCEPT_ALL",
                  allow_user_cancel: true,
                  business_appointment_settings: { alignment_time: "QUARTER_HOURLY" },
                  support_seller_level_writes: appointments === "plus",
                },
                errors: [],
              }),
        ),
      )
      .on(
        "POST",
        `${b}/v2/catalog/search-catalog-items`,
        guard(() => json({ items: svcList, matched_variation_ids: [] })),
      )
      .on(
        "GET",
        `${b}/v2/bookings/team-member-booking-profiles`,
        guard(() =>
          json({
            team_member_booking_profiles: [
              { team_member_id: "TM_amelie", display_name: "Amélie Tremblay", is_bookable: true },
              { team_member_id: "TM_kwame", display_name: "Kwame Mensah", is_bookable: true },
            ],
            errors: [],
          }),
        ),
      )
      .on(
        "POST",
        `${b}/v2/bookings/availability/search`,
        guard((req) => {
          const q = JSON.parse(req.body) as {
            query: {
              filter: {
                start_at_range: { start_at: string; end_at: string };
                location_id: string;
                segment_filters: { service_variation_id: string; team_member_id_filter?: { any: string[] } }[];
              };
            };
          };
          const f = q.query.filter;
          const from = Date.parse(f.start_at_range.start_at);
          const to = Date.parse(f.start_at_range.end_at);
          if (to - from < DAY) return bad("The time range must be at least 24 hours.", "query.filter.start_at_range");
          if (to - from > 31 * DAY)
            return bad("The time range must not be longer than 31 days.", "query.filter.start_at_range");
          const seg = f.segment_filters[0];
          const v = seg ? variationOf(seg.service_variation_id) : null;
          if (!seg || !v) return bad("Invalid service variation.", "service_variation_id");
          const minutes = v.service_duration / 60_000;
          const team = v.team_member_ids.filter(
            (t) => !seg.team_member_id_filter || seg.team_member_id_filter.any.includes(t),
          );
          const availabilities: Record<string, unknown>[] = [];
          for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
            const hours = open(day);
            for (let s = hours.start; s + minutes * 60_000 <= hours.end; s += 15 * 60_000) {
              if (s < from || s >= to) continue;
              for (const t of team) {
                if (busyFor(t, s, s + minutes * 60_000)) continue;
                availabilities.push({
                  start_at: new Date(s).toISOString().replace(".000Z", "Z"),
                  location_id: f.location_id,
                  appointment_segments: [
                    {
                      duration_minutes: minutes,
                      team_member_id: t,
                      service_variation_id: seg.service_variation_id,
                      service_variation_version: 1756720800000,
                    },
                  ],
                });
              }
            }
          }
          return json({ availabilities, errors: [] });
        }),
      )
      .on(
        "POST",
        `${b}/v2/customers/search`,
        guard((req) => {
          const q = JSON.parse(req.body) as { query?: { filter?: { reference_id?: { exact?: string } } } };
          const ref = q.query?.filter?.reference_id?.exact;
          const found = [...sq.customers.values()].filter((c) => ref !== undefined && c.reference_id === ref);
          return json(found.length > 0 ? { customers: found } : {});
        }),
      )
      .on(
        "POST",
        `${b}/v2/customers`,
        guard((req) => {
          const body = JSON.parse(req.body) as Record<string, unknown>;
          return once(`cust:${String(body.idempotency_key)}`, () => {
            const cid = id("CUST");
            const { idempotency_key: _k, ...fields } = body;
            const customer = { id: cid, created_at: nowIso(), creation_source: "THIRD_PARTY", version: 0, ...fields };
            sq.customers.set(cid, customer);
            return json({ customer });
          });
        }),
      )
      .on(
        "POST",
        `${b}/v2/bookings`,
        guard((req) => {
          const body = JSON.parse(req.body) as {
            idempotency_key?: string;
            booking: {
              start_at: string;
              location_id: string;
              customer_id: string;
              customer_note?: string;
              seller_note?: string;
              appointment_segments: {
                service_variation_id: string;
                team_member_id: string;
                duration_minutes?: number;
              }[];
            };
          };
          return once(`book:${String(body.idempotency_key)}`, () => {
            const bk = body.booking;
            const customer = sq.customers.get(bk.customer_id);
            if (!customer?.phone_number) return bad("is invalid", "phone");
            const seg = bk.appointment_segments[0];
            const v = seg ? variationOf(seg.service_variation_id) : null;
            if (!seg || !v) return bad("Invalid service variation.");
            if (appointments !== "plus" && seg.duration_minutes !== undefined) {
              return bad("duration_minutes is read-only with buyer-level permissions.", "duration_minutes");
            }
            const start = Date.parse(bk.start_at);
            const minutes = v.service_duration / 60_000;
            if (busyFor(seg.team_member_id, start, start + minutes * 60_000)) {
              return bad("The time slot is not available.", "start_at");
            }
            const made: FakeBooking = {
              id: id("bk").toLowerCase(),
              version: 0,
              status: "ACCEPTED",
              start,
              minutes,
              location: bk.location_id,
              customer: bk.customer_id,
              service: seg.service_variation_id,
              team: seg.team_member_id,
              ...(bk.customer_note !== undefined ? { customerNote: bk.customer_note } : {}),
              ...(bk.seller_note !== undefined ? { sellerNote: bk.seller_note } : {}),
            };
            sq.bookings.set(made.id, made);
            return json({ booking: bookingView(made), errors: [] });
          });
        }),
      )
      .on(
        "GET",
        `${b}/v2/bookings/:id`,
        guard((req) => {
          const bk = sq.bookings.get(req.params.id ?? "");
          return bk ? json({ booking: bookingView(bk), errors: [] }) : notFound();
        }),
      )
      .on(
        "PUT",
        `${b}/v2/bookings/:id`,
        guard((req) => {
          const bk = sq.bookings.get(req.params.id ?? "");
          if (!bk) return notFound();
          const body = JSON.parse(req.body) as { booking: { version?: number; start_at?: string } };
          if (body.booking.version !== bk.version)
            return json({ errors: [{ code: "CONFLICT", detail: "Stale version." }] }, 409);
          if (body.booking.start_at) {
            const start = Date.parse(body.booking.start_at);
            if (busyFor(bk.team, start, start + bk.minutes * 60_000, bk.id)) {
              return bad("The time slot is not available.", "start_at");
            }
            bk.start = start;
          }
          bk.version++;
          return json({ booking: bookingView(bk), errors: [] });
        }),
      )
      .on(
        "POST",
        `${b}/v2/bookings/:id/cancel`,
        guard((req) => {
          const bk = sq.bookings.get(req.params.id ?? "");
          if (!bk) return notFound();
          const body = JSON.parse(req.body) as { booking_version?: number };
          if (body.booking_version !== bk.version) return bad("The booking version does not match.");
          if (bk.start < Date.now() && appointments !== "plus") {
            return bad("The cancellation period for this booking has ended.", "base");
          }
          bk.status = appointments === "plus" ? "CANCELLED_BY_SELLER" : "CANCELLED_BY_CUSTOMER";
          bk.version++;
          return json({ booking: bookingView(bk), errors: [] });
        }),
      )
      .on(
        "GET",
        `${b}/v2/bookings`,
        guard((req) => {
          const p = req.url.searchParams;
          const min = Date.parse(p.get("start_at_min") ?? "");
          const max = Date.parse(p.get("start_at_max") ?? "");
          const list = [...sq.bookings.values()].filter(
            (bk) =>
              (!p.get("location_id") || bk.location === p.get("location_id")) &&
              (!p.get("customer_id") || bk.customer === p.get("customer_id")) &&
              (!Number.isFinite(min) || bk.start >= min) &&
              (!Number.isFinite(max) || bk.start <= max),
          );
          return json({ bookings: list.map(bookingView), errors: [] });
        }),
      )
      .on(
        "POST",
        `${b}/v2/catalog/search`,
        guard((req) => {
          const body = JSON.parse(req.body) as { begin_time?: string; cursor?: string; limit?: number };
          const since = body.begin_time ? Date.parse(body.begin_time) : Number.NEGATIVE_INFINITY;
          const list = sq.items.filter((i) => Date.parse(String(i.updated_at)) >= since);
          const start = Number(body.cursor ?? 0);
          const size = 3;
          const page = list.slice(start, start + size);
          return json({
            objects: page,
            ...(start + size < list.length ? { cursor: String(start + size) } : {}),
            latest_time: nowIso(),
          });
        }),
      )
      .on(
        "POST",
        `${b}/v2/catalog/batch-retrieve`,
        guard((req) => {
          const body = JSON.parse(req.body) as { object_ids: string[] };
          const objects: Record<string, unknown>[] = [];
          const related: Record<string, unknown>[] = [];
          for (const item of sq.items) {
            const variations = ((item.item_data as { variations?: Record<string, unknown>[] }).variations ?? []).filter(
              (v) => body.object_ids.includes(String(v.id)),
            );
            if (variations.length > 0) {
              objects.push(...variations);
              related.push(item);
            }
          }
          return json({ objects, related_objects: related });
        }),
      )
      .on(
        "POST",
        `${b}/v2/inventory/counts/batch-retrieve`,
        guard((req) => {
          const body = JSON.parse(req.body) as {
            catalog_object_ids?: string[];
            location_ids?: string[];
            updated_after?: string;
          };
          const after = body.updated_after ? Date.parse(body.updated_after) : Number.NEGATIVE_INFINITY;
          const counts = [...sq.stock.entries()]
            .filter(
              ([vid, c]) =>
                (!body.catalog_object_ids || body.catalog_object_ids.includes(vid)) && Date.parse(c.at) > after,
            )
            .map(([vid, c]) => ({
              catalog_object_id: vid,
              catalog_object_type: "ITEM_VARIATION",
              state: "IN_STOCK",
              location_id: body.location_ids?.[0] ?? seller.location,
              quantity: String(c.quantity),
              calculated_at: c.at,
            }));
          return json({ counts });
        }),
      )
      .on(
        "POST",
        `${b}/v2/online-checkout/payment-links`,
        guard((req) => {
          const body = JSON.parse(req.body) as {
            idempotency_key?: string;
            order: {
              location_id: string;
              reference_id?: string;
              line_items: {
                catalog_object_id?: string;
                name?: string;
                quantity: string;
                base_price_money?: { amount: number; currency: string };
              }[];
              fulfillments?: Record<string, unknown>[];
              pricing_options?: { auto_apply_taxes?: boolean };
            };
            checkout_options?: Record<string, unknown>;
          };
          return once(`link:${String(body.idempotency_key)}`, () => {
            const currency = seller.currency;
            let subtotal = 0;
            const lines = body.order.line_items.map((l) => {
              let price = l.base_price_money?.amount ?? 0;
              let name = l.name ?? "";
              if (l.catalog_object_id) {
                const found = sq.items
                  .flatMap((i) =>
                    (i.item_data as { variations: Record<string, unknown>[]; name: string }).variations.map((v) => ({
                      i,
                      v,
                    })),
                  )
                  .find((x) => x.v.id === l.catalog_object_id);
                if (!found) return null;
                const vd = found.v.item_variation_data as { price_money?: { amount: number } };
                price = vd.price_money?.amount ?? 0;
                name = (found.i.item_data as { name: string }).name;
              }
              subtotal += price * Number(l.quantity);
              return {
                uid: id("li"),
                name,
                quantity: l.quantity,
                base_price_money: { amount: price, currency },
                item_type: "ITEM",
              };
            });
            if (lines.some((l) => l === null)) return bad("Item variation not found.", "catalog_object_id");
            const tax = body.order.pricing_options?.auto_apply_taxes ? Math.round(subtotal * sq.taxRate) : 0;
            const orderId = id("ORD");
            const linkId = id("PL").toUpperCase();
            const url = `https://square.link/u/${linkId.slice(0, 8)}`;
            const order: FakeOrder = {
              id: orderId,
              version: 1,
              location: body.order.location_id,
              reference: body.order.reference_id ?? null,
              state: "DRAFT",
              lines: lines as Record<string, unknown>[],
              total: subtotal + tax,
              currency,
              fulfillments: (body.order.fulfillments ?? [{ type: "DIGITAL", state: "PROPOSED" }]).map((f) => ({
                uid: id("ff"),
                ...f,
              })),
              tenders: [],
              refunds: [],
              updatedAt: nowIso(),
              sent: body as unknown as Record<string, unknown>,
            };
            sq.orders.set(orderId, order);
            sq.links.set(linkId, { id: linkId, orderId, url, request: body as unknown as Record<string, unknown> });
            return json({
              payment_link: { id: linkId, version: 1, description: "", order_id: orderId, url, created_at: nowIso() },
              related_resources: { orders: [orderView(order)] },
            });
          });
        }),
      )
      .on(
        "DELETE",
        `${b}/v2/online-checkout/payment-links/:id`,
        guard((req) => {
          const link = sq.links.get(req.params.id ?? "");
          if (!link) return notFound();
          const order = sq.orders.get(link.orderId);
          if (order && order.tenders.length > 0) return bad("A paid order cannot be canceled.");
          sq.links.delete(link.id);
          if (order) {
            order.state = "CANCELED";
            order.version++;
            order.updatedAt = nowIso();
          }
          return json({ id: link.id, cancelled_order_id: link.orderId });
        }),
      )
      .on(
        "GET",
        `${b}/v2/orders/:id`,
        guard((req) => {
          const order = sq.orders.get(req.params.id ?? "");
          return order ? json({ order: orderView(order) }) : notFound();
        }),
      )
      .on(
        "GET",
        `${b}/v2/payments/:id`,
        guard((req) => {
          const payment = sq.payments.get(req.params.id ?? "");
          return payment ? json({ payment }) : notFound();
        }),
      )
      .on(
        "GET",
        `${b}/v2/refunds/:id`,
        guard((req) => {
          for (const order of sq.orders.values()) {
            const r = order.refunds.find((x) => x.id === req.params.id);
            if (r) {
              return json({
                refund: {
                  id: r.id,
                  status: r.status,
                  amount_money: { amount: r.amount, currency: order.currency },
                  payment_id: order.tenders[0]?.payment_id,
                  order_id: order.id,
                  location_id: order.location,
                },
              });
            }
          }
          return notFound();
        }),
      )
      .on(
        "POST",
        `${b}/v2/webhooks/subscriptions`,
        guard((req) => {
          const body = JSON.parse(req.body) as { subscription: Record<string, unknown> };
          const sid = `wbhk_${crypto.randomUUID().replaceAll("-", "")}`;
          const subscription = {
            id: sid,
            ...body.subscription,
            enabled: true,
            signature_key: btoa(crypto.randomUUID()).slice(0, 22),
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          sq.subscriptions.set(sid, subscription);
          return json({ subscription });
        }),
      )
      .on(
        "GET",
        `${b}/v2/webhooks/subscriptions/:id`,
        guard((req) => {
          const s = sq.subscriptions.get(req.params.id ?? "");
          if (!s) return notFound();
          const { signature_key: _k, ...shown } = s;
          return json({ subscription: shown });
        }),
      )
      .on(
        "PUT",
        `${b}/v2/webhooks/subscriptions/:id`,
        guard((req) => {
          const s = sq.subscriptions.get(req.params.id ?? "");
          if (!s) return notFound();
          Object.assign(s, (JSON.parse(req.body) as { subscription: Record<string, unknown> }).subscription);
          const { signature_key: _k, ...shown } = s;
          return json({ subscription: shown });
        }),
      )
      .on(
        "DELETE",
        `${b}/v2/webhooks/subscriptions/:id`,
        guard((req) => (sq.subscriptions.delete(req.params.id ?? "") ? json({}) : notFound())),
      )
      .on(
        "GET",
        `${b}/v2/webhooks/subscriptions`,
        guard(() =>
          json({
            subscriptions: [...sq.subscriptions.values()].map(({ signature_key: _k, ...shown }) => shown),
          }),
        ),
      );
  }

  platform
    .on("POST", `${PRODUCTION}/oauth2/token`, (req) => {
      const body = JSON.parse(req.body) as Record<string, string>;
      if (body.client_id !== CLIENT.clientId || body.client_secret !== CLIENT.clientSecret) {
        return json({ message: "Not Authorized", type: "service.not_authorized" }, 401);
      }
      if (body.grant_type === "authorization_code" && body.code !== OAUTH_CODE) {
        return json({ message: "Invalid code", type: "bad_request" }, 400);
      }
      if (
        body.grant_type === "refresh_token" &&
        body.refresh_token !== "EQAA-refresh-1" &&
        body.refresh_token !== "EQAA-refresh-2"
      ) {
        return json({ message: "Invalid refresh token", type: "bad_request" }, 400);
      }
      // The token that comes back is the one production takes from now on.
      tokens.production =
        body.grant_type === "refresh_token" ? "EAAA-oauth-renewed-0000000000" : "EAAA-oauth-token-00000000000";
      return json({
        access_token: tokens.production,
        token_type: "bearer",
        expires_at: new Date(Date.now() + 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"),
        merchant_id: seller.merchant,
        refresh_token: body.grant_type === "refresh_token" ? "EQAA-refresh-2" : "EQAA-refresh-1",
        short_lived: false,
      });
    })
    .on("POST", `${PRODUCTION}/oauth2/revoke`, (req) =>
      req.headers.get("authorization") === `Client ${CLIENT.clientSecret}` ? json({ success: true }) : json({}, 401),
    );

  function orderView(o: FakeOrder) {
    return {
      id: o.id,
      location_id: o.location,
      ...(o.reference ? { reference_id: o.reference } : {}),
      source: { name: "Inbox" },
      line_items: o.lines,
      fulfillments: o.fulfillments,
      ...(o.tenders.length > 0
        ? {
            tenders: o.tenders.map((t) => ({
              id: t.id,
              location_id: o.location,
              type: "CARD",
              amount_money: { amount: t.amount, currency: o.currency },
              payment_id: t.payment_id,
            })),
          }
        : {}),
      ...(o.refunds.length > 0
        ? {
            refunds: o.refunds.map((r) => ({
              id: r.id,
              location_id: o.location,
              status: r.status,
              amount_money: { amount: r.amount, currency: o.currency },
            })),
          }
        : {}),
      created_at: "2026-10-20T14:00:00.000Z",
      updated_at: o.updatedAt,
      state: o.state,
      version: o.version,
      total_money: { amount: o.total, currency: o.currency },
      net_amount_due_money: { amount: o.tenders.length > 0 ? 0 : o.total, currency: o.currency },
    };
  }

  return sq;
}
