import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ElsewhereOrder,
  type HookEvent,
  type RunContext,
  type SetupSnapshot,
  type SnapshotOptionGroup,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { constantTimeEqual } from "../pay-sign";
import { allergenCodesOf, failOn, jsonOf, minorOf, short, snapshotItem } from "./common";

/**
 * GloriaFood (ADR-040), with the keys a restaurant makes in its own admin panel: Others → 3rd party
 * integrations → Enabled integrations, one template each. The **Fetch Menu** key reads the menu, which
 * the owner keeps item by item, its allergens unconfirmed (`GET https://pos.globalfoodsoft.com/pos/menu`,
 * `Glf-Api-Version: 2`). The **Poll Accepted Order v2** key, given only if the owner wants it, reads the
 * orders the restaurant accepted in GloriaFood (`POST /pos/order/pop`) for the owner's view only, while
 * they switch it on: no customer details are kept, no item is made, nothing is a receipt (I-Q6). Ordering
 * itself goes to the restaurant's own GloriaFood page, its door elsewhere.
 *
 * A push GloriaFood sends to the connection's own address carries a master key in `Authorization`,
 * compared here in constant time; its body is never kept: it makes the next read happen at once.
 *
 * Source, read 21 Oct 2026: https://github.com/GlobalFood/integration_docs (fetch_menu/README.md,
 * accepted_orders/README.md, and their payload examples).
 */

export const GLORIAFOOD_API = "https://pos.globalfoodsoft.com";

export const gloriafoodForm = z.object({
  menuKey: secretField(z.string().trim().min(6).max(200), {
    label: "Fetch Menu key",
    help: "In GloriaFood's admin panel: Others → 3rd party integrations → Enabled integrations → add Fetch Menu, then copy its key.",
    link: {
      href: "https://github.com/GlobalFood/integration_docs/blob/master/fetch_menu/README.md",
      text: "Where the key is",
    },
  }),
  ordersKey: secretField(z.string().trim().min(6).max(200).optional(), {
    label: "Poll Accepted Order v2 key",
    help: "Only to see here the orders you accept in GloriaFood: add Poll Accepted Order v2 and copy its key. They are shown to you alone.",
    advanced: true,
  }),
  masterKey: secretField(z.string().trim().min(6).max(200).optional(), {
    label: "Push master key",
    help: "Only if GloriaFood pushes accepted orders to this connection's address: the master key it sends.",
    advanced: true,
  }),
});

const HEADERS = (key: string) => ({
  authorization: key,
  accept: "application/json",
  "glf-api-version": "2",
});

async function readMenu(ctx: Pick<ConnectContext, "http">, key: string): Promise<GloriaMenu> {
  const res = await ctx.http.request({ method: "GET", url: `${GLORIAFOOD_API}/pos/menu`, headers: HEADERS(key) });
  failOn("GloriaFood", res, "menuKey");
  const menu = jsonOf(res) as GloriaMenu | null;
  if (res.status !== 200 || !menu || !Array.isArray(menu.categories)) {
    throw new ConnectorError("bad_response", "GloriaFood did not send a menu for that key.", { field: "menuKey" });
  }
  return menu;
}

interface GloriaOption {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly price?: unknown;
  readonly default?: unknown;
}
interface GloriaGroup {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly required?: unknown;
  readonly force_min?: unknown;
  readonly force_max?: unknown;
  readonly options?: readonly GloriaOption[];
}
interface GloriaItem {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly price?: unknown;
  readonly active?: unknown;
  readonly tags?: readonly unknown[] | null;
  readonly sizes?: readonly (GloriaOption & { groups?: readonly GloriaGroup[] })[];
  readonly groups?: readonly GloriaGroup[];
  readonly extras?: { readonly menu_item_allergens_values?: readonly { name?: unknown }[] } | null;
}
interface GloriaMenu {
  readonly id?: unknown;
  readonly restaurant_id?: unknown;
  readonly currency?: unknown;
  readonly categories: readonly {
    name?: unknown;
    active?: unknown;
    items?: readonly GloriaItem[];
    groups?: readonly GloriaGroup[];
  }[];
}

