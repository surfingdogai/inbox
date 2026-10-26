import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  field,
  type RunContext,
  type SetupSnapshot,
  type SnapshotOptionGroup,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { clientToken, failOn, jsonOf, minorOf, short, snapshotItem } from "./common";

/**
 * Flipdish (ADR-036), with an OAuth app the restaurant makes in its own Flipdish account: portal →
 * Developer tools → OAuth apps → Add New; its Client ID and Secret Key are pasted here, and the inbox
 * asks Flipdish for a token with them each time (`client_credentials`, scope `api`), keeping no token.
 *
 * What it does: the store's menu, read to start from item by item (`GET /api/v1.0/menus/{menuId}`), its
 * collection hours (the store's `PickupHours`, in its own `IanaTimeZone`), and pausing: when the owner
 * chose so, pausing the kitchen here closes the store for collection and delivery in Flipdish until then
 * (`POST /api/v1.0/stores/{storeId}/businesshoursoverrides`, Type `Closed`), and resuming deletes those
 * closures, the ones this inbox made, kept sealed by their ids: a closure the owner set in Flipdish
 * (a holiday, a short-staffed evening) stays. Ordering stays on the restaurant's own Flipdish page, its door elsewhere: no
 * order is written into Flipdish (no third-party order-injection is documented, unknown).
 *
 * Sources, read 21 Oct 2026: https://developers.flipdish.com/docs/oauth-and-webhooks-integrator-guide,
 * https://developers.flipdish.com/docs/api-overview and the Open API v1.0 document at
 * https://api.flipdish.co/swagger/docs/v1.0 (Stores, Menus, BusinessHoursOverride). Limits: 50 requests
 * a minute per address by default.
 */

export const FLIPDISH_API = "https://api.flipdish.co";
export const FLIPDISH_TOKEN_URL = `${FLIPDISH_API}/identity/connect/token`;

export const flipdishForm = z.object({
  clientId: field(z.string().trim().min(4).max(200), {
    label: "Client ID",
    help: "In the Flipdish portal: your avatar → Developer tools → OAuth apps → Add New. Copy its Client ID.",
    link: {
      href: "https://developers.flipdish.com/docs/oauth-and-webhooks-integrator-guide",
      text: "How to make the app",
    },
  }),
  clientSecret: secretField(z.string().trim().min(8).max(500), {
    label: "Secret Key",
    help: "On the same app: Reveal secret key, then copy it.",
  }),
});

async function token(ctx: Pick<ConnectContext, "http">, clientId: string, clientSecret: string): Promise<string> {
  return clientToken(ctx, {
    tool: "Flipdish",
    url: FLIPDISH_TOKEN_URL,
    body: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "api" },
  });
}

async function call(ctx: Pick<ConnectContext, "http">, bearer: string, method: string, path: string, json?: unknown) {
  const res = await ctx.http.request({
    method,
    url: `${FLIPDISH_API}${path}`,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  failOn("Flipdish", res, "clientSecret");
  return { res, json: jsonOf(res) as { Data?: unknown } | null };
}

interface FlipdishStore {
  readonly StoreId?: unknown;
  readonly Name?: unknown;
  readonly MenuId?: unknown;
  readonly IanaTimeZone?: unknown;
  readonly Currency?: unknown;
  readonly PickupHours?: readonly { DayOfWeek?: unknown; StartTime?: unknown; Period?: unknown }[];
}

const DAYS: Readonly<Record<string, string>> = {
  Monday: "mon",
  Tuesday: "tue",
  Wednesday: "wed",
  Thursday: "thu",
  Friday: "fri",
  Saturday: "sat",
  Sunday: "sun",
};

/** "11:30" or "11:30:00" as minutes; a period may run past a day ("1.02:00:00" is 26 hours). */
function minutesOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** A store's collection hours as weekly windows, in its own zone; a window past midnight stops at 24:00. */
export function flipdishHours(store: FlipdishStore): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const p of store.PickupHours ?? []) {
    const day = typeof p.DayOfWeek === "string" ? DAYS[p.DayOfWeek] : undefined;
    const start = minutesOf(p.StartTime);
    const period = minutesOf(p.Period);
    if (!day || start === null || period === null || period <= 0 || start >= 1440) continue;
    const end = Math.min(1440, start + period);
    const windows = out[day] ?? [];
    windows.push([hhmm(start), end === 1440 ? "24:00" : hhmm(end)]);
    out[day] = windows;
  }
  return out;
}

