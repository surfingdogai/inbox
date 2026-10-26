import {
  cleanDoorUrl,
  DOOR_PLATFORM_GROUPS,
  DOOR_PLATFORMS,
  type DoorElsewhereKind,
  type DoorPlatform,
  type DoorPlatformGroup,
  doorPlace,
  doorPlatform,
  doorPlatformFit,
  doorPlatformOf,
  hostIsOn,
  ownSiteDomain,
} from "../../../../../packages/spec/src/door-platforms";
import type { NetworkView, Settings } from "./types";

/**
 * What agents can do here, door by door, as the owner's switches show it (`settings.doors`): where
 * each switch stands, whether the door is really open (what `GET /v1/business` lists), and what it
 * still needs when it is switched on and not open yet.
 */
export type DoorKey = "booking" | "quoteRequest" | "message";

export interface DoorView {
  readonly key: DoorKey;
  /** The one line the switch says. */
  readonly label: string;
  /** Where the switch stands. */
  readonly on: boolean;
  /** Whether agents are told of it now. */
  readonly open: boolean;
  /** What it waits for, switched on and not open: a service, opening hours, or both. */
  readonly needs: "service" | "hours" | "service_and_hours" | null;
  /** Bookings taken at another site instead, named as agents read it ("Fresha", or its host); only for booking. */
  readonly elsewhere: string | null;
}

export interface DoorFacts {
  readonly doors: Settings["doors"];
  readonly itemTypes: readonly string[];
  /** An active service. */
  readonly hasService: boolean;
  /** Opening hours with a window, the business's or a service's own. */
  readonly hasHours: boolean;
  readonly doorsElsewhere: Settings["doorsElsewhere"];
}

export function doorViews(f: DoorFacts): readonly DoorView[] {
  const away = f.doorsElsewhere.find((d) => d.itemType === "booking");
  const bookingOn = f.doors.booking !== false;
  const bookingOpen = f.itemTypes.includes("booking");
  return [
    {
      key: "booking",
      label: "Agents can book time",
      on: bookingOn && !away,
      open: bookingOpen,
      needs:
        bookingOn && !away && !bookingOpen
          ? !f.hasService && !f.hasHours
            ? "service_and_hours"
            : !f.hasService
              ? "service"
              : "hours"
          : null,
      elsewhere: away ? placeOf(away) : null,
    },
    {
      key: "quoteRequest",
      label: "Agents can ask for a price",
      // Left to follow the catalogue, it stands where the door is: on once something is listed.
      on: f.doors.quoteRequest ?? f.itemTypes.includes("quote_request"),
      open: f.itemTypes.includes("quote_request"),
      needs: null,
      elsewhere: null,
    },
    {
      key: "message",
      label: "Agents can send a message",
      on: f.doors.message !== false,
      open: f.itemTypes.includes("message"),
      needs: null,
      elsewhere: null,
    },
  ];
}

/** The settings write a switch makes: on is true (a price can be asked before anything is listed), off is false. */
export function doorSwitchDoc(key: DoorKey, on: boolean): { doors: Partial<Record<DoorKey, boolean>> } {
  return { doors: { [key]: on } };
}

/** What a switched-on door still needs, in words. */
export function needsWords(needs: DoorView["needs"]): string {
  if (needs === "service_and_hours") return "Needs a service and opening hours.";
  if (needs === "service") return "Needs a service.";
  if (needs === "hours") return "Needs opening hours.";
  return "";
}

/** What a switched-on door is waiting for, after its line: "once you add a service". */
export function waitWords(needs: DoorView["needs"]): string {
  if (needs === "service_and_hours") return "once you add a service and your hours";
  if (needs === "service") return "once you add a service";
  if (needs === "hours") return "once you set your hours";
  return "";
}

// ---- booked or ordered elsewhere (ADR-035) ---------------------------------------------------------

export type ElsewhereEntry = Settings["doorsElsewhere"][number];
export type ElsewhereKind = DoorElsewhereKind;

/** The kinds a door elsewhere can take, in the order the card shows them. */
export const ELSEWHERE_KINDS: readonly ElsewhereKind[] = ["booking", "order"];

/** What a door elsewhere is called, as agents and the business's page say it: "Fresha", or the page's host. */
export function placeOf(d: {
  readonly itemType: string;
  readonly url: string;
  readonly platform?: string | undefined;
}) {
  return doorPlace({ url: d.url, platform: d.platform ?? doorPlatformOf(d.url, d.itemType)?.id });
}

