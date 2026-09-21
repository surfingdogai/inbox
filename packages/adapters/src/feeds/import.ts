import {
  type Capabilities,
  ensureJob,
  FEED_IMPORT_KIND,
  FEED_MAX_BYTES,
  FEED_SYNC_INTERVAL_MS,
  isPublicHost,
  type JobHandler,
  USER_AGENT,
} from "@surfingdog/core";

/**
 * Fetching a product feed (ADR-015 §7.3).
 *
 * The URL comes from the owner, which sounds harmless until you remember where the server sits. On
 * a self-hosted box `https://192.168.1.10/` is the router, and on hosted tenancy it is somebody
 * else's instance; `169.254.169.254` is the cloud metadata service and hands out credentials to
 * anything that asks. So the fetcher refuses a private destination, follows redirects by hand and
 * checks every hop rather than trusting `fetch` to land somewhere reasonable, and stops reading at
 * a size a price list has no business exceeding.
 *
 * This is not a complete answer to server-side request forgery: a hostname that resolves to a
 * private address defeats a check made on the name alone, and resolving it ourselves is not
 * something a Worker can do. It closes the cases that happen — a pasted LAN address, a metadata
 * URL, a redirect chain that ends somewhere internal — and the remaining one needs a DNS record
 * built on purpose by the person who already owns the instance.
 */

export { FEED_IMPORT_KIND };

/** A feed that redirects more than this is misconfigured, or is trying to tire us out. */
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

export interface FeedImportPayload {
  readonly connectorId: string;
}

export class FeedFetchError extends Error {
  readonly code: "blocked_host" | "bad_status" | "too_large" | "network" | "too_many_redirects";

  constructor(code: FeedFetchError["code"], message: string) {
    super(message);
    this.name = "FeedFetchError";
    this.code = code;
  }
}

/* --- Where we refuse to go ---------------------------------------------- */

/**
 * The host rule is `isPublicHost` in `@surfingdog/core`, the same one a webhook endpoint has to
 * pass. It is reused rather than reimplemented on purpose: it refuses every IP literal, every
 * IPv6 address, any name with no dot in it and the internal suffixes, which covers a pasted LAN
 * address, `localhost`, and the cloud metadata service that hands out credentials to anything
 * that asks it. Two host rules drifting apart is how one door ends up laxer than the other.
 *
 * It is not a complete answer to server-side request forgery — a public name that resolves to a
 * private address defeats any check made on the name alone, and a Worker cannot resolve it to
 * find out. Closing that needs a resolver we do not have, and opening it needs a DNS record made
 * on purpose by whoever already owns the instance.
 */
function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedFetchError("network", `this is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new FeedFetchError("blocked_host", `a feed is fetched over https, not ${url.protocol}`);
  }
  if (!isPublicHost(url.hostname)) {
    throw new FeedFetchError("blocked_host", `${url.hostname} is not a public address, so it is not fetched`);
  }
  return url;
}

/* --- Fetching ------------------------------------------------------------ */

export interface FetchFeedOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly maxBytes?: number | undefined;
}

/**
 * Downloads a feed. Redirects are followed by hand, up to three hops, and each hop is checked
 * again: a public URL that redirects to `169.254.169.254` is the whole trick.
 */
export async function fetchFeed(rawUrl: string, options: FetchFeedOptions = {}): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  let url = checkUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          accept:
            "text/csv, text/plain, application/xml, text/xml, application/rss+xml, application/atom+xml, */*;q=0.5",
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new FeedFetchError("network", `could not reach ${url.host}: ${(error as Error).message ?? error}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FeedFetchError("bad_status", `${url.host} answered ${response.status} with no location`);
      url = checkUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new FeedFetchError("bad_status", `${url.host} answered ${response.status}`);
    }

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FeedFetchError("too_large", `the feed says it is ${Math.round(declared / 1024 / 1024)}MB`);
    }
    return await readCapped(response, maxBytes);
  }
  throw new FeedFetchError("too_many_redirects", `${rawUrl} redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * Reads the body but stops at the cap. A `content-length` is a claim, not a promise, so the count
 * is done on the bytes that actually arrive, and a server that streams for ever is cut off rather
 * than allowed to fill the process.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new FeedFetchError("too_large", `the feed is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`);
      }
      chunks.push(value);
    }
  } finally {
    // Let the connection go whether we finished or gave up on it.
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

/* --- The job ------------------------------------------------------------- */

export interface FeedImportDeps {
  readonly caps: Capabilities;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly maxBytes?: number | undefined;
}

/**
 * Fetch, parse, write, and record what happened on the connector either way. A feed that is down
 * is not an error worth retrying eight times: the next scheduled import is minutes away and the
 * owner can see why this one failed, so the job succeeds with a note and leaves the connector in
 * `error` with the reason on it.
 */
export function feedImportHandler(deps: FeedImportDeps): JobHandler {
  return async (job, { db, now }) => {
    const payload = job.payload as FeedImportPayload;
    if (!payload?.connectorId) return { note: "no connector id" };
    const at = now;

    let config: Awaited<ReturnType<Capabilities["feeds"]["configFor"]>>;
    try {
      config = await deps.caps.feeds.configFor(payload.connectorId);
    } catch {
      // Disconnected. Nothing is rescheduled, so the chain ends here by itself.
      return { note: `feed ${payload.connectorId} is gone` };
    }

    // The successor is scheduled BEFORE the fetch, exactly as the network ping does it: a feed
    // that is down today must not be a feed that stops importing for ever. The dedupe key is the
    // window, so many attempts in one window still leave one job.
    const nextAt = at + FEED_SYNC_INTERVAL_MS;
    await ensureJob(db, FEED_IMPORT_KIND, `feed:${config.id}:${Math.floor(nextAt / FEED_SYNC_INTERVAL_MS)}`, {
      now: at,
      runAt: nextAt,
      payload: { connectorId: config.id },
    });
    if (!config.url) {
      await deps.caps.feeds.markError(config.id, "this feed has no URL", at);
      return { note: "no url" };
    }

    let body: string;
    try {
      body = await fetchFeed(config.url, { fetchImpl: deps.fetchImpl, maxBytes: deps.maxBytes });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      await deps.caps.feeds.markError(config.id, message, at);
      return { note: `feed ${config.id}: ${message}` };
    }

    try {
      const summary = await deps.caps.feeds.importBody(config.id, body, at);
      const parts = [`${summary.created} new`, `${summary.updated} updated`, `${summary.deactivated} gone`];
      if (summary.skipped.length > 0) parts.push(`${summary.skipped.length} skipped`);
      if (summary.truncated) parts.push("truncated");
      return { note: `feed ${config.id}: ${parts.join(", ")}` };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      return { note: `feed ${config.id}: ${message}` };
    }
  };
}
