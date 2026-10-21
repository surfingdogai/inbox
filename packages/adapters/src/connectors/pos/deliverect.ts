import {
  type ConnectorDefinition,
  ConnectorError,
  field,
  type HookEvent,
  minorUnits,
  type OutboundOrder,
  type PosOrderState,
} from "@surfingdog/core";
import { z } from "zod";
import { verifyHexHmac } from "../hook-sign";
import { uuidFrom } from "../work/common";
import { clientToken, failOn, jsonOf, type PartnerClient, short } from "./common";

/**
 * Deliverect (ADR-036), built and switched off: one channel integration reaches every till Deliverect
 * connects, once Deliverect certified it (a partner application, staging keys, certification calls). The
 * channel's client and name are the server's (`DELIVERECT_CLIENT_ID`, `DELIVERECT_CLIENT_SECRET`,
 * `DELIVERECT_CHANNEL`); until then the card says "Needs setup".
 *
 * With them: the restaurant adds this channel in Deliverect, and the connection names its channel link.
 * An order the business accepts here is created on it (`POST /{channelName}/order/{channelLinkId}`),
 * prices as integers in the currency's minor unit (`decimalDigits`), the restaurant's own couriers,
 * under a `channelOrderId` the inbox makes from its own mark (Deliverect refuses one reused within 48
 * hours). A 201 only says the order was valid: what the till did comes as an Order Status Update to the
 * connection's own address, signed with HMAC-SHA-256 over the exact bytes (`x-server-authorization-hmac-sha256`,
 * hex), checked in constant time, and only then read: accepted, preparing, ready, in delivery and
 * finalized become the order's progress; denied (35), cancelled (110) and failed (120) mark it for a
 * person. Deliverect offers no read-back of
 * an order a channel made, so this signed status is the word the inbox takes.
 *
 * Sources, read 21 Oct 2026: https://developers.deliverect.com/v3.0-ordering-experience/docs/channel-api-overview,
 * .../reference/create-channel-order, .../reference/channel_order_status and
 * https://developers.deliverect.com/reference/hmac-authentication. The menu reaches a channel by Deliverect's
 * push (Menu Update), which this build does not take: start from the menu here or another tool.
 */

export interface DeliverectPartner extends PartnerClient {
  /** The channel's name in Deliverect's paths, given at certification. */
  readonly channel: string;
  /** Deliverect's staging environment, before certification. */
  readonly staging?: boolean | undefined;
}

export const DELIVERECT_NOT_READY = "Needs setup: a Deliverect channel needs Deliverect's certification first.";
export const DELIVERECT_API = "https://api.deliverect.com";
export const DELIVERECT_STAGING_API = "https://api.staging.deliverect.com";

export const deliverectForm = z.object({
  channelLinkId: field(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{6,64}$/, "the channel link id Deliverect shows"),
    {
      label: "Channel link",
      help: "In Deliverect, once you add this channel: its channel link id.",
    },
  ),
  hmacSecret: field(z.string().trim().min(8).max(200).optional(), {
    label: "Webhook secret",
    help: "The secret Deliverect signs its updates with, from the channel's integration settings.",
    input: "password",
    secret: true,
    advanced: true,
  }),
});

