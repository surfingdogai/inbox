import {
  ConnectorError,
  type ConnectorHttp,
  type ConnectorHttpResponse,
  isHundredthsCurrency,
  isWholeUnitCurrency,
} from "@surfingdog/core";
import { basicAuth, retryAfterMs } from "../http";

/**
 * Talking to one WooCommerce store, over its REST API v3 with a key pair the store made for this
 * inbox (https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication-over-https): HTTP
 * Basic with the consumer key and secret, over https only. Where the store's server drops the
 * Authorization header (some hosts do, and WooCommerce documents the fallback), the pair goes in the
 * query instead; such a request never follows a redirect, so the pair never travels to another host.
 *
 * A store answers at `<site>/wp-json/` with pretty permalinks, or at `<site>/?rest_route=/` without
 * (https://developer.wordpress.org/rest-api/extending-the-rest-api/routes-and-endpoints/): which one is
 * found when it is connected, and kept.
 *
 * Every request asks only for the fields the inbox reads (WordPress's `_fields`,
 * https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/#_fields): the store's
 * answers about orders never bring back the customer's address or contact details.
 */

/** Where a store is, and how it is reached: what the connection keeps about itself. */
export interface Store {
  /** The WordPress site, https, without a trailing slash: `https://kibanda.example.com`, `https://example.com/shop`. */
  readonly base: string;
  /** `path`: `<base>/wp-json/<route>`; `query`: `<base>/?rest_route=/<route>` (plain permalinks). */
  readonly api: "path" | "query";
  /** `header`: HTTP Basic; `query`: the pair in the query, for a server that drops the header. */
  readonly auth: "header" | "query";
}

/** The key pair a store made for this inbox. Sealed by the secret box; never in an answer or a log. */
export interface Keys {
  readonly key: string;
  readonly secret: string;
}

export interface WooAnswer {
  readonly status: number;
  readonly json: unknown;
  readonly headers: Headers;
  /** Whether the answer was JSON at all (a firewall's page, a theme's 404, are not). */
  readonly isJson: boolean;
}

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * A typed shop address as the inbox keeps it: https (a bare host gets it), no credentials, a public
 * host, no query; WordPress's own paths (`/wp-admin`, `/wp-json`, `/wp-login.php`) taken off. Throws
 * `ConnectorError("config")` on the `store_url` field otherwise.
 */
export function normalizeStore(raw: string): string {
  const typed = String(raw ?? "").trim();
  if (!typed) throw new ConnectorError("config", "Your shop's address is needed.", { field: "store_url" });
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new ConnectorError("config", "That is not a web address. Use your shop's, like https://shop.example.com.", {
      field: "store_url",
    });
  }
  if (url.protocol === "http:") {
    throw new ConnectorError(
      "config",
      "Your shop must answer over https: WooCommerce sends keys only to an https address, and this inbox calls nothing else.",
      { field: "store_url" },
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
    throw new ConnectorError("config", "Use your shop's own web address, like https://shop.example.com.", {
      field: "store_url",
    });
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(wp-admin|wp-json|wp-login\.php)(\/.*)?$/i, "");
  return `https://${url.host.toLowerCase()}${path}`;
}

