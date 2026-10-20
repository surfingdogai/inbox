import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKey } from "@surfingdog/adapters";
import { customerCopyProblems } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { STRIPE_LIVE_KEY } from "../../../packages/adapters/test/fixtures/payments";
import { createInbox } from "../src/app";
import { confirmed, confirmedTool, freshDb } from "./harness";
import { stripePlatform } from "./pay-platforms";

/**
 * A salon end to end (ADR-035), through the inbox's own doors: the owner sets up staff and a service
 * with a deposit; a customer's assistant reads who it can book (first names only), finds a time with
 * someone, and books it; once the owner confirms, the deposit's link is made on the business's own
 * Stripe, in won, which has no minor unit; paid, it is recorded on the booking. Mapo Barber Lab, Seoul.
 */
const BASE = "https://inbox.example.com";
const SECRET_KEY = "salons-app-secret-0123456789abcdefghijkl";

async function salon() {
  const db = await freshDb();
  const stripe = stripePlatform(STRIPE_LIVE_KEY, BASE);
  const inbox = createInbox({
    db,
    mailOut: logMailOut(),
    secretKey: SECRET_KEY,
    baseUrl: BASE,
    eventSettleMs: 0,
    background: () => {},
    fetchImpl: stripe.fetch,
  });
  const owner = { authorization: `Bearer ${(await createApiKey(db, { kind: "owner", name: "cli" })).key}` };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...owner, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };
  await call("PUT", "/v1/owner/settings", {
    doc: {
      business: { name: "Mapo Barber Lab", currency: "KRW", timezone: "Asia/Seoul", languages: ["ko", "en"] },
      email: { fromAddress: "hello@mapo-barber.example" },
      notifications: { ownerEmail: "owner@mapo-barber.example", appUrl: BASE },
      booking: { minNoticeMin: 60 },
    },
  });
  const day: [string, string][] = [["10:00", "20:00"]];
  await call("PUT", "/v1/owner/availability", {
    weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  });
  await call("POST", "/v1/owner/integrations", { kind: "stripe", values: { api_key: STRIPE_LIVE_KEY } });
  const cut = await call("POST", "/v1/owner/services", {
    name: "Two-block cut",
    duration_min: 40,
    granularity_min: 20,
    price: { model: "fixed", value: 35_000, currency: "KRW" },
    deposit: { kind: "percent", value: 30 },
    add_ons: [{ name: "Scalp massage", duration_min: 20, price: { value: 10_000, currency: "KRW" } }],
  });
  const jiho = await call("POST", "/v1/owner/staff", {
    name: "Kim Ji-ho",
    public_name: "Ji-ho",
    services: [{ service_id: cut.id }],
  });
  // Family name first, as written in Seoul: the owner says the name customers see.
  const seo = await call("POST", "/v1/owner/staff", {
    name: "Park Seo-yeon",
    public_name: "Seo-yeon",
    sort: 1,
    services: [{ service_id: cut.id }],
  });
  return { db, inbox, call, stripe, cut: String(cut.id), jiho: String(jiho.id), seo: String(seo.id) };
}

async function mcp(app: ReturnType<typeof createInbox>["app"]) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (input: string | URL, init?: RequestInit) => app.request(String(input), init),
  });
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(transport);
  return client;
}

/** Tomorrow and the day after, in Seoul. */
const seoulDay = (days: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 86_400_000));

