import { isPublicHost } from "../util/hosts";
import { USER_AGENT } from "../version";

/**
 * A file an agent names by address (ADR-039 §2), fetched the way every address someone else chose is
 * here: https only, a public host name and never an address, no user or password in it, each redirect
 * checked again (at most two), a time limit, and the body read only up to the largest file taken. The
 * host's `fetchImpl` (`pinnedFetch` on Node) then refuses a name that resolves to a private address.
 * Nothing the answer says about its type is believed: the first bytes decide.
 */

export type FetchRefusal =
  | "not_https"
  | "not_public"
  | "credentials"
  | "bad_url"
  | "too_large"
  | "unreachable"
  | "status"
  | "redirects";

export class FileFetchError extends Error {
  readonly reason: FetchRefusal;
  constructor(reason: FetchRefusal, message: string) {
    super(message);
    this.name = "FileFetchError";
    this.reason = reason;
  }
}

const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 15_000;

function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FileFetchError("bad_url", "That is not an address.");
  }
  if (url.protocol !== "https:") throw new FileFetchError("not_https", "Files are fetched over https only.");
  if (url.username || url.password)
    throw new FileFetchError("credentials", "An address with a password in it is not used.");
  if (!isPublicHost(url.hostname)) throw new FileFetchError("not_public", `${url.hostname} is not a public address.`);
  return url;
}

export async function fetchFile(
  raw: string,
  opts: { readonly fetchImpl?: typeof fetch | undefined; readonly maxBytes: number },
): Promise<Uint8Array> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url = checkedUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "image/jpeg, image/png, image/webp, application/pdf" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FileFetchError("unreachable", `Could not fetch the file from ${url.host}.`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new FileFetchError("status", `${url.host} redirected nowhere.`);
      url = checkedUrl(new URL(location, url).toString());
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new FileFetchError("status", `${url.host} answered ${res.status} for the file.`);
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FileFetchError("too_large", "The file is larger than this inbox takes.");
    }
    return readBounded(res, opts.maxBytes);
  }
  throw new FileFetchError("redirects", "The file's address redirected too many times.");
}

async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new FileFetchError("too_large", "The file is larger than this inbox takes.");
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // closed already
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
