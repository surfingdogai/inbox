import { describe, expect, it } from "vitest";
import { countFor, countsFrom, FILTERS, filterLabel, paramsFor, parseFilter } from "../client/src/lib/filters";
import { isNotice, NOTICES_TOP, wasNotice } from "../client/src/lib/notices";
import type { ItemView } from "../client/src/lib/types";

/**
 * The Notices view (ADR-026 §6): emails from systems that answer no conversation, under a quiet filter
 * of their own beside the inbox list, counted without asking for anything.
 */
const view = (id: string, flags: Record<string, unknown> = {}): ItemView =>
  ({
    item: {
      id,
      type: "message",
      state: "open",
      flags: { needsHuman: false, sandbox: false, priority: 0, ...flags },
      payload: { text: "x" },
      closedAt: null,
    },
  }) as unknown as ItemView;

const page = (items: ItemView[], more = false) => ({ items, next_cursor: more ? "c" : null });

describe("the Notices view", () => {
  it("lists notices, and only notices, from the API", () => {
    expect(parseFilter("notices")).toBe("notices");
    expect(filterLabel("notices")).toBe("Notices");
    expect(FILTERS.at(-1)?.key).toBe("notices");
    expect(paramsFor("notices", undefined, false)).toMatchObject({ notices: true, open_only: false });
    expect(paramsFor("notices", "receipt", true)).toMatchObject({ notices: true, q: "receipt", sandbox: true });
    // No other list asks for them: the API leaves them out of every one.
    for (const f of FILTERS.filter((x) => x.key !== "notices")) {
      expect(paramsFor(f.key, undefined, false)).not.toHaveProperty("notices");
    }
  });

  it("counts them quietly: nothing when there are none, never as something that needs you", () => {
    const none = countsFrom(page([view("a")]), page([view("a")]), page([]), page([]));
    expect(countFor(none, "notices")).toBe("");
    const three = countsFrom(
      page([view("a")]),
      page([view("a")]),
      page([]),
      page([view("n1"), view("n2"), view("n3")]),
    );
    expect(countFor(three, "notices")).toBe("3");
    expect(countFor(three, "needs")).toBe("0");
    expect(countFor(countsFrom(page([]), page([]), page([]), page([view("n")], true)), "notices")).toBe("1+");
  });

  it("says what they are in one plain line, and tells a notice from one moved to the inbox", () => {
    expect(NOTICES_TOP).toBe(
      "Notices: emails from systems, like receipts, account and newsletter mail. Nobody answers them.",
    );
    expect(isNotice(view("n", { notice: true }).item)).toBe(true);
    expect(isNotice(view("n", { notice: true, inInbox: true }).item)).toBe(false);
    expect(wasNotice(view("n", { notice: true, inInbox: true }).item)).toBe(true);
    expect(isNotice(view("c").item)).toBe(false);
  });
});
