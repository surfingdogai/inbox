/**
 * The addresses the owner's phone reads (ADR-026), written and read in one place, by the inbox and by
 * the phone app alike. No imports: the app bundles this file on its own.
 *
 * - A QR code in Settings → Phone: `https://<inbox>/phone#v=1&pair=<secret>`. The secret rides in the
 *   fragment, which a browser never sends anywhere: scanned with the phone's own camera, the address
 *   opens a page that says to scan it from the app, and nothing more.
 * - A sign-in link by email: `https://<inbox>/phone#v=1&link=<secret>`, whose page hands it to the app
 *   as `ai.surfingdog.inbox://link?o=<inbox>&s=<secret>`. Only the phone that asked for it holds the
 *   PKCE verifier and the device key it needs, so another app that catches it gets nothing.
 * - An item: `https://<inbox>/i/<id>`: the owner app on a computer, the app on a phone.
 * - On an Android phone, the page a QR code opens hands its secret to the app itself, by an
 *   `intent://pair?o=<inbox>&s=<secret>` link pinned to the app's package (no other app can take it):
 *   the app reads it as `ai.surfingdog.inbox://pair?o=<inbox>&s=<secret>`.
 */
export const APP_SCHEME = "ai.surfingdog.inbox";
/**
 * Where an owner gets the Android app, once there is a place to get it (a test build page, then the
 * Play Store). Null until Surfing Dog decides where: then Settings → Phone and the page a QR code
 * opens offer "Get it for Android".
 */
export const ANDROID_APP_URL: string | null = null;
const SECRET = /^sdi_pp_[A-Za-z0-9_-]{43}$/;
const ITEM = /^[0-9A-Za-z_-]{1,64}$/;

export function pairingUri(origin: string, secret: string): string {
  return `${origin}/phone#v=1&pair=${secret}`;
}

export function signInLinkUri(origin: string, secret: string): string {
  return `${origin}/phone#v=1&link=${secret}`;
}

export function appLinkUri(origin: string, secret: string): string {
  return `${APP_SCHEME}://link?o=${encodeURIComponent(origin)}&s=${secret}`;
}

export function itemUri(origin: string, itemId: string): string {
  return `${origin}/i/${encodeURIComponent(itemId)}`;
}

/** An inbox's address as the phone may trust it: https, or plain http on this computer for development. */
export function inboxOrigin(value: string, allowLocal = false): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.origin;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "10.0.2.2";
  return allowLocal && u.protocol === "http:" && local ? u.origin : null;
}

export interface PhoneLink {
  readonly kind: "pair" | "link";
  readonly origin: string;
  readonly secret: string;
}

/** What a scanned code or an opened link says, or null when it is not one of ours. */
export function readPhoneLink(text: string, allowLocal = false): PhoneLink | null {
  const value = text.trim();
  if (value.startsWith(`${APP_SCHEME}://`)) {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      return null;
    }
    const what = u.host || u.pathname.replace(/^\/+/, "");
    if (what !== "link" && what !== "pair") return null;
    const origin = inboxOrigin(u.searchParams.get("o") ?? "", allowLocal);
    const secret = u.searchParams.get("s") ?? "";
    return origin && SECRET.test(secret) ? { kind: what, origin, secret } : null;
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const origin = inboxOrigin(value, allowLocal);
  if (!origin || u.pathname !== "/phone") return null;
  const params = new URLSearchParams(u.hash.replace(/^#/, ""));
  if (params.get("v") !== "1") return null;
  const pair = params.get("pair");
  if (pair && SECRET.test(pair)) return { kind: "pair", origin, secret: pair };
  const link = params.get("link");
  if (link && SECRET.test(link)) return { kind: "link", origin, secret: link };
  return null;
}

/** The inbox and item an item link names, or null. */
export function readItemLink(text: string, allowLocal = false): { origin: string; item: string } | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.protocol === `${APP_SCHEME}:`) {
    // ai.surfingdog.inbox://i/<id>?o=<inbox>, as a notification opens the app.
    const id = (u.host === "i" ? u.pathname : u.pathname.replace(/^\/+i/, "")).replace(/^\/+/, "");
    const origin = inboxOrigin(u.searchParams.get("o") ?? "", allowLocal);
    return origin && ITEM.test(id) ? { origin, item: id } : null;
  }
  const origin = inboxOrigin(u.href, allowLocal);
  const m = /^\/i\/([^/]+)$/.exec(u.pathname);
  const id = m?.[1] ? decodeURIComponent(m[1]) : "";
  return origin && ITEM.test(id) ? { origin, item: id } : null;
}