/** What the inbox knows a store by, once per inbox: its host (without `www.`) and path. */
export function storeId(base: string): string {
  const url = new URL(base);
  return `${url.host.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
}

/** The address of one route of a store's REST API, with the pair in the query when the store needs it so. */
export function routeUrl(store: Store, keys: Keys | null, route: string, query: Query = {}): string {
  const q = new URLSearchParams();
  if (store.api === "query") q.set("rest_route", route);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  if (keys && store.auth === "query") {
    q.set("consumer_key", keys.key);
    q.set("consumer_secret", keys.secret);
  }
  const qs = q.toString();
  return store.api === "query" ? `${store.base}/?${qs}` : `${store.base}/wp-json${route}${qs ? `?${qs}` : ""}`;
}

/** One request, answered as it came: nothing mapped to an error yet (what `discover` reads to find its way). */
export async function send(
  http: ConnectorHttp,
  store: Store,
  keys: Keys | null,
  method: string,
  route: string,
  opts: { readonly query?: Query; readonly body?: unknown; readonly maxBytes?: number } = {},
): Promise<WooAnswer> {
  const res: ConnectorHttpResponse = await http.request({
    method,
    url: routeUrl(store, keys, route, opts.query),
    headers: {
      accept: "application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(keys && store.auth === "header" ? { authorization: basicAuth(keys.key, keys.secret) } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    // Never followed: a key in the query would go with it, and a store that moved is said so.
    followRedirects: false,
    timeoutMs: 20_000,
  });
  let json: unknown = null;
  let isJson = false;
  try {
    // WordPress sends JSON; a plugin may print a BOM or a notice before it, which is cut.
    const text = res.text.replace(/^﻿/, "");
    const start = text.search(/[[{]/);
    if (start >= 0 && start < 512) {
      json = JSON.parse(text.slice(start));
      isJson = true;
    }
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, isJson };
}

/** WooCommerce's error code and message, as plain words. */
export function errorOf(answer: WooAnswer): { readonly code: string; readonly message: string } {
  const j = (answer.json ?? {}) as { code?: unknown; message?: unknown };
  return {
    code: typeof j.code === "string" ? j.code : "",
    message: typeof j.message === "string" ? plain(j.message).slice(0, 240) : "",
  };
}

/**
 * One request whose failures are said in the owner's words: a key the store does not take (`auth`),
 * a store that is not WooCommerce or moved (`config`), a thing it does not have (`not_found`), a
 * store asking to wait (`rate_limited`) or not answering properly (`unreachable`), a refusal in
 * WooCommerce's own words (`refused`), and a page where JSON was expected (`bad_response`).
 */
export async function call(
  http: ConnectorHttp,
  store: Store,
  keys: Keys,
  method: string,
  route: string,
  opts: { readonly query?: Query; readonly body?: unknown; readonly maxBytes?: number } = {},
): Promise<WooAnswer> {
  return raise(await send(http, store, keys, method, route, opts), store, method);
}

/** An answer as it came, or the error it is in the owner's words (`call`). */
export function raise(answer: WooAnswer, store: Store, method: string): WooAnswer {
  const host = new URL(store.base).host;
  const { code, message } = errorOf(answer);
  if (answer.status >= 200 && answer.status < 300) {
    if (!answer.isJson && method !== "DELETE") {
      throw new ConnectorError(
        "bad_response",
        `${host} answered with a web page instead of WooCommerce: a security plugin or firewall may be in the way of its REST API.`,
      );
    }
    return answer;
  }
  if (answer.status === 401 || answer.status === 403) {
    if (
      code === "woocommerce_rest_cannot_create" ||
      code === "woocommerce_rest_cannot_edit" ||
      /write/i.test(message)
    ) {
      throw new ConnectorError(
        "auth",
        "The shop's key can only read. Make one with Read/Write permissions in WooCommerce → Settings → Advanced → REST API, and connect again.",
      );
    }
    throw new ConnectorError(
      "auth",
      "Your shop did not take this inbox's key. It may have been removed: connect your shop again.",
    );
  }
  if (answer.status === 404) {
    if (code === "rest_no_route") {
      throw new ConnectorError("config", `WooCommerce is not active at ${host}, or its REST API is switched off.`);
    }
    if (!answer.isJson) {
      throw new ConnectorError("config", `${host} has no WordPress REST API at this address.`);
    }
    throw new ConnectorError("not_found", message || "Your shop has no such thing.");
  }
  if (answer.status === 429) {
    throw new ConnectorError("rate_limited", "Your shop asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(answer.headers),
    });
  }
  if (answer.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      `${host} is not answering properly; this inbox tries again in a few minutes.`,
    );
  }
  if (answer.status >= 300 && answer.status < 400) {
    const to = answer.headers.get("location") ?? "";
    let where = "";
    try {
      where = to ? new URL(to, store.base).host : "";
    } catch {
      where = "";
    }
    throw new ConnectorError(
      "config",
      where && where !== host
        ? `${host} now sends this inbox to ${where}. Connect your shop again with that address.`
        : `${host} redirected this inbox. Connect your shop again with its address as it is now.`,
    );
  }
  throw new ConnectorError("refused", `WooCommerce said: ${message || `HTTP ${answer.status}`}`);
}

/** The store's own settings this inbox reads: its currency, and whether it counts tax. */
export interface StoreSettings {
  readonly currency: string | null;
  readonly taxes: boolean;
}

export const SETTINGS_ROUTE = "/wc/v3/settings/general";

/**
 * Why a store's currency cannot be taken here, in the owner's words; null when it can. Every amount
 * here is in hundredths: a currency with no minor unit (yen, won, dong) is exact in them, and a shop
 * takes it back as a decimal in its own currency; one counted in thousandths (Kuwaiti or Bahraini
 * dinars) is not, and is refused before a price of the shop's is read wrong.
 */
export function currencyRefusal(currency: string | null): string | null {
  if (currency === null || isHundredthsCurrency(currency) || isWholeUnitCurrency(currency)) return null;
  return `Your shop sells in ${currency}, which this inbox cannot take orders in yet: its amounts are counted in hundredths.`;
}

/**
 * Whether the store's prices include tax (`woocommerce_prices_include_tax`, in the tax group WooCommerce
 * lists only when it counts tax): false for a store that adds tax at checkout. Null when it does not say.
 */
export async function pricesIncludeTax(http: ConnectorHttp, store: Store, keys: Keys): Promise<boolean | null> {
  try {
    const answer = await send(http, store, keys, "GET", "/wc/v3/settings/tax/woocommerce_prices_include_tax", {
      query: { _fields: "id,value" },
      maxBytes: 64 * 1024,
    });
    const value = (answer.json as { value?: unknown } | null)?.value;
    if (answer.status !== 200 || !answer.isJson) return null;
    return value === "yes" ? true : value === "no" ? false : null;
  } catch {
    return null;
  }
}

export function settingsOf(json: unknown): StoreSettings {
  const list = Array.isArray(json) ? (json as { id?: unknown; value?: unknown }[]) : [];
  const value = (id: string) => list.find((s) => s && s.id === id)?.value;
  const currency = String(value("woocommerce_currency") ?? "")
    .trim()
    .toUpperCase();
  return {
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    taxes: value("woocommerce_calc_taxes") === "yes",
  };
}

/**
 * Finds the store's REST API at the typed address with the key pair, and checks the pair: the
 * address WordPress moved to when it is the same site with or without `www.` (a store that sends
 * this inbox anywhere else is said so); `?rest_route=` when the store has no pretty permalinks; the
 * pair in the query when the server drops the Authorization header (WooCommerce's
 * `woocommerce_rest_cannot_view`: the request came with no key at all). Answers where it is, and its
 * settings.
 */
export async function discover(
  http: ConnectorHttp,
  typed: string,
  keys: Keys,
): Promise<{ readonly store: Store; readonly settings: StoreSettings }> {
  let store: Store = { base: normalizeStore(typed), api: "path", auth: "header" };
  const query = { _fields: "id,value" };
  let moved = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const answer = await send(http, store, keys, "GET", SETTINGS_ROUTE, { query });
    if (answer.status === 200 && answer.isJson) return { store, settings: settingsOf(answer.json) };
    const { code } = errorOf(answer);
    if (answer.status >= 300 && answer.status < 400 && !moved && store.auth === "header") {
      const next = movedTo(store, answer.headers.get("location"));
      if (next) {
        store = { ...store, base: next };
        moved = true;
        continue;
      }
    }
    if (answer.status === 401 && code === "woocommerce_rest_cannot_view" && store.auth === "header") {
      store = { ...store, auth: "query" };
      continue;
    }
    // A page where the REST API should be: no pretty permalinks (WordPress's 404), or not WordPress.
    if (!answer.isJson && store.api === "path" && (answer.status === 404 || answer.status === 200)) {
      store = { ...store, api: "query" };
      continue;
    }
    if (!answer.isJson && store.api === "query" && answer.status < 400) {
      throw new ConnectorError(
        "config",
        `No WooCommerce answers at ${new URL(store.base).host}: check your shop's address, or whether a security plugin or firewall keeps its REST API closed.`,
        { field: "store_url" },
      );
    }
    // Anything else is said as any call would say it.
    raise(answer, store, "GET");
    break;
  }
  throw new ConnectorError("config", "This inbox could not find WooCommerce at that address.", { field: "store_url" });
}

