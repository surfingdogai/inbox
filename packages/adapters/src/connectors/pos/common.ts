import {
  type ConnectContext,
  ConnectorError,
  type ConnectorHttpResponse,
  minorUnits,
  type RunContext,
  type SnapshotMenuItem,
} from "@surfingdog/core";
import { retryAfterMs } from "../http";

/**
 * What the food connectors share (ADR-040): a till's decimal prices in the business's minor units, the
 * allergen names tools send read as the menu's codes (always unconfirmed), JSON calls answered alike,
 * and the last few words of a refusal. Web APIs only.
 */

/** A till's price in major units (7, 0.7, 4.37) as an integer count of the currency's minor unit. */
export function minorOf(value: unknown, currency: string): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const e = minorUnits(currency.toUpperCase());
  if (e === null || e === undefined) return null;
  // From the shortest decimal the number prints as, never from a float multiplied: 4.37 is 437.
  const [whole = "0", fraction = ""] = String(n).split(".");
  if (/e/i.test(whole)) return Math.round(n * 10 ** e);
  const minor = Number(whole) * 10 ** e + Number((fraction.slice(0, e) || "0").padEnd(e, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Allergen names as tools write them, read as the menu's codes. What a name does not say for sure is
 * left out: the owner adds and confirms each dish in person anyway.
 */
const NAMES: Readonly<Record<string, readonly string[]>> = {
  milk: ["milk"],
  dairy: ["milk"],
  lactose: ["milk"],
  egg: ["eggs"],
  eggs: ["eggs"],
  fish: ["fish"],
  crustacean: ["crustaceans"],
  crustaceans: ["crustaceans"],
  shellfish: ["crustaceans"],
  mollusc: ["molluscs"],
  molluscs: ["molluscs"],
  mollusk: ["molluscs"],
  mollusks: ["molluscs"],
  peanut: ["peanuts"],
  peanuts: ["peanuts"],
  "tree nuts": ["tree_nuts"],
  nuts: ["tree_nuts"],
  soy: ["soy"],
  soya: ["soy"],
  soybean: ["soy"],
  soybeans: ["soy"],
  wheat: ["wheat"],
  gluten: ["gluten"],
  sesame: ["sesame"],
  "sesame seeds": ["sesame"],
  celery: ["celery"],
  mustard: ["mustard"],
  lupin: ["lupin"],
  lupine: ["lupin"],
  sulphites: ["sulphites"],
  sulfites: ["sulphites"],
  "sulphur dioxide": ["sulphites"],
  "sulfur dioxide": ["sulphites"],
};

export function allergenCodesOf(names: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    for (const code of NAMES[n.trim().toLowerCase()] ?? []) out.add(code);
  }
  return [...out];
}

/** A tool's text, on one line and short: a name, a reason. */
export function short(value: unknown, max = 200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function jsonOf(res: ConnectorHttpResponse): unknown {
  try {
    return res.text ? (JSON.parse(res.text) as unknown) : null;
  } catch {
    return null;
  }
}

/** The failures every till answers alike, in the owner's words. */
export function failOn(tool: string, res: ConnectorHttpResponse, field: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError("auth", `${tool} did not take that key. Make a new one and connect again.`, { field });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", `${tool} asked this inbox to slow down.`, {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      `${tool} is not answering properly; this inbox tries again in a few minutes.`,
    );
  }
}

/** An item as a snapshot carries it, with only the fields that hold something. */
export function snapshotItem(i: {
  externalId: string;
  groupExternalId?: string | undefined;
  name: string;
  description?: string | null | undefined;
  price: { value: number; currency: string } | null;
  contains?: readonly string[] | undefined;
  optionGroups?: SnapshotMenuItem["optionGroups"];
  dietary?: readonly string[] | undefined;
}): SnapshotMenuItem {
  return {
    externalId: i.externalId,
    ...(i.groupExternalId ? { groupExternalId: i.groupExternalId } : {}),
    name: i.name,
    ...(i.description ? { description: i.description } : {}),
    price: i.price,
    ...(i.contains?.length ? { allergens: { contains: i.contains, status: "unconfirmed" as const } } : {}),
    ...(i.optionGroups?.length ? { optionGroups: i.optionGroups } : {}),
    ...(i.dietary?.length ? { dietary: i.dietary } : {}),
  };
}

