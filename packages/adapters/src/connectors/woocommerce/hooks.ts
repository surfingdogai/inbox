import {
  ConnectorError,
  type HookEvent,
  type HookFact,
  type HooksHandler,
  type InboundRequest,
  type RunContext,
} from "@surfingdog/core";
import { verifyBase64Hmac } from "../hook-sign";
import { call, metaOf } from "./api";
import { factsOf } from "./orders";
import { extraOf, keysOf, markOf, randomSecret, storeOf, type WooExtra } from "./state";

/**
 * The store's webhooks, at the connection's own address (ADR-030 §4, ADR-032 §5). WooCommerce signs
 * each delivery with `X-WC-Webhook-Signature`: the base64 HMAC-SHA-256 of the body under the
 * webhook's secret, and names it in `X-WC-Webhook-Topic`, `-ID` and `-Delivery-ID`. The delivery id is
 * no event's own: WooCommerce makes it of the webhook's id and the second it is sent
 * (`get_new_delivery_id`: `wp_hash($id . strtotime('now'))`), so every delivery of a webhook within one
 * second shares it (a batch the scheduler sends, a bulk edit in wp-admin). An event is known by its
 * webhook and its signed body instead: a delivery sent again is the same event, and two orders, or two
 * changes to one, are two. When a webhook is
 * made it pings its address once, unsigned, with the form body `webhook_id=<id>`; that is answered
 * 200 and nothing else. A webhook whose deliveries keep failing is switched off by the store (after
 * more than five in a row); every few hours this inbox switches its own back on.
 *
 * Only ids are kept, never a body: WooCommerce sends the whole order, the customer's details with
 * it. And nothing a body says is believed: what an event names is read back with the key. An order
 * the inbox did not make (the shop's own checkout) is let go unkept, by the body's own signed
 * `_sdi_ref` and mark: the inbox copies no order it did not make (ADR-030, not now).
 *
 * https://woocommerce.com/document/webhooks/,
 * https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-webhook.php,
 * https://woocommerce.github.io/woocommerce-rest-api-docs/#webhooks.
 */

/** What the inbox asks the store for: one webhook each. An order made here is read back on each sync too. */
export const WOO_TOPICS: readonly string[] = ["order.updated", "product.updated", "product.deleted"];

/** Retried no sooner than this when the store would not take this inbox's webhooks. */
const RETRY_HOOKS_MS = 15 * 60_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verify(ctx: RunContext, request: InboundRequest): Promise<HookEvent | null> {
  const signature = request.headers.get("x-wc-webhook-signature");
  if (signature === null) {
    // The ping a webhook sends when it is made: unsigned, and naming nothing.
    if (/^webhook_id=\d{1,20}$/.test(request.body.trim())) return null;
    throw new ConnectorError("refused", "The request is not signed.");
  }
  if (!(await verifyBase64Hmac(ctx.secret.hook_secret ?? "", request.body, signature))) {
    throw new ConnectorError("refused", "The signature does not check out.");
  }
  const topic = (request.headers.get("x-wc-webhook-topic") ?? "").trim().toLowerCase();
  if (!WOO_TOPICS.includes(topic)) return null;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(request.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Number.isInteger(body.id)) return null;
  const id = String(body.id);
  let refs: string[];
  if (topic.startsWith("order.")) {
    const ref = metaOf(body, "_sdi_ref");
    // An order the shop took itself, at its own checkout: not this inbox's to keep.
    if (Array.isArray(body.meta_data) && !ref) return null;
    if (ref && metaOf(body, "_sdi_mark") !== (await markOf(ctx, ref))) return null;
    refs = [id];
  } else {
    const parent = Number.isInteger(body.parent_id) && Number(body.parent_id) > 0 ? String(body.parent_id) : null;
    refs = parent ? [`v:${id}`, `p:${parent}`] : [`p:${id}`];
  }
  const hook = (request.headers.get("x-wc-webhook-id") ?? "").trim();
  const eventId = `${/^\d{1,20}$/.test(hook) ? hook : "0"}:${(await sha256Hex(request.body)).slice(0, 40)}`;
  return { eventId, topic, refs };
}

async function read(ctx: RunContext, event: HookEvent): Promise<readonly HookFact[]> {
  if (event.topic.startsWith("product.")) return [{ kind: "catalogue", externalIds: event.refs }];
  const out: HookFact[] = [];
  for (const ref of event.refs) out.push(...(await factsOf(ctx, ref)));
  return out;
}

export const hooks: HooksHandler = { topics: WOO_TOPICS, verify, read };

/** The name a webhook of this inbox carries in the store's list: which inbox, and what it is for. */
function hookName(host: string, topic: string): string {
  return `Agent inbox (${host}) · ${topic}`;
}

