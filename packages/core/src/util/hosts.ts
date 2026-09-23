/**
 * Which hosts this instance will call, and what counts as a network's address. Settings validate
 * with these at write time and the jobs check again at run time, so a bad address is refused where
 * the owner can see it and never reaches the network code at all.
 */

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".onion",
  ".test",
  ".invalid",
  ".example",
];

/**
 * No IP literals, no local, internal or reserved names. This is the one definition of the rule:
 * the webhook capability, `safeFetch` in `@surfingdog/adapters` and the network settings all use
 * it rather than keeping a copy, because two host allow-lists that drift apart is how one door
 * ends up laxer than the other.
 */
export function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h || BLOCKED_HOSTS.has(h)) return false;
  if (!h.includes(".")) return false;
  if (/^[\d.]+$/.test(h) || h.startsWith("[") || h.includes(":")) return false;
  return !BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * A network's key in settings (ADR-017 §8.1): an https origin on port 443 with a public host name,
 * and nothing else — no path, query, fragment or credentials. Returns the canonical spelling
 * (lower-case, punycode, no trailing slash, no `:443`), or null when the input is not one.
 * `https://Network.Example.com/` is accepted as `https://network.example.com`.
 */
export function canonicalNetworkOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  if (input.trim().endsWith("?") || input.trim().endsWith("#")) return null;
  if (!isPublicHost(url.hostname)) return null;
  return `https://${url.hostname.replace(/\.$/, "")}`;
}

/**
 * The network origin a legacy `network.url` pointed at. The old jobs only ever used the URL's
 * origin, so a path is dropped here the same way; anything that is not https on 443 with a public
 * host still yields null, as it never worked then either.
 */
export function networkOriginOfUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    return canonicalNetworkOrigin(new URL(input.trim()).origin);
  } catch {
    return null;
  }
}
