import { readPhoneLink } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { pushUnavailable, pushWord, QUIET_ZONE, qrDrawing, qrMatrix, timeLeft } from "../client/src/lib/phones";

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
  it("counts a code down to its last second, and then says nothing", () => {
    const at = Date.parse("2026-10-20T10:00:00Z");
    expect(timeLeft("2026-10-20T10:05:00Z", at)).toBe("5:00");
    expect(timeLeft("2026-10-20T10:00:05Z", at)).toBe("0:05");
    expect(timeLeft("2026-10-20T10:00:00.400Z", at)).toBe("0:01");
    expect(timeLeft("2026-10-20T10:00:00Z", at)).toBe("");
    expect(timeLeft("not a time", at)).toBe("");
  });

  it("says how notifications stand on each phone, and why there are none on a server", () => {
    expect(pushWord({ push: "on" })).toBe("Notifications on");
    expect(pushWord({ push: "lost" })).toContain("open the app");
    expect(pushWord({ push: "off" })).toBe("Notifications not set up yet");
    expect(pushUnavailable(null)).toBeNull();
    expect(pushUnavailable("no_secret_key")).toContain("INBOX_SECRET_KEY");
    expect(pushUnavailable("no_relay")).toContain("INBOX_PUSH_RELAY=off");
  });
});
