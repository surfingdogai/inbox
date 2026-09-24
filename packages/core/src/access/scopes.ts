import { z } from "zod";
import { isoDateTime } from "../domain/types";

/**
 * The scopes an owner-side principal can hold (ADR-004). An OAuth grant carries the ones the owner
 * consented to; an integration key carries the ones it was minted with; the owner in person holds
 * `*`. Every owner route and tool names the scopes that let a caller through (any one of them).
 *
 * Log first: in this release a call outside its scopes goes through and is recorded, per key or AI
 * app, for the owner to see under Settings → Keys. `security.enforceScopes` turns the refusal on;
 * a later release turns it on for everyone.
 */
export const SCOPES = {
  "inbox:read": "read items and conversations",
  "inbox:write": "confirm, propose, decline and reply on items",
  "events:read": "read the event stream",
  "catalogue:write": "change services and products",
  "availability:write": "change opening hours and closed days",
  "settings:read": "read settings and setup",
  "settings:write": "change settings and the business profile",
  "setup:run": "add, change and apply rules",
  "integrations:write": "add, change and test webhooks and product feeds",
  "keys:write": "create and revoke integration keys",
  "customers:erase": "erase one customer's personal data (it cannot be undone)",
  offline_access: "stay connected without asking again",
} as const;

export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];

/**
 * What a key minted in the product may carry: every scope but minting keys (an integration key
 * never mints keys) and staying signed in (a key does not expire by itself; that is OAuth's word).
 */
export const KEY_SCOPES = SCOPE_NAMES.filter((s) => s !== "keys:write" && s !== "offline_access") as [
  Scope,
  ...Scope[],
];

/**
 * Scopes an AI app cannot be granted by OAuth: erasing a customer is never the owner's AI's to do
 * (Tiago, 23 September 2026), so it is not offered to one.
 */
export const NOT_FOR_AI_SCOPES: readonly Scope[] = ["customers:erase"];

/**
 * Ready-made scope sets, one per kind of system a key is pasted into. None includes
 * `settings:write` or `keys:write`: a key in Zapier or a shop's admin cannot reconfigure the inbox.
 */
export const KEY_PRESETS = [
  {
    key: "automation",
    name: "Automation tool",
    description: "Zapier, Make, n8n: read items and events, and move items along.",
    scopes: ["inbox:read", "inbox:write", "events:read"],
  },
  {
    key: "shop_sync",
    name: "Shop or till sync",
    description: "Keep products in step with a shop or a point of sale, and follow orders.",
    scopes: ["catalogue:write", "inbox:read", "inbox:write", "events:read"],
  },
  {
    key: "calendar_sync",
    name: "Calendar or booking sync",
    description: "Keep opening hours and closed days in step, and follow bookings.",
    scopes: ["availability:write", "inbox:read", "inbox:write", "events:read"],
  },
  {
    key: "read_only",
    name: "Read only",
    description: "Reports and dashboards: read items, events and setup, change nothing.",
    scopes: ["inbox:read", "events:read", "settings:read"],
  },
] as const satisfies readonly { key: string; name: string; description: string; scopes: readonly Scope[] }[];

export type KeyPresetKey = (typeof KEY_PRESETS)[number]["key"];
const PRESET_KEYS = KEY_PRESETS.map((p) => p.key) as [KeyPresetKey, ...KeyPresetKey[]];

export function holdsScope(held: readonly string[], anyOf: readonly string[]): boolean {
  return held.includes("*") || anyOf.some((s) => held.includes(s));
}

export const createApiKeyInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('What the key is for, as the owner will recognise it: the system it goes into, e.g. "Zapier".'),
  preset: z
    .enum(PRESET_KEYS)
    .optional()
    .describe(
      "A ready-made scope set: automation, shop_sync, calendar_sync or read_only. Give this or scopes (or both: they add up).",
    ),
  scopes: z
    .array(z.enum(KEY_SCOPES))
    .max(KEY_SCOPES.length)
    .optional()
    .describe("The scopes, as narrow as the system needs. Never keys:write."),
  expires_at: isoDateTime.optional().describe("When the key stops working. Omit for a key that works until revoked."),
});

export const revokeApiKeyInput = z.object({
  key_id: z.string().min(1).describe("The id from list_api_keys."),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeyInput>;
