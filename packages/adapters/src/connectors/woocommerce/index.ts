import {
  type ConnectContext,
  type Connected,
  type ConnectionNote,
  type ConnectorDefinition,
  ConnectorError,
  field,
  type InboundRequest,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import {
  call,
  currencyRefusal,
  discover,
  type Keys,
  normalizeStore,
  pricesIncludeTax,
  SETTINGS_ROUTE,
  type Store,
  type StoreSettings,
  settingsOf,
  siteName,
  storeId,
} from "./api";
import { catalogue } from "./catalogue";
import { hooks, hooksStale, keepWebhooks, removeWebhooks } from "./hooks";
import { payments } from "./orders";
import { extraOf, keysOf, storeOf, type WooExtra } from "./state";

export { minorOf, normalizeStore, routeUrl, storeId } from "./api";
export { PAGE_SIZE as WOO_PAGE_SIZE } from "./catalogue";
export { WOO_TOPICS } from "./hooks";
export { orderBody as wooOrderBody, WOO_METHODS } from "./orders";

/**
 * WooCommerce (ADR-032): the business's own WordPress shop, with a key pair the store makes for this
 * inbox. Nobody holds a developer account: the owner presses **Connect your shop**, WooCommerce's own
 * Approve page opens in their WordPress admin (`/wc-auth/v1/authorize`, `read_write`), and the store
 * POSTs the key pair it made to this inbox, server to server, before the owner comes back
 * (https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication-endpoint). A store whose
 * Approve page cannot work (no pretty permalinks) takes a pair made by hand in WooCommerce → Settings →
 * Advanced → REST API instead, under More options.
 *
 * The store POSTs the key while it waits for this inbox's answer, so the key is taken as it comes (read
 * and write, the shape of a WooCommerce key) and checked against the store on the first sync, where a
 * failure is said on the connection: a small host may have no PHP worker free to answer the inbox
 * while one waits, and WooCommerce deletes the key unless it hears 200 within its time limit.
 *
 * Products and stock come into the catalogue; an order the inbox accepts is written into the store,
 * pending, and paid at the store's own checkout; what the store says became of it (paid, completed,
 * cancelled, refunded) is read back with the key, on each sync and when a signed webhook says
 * something changed. The business is the merchant: the money never passes the inbox, no card detail
 * is ever seen here, and no fee is ever added.
 *
 * WooCommerce has no way over its REST API to take a key away, so on disconnect the inbox removes its
 * webhooks and asks the owner to remove the key.
 */

const KEY_GUIDE = "https://woocommerce.com/document/woocommerce-rest-api/";

/** How long the owner is reminded to remove the key a new one replaced. */
const EARLIER_KEY_MS = 14 * 86_400_000;

/** Accepted as a shop's address: what `normalizeStore` takes. */
function isStoreAddress(value: string): boolean {
  try {
    normalizeStore(value);
    return true;
  } catch {
    return false;
  }
}

const storeUrl = () =>
  field(
    z
      .string()
      .trim()
      .min(4)
      .max(2048)
      .refine(isStoreAddress, "your shop's own https address, like https://shop.example.com"),
    {
      label: "Your shop's address",
      input: "url",
      prefill: "website",
      placeholder: "https://…",
      help: "Where your WordPress shop is.",
    },
  );

/** What the store's Approve page needs first: its address, filled in from your website. */
export const woocommerceBefore = z.object({ store_url: storeUrl() });

/** The key pair made by hand, for a store whose Approve page cannot work. */
export const woocommerceForm = z.object({
  store_url: storeUrl(),
  consumer_key: secretField(
    z
      .string()
      .trim()
      .regex(/^ck_[A-Za-z0-9]{20,64}$/, "a WooCommerce consumer key starts with ck_"),
    {
      label: "Consumer key",
      placeholder: "ck_…",
      steps: [
        "In WordPress: WooCommerce → Settings → Advanced → REST API → Add key.",
        "Description: Agent inbox. Permissions: Read/Write. Then Generate API key.",
        "Copy the consumer key and the consumer secret here.",
      ],
      link: { href: KEY_GUIDE, text: "WooCommerce's guide" },
    },
  ),
  consumer_secret: secretField(
    z
      .string()
      .trim()
      .regex(/^cs_[A-Za-z0-9]{20,64}$/, "a WooCommerce consumer secret starts with cs_"),
    { label: "Consumer secret", placeholder: "cs_…" },
  ),
});

/** A failure while connecting, on the field the owner fixes. */
function onField(error: unknown, keysWay: boolean): unknown {
  if (!(error instanceof ConnectorError) || error.field) return error;
  if (error.code === "auth" && keysWay) return new ConnectorError("auth", error.message, { field: "consumer_key" });
  if (error.code === "config") return new ConnectorError("config", error.message, { field: "store_url" });
  return error;
}

/**
 * The key a connection replaces, for the owner to remove: the one before, when connecting again in
 * place made a new one (the store makes one on each approval; a key pasted by hand replaces one made
 * on the Approve page). Two keys pasted by hand are the owner's own to sort out.
 */
function earlierKey(before: WooExtra | null, via: WooExtra["via"], now: number): WooExtra["earlier_key"] | undefined {
  if (!before || (before.via === "keys" && via === "keys")) return undefined;
  return { id: before.via === "authorize" ? (before.key_id ?? null) : null, at: now };
}

function connectedOf(
  store: Store,
  settings: StoreSettings,
  keys: Keys,
  name: string | null,
  via: WooExtra["via"],
  previous: ConnectContext["previous"],
  opts: {
    readonly now: number;
    readonly keyId?: number | undefined;
    readonly checkedAt?: number | undefined;
    readonly pricesIncludeTax?: boolean | null | undefined;
  },
): Connected {
  const before = previous?.extra ? extraOf({ extra: previous.extra }) : null;
  const earlier = earlierKey(before, via, opts.now);
  const extra: WooExtra = {
    store: store.base,
    api: store.api,
    auth: store.auth,
    currency: settings.currency,
    taxes: settings.taxes,
    ...(opts.pricesIncludeTax !== undefined ? { prices_include_tax: opts.pricesIncludeTax } : {}),
    ...(opts.checkedAt !== undefined ? { checked_at: opts.checkedAt } : {}),
    via,
    ...(opts.keyId !== undefined ? { key_id: opts.keyId } : {}),
    ...(earlier ? { earlier_key: earlier } : {}),
    // Made on the first sync once the inbox can be reached: a store pings each webhook it is given
    // at once, and a sign-in is answered before this connection exists to answer it.
    webhook: "pending",
    // Connected again in place: the webhooks made before are kept, and signed again with the new secret.
    hooks: before?.hooks ?? {},
    hook_url: null,
  };
  const id = storeId(store.base);
  return {
    account: name ?? id,
    externalId: id,
    secret: { consumer_key: keys.key, consumer_secret: keys.secret },
    extra: extra as unknown as Record<string, unknown>,
    calendars: [],
    destinations: [],
    defaults: { busy: [], destination: null },
  };
}

/** The keys pasted by hand: checked against the store, and its name read for the connection's line. */
async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const keys = { key: String(input.consumer_key ?? "").trim(), secret: String(input.consumer_secret ?? "").trim() };
  try {
    const found = await discover(ctx.http, String(input.store_url ?? ""), keys);
    const refusal = currencyRefusal(found.settings.currency);
    if (refusal) throw new ConnectorError("config", refusal, { field: "store_url" });
    const including = found.settings.taxes ? await pricesIncludeTax(ctx.http, found.store, keys) : null;
    return connectedOf(found.store, found.settings, keys, await siteName(ctx.http, found.store), "keys", ctx.previous, {
      now: ctx.now,
      checkedAt: ctx.now,
      pricesIncludeTax: including,
    });
  } catch (error) {
    throw onField(error, true);
  }
}

