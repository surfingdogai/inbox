import { ANDROID_APP_URL, ANDROID_LATEST_URL } from "../../../../packages/core/src/phones/links";
import type { KV } from "./offline";
import type { Fetch } from "./session";

/**
 * Updates for an app installed from its download page, not from a store (ADR-028). The app reads one
 * small file Surfing Dog publishes with that page, at most twice a day, and says quietly when a newer
 * version is ready. It installs nothing itself (no REQUEST_INSTALL_PACKAGES): the line opens the
 * download page in the browser, and Android installs the new APK over this one, connections and all,
 * because both carry the same signature.
 */

/**
 * A release's versionCode is major × 10000 + minor × 100 + patch, so 1.0.0 is 10000. Test builds are
 * numbered by their CI run, below it, and signed with another key: they can't install a release over
 * themselves, so they never hear of one.
 */
export const RELEASE_CODE_FLOOR = 10_000;
export const CHECK_EVERY_MS = 12 * 3_600_000;
const KEY = "sdi.update";

export interface Latest {
  readonly versionCode: number;
  readonly versionName: string;
  /** The oldest version the inbox still works with: below it, the line asks for the update. */
  readonly minSupported: number;
}

export type UpdateState =
  | { readonly kind: "none" }
  | { readonly kind: "ready" | "required"; readonly versionName: string; readonly page: string };

export const NO_UPDATE: UpdateState = { kind: "none" };

/** The release file as published, or null when it isn't one (or its APK isn't out yet). */
export function readLatest(value: unknown): Latest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const code = v.versionCode;
  const name = v.versionName;
  const min = v.minSupported ?? 1;
  if (typeof code !== "number" || !Number.isSafeInteger(code) || code < RELEASE_CODE_FLOOR) return null;
  if (typeof name !== "string" || !/^\d{1,6}\.\d{1,2}\.\d{1,2}$/.test(name)) return null;
  if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 1) return null;
  // A release is out once its APK has a SHA-256: until then there is nothing to get.
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
  return { versionCode: code, versionName: name, minSupported: min };
}

/** What this build should say, given the newest release. */
export function updateState(build: number, latest: Latest | null): UpdateState {
  if (!latest || !ANDROID_APP_URL || build < RELEASE_CODE_FLOOR) return NO_UPDATE;
  if (build < latest.minSupported) return { kind: "required", versionName: latest.versionName, page: ANDROID_APP_URL };
  if (latest.versionCode > build) return { kind: "ready", versionName: latest.versionName, page: ANDROID_APP_URL };
  return NO_UPDATE;
}

interface Kept {
  readonly at: number;
  readonly latest: unknown;
}

function kept(kv: KV): Kept | null {
  try {
    const k = JSON.parse(kv.getItem(KEY) ?? "null") as Kept | null;
    return k && typeof k.at === "number" ? k : null;
  } catch {
    return null;
  }
}

/**
 * Reads the release file when the last read is over twelve hours old (or from the future), and keeps
 * what it said, so a start or a return to the app costs nothing most of the time. Offline, what was read
 * last stands; nothing is ever shown about a release the phone could not read.
 */
export async function checkForUpdate(fetch: Fetch, kv: KV, build: number, now = Date.now()): Promise<UpdateState> {
  if (build < RELEASE_CODE_FLOOR) return NO_UPDATE;
  const last = kept(kv);
  let latest = last ? readLatest(last.latest) : null;
  if (!last || now - last.at >= CHECK_EVERY_MS || now < last.at) {
    try {
      const res = await fetch(ANDROID_LATEST_URL, { headers: { accept: "application/json" } });
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      latest = readLatest(body);
      kv.setItem(KEY, JSON.stringify({ at: now, latest: body } satisfies Kept));
    } catch {
      // Not reachable now: try again next time.
    }
  }
  return updateState(build, latest);
}

/** "1.0.0", or "0.1.23 · test build" for a build from CI that is not a release. */
export function versionLine(version: string, build: number): string {
  return build > 0 && build < RELEASE_CODE_FLOOR ? `${version} · test build` : version;
}