interface FlipdishMenu {
  readonly MenuSections?: readonly {
    Name?: unknown;
    IsAvailable?: unknown;
    IsHiddenFromCustomers?: unknown;
    MenuItems?: readonly {
      MenuItemId?: unknown;
      Name?: unknown;
      Description?: unknown;
      Price?: unknown;
      IsAvailable?: unknown;
      Alcohol?: unknown;
      MenuItemOptionSets?: readonly {
        MenuItemOptionSetId?: unknown;
        Name?: unknown;
        MinSelectCount?: unknown;
        MaxSelectCount?: unknown;
        MenuItemOptionSetItems?: readonly {
          MenuItemOptionSetItemId?: unknown;
          Name?: unknown;
          Price?: unknown;
          IsAvailable?: unknown;
        }[];
      }[];
    }[];
  }[];
}

/** A Flipdish menu as a snapshot. Flipdish keeps no allergens here: every dish arrives with none, unconfirmed. */
export function flipdishSnapshot(store: FlipdishStore, menu: FlipdishMenu, now: number): SetupSnapshot {
  const currency = String(store.Currency ?? "").toUpperCase();
  const zone = typeof store.IanaTimeZone === "string" ? store.IanaTimeZone : undefined;
  return {
    source: { kind: "flipdish", account: String(store.StoreId ?? ""), readAt: now, ...(zone ? { zone } : {}) },
    hours: flipdishHours(store),
    menu: (menu.MenuSections ?? [])
      .filter((s) => s.IsAvailable !== false && s.IsHiddenFromCustomers !== true)
      .map((s) => ({
        name: short(s.Name, 120) || "Menu",
        items: (s.MenuItems ?? [])
          .filter((i) => i.IsAvailable !== false && i.MenuItemId !== undefined && short(i.Name))
          .map((i) => {
            const groups: SnapshotOptionGroup[] = (i.MenuItemOptionSets ?? []).flatMap((g) => {
              const choices = (g.MenuItemOptionSetItems ?? [])
                .filter((c) => c.IsAvailable !== false && c.MenuItemOptionSetItemId !== undefined && short(c.Name))
                .map((c) => ({
                  externalId: String(c.MenuItemOptionSetItemId),
                  name: short(c.Name, 120),
                  priceDelta: minorOf(c.Price, currency) ?? 0,
                }));
              if (choices.length === 0 || g.MenuItemOptionSetId === undefined) return [];
              const min = Math.max(0, Number(g.MinSelectCount) || 0);
              const max = Math.max(Number(g.MaxSelectCount) || choices.length, min, 1);
              return [
                { externalId: String(g.MenuItemOptionSetId), name: short(g.Name, 120) || "Options", min, max, choices },
              ];
            });
            const price = minorOf(i.Price, currency);
            return snapshotItem({
              externalId: String(i.MenuItemId),
              name: short(i.Name),
              description: short(i.Description, 2000) || null,
              price: price === null ? null : { value: price, currency },
              optionGroups: groups.slice(0, 20),
            });
          }),
      }))
      .filter((s) => s.items.length > 0),
  };
}

const PAGE = 50;
const PAGES = 20;

/** The stores this app reaches, page by page (50 a page), up to a thousand. */
async function stores(ctx: Pick<ConnectContext, "http">, bearer: string): Promise<FlipdishStore[]> {
  const all: FlipdishStore[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const { res, json } = await call(ctx, bearer, "GET", `/api/v1.0/stores?page=${page}&limit=${PAGE}`);
    if (res.status !== 200 || !Array.isArray(json?.Data)) {
      throw new ConnectorError("bad_response", "Flipdish did not list the stores this app can reach.");
    }
    const data = json.Data as FlipdishStore[];
    all.push(...data);
    const total = Number((json as { TotalRecordCount?: unknown }).TotalRecordCount);
    if (data.length < PAGE || (Number.isFinite(total) && all.length >= total)) break;
  }
  return all;
}

/**
 * The store the owner chose, and only that one: pausing never closes, nor resuming opens, another. One
 * that is not on the app any more is said so, never stood in for by the first.
 */
async function storeOf(ctx: RunContext, bearer: string): Promise<FlipdishStore> {
  const chosen = ctx.choices?.store ?? null;
  const all = await stores(ctx, bearer);
  if (all.length === 0)
    throw new ConnectorError("not_found", "This Flipdish app reaches no store. Add one to it in Flipdish.");
  const store =
    chosen === null ? (all.length === 1 ? all[0] : undefined) : all.find((s) => String(s.StoreId) === chosen);
  if (!store) {
    throw new ConnectorError(
      "not_found",
      "The Flipdish store you chose is not on this app any more: choose the store again in Settings → Integrations.",
    );
  }
  return store;
}

/** The closures this inbox made while paused, by their ids, kept sealed with the app's key. */
const OVERRIDES = "pauseOverrides";
const overridesOf = (ctx: RunContext): string[] =>
  (ctx.secret[OVERRIDES] ?? "").split(",").filter((x) => /^\d+$/.test(x));

