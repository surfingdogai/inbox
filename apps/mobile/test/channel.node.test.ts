import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import * as direct from "../src/channel";
import * as play from "../src/channel.play";

/**
 * The copy on Google Play carries no self-update (store/play/technical.md; Play's Device and Network
 * Abuse policy: an app from Play updates only through Play). Its screens, built as the Android build
 * packs them (`vite build --mode play`), never read the release file, never link to the download page
 * and never say a new version is ready. The download page's copy does all three, so the check can
 * tell them apart; and the Android build refuses to pack one copy's screens into the other.
 */
const mobile = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "sdi-channel-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Everything a build of the screens holds, as text, and the copy it says it is. */
async function screens(mode: "play" | "production"): Promise<{ text: string; channel: unknown }> {
  const dir = path.join(out, mode);
  await build({
    configFile: path.join(mobile, "vite.config.ts"),
    mode,
    logLevel: "silent",
    build: { outDir: dir, emptyOutDir: true },
  });
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      statSync(path.join(d, f)).isDirectory() ? files(path.join(d, f)) : [path.join(d, f)],
    );
  const text = files(dir)
    .filter((f) => /\.(js|html|json|css)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  return { text, channel: JSON.parse(readFileSync(path.join(dir, "channel.json"), "utf8")).channel };
}

/** What only a self-updating copy holds: the release file, the download page, and its lines. */
const SELF_UPDATE = [
  "surfingdog.ai/phone/latest.json",
  "latest.json",
  "surfingdog.ai/phone",
  "A new version is ready",
  "too old for your inbox",
];

describe("the Google Play copy", { timeout: 120_000 }, () => {
  it("carries no self-update: no release file, no download page, no line about either", async () => {
    const built = await screens("play");
    expect(built.channel).toBe("play");
    for (const s of SELF_UPDATE) expect(built.text, s).not.toContain(s);
    // The rest of the app is all there, the demo for Play's reviewer with it.
    expect(built.text).toContain("Connect your inbox");
    expect(built.text).toContain("Try the demo");
    expect(built.text).toContain("demo.surfingdog.ai");
  });

  it("is told apart from the download page's copy, which does update itself", async () => {
    const built = await screens("production");
    expect(built.channel).toBe("direct");
    for (const s of SELF_UPDATE) expect(built.text, s).toContain(s);
  });

  it("never asks whether there is an update, and never shows the line", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return new Response("{}");
    };
    const kv = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    expect(await play.checkForUpdate(fetch, kv, 10001)).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
    expect(play.UpdateLine()).toBeNull();
    expect(play.CHANNEL).toBe("play");
    expect(direct.CHANNEL).toBe("direct");
    // The same names in both copies, so either one fits wherever the other is used.
    expect(Object.keys(play).sort()).toEqual(Object.keys(direct).sort());
  });

  it("is its own Android flavour, signed with the upload key and refusing the other copy's screens", () => {
    const gradle = readFileSync(path.join(mobile, "android/app/build.gradle"), "utf8");
    expect(gradle).toMatch(/productFlavors\s*\{[\s\S]*\bdirect\s*\{[\s\S]*\bplay\s*\{/);
    expect(gradle).toContain("checkScreens");
    expect(gradle).toContain('System.getenv("ANDROID_UPLOAD_KEYSTORE")');
    // Keys and passwords come from the environment only, never from the repository.
    expect(gradle).not.toMatch(/storePassword\s*=?\s*"(?!android")/);
    const manifest = readFileSync(path.join(mobile, "android/app/src/main/AndroidManifest.xml"), "utf8");
    expect(manifest).not.toContain("REQUEST_INSTALL_PACKAGES");
  });
});
