import { canonicalNetworkOrigin, networkOriginOfUrl } from "../util/hosts";
import type { FieldProblem } from "../write/errors";
import {
  DEFAULT_NETWORK,
  isPlainObject,
  legacyNetworks,
  NETWORK_KEY_RULE,
  parseStoredSettings,
  SETTINGS_KEYS,
} from "./schema";

/**
 * Gets a settings write ready to be merged over the stored document (ADR-017 §8.1):
 *
 * - a key that is not a setting is refused, so a typo is an error rather than a key stored forever;
 * - `networks` keys are canonical origins (`https://Network.Example.com/` becomes
 *   `https://network.example.com`), and anything that is not one is a field error;
 * - the legacy `network: {url, join}` — what older owner apps, scripts and assistants still send —
 *   becomes the same change to `networks` (`legacyChange`), and is never stored;
 * - when the stored document has no `networks` yet, the map it is read as (from the legacy pair,
 *   or the default) becomes the base, so adding a second network keeps the first.
 */
export function prepareSettingsWrite(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): { base: Record<string, unknown>; patch: Record<string, unknown> } | { problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const out: Record<string, unknown> = { ...patch };
  delete out.schemaVersion;
  for (const key of Object.keys(out)) {
    if (!SETTINGS_KEYS.has(key)) problems.push({ path: `doc.${key}`, problem: "invalid", message: "not a setting" });
  }

  if (out.network !== undefined) {
    const legacy = out.network;
    delete out.network;
    if (out.networks === undefined && isPlainObject(legacy)) {
      const change = legacyChange(stored, legacy);
      if (change === null) problems.push({ path: "doc.network.url", problem: "invalid", message: NETWORK_KEY_RULE });
      else out.networks = change;
    }
  }

  if (out.networks === null || (out.networks !== undefined && !isPlainObject(out.networks))) {
    // Removing the whole map would bring back what it replaced (the legacy pair, or the default).
    problems.push({
      path: "doc.networks",
      problem: "invalid",
      message: "send the networks to change, keyed by origin; switch one off with enabled: false",
    });
  } else if (isPlainObject(out.networks)) {
    const networks: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(out.networks)) {
      const origin = canonicalNetworkOrigin(key);
      if (!origin) {
        problems.push({ path: `doc.networks.${key}`, problem: "invalid", message: NETWORK_KEY_RULE });
      } else if (origin in networks) {
        problems.push({ path: `doc.networks.${key}`, problem: "invalid", message: `${origin} is named twice` });
      } else {
        networks[origin] = entry;
      }
    }
    out.networks = networks;
  }
  if (problems.length) return { problems };

  const base: Record<string, unknown> = { ...stored };
  if (out.networks !== undefined && base.networks === undefined) {
    base.networks = isPlainObject(stored.network) ? legacyNetworks(stored.network) : { [DEFAULT_NETWORK]: {} };
  }
  return { base, patch: out };
}

/**
 * The change to `networks` that a legacy `network: {url, join}` means. That pair describes the one
 * network an older client knows of: where the inbox reports, and whether it does. So it may only
 * ever share less than the client asked for, never more:
 *
 * - `join: false` is "leave the network": every network that is on is switched off, since the
 *   client cannot say which of several it means;
 * - a `url` other than the one the pair pointed at moves the one network there, as it always did
 *   ("point `network.url` at a directory you run yourself and none of it reaches us"): the new
 *   origin is on if `join` says so, or if the inbox was reporting anywhere, and every other
 *   network that is on is switched off;
 * - otherwise it is `join` for the network the pair points at, and nothing else moves.
 *
 * Null when the URL, sent or stored, is not a network origin.
 */
function legacyChange(
  stored: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> | null {
  const target = legacy.url === undefined ? undefined : networkOriginOfUrl(legacy.url);
  if (target === null) return null;
  const on = Object.entries(parseStoredSettings(stored).settings.networks)
    .filter(([, n]) => n.enabled)
    .map(([origin]) => origin);
  const off = (origins: readonly string[]) => Object.fromEntries(origins.map((o) => [o, { enabled: false }]));

  if (legacy.join === false) return { ...off(on), ...(target ? { [target]: { enabled: false } } : {}) };
  const pointer = isPlainObject(stored.network)
    ? stored.network.url === undefined
      ? DEFAULT_NETWORK
      : networkOriginOfUrl(stored.network.url)
    : DEFAULT_NETWORK;
  if (target === undefined || target === pointer) {
    // A stored URL that was never usable reported nowhere, and joining it still reports nowhere.
    const origin = target ?? pointer;
    return origin ? { [origin]: legacy.join === true ? { enabled: true } : {} } : null;
  }
  return {
    ...off(on.filter((o) => o !== target)),
    [target]: { enabled: legacy.join === true || (legacy.join === undefined && on.length > 0) },
  };
}

/**
 * Keeps a stored legacy pair telling the truth after a write, for the one reader that still reads
 * it: the previous version, should this one be rolled back. Without this, an owner who switched the
 * network off here would have the previous version, reading the stale `join: true`, start sending
 * again. The pair is never added, only kept, and `join` is true only while the network it points
 * at is on and gets everything the previous version would send it.
 */
export function syncLegacyPair(merged: Record<string, unknown>): void {
  if (!isPlainObject(merged.network) || !isPlainObject(merged.networks)) return;
  const url = merged.network.url;
  const origin = url === undefined ? DEFAULT_NETWORK : networkOriginOfUrl(url);
  const entry = origin ? parseStoredSettings(merged).settings.networks[origin] : undefined;
  const join = !!entry?.enabled && entry.share.listing && entry.share.counts && entry.share.receipts;
  merged.network = { ...merged.network, join };
}
