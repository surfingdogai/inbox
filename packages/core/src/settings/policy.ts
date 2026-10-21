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
  /**
   * The settings a host starts a new inbox with: written once, with the very first settings the
   * inbox stores (before it has any, on its first `prepare`), and the owner's from then on like any
   * other. Never written again, so an owner who changes one keeps their choice, and an inbox that
   * already had settings when its host began seeding is left as it was, unless whoever runs it
   * decides otherwise (`applyHostSeed`).
   */
  readonly seed?: SettingsPatch | undefined;
  /**
   * Whether platforms can reach the inbox's public doors at its address now (a payment platform's
   * webhook, `/v1/hooks/*`). A hosted inbox before it goes live answers only its owner: false until
   * then, so nothing is added on a platform that would fail. Absent is true.
   */
  readonly hooksLive?: boolean | undefined;
  /**
   * What the files customers send with their requests may take in all, in bytes (ADR-034 §2): a host
   * keeps each inbox to its share (500 MB for a hosted inbox, est.). Absent: no limit but the database's
   * own, which is a self-hosted inbox's to watch.
   */
  readonly attachmentsQuotaBytes?: number | undefined;
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
 * - Until the site links to it: every network held off, held out of every directory, and no
 *   website named, in the settings or in the profile's domain. Held, not switched off: each network
 *   remembers whether it was on (`resume`), and so does the listing, for when the hold ends.
 * - Once it does: the website is the site, and the profile's domain is its host; what was held comes
 *   back as it was, and the networks and the directories are the owner's to switch on and off.
 * - `joins`: the networks a new inbox starts switched on with, listed in their directories (`seed`):
 *   held until the site links to it, like any other, and on from the moment it does.
 */
export function hostPolicyFor(o: {
  readonly address: string;
  readonly site: string | null;
  /** The business's own domain, and the host's page where the owner connects the inbox to it. */
  readonly domain?: string | null | undefined;
  readonly connectUrl?: string | null | undefined;
  /** Networks a new inbox joins (https origins); none when absent. */
  readonly joins?: readonly string[] | undefined;
}): HostPolicy {
  const linked = o.site !== null;
  const joins = o.joins ?? [];
  return {
    ...(o.domain ? { home: { domain: o.domain, linked, connectUrl: o.connectUrl ?? null } } : {}),
    forced: (current) => ({
      notifications: { appUrl: o.address },
      integrations: { webhooks: { allowPrivateTargets: false } },
      identity: { extraAuthorities: [] },
      directory: { url: o.site ?? "", ...(linked ? releaseListing(current) : holdListing(current)) },
      ...(linked ? releaseNetworks(current) : holdNetworks(current)),
    }),
    locked: ["email", "notifications.ownerEmail", "security.contact", ...(linked ? [] : ["networks"])],
    profileDomain: o.site === null ? null : new URL(o.site).hostname.replace(/^www\./, ""),
    ...(joins.length ? { seed: joinPatch(joins) } : {}),
  };
}

/**
 * The patch that joins `origins` and is listed in their directories: what a host seeds a new inbox
 * with (held, like any network, while the host holds them). Listing, counts and receipts, and no
 * first-time customer's email: giving customers a key (`issue`) stays off until a person at the
 * business switches it on in Settings → Networks (the founder, 23 September 2026).
 */
export function joinPatch(origins: readonly string[]): SettingsPatch {
  return {
    networks: Object.fromEntries(origins.map((origin) => [origin, { enabled: true, issue: false }])),
    directory: { listed: true },
  };
}

/**
 * Whether the policy holds the networks now (a hosted inbox before the business's own site links to
 * it): each is held off, remembering in `resume` whether it comes back on.
 */
export function holdsNetworks(policy: HostPolicy | null | undefined, current: Settings): boolean {
  if (!policy) return false;
  return hostLockedPaths(policy, current).some((path) => path.length === 1 && path[0] === "networks");
}

/** What a write chooses while the host holds the networks (`holdChoices`). */
export interface HoldChoices {
  /** The rest of the write: checked against the host's lock as any write is. */
  readonly rest: Record<string, unknown>;
  /** What it chose, as a patch over the held settings: what comes back on, and less to share. */
  readonly choices: Record<string, unknown>;
  /** The `resume` paths `choices` sets, dotted: written by someone other than the host, on purpose. */
  readonly resumed: readonly string[];
  /** The ones it sets to true: a network, or the listing, to come back on. The owner's in person only. */
  readonly opened: readonly string[];
}

