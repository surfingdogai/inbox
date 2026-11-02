import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../../packages/core/src/phones/prefs";
import { createInbox } from "../../inbox/src/app";
import { freshDb } from "../../inbox/test/harness";
import { DEMO_ENTRY, DEMO_ORIGIN, DEMO_READ_ONLY, DemoClient, demoPath, sendQueued } from "../src/lib/client";
import type { QueuedAction } from "../src/lib/offline";
import { InboxError, type Sessions } from "../src/lib/session";

/**
 * "Try the demo" (store/play/app-content.md → App access): a Play reviewer, or anyone, opens the demo
 * shop with no code, no sign-in and no key on the phone, sees its examples on every screen, and can
 * change nothing. Against the real demo instance (INBOX_DEMO, apps/inbox/src/demo.ts), so the doors the
 * phone reads are the ones demo.surfingdog.ai answers.
 */
const OWNER = "owner@example.com";

async function demoShop() {
  const db = await freshDb();
  const inbox = createInbox({
    db,
    baseUrl: DEMO_ORIGIN,
    secretKey: "demo-test-secret-key-0123456789abcdef",
    ownerEmails: [OWNER],
    background: () => {},
    demo: { ownerEmails: [OWNER] },
  });
  await inbox.prepare();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    return inbox.app.request(url, init);
  };
  // The demo never reaches for the phone's sessions: no token, no key, no unlock.
  const sessions = new Proxy({} as Sessions, {
    get: () => {
      throw new Error("the demo used the phone's sessions");
    },
  });
  return { client: new DemoClient(sessions, fetch), calls };
}

describe("try the demo", { timeout: 30_000 }, () => {
  it("opens the demo shop with no code, no sign-in and no key, on every screen", async () => {
    const { client, calls } = await demoShop();
    expect(client.entry).toEqual(DEMO_ENTRY);

    const me = await client.me();
    expect(me.business.name).toBe("Oficina Maré");
    expect(me.push_available).toBe(false);

    const open = await client.items("all");
    expect(open.items.length).toBeGreaterThan(0);
    expect(open.items.every((v) => v.item.closedAt === null)).toBe(true);
    const recent = await client.recent();
    expect(recent.items.length).toBeGreaterThan(open.items.length);
    const aside = await client.screened("spam");
    expect(aside.items.length).toBeGreaterThan(0);
    await client.screened("held");

    const first = open.items[0]?.item.id ?? "";
    const detail = await client.item(first);
    expect(detail.item.id).toBe(first);
    expect(Array.isArray(detail.events)).toBe(true);

    // A booking's other free times, from the shop's public door as at any inbox.
    const booking = recent.items.find((v) => v.item.type === "booking");
    const serviceId = (booking?.item.payload as { reservationFor?: { serviceId?: string } } | undefined)?.reservationFor
      ?.serviceId;
    expect(serviceId).toBeTruthy();
    const from = new Date(Date.now() + 86_400_000).toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await client.slots(serviceId ?? "", from, to)).service.id).toBe(serviceId);

    // Every call went to the demo, to its read-only doors or the public one, and carried no token.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(
        c.url.startsWith(`${DEMO_ORIGIN}/demo/phone/`) || c.url.startsWith(`${DEMO_ORIGIN}/v1/availability?`),
      ).toBe(true);
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });

  it("changes nothing: every write is refused on the phone, before anything is sent", async () => {
    const { client, calls } = await demoShop();
    const refused = async (work: Promise<unknown>) => {
      const error = await work.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InboxError);
      expect((error as InboxError).message).toBe(DEMO_READ_ONLY);
      expect((error as InboxError).code).toBe("demo");
      expect((error as InboxError).offline).toBe(false);
    };
    await refused(client.transition("x", { event: "confirm" }, "k1"));
    await refused(client.reply("x", "Hello", "k2"));
    await refused(client.spamAct("x", "let-in", "k3"));
    await refused(client.setNotify(DEFAULT_PREFS));
    await refused(client.registerPush({ token: "t", p256dh: "p", auth: "a" }));
    await refused(client.test());
    await refused(client.phones());
    await refused(client.removePhone("p"));
    await refused(client.setSpamEmails({ held_digest: false }));
    await refused(client.spam());
    // What would wait to be sent from offline is dropped, never kept for later.
    const r = await sendQueued(client, {
      id: "q1",
      alias: "demo",
      itemId: "x",
      kind: "reply",
      body: { body: "Hi" },
      label: "Reply",
      key: "k4",
      at: 0,
    } satisfies QueuedAction);
    expect(r).toEqual({ ok: false, offline: false, reason: DEMO_READ_ONLY });
    expect(calls).toEqual([]);
  });

  it("reads only what a real inbox would show, at the demo's own doors", () => {
    expect(demoPath("GET", "/v1/owner/items?open_only=true&limit=40")).toBe(
      "/demo/phone/items?open_only=true&limit=40",
    );
    expect(demoPath("GET", "/v1/owner/items/01ABC")).toBe("/demo/phone/items/01ABC");
    expect(demoPath("GET", "/v1/availability?service_id=s")).toBe("/v1/availability?service_id=s");
    expect(demoPath("GET", "/v1/phone/phones")).toBeNull();
    expect(demoPath("GET", "/v1/owner/items/01ABC/payments")).toBeNull();
    expect(demoPath("POST", "/v1/owner/items/01ABC/transitions")).toBeNull();
    expect(demoPath("PUT", "/v1/phone/notify")).toBeNull();
  });
});