/** What WooCommerce's authorize endpoint POSTs: the key pair it made, and the state the inbox gave it. */
interface Posted {
  readonly key_id?: unknown;
  readonly user_id?: unknown;
  readonly consumer_key?: unknown;
  readonly consumer_secret?: unknown;
  readonly key_permissions?: unknown;
}

function postedOf(request: InboundRequest): Posted | null {
  try {
    const parsed = JSON.parse(request.body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Posted) : null;
  } catch {
    return null;
  }
}

/**
 * The key pair the store POSTed after the owner approved: read and write, shaped as WooCommerce makes
 * them, for the store at the address the owner gave (never one the POST names). Nothing is asked of
 * the store while it waits for this answer (it deletes the key unless it hears 200 in time, and a small
 * host may have no PHP worker free to answer meanwhile): the key is checked on the first sync, and the
 * store found where it answers then. The same store approved again keeps what was found of it before.
 */
async function receivePosted(
  ctx: ConnectContext,
  request: InboundRequest,
  input: Readonly<Record<string, string>>,
): Promise<Connected> {
  const posted = postedOf(request);
  const key = typeof posted?.consumer_key === "string" ? posted.consumer_key.trim() : "";
  const secret = typeof posted?.consumer_secret === "string" ? posted.consumer_secret.trim() : "";
  if (!/^ck_[A-Za-z0-9]{20,64}$/.test(key) || !/^cs_[A-Za-z0-9]{20,64}$/.test(secret)) {
    throw new ConnectorError("bad_response", "Your shop did not send a key this inbox can use. Try again.");
  }
  if (posted?.key_permissions !== "read_write") {
    throw new ConnectorError(
      "config",
      "Your shop gave this inbox less than read and write access, which it needs to write the orders you accept. Try again.",
    );
  }
  const keys = { key, secret };
  const typed = normalizeStore(String(input.store_url ?? ""));
  const before = ctx.previous?.extra ? extraOf({ extra: ctx.previous.extra }) : null;
  const same = before?.store ? storeId(before.store) === storeId(typed) : false;
  const store: Store =
    same && before
      ? { base: before.store, api: before.api, auth: before.auth }
      : {
          base: typed,
          api: "path",
          auth: "header",
        };
  const settings: StoreSettings =
    same && before
      ? { currency: before.currency, taxes: before.taxes }
      : {
          currency: null,
          taxes: false,
        };
  const keyId = Number(posted?.key_id);
  return connectedOf(store, settings, keys, null, "authorize", ctx.previous, {
    now: ctx.now,
    keyId: Number.isInteger(keyId) ? keyId : undefined,
    ...(same && before?.prices_include_tax !== undefined ? { pricesIncludeTax: before.prices_include_tax } : {}),
  });
}

