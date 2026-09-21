/**
 * The origin this instance is reached at. Behind Caddy/Cloudflare the request URL says http://,
 * so a configured base URL wins, then X-Forwarded-Proto, then the request itself. Only the scheme
 * is taken from the proxy header: the host always comes from the request URL.
 */
export function publicOrigin(request: Request, baseUrl?: string | undefined): string {
  if (baseUrl) return new URL(baseUrl).origin;
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https" && url.protocol === "http:") return `https://${url.host}`;
  return url.origin;
}
