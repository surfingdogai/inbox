/**
 * Cloudflare Web Analytics, for the surfingdog.ai build only. It counts visits without cookies and
 * without following anyone across sites (the privacy page says what it records). It is off unless
 * the build is run with WEB_ANALYTICS_TOKEN set to the site's beacon token: our deploy sets it, so
 * anyone else who builds this repository sends nothing to our account, and can set a token of their
 * own instead. The token is public by design, since it is written into every page.
 *
 * The beacon is one script tag: in the head of every page of the site (src/layouts/Layout.astro)
 * and of the docs (astro.config.mjs). The owner app, the inbox itself and anything a business
 * serves never carry it.
 */
const token = process.env.WEB_ANALYTICS_TOKEN?.trim() ?? "";

if (token && !/^[0-9a-f]{32}$/.test(token)) {
  throw new Error("WEB_ANALYTICS_TOKEN is not a Cloudflare Web Analytics token (32 hex digits)");
}

/** Where the beacon's script comes from. It reports each visit to https://cloudflareinsights.com. */
export const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

/** The beacon's script tag, as attributes; null when the build counts nothing. */
export const BEACON = token ? { defer: true, src: BEACON_SRC, "data-cf-beacon": JSON.stringify({ token }) } : null;

/** The same tag as an entry of the docs' head (Starlight's `head`), or none. */
export const BEACON_HEAD = BEACON ? [{ tag: "script" as const, attrs: BEACON }] : [];
