import { WriteError } from "../write/errors";
import { changedSettings } from "./guard";
import { mergeSettings, patchPaths } from "./merge";
import { prepareSettingsWrite } from "./patch";
import { isPlainObject, parseStoredSettings, SETTINGS_KEYS, type Settings } from "./schema";

/**
 * A host's policy: the settings whoever runs the inbox sets for it, and the ones nobody changes
 * through it. It is passed to `createInbox({ policy })`; an inbox built without one has none, and
 * every setting is the owner's, as before.
 *
 * - `forced` is a settings patch, laid over the stored document the way a write is
 *   (`settings/merge.ts`): written before the inbox serves, and again whenever the inbox is
 *   prepared. A function is asked with the settings as they stand, for a patch that depends on them
 *   (every network switched off, whichever ones the owner added). What it sets is locked.
 * - `locked` names settings by dotted path: `email` is the whole section, `notifications.appUrl`
 *   one key. A network's origin has dots in it, so `networks` is locked whole or not at all.
 *
 * Nobody changes a locked setting through `updateSettings`: not the owner in person, not a key with
 * `settings:write`, not the owner's AI and not the inbox's own writes as the system (a setup plan,
 * the address the owner's sign-in remembers). Each is told the setting is set by their host. A write
 * that sends a locked setting back as it is changes nothing and is never refused.
 */
export interface HostPolicy {
  readonly forced?: SettingsPatch | ((current: Settings) => SettingsPatch) | undefined;
  readonly locked?: readonly string[] | undefined;
  /**
   * The domain the business's profile names (`PUT /profile`; `GET /v1/business` and the profile tool
   * publish it), when the host holds it: written over the profile as the forced settings are, and
   * nobody changes it here. `null` names none. Absent, the profile's domain is the owner's.
   */
  readonly profileDomain?: string | null | undefined;
  /**
   * Where the business joined from, when a host set the inbox up for it: its own domain, whether
   * that site links to the inbox yet, and the host's page where the owner connects the two. Shown to
   * the owner in Settings; never published.
   */
  readonly home?: HostHome | undefined;
}

/** The business's own site as its host knows it (`HostPolicy.home`). */
export interface HostHome {
  readonly domain: string;
  readonly linked: boolean;
  readonly connectUrl: string | null;
}

/** A settings write's document: sections and keys to set, `null` to remove one. */
export type SettingsPatch = Readonly<Record<string, unknown>>;

/** What a refused write says of each locked setting it would change. */
export const SET_BY_HOST = "set by your host";

/**
 * The policy for an inbox someone runs for a business, at an address they gave it (`address`), as
 * far as the business's own site vouches for it (`site`: the site, once it links to the inbox).
 *
 * - Always held: who its email is from and where replies go (`email`; the transport pins the sender
 *   as well), the address every link points at, calls to private addresses (off), more hosts an
 *   agent's signature may name (none), where security reports go, and the owner's address, which
 *   changes only through the owner's own confirmed change, never a settings write.
 * - Until the site links to it: every network off, out of every directory, and no website named,
 *   in the settings or in the profile's domain.
 * - Once it does: the website is the site, and the profile's domain is its host; the networks and
 *   the directories stay as they were, and are the owner's to switch on.
 */
export function hostPolicyFor(o: {
  readonly address: string;
  readonly site: string | null;
  /** The business's own domain, and the host's page where the owner connects the inbox to it. */
  readonly domain?: string | null | undefined;
  readonly connectUrl?: string | null | undefined;
}): HostPolicy {
  const linked = o.site !== null;
  return {
    ...(o.domain ? { home: { domain: o.domain, linked, connectUrl: o.connectUrl ?? null } } : {}),
    forced: (current) => ({
      notifications: { appUrl: o.address },
      integrations: { webhooks: { allowPrivateTargets: false } },
      identity: { extraAuthorities: [] },
      directory: { url: o.site ?? "", ...(linked ? {} : { listed: false }) },
      ...(linked
        ? {}
        : {
            networks: Object.fromEntries(Object.keys(current.networks).map((origin) => [origin, { enabled: false }])),
          }),
    }),
    locked: ["email", "notifications.ownerEmail", "security.contact", ...(linked ? [] : ["networks"])],
    profileDomain: o.site === null ? null : new URL(o.site).hostname.replace(/^www\./, ""),
  };
}

