import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorPreset,
  type OutboundOrder,
  type RunContext,
  type SetupSnapshot,
  type SnapshotMenuItem,
} from "@surfingdog/core";
import {
  failOn,
  jsonOf,
  type PartnerClient,
  short,
  snapshotItem,
  type Tokens,
  tillCurrency,
  tokenSecret,
  tokensOf,
} from "./common";

/**
 * Clover (ADR-036), built and switched off: a Clover app needs a production developer account per region
 * and Clover's App Market approval before it can be used, and its v2/OAuth client (`CLOVER_CLIENT_ID`,
 * `CLOVER_CLIENT_SECRET`) is the server's. Until then the card says "Needs setup".
 *
 * With it: the owner signs in to Clover in their region (North America, Europe or Latin America: one way
 * each), Clover sends them back with the merchant's id (`merchant_id`), and the code is exchanged for an
 * expiring token pair (`/oauth/v2/token`, renewed at `/oauth/v2/refresh`). The inventory comes in to start
 * from (`GET /v3/merchants/{mId}/items?expand=modifierGroups,categories`, the groups' modifiers from
 * `GET /v3/merchants/{mId}/modifier_groups?expand=modifiers`; prices are in the currency's minor unit, as
 * Clover keeps them). An order the business accepts here is made as an atomic order
 * (`POST /v3/merchants/{mId}/atomic_order/orders`), Clover working out its totals and tax, one line per
 * unit; it is in Clover's till from then on, and one deleted there reads as cancelled.
 *
 * Clover documents no idempotency key for atomic orders and no way here to find an app's order again
 * by its own reference: a write whose answer never came is left for the owner to check in Clover.
 *
 * Sources, read 21 Oct 2026: https://docs.clover.com/dev/docs/create-an-atomic-order,
 * https://docs.clover.com/dev/docs/making-rest-api-calls, .../generate-expiring-tokens-using-v2-oauth-flow,
 * .../managing-modifier-groups-modifiers and .../app-approval-and-app-market-faqs.
 */

export const CLOVER_REGIONS = {
  na: { www: "https://www.clover.com", api: "https://api.clover.com", label: "Clover" },
  eu: { www: "https://www.eu.clover.com", api: "https://api.eu.clover.com", label: "Clover Europe" },
  la: { www: "https://www.la.clover.com", api: "https://api.la.clover.com", label: "Clover Latin America" },
} as const;
type Region = keyof typeof CLOVER_REGIONS;

export const CLOVER_NOT_READY = "Needs setup: a Clover app needs Clover's App Market approval first.";

const regionOf = (v: unknown): Region => (v === "eu" || v === "la" ? v : "na");

async function tokens(
  ctx: Pick<ConnectContext, "http" | "now">,
  region: Region,
  path: string,
  body: Record<string, string>,
): Promise<Tokens> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${CLOVER_REGIONS[region].api}${path}`,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 400 || res.status === 401)
    throw new ConnectorError("auth", "Clover did not take the sign-in. Connect it again.");
  failOn("Clover", res, "code");
  const j = jsonOf(res) as {
    access_token?: unknown;
    refresh_token?: unknown;
    access_token_expiration?: unknown;
  } | null;
  if (typeof j?.access_token !== "string" || typeof j.refresh_token !== "string") {
    throw new ConnectorError("bad_response", "Clover did not give this inbox a token.");
  }
  const exp = Number(j.access_token_expiration);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Number.isFinite(exp) ? exp * 1000 : ctx.now + 30 * 60_000,
  };
}

async function call(
  ctx: Pick<ConnectContext, "http">,
  region: Region,
  token: string,
  method: string,
  path: string,
  json?: unknown,
) {
  const res = await ctx.http.request({
    method,
    url: `${CLOVER_REGIONS[region].api}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  failOn("Clover", res, "code");
  return { res, json: jsonOf(res) as { elements?: unknown[] } | null };
}

interface CloverItem {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly price?: unknown;
  readonly hidden?: unknown;
  readonly available?: unknown;
  readonly categories?: { readonly elements?: readonly { name?: unknown }[] };
  readonly modifierGroups?: { readonly elements?: readonly { id?: unknown }[] };
}
interface CloverGroup {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly minRequired?: unknown;
  readonly maxAllowed?: unknown;
  readonly modifiers?: {
    readonly elements?: readonly { id?: unknown; name?: unknown; price?: unknown; available?: unknown }[];
  };
}

