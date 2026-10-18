import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  decimalAmount,
  type InboundRequest,
  type KnownLink,
  minorAmount,
  type PayLinkRequest,
  type PaymentFact,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { retryAfterMs } from "./http";
import { constantTimeEqual, hmacSha256Hex } from "./pay-sign";

/**
 * Mollie (ADR-023): pay links in the business's own Mollie account, with the profile's API key.
 *
 * An order the inbox accepts gets a Payment Link for what it comes to, good for one payment, made
 * with an idempotency key from the inbox's own id for the link. Each link names its own webhook
 * (`/v1/hooks/mollie?ref=<the inbox's id for it>`): Mollie posts there the id of a payment, unsigned,
 * and the inbox asks Mollie with the key what was paid on that link before it marks anything paid —
 * the body is never believed. An owner who also adds a signed webhook in Mollie (`payment-link.paid`,
 * `X-Mollie-Signature: sha256=<hex HMAC of the body>`) gives its signing secret, and those events are
 * checked by it as well, then read back the same way. A link whose order changed or ended is
 * archived. Refunds are made in Mollie, where the money is.
 *
 * The endpoints and fields are the ones Mollie documented on 18 October 2026; answers are read
 * leniently, so a field added later changes nothing.
 */

export const MOLLIE_API = "https://api.mollie.com";
/** The event a signed webhook added in Mollie's dashboard sends for a link paid. */
export const MOLLIE_EVENTS: readonly string[] = ["payment-link.paid"];
const KEY_PAGE = "https://my.mollie.com/dashboard/developers/api-keys";
const MOLLIE_DASHBOARD = "https://my.mollie.com/dashboard";

export const mollieForm = z.object({
  api_key: secretField(
    z
      .string()
      .trim()
      .min(20)
      .max(200)
      .regex(/^(live|test|access)_[A-Za-z0-9]+$/, "a Mollie API key starts with live_ or test_"),
    {
      label: "API key",
      help: "In Mollie: Developers → API keys. Copy the Live API key, or the Test API key to try it first.",
      link: { href: KEY_PAGE, text: "Get your API key" },
      placeholder: "live_…",
    },
  ),
  webhook_secret: secretField(z.string().trim().min(16).max(200).optional(), {
    label: "Webhook signing secret",
    help: "Mollie reports every payment either way. To have it signed too, add the address below in Mollie → Developers → Webhooks, with this event, and paste its signing secret.",
    advanced: true,
  }),
});

type Mode = "live" | "test";

interface Ctx {
  readonly http: ConnectContext["http"];
}