/** The store an address names, as the inbox knows it once per inbox: what connecting it again finds. */
function accountOf(input: Readonly<Record<string, string>>): string | null {
  try {
    return storeId(normalizeStore(String(input.store_url ?? "")));
  } catch {
    return null;
  }
}

/**
 * Every few hours, and on the first sync of a key the store POSTed: the key works (checked, and the
 * store found where it answers, the first time), the store's currency and name and whether its prices
 * include tax as they are now, and this inbox's webhooks as they should be (made once the inbox can be
 * reached, moved when it moves, switched on again when the store switched them off). A store that will
 * not take the webhooks just now is asked again later: every order is read back on each sync anyway.
 */
async function refresh(ctx: RunContext) {
  const now = extraOf(ctx);
  const keys = keysOf(ctx);
  let store: Store;
  let settings: StoreSettings;
  if (now.checked_at === undefined) {
    const found = await discover(ctx.http, now.store || storeOf(ctx).base, keys);
    store = found.store;
    settings = found.settings;
  } else {
    store = storeOf(ctx);
    settings = settingsOf(
      (await call(ctx.http, store, keys, "GET", SETTINGS_ROUTE, { query: { _fields: "id,value" } })).json,
    );
  }
  const refusal = currencyRefusal(settings.currency);
  if (refusal) throw new ConnectorError("config", refusal);
  const including = settings.taxes ? await pricesIncludeTax(ctx.http, store, keys) : null;
  let extra: WooExtra = {
    ...now,
    store: store.base,
    api: store.api,
    auth: store.auth,
    currency: settings.currency ?? now.currency,
    taxes: settings.taxes,
    prices_include_tax: including,
    checked_at: ctx.now,
  };
  if (extra.earlier_key && ctx.now - extra.earlier_key.at >= EARLIER_KEY_MS) {
    const { earlier_key: _done, ...rest } = extra;
    extra = rest;
  }
  try {
    const kept = await keepWebhooks({ ...ctx, extra: extra as unknown as Record<string, unknown> });
    if (kept) {
      const { hook_failed_at: _done, ...rest } = extra;
      extra = { ...rest, ...kept };
    }
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
    extra = { ...extra, hook_failed_at: ctx.now };
  }
  const name = await siteName(ctx.http, store);
  return {
    account: name ?? storeId(store.base),
    calendars: [],
    destinations: [],
    extra: extra as unknown as Record<string, unknown>,
  };
}

