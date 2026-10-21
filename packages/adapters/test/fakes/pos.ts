import { hmacSha256Hex } from "../../src/connectors/pay-sign";
import {
  DELIVERECT_LINK,
  FLIPDISH_CLIENT_ID,
  FLIPDISH_MENU,
  FLIPDISH_SECRET,
  FLIPDISH_STORE,
  GLORIA_MASTER_KEY,
  GLORIA_MENU,
  GLORIA_MENU_KEY,
  GLORIA_ORDERS,
  GLORIA_ORDERS_KEY,
  TOAST_HOST,
  TOAST_MENUS,
  TOAST_PARTNER,
  TOAST_RESTAURANT,
} from "../fixtures/pos";
import type { FakePlatform, FakeRequest } from "./platform";
import { json } from "./platform";

/**
 * The food platforms as local fakes (ADR-036), each answering as its published reference says, with the
 * shapes in `fixtures/pos.ts`. Every one keeps what it was sent, checks the credentials it was given,
 * and has a menu, and the tills take an order and accept or reject it. No real platform is ever called.
 */

const unauthorised = () => json({ message: "Unauthorized" }, 401);

/* --- GloriaFood ----------------------------------------------------------------------- */

export function fakeGloriaFood(p: FakePlatform) {
  const state = { queue: [...GLORIA_ORDERS.orders] as Record<string, unknown>[], master: GLORIA_MASTER_KEY };
  const v2 = (r: FakeRequest) => r.headers.get("glf-api-version") === "2";
  p.on("GET", "https://pos.globalfoodsoft.com/pos/menu", (r) =>
    r.headers.get("authorization") === GLORIA_MENU_KEY && v2(r) ? json(GLORIA_MENU) : unauthorised(),
  );
  p.on("POST", "https://pos.globalfoodsoft.com/pos/order/pop", (r) => {
    if (r.headers.get("authorization") !== GLORIA_ORDERS_KEY || !v2(r)) return unauthorised();
    // Each accepted order is handed over once: the poll pops it.
    const orders = state.queue.splice(0, state.queue.length);
    return json({ count: orders.length, orders });
  });
  return state;
}

/* --- Flipdish ---------------------------------------------------------------------------- */

export function fakeFlipdish(p: FakePlatform) {
  const state = {
    token: "fd-access-token-1",
    overrides: [] as {
      BusinessHoursOverrideId: number;
      DeliveryType: string;
      StartTime: string;
      EndTime: string;
      Type: string;
    }[],
    nextId: 700,
  };
  const authed = (r: FakeRequest) => r.headers.get("authorization") === `Bearer ${state.token}`;
  p.on("POST", "https://api.flipdish.co/identity/connect/token", (r) => {
    const f = new URLSearchParams(r.body);
    if (f.get("grant_type") !== "client_credentials" || f.get("scope") !== "api")
      return json({ error: "unsupported_grant_type" }, 400);
    if (f.get("client_id") !== FLIPDISH_CLIENT_ID || f.get("client_secret") !== FLIPDISH_SECRET)
      return json({ error: "invalid_client" }, 400);
    return json({ access_token: state.token, expires_in: 3600, token_type: "Bearer", scope: "api" });
  });
  p.on("GET", "https://api.flipdish.co/api/v1.0/stores", (r) =>
    authed(r) ? json({ Page: 1, Limit: 50, TotalRecordCount: 1, Data: [FLIPDISH_STORE] }) : unauthorised(),
  );
  p.on("GET", "https://api.flipdish.co/api/v1.0/menus/:id", (r) =>
    authed(r) && r.params.id === String(FLIPDISH_STORE.MenuId) ? json({ Data: FLIPDISH_MENU }) : unauthorised(),
  );
  p.on("POST", "https://api.flipdish.co/api/v1.0/stores/:id/businesshoursoverrides", (r) => {
    if (!authed(r)) return unauthorised();
    const o = JSON.parse(r.body) as { DeliveryType: string; StartTime: string; EndTime: string; Type: string };
    const made = { BusinessHoursOverrideId: state.nextId++, ...o };
    state.overrides.push(made);
    return json({ Data: made });
  });
  p.on("GET", "https://api.flipdish.co/api/v1.0/stores/:id/businesshoursoverrides", (r) =>
    authed(r)
      ? json({ Page: 1, Limit: 50, TotalRecordCount: state.overrides.length, Data: state.overrides })
      : unauthorised(),
  );
  p.on("DELETE", "https://api.flipdish.co/api/v1.0/stores/:id/businesshoursoverrides/:oid", (r) => {
    if (!authed(r)) return unauthorised();
    state.overrides = state.overrides.filter((o) => String(o.BusinessHoursOverrideId) !== r.params.oid);
    return json({ Data: [] });
  });
  return state;
}

/* --- Toast ------------------------------------------------------------------------------- */

