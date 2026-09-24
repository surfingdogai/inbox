import type { Settings } from "./schema";

/**
 * The settings that decide where this inbox sends what it holds, and the ones that decide who is
 * trusted: what the owner's AI may not change (`access/outbound.ts`), found by comparing the
 * settings as they were with the settings a write would leave, so a document written back as it
 * was read changes nothing and is never refused.
 */

/** A path into the settings, and when a change there counts: any change, or only switching it on. */
interface Watched {
  readonly path: readonly string[];
  readonly on?: "any" | "switched_on";
}

/**
 * Where email, alerts and events go. The owner in person, or a key the owner minted with
 * `settings:write`, may change these; the owner's AI may not.
 *
 * - `notifications.ownerEmail`: where every alert about a new request goes, with the customer's
 *   name in it; it is also an address that may sign in to the owner app the first time.
 * - `notifications.appUrl`: the address every link in every email points at.
 * - `email.*` sender and reply-to: where customers' answers go, and whose name they see.
 * - Webhooks switched back on, and test mode switched on: the first sends every event to the
 *   endpoints again, the second silently stops every email to customers and to the owner.
 */
export const DATA_OUT_SETTINGS: readonly Watched[] = [
  { path: ["notifications", "ownerEmail"] },
  { path: ["notifications", "appUrl"] },
  { path: ["email", "fromAddress"] },
  { path: ["email", "fromName"] },
  { path: ["email", "replyTo"] },
  { path: ["integrations", "webhooks", "enabled"], on: "switched_on" },
  { path: ["testMode"], on: "switched_on" },
];

/**
 * Who is trusted, which only the owner in person changes — never the AI and never a key:
 * the secret the inbound mail webhook is let in by, calling private addresses (SSRF), the hosts an
 * agent's signature may name, and how hard a customer's one-time code is to guess. (`security`
 * itself, and switching a network on, have checks of their own in `updateSettings`.)
 */
export const OWNER_ONLY_SETTINGS: readonly Watched[] = [
  { path: ["email", "inboundSecret"] },
  { path: ["integrations", "webhooks", "allowPrivateTargets"] },
  { path: ["identity", "extraAuthorities"] },
  { path: ["customers", "otp"] },
];

function at(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** The watched paths a write changes, dotted (`notifications.ownerEmail`). */
export function changedSettings(before: Settings, after: Settings, watched: readonly Watched[]): string[] {
  const out: string[] = [];
  for (const w of watched) {
    const was = at(before, w.path);
    const now = at(after, w.path);
    const changed = w.on === "switched_on" ? now === true && was !== true : JSON.stringify(was) !== JSON.stringify(now);
    if (changed) out.push(w.path.join("."));
  }
  return out;
}

/**
 * Networks a write opens: switched on, allowed to issue keys, or given something more to share
 * (listing, counts, receipts). Each is sent something about this inbox's customers once it is.
 */
export function openedNetworks(before: Settings, after: Settings): string[] {
  const out: string[] = [];
  for (const [origin, entry] of Object.entries(after.networks)) {
    if (!entry.enabled) continue;
    const was = before.networks[origin];
    if (!was?.enabled) {
      out.push(`networks.${origin}.enabled`);
      continue;
    }
    if (entry.issue && !was.issue) out.push(`networks.${origin}.issue`);
    for (const share of ["listing", "counts", "receipts"] as const) {
      if (entry.share[share] && !was.share[share]) out.push(`networks.${origin}.share.${share}`);
    }
  }
  return out;
}