/**
 * Throws when the policy names something that is not a setting, so a typo never locks nothing. Run
 * once, when the inbox is built.
 */
export function checkHostPolicy(policy: HostPolicy): void {
  for (const path of policy.locked ?? []) {
    const parts = path.split(".");
    if (parts.some((p) => p.length === 0) || !SETTINGS_KEYS.has(parts[0] ?? "")) {
      throw new Error(`host policy: "${path}" is not a setting`);
    }
  }
  const domain = policy.profileDomain;
  if (typeof domain === "string" && !/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(domain)) {
    throw new Error(`host policy: profileDomain "${domain}" is not a lower-case hostname`);
  }
  const forced = policy.forced;
  if (forced !== undefined && typeof forced !== "function") {
    if (!isPlainObject(forced)) throw new Error("host policy: forced is a settings patch, an object");
    for (const key of Object.keys(forced)) {
      if (!SETTINGS_KEYS.has(key)) throw new Error(`host policy: "${key}" is not a setting`);
    }
  }
}

/** The patch the policy forces over `current`, keyed as a write would store it; empty when it forces nothing. */
export function forcedPatch(policy: HostPolicy, current: Settings): Record<string, unknown> {
  const forced = typeof policy.forced === "function" ? policy.forced(current) : policy.forced;
  if (!isPlainObject(forced) || Object.keys(forced).length === 0) return {};
  // Through the same preparation as any write, so a network is named by its canonical origin.
  const prepared = prepareSettingsWrite({}, { ...forced });
  if ("problems" in prepared) {
    throw new Error(
      `host policy: forced ${prepared.problems.map((p) => `${p.path.replace(/^doc\./, "")} ${p.message}`).join("; ")}`,
    );
  }
  return prepared.patch;
}

/** Every setting the policy holds, as paths: what it locks by name, and what it forces over `current`. */
export function hostLockedPaths(policy: HostPolicy, current: Settings): string[][] {
  const forced = forcedPatch(policy, current);
  return [
    ...(policy.locked ?? []).map((path) => path.split(".")),
    ...(Object.keys(forced).length ? patchPaths(forced) : []),
  ];
}

/** Whether the policy holds `path`, or a setting inside it, or the section it sits in. */
export function hostLocks(policy: HostPolicy, current: Settings, path: readonly string[]): boolean {
  return hostLockedPaths(policy, current).some((held) => {
    const n = Math.min(held.length, path.length);
    return held.slice(0, n).every((part, i) => part === path[i]);
  });
}

/**
 * The settings the policy holds that a write of `doc` over `stored` would change, dotted. Empty when
 * it changes none, and when the write is refused for something else first (a key that is not a
 * setting), since then nothing is written either.
 */
export function hostLockedChanges(
  policy: HostPolicy,
  stored: Record<string, unknown>,
  doc: Record<string, unknown>,
): string[] {
  const prepared = prepareSettingsWrite(stored, doc);
  if ("problems" in prepared) return [];
  const before = parseStoredSettings(stored).settings;
  const after = parseStoredSettings(mergeSettings(prepared.base, prepared.patch)).settings;
  // A forced patch that depends on the settings is asked about both: what it would set over the
  // write is held too (a network the write adds, which a patch switching every network off covers).
  const held = [...hostLockedPaths(policy, before), ...hostLockedPaths(policy, after)];
  const unique = [...new Map(held.map((path) => [JSON.stringify(path), path])).values()];
  return changedSettings(
    before,
    after,
    unique.map((path) => ({ path })),
  );
}

/**
 * The refusal for a write that would change what the host holds. It says nobody can change it
 * here, the owner included, so neither the owner nor their AI looks for another way round.
 */
export function hostLockedError(paths: readonly string[]): WriteError {
  const unique = [...new Set(paths)];
  return new WriteError(
    "not_allowed",
    `${unique.join(", ")} ${unique.length === 1 ? "is" : "are"} ${SET_BY_HOST}: nobody can change ${unique.length === 1 ? "it" : "them"} here, the owner included. Nothing was changed.`,
    {
      details: { reason: "set_by_host" },
      fields: unique.map((path) => ({ path: `doc.${path}`, problem: "invalid" as const, message: SET_BY_HOST })),
    },
  );
}
