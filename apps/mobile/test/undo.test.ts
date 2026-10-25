import { describe, expect, it } from "vitest";
import { Waiting } from "../src/lib/undo";

/**
 * A press on the phone waits for Undo (ADR-029 §12): sent once when its time ends, sent at once when
 * the item closes or the app goes to the background, never when Undo is pressed, and never because
 * anything else happened meanwhile (a refresh, a toast, the network coming back, the screen drawn
 * again). The screen keeps one of these for its whole life.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waiting(ms = 60) {
  const sent: string[] = [];
  let done = 0;
  const w = new Waiting<string>(
    (act) => {
      sent.push(act);
    },
    ms,
    () => {
      done++;
    },
  );
  return { w, sent, done: () => done };
}

describe("a press waiting for Undo", () => {
  it("is sent now when asked, and says when it was: what comes after waits for it", async () => {
    const sent: string[] = [];
    const w = new Waiting<string>(async (act) => {
      await sleep(30);
      sent.push(act);
    }, 6_000);
    w.start("let_in");
    await w.now();
    expect(sent).toEqual(["let_in"]);
    // Nothing waits: done at once.
    await w.now();
    expect(sent).toEqual(["let_in"]);
  });

  it("is sent once, when its time ends, and nothing else sends it", async () => {
    const { w, sent, done } = waiting();
    w.start("not_spam");
    expect(w.pending).toBe("not_spam");
    await sleep(20);
    expect(sent).toEqual([]);
    await sleep(80);
    expect(sent).toEqual(["not_spam"]);
    expect(done()).toBe(1);
    expect(w.pending).toBeNull();
    await sleep(80);
    expect(sent).toEqual(["not_spam"]);
  });

  it("is never sent when Undo is pressed", async () => {
    const { w, sent } = waiting();
    w.start("spam");
    w.undo();
    await sleep(100);
    expect(sent).toEqual([]);
    expect(w.pending).toBeNull();
  });

  it("is sent at once when the item closes or the app goes to the background, and only once", async () => {
    const { w, sent } = waiting();
    w.start("let_in");
    w.now();
    expect(sent).toEqual(["let_in"]);
    w.now();
    await sleep(100);
    expect(sent).toEqual(["let_in"]);
  });

  it("sends the one before at once when another press takes its place", async () => {
    const { w, sent } = waiting();
    w.start("spam");
    w.start("not_spam");
    expect(sent).toEqual(["spam"]);
    expect(w.pending).toBe("not_spam");
    await sleep(100);
    expect(sent).toEqual(["spam", "not_spam"]);
  });
});
