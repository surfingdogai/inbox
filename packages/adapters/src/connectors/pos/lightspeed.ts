import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type OutboundOrder,
  type RunContext,
  type SetupSnapshot,
  type SnapshotMenuItem,
} from "@surfingdog/core";
import { uuidFrom } from "../work/common";
import {
  failOn,
  jsonOf,
  minorOf,
  type PartnerClient,
  refreshOnce,
  refuseUnknownChoices,
  short,
  snapshotItem,
  type Tokens,
  tillCurrency,
  tokenSecret,
  tokensOf,
} from "./common";

/**
 * Lightspeed Restaurant (K-Series), built and switched off (ADR-036): Lightspeed's API is for partners,
 * through its partner programme, with an OAuth 2.0 authorization-code client
 * (`https://auth.lsk-prod.app/realms/k-series/protocol/openid-connect/…`, scopes `orders-api` and
 * `offline-access`). Until whoever runs the server holds that client (`LIGHTSPEED_CLIENT_ID`,
 * `LIGHTSPEED_CLIENT_SECRET`), the card says "Needs setup".
 *
 * With it: the owner signs in to Lightspeed and chooses the business location
 * (`GET /o/op/data/businesses`). Its menu comes in to start from (`GET /o/op/1/menu/list`, then
 * `GET /o/op/2/menu/load/{menuId}`), its items keyed by their SKU, their production instructions as
 * option groups that add nothing. An order the business accepts here goes in as a to-go order
 * (`POST /o/op/1/order/toGo`) by SKU, with a `thirdPartyReference` the inbox makes from its own mark:
 * Lightspeed answers 409 to the same reference twice, which counts as written.
 *
 * Lightspeed says what became of an order by webhook only (its Order Notification, with no signature
 * this build could read), and has no read-back by the inbox's reference: this connector does not follow
 * an order's status (`status_in` is not claimed), and the owner follows it in Lightspeed.
 *
 * Source, read 21 Oct 2026: the K-Series OpenAPI document at https://api-docs.lsk.lightspeed.app/source.json.
 */

export const LIGHTSPEED_API = "https://api.lsk.lightspeed.app";
export const LIGHTSPEED_AUTH = "https://auth.lsk-prod.app/realms/k-series/protocol/openid-connect";
export const LIGHTSPEED_NOT_READY = "Needs setup: Lightspeed gives API access to partners only.";

async function tokenCall(ctx: Pick<ConnectContext, "http" | "now">, body: Record<string, string>): Promise<Tokens> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${LIGHTSPEED_AUTH}/token`,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  if (res.status === 400 || res.status === 401)
    throw new ConnectorError("auth", "Lightspeed did not take the sign-in. Connect it again.");
  failOn("Lightspeed", res, "code");
  const j = jsonOf(res) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  if (typeof j?.access_token !== "string" || typeof j.refresh_token !== "string") {
    throw new ConnectorError("bad_response", "Lightspeed did not give this inbox a token.");
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: ctx.now + (Number(j.expires_in) || 300) * 1000,
  };
}

async function fresh(ctx: RunContext, client: PartnerClient): Promise<string> {
  const t = tokensOf(ctx.secret);
  if (!t) throw new ConnectorError("auth", "Connect Lightspeed again.");
  if (t.expiresAt - 60_000 > ctx.now) return t.accessToken;
  const next = await refreshOnce(t.refreshToken, ctx.now, () =>
    tokenCall(ctx, {
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  );
  await ctx.saveSecret(tokenSecret(next));
  return next.accessToken;
}

async function call(ctx: Pick<ConnectContext, "http">, token: string, method: string, path: string, json?: unknown) {
  const res = await ctx.http.request({
    method,
    url: `${LIGHTSPEED_API}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  failOn("Lightspeed", res, "code");
  return { res, json: jsonOf(res) };
}

interface LskEntry {
  readonly "@type"?: unknown;
  readonly name?: unknown;
  readonly productName?: unknown;
  readonly productPrice?: unknown;
  readonly sku?: unknown;
  readonly menuEntry?: readonly LskEntry[];
  readonly productionInstructionList?: readonly {
    productionIntructionGroupId?: unknown;
    productionInstructionGroupName?: unknown;
    multiSelectionPermitted?: unknown;
    productionInstructionList?: readonly { instruction?: unknown; ikentooModifierId?: unknown }[];
  }[];
}