export function flipdishConnector(): ConnectorDefinition {
  return {
    kind: "flipdish",
    title: "Flipdish",
    group: "pos",
    capabilities: ["setup_in"],
    auth: "form",
    form: flipdishForm,
    note: "Your menu and hours come in to start from; pausing here can close your Flipdish store too. Orders keep going to your Flipdish page.",
    action: "Connect Flipdish",
    disconnectNote: "Delete the OAuth app in Flipdish: Developer tools → OAuth apps.",

    async connect(ctx, input) {
      const clientId = (input.clientId ?? "").trim();
      const clientSecret = (input.clientSecret ?? "").trim();
      if (!clientId) throw new ConnectorError("config", "Paste the Client ID.", { field: "clientId" });
      if (!clientSecret) throw new ConnectorError("config", "Paste the Secret Key.", { field: "clientSecret" });
      const bearer = await token(ctx, clientId, clientSecret);
      const all = await stores(ctx, bearer);
      if (all.length === 0)
        throw new ConnectorError("not_found", "This Flipdish app reaches no store. Add one to it in Flipdish.");
      const first = all[0] as FlipdishStore;
      return {
        account: short(first.Name, 120) || "Flipdish",
        externalId: `app:${clientId}`,
        secret: { clientId, clientSecret },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
        choices: [
          {
            key: "store",
            label: "Store",
            options: all
              .slice(0, 50)
              .map((s) => ({ id: String(s.StoreId), name: short(s.Name, 120) || String(s.StoreId) })),
            value: String(first.StoreId),
          },
        ],
      };
    },

    setup: {
      async read(ctx: RunContext) {
        const bearer = await token(ctx, ctx.secret.clientId ?? "", ctx.secret.clientSecret ?? "");
        const store = await storeOf(ctx, bearer);
        if (store.MenuId === undefined || store.MenuId === null) {
          return flipdishSnapshot(store, {}, ctx.now);
        }
        const { res, json } = await call(
          ctx,
          bearer,
          "GET",
          `/api/v1.0/menus/${encodeURIComponent(String(store.MenuId))}`,
        );
        if (res.status !== 200) throw new ConnectorError("bad_response", "Flipdish did not send the store's menu.");
        return flipdishSnapshot(store, (json?.Data ?? {}) as FlipdishMenu, ctx.now);
      },
    },

    pause: {
      async pause(ctx: RunContext, until: number) {
        const bearer = await token(ctx, ctx.secret.clientId ?? "", ctx.secret.clientSecret ?? "");
        const store = await storeOf(ctx, bearer);
        const made = overridesOf(ctx);
        try {
          for (const DeliveryType of ["Pickup", "Delivery"]) {
            const { res, json } = await call(
              ctx,
              bearer,
              "POST",
              `/api/v1.0/stores/${String(store.StoreId)}/businesshoursoverrides`,
              {
                DeliveryType,
                StartTime: new Date(ctx.now).toISOString(),
                EndTime: new Date(until).toISOString(),
                Type: "Closed",
              },
            );
            if (res.status !== 200)
              throw new ConnectorError(
                "refused",
                `Flipdish did not close the store for ${DeliveryType.toLowerCase()}.`,
              );
            const id = (json?.Data as { BusinessHoursOverrideId?: unknown } | undefined)?.BusinessHoursOverrideId;
            if (id !== undefined && /^\d+$/.test(String(id))) made.push(String(id));
          }
        } finally {
          // Whatever was closed is kept, so resuming opens exactly that.
          await ctx.saveSecret({ ...ctx.secret, [OVERRIDES]: made.slice(-40).join(",") });
        }
      },
      async resume(ctx: RunContext) {
        const made = overridesOf(ctx);
        if (made.length === 0) return;
        const bearer = await token(ctx, ctx.secret.clientId ?? "", ctx.secret.clientSecret ?? "");
        const store = await storeOf(ctx, bearer);
        // Only the closures this inbox made: one the owner set in Flipdish stays, whenever it holds.
        const left: string[] = [];
        for (const id of made) {
          const { res } = await call(
            ctx,
            bearer,
            "DELETE",
            `/api/v1.0/stores/${String(store.StoreId)}/businesshoursoverrides/${id}`,
          );
          if (res.status !== 200 && res.status !== 204 && res.status !== 404) left.push(id);
        }
        const { [OVERRIDES]: _gone, ...rest } = ctx.secret;
        await ctx.saveSecret(left.length ? { ...rest, [OVERRIDES]: left.join(",") } : rest);
        if (left.length) throw new ConnectorError("refused", "Flipdish did not open the store again: open it there.");
      },
    },
  };
}
