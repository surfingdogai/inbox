import vocabulary from "../vocab/door-platforms.json" with { type: "json" };

/**
 * The platforms a business takes bookings or orders at instead of its inbox (`vocab/door-platforms.json`, spec 0.9.0,
 * ADR-031): the `platform` a manifest's `doors_elsewhere` entry may name, so an agent and a person read "Book at
 * Fresha" rather than a host name. Nothing here signs in anywhere or calls a platform: it only tells, from a URL alone,
 * whether that URL is a business's own page on a platform.
 *
 * Free of any dependency (the owner app imports it as it is), so the rules are written once.
 */

/** The kinds of request a business can take somewhere else: messages and requests for a price always stay at its inbox. */
export type DoorElsewhereKind = "booking" | "order";

/**
 * How a business's own page on a platform is told apart from the platform's own pages, for a platform with no `pages`:
 * `path`, a path other than `/` whose first segment is not one of the vocabulary's `reserved_paths`
 * (`https://calendly.com/…`); `subdomain`, a name under the platform's host other than `www` and the
 * `reserved_subdomains` (`https://studio.simplybook.me/`); `any`, either.
 */
export type DoorPlatformPage = "path" | "subdomain" | "any";

export interface DoorPlatform {
  /** The token a `doors_elsewhere` entry names, and a network's door type `platform:<id>`. */
  readonly id: string;
  readonly name: string;
  /** One of `groups`: how the owner's chooser heads it. */
  readonly group: string;
  readonly item_types: readonly DoorElsewhereKind[];
  /** Registrable names: a host is on the platform when it is one of these or a name under one. */
  readonly hosts: readonly string[];
  readonly page: DoorPlatformPage;
  /**
   * Where the platform's pages for a business are known to sit: patterns, matched without regard to case against the
   * host without `www.` followed by the path (`fresha.com/a/studio-x`). With them, a page on the platform is the
   * business's own only when one matches; without them, `page` and the reserved names decide.
   */
  readonly pages?: readonly string[];
  /**
   * The platform also serves the business's pages on the business's own domain (a shop's own checkout, a booking
   * site on the business's own name). A page there is named by its host, never by the platform.
   */
  readonly own_site?: boolean;
  /** The platform's own public page or help the hosts were read from. */
  readonly source: string;
}

export interface DoorPlatformGroup {
  readonly id: string;
  readonly label: string;
}

export interface DoorPlatformsVocabulary {
  readonly version: number;
  readonly description: string;
  readonly groups: readonly DoorPlatformGroup[];
  /** Query parameters a door may not carry (tracking and affiliate tags); a name ending in `*` is a prefix. */
  readonly tracking_params: readonly string[];
  /** Names under a platform's host that are the platform's own (help, app, admin…), never a business's. */
  readonly reserved_subdomains: readonly string[];
  /** First path segments that are the platform's own pages (login, pricing, blog…), never a business's. */
  readonly reserved_paths: readonly string[];
  readonly platforms: readonly DoorPlatform[];
}

export const DOOR_PLATFORMS_VOCABULARY = vocabulary as unknown as DoorPlatformsVocabulary;
export const DOOR_PLATFORMS: readonly DoorPlatform[] = DOOR_PLATFORMS_VOCABULARY.platforms;
export const DOOR_PLATFORM_GROUPS: readonly DoorPlatformGroup[] = DOOR_PLATFORMS_VOCABULARY.groups;

/** A platform token: lower-case letters, digits and hyphens, at most 40, as a network's `platform:<id>` door type. */
export const DOOR_PLATFORM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const BY_ID = new Map(DOOR_PLATFORMS.map((p) => [p.id, p]));
const RESERVED_SUBDOMAINS = new Set(DOOR_PLATFORMS_VOCABULARY.reserved_subdomains);
const RESERVED_PATHS = new Set(DOOR_PLATFORMS_VOCABULARY.reserved_paths);
const PAGES = new Map(DOOR_PLATFORMS.map((p) => [p.id, (p.pages ?? []).map((re) => new RegExp(re, "i"))]));

/** The platform a token names, or undefined for one this vocabulary does not know. */
export function doorPlatform(id: unknown): DoorPlatform | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** Whether `host` is `name` or a name under it: `www.fresha.com` is on `fresha.com`, `notfresha.com` is not. */
export function hostIsOn(host: string, name: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === name || h.endsWith(`.${name}`);
}

/**
 * A business's own domain as every check compares it: lower case, without a scheme, a path, a port, a leading `www.`
 * or a trailing dot. It takes a domain as an owner types it (`Kissahoshi.JP.`) or a website's address
 * (`https://www.kissahoshi.jp/menu`); empty for nothing usable. The owner app and the server both use this one.
 */