/**
 * Where a redirect sends the store, when it is the same site: the same host with or without `www.`,
 * or another path on the same host. Null for anywhere else.
 */
function movedTo(store: Store, location: string | null): string | null {
  if (!location) return null;
  let to: URL;
  try {
    to = new URL(location, `${store.base}/`);
  } catch {
    return null;
  }
  const from = new URL(store.base);
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  if (to.protocol !== "https:" || bare(to.host) !== bare(from.host)) return null;
  // The new base is the redirect's path with the route taken off: `/shop/wp-json/wc/v3/…` → `/shop`.
  const at = to.pathname.indexOf("/wp-json/");
  const path = at >= 0 ? to.pathname.slice(0, at) : from.pathname.replace(/\/+$/, "");
  try {
    return normalizeStore(`https://${to.host}${path}`);
  } catch {
    return null;
  }
}

/** The site's own name, as WordPress gives it to anyone (`/wp-json/?_fields=name`); null when it does not. */
export async function siteName(http: ConnectorHttp, store: Store): Promise<string | null> {
  try {
    const answer = await send(http, { ...store, auth: "header" }, null, "GET", "/", {
      query: { _fields: "name" },
      maxBytes: 64 * 1024,
    });
    const name = (answer.json as { name?: unknown } | null)?.name;
    const text = typeof name === "string" ? plain(name).trim() : "";
    return answer.status === 200 && text ? text.slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** The named entities WordPress and WooCommerce write (its state names: `S&atilde;o Paulo`): signs, then letters. */
const SIGNS: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  pound: "£",
  yen: "¥",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
};
const LETTERS: Readonly<Record<string, string>> = {
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  uacute: "ú",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
  szlig: "ß",
};

/** A named entity as text (`&Atilde;` is Ã: a capital first letter is the capital); undefined when it is not one of these. */
function named(name: string): string | undefined {
  const sign = SIGNS[name.toLowerCase()];
  if (sign !== undefined) return sign;
  const letter = LETTERS[name];
  if (letter !== undefined) return letter;
  const lower = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  const capital = lower !== name && lower !== "szlig" ? LETTERS[lower] : undefined;
  return capital?.toUpperCase();
}

/**
 * Text a store sends, as plain words: tags taken off, the entities WordPress writes turned back in one
 * pass, so `&amp;lt;` is the text `&lt;` and never a `<`.
 */
export function plain(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:#(\d{2,7})|#x([0-9a-f]{2,6})|([a-z]{2,8}));/gi,
      (whole, dec?: string, hex?: string, name?: string) => {
        if (name !== undefined) return named(name) ?? whole;
        const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
        return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A decimal amount as a store writes it ("12.50", "1200", "4.5833") in hundredths, rounded half up
 * at the third decimal: WooCommerce keeps more decimals than it shows. Null when it is not a number.
 */
export function hundredths(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const m = /^(-?)(\d{1,13})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = `${m[3] ?? ""}000`;
  let value = Number(m[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) value += 1;
  return m[1] === "-" ? -value : value;
}

/** Hundredths written as WooCommerce takes an amount: 4500 → "45.00". */
export function decimal(value: number): string {
  const s = String(Math.abs(Math.trunc(value))).padStart(3, "0");
  return `${value < 0 ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** The meta value a store answer holds under `key`, as a string; null when it has none. */
export function metaOf(entity: unknown, key: string): string | null {
  const list = (entity as { meta_data?: unknown } | null)?.meta_data;
  if (!Array.isArray(list)) return null;
  for (const m of list as { key?: unknown; value?: unknown }[]) {
    if (m && m.key === key) return typeof m.value === "string" || typeof m.value === "number" ? String(m.value) : null;
  }
  return null;
}
