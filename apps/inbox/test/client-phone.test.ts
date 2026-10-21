import { readPhoneLink } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  ago,
  openInAppLink,
  phoneLine,
  pushUnavailable,
  pushWord,
  QUIET_ZONE,
  qrDrawing,
  qrMatrix,
  timeLeft,
} from "../client/src/lib/phones";

/** Settings → Phone's pure parts: the QR code it draws, the clock under it, and the words for phones. */
const QR = "https://inbox.atelierlumen.com/phone#v=1&pair=sdi_pp_7Qm3kXc9vA2bN5rT8yZ1wE4uI6oP0sD3fG7hJ9kL2mN";

/** The modules a drawing's path paints, as a scanner would see them. */
function paint(drawing: { size: number; path: string }): boolean[][] {
  const grid = Array.from({ length: drawing.size }, () => Array<boolean>(drawing.size).fill(false));
  for (const [, x, y, w] of drawing.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) {
      const row = grid[Number(y)];
      if (row) row[Number(x) + i] = true;
    }
  }
  return grid;
}

describe("the QR code", () => {
  it("paints exactly the code's dark modules, inside a quiet zone of four", () => {
    const drawing = qrDrawing(QR);
    const painted = paint(drawing);
    expect(painted).toEqual(qrMatrix(QR));
    expect(painted.slice(0, QUIET_ZONE).flat().some(Boolean)).toBe(false);
    expect(painted.flatMap((r) => r.slice(0, QUIET_ZONE)).some(Boolean)).toBe(false);
    // Small enough for a phone to read across a desk: version 6 or less.
    expect(drawing.size - QUIET_ZONE * 2).toBeLessThanOrEqual(41);
    expect(readPhoneLink(QR)).toMatchObject({ kind: "pair", origin: "https://inbox.atelierlumen.com" });
  });
});

describe("the words", () => {
  it("counts a code down from 4:59 to its last second, never over five minutes, then says nothing", () => {
    const at = Date.parse("2026-10-20T10:00:00Z");
    expect(timeLeft("2026-10-20T10:05:00Z", at)).toBe("4:59");
    // The server's clock a second ahead of this one: still never more than the five minutes promised.
    expect(timeLeft("2026-10-20T10:05:01Z", at)).toBe("4:59");
    expect(timeLeft("2026-10-20T10:00:05Z", at)).toBe("0:05");
    expect(timeLeft("2026-10-20T10:00:00.400Z", at)).toBe("0:00");
    expect(timeLeft("2026-10-20T10:00:00Z", at)).toBe("");
    expect(timeLeft("not a time", at)).toBe("");
  });

  it("says how notifications stand on each phone, and why there are none, to the owner first", () => {
    expect(pushWord({ push: "on" })).toBe("Notifications on");
    expect(pushWord({ push: "lost" })).toContain("open the app");
    expect(pushWord({ push: "off" })).toBe("No notifications yet");
    expect(pushUnavailable(null)).toBeNull();
    // A hosted inbox's owner has no server: no server words for them.
    expect(pushUnavailable("no_secret_key", true)).toEqual({
      text: "Notifications aren't on for this inbox yet. Your phone still opens it.",
      server: null,
    });
    expect(pushUnavailable("no_secret_key")?.server).toBe("For whoever runs the server: set INBOX_SECRET_KEY.");
    expect(pushUnavailable("no_relay")?.server).toContain("INBOX_PUSH_RELAY");
    const now = Date.parse("2026-10-20T10:00:00Z");
    expect(ago("2026-10-20T09:59:40Z", now)).toBe("just now");
    expect(ago("2026-10-18T09:00:00Z", now)).toBe("2 days ago");
    expect(
      phoneLine({ created_at: "2026-10-20T09:59:40Z", last_seen_at: "2026-10-20T09:59:50Z", push: "off" }, now),
    ).toBe("Connected just now · No notifications yet");
    expect(
      phoneLine({ created_at: "2026-10-18T09:00:00Z", last_seen_at: "2026-10-20T09:00:00Z", push: "on" }, now),
    ).toBe("Connected 2 days ago · opened 1 h ago · Notifications on");
  });

  it("hands the code to the app itself on an Android phone, and to no other app", () => {
    const intent = openInAppLink(QR);
    expect(intent).toContain("intent://pair?o=https%3A%2F%2Finbox.atelierlumen.com&s=sdi_pp_");
    expect(intent).toContain(";package=ai.surfingdog.inbox;");
    expect(intent).toContain(";scheme=ai.surfingdog.inbox;");
    expect(intent).toContain(
      "S.browser_fallback_url=https%3A%2F%2Finbox.atelierlumen.com%2Fphone%23v%3D1%26app%3Dmissing",
    );
    expect(openInAppLink("https://example.com/menu")).toBeNull();
  });
});