/** What the owner should know about the connection now, a line each. */
function notes(view: { readonly extra: Readonly<Record<string, unknown>>; readonly now: number }): ConnectionNote[] {
  const e = extraOf(view);
  const out: ConnectionNote[] = [];
  if (e.taxes && e.prices_include_tax === false) {
    out.push({ text: "Your shop adds tax at checkout, so each order's total goes to you first." });
  }
  const earlier = e.earlier_key;
  if (earlier && view.now - earlier.at < EARLIER_KEY_MS && e.store) {
    const keysPage = `${e.store}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys`;
    out.push({
      text:
        earlier.id === null
          ? "Your shop made this inbox a new key. Remove the one made by hand before, in WooCommerce → Settings → Advanced → REST API."
          : "Your shop made this inbox a new key. Remove the earlier Agent inbox key in WooCommerce → Settings → Advanced → REST API.",
      href: earlier.id === null ? keysPage : `${keysPage}&edit-key=${earlier.id}`,
      link: "Remove it",
    });
  }
  return out;
}

async function disconnect(ctx: RunContext): Promise<void> {
  await removeWebhooks(ctx);
}

export function woocommerceConnector(): ConnectorDefinition {
  return {
    kind: "woocommerce",
    title: "WooCommerce",
    group: "shops",
    capabilities: ["catalogue", "shop_orders", "pay_links"],
    auth: "oauth",
    action: "Connect your shop",
    again: "Approve again",
    consent:
      "WooCommerce will ask you to approve this inbox. It reads your products and stock, and only writes the orders you accept.",
    note: "Orders you accept go into your shop and are paid at its own checkout.",
    form: woocommerceForm,
    presets: [
      {
        // The way for a store whose Approve page cannot work: the keys made by hand. Named after the
        // platform, since the owner's notices name a connection by its way.
        id: "keys",
        label: "WooCommerce",
        values: {},
        auth: "form",
        action: "Connect",
        note: "Orders you accept go into your shop and are paid at its own checkout.",
      },
    ],
    disconnectNote: "Then remove the key named Agent inbox in WooCommerce → Settings → Advanced → REST API.",
    notes,
    connect,
    oauth: {
      before: woocommerceBefore,
      delivery: "post",
      authorizeUrl({ redirectUri, state, input, postUrl }) {
        const store = normalizeStore(String(input?.store_url ?? ""));
        const host = new URL(redirectUri).host;
        const q = new URLSearchParams({
          app_name: `Agent inbox (${host})`,
          scope: "read_write",
          user_id: state,
          // WooCommerce sends the owner back here with success and user_id added; the state is this inbox's.
          return_url: `${redirectUri}?state=${encodeURIComponent(state)}`,
          callback_url: postUrl ?? "",
        });
        return `${store}/wc-auth/v1/authorize?${q}`;
      },
      async exchange() {
        throw new ConnectorError("config", "WooCommerce sends this inbox its key itself. Connect your shop again.");
      },
      postedState(request) {
        const id = postedOf(request)?.user_id;
        return typeof id === "string" && id.length > 0 && id.length <= 600 ? id : null;
      },
      receivePosted,
      accountOf,
    },
    refresh,
    // A key the store POSTed is checked on the first sync; the webhooks, whenever they want looking at.
    stale: (ctx) => extraOf(ctx).checked_at === undefined || hooksStale(ctx),
    disconnect,
    catalogue,
    hooks,
    payments,
  };
}
