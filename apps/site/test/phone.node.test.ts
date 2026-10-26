import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANDROID_APP_URL, ANDROID_LATEST_URL } from "../../../packages/core/src/phones/links";
import { readLatest } from "../../mobile/src/lib/update";

/**
 * The phone app's download page (/phone) and the release file beside it (/phone/latest.json), which the
 * inbox and the app both point at: one certificate everywhere, a release address the workflow
 * android-release really makes, and the plain words of the rest of the site.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repo(path), "utf8");
const latest = JSON.parse(read("apps/site/public/phone/latest.json")) as Record<string, unknown>;
const workflow = read(".github/workflows/android-release.yml");
const page = read("apps/site/src/pages/phone.astro");

describe("the download page and its release file", () => {
  it("are where the inbox and the app look for them", () => {
    expect(ANDROID_APP_URL).toBe("https://surfingdog.ai/phone");
    expect(ANDROID_LATEST_URL).toBe("https://surfingdog.ai/phone/latest.json");
  });

  it("name the certificate the release workflow insists on", () => {
    const pinned = /RELEASE_CERT_SHA256: ([0-9a-f]{64})/.exec(workflow)?.[1] ?? "";
    expect(pinned).toHaveLength(64);
    const colons = pinned.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    expect(latest.certSha256).toBe(colons);
  });

  it("point at the APK the workflow publishes for that version, never at a store or a run's artifact", () => {
    const version = String(latest.versionName);
    expect(latest.url).toBe(
      `https://github.com/surfingdogai/inbox/releases/download/android-v${version}/surfingdog-inbox-${version}.apk`,
    );
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    expect(latest.versionCode).toBe(major * 10000 + minor * 100 + patch);
    expect(Number(latest.minSupported)).toBeGreaterThanOrEqual(1);
  });

  it("offer a download only once the release has its SHA-256, and the app agrees", () => {
    const released = typeof latest.sha256 === "string";
    if (released) expect(latest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readLatest(latest) !== null).toBe(released);
    expect(page).toContain("released ? (");
  });

  it("are plain: no claim of being first, alone or best, and no store the app isn't in", () => {
    const words = page.toLowerCase();
    for (const claim of ["first app", "only app", "#1", "best", "guarantee", "play store", "app store"])
      expect(words).not.toContain(claim);
    expect(page).toContain('href="/privacy/#phone-h"');
    expect(read("apps/site/src/pages/privacy.astro")).toContain('id="phone-h"');
  });
});