/** A K-Series menu as a snapshot: each group a section, its items by SKU. */
export function lightspeedSnapshot(
  menu: { menuEntryGroups?: readonly LskEntry[] },
  location: string,
  currency: string,
  now: number,
): SetupSnapshot {
  const sections: { name: string; items: SnapshotMenuItem[] }[] = [];
  const walk = (g: LskEntry) => {
    const items: SnapshotMenuItem[] = [];
    for (const e of g.menuEntry ?? []) {
      if (e["@type"] === "group") {
        walk(e);
        continue;
      }
      if (e["@type"] !== "menuItem" || typeof e.sku !== "string" || !short(e.productName)) continue;
      const price = minorOf(e.productPrice, currency);
      items.push(
        snapshotItem({
          externalId: e.sku,
          name: short(e.productName),
          price: price === null ? null : { value: price, currency },
          optionGroups: (e.productionInstructionList ?? []).flatMap((pg) => {
            const choices = (pg.productionInstructionList ?? []).flatMap((x) =>
              x.ikentooModifierId !== undefined && short(x.instruction)
                ? [{ externalId: String(x.ikentooModifierId), name: short(x.instruction, 120), priceDelta: 0 }]
                : [],
            );
            if (choices.length === 0 || pg.productionIntructionGroupId === undefined) return [];
            return [
              {
                externalId: String(pg.productionIntructionGroupId),
                name: short(pg.productionInstructionGroupName, 120) || "Instructions",
                min: 0,
                max: pg.multiSelectionPermitted === true ? choices.length : 1,
                choices,
              },
            ];
          }),
        }),
      );
    }
    if (items.length) sections.push({ name: short(g.name, 120) || "Menu", items });
  };
  for (const g of menu.menuEntryGroups ?? []) walk(g);
  return { source: { kind: "lightspeed", account: location, readAt: now }, menu: sections };
}

/** The to-go order as K-Series takes it, by SKU. Every line must be an item of the menu that came in. */
export function lightspeedOrderBody(o: OutboundOrder, location: string, reference: string): Record<string, unknown> {
  const missing = o.lines.find((l) => !l.externalId);
  if (missing)
    throw new ConnectorError("refused", `${missing.name} is not an item of the Lightspeed menu this inbox brought in.`);
  refuseUnknownChoices("Lightspeed", o);
  return {
    businessLocationId: Number(location),
    thirdPartyReference: reference,
    ...(o.customer.firstName
      ? {
          customerInfo: {
            firstName: o.customer.firstName,
            ...(o.customer.phone ? { contactNumberAsE164: o.customer.phone } : {}),
          },
        }
      : {}),
    ...(o.note ? { orderNote: o.note.slice(0, 500) } : {}),
    ...(o.slotStart !== null ? { scheduledTimeForOrderAsIso8601: new Date(o.slotStart).toISOString() } : {}),
    items: o.lines.map((l) => ({
      quantity: l.quantity,
      sku: l.externalId,
      modifiers: l.options.map((x) => ({ modifierId: x.externalId })),
    })),
    ...(o.address
      ? {
          deliveryAddress: {
            addressLine1: o.address.streetAddress ?? "",
            zip: o.address.postalCode ?? "",
            city: o.address.addressLocality ?? "",
          },
        }
      : {}),
  };
}