/** The one line a door elsewhere reads as: "Bookings at Fresha". */
export function elsewhereLine(d: ElsewhereEntry): string {
  return `${d.itemType === "booking" ? "Bookings" : "Orders"} at ${placeOf(d)}`;
}

/**
 * The platform the owner picked, for the owner's own line only, when agents name the door by its address instead (a
 * shop on the business's own website: "Orders at kissahoshi.jp · Shopify"); null when the line already says it.
 */
export function pickedPlatformNote(d: ElsewhereEntry): string | null {
  const p = doorPlatform(d.platform);
  return p && placeOf(d) !== p.name ? p.name : null;
}

/**
 * What still comes to the inbox while a kind is sent elsewhere, from the doors open now: both, messages alone, price
 * requests alone, or nothing to say. Never a door that would turn an agent away too.
 */
export function stillHereWords(open: { readonly message: boolean; readonly quoteRequest: boolean }): string {
  if (open.message && open.quoteRequest) return "Messages and price requests still come here.";
  if (open.message) return "Messages still come here.";
  if (open.quoteRequest) return "Price requests still come here.";
  return "";
}

/** The business's own domains, each as every check compares it: its domain, and the website it gave, if any. */
export function ownDomains(...values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map(ownSiteDomain).filter((d) => d !== ""))];
}

function domainsOf(value: string | null | undefined | readonly (string | null | undefined)[]): string[] {
  return typeof value === "string" || value == null ? ownDomains(value) : ownDomains(...value);
}

/** A link as the owner reads it: host and path, no scheme, no trailing slash. */
export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The chooser for a kind: the groups that have a platform taking it, the likeliest groups first (tables and
 * salons for bookings, food ordering and shops for orders), each with its platforms in the vocabulary's order.
 * "Another page" is the chooser's own last option, never a platform.
 */
export function platformChoices(kind: ElsewhereKind): { group: DoorPlatformGroup; platforms: DoorPlatform[] }[] {
  const first = kind === "order" ? ["ordering", "shops"] : [];
  const groups = [...DOOR_PLATFORM_GROUPS].sort(
    (a, b) => (first.includes(a.id) ? first.indexOf(a.id) : 9) - (first.includes(b.id) ? first.indexOf(b.id) : 9),
  );
  return groups
    .map((group) => ({
      group,
      platforms: DOOR_PLATFORMS.filter((p) => p.group === group.id && p.item_types.includes(kind)),
    }))
    .filter((g) => g.platforms.length > 0);
}

/** The doors the owner's networks found for this business (their last answers' `doors`), newest network first. */
export function detectedDoors(networks: readonly NetworkView[] | undefined): { type: string; url: string }[] {
  return (networks ?? []).flatMap((n) => (n.doors?.doors ?? []).map((d) => ({ type: d.type, url: d.url })));
}

/**
 * The link to start from when the owner picks a platform: the one saved for this kind on it, else the page a network
 * already found on it for this business, else the business's own website for a platform that serves it there.
 * Empty when there is nothing to go on: the owner pastes it.
 */
export function prefillFor(
  platformId: string,
  kind: ElsewhereKind,
  opts: {
    readonly current?: ElsewhereEntry | undefined;
    readonly detected?: readonly { readonly type: string; readonly url: string }[];
    readonly domain?: string | null | undefined;
  },
): string {
  return prefillFrom(platformId, kind, opts).url;
}

/**
 * `prefillFor`, with where the link came from: `saved`, `found` (a network found the page; on a marketplace platform
 * the owner is asked for the platform's direct link instead, if it has one), `website`, or `none`.
 */