/** Clover's inventory as a snapshot: its first category is the section, its modifier groups the options. */
export function cloverSnapshot(
  items: readonly CloverItem[],
  groups: readonly CloverGroup[],
  merchant: string,
  currency: string,
  now: number,
): SetupSnapshot {
  const byId = new Map(groups.filter((g) => g.id !== undefined).map((g) => [String(g.id), g]));
  const sections = new Map<string, SnapshotMenuItem[]>();
  for (const i of items) {
    if (i.hidden === true || i.available === false || i.id === undefined || !short(i.name)) continue;
    const section = short(i.categories?.elements?.[0]?.name, 120) || "Menu";
    const price = typeof i.price === "number" && Number.isSafeInteger(i.price) && i.price >= 0 ? i.price : null;
    const optionGroups = (i.modifierGroups?.elements ?? []).flatMap((ref) => {
      const g = ref.id !== undefined ? byId.get(String(ref.id)) : undefined;
      if (!g) return [];
      const choices = (g.modifiers?.elements ?? []).flatMap((m) =>
        m.id !== undefined && short(m.name) && m.available !== false
          ? [
              {
                externalId: String(m.id),
                name: short(m.name, 120),
                priceDelta: typeof m.price === "number" && m.price > 0 ? Math.trunc(m.price) : 0,
              },
            ]
          : [],
      );
      if (choices.length === 0) return [];
      const min = Math.max(0, Number(g.minRequired) || 0);
      const max = Math.max(Number(g.maxAllowed) || choices.length, min, 1);
      return [{ externalId: String(g.id), name: short(g.name, 120) || "Options", min, max, choices }];
    });
    const list = sections.get(section) ?? [];
    list.push(
      snapshotItem({
        externalId: String(i.id),
        name: short(i.name),
        price: price === null ? null : { value: price, currency },
        optionGroups,
      }),
    );
    sections.set(section, list);
  }
  return {
    source: { kind: "clover", account: merchant, readAt: now },
    menu: [...sections].map(([name, items]) => ({ name, items })),
  };
}

/** An accepted order as an atomic order: one line per unit, each with its modifiers. */
export function cloverOrderBody(o: OutboundOrder): Record<string, unknown> {
  const missing = o.lines.find((l) => !l.externalId);
  if (missing)
    throw new ConnectorError(
      "refused",
      `${missing.name} is not an item of the Clover inventory this inbox brought in.`,
    );
  const lineItems = o.lines.flatMap((l) =>
    Array.from({ length: Math.min(50, l.quantity) }, () => ({
      item: { id: l.externalId },
      ...(l.note ? { note: l.note.slice(0, 140) } : {}),
      modifications: l.options.filter((x) => x.externalId).map((x) => ({ modifier: { id: x.externalId } })),
    })),
  );
  return {
    orderCart: { lineItems, note: `${o.reference}${o.note ? ` · ${o.note.slice(0, 200)}` : ""}`, title: o.reference },
  };
}

