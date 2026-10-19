import { encode } from "uqr";
import type { PhoneView } from "./types";

/**
 * Settings → Phone (ADR-026): the QR code a phone scans to connect, and the words for the phones that
 * did. The code is drawn here as one SVG path, ink on white whatever the theme: a camera reads dark
 * modules on a light ground, and a quiet zone of four modules round it.
 */
export interface QrDrawing {
  /** Modules on a side, quiet zone included: the SVG's viewBox is 0 0 size size. */
  readonly size: number;
  /** One path for every dark module. */
  readonly path: string;
}

export const QUIET_ZONE = 4;

export function qrDrawing(text: string): QrDrawing {
  // M is the level phone cameras read best at this size; the address and secret fit version 6 or so.
  const qr = encode(text, { ecc: "M", border: 0 });
  const size = qr.size + QUIET_ZONE * 2;
  let path = "";
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      // A run of dark modules on one row is one rectangle.
      let end = x;
      while (end < row.length && row[end]) end++;
      path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return { size, path };
}

/** The modules a drawing paints, back as a matrix: what a scanner would see (the tests read it back). */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: QUIET_ZONE }).data;
}

/** Time left on a code, as a clock shows it: `4:59`, `0:05`; nothing once it has run out. */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return "";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether notifications reach a phone, as one short phrase. */
export function pushWord(phone: Pick<PhoneView, "push">): string {
  switch (phone.push) {
    case "on":
      return "Notifications on";
    case "lost":
      return "Not reached: open the app on it once";
    case "error":
      return "Notifications failed";
    case "unavailable":
      return "No notifications on this server";
    default:
      return "Notifications not set up yet";
  }
}

/** Why notifications cannot work on this inbox at all, when they cannot. */
export function pushUnavailable(reason: "no_relay" | "no_secret_key" | null): string | null {
  if (reason === "no_secret_key")
    return "Notifications need INBOX_SECRET_KEY on this server. The phone still opens your inbox without them.";
  if (reason === "no_relay")
    return "Notifications are switched off on this server (INBOX_PUSH_RELAY=off). The phone still opens your inbox.";
  return null;
}