describe("a salon, end to end", () => {
  it("lists its staff by first name to an assistant, which books one, and the deposit is asked in won", async () => {
    const s = await salon();
    const client = await mcp(s.inbox.app);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_staff");
    const staff = (await client.callTool({ name: "list_staff", arguments: {} })).structuredContent as {
      items: { id: string; name: string }[];
    };
    expect(staff.items.map((x) => x.name)).toEqual(["Ji-ho", "Seo-yeon"]);
    const date = seoulDay(2);
    const times = await client.callTool({
      name: "check_availability",
      arguments: { service_id: s.cut, from: `${date}T10:00:00+09:00`, to: `${date}T12:00:00+09:00`, staff_id: "any" },
    });
    const text = (times.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("with Ji-ho, Seo-yeon");
    const booked = (await confirmedTool((p) => client.callTool(p), {
      name: "create_booking",
      arguments: {
        payload: {
          reservationFor: { serviceId: s.cut, name: "Two-block cut" },
          startTime: `${date}T10:00:00+09:00`,
          endTime: `${date}T10:40:00+09:00`,
        },
        staff_id: s.seo,
        contact: { name: "Lee Min-jun", email: "minjun@example.com", locale: "ko" },
        idempotency_key: "mapo-mcp-1",
      },
    })) as { structuredContent: { view: { item: { id: string; payload: Record<string, unknown> } } } };
    const item = booked.structuredContent.view.item;
    expect(item.payload.staffName).toBe("Seo-yeon");
    expect(item.payload.deposit).toMatchObject({ amount: { value: 10_500, currency: "KRW" }, refundable: true });

    // The owner confirms: the deposit's link is made on the business's own Stripe, for ₩10,500 as 10500.
    await s.call("POST", `/v1/owner/items/${item.id}/transitions`, { event: "confirm" });
    await s.inbox.caps.connectors.payments.ensure(item.id, Date.now());
    const links = [...s.stripe.links.values()];
    expect(links.map((l) => [l.amount, l.currency, l.submit])).toEqual([[10_500, "krw", "book"]]);
    expect(links[0]?.name).toContain("Two-block cut (");
    // Paid on Stripe, it is recorded on the booking, read back with the business's own key.
    const hook = await s.inbox.app.request(await s.stripe.pay(links[0]?.id ?? ""));
    expect(hook.status).toBe(200);
    const detail = await s.call("GET", `/v1/owner/items/${item.id}`);
    expect((detail.item as { payload: { paidAmount?: unknown } }).payload.paidAmount).toEqual({
      value: 10_500,
      currency: "KRW",
    });
    // The day by staff has it in Seo-yeon's column.
    const dayView = (await s.call("GET", `/v1/owner/staff/day?date=${date}`)) as {
      columns: { staff: { id: string } | null; bookings: { id: string }[] }[];
    };
    expect(dayView.columns.find((c) => c.staff?.id === s.seo)?.bookings.map((b) => b.id)).toEqual([item.id]);
  });

  it("books an add-on longer and dearer, and says so before it binds, in words customers may read", async () => {
    const s = await salon();
    const services = (await s.call("GET", "/v1/owner/services")) as {
      items: { id: string; addOns: { id: string }[] | null }[];
    };
    const massage = services.items.find((x) => x.id === s.cut)?.addOns?.[0]?.id ?? "";
    const date = seoulDay(3);
    const first = await s.inbox.app.request(
      new Request(`${BASE}/v1/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "mapo-rest-1" },
        body: JSON.stringify({
          payload: {
            reservationFor: { serviceId: s.cut, name: "Two-block cut" },
            startTime: `${date}T14:00:00+09:00`,
            endTime: `${date}T14:40:00+09:00`,
          },
          add_ons: [massage],
          contact: { name: "Choi Yuna", email: "yuna@example.com" },
        }),
      }),
    );
    expect(first.status).toBe(409);
    const problem = (await first.json()) as { details: { summary: string } };
    expect(problem.details.summary).toContain("With Ji-ho.");
    expect(problem.details.summary).toContain("Added: Scalp massage.");
    expect(problem.details.summary).toMatch(/A deposit of ₩13,500 keeps it/);
    expect(customerCopyProblems([problem.details.summary])).toEqual([]);
    const res = await confirmed(
      (r) => s.inbox.app.request(r),
      new Request(`${BASE}/v1/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "mapo-rest-1" },
        body: JSON.stringify({
          payload: {
            reservationFor: { serviceId: s.cut, name: "Two-block cut" },
            startTime: `${date}T14:00:00+09:00`,
            endTime: `${date}T14:40:00+09:00`,
          },
          add_ons: [massage],
          contact: { name: "Choi Yuna", email: "yuna@example.com" },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { view: { item: { payload: { endTime: string; totalPrice: unknown } } } };
    // Twenty minutes longer, ₩10,000 more.
    expect(Date.parse(body.view.item.payload.endTime)).toBe(Date.parse(`${date}T15:00:00+09:00`));
    expect(body.view.item.payload.totalPrice).toEqual({ value: 45_000, currency: "KRW" });
  });

  it("shows agents a staff photo at its own address, with no metadata and no other content type", async () => {
    const s = await salon();
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x11, 0x22, 0xff, 0xd9,
    ]);
    await s.call("PATCH", `/v1/owner/staff/${s.jiho}`, {
      photo: `data:image/jpeg;base64,${btoa(String.fromCharCode(...jpeg))}`,
    });
    const listed = (await (await s.inbox.app.request(`${BASE}/v1/staff`)).json()) as {
      items: { id: string; photo_url?: string }[];
    };
    const url = listed.items.find((x) => x.id === s.jiho)?.photo_url ?? "";
    expect(url).toBe(`${BASE}/v1/staff/${s.jiho}/photo.jpg`);
    const photo = await s.inbox.app.request(url);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await photo.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("Exif");
    // Someone who left is not shown.
    await s.call("DELETE", `/v1/owner/staff/${s.jiho}`);
    expect((await s.inbox.app.request(url)).status).toBe(404);
  });
});
