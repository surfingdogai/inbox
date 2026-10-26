import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type OutboundOrder,
  type PosOrderRef,
  type PosOrderState,
  type RunContext,
  type SetupSnapshot,
  type SnapshotOptionGroup,
} from "@surfingdog/core";
import { z } from "zod";
import { uuidFrom } from "../work/common";
import { failOn, jsonOf, minorOf, short, snapshotItem, tillCurrency } from "./common";

/**
 * Toast (ADR-040), built and switched off: Toast gives API access only to approved partners, after an
 * application and a certification, as client credentials and the API hostname to call. Until whoever runs
 * the server holds them (`TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_API_HOST`), the card says "Needs
 * setup" and has nothing to press.
 *
 * With them: a restaurant grants this partner access in Toast; Connect lists the restaurants the partner
 * may reach (`GET /partners/v1/restaurants`) to choose from. The menu comes in to start from
 * (`GET /menus/v2/menus`, `Toast-Restaurant-External-ID`; Toast's allergen fields are "not currently
 * supported for external integrations", so every dish arrives with none, unconfirmed). An order the
 * business accepts here is posted to Toast (`POST /orders/v2/orders`) on the dining option of its kind
 * (`GET /config/v2/diningOptions`: TAKE_OUT, DELIVERY, DINE_IN), with Toast's own item and modifier
 * GUIDs from the menu that came in, and an `externalId` the inbox makes from its own mark so the same
 * order is found again rather than posted twice. Its `approvalStatus` is its word back: NEEDS_APPROVAL
 * waits, APPROVED and FUTURE are accepted, NOT_APPROVED is refused, a voided order is cancelled.
 *
 * As the Orders OpenAPI (v2.12.0) asks of a POST: every selection names its item and its menu group
 * (`itemGroup`), every modifier its option group (`optionGroup`), both from the menu that came in; a
 * delivery carries its `deliveryInfo` (address1, city, state, zipCode); and a `customer` goes with all of
 * first name, last name, email and phone or not at all (the inbox hands a till a first name only, so it
 * sends none). Toast refuses an `externalId` it has seen: that answer is the order already there. The
 * login's token is kept sealed until it runs out, never asked for on every call (Toast limits logins).
 *
 * Sources, read 21 Oct 2026: the OpenAPI documents behind https://doc.toasttab.com/openapi/ (authentication,
 * partners, menus v2, orders v2, configuration v2). The developer guide's pages answered 403 to automated
 * reads; what they add (rate limits, the hostname per environment) is the partner's to confirm.
 */

export interface ToastPartner {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The API hostname Toast gives with the credentials: https, a host only. */
  readonly apiHost: string;
}

export const TOAST_NOT_READY = "Needs setup: Toast gives API access to approved partners only.";

const hostOk = (h: string) => /^https:\/\/[a-z0-9.-]+\.toasttab\.com$/.test(h);

/** A login's token, by the partner's client, held until a minute before Toast says it runs out. */
const tokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

async function login(ctx: Pick<ConnectContext, "http" | "now">, p: ToastPartner): Promise<string> {
  return (await loginFor(ctx, p)).token;
}

async function loginFor(
  ctx: Pick<ConnectContext, "http" | "now">,
  p: ToastPartner,
): Promise<{ token: string; expiresAt: number }> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${p.apiHost}/authentication/v1/authentication/login`,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      userAccessType: "TOAST_MACHINE_CLIENT",
    }),
  });
  failOn("Toast", res, "clientSecret");
  const body = (jsonOf(res) as { token?: { accessToken?: unknown; expiresIn?: unknown } } | null)?.token;
  const t = body?.accessToken;
  if (res.status !== 200 || typeof t !== "string")
    throw new ConnectorError("auth", "Toast did not take the partner credentials.");
  const seconds = Number(body?.expiresIn);
  const held = { token: t, expiresAt: ctx.now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 };
  tokens.set(p.clientId, held);
  return held;
}

/**
 * The partner's token for a run: the one this process holds, else the one kept sealed on the connection,
 * else a new login (kept sealed for the next run). `fresh` asks for a new one, after a 401.
 */
async function tokenFor(ctx: RunContext, p: ToastPartner, fresh = false): Promise<string> {
  const ok = (t: { expiresAt: number } | undefined): t is { token: string; expiresAt: number } =>
    t !== undefined && t.expiresAt - 60_000 > ctx.now;
  if (!fresh) {
    const mine = tokens.get(p.clientId);
    if (ok(mine)) return mine.token;
    const sealed = { token: ctx.secret.accessToken ?? "", expiresAt: Number(ctx.secret.expiresAt) };
    if (sealed.token && ok(sealed)) {
      tokens.set(p.clientId, sealed);
      return sealed.token;
    }
  }
  tokens.delete(p.clientId);
  const next = await loginFor(ctx, p);
  await ctx.saveSecret({ ...ctx.secret, accessToken: next.token, expiresAt: String(next.expiresAt) });
  return next.token;
}

/** A call with the held token; a 401 logs in once more and tries again. */
async function authed(
  ctx: RunContext,
  p: ToastPartner,
  method: string,
  path: string,
  o: { readonly restaurant?: string | undefined; readonly json?: unknown } = {},
) {
  try {
    return await call(ctx, p, await tokenFor(ctx, p), method, path, o);
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "auth") throw error;
    return call(ctx, p, await tokenFor(ctx, p, true), method, path, o);
  }
}

async function call(
  ctx: Pick<ConnectContext, "http">,
  p: ToastPartner,
  token: string,
  method: string,
  path: string,
  o: { readonly restaurant?: string | undefined; readonly json?: unknown } = {},
) {
  const res = await ctx.http.request({
    method,
    url: `${p.apiHost}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(o.restaurant ? { "toast-restaurant-external-id": o.restaurant } : {}),
      ...(o.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}),
  });
  failOn("Toast", res, "restaurant");
  return { res, json: jsonOf(res) };
}