export function fakeToast(p: FakePlatform) {
  const state = {
    token: "toast-jwt-1",
    orders: new Map<string, Record<string, unknown>>(),
    /** Accept or reject as a restaurant employee would, in Toast. */
    approve(guid: string, status: "APPROVED" | "NOT_APPROVED") {
      const o = state.orders.get(guid);
      if (o) o.approvalStatus = status;
    },
  };
  const authed = (r: FakeRequest) => r.headers.get("authorization") === `Bearer ${state.token}`;
  const atRestaurant = (r: FakeRequest) =>
    authed(r) && r.headers.get("toast-restaurant-external-id") === TOAST_RESTAURANT;
  p.on("POST", `${TOAST_HOST}/authentication/v1/authentication/login`, (r) => {
    const b = JSON.parse(r.body) as { clientId?: string; clientSecret?: string; userAccessType?: string };
    if (
      b.clientId !== TOAST_PARTNER.clientId ||
      b.clientSecret !== TOAST_PARTNER.clientSecret ||
      b.userAccessType !== "TOAST_MACHINE_CLIENT"
    ) {
      return json({ status: 401, message: "Access denied" }, 401);
    }
    return json({ status: "SUCCESS", token: { tokenType: "Bearer", accessToken: state.token, expiresIn: 86400 } });
  });
  p.on("GET", `${TOAST_HOST}/partners/v1/restaurants`, (r) =>
    authed(r)
      ? json([
          {
            restaurantGuid: TOAST_RESTAURANT,
            restaurantName: "Pizzería Volcán",
            locationName: "Roma Norte",
            deleted: false,
          },
        ])
      : unauthorised(),
  );
  p.on("GET", `${TOAST_HOST}/menus/v2/menus`, (r) => (atRestaurant(r) ? json(TOAST_MENUS) : unauthorised()));
  p.on("GET", `${TOAST_HOST}/config/v2/diningOptions`, (r) =>
    atRestaurant(r)
      ? json([
          {
            guid: "d0000000-0000-4000-8000-00000000take",
            entityType: "DiningOption",
            name: "Para llevar",
            behavior: "TAKE_OUT",
          },
          {
            guid: "d0000000-0000-4000-8000-0000000deliv",
            entityType: "DiningOption",
            name: "A domicilio",
            behavior: "DELIVERY",
          },
        ])
      : unauthorised(),
  );
  p.on("POST", `${TOAST_HOST}/orders/v2/orders`, (r) => {
    if (!atRestaurant(r)) return unauthorised();
    const b = JSON.parse(r.body) as Record<string, unknown>;
    const guid = `ord-${state.orders.size + 1}`;
    const order = {
      guid,
      entityType: "Order",
      externalId: b.externalId,
      approvalStatus: "NEEDS_APPROVAL",
      voided: false,
      sent: b,
    };
    state.orders.set(guid, order);
    return json(order);
  });
  p.on("GET", `${TOAST_HOST}/orders/v2/orders/:guid`, (r) => {
    if (!atRestaurant(r)) return unauthorised();
    const o =
      state.orders.get(r.params.guid ?? "") ?? [...state.orders.values()].find((x) => x.externalId === r.params.guid);
    return o ? json(o) : json({ message: "Not found" }, 404);
  });
  return state;
}

/* --- Deliverect ---------------------------------------------------------------------------- */

export function fakeDeliverect(p: FakePlatform, base = "https://api.staging.deliverect.com") {
  const state = { orders: new Map<string, Record<string, unknown>>(), token: "dlv-token-1" };
  p.on("POST", `${base}/oauth/token`, (r) => {
    const f = new URLSearchParams(r.body);
    return f.get("client_id") === "dlv-client" && f.get("client_secret") === "dlv-secret"
      ? json({ access_token: state.token, expires_in: 86400, token_type: "Bearer" })
      : json({ error: "access_denied" }, 401);
  });
  p.on("POST", `${base}/:channel/order/:link`, (r) => {
    if (r.headers.get("authorization") !== `Bearer ${state.token}`) return unauthorised();
    if (r.params.link !== DELIVERECT_LINK) return json({ message: "Channel link not found" }, 404);
    const b = JSON.parse(r.body) as { channelOrderId: string };
    // A channelOrderId cannot be reused within 48 hours.
    if (state.orders.has(b.channelOrderId)) return json({ message: "Order already exists" }, 400);
    state.orders.set(b.channelOrderId, b);
    return new Response(null, { status: 201 });
  });
  return state;
}

/** A Deliverect order status update, as its webhook sends it, signed as Deliverect signs it. */
export async function deliverectStatus(
  channelOrderId: string,
  status: number,
  secret: string,
  reason?: string,
): Promise<{ body: string; headers: Headers }> {
  const body = JSON.stringify({
    orderId: "65f0c0ffee0000000000abcd",
    status,
    timeStamp: "2026-11-04T03:41:00.000Z",
    channelOrderId,
    channelLink: DELIVERECT_LINK,
    location: "5f8a7b6c5d4e3f2a1b0c0000",
    ...(reason ? { reason } : {}),
  });
  return { body, headers: new Headers({ "x-server-authorization-hmac-sha256": await hmacSha256Hex(secret, body) }) };
}