export function prefillFrom(
  platformId: string,
  kind: ElsewhereKind,
  opts: {
    readonly current?: ElsewhereEntry | undefined;
    readonly detected?: readonly { readonly type: string; readonly url: string }[];
    readonly domain?: string | null | undefined;
  },
): { url: string; from: "saved" | "found" | "website" | "none" } {
  const p = doorPlatform(platformId);
  const cur = opts.current;
  if (cur && cur.itemType === kind && (cur.platform ?? doorPlatformOf(cur.url, kind)?.id ?? "") === platformId)
    return { url: cur.url, from: "saved" };
  if (!p)
    return cur?.itemType === kind && !cur.platform && !doorPlatformOf(cur.url, kind)
      ? { url: cur.url, from: "saved" }
      : { url: "", from: "none" };
  for (const d of opts.detected ?? []) {
    if (!/^https:\/\//.test(d.url)) continue;
    if (d.type === `platform:${p.id}` || doorPlatformFit(d.url, p, kind) === "on_platform")
      return { url: cleanDoorUrl(d.url), from: "found" };
  }
  const own = ownSiteDomain(opts.domain);
  if (p.own_site && own) return { url: `https://${own}/`, from: "website" };
  return { url: "", from: "none" };
}

/**
 * What is wrong with a link for the platform picked (empty: Another page), in the owner's words, before it is saved;
 * null when it can be saved. Tracking is not a problem: it is taken off as the link is pasted (`cleanDoorUrl`).
 * The server says the same (`doorElsewhereSettingSchema`, `doorElsewhereDomainProblems`).
 */
export function linkProblem(
  url: string,
  platformId: string,
  kind: ElsewhereKind,
  domain?: string | null | undefined | readonly (string | null | undefined)[],
): string | null {
  const text = url.trim();
  if (!text) return "Paste the link.";
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return "Paste the whole link, starting with https://";
  }
  if (u.protocol !== "https:") return "The link must start with https://";
  const labels = u.hostname.split(".");
  if (labels.length < 2 || !/^[a-z]/i.test(labels[labels.length - 1] ?? "") || u.username || u.password)
    return "That doesn't look like a web page's link.";
  const p = doorPlatform(platformId);
  if (!p) return null;
  const fit = doorPlatformFit(text, p, kind);
  if (fit === "not_on_platform") return `That link isn't on ${p.name}. If it's yours, choose Another page.`;
  if (fit === "platform_page") return `That's ${p.name}'s own page. Paste the link to yours.`;
  if (fit === "own_site") {
    const own = domainsOf(domain);
    if (own.length === 0) return noWebsiteWords(kind);
    if (!own.some((d) => hostIsOn(u.hostname, d))) {
      return p.hosts.length
        ? `That link isn't on your website (${own[0]}) or on ${p.name}.`
        : `That link isn't on your website (${own[0]}).`;
    }
  }
  return null;
}

/** What a page on the business's own website waits for while the business has none set. */
export function noWebsiteWords(kind: ElsewhereKind): string {
  return `Add your website in General first, so agents know this ${kind === "order" ? "shop" : "page"} is yours.`;
}

/**
 * Where a pasted link puts the chooser: the listed platform it is plainly on (a TableCheck link with OpenTable picked
 * picks TableCheck), or whose own page it is (so the owner is told it isn't theirs); Another page for a link on no
 * listed platform, when nothing or a platform it is not on was picked; otherwise where it stands. `moved` says it went
 * to Another page, so the owner is told.
 */
export function choiceForLink(
  url: string,
  choice: string,
  kind: ElsewhereKind,
  another: string,
): { choice: string; moved: boolean } {
  const on = doorPlatformOf(url, kind);
  const picked = doorPlatform(choice);
  if (on) {
    const fits = picked && picked.id !== on.id ? doorPlatformFit(url, picked, kind) : "on_platform";
    return { choice: !picked || picked.id === on.id || fits !== "on_platform" ? on.id : choice, moved: false };
  }
  let valid = false;
  try {
    valid = new URL(url).protocol === "https:";
  } catch {
    valid = false;
  }
  if (!valid) return { choice, moved: false };
  // One of a platform's own pages (fresha.com/for-business) picks that platform, so the owner is told it isn't theirs.
  const own = DOOR_PLATFORMS.find(
    (p) => p.item_types.includes(kind) && doorPlatformFit(url, p, kind) === "platform_page",
  );
  if (own) return { choice: own.id, moved: false };
  if (!choice) return { choice: another, moved: true };
  if (picked && !picked.own_site && doorPlatformFit(url, picked, kind) === "not_on_platform")
    return { choice: another, moved: true };
  return { choice, moved: false };
}

/** The settings write that sets one kind's door elsewhere, or with null brings that kind back here. */
export function elsewhereDoc(
  current: readonly ElsewhereEntry[],
  kind: ElsewhereKind,
  next: { readonly url: string; readonly platform?: string | undefined } | null,
): { doorsElsewhere: ElsewhereEntry[] | null } {
  const rest = current.filter((d) => d.itemType !== kind);
  const all = next
    ? [
        ...rest,
        { itemType: kind, url: cleanDoorUrl(next.url.trim()), ...(next.platform ? { platform: next.platform } : {}) },
      ]
    : rest;
  // Bookings first, as everywhere: the same list reads the same.
  all.sort((a, b) => ELSEWHERE_KINDS.indexOf(a.itemType) - ELSEWHERE_KINDS.indexOf(b.itemType));
  return { doorsElsewhere: all.length ? all : null };
}

export { cleanDoorUrl, doorPlatform, doorPlatformFit, doorPlatformOf };
