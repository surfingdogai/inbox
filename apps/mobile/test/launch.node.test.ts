import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app opened from a link while it was not running (Android starts it with the link: a code the
 * page a QR code opens hands over, an emailed sign-in link, a notification). Capacitor gives that link
 * only through `getLaunchUrl`, never as an `appUrlOpen` event, and the app opens a waiting link only
 * when it becomes ready or is unlocked. So the link must be read before the app says it is ready:
 * read after, it waits in a ref nothing looks at again, and the owner's first connection is lost.
 */
describe("the link the app was started with", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

  it("is read before the app is ready, so opening the app with it is never lost", () => {
    const boot = source.slice(source.indexOf("// ---- boot"), source.indexOf("// ---- this build"));
    const read = boot.indexOf("CapApp.getLaunchUrl()");
    const kept = boot.indexOf("pendingLink.current = launch.url");
    const ready = boot.indexOf("setReady(true)");
    expect(read).toBeGreaterThan(-1);
    expect(kept).toBeGreaterThan(read);
    expect(ready).toBeGreaterThan(kept);
  });

  it("is opened once the app is ready and unlocked", () => {
    expect(source).toMatch(
      /if \(!ready \|\| locked \|\| insecure \|\| !pendingLink\.current\) return;[\s\S]*void openLink\(url\);/,
    );
  });
});