/** GloriaFood's tags in the menu's vocabulary; RAW has no word there. */
const TAGS: Readonly<Record<string, string>> = {
  VEGETARIAN: "vegetarian",
  VEGAN: "vegan",
  GLUTEN_FREE: "gluten_free",
  HALAL: "halal",
  NUT_FREE: "nut_free",
  DAIRY_FREE: "dairy_free",
  HOT: "spicy",
};

function group(g: GloriaGroup, currency: string): SnapshotOptionGroup | null {
  const choices = (g.options ?? []).flatMap((o) => {
    const name = short(o.name, 120);
    if (!name || o.id === undefined) return [];
    return [
      {
        externalId: String(o.id),
        name,
        priceDelta: minorOf(o.price, currency) ?? 0,
        ...(o.default === true ? { default: true } : {}),
      },
    ];
  });
  if (choices.length === 0 || g.id === undefined) return null;
  // force_min is how many a required group takes at least; a group that is not required takes none.
  const min = g.required === true ? Math.max(Number(g.force_min) || 0, 1) : 0;
  const max = Math.max(Number(g.force_max) || choices.length, min, 1);
  return { externalId: String(g.id), name: short(g.name, 120) || "Options", min, max, choices };
}

/** GloriaFood's menu as a snapshot: sizes as a group of their own, the category's groups on each item. */
export function gloriafoodSnapshot(menu: GloriaMenu, now: number): SetupSnapshot {
  const currency = String(menu.currency ?? "").toUpperCase();
  return {
    source: { kind: "gloriafood", account: String(menu.restaurant_id ?? menu.id ?? ""), readAt: now },
    menu: menu.categories
      .filter((c) => c.active !== false)
      .map((c) => ({
        name: short(c.name, 120) || "Menu",
        items: (c.items ?? [])
          .filter((i) => i.active !== false && i.id !== undefined && short(i.name))
          .map((i) => {
            const groups: SnapshotOptionGroup[] = [];
            const sizes = (i.sizes ?? []).filter((s) => s.id !== undefined);
            if (sizes.length > 0) {
              const g = group(
                {
                  id: `size-${String(i.id)}`,
                  name: "Size",
                  required: true,
                  force_min: 1,
                  force_max: 1,
                  options: sizes,
                },
                currency,
              );
              if (g) groups.push(g);
              // The groups of the default size: what most people order.
              const first = sizes.find((s) => s.default === true) ?? sizes[0];
              for (const sg of first?.groups ?? []) {
                const x = group(sg, currency);
                if (x) groups.push(x);
              }
            }
            for (const g of [...(i.groups ?? []), ...(c.groups ?? [])]) {
              const x = group(g, currency);
              if (x) groups.push(x);
            }
            const price = minorOf(i.price, currency);
            return snapshotItem({
              externalId: String(i.id),
              name: short(i.name),
              description: short(i.description, 2000) || null,
              price: price === null ? null : { value: price, currency },
              contains: allergenCodesOf((i.extras?.menu_item_allergens_values ?? []).map((a) => a.name)),
              optionGroups: groups.slice(0, 20),
              dietary: (i.tags ?? []).flatMap((t) => (typeof t === "string" && TAGS[t] ? [TAGS[t] as string] : [])),
            });
          }),
      }))
      .filter((s) => s.items.length > 0),
  };
}

/** An accepted order as the owner's view keeps it: its lines and when, never who ordered or where they live. */
export function gloriafoodOrder(o: Record<string, unknown>, now: number): ElsewhereOrder | null {
  if (o.id === undefined || o.id === null) return null;
  const currency = String(o.currency ?? "").toUpperCase();
  const type = String(o.type ?? "");
  const total = currency ? minorOf(o.total_price, currency) : null;
  const at = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  return {
    externalId: String(o.id),
    acceptedAt: at(o.accepted_at) ?? now,
    method:
      type === "pickup"
        ? "pickup"
        : type === "delivery"
          ? "delivery"
          : type === "table_reservation" || type === "dine_in"
            ? "dine_in"
            : "other",
    fulfilAt: at(o.fulfill_at),
    total: total === null ? null : { value: total, currency },
    lines: items
      .filter((i) => i.type === "item" || i.type === undefined)
      .slice(0, 100)
      .map((i) => ({
        name: short(i.name, 120),
        quantity: Math.max(1, Math.trunc(Number(i.quantity) || 1)),
        options: (Array.isArray(i.options) ? (i.options as Record<string, unknown>[]) : [])
          .slice(0, 20)
          .map((x) => short(x.name, 80))
          .filter(Boolean),
      })),
  };
}