/** Deliverect's order types: collection 1, delivery 2, eating in 3. */
const ORDER_TYPE = { pickup: 1, delivery: 2, dine_in: 3 } as const;

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export function deliverectOrderBody(
  o: OutboundOrder,
  channelOrderId: string,
  channel: string,
): Record<string, unknown> {
  const digits = minorUnits(o.total.currency) ?? 2;
  const missing = o.lines.find((l) => !l.externalId);
  if (missing) throw new ConnectorError("refused", `${missing.name} has no PLU from your till's menu.`);
  const when = o.slotStart;
  return {
    channelOrderId,
    channelOrderDisplayId: o.reference,
    orderType: ORDER_TYPE[o.method],
    deliveryIsAsap: when === null,
    ...(when !== null ? (o.method === "delivery" ? { deliveryTime: utc(when) } : { pickupTime: utc(when) }) : {}),
    decimalDigits: digits,
    courier: o.method === "delivery" ? "restaurant" : channel,
    orderIsAlreadyPaid: o.paid,
    payment: { amount: o.total.value, type: o.paid ? 0 : 1 },
    items: o.lines.map((l) => ({
      plu: l.externalId,
      name: l.name.slice(0, 120),
      price: l.unitPrice.value,
      quantity: l.quantity,
      ...(l.note ? { remark: l.note.slice(0, 140) } : {}),
      subItems: l.options
        .filter((x) => x.externalId)
        .map((x) => ({ plu: x.externalId, name: x.name.slice(0, 120), price: x.priceDelta?.value ?? 0, quantity: 1 })),
    })),
    ...(o.note ? { note: o.note.slice(0, 500) } : {}),
    ...(o.fee ? { deliveryCost: o.fee.value } : {}),
    ...(o.tip ? { tip: o.tip.value } : {}),
    ...(o.customer.firstName
      ? { customer: { name: o.customer.firstName, ...(o.customer.phone ? { phoneNumber: o.customer.phone } : {}) } }
      : {}),
    ...(o.address
      ? {
          deliveryAddress: {
            street: o.address.streetAddress ?? "",
            postalCode: o.address.postalCode ?? "",
            city: o.address.addressLocality ?? "",
          },
        }
      : {}),
  };
}

/**
 * A Deliverect order status as where the order stands (its order statuses page): 10 new, 20 accepted,
 * 30 a duplicate (ignored), 35 denied by the restaurant, 40 printed, 50 preparing, 60 prepared, 70 ready
 * for pickup, 80 in delivery, 90 finalized, 95 auto-finalized, 100 and 110 cancelled, 120 and above failed.
 */
export function deliverectState(status: number, reason?: string): PosOrderState | null {
  const why = reason ? { reason } : {};
  switch (status) {
    case 10:
      return { status: "pending" };
    case 20:
    case 40:
    case 95:
      return { status: "accepted" };
    case 30:
      return null;
    case 35:
      return { status: "rejected", ...why };
    case 50:
      return { status: "preparing" };
    case 60:
    case 70:
      return { status: "ready" };
    case 80:
      return { status: "out_for_delivery" };
    case 90:
      return { status: "completed" };
    case 100:
    case 110:
      return { status: "cancelled", ...why };
    default:
      return status >= 120 ? { status: "rejected", ...why } : null;
  }
}

