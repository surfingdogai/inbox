import { ConnectorError, type RunContext } from "@surfingdog/core";
import type { Keys, Store } from "./api";

/**
 * What a WooCommerce connection keeps about itself (`extra`, not secret) and what is sealed
 * (`secret`): the store's address and how it is reached; the key pair the store made for this inbox,
 * and the secret its webhooks are signed with.
 */
export interface WooExtra {
  readonly store: string;
  readonly api: Store["api"];
  readonly auth: Store["auth"];
  /** The store's currency (`woocommerce_currency`), for the prices of its products. */
  readonly currency: string | null;
  /** Whether the store counts tax (`woocommerce_calc_taxes`). */
  readonly taxes: boolean;
  /** How it was connected: the store's Approve page (`authorize`), or keys pasted (`keys`). */
  readonly via: "authorize" | "keys";
  /** The id WooCommerce gave the key it made on its Approve page, for the owner to find it by. */
  readonly key_id?: number | undefined;
  /** `added`: this inbox's webhooks are in the store; `pending`: still to add (not live yet, or failed). */
  readonly webhook: "added" | "pending";
  /** The ids of this inbox's webhooks in the store, by topic. */
  readonly hooks: Readonly<Record<string, number>>;
  /** Where they deliver: this connection's own address when they were made. */
  readonly hook_url: string | null;
  /** When putting them right last failed, so a store that refuses is not asked on every sync. */
  readonly hook_failed_at?: number | undefined;
}

export function extraOf(ctx: Pick<RunContext, "extra">): WooExtra {
  const e = ctx.extra as Partial<WooExtra>;
  const hooks: Record<string, number> = {};
  for (const [topic, id] of Object.entries(e.hooks ?? {})) if (Number.isInteger(id)) hooks[topic] = Number(id);
  return {
    store: typeof e.store === "string" ? e.store : "",
    api: e.api === "query" ? "query" : "path",
    auth: e.auth === "query" ? "query" : "header",
    currency: typeof e.currency === "string" ? e.currency : null,
    taxes: e.taxes === true,
    via: e.via === "keys" ? "keys" : "authorize",
    ...(Number.isInteger(e.key_id) ? { key_id: Number(e.key_id) } : {}),
    webhook: e.webhook === "added" ? "added" : "pending",
    hooks,
    hook_url: typeof e.hook_url === "string" ? e.hook_url : null,
    ...(typeof e.hook_failed_at === "number" ? { hook_failed_at: e.hook_failed_at } : {}),
  };
}

export function storeOf(ctx: Pick<RunContext, "extra">): Store {
  const e = extraOf(ctx);
  if (!e.store)
    throw new ConnectorError("config", "This connection does not know its shop's address. Connect your shop again.");
  return { base: e.store, api: e.api, auth: e.auth };
}

export function keysOf(ctx: Pick<RunContext, "secret">): Keys {
  const key = ctx.secret.consumer_key ?? "";
  const secret = ctx.secret.consumer_secret ?? "";
  if (!key || !secret) throw new ConnectorError("config", "The shop's key is not there. Connect your shop again.");
  return { key, secret };
}

/**
 * The mark an order this inbox made carries (`_sdi_mark`), of this account's marker and the inbox's
 * own id for the link, and nobody else's: a second inbox connected to the same store, or anyone who
 * writes `_sdi_ref` on an order, never passes for this one.
 */
export async function markOf(ctx: Pick<RunContext, "marker">, ref: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ctx.marker}:woocommerce:${ref}`)),
  );
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url: a secret this inbox makes for its webhooks. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
