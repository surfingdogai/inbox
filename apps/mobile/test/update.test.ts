import { describe, expect, it } from "vitest";
import { ANDROID_APP_URL, ANDROID_LATEST_URL } from "../../../packages/core/src/phones/links";
import type { KV } from "../src/lib/offline";
import { CHECK_EVERY_MS, checkForUpdate, readLatest, updateState, versionLine } from "../src/lib/update";

/**
 * "A new version is ready" (ADR-028): an app installed from its download page learns of the next
 * release from one file, read at most twice a day, and opens the download page for it.
 */
const SHA = "a".repeat(64);
const release = (over: Record<string, unknown> = {}) => ({
  versionCode: 10001,
  versionName: "1.0.1",
  minSupported: 1,
  url: "https://github.com/surfingdogai/inbox/releases/download/android-v1.0.1/surfingdog-inbox-1.0.1.apk",
  sha256: SHA,
  size: 1_600_000,
  certSha256: "98:94",
  ...over,
});

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

function served(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("the release file", () => {
  it("is read only when it names a release whose APK is out", () => {
    expect(readLatest(release())).toEqual({ versionCode: 10001, versionName: "1.0.1", minSupported: 1 });
    expect(readLatest(release({ sha256: null }))).toBeNull();
    expect(readLatest(release({ sha256: "ABC" }))).toBeNull();
    expect(readLatest(release({ versionCode: 18 }))).toBeNull();
    expect(readLatest(release({ versionCode: "10001" }))).toBeNull();
    expect(readLatest(release({ versionName: "1.0" }))).toBeNull();
    expect(readLatest(release({ minSupported: 0 }))).toBeNull();
    expect(readLatest(release({ minSupported: undefined }))?.minSupported).toBe(1);
    expect(readLatest(null)).toBeNull();
    expect(readLatest([release()])).toBeNull();
  });

  it("says a new version is ready, or that one is needed, and always opens the download page", () => {
    const latest = readLatest(release());
    expect(updateState(10000, latest)).toEqual({ kind: "ready", versionName: "1.0.1", page: ANDROID_APP_URL });
    expect(updateState(10001, latest)).toEqual({ kind: "none" });
    expect(updateState(10002, latest)).toEqual({ kind: "none" });
    expect(updateState(10000, readLatest(release({ minSupported: 10001 })))?.kind).toBe("required");
    // A test build is signed with another key: a release can't install over it, so it never offers one.
    expect(updateState(23, latest)).toEqual({ kind: "none" });
    expect(updateState(10000, null)).toEqual({ kind: "none" });
  });
});

describe("checking for an update", () => {
  it("reads the file at most twice a day, and keeps what it said", async () => {
    const kv = memory();
    const s = served(release());
    const t0 = 1_800_000_000_000;
    expect((await checkForUpdate(s.fetch, kv, 10000, t0)).kind).toBe("ready");
    expect(s.calls).toEqual([ANDROID_LATEST_URL]);
    expect((await checkForUpdate(s.fetch, kv, 10000, t0 + 60_000)).kind).toBe("ready");
    expect(s.calls).toHaveLength(1);
    await checkForUpdate(s.fetch, kv, 10000, t0 + CHECK_EVERY_MS);
    expect(s.calls).toHaveLength(2);
    // A clock set back reads again rather than trusting a time to come.
    await checkForUpdate(s.fetch, kv, 10000, t0);
    expect(s.calls).toHaveLength(3);
  });

  it("offline, what was read last stands; nothing read, nothing shown", async () => {
    const kv = memory();
    const t0 = 1_800_000_000_000;
    const down = async () => {
      throw new TypeError("offline");
    };
    expect(await checkForUpdate(down, kv, 10000, t0)).toEqual({ kind: "none" });
    await checkForUpdate(served(release()).fetch, kv, 10000, t0);
    expect((await checkForUpdate(down, kv, 10000, t0 + CHECK_EVERY_MS)).kind).toBe("ready");
  });

  it("before the first release is out, and on a refusal, says nothing", async () => {
    const t0 = 1_800_000_000_000;
    expect(await checkForUpdate(served(release({ sha256: null })).fetch, memory(), 10000, t0)).toEqual({
      kind: "none",
    });
    expect(await checkForUpdate(served({ error: "gone" }, 404).fetch, memory(), 10000, t0)).toEqual({ kind: "none" });
  });

  it("a test build never asks", async () => {
    const s = served(release());
    expect(await checkForUpdate(s.fetch, memory(), 23)).toEqual({ kind: "none" });
    expect(s.calls).toHaveLength(0);
    expect(versionLine("0.1.23", 23)).toBe("0.1.23 · test build");
    expect(versionLine("1.0.0", 10000)).toBe("1.0.0");
  });
});