async function call(
  ctx: Ctx,
  key: string,
  method: string,
  path: string,
  opts: { readonly body?: unknown; readonly idempotency?: string } = {},
): Promise<{ res: ConnectorHttpResponse; json: Record<string, unknown> }> {
  const res = await ctx.http.request({
    method,
    url: `${MOLLIE_API}${path}`,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/hal+json, application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.idempotency ? { "idempotency-key": opts.idempotency } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed = res.text ? JSON.parse(res.text) : {};
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (res.status === 401) {
    throw new ConnectorError("auth", "Mollie did not take that API key. Copy it again from Mollie and connect again.", {
      field: "api_key",
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Mollie asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Mollie is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  if (res.status === 404) throw new ConnectorError("not_found", detailOf(json) || "Mollie has no such thing.");
  if (res.status >= 400) {
    throw new ConnectorError("refused", `Mollie said: ${detailOf(json) || `HTTP ${res.status}`}`);
  }
  return { res, json };
}

function detailOf(json: Record<string, unknown>): string {
  return typeof json.detail === "string" ? json.detail.slice(0, 300) : "";
}

function modeOf(key: string): Mode {
  return key.startsWith("live_") ? "live" : "test";
}

function href(links: unknown, name: string): string | null {
  const l = (links as Record<string, { href?: unknown }> | undefined)?.[name];
  return typeof l?.href === "string" && l.href.startsWith("https://") ? l.href : null;
}

async function connect(ctx: ConnectContext, input: Readonly<Record<string, string>>): Promise<Connected> {
  const key = String(input.api_key ?? "");
  if (key.startsWith("access_")) {
    throw new ConnectorError(
      "config",
      "That is an access token. Use the profile's API key (live_… or test_…) from Developers → API keys.",
      { field: "api_key" },
    );
  }
  const mode = modeOf(key);
  const { json: profile } = await call(ctx, key, "GET", "/v2/profiles/me");
  const id = typeof profile.id === "string" ? profile.id : "";
  if (!id.startsWith("pfl_"))
    throw new ConnectorError("bad_response", "Mollie did not say which profile this key is for.");
  if (!ctx.hookUrl) {
    throw new ConnectorError(
      "config",
      "This inbox does not know its own public https address (INBOX_PUBLIC_URL, or the Inbox address in Settings), so Mollie could not tell it of payments.",
    );
  }
  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 80) : id;
  const given = input.webhook_secret?.trim() || "";
  return {
    account: mode === "live" ? name : `${name} · test mode`,
    externalId: `${id}:${mode}`,
    secret: { api_key: key, ...(given ? { webhook_secret: given } : {}) },
    extra: {
      webhook: given ? "by_hand" : "per_link",
      profile_id: id,
      ...(typeof profile.status === "string" ? { profile_status: profile.status } : {}),
    },
    calendars: [],
    destinations: [],
    defaults: { busy: [], destination: null },
    mode,
  };
}

async function createLink(ctx: RunContext, req: PayLinkRequest) {
  const { json } = await call(ctx, keyOf(ctx), "POST", "/v2/payment-links", {
    idempotency: `sdi-${req.ref}`,
    body: {
      description: req.title.slice(0, 255),
      amount: { currency: req.amount.currency.toUpperCase(), value: decimalAmount(req.amount) },
      webhookUrl: req.hookUrl,
      reusable: false,
    },
  });
  const externalId = typeof json.id === "string" ? json.id : "";
  const url = href(json._links, "paymentLink");
  if (!externalId.startsWith("pl_") || !url) {
    throw new ConnectorError("bad_response", "Mollie made the payment link but did not say where it is.");
  }
  return { externalId, url };
}

async function closeLink(ctx: RunContext, link: { readonly externalId: string }): Promise<void> {
  await call(ctx, keyOf(ctx), "PATCH", `/v2/payment-links/${encodeURIComponent(link.externalId)}`, {
    body: { archived: true },
  });
}

/** Mollie's names for how it was paid, in the receipt's words. */
const METHODS: Readonly<Record<string, string>> = {
  creditcard: "card",
  applepay: "apple_pay",
  googlepay: "google_pay",
};

/** What Mollie holds about the link's payments, read with the key: the paid one, if there is one. */
async function check(ctx: RunContext, link: KnownLink): Promise<PaymentFact | null> {
  if (!link.externalId) return null;
  const { json } = await call(
    ctx,
    keyOf(ctx),
    "GET",
    `/v2/payment-links/${encodeURIComponent(link.externalId)}/payments?limit=10`,
  );
  const payments = ((json._embedded ?? {}) as { payments?: unknown }).payments;
  const list = Array.isArray(payments) ? (payments as Record<string, unknown>[]) : [];
  const paid = list.find((p) => p && p.status === "paid" && typeof p.id === "string");
  if (!paid) return null;
  const amount = paid.amount as { value?: unknown; currency?: unknown } | undefined;
  const currency = typeof amount?.currency === "string" ? amount.currency.toUpperCase() : "";
  const value = typeof amount?.value === "string" && currency ? minorAmount(amount.value, currency) : null;
  const method = typeof paid.method === "string" ? (METHODS[paid.method] ?? paid.method) : undefined;
  const paidAt = typeof paid.paidAt === "string" ? Date.parse(paid.paidAt) : Number.NaN;
  const dashboardUrl = href(paid._links, "dashboard");
  return {
    status: "paid",
    linkId: link.externalId,
    ref: link.ref,
    paymentId: String(paid.id),
    amount: value === null ? null : { value, currency },
    ...(method ? { method: method.slice(0, 40) } : {}),
    ...(Number.isFinite(paidAt) ? { paidAt } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
    livemode: paid.mode === "live",
  };
}

/**
 * A webhook. A signed one (Mollie's newer webhooks, added in the dashboard) is checked by its
 * signature — each value Mollie sends while a secret is rolled — and names the link; Mollie's
 * per-link one is not signed and names a payment, and the link comes from the address it was sent to.
 * Either way what was paid is asked of Mollie with the key: nothing in the body is believed.
 */
async function receive(ctx: RunContext, request: InboundRequest, lookup: (ref: string) => Promise<KnownLink | null>) {
  const signed = request.headers.get("x-mollie-signature");
  if (signed !== null) {
    const secret = ctx.secret.webhook_secret;
    if (!secret) throw new ConnectorError("refused", "A signed Mollie webhook, but no signing secret is set here.");
    const expected = await hmacSha256Hex(secret, request.body);
    const given = signed
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^sha256=/i, "")
          .toLowerCase(),
      )
      .filter(Boolean);
    if (!given.some((g) => constantTimeEqual(g, expected))) {
      throw new ConnectorError("refused", "The signature does not check out.");
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(request.body) as Record<string, unknown>;
    } catch {
      return null;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const eventId = typeof event.id === "string" ? event.id : "";
    const entityId = typeof event.entityId === "string" ? event.entityId : "";
    if (!MOLLIE_EVENTS.includes(type) || !eventId || !entityId.startsWith("pl_")) return null;
    const fact = await check(ctx, { ref: "", externalId: entityId, itemId: "" });
    return fact ? { eventId, topic: type, facts: [{ ...fact, ref: null }] } : null;
  }
  const ref = request.query.get("ref");
  if (!ref) return null;
  const link = await lookup(ref);
  if (!link?.externalId) return null;
  const fact = await check(ctx, link);
  if (!fact) return null;
  // The same payment told twice is one event.
  return { eventId: `${fact.paymentId}:${fact.status}`, topic: "payment-link.payment", facts: [fact] };
}

async function refresh(ctx: RunContext) {
  const { json } = await call(ctx, keyOf(ctx), "GET", "/v2/profiles/me");
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim().slice(0, 80) : "Mollie";
  return {
    account: modeOf(keyOf(ctx)) === "live" ? name : `${name} · test mode`,
    calendars: [],
    destinations: [],
  };
}

function keyOf(ctx: Pick<RunContext, "secret">): string {
  const key = ctx.secret.api_key;
  if (!key) throw new ConnectorError("config", "The Mollie key is not there. Connect Mollie again.");
  return key;
}

export function mollieConnector(): ConnectorDefinition {
  return {
    kind: "mollie",
    title: "Mollie",
    group: "payments",
    capabilities: ["pay_links"],
    auth: "form",
    form: mollieForm,
    note: "Orders you accept get a link to pay into your own Mollie account. Refunds stay in Mollie.",
    hookEvents: MOLLIE_EVENTS,
    connect,
    refresh,
    payments: {
      createLink,
      closeLink,
      check,
      receive,
      // Mollie opens the account's own organisation from here; each payment links to itself.
      dashboardUrl: () => MOLLIE_DASHBOARD,
    },
  };
}
