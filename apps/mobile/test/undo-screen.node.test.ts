import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The item screen keeps one press waiting for Undo for its whole life (`Waiting`): it is sent when the
 * screen closes or the app goes to the background, never because the screen drew itself again — a
 * refresh, a toast, the network coming back.
 */
describe("the phone's item screen", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../src/screens/Item.tsx"), "utf8");

  it("makes what waits once, and reads the app and the item as they are when it is sent", () => {
    expect(source).toMatch(/waiting\.current \?\?= new Waiting<SpamAct>\(/);
    expect(source).toMatch(/const appRef = useRef\(app\);/);
    // No effect whose cleanup sends what waits may depend on anything that changes as the app draws.
    expect(source).not.toMatch(/\}, \[commit\]\);/);
  });

  it("sends what waits when the item closes, the page hides or the app pauses, and on nothing else", () => {
    const effect = source.slice(source.indexOf("const q = waiting.current;"), source.indexOf("}, []);"));
    expect(effect).toContain('document.addEventListener("visibilitychange", hidden)');
    expect(effect).toContain('window.addEventListener("pagehide", away)');
    expect(effect).toContain('CapApp.addListener("pause", away)');
    expect(effect).toContain("q?.now();");
  });
});
