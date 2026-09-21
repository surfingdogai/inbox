import { type Caller, FEED_IMPORT_KIND, isPublicHost } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { FeedFetchError, feedImportHandler, fetchFeed } from "../src/feeds/index";
import { freshDb } from "./db";

/**
 * Fetching a feed (ADR-015 §7.3). The URL is the owner's, and the server that fetches it sits
 * inside a network the owner is not the only tenant of, so where it is allowed to go matters more
 * than what it brings back.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");

const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

const CSV = "id,title,price\nA1,Chain lube,8.50\n";

function reply(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/csv" }, ...init });
}

describe("where a feed may be fetched from", () => {
  it("refuses this machine, this network, and the metadata service", async () => {
    const refused = [
      "https://localhost/feed.csv",
      "https://127.0.0.1/feed.csv",
      "https://192.168.1.10/feed.csv",
      "https://10.0.0.5/feed.csv",
      "https://172.16.4.4/feed.csv",
      "https://169.254.169.254/latest/meta-data/",
      "https://nas.local/feed.xml",
      "https://backups.internal/feed.csv",
      "https://[::1]/feed.csv",
      "https://2130706433/feed.csv",
    ];
    for (const url of refused) {
      const never = (): never => {
        throw new Error(`fetched ${url}, which must never happen`);
      };
      await expect(fetchFeed(url, { fetchImpl: never as unknown as typeof fetch }), url).rejects.toThrow(
        FeedFetchError,
      );
    }
  });

  it("uses the same host rule a webhook endpoint has to pass", () => {
    // Not a second allow-list: one drifting from the other is how a door ends up laxer.
    expect(isPublicHost("shop.example.com")).toBe(true);
    expect(isPublicHost("192.168.1.10")).toBe(false);
  });

  it("refuses plain http, so a price list cannot be rewritten on the way", async () => {
    await expect(fetchFeed("http://shop.example.com/feed.csv")).rejects.toThrow(/https/);
  });
});

describe("fetching", () => {
  it("brings back the body", async () => {
    const body = await fetchFeed("https://shop.example.com/feed.csv", {
      fetchImpl: async () => reply(CSV),
    });
    expect(body).toBe(CSV);
  });

  it("follows a redirect but checks where it lands", async () => {
    const hops: string[] = [];
    const body = await fetchFeed("https://shop.example.com/feed", {
      fetchImpl: async (input) => {
        const url = String(input);
        hops.push(url);
        if (hops.length === 1) {
          return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/feed.csv" } });
        }
        return reply(CSV);
      },
    });
    expect(body).toBe(CSV);
    expect(hops[1]).toBe("https://cdn.example.com/feed.csv");
  });

  it("refuses a redirect into the private network, which is the whole trick", async () => {
    await expect(
      fetchFeed("https://shop.example.com/feed", {
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
      }),
    ).rejects.toThrow(FeedFetchError);
  });

  it("gives up rather than following a redirect loop", async () => {
    await expect(
      fetchFeed("https://shop.example.com/feed", {
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "https://shop.example.com/feed" } }),
      }),
    ).rejects.toThrow(/redirected more than/);
  });

  it("stops at the size cap even when content-length lied", async () => {
    const big = "x".repeat(4096);
    await expect(
      fetchFeed("https://shop.example.com/feed.csv", {
        maxBytes: 1024,
        fetchImpl: async () => reply(big),
      }),
    ).rejects.toThrow(/larger than/);
  });

  it("believes a content-length that is over the cap without downloading it", async () => {
    await expect(
      fetchFeed("https://shop.example.com/feed.csv", {
        maxBytes: 1024,
        fetchImpl: async () => reply("small", { headers: { "content-length": "99999999" } }),
      }),
    ).rejects.toThrow(/says it is/);
  });

  it("reports a bad status rather than parsing an error page", async () => {
    await expect(
      fetchFeed("https://shop.example.com/feed.csv", {
        fetchImpl: async () => new Response("<h1>Not found</h1>", { status: 404 }),
      }),
    ).rejects.toThrow(/answered 404/);
  });
});

describe("the import job", () => {
  it("imports a feed and reports what it did", async () => {
    const { db, caps } = await freshDb();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const handler = feedImportHandler({ caps, fetchImpl: async () => reply(CSV) });

    const result = await handler({ id: "job_1", kind: FEED_IMPORT_KIND, payload: { connectorId: feed.id } } as never, {
      db,
      now: T0,
    });
    expect(result?.note).toContain("1 new");
    expect((await caps.feeds.get(owner, feed.id)).product_count).toBe(1);
    expect((await caps.feeds.get(owner, feed.id)).status).toBe("active");
  });

  it("puts the reason on the connector when the feed is down, and does not throw", async () => {
    const { db, caps } = await freshDb();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    const handler = feedImportHandler({
      caps,
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });

    // A feed being down is not a job that should be retried eight times: the next run is minutes
    // away, and the owner needs to see why rather than watch a job queue thrash.
    const result = await handler({ id: "job_1", kind: FEED_IMPORT_KIND, payload: { connectorId: feed.id } } as never, {
      db,
      now: T0,
    });
    expect(result?.note).toContain("503");
    const after = await caps.feeds.get(owner, feed.id);
    expect(after.status).toBe("error");
    expect(after.last_error).toContain("503");
  });

  it("schedules the next import before fetching, so a feed that is down still runs tomorrow", async () => {
    const { db, caps } = await freshDb();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await db.client.query({ sql: "DELETE FROM jobs", method: "run" });

    const handler = feedImportHandler({ caps, fetchImpl: async () => new Response("down", { status: 503 }) });
    await handler({ id: "job_1", kind: FEED_IMPORT_KIND, payload: { connectorId: feed.id } } as never, {
      db,
      now: T0,
    });

    const { rows } = await db.client.query({
      sql: "SELECT kind, run_at FROM jobs WHERE kind = ?",
      params: [FEED_IMPORT_KIND],
      method: "all",
    });
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as unknown[])[1])).toBeGreaterThan(T0);
  });

  it("leaves one job per window however many times it runs", async () => {
    const { db, caps } = await freshDb();
    const feed = await caps.feeds.add(owner, { url: "https://shop.example.com/feed.csv" });
    await db.client.query({ sql: "DELETE FROM jobs", method: "run" });
    const handler = feedImportHandler({ caps, fetchImpl: async () => reply(CSV) });
    const job = { id: "job_1", kind: FEED_IMPORT_KIND, payload: { connectorId: feed.id } } as never;

    await handler(job, { db, now: T0 });
    await handler(job, { db, now: T0 + 1000 });

    const { rows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [FEED_IMPORT_KIND],
      method: "all",
    });
    expect(Number((rows[0] as unknown[])[0])).toBe(1);
  });

  it("shrugs at a job for a feed that has been disconnected", async () => {
    const { db, caps } = await freshDb();
    const handler = feedImportHandler({ caps, fetchImpl: async () => reply(CSV) });
    const result = await handler({ id: "job_1", kind: FEED_IMPORT_KIND, payload: { connectorId: "gone" } } as never, {
      db,
      now: T0,
    });
    expect(result?.note).toContain("gone");
  });
});