interface ToastItem {
  readonly guid?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly price?: unknown;
  readonly modifierGroupReferences?: readonly unknown[];
}
interface ToastGroup {
  readonly guid?: unknown;
  readonly name?: unknown;
  readonly menuItems?: readonly ToastItem[];
  readonly menuGroups?: readonly ToastGroup[];
}
interface ToastRestaurant {
  readonly restaurantGuid?: unknown;
  readonly restaurantTimeZone?: unknown;
  readonly menus?: readonly { name?: unknown; menuGroups?: readonly ToastGroup[] }[];
  readonly modifierGroupReferences?: Readonly<
    Record<
      string,
      {
        guid?: unknown;
        name?: unknown;
        minSelections?: unknown;
        maxSelections?: unknown;
        modifierOptionReferences?: readonly unknown[];
      }
    >
  >;
  readonly modifierOptionReferences?: Readonly<
    Record<string, { guid?: unknown; name?: unknown; price?: unknown; isDefault?: unknown }>
  >;
}

/** Toast's menus as a snapshot: each menu group a section, its modifier groups by their references. */
export function toastSnapshot(r: ToastRestaurant, currency: string, now: number): SetupSnapshot {
  const groupsOf = (refs: readonly unknown[] | undefined): SnapshotOptionGroup[] =>
    (refs ?? []).flatMap((ref) => {
      const g = r.modifierGroupReferences?.[String(ref)];
      if (!g || g.guid === undefined) return [];
      const choices = (g.modifierOptionReferences ?? []).flatMap((oref) => {
        const o = r.modifierOptionReferences?.[String(oref)];
        if (!o || o.guid === undefined || !short(o.name)) return [];
        return [
          {
            externalId: String(o.guid),
            name: short(o.name, 120),
            priceDelta: minorOf(o.price, currency) ?? 0,
            ...(o.isDefault === true ? { default: true } : {}),
          },
        ];
      });
      if (choices.length === 0) return [];
      const min = Math.max(0, Number(g.minSelections) || 0);
      const max =
        g.maxSelections === null || g.maxSelections === undefined
          ? choices.length
          : Math.max(Number(g.maxSelections) || 1, min, 1);
      return [{ externalId: String(g.guid), name: short(g.name, 120) || "Options", min, max, choices }];
    });
  const sections: NonNullable<SetupSnapshot["menu"]>[number][] = [];
  const walk = (g: ToastGroup) => {
    const items = (g.menuItems ?? []).flatMap((i) => {
      if (i.guid === undefined || !short(i.name)) return [];
      const price = minorOf(i.price, currency);
      return [
        snapshotItem({
          externalId: String(i.guid),
          // A POST names the item's menu group (`itemGroup`): kept with the item from here.
          ...(g.guid !== undefined ? { groupExternalId: String(g.guid) } : {}),
          name: short(i.name),
          description: short(i.description, 2000) || null,
          price: price === null ? null : { value: price, currency },
          optionGroups: groupsOf(i.modifierGroupReferences).slice(0, 20),
        }),
      ];
    });
    if (items.length) sections.push({ name: short(g.name, 120) || "Menu", items });
    for (const sub of g.menuGroups ?? []) walk(sub);
  };
  for (const m of r.menus ?? []) for (const g of m.menuGroups ?? []) walk(g);
  const zone = typeof r.restaurantTimeZone === "string" ? r.restaurantTimeZone : undefined;
  return {
    source: { kind: "toast", account: String(r.restaurantGuid ?? ""), readAt: now, ...(zone ? { zone } : {}) },
    menu: sections,
  };
}