/** A client-credentials token (Flipdish, Deliverect): asked for on each run, never kept. */
export async function clientToken(
  ctx: Pick<ConnectContext, "http">,
  o: { readonly tool: string; readonly url: string; readonly body: Record<string, string>; readonly json?: boolean },
): Promise<string> {
  const res = await ctx.http.request({
    method: "POST",
    url: o.url,
    headers: {
      accept: "application/json",
      "content-type": o.json ? "application/json" : "application/x-www-form-urlencoded",
    },
    body: o.json ? JSON.stringify(o.body) : new URLSearchParams(o.body).toString(),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ConnectorError("auth", `${o.tool} did not take that client ID and secret.`, { field: "clientSecret" });
  }
  failOn(o.tool, res, "clientSecret");
  const token = (jsonOf(res) as { access_token?: unknown } | null)?.access_token;
  if (res.status !== 200 || typeof token !== "string" || !token) {
    throw new ConnectorError("bad_response", `${o.tool} did not give this inbox a token.`);
  }
  return token;
}

/** The currency a till's prices are read in, where they name none: the business's. */
export function tillCurrency(ctx: Pick<RunContext, "inbox">): string {
  const c = ctx.inbox.currency ?? "";
  return /^[A-Z]{3}$/.test(c) ? c : "USD";
}

/** A partner app's client, from the server's environment: what a "Needs setup" till waits for. */
export interface PartnerClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Access and refresh tokens kept sealed, renewed before they run out. */
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

export function tokensOf(secret: Readonly<Record<string, string>>): Tokens | null {
  const a = secret.accessToken;
  const r = secret.refreshToken;
  const e = Number(secret.expiresAt);
  return a && r && Number.isFinite(e) ? { accessToken: a, refreshToken: r, expiresAt: e } : null;
}

export function tokenSecret(t: Tokens): Record<string, string> {
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: String(t.expiresAt) };
}

/** Refreshes in flight, and the ones just made, by the refresh token they spent. */
const refreshing = new Map<string, Promise<Tokens>>();
const refreshed = new Map<string, { readonly tokens: Tokens; readonly until: number }>();

/**
 * One refresh per refresh token: a sync and an order written in the same minute share it, and a run that
 * started with the token another just spent is given what that one got. A provider may let each refresh
 * token be used once (Clover's expiring tokens); spending it twice would end the connection.
 */
export function refreshOnce(refreshToken: string, now: number, run: () => Promise<Tokens>): Promise<Tokens> {
  const done = refreshed.get(refreshToken);
  if (done && done.until > now && done.tokens.expiresAt - 60_000 > now) return Promise.resolve(done.tokens);
  const inFlight = refreshing.get(refreshToken);
  if (inFlight) return inFlight;
  const next = run()
    .then((t) => {
      for (const [k, v] of refreshed) if (v.until <= now) refreshed.delete(k);
      refreshed.set(refreshToken, { tokens: t, until: now + 10 * 60_000 });
      return t;
    })
    .finally(() => refreshing.delete(refreshToken));
  refreshing.set(refreshToken, next);
  return next;
}

/** A line's choices must each be one the till knows: never left out while the price still holds them. */
export function refuseUnknownChoices(tool: string, o: OutboundOrderLike): void {
  for (const l of o.lines) {
    const choice = l.options.find((x) => !x.externalId);
    if (choice) {
      throw new ConnectorError("refused", `${choice.name} has no id in your ${tool} menu: bring the menu in again.`);
    }
  }
}

interface OutboundOrderLike {
  readonly lines: readonly {
    readonly options: readonly { readonly name: string; readonly externalId: string | null }[];
  }[];
}
