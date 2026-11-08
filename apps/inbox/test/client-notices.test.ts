import { describe, expect, it } from "vitest";
import { countFor, countsFrom, FILTERS, filterLabel, paramsFor, parseFilter } from "../client/src/lib/filters";
import {
  isNotice,
  MOVED_LINE,
  MOVED_TO_INBOX,
  NOTICES_TOP,
  newNotices,
  noticesLine,
  RECENT_NOTICES_MS,
  readNoticesSeen,
  wasNotice,
} from "../client/src/lib/notices";
import type { ItemView } from "../client/src/lib/types";

/**
 * The Notices view (ADR-026 §6): emails from systems that answer no conversation, under a quiet filter
 * of their own beside the inbox list, counted without asking for anything.
 */
const view = (id: string, flags: Record<string, unknown> = {}, createdAt = "2026-11-08T09:00:00Z"): ItemView =>
  ({
    item: {
      id,
      type: "message",
      state: "open",
      flags: { needsHuman: false, sandbox: false, priority: 0, ...flags },
      payload: { text: "x" },
      createdAt,
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

  it("are said above the inbox when new: since you last opened them, or the last week's before you ever did", () => {
    const now = Date.parse("2026-11-08T15:00:00Z");
    const times = ["2026-11-08T14:00:00Z", "2026-11-08T09:00:00Z", "2026-11-05T09:00:00Z", "2026-10-20T09:00:00Z"];
    // Never opened on this browser: the last week's are new.
    expect(newNotices(times, null, now)).toBe(3);
    expect(RECENT_NOTICES_MS).toBe(7 * 86_400_000);
    // Opened this morning: only what came since.
    expect(newNotices(times, Date.parse("2026-11-08T10:00:00Z"), now)).toBe(1);
    expect(newNotices(times, now, now)).toBe(0);
    expect(newNotices([], null, now)).toBe(0);
    // What the browser kept is a time, or nothing.
    expect(readNoticesSeen(String(now))).toBe(now);
    expect(readNoticesSeen(null)).toBeNull();
    expect(readNoticesSeen("")).toBeNull();
    expect(readNoticesSeen("soon")).toBeNull();
    expect(readNoticesSeen("-5")).toBeNull();
    // The rail's counts carry when each came.
    const counts = countsFrom(
      page([]),
      page([]),
      page([]),
      page([view("n1", { notice: true }, times[0]), view("n2", { notice: true }, times[3])]),
    );
    expect(counts.noticeTimes).toEqual([times[0], times[3]]);
  });

  it("are said in a few plain words, never as something that needs you", () => {
    expect(noticesLine(6)).toBe("6 new notices from companies");
    expect(noticesLine(1)).toBe("1 new notice from a company");
    expect(noticesLine(100, true)).toBe("100+ new notices from companies");
    expect(MOVED_TO_INBOX).toBe("Moved to your inbox.");
    // A notice in the inbox, moved there or brought back with Not spam, says so, and that it is still yours alone.
    expect(MOVED_LINE).toBe("A notice, in your inbox now. Still yours alone: nothing answers it by itself.");
  });
});
