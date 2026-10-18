import {
  ConnectorError,
  type ConnectorHttp,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse,
  isPublicHost,
  USER_AGENT,
} from "@surfingdog/core";

/**
 * How a connector reaches a platform: the same rules every call to an address someone else chose
 * follows here (feeds, webhooks, networks). https only, a public host name and never an address,
 * redirects followed by hand and each hop checked again, a time limit, and an answer read only up to
 * a size. The host's `fetchImpl` (`pinnedFetch` on Node) then resolves the name, refuses it when any
 * address is not public, and connects to the address it checked.
 *
 * Credentials travel only within one site. A calendar server that redirects to another of its own
 * hosts (iCloud sends each account to a partition host) keeps the sign-in; a redirect anywhere else
 * goes without it.
 */

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function connectorHttp(opts: { readonly fetchImpl?: typeof fetch | undefined } = {}): ConnectorHttp {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(request: ConnectorHttpRequest): Promise<ConnectorHttpResponse> {
      let url = checked(request.url);
      const site = siteOf(url.hostname);
      let method = request.method.toUpperCase();
      let body = request.body;
      const headers: Record<string, string> = { "user-agent": USER_AGENT, ...(request.headers ?? {}) };
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let response: Response;
        try {
          response = await doFetch(url.toString(), {
            method,
            headers,
            ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
            redirect: "manual",
            signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          });
        } catch (error) {
          const timedOut = (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError";
          throw new ConnectorError(
            "unreachable",
            timedOut ? `${url.host} did not answer in time.` : `Could not reach ${url.host}.`,
          );
        }
        if (response.status >= 300 && response.status < 400 && request.followRedirects) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location) throw new ConnectorError("bad_response", `${url.host} redirected nowhere.`);
          const next = checked(new URL(location, url).toString());
          if (siteOf(next.hostname) !== site) {
            delete headers.authorization;
            delete headers.Authorization;
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
          }
          url = next;
          continue;
        }
        const declared = Number(response.headers.get("content-length") ?? "");
        const max = request.maxBytes ?? DEFAULT_MAX_BYTES;
        if (Number.isFinite(declared) && declared > max) {
          await response.body?.cancel().catch(() => {});
          throw new ConnectorError("bad_response", `${url.host} sent more than this inbox reads.`);
        }
        const text = await readBounded(response, max, url.host);
        return { status: response.status, headers: response.headers, text, url: url.toString() };
      }
      throw new ConnectorError("bad_response", `${url.host} redirected too many times.`);
    },
  };
}

function checked(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("config", `This is not an address: ${raw}`);
  }
  if (url.protocol !== "https:") throw new ConnectorError("config", `${url.host || raw} is reached over https only.`);
  if (url.username || url.password) throw new ConnectorError("config", "An address with a password in it is not used.");
  if (!isPublicHost(url.hostname)) throw new ConnectorError("config", `${url.hostname} is not a public address.`);
  return url;
}

/**
 * The site a host belongs to, for whether a sign-in may follow a redirect: its last two labels, or
 * three under a two-letter country's common second level (example.co.uk, example.com.br).
 */
export function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const n = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-n).join(".");
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "gob", "nom"]);

async function readBounded(response: Response, max: number, host: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new ConnectorError("bad_response", `${host} sent more than this inbox reads.`);
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // closed already
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/** `Basic` credentials for a user and password, as UTF-8 (an accented name works). */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** How long a platform asked us to wait (`Retry-After`), in milliseconds, within reason. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 1), 3_600) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 1000), 3_600_000) : undefined;
}