export function lightspeedConnector(client: PartnerClient | null): ConnectorDefinition {
  const ready = Boolean(client?.clientId && client.clientSecret);
  const c = client as PartnerClient;
  const locationOf = (ctx: RunContext) =>
    ctx.choices?.location ?? (typeof ctx.extra.location === "string" ? ctx.extra.location : "");
  return {
    kind: "lightspeed",
    title: "Lightspeed Restaurant",
    group: "pos",
    capabilities: ["setup_in", "orders_out"],
    auth: "oauth",
    ready: () => (ready ? true : LIGHTSPEED_NOT_READY),
    whenNotReady: {
      status: "setup",
      hint: "Not available yet: Lightspeed lets only approved partners connect. Use GloriaFood or Flipdish meanwhile.",
      href: "https://surfingdog.ai/docs/ordering/#which-tills",
    },
    note: "Your Lightspeed menu comes in to start from, and orders you accept here go into Lightspeed.",
    consent: "Lightspeed will ask to let this inbox read your menu and send it orders.",
    oauth: {
      authorizeUrl: (p) =>
        `${LIGHTSPEED_AUTH}/auth?${new URLSearchParams({
          response_type: "code",
          client_id: c.clientId,
          redirect_uri: p.redirectUri,
          scope: "orders-api offline-access",
          state: p.state,
          code_challenge: p.challenge,
          code_challenge_method: "S256",
        })}`,
      async exchange(ctx, p) {
        if (!ready) throw new ConnectorError("config", LIGHTSPEED_NOT_READY);
        const t = await tokenCall(ctx, {
          grant_type: "authorization_code",
          code: p.code,
          redirect_uri: p.redirectUri,
          code_verifier: p.verifier,
          client_id: c.clientId,
          client_secret: c.clientSecret,
        });
        const { res, json } = await call(ctx, t.accessToken, "GET", "/o/op/data/businesses");
        const list = Array.isArray(json)
          ? (json as { id?: unknown; name?: unknown; businessLocations?: { id?: unknown; name?: unknown }[] }[])
          : [];
        const locations = list.flatMap((b) =>
          (b.businessLocations ?? []).flatMap((l) =>
            l.id !== undefined
              ? [
                  {
                    id: String(l.id),
                    name: [short(b.name, 80), short(l.name, 80)].filter(Boolean).join(", ") || String(l.id),
                  },
                ]
              : [],
          ),
        );
        if (res.status !== 200 || locations.length === 0)
          throw new ConnectorError("not_found", "Lightspeed shows no business location for this sign-in.");
        const first = locations[0] as { id: string; name: string };
        return {
          account: first.name,
          externalId: String(list[0]?.id ?? first.id),
          secret: tokenSecret(t),
          extra: { location: first.id },
          calendars: [],
          destinations: [],
          defaults: { busy: [], destination: null },
          choices: [{ key: "location", label: "Business location", options: locations.slice(0, 100), value: first.id }],
        };
      },
    },

    setup: {
      async read(ctx) {
        const token = await fresh(ctx, c);
        const location = locationOf(ctx);
        const list = await call(
          ctx,
          token,
          "GET",
          `/o/op/1/menu/list?businessLocationId=${encodeURIComponent(location)}`,
        );
        const menus = Array.isArray(list.json) ? (list.json as { ikentooMenuId?: unknown }[]) : [];
        const id = menus[0]?.ikentooMenuId;
        if (id === undefined) return { source: { kind: "lightspeed", account: location, readAt: ctx.now }, menu: [] };
        const { res, json } = await call(
          ctx,
          token,
          "GET",
          `/o/op/2/menu/load/${encodeURIComponent(String(id))}?businessLocationId=${encodeURIComponent(location)}`,
        );
        if (res.status !== 200) throw new ConnectorError("bad_response", "Lightspeed did not send the menu.");
        return lightspeedSnapshot(
          (json ?? {}) as { menuEntryGroups?: readonly LskEntry[] },
          location,
          tillCurrency(ctx),
          ctx.now,
        );
      },
    },

    orders: {
      // Lightspeed answers 409 to a thirdPartyReference it has seen: a second write is the same order.
      idempotent: true,
      async put(ctx, order) {
        const token = await fresh(ctx, c);
        const reference = await uuidFrom(ctx.marker, order.key);
        const { res, json } = await call(
          ctx,
          token,
          "POST",
          "/o/op/1/order/toGo",
          lightspeedOrderBody(order, locationOf(ctx), reference),
        );
        // The same reference twice is the same order: written already.
        if (res.status === 200 || res.status === 409) return { externalId: reference, status: "pending" };
        if (res.status === 400) {
          const why = short((json as { message?: unknown } | null)?.message, 200);
          throw new ConnectorError(
            "refused",
            why ? `Lightspeed would not take the order: ${why}` : "Lightspeed would not take the order.",
          );
        }
        throw new ConnectorError("bad_response", `Lightspeed answered ${res.status} to the order.`);
      },
      // No read-back by the inbox's reference: a write whose answer never came is written once more
      // (`idempotent`), and a reference Lightspeed has seen is answered 409, written.
      async find() {
        return null;
      },
      async status() {
        return null;
      },
    },
  };
}