/**
 * While the host holds the networks, what a write may still choose (the founder: "the owner can
 * switch it off"), taken out of it so the host's lock does not refuse it:
 *
 * - for a held network, whether it comes back on when the hold ends, sent as `resume` or as
 *   `enabled` (it stays off meanwhile, so `enabled` can only mean that), kept as `resume`;
 * - for a held network, less to share with it: `issue`, `share.listing`, `share.counts` or
 *   `share.receipts` set to false;
 * - for the listing, whether it comes back, sent as `directory.resume` or `directory.listed`.
 *
 * Setting one to false is anyone's to do; to true, the owner's in person (`opened`), as switching a
 * network on is. Two values that disagree (`enabled: false` beside `resume: true`: a document sent
 * back as it was read) are left in `rest`, where sending them back unchanged changes nothing.
 * Everything else stays in `rest` for the lock: a network added, more shared, a hold removed.
 * `patch` is a prepared write (`prepareSettingsWrite`), so networks are keyed by canonical origin.
 */
export function holdChoices(current: Settings, patch: Record<string, unknown>): HoldChoices {
  const rest: Record<string, unknown> = { ...patch };
  const choices: Record<string, unknown> = {};
  const resumed: string[] = [];
  const opened: string[] = [];
  const wanted = (entry: Record<string, unknown>, keys: readonly string[]): boolean | undefined => {
    const said = keys.map((k) => entry[k]).filter((v) => v !== undefined);
    if (said.length === 0 || !said.every((v) => typeof v === "boolean" && v === said[0])) return undefined;
    return said[0] as boolean;
  };

  if (isPlainObject(patch.networks)) {
    const restNetworks: Record<string, unknown> = {};
    const chosen: Record<string, unknown> = {};
    for (const [origin, entry] of Object.entries(patch.networks)) {
      if (current.networks[origin]?.resume === undefined || !isPlainObject(entry)) {
        restNetworks[origin] = entry;
        continue;
      }
      const left: Record<string, unknown> = { ...entry };
      const pick: Record<string, unknown> = {};
      const back = wanted(entry, ["enabled", "resume"]);
      if (back !== undefined) {
        delete left.enabled;
        delete left.resume;
        pick.resume = back;
        resumed.push(`networks.${origin}.resume`);
        if (back) opened.push(`networks.${origin}.resume`);
      }
      if (entry.issue === false) {
        delete left.issue;
        pick.issue = false;
      }
      if (isPlainObject(entry.share)) {
        const share: Record<string, unknown> = { ...entry.share };
        const less: Record<string, unknown> = {};
        for (const key of ["listing", "counts", "receipts"]) {
          if (share[key] === false) {
            delete share[key];
            less[key] = false;
          }
        }
        if (Object.keys(less).length) pick.share = less;
        if (Object.keys(share).length) left.share = share;
        else delete left.share;
      }
      if (Object.keys(pick).length) chosen[origin] = pick;
      if (Object.keys(left).length) restNetworks[origin] = left;
    }
    if (Object.keys(restNetworks).length) rest.networks = restNetworks;
    else delete rest.networks;
    if (Object.keys(chosen).length) choices.networks = chosen;
  }

  if (isPlainObject(patch.directory) && current.directory.resume !== undefined) {
    const left: Record<string, unknown> = { ...patch.directory };
    const back = wanted(patch.directory, ["listed", "resume"]);
    if (back !== undefined) {
      delete left.listed;
      delete left.resume;
      choices.directory = { resume: back };
      resumed.push("directory.resume");
      if (back) opened.push("directory.resume");
    }
    if (Object.keys(left).length) rest.directory = left;
    else delete rest.directory;
  }
  return { rest, choices, resumed, opened };
}

/**
 * Every network held off, each remembering whether it is to come back on. On now means on when the
 * hold ends: nobody but the host can switch one on while it holds them (they are locked), so a
 * network on during a hold was switched on by the host itself (a seed). A network already held
 * keeps what it remembers.
 */
function holdNetworks(current: Settings): SettingsPatch {
  return {
    networks: Object.fromEntries(
      Object.entries(current.networks).map(([origin, entry]) => [
        origin,
        { enabled: false, resume: entry.enabled || entry.resume === true },
      ]),
    ),
  };
}

/** Each held network back as it was, and the hold gone. Nothing when none is held. */
function releaseNetworks(current: Settings): SettingsPatch {
  const held = Object.entries(current.networks).filter(([, entry]) => entry.resume !== undefined);
  if (held.length === 0) return {};
  return {
    networks: Object.fromEntries(held.map(([origin, entry]) => [origin, { enabled: entry.resume, resume: null }])),
  };
}

function holdListing(current: Settings): SettingsPatch {
  return { listed: false, resume: current.directory.listed || current.directory.resume === true };
}

function releaseListing(current: Settings): SettingsPatch {
  const resume = current.directory.resume;
  return resume === undefined ? {} : { listed: resume, resume: null };
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
  const seed = policy.seed;
  if (seed !== undefined) {
    if (!isPlainObject(seed)) throw new Error("host policy: seed is a settings patch, an object");
    const prepared = prepareSettingsWrite({}, { ...seed });
    if ("problems" in prepared) {
      throw new Error(
        `host policy: seed ${prepared.problems.map((p) => `${p.path.replace(/^doc\./, "")} ${p.message}`).join("; ")}`,
      );
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
