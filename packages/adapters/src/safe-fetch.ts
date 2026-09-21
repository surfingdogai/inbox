/**
 * Fetches a public https URL the way an untrusted input demands: no IP literals, no local hosts,
 * no redirects to another host, a short timeout and a size cap. Used for Client ID Metadata
 * Documents, key directories and website imports.
 */
import { isPublicHost } from "@surfingdog/core";

/**
 * The host rule itself lives in `@surfingdog/core` (`capabilities/webhooks.ts`), because the
 * webhook capability has to apply it when an endpoint is added and core cannot import adapters.
 * It is re-exported rather than copied: two allow-lists drifting apart is how one door ends up
 * laxer than the other.
 */
export { isPublicHost };

export interface SafeFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly accept?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function safeFetchJson<T = unknown>(url: string, opts: SafeFetchOptions = {}): Promise<T | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  if (current.protocol !== "https:" || !isPublicHost(current.hostname)) return null;
  const origin = current.host;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 2); hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: opts.accept ?? "application/json",
          "user-agent": "surfingdog-inbox/0 (+https://surfingdog.ai)",
        },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      const next = new URL(loc, current);
      if (next.protocol !== "https:" || next.host !== origin) return null;
      current = next;
      continue;
    }
    if (!res.ok) return null;
    const text = await readCapped(res, maxBytes);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