export function gloriafoodConnector(): ConnectorDefinition {
  return {
    kind: "gloriafood",
    title: "GloriaFood",
    group: "pos",
    capabilities: ["setup_in"],
    auth: "form",
    form: gloriafoodForm,
    note: "Your menu comes in to start from, item by item; you confirm each dish's allergens yourself. Orders keep going to your GloriaFood page.",
    action: "Connect GloriaFood",
    disconnectNote: "Remove the integrations in GloriaFood: Others → 3rd party integrations.",

    async connect(ctx, input) {
      const key = (input.menuKey ?? "").trim();
      if (!key) throw new ConnectorError("config", "Paste the Fetch Menu key.", { field: "menuKey" });
      const menu = await readMenu(ctx, key);
      const account = String(menu.restaurant_id ?? menu.id ?? "");
      if (!account) throw new ConnectorError("bad_response", "GloriaFood did not say which restaurant this is.");
      const secret: Record<string, string> = { menuKey: key };
      if (input.ordersKey?.trim()) secret.ordersKey = input.ordersKey.trim();
      if (input.masterKey?.trim()) secret.masterKey = input.masterKey.trim();
      return {
        account: `GloriaFood restaurant ${account}`,
        externalId: account,
        secret,
        // Where a push of accepted orders goes, if the restaurant sets one up: the connection's own address.
        ...(ctx.hookUrl ? { extra: { hook_url: ctx.hookUrl } } : {}),
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
        choices: [
          {
            key: "orders_view",
            label: "Orders you accept in GloriaFood",
            options: [
              { id: "off", name: "Not shown here" },
              { id: "on", name: "Shown here, to you alone" },
            ],
            value: "off",
          },
        ],
      };
    },

    setup: {
      async read(ctx: RunContext) {
        return gloriafoodSnapshot(await readMenu(ctx, ctx.secret.menuKey ?? ""), ctx.now);
      },
    },

    elsewhere: {
      async poll(ctx: RunContext) {
        const key = ctx.secret.ordersKey;
        if (!key) return [];
        const res = await ctx.http.request({
          method: "POST",
          url: `${GLORIAFOOD_API}/pos/order/pop`,
          headers: HEADERS(key),
        });
        failOn("GloriaFood", res, "ordersKey");
        if (res.status !== 200)
          throw new ConnectorError("bad_response", `GloriaFood answered ${res.status} to the orders read.`);
        const body = jsonOf(res) as { orders?: unknown } | null;
        const orders = Array.isArray(body?.orders) ? (body.orders as Record<string, unknown>[]) : [];
        return orders.flatMap((o) => {
          const x = gloriafoodOrder(o, ctx.now);
          return x ? [x] : [];
        });
      },
    },

    hooks: {
      topics: ["orders"],
      async verify(ctx, request): Promise<HookEvent | null> {
        const master = ctx.secret.masterKey;
        const sent = request.headers.get("authorization") ?? "";
        if (!master || !constantTimeEqual(sent, master)) {
          throw new ConnectorError("refused", "That is not GloriaFood's master key for this connection.");
        }
        // Only the ids are read, to count a push sent twice once; the body is never kept.
        let ids: string[] = [];
        try {
          const body = JSON.parse(request.body) as { orders?: { id?: unknown }[] };
          ids = (body.orders ?? [])
            .flatMap((o) => (o.id !== undefined ? [String(o.id).slice(0, 40)] : []))
            .slice(0, 50);
        } catch {
          ids = [];
        }
        if (ids.length === 0) return null;
        return { eventId: `orders:${ids.join(",")}`.slice(0, 200), topic: "orders", refs: ids };
      },
      async read() {
        return [{ kind: "sync" }];
      },
    },
  };
}