export function ownSiteDomain(value: string | null | undefined): string {
  let v = (value ?? "").trim().toLowerCase();
  if (!v) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    const u = parse(v);
    if (!u) return "";
    v = u.hostname;
  } else v = (v.split(/[/?#]/)[0] ?? "").replace(/:\d+$/, "");
  return v.replace(/\.$/, "").replace(/^www\./, "");
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Where a URL stands against a platform, for a kind of request:
 *
 * - `on_platform`: the business's own page on the platform: one of its `pages` when it has them, and otherwise past
 *   its home, its reserved names (`help.…`, `/login`, `/pricing`…) and the `page` rule;
 * - `own_site`: not on the platform's hosts, and the platform serves pages on the business's own domain, so it may be
 *   there (whoever knows that domain checks it: `doorPlatformHolds`);
 * - `platform_page`: on the platform, but one of the platform's own pages (its home, its help, its sign-in, its prices:
 *   a page with no business in it);
 * - `not_on_platform`: somewhere else altogether;
 * - `kind`: the platform takes no such request (a booking at an ordering platform);
 * - `invalid`: not a URL.
 */
export type DoorPlatformFit = "on_platform" | "own_site" | "platform_page" | "not_on_platform" | "kind" | "invalid";

export function doorPlatformFit(url: string, platform: DoorPlatform, kind?: string): DoorPlatformFit {
  const u = parse(url);
  if (!u) return "invalid";
  if (kind !== undefined && !platform.item_types.includes(kind as DoorElsewhereKind)) return "kind";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const on = platform.hosts.find((h) => hostIsOn(host, h));
  if (!on) return platform.own_site ? "own_site" : "not_on_platform";
  // The names under the platform's host, `www.` aside: "" for www.fresha.com, "studio" for studio.simplybook.me.
  const under = (host === on ? "" : host.slice(0, -(on.length + 1))).replace(/^www$|^www\./, "");
  // help.simplybook.me, app.setmore.com, admin.myshopify.com: the platform's own, and all under them.
  if (under !== "" && RESERVED_SUBDOMAINS.has(under.split(".").at(-1) ?? "")) return "platform_page";
  const pages = PAGES.get(platform.id) ?? [];
  if (pages.length) {
    const at = `${host.replace(/^www\./, "")}${u.pathname}`;
    return pages.some((re) => re.test(at)) ? "on_platform" : "platform_page";
  }
  const sub = under !== "";
  const first = (u.pathname.split("/")[1] ?? "").toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const path = first !== "" && !RESERVED_PATHS.has(first);
  const fits = platform.page === "path" ? path : platform.page === "subdomain" ? sub : sub || path;
  return fits ? "on_platform" : "platform_page";
}

/**
 * Whether a door may carry `platform`'s name: its page is the business's own page on the platform, or, for a platform
 * that also serves the business's own domain, the page is on one of `ownDomains` (each as `ownSiteDomain` gives it).
 * With no domain of the business's own known, a page off the platform's hosts never carries the name: anyone can
 * say a stranger's shop is theirs. The manifest's writer and reader, the profile and the settings all hold to it.
 */
export function doorPlatformHolds(
  url: string,
  platform: DoorPlatform,
  kind: string,
  ownDomains: readonly string[] = [],
): boolean {
  const fit = doorPlatformFit(url, platform, kind);
  if (fit === "on_platform") return true;
  if (fit !== "own_site") return false;
  const host = parse(url)?.hostname ?? "";
  return ownDomains.some((d) => d !== "" && hostIsOn(host, d));
}

/**
 * The platform a URL is the business's own page on, for a kind of request when one is given: the first in the
 * vocabulary's order whose hosts it is on. Undefined for a page anywhere else, the business's own website included.
 */
export function doorPlatformOf(url: string, kind?: string): DoorPlatform | undefined {
  return DOOR_PLATFORMS.find((p) => p.hosts.length > 0 && doorPlatformFit(url, p, kind) === "on_platform");
}

const TRACKING = DOOR_PLATFORMS_VOCABULARY.tracking_params;

function isTracking(param: string): boolean {
  const k = param.toLowerCase();
  return TRACKING.some((t) => (t.endsWith("*") ? k.startsWith(t.slice(0, -1)) : k === t));
}

/** The tracking or affiliate parameters a URL's query carries (`tracking_params`), as written; none for a bad URL. */
export function doorTrackingParams(url: string): string[] {
  const u = parse(url);
  if (!u) return [];
  return [...new Set([...u.searchParams.keys()].filter(isTracking))];
}

/**
 * The URL without its tracking and affiliate parameters, everything else kept exactly as written (`?tz=America/Toronto`
 * stays as it is, never re-encoded); exactly as written when it carries none, so a clean link is never rewritten.
 */
export function cleanDoorUrl(url: string): string {
  if (!parse(url) || doorTrackingParams(url).length === 0) return url;
  const hash = url.indexOf("#");
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  const q = beforeHash.indexOf("?");
  if (q === -1) return url;
  const kept = beforeHash
    .slice(q + 1)
    .split("&")
    .filter((pair) => {
      if (pair === "") return false;
      const raw = pair.split("=")[0] ?? "";
      let key = raw;
      try {
        key = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        // A key that does not decode is compared as written.
      }
      return !isTracking(key);
    });
  return `${beforeHash.slice(0, q)}${kept.length ? `?${kept.join("&")}` : ""}${fragment}`;
}

/**
 * What a door elsewhere is called, for "Book at …" and "Order at …": the platform's name for a page on it, and the
 * page's host, exactly as the address names it, for any other (the business's own website, a platform this
 * vocabulary does not know).
 */
export function doorPlace(entry: { readonly url: string; readonly platform?: string | undefined }): string {
  const p = doorPlatform(entry.platform);
  if (p && doorPlatformFit(entry.url, p) === "on_platform") return p.name;
  return parse(entry.url)?.host ?? entry.url;
}