export function deliverectConnector(partner: DeliverectPartner | null): ConnectorDefinition {
  const ready = Boolean(partner?.clientId && partner.clientSecret && /^[a-z0-9_-]{2,40}$/i.test(partner.channel));
  const p = partner as DeliverectPartner;
  const base = () => (p.staging ? DELIVERECT_STAGING_API : DELIVERECT_API);
  return {
    kind: "deliverect",
    title: "Deliverect",
    group: "pos",
    capabilities: ["orders_out", "status_in"],
    auth: "form",
    form: deliverectForm,
    ready: () => (ready ? true : DELIVERECT_NOT_READY),
    whenNotReady: {
      status: "setup",
      hint: DELIVERECT_NOT_READY,
      href: "https://surfingdog.ai/docs/ordering/#which-tills",
    },
    note: "Orders you accept here go to your till through Deliverect, and its word comes back.",
    action: "Connect Deliverect",

    async connect(ctx, input) {
      if (!ready) throw new ConnectorError("config", DELIVERECT_NOT_READY);
      const link = (input.channelLinkId ?? "").trim();
      if (!link) throw new ConnectorError("config", "Paste the channel link id.", { field: "channelLinkId" });
      // The client is checked once now: a channel that cannot get a token cannot take orders later.
      await clientToken(ctx, {
        tool: "Deliverect",
        url: `${base()}/oauth/token`,
        body: { grant_type: "client_credentials", client_id: p.clientId, client_secret: p.clientSecret },
      });
      const secret: Record<string, string> = {};
      if (input.hmacSecret?.trim()) secret.hmacSecret = input.hmacSecret.trim();
      return {
        account: `Deliverect channel link ${link.slice(-6)}`,
        externalId: link,
        secret,
        // Where Deliverect sends its order status updates: the connection's own address.
        extra: { channelLinkId: link, ...(ctx.hookUrl ? { hook_url: ctx.hookUrl } : {}) },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      };
    },

    orders: {
      async put(ctx, order) {
        const token = await clientToken(ctx, {
          tool: "Deliverect",
          url: `${base()}/oauth/token`,
          body: { grant_type: "client_credentials", client_id: p.clientId, client_secret: p.clientSecret },
        });
        const channelOrderId = await uuidFrom(ctx.marker, order.key);
        const link = String(ctx.extra.channelLinkId ?? "");
        const res = await ctx.http.request({
          method: "POST",
          url: `${base()}/${encodeURIComponent(p.channel)}/order/${encodeURIComponent(link)}`,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(deliverectOrderBody(order, channelOrderId, p.channel)),
        });
        failOn("Deliverect", res, "channelLinkId");
        if (res.status === 201 || res.status === 200) return { externalId: channelOrderId, status: "pending" };
        const why = short((jsonOf(res) as { message?: unknown; detail?: unknown } | null)?.message ?? "", 200);
        // The same channelOrderId again is the same order: Deliverect has it.
        if (res.status === 400 && /already|duplicate/i.test(why))
          return { externalId: channelOrderId, status: "pending" };
        if (res.status >= 400 && res.status < 500) {
          throw new ConnectorError(
            "refused",
            why ? `Deliverect would not take the order: ${why}` : "Deliverect would not take the order.",
          );
        }
        throw new ConnectorError("bad_response", `Deliverect answered ${res.status} to the order.`);
      },
      async find() {
        return null;
      },
      // Its word comes by its signed status update, not by asking.
      async status() {
        return null;
      },
    },

    hooks: {
      topics: ["order_status"],
      async verify(ctx, request): Promise<HookEvent | null> {
        // Before certification Deliverect signs with the channel link itself; after, with the secret.
        const secret = ctx.secret.hmacSecret || String(ctx.extra.channelLinkId ?? "");
        const ok = secret
          ? await verifyHexHmac(secret, request.body, request.headers.get("x-server-authorization-hmac-sha256"))
          : false;
        if (!ok) throw new ConnectorError("refused", "That is not Deliverect's signature for this connection.");
        let body: {
          channelOrderId?: unknown;
          status?: unknown;
          reason?: unknown;
          orderId?: unknown;
          timeStamp?: unknown;
        } = {};
        try {
          body = JSON.parse(request.body) as typeof body;
        } catch {
          return null;
        }
        const id = typeof body.channelOrderId === "string" ? body.channelOrderId.slice(0, 64) : "";
        const status = Number(body.status);
        if (!id || !Number.isInteger(status)) return null;
        // What is kept: the order's id here, its status code and when, as ids; never the body.
        const reason = short(body.reason, 120).replace(/[^A-Za-z0-9 .:-]/g, "");
        return {
          eventId: `${id}:${status}:${short(body.timeStamp, 40)}`.slice(0, 200),
          topic: "order_status",
          refs: [id, `status:${status}`, ...(reason ? [`reason:${reason.replace(/\s+/g, "_").slice(0, 100)}`] : [])],
        };
      },
      async read(_ctx, event) {
        const id = event.refs[0];
        const status = Number((event.refs.find((r) => r.startsWith("status:")) ?? "").slice(7));
        const reason = (event.refs.find((r) => r.startsWith("reason:")) ?? "").slice(7).replaceAll("_", " ");
        const state = id && Number.isInteger(status) ? deliverectState(status, reason || undefined) : null;
        return state && id ? [{ kind: "pos_order" as const, externalId: id, state }] : [];
      },
    },
  };
}
