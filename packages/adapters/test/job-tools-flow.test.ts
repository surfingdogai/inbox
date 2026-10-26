import {
  type Caller,
  Capabilities,
  createSecretBox,
  pushRequest,
  transitionItem,
  ulid,
  WORK_PUSH_KIND,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { servicem8Connector } from "../src/index";
import { freshDb } from "./db";
import { fakePlatform } from "./fakes/platform";
import { fakeServiceM8 } from "./fakes/work";

/**
 * A request into the owner's job tool (ADR-039 §5), through the inbox: only as the owner chose
 * (default: the ones they take on, when they quote one or press Send), never a test request, never by
 * the owner's AI, once however often it is asked. Against a local ServiceM8.
 */

const T0 = Date.parse("2026-11-04T07:30:00Z");
const BASE = "https://fundiflow.example";

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
});
const ai: Caller = {
  actor: { kind: "owner_ai", id: "app_1", channel: "mcp_owner" },
  actsAs: "owner",
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
  principal: { via: "oauth", id: "app_1", name: "An assistant", scopes: ["*"], userId: "u1" },
};
const anon = (sandbox = false): Caller => ({
  actor: { kind: "customer_agent", id: `anon:${ulid()}`, channel: "mcp_public" },
  tier: "anonymous",
  sandbox,
  now: () => T0,
});

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function setup(jobTool?: "every" | "accepted" | "never") {
  const { db } = await freshDb();
  const caps = new Capabilities(db, createSecretBox(["job-tool-flow-instance-key-0123456789"]), BASE);
  const p = fakePlatform();
  const sm8 = fakeServiceM8(p);
  caps.connectors.attach({ definitions: [servicem8Connector()], http: p.http });
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Fundi Flow Plumbing", currency: "KES", timezone: "Africa/Nairobi" },
      doors: { quoteRequest: true },
      ...(jobTool ? { work: { jobTool } } : {}),
    },
  });
  const conn = await caps.connectors.connect(owner(), { kind: "servicem8", values: { api_key: sm8.key } });
  return { db, caps, p, sm8, conn };
}

const request = (caps: Capabilities, sandbox = false) =>
  caps.requestQuote(anon(sandbox), {
    payload: {
      itemOffered: { name: "Blocked drain" },
      description: "The kitchen drain is blocked.",
      job: { urgency: "within_24h", visit: "needed" },
    },
    contact: { name: "Achieng Otieno", email: "achieng@example.com" },
    attachments: [{ data_base64: b64(JPEG), name: "drain.jpg" }],
  });

const jobs = (sm8: ReturnType<typeof fakeServiceM8>) => [...sm8.records.values()].filter((r) => r.status === "Quote");

describe("requests into the job tool", () => {
  it("go in, by default, only once the owner takes them on: when they quote", async () => {
    const s = await setup();
    const q = await request(s.caps);
    const id = q.view.item.id;
    // A job is queued for the request (the tool is connected), and it sends nothing in this mode.
    const { rows } = await s.db.client.query({
      sql: "SELECT COUNT(*) FROM jobs WHERE kind = ?",
      params: [WORK_PUSH_KIND],
    });
    expect(Number(rows[0]?.[0])).toBe(1);
    expect((await pushRequest(s.db, s.caps.connectors, id, "created", T0))[0]).toMatchObject({ status: "skipped" });
    expect(jobs(s.sm8)).toHaveLength(0);
    await transitionItem(s.db, owner(), {
      itemId: id,
      event: "quote",
      input: { totalPrice: { value: 450_000, currency: "KES" } },
    });
    const pushed = await pushRequest(s.db, s.caps.connectors, id, "quoted", T0 + 60_000);
    expect(pushed[0]).toMatchObject({ status: "written", kind: "servicem8" });
    expect(jobs(s.sm8)).toHaveLength(1);
    expect(s.sm8.attachments[0]?.file).toMatch(/^file:drain\.jpg:/);
    const view = await s.caps.trades.jobTool(owner(), id);
    expect(view.sent[0]).toMatchObject({
      outcome: "written",
      url: expect.stringMatching(/^https:\/\/go\.servicem8\.com\/OpenJob\//),
    });
    // Asked again (a second quote, the owner's press): there already, nothing made twice.
    expect((await pushRequest(s.db, s.caps.connectors, id, "sent", T0 + 120_000))[0]).toMatchObject({
      status: "written",
      note: "there already",
    });
    expect(jobs(s.sm8)).toHaveLength(1);
  });

  it("go in as they arrive when the owner sends every one, and never as a test", async () => {
    const s = await setup("every");
    const q = await request(s.caps);
    expect((await pushRequest(s.db, s.caps.connectors, q.view.item.id, "created", T0))[0]).toMatchObject({
      status: "written",
    });
    const test = await request(s.caps, true);
    expect((await pushRequest(s.db, s.caps.connectors, test.view.item.id, "created", T0))[0]).toMatchObject({
      status: "skipped",
      note: "a test request never goes to a job tool",
    });
    expect(jobs(s.sm8)).toHaveLength(1);
  });

  it("are sent by hand only by a person at the business, and not at all when the owner sends none", async () => {
    const s = await setup();
    const q = await request(s.caps);
    await expect(s.caps.trades.sendToJobTool(ai, q.view.item.id)).rejects.toMatchObject({
      details: { reason: "person_only" },
    });
    const sent = await s.caps.trades.sendToJobTool(owner(), q.view.item.id);
    expect(sent.outcomes[0]).toMatchObject({ status: "written" });
    const never = await setup("never");
    const r = await request(never.caps);
    await expect(never.caps.trades.sendToJobTool(owner(), r.view.item.id)).rejects.toMatchObject({
      details: { reason: "job_tool_never" },
    });
    expect((await pushRequest(never.db, never.caps.connectors, r.view.item.id, "quoted", T0))[0]).toMatchObject({
      status: "skipped",
    });
    expect(jobs(never.sm8)).toHaveLength(0);
  });

  it("start from the tool's opening hours, read for the owner and kept by nobody but them", async () => {
    const s = await setup();
    const snap = await s.caps.connectors.setupSnapshot(owner(), s.conn.id);
    expect(snap.source).toMatchObject({ kind: "servicem8", zone: "Africa/Nairobi" });
    expect(snap.hours?.mon).toEqual([["08:00", "17:00"]]);
    expect(snap.hours?.sun).toBeUndefined();
    // Reading changes nothing: the inbox's hours are the owner's to keep, through Availability.
    const before = JSON.stringify(await s.caps.setup.getAvailability(owner()));
    await s.caps.connectors.setupSnapshot(owner(), s.conn.id);
    expect(JSON.stringify(await s.caps.setup.getAvailability(owner()))).toBe(before);
    await expect(s.caps.connectors.setupSnapshot(anon(), s.conn.id)).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("leave the business's job tool alone once it is disconnected", async () => {
    const s = await setup("every");
    await s.caps.connectors.remove(owner(), s.conn.id);
    const q = await request(s.caps);
    expect(await pushRequest(s.db, s.caps.connectors, q.view.item.id, "created", T0)).toEqual([]);
    expect(jobs(s.sm8)).toHaveLength(0);
  });
});