/** Toast's approval status as where the order stands. */
export function toastState(order: { approvalStatus?: unknown; voided?: unknown }): PosOrderState | null {
  if (order.voided === true) return { status: "cancelled" };
  switch (order.approvalStatus) {
    case "NEEDS_APPROVAL":
      return { status: "pending" };
    case "APPROVED":
    case "FUTURE":
      return { status: "accepted" };
    case "NOT_APPROVED":
      return { status: "rejected" };
    default:
      return null;
  }
}

/** A US state, or a region, as Toast's `state` takes it: "US-NY" and "NY" are both "NY". */
function stateOf(region: string | undefined): string | null {
  const r = (region ?? "").trim().toUpperCase();
  const m = /^(?:[A-Z]{2}-)?([A-Z0-9]{1,3})$/.exec(r);
  return m ? (m[1] as string) : null;
}

/**
 * The order as Toast takes it. Every line must be an item of the Toast menu that came in, with its menu
 * group, and every choice one of its modifiers with its option group: nothing is left out silently.
 */
export function toastOrderBody(o: OutboundOrder, externalId: string, diningOption: string): Record<string, unknown> {
  const missing = o.lines.find((l) => !l.externalId);
  if (missing)
    throw new ConnectorError("refused", `${missing.name} is not an item of the Toast menu this inbox brought in.`);
  const groupless = o.lines.find((l) => !l.groupExternalId);
  if (groupless)
    throw new ConnectorError(
      "refused",
      `${groupless.name} came in without its Toast menu group: bring the menu in again.`,
    );
  for (const l of o.lines) {
    const choice = l.options.find((x) => !x.externalId || !x.groupExternalId);
    if (choice)
      throw new ConnectorError("refused", `${choice.name} has no id in your Toast menu: bring the menu in again.`);
  }
  let deliveryInfo: Record<string, string> | undefined;
  if (o.method === "delivery") {
    const a = o.address;
    const state = stateOf(a?.addressRegion);
    if (!a?.streetAddress || !a.addressLocality || !a.postalCode || !state) {
      throw new ConnectorError("refused", "Toast needs the delivery address's street, city, state and postal code.");
    }
    deliveryInfo = {
      address1: a.streetAddress.slice(0, 200),
      city: a.addressLocality.slice(0, 100),
      state,
      zipCode: a.postalCode.slice(0, 20),
    };
  }
  return {
    externalId,
    diningOption: { guid: diningOption, entityType: "DiningOption" },
    ...(o.slotStart !== null ? { promisedDate: new Date(o.slotStart).toISOString().replace("Z", "+0000") } : {}),
    ...(deliveryInfo ? { deliveryInfo } : {}),
    checks: [
      {
        selections: o.lines.map((l) => ({
          item: { guid: l.externalId, entityType: "MenuItem" },
          itemGroup: { guid: l.groupExternalId, entityType: "MenuGroup" },
          quantity: l.quantity,
          modifiers: l.options.map((x) => ({
            item: { guid: x.externalId, entityType: "MenuItem" },
            optionGroup: { guid: x.groupExternalId, entityType: "MenuOptionGroup" },
            quantity: 1,
          })),
          ...(l.note ? { specialRequest: l.note.slice(0, 140) } : {}),
        })),
      },
    ],
  };
}

/** Toast's answer that it holds an order under this `externalId` already. */
const seenBefore = (status: number, why: string) =>
  (status === 400 || status === 409) && /external ?id|already|duplicate/i.test(why);