/**
 * This inbox's webhooks, as they should be: one per topic, at the connection's own address, switched
 * on, signed with the secret this inbox keeps. Made where missing (connected before the inbox was
 * live, or removed in the store), moved where the address changed (the inbox went to its own domain),
 * switched back on where the store switched one off. A webhook of this inbox's own that the connection
 * no longer knows by id (the store approved again, and the connection began anew) is taken over by its
 * name or address rather than made again, and any second one of a topic is removed, so the store sends
 * each change once and never to an address that is gone. Answers what the connection keeps of them;
 * null when the inbox cannot be reached yet.
 */
export async function keepWebhooks(ctx: RunContext): Promise<Pick<WooExtra, "webhook" | "hooks" | "hook_url"> | null> {
  if (!ctx.hookUrl || ctx.hooksLive === false) return null;
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  const extra = extraOf(ctx);
  let secret = ctx.secret.hook_secret ?? "";
  const fresh = !secret;
  if (fresh) {
    // Kept before the store is told it: no webhook is ever signed with a secret this inbox lost.
    secret = randomSecret();
    await ctx.saveSecret({ ...ctx.secret, hook_secret: secret });
  }
  const listed = await call(ctx.http, store, keys, "GET", "/wc/v3/webhooks", {
    query: { per_page: 100, search: "Agent inbox", _fields: "id,name,status,topic,delivery_url" },
  });
  const there = (Array.isArray(listed.json) ? (listed.json as Record<string, unknown>[]) : []).filter((w) =>
    Number.isInteger(w?.id),
  );
  // This inbox's own, whatever the connection kept: its name in the store's list, or its address here.
  const prefix = `${ctx.inbox.origin.replace(/\/+$/, "")}/v1/hooks/woocommerce/`;
  const own = (w: Record<string, unknown>) =>
    w.name === hookName(ctx.inbox.host, String(w.topic)) ||
    (typeof w.delivery_url === "string" && w.delivery_url.startsWith(prefix));
  const hooks: Record<string, number> = {};
  for (const topic of WOO_TOPICS) {
    const ofTopic = there.filter((w) => w.topic === topic);
    const found =
      ofTopic.find((w) => w.id === extra.hooks[topic]) ??
      ofTopic.find((w) => w.delivery_url === ctx.hookUrl) ??
      ofTopic.find(own);
    for (const other of ofTopic) {
      if (other === found || !own(other)) continue;
      try {
        await call(ctx.http, store, keys, "DELETE", `/wc/v3/webhooks/${String(other.id)}`, {
          query: { force: "true", _fields: "id" },
        });
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "not_found") throw error;
      }
    }
    if (found) {
      const id = Number(found.id);
      // Moved, switched off, or not signed with the secret this inbox keeps (a new secret, or one made
      // by an earlier connection of this inbox): put right in place.
      if (found.delivery_url !== ctx.hookUrl || found.status !== "active" || fresh || id !== extra.hooks[topic]) {
        await call(ctx.http, store, keys, "PUT", `/wc/v3/webhooks/${id}`, {
          query: { _fields: "id" },
          body: { delivery_url: ctx.hookUrl, status: "active", secret, name: hookName(ctx.inbox.host, topic) },
        });
      }
      hooks[topic] = id;
      continue;
    }
    const made = await call(ctx.http, store, keys, "POST", "/wc/v3/webhooks", {
      query: { _fields: "id" },
      body: { name: hookName(ctx.inbox.host, topic), topic, delivery_url: ctx.hookUrl, secret, status: "active" },
    });
    const id = (made.json as { id?: unknown } | null)?.id;
    if (!Number.isInteger(id))
      throw new ConnectorError("bad_response", "Your shop made a webhook but did not say which.");
    hooks[topic] = Number(id);
  }
  return { webhook: "added", hooks, hook_url: ctx.hookUrl };
}

/** Whether the webhooks want looking at now: still to make, or made for an address the inbox has left. */
export function hooksStale(ctx: RunContext): boolean {
  if (!ctx.hookUrl || ctx.hooksLive === false) return false;
  const e = extraOf(ctx);
  if (e.webhook === "added" && e.hook_url === ctx.hookUrl) return false;
  return e.hook_failed_at === undefined || ctx.now - e.hook_failed_at >= RETRY_HOOKS_MS;
}

/** Takes this inbox's webhooks out of the store, as the connection goes. One already gone is gone. */
export async function removeWebhooks(ctx: RunContext): Promise<void> {
  const store = storeOf(ctx);
  const keys = keysOf(ctx);
  for (const id of Object.values(extraOf(ctx).hooks)) {
    try {
      await call(ctx.http, store, keys, "DELETE", `/wc/v3/webhooks/${id}`, { query: { force: "true", _fields: "id" } });
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "not_found") throw error;
    }
  }
}
