import { createDb, type Db } from "@surfingdog/core";
import { logMailOut, type SqliteClient } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox, type Inbox } from "../src/app";
import { freshDb } from "./harness";
import { expectAnswered, modern, modernHeaders, WIRE_CASES, within } from "./mcp-wire";

/**
 * Every request to the MCP door is answered, in demo mode and out of it, on Node and in workerd.
 *
 * On 24 Sep 2026 the public demo shop left some requests to /mcp without any answer. These hold the
 * door to an answer for everything a client can send, and hold the things that could leave a request
 * waiting on something that will never come: a body copied and never read, and a check one request
 * started that another request waits on, which on Workers stops for good if its own request is
 * cancelled. Each case fails in seconds, not at the suite's timeout.
 */
const BASE = "https://door.test";
const OWNER = "owner@example.com";

function inboxOn(db: Db, demo: boolean): Inbox {
  return createInbox({
    db,
    mailOut: logMailOut(),
    baseUrl: BASE,
    secretKey: "door-test-secret-key-0123456789abcdef",
    ownerEmails: [OWNER],
    background: () => {},
    ...(demo ? { demo: { ownerEmails: [OWNER] } } : {}),
  });
}

/** A client over `base` whose first query matching `hang` never answers, as a cancelled request's I/O never does. */
function oneQueryNeverAnswers(base: SqliteClient, hang: RegExp): { client: SqliteClient; hung: () => boolean } {
  let armed = true;
  let hung = false;
  const client: SqliteClient = {
    ...base,
    query: (q) => {
      if (armed && hang.test(q.sql)) {
        armed = false;
        hung = true;
        return new Promise(() => {});
      }
      return base.query(q);
    },
    batch: (qs) => base.batch(qs),
  };
  return { client, hung: () => hung };
}

const toolsList = () =>
  new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": "203.0.113.80",
      ...modernHeaders("tools/list"),
    },
    body: JSON.stringify(modern(1, "tools/list")),
  });

for (const demo of [false, true]) {
  describe(demo ? "the MCP door of a demo shop" : "the MCP door", () => {
    for (const c of WIRE_CASES) {
      it(`answers ${c.name}`, async () => {
        const inbox = inboxOn(await freshDb(), demo);
        await inbox.prepare();
        await expectAnswered((init) => inbox.app.request(`${BASE}/mcp`, init), c, {
          "cf-connecting-ip": "203.0.113.81",
        });
      });
    }

    it("answers a body sent as a stream of unknown length", async () => {
      const inbox = inboxOn(await freshDb(), demo);
      await inbox.prepare();
      const bytes = new TextEncoder().encode(JSON.stringify(modern(1, "tools/list")));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 20));
          controller.enqueue(bytes.slice(20));
          controller.close();
        },
      });
      const res = await within(
        inbox.app.request(`${BASE}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", ...modernHeaders("tools/list") },
          body,
          duplex: "half",
        } as RequestInit),
        "a streamed body",
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
    });

    it("answers while a request that came first is still waiting on its migrations check", async () => {
      const base = await freshDb();
      const { client, hung } = oneQueryNeverAnswers(base.client, /FROM migrations/i);
      const inbox = inboxOn(createDb(client), demo);
      // The first request's check never finishes, as it never would on Workers once that request
      // was cancelled. The next request must not wait on it.
      void inbox.app.request(toolsList());
      await within(
        (async () => {
          while (!hung()) await new Promise((r) => setTimeout(r, 1));
        })(),
        "the first request reaching its check",
      );
      const res = await within(inbox.app.request(toolsList()), "the second request");
      expect(res.status).toBe(200);
    });
  });
}

describe("the MCP door of a demo shop, before it knows it is one", () => {
  it("answers while a request that came first is still waiting on the demo check", async () => {
    const base = await freshDb();
    const { client, hung } = oneQueryNeverAnswers(base.client, /from "business"/i);
    const inbox = inboxOn(createDb(client), true);
    void inbox.app.request(toolsList());
    await within(
      (async () => {
        while (!hung()) await new Promise((r) => setTimeout(r, 1));
      })(),
      "the first request reaching the demo check",
    );
    const res = await within(inbox.app.request(toolsList()), "the second request");
    expect(res.status).toBe(200);
    // And the shop was set up by the request that could: the live view is there.
    expect((await within(inbox.app.request(`${BASE}/demo/live.json`), "the live view")).status).toBe(200);
  });

  it("seeds once when requests meet an empty demo together, and every one is answered", async () => {
    const db = await freshDb();
    const inbox = inboxOn(db, true);
    const answers = await within(
      Promise.all(Array.from({ length: 6 }, () => inbox.app.request(toolsList()))),
      "six at once",
    );
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const { rows } = await db.client.query({ sql: "SELECT COUNT(*) FROM services", method: "all" });
    const once = Number(rows[0]?.[0]);
    await inbox.prepare();
    const again = await db.client.query({ sql: "SELECT COUNT(*) FROM services", method: "all" });
    expect(once).toBeGreaterThan(0);
    expect(Number(again.rows[0]?.[0])).toBe(once);
  });

  it("stays the demo shop when another request claims the empty database between its two checks", async () => {
    // The first request finds no shop, then asks whether the database is empty only after the
    // second request has claimed it and begun seeding. It must not take the shop it meets for
    // someone else's data: that would refuse the demo for as long as this process lives.
    const base = await freshDb();
    let held = false;
    const client: SqliteClient = {
      ...base.client,
      query: async (q) => {
        if (!held && /SELECT EXISTS \(SELECT 1 FROM business\)/.test(q.sql)) {
          held = true;
          await new Promise((r) => setTimeout(r, 300));
        }
        return base.client.query(q);
      },
      batch: (qs) => base.client.batch(qs),
    };
    const inbox = inboxOn(createDb(client), true);
    const answers = await within(
      Promise.all([inbox.app.request(toolsList()), inbox.app.request(toolsList())]),
      "two at once",
    );
    expect(held).toBe(true);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect((await within(inbox.app.request(`${BASE}/demo/live.json`), "the live view")).status).toBe(200);
    await within(inbox.prepare(), "prepare");
  });

  it("carries a live-view reading others share past its own request, on Workers by waitUntil", async () => {
    const inbox = inboxOn(await freshDb(), true);
    await inbox.prepare();
    const kept: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void kept.push(p), passThroughOnException: () => {}, props: {} };
    const poll = () => inbox.app.fetch(new Request(`${BASE}/demo/live.json`), {}, ctx as never);
    const [a, b] = await within(Promise.all([poll(), poll()]), "two polls");
    expect([a.status, b.status]).toEqual([200, 200]);
    // One reading, shared, and handed to the context of the request that started it.
    expect(kept.length).toBe(1);
    await within(Promise.all(kept), "the kept reading");
  });
});

describe("the MCP door reads a body once", () => {
  it("copies no request and reads the body once, whatever it holds", async () => {
    const inbox = inboxOn(await freshDb(), false);
    await inbox.prepare();
    for (const c of WIRE_CASES.filter((w) => w.method === undefined)) {
      let copies = 0;
      const req = new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...c.headers },
        body: c.body,
      });
      const clone = req.clone.bind(req);
      req.clone = (() => {
        copies++;
        return clone();
      }) as typeof req.clone;
      const res = await within(inbox.app.request(req), c.name);
      await res.text();
      expect(copies, c.name).toBe(0);
      expect(req.bodyUsed, c.name).toBe(true);
    }
  });
});