export function toastConnector(partner: ToastPartner | null): ConnectorDefinition {
  const ready = partner !== null && hostOk(partner.apiHost) && Boolean(partner.clientId && partner.clientSecret);
  const p = partner as ToastPartner;
  const restaurantOf = (ctx: RunContext) =>
    ctx.choices?.restaurant ?? (typeof ctx.extra.restaurant === "string" ? ctx.extra.restaurant : "");
  const externalIdOf = async (ctx: RunContext, o: OutboundOrder) => `SURFINGDOG:${await uuidFrom(ctx.marker, o.key)}`;
  const findOrder = async (ctx: RunContext, order: OutboundOrder): Promise<PosOrderRef | null> => {
    const externalId = await externalIdOf(ctx, order);
    // Read back by the externalId the inbox gave it. The reference names the path's id as the order's
    // GUID: whether it finds an externalId too is to be confirmed in Toast's sandbox (partners doc).
    const { res, json } = await authed(ctx, p, "GET", `/orders/v2/orders/${encodeURIComponent(externalId)}`, {
      restaurant: restaurantOf(ctx),
    });
    const o = json as { guid?: unknown; approvalStatus?: unknown } | null;
    if (res.status === 200 && typeof o?.guid === "string") {
      const state = toastState(o);
      return { externalId: o.guid, ...(state ? { status: state.status } : {}) };
    }
    return null;
  };
  return {
    kind: "toast",
    title: "Toast",
    group: "pos",
    capabilities: ["setup_in", "orders_out", "status_in"],
    auth: "form",
    form: z.object({}),
    ready: () => (ready ? true : TOAST_NOT_READY),
    whenNotReady: {
      status: "setup",
      hint: "Not available yet: Toast lets only approved partners connect. Use GloriaFood or Flipdish meanwhile.",
      href: "https://surfingdog.ai/docs/ordering/#which-tills",
    },
    note: "Your Toast menu comes in to start from, and orders you accept here go into Toast.",
    action: "Connect Toast",

    async connect(ctx) {
      if (!ready) throw new ConnectorError("config", TOAST_NOT_READY);
      const token = await login(ctx, p);
      const { res, json } = await call(ctx, p, token, "GET", "/partners/v1/restaurants");
      const list = Array.isArray(json)
        ? (json as { restaurantGuid?: unknown; restaurantName?: unknown; locationName?: unknown; deleted?: unknown }[])
        : [];
      const open = list.filter((r) => r.deleted !== true && typeof r.restaurantGuid === "string");
      if (res.status !== 200 || open.length === 0) {
        throw new ConnectorError(
          "not_found",
          "No restaurant has given this inbox access in Toast yet: add it in Toast's integrations first.",
        );
      }
      const first = open[0] as { restaurantGuid: string; restaurantName?: unknown; locationName?: unknown };
      const name = (r: typeof first) =>
        [short(r.restaurantName, 80), short(r.locationName, 80)].filter(Boolean).join(", ") || r.restaurantGuid;
      return {
        account: name(first),
        externalId: open.length === 1 ? first.restaurantGuid : `partner:${p.clientId}`,
        secret: {},
        extra: { restaurant: first.restaurantGuid },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
        choices: [
          {
            key: "restaurant",
            label: "Restaurant",
            options: open.slice(0, 100).map((r) => ({ id: String(r.restaurantGuid), name: name(r as typeof first) })),
            value: first.restaurantGuid,
          },
        ],
      };
    },

    setup: {
      async read(ctx) {
        const restaurant = restaurantOf(ctx);
        const { res, json } = await authed(ctx, p, "GET", "/menus/v2/menus", { restaurant });
        if (res.status !== 200 || !json) throw new ConnectorError("bad_response", "Toast did not send the menus.");
        return toastSnapshot(json as ToastRestaurant, tillCurrency(ctx), ctx.now);
      },
    },

    orders: {
      // Toast refuses an externalId it has seen: a second write of the same order is answered as there.
      idempotent: true,
      async put(ctx, order): Promise<PosOrderRef> {
        const restaurant = restaurantOf(ctx);
        const options = await authed(ctx, p, "GET", "/config/v2/diningOptions", { restaurant });
        const behaviour =
          order.method === "delivery" ? "DELIVERY" : order.method === "dine_in" ? "DINE_IN" : "TAKE_OUT";
        const dining = (
          Array.isArray(options.json) ? (options.json as { guid?: unknown; behavior?: unknown }[]) : []
        ).find((d) => d.behavior === behaviour && typeof d.guid === "string");
        if (!dining)
          throw new ConnectorError(
            "refused",
            `Toast has no dining option for ${behaviour.toLowerCase().replace("_", " ")}.`,
          );
        const externalId = await externalIdOf(ctx, order);
        const { res, json } = await authed(ctx, p, "POST", "/orders/v2/orders", {
          restaurant,
          json: toastOrderBody(order, externalId, String(dining.guid)),
        });
        const o = json as { guid?: unknown; approvalStatus?: unknown } | null;
        if (res.status === 200 && typeof o?.guid === "string") {
          const state = toastState(o);
          return { externalId: o.guid, ...(state ? { status: state.status } : {}) };
        }
        if (res.status >= 400 && res.status < 500) {
          const why = short((json as { message?: unknown } | null)?.message, 200);
          // Ours already: Toast's own id for it, where it can be read back; else ours, followed by hand.
          if (seenBefore(res.status, why)) return (await findOrder(ctx, order)) ?? { externalId, status: "pending" };
          throw new ConnectorError(
            "refused",
            why ? `Toast would not take the order: ${why}` : "Toast would not take the order.",
          );
        }
        throw new ConnectorError("bad_response", `Toast answered ${res.status} to the order.`);
      },
      find: findOrder,
      async status(ctx, ref) {
        const { res, json } = await authed(ctx, p, "GET", `/orders/v2/orders/${encodeURIComponent(ref.externalId)}`, {
          restaurant: restaurantOf(ctx),
        });
        if (res.status !== 200 || !json) return null;
        return toastState(json as { approvalStatus?: unknown; voided?: unknown });
      },
    },
  };
}