export function cloverConnector(client: PartnerClient | null): ConnectorDefinition {
  const ready = Boolean(client?.clientId && client.clientSecret);
  const c = client as PartnerClient;
  const presets: ConnectorPreset[] = (["eu", "la"] as const).map((r) => ({
    id: r,
    label: CLOVER_REGIONS[r].label,
    values: { region: r },
  }));
  const fresh = async (ctx: RunContext): Promise<{ token: string; region: Region; merchant: string }> => {
    const region = regionOf(ctx.extra.region);
    const merchant = String(ctx.extra.merchant ?? "");
    const t = tokensOf(ctx.secret);
    if (!t || !merchant) throw new ConnectorError("auth", "Connect Clover again.");
    if (t.expiresAt - 60_000 > ctx.now) return { token: t.accessToken, region, merchant };
    const next = await tokens(ctx, region, "/oauth/v2/refresh", {
      client_id: c.clientId,
      refresh_token: t.refreshToken,
    });
    await ctx.saveSecret(tokenSecret(next));
    return { token: next.accessToken, region, merchant };
  };
  return {
    kind: "clover",
    title: "Clover",
    group: "pos",
    capabilities: ["setup_in", "orders_out", "status_in"],
    auth: "oauth",
    presets,
    ready: () => (ready ? true : CLOVER_NOT_READY),
    whenNotReady: { status: "setup", hint: CLOVER_NOT_READY, href: "https://surfingdog.ai/docs/ordering/#which-tills" },
    note: "Your Clover inventory comes in to start from, and orders you accept here go into Clover.",
    consent: "Clover will ask to let this inbox read your inventory and make orders.",
    oauth: {
      authorizeUrl: (p) =>
        `${CLOVER_REGIONS[regionOf(p.input?.region)].www}/oauth/v2/authorize?${new URLSearchParams({
          client_id: c.clientId,
          redirect_uri: p.redirectUri,
          state: p.state,
        })}`,
      async exchange(ctx, p) {
        if (!ready) throw new ConnectorError("config", CLOVER_NOT_READY);
        const merchant = p.returned?.merchant_id;
        if (!merchant) throw new ConnectorError("bad_response", "Clover did not say which merchant this is.");
        const region = regionOf(p.input?.region);
        const t = await tokens(ctx, region, "/oauth/v2/token", {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code: p.code,
        });
        const { res, json } = await call(
          ctx,
          region,
          t.accessToken,
          "GET",
          `/v3/merchants/${encodeURIComponent(merchant)}`,
        );
        const name = short((json as { name?: unknown } | null)?.name, 120);
        if (res.status !== 200) throw new ConnectorError("bad_response", "Clover did not show the merchant.");
        return {
          account: name || "Clover",
          externalId: `${region}:${merchant}`,
          secret: tokenSecret(t),
          extra: { region, merchant },
          calendars: [],
          destinations: [],
          defaults: { busy: [], destination: null },
        };
      },
    },

    setup: {
      async read(ctx) {
        const { token, region, merchant } = await fresh(ctx);
        const m = encodeURIComponent(merchant);
        const items = await call(
          ctx,
          region,
          token,
          "GET",
          `/v3/merchants/${m}/items?expand=modifierGroups,categories&limit=1000`,
        );
        const groups = await call(
          ctx,
          region,
          token,
          "GET",
          `/v3/merchants/${m}/modifier_groups?expand=modifiers&limit=1000`,
        );
        if (items.res.status !== 200) throw new ConnectorError("bad_response", "Clover did not send the inventory.");
        return cloverSnapshot(
          (items.json?.elements ?? []) as CloverItem[],
          (groups.json?.elements ?? []) as CloverGroup[],
          merchant,
          tillCurrency(ctx),
          ctx.now,
        );
      },
    },

    orders: {
      async put(ctx, order) {
        const { token, region, merchant } = await fresh(ctx);
        const { res, json } = await call(
          ctx,
          region,
          token,
          "POST",
          `/v3/merchants/${encodeURIComponent(merchant)}/atomic_order/orders`,
          cloverOrderBody(order),
        );
        const id = (json as { id?: unknown } | null)?.id;
        if (res.status === 200 && typeof id === "string") return { externalId: id, status: "accepted" };
        if (res.status >= 400 && res.status < 500) {
          const why = short((json as { message?: unknown } | null)?.message, 200);
          throw new ConnectorError(
            "refused",
            why ? `Clover would not take the order: ${why}` : "Clover would not take the order.",
          );
        }
        throw new ConnectorError("bad_response", `Clover answered ${res.status} to the order.`);
      },
      async find() {
        return null;
      },
      async status(ctx, ref) {
        const { token, region, merchant } = await fresh(ctx);
        const { res, json } = await call(
          ctx,
          region,
          token,
          "GET",
          `/v3/merchants/${encodeURIComponent(merchant)}/orders/${encodeURIComponent(ref.externalId)}`,
        );
        if (res.status === 404) return { status: "cancelled", reason: "deleted in Clover" };
        if (res.status !== 200 || !json) return null;
        return { status: (json as { state?: unknown }).state === "locked" ? "completed" : "accepted" };
      },
    },
  };
}
