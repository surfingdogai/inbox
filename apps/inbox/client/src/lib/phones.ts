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

/** A code works for five minutes: the clock never shows more, whatever the two clocks say. */
export const CODE_SECONDS = 300;

/** Time left on a code, as a clock shows it: `4:59`, `0:05`; nothing once it has run out. */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return "";
  const s = Math.min(CODE_SECONDS - 1, Math.floor(ms / 1000));
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
      return "No notifications here yet";
    default:
      return "No notifications yet";
  }
}

/** How long ago, as a sentence says it: "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(t));
}

/** A phone's line in the list: "Connected just now · No notifications yet"; opened only when it says more. */
export function phoneLine(
  p: Pick<PhoneView, "created_at" | "last_seen_at" | "push">,
  now: number = Date.now(),
): string {
  const connected = ago(p.created_at, now);
  const opened = p.last_seen_at ? ago(p.last_seen_at, now) : "";
  return [`Connected ${connected}`, opened && opened !== connected ? `opened ${opened}` : null, pushWord(p)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Why notifications cannot work on this inbox, when they cannot: one line for the owner, and on an
 * inbox of the owner's own a second for whoever runs its server. A hosted inbox's owner has no server.
 */
export function pushUnavailable(
  reason: "no_relay" | "no_secret_key" | null,
  hosted = false,
): { readonly text: string; readonly server: string | null } | null {
  if (!reason) return null;
  const text = "Notifications aren't on for this inbox yet. Your phone still opens it.";
  if (hosted) return { text, server: null };
  return {
    text,
    server:
      reason === "no_secret_key"
        ? "For whoever runs the server: set INBOX_SECRET_KEY."
        : "For whoever runs the server: INBOX_PUSH_RELAY is off.",
  };
}

/**
 * On an Android phone, the code itself handed to the app: an `intent://` link pinned to the app's
 * package, so no other app can take the secret, falling back to the page that says how to get the app.
 * Null for anything that is not one of our codes.
 */
export function openInAppLink(qr: string): string | null {
  let u: URL;
  try {
    u = new URL(qr);
  } catch {
    return null;
  }
  const f = new URLSearchParams(u.hash.replace(/^#/, ""));
  const secret = f.get("pair") ?? "";
  if (u.pathname !== "/phone" || f.get("v") !== "1" || !/^sdi_pp_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const fallback = `${u.origin}/phone#v=1&app=missing`;
  return `intent://pair?o=${encodeURIComponent(u.origin)}&s=${secret}#Intent;scheme=ai.surfingdog.inbox;package=ai.surfingdog.inbox;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}
