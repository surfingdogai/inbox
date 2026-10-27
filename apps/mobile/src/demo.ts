import type { Deps } from "./App";
import type { Route } from "./context";
import { type Native, webNative } from "./lib/native";
import type { InboxEntry } from "./lib/session";

/**
 * Development only, never in the app's own build (main.tsx imports it behind `import.meta.env.DEV`):
 * a made-up business, Atelier Lumen, answering as an inbox would, so the screens can be seen and
 * photographed without a server. The names are the approved design's sample names.
 */
const ORIGIN = "https://inbox.atelierlumen.example";

function at(dayOffset: number, hhmm: string): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = hhmm.split(":").map(Number);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function view(
  id: string,
  type: string,
  state: string,
  payload: unknown,
  party: string | null,
  channel: string,
  createdMinAgo: number,
  transitions: { event: string; label: string }[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    item: {
      id,
      type,
      state,
      version: 1,
      partyId: `p_${id}`,
      locationId: null,
      channel,
      subject: null,
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: ago(createdMinAgo),
      updatedAt: ago(createdMinAgo),
      closedAt: null,
      payload,
      ...extra,
    },
    transitions,
    human: `${type} is ${state}.`,
    party: party ? { id: `p_${id}`, name: party, kind: "person", verified: false } : undefined,
  };
}

const eur = (value: number) => ({ value, currency: "EUR" });

function views() {
  const booking = [
    { event: "confirm", label: "Confirm booking" },
    { event: "propose", label: "Propose another time" },
    { event: "decline", label: "Decline" },
  ];
  // As the inbox says them for the owner: Maya's time is free, Lea's question was answered by a rule.
  const said = (v: ReturnType<typeof view>) =>
    v.item.id === "maya"
      ? { ...v, calendar: { free: true, clash: null } }
      : v.item.id === "lea"
        ? { ...v, by_rules: true }
        : v;
  return [
    view(
      "maya",
      "booking",
      "requested",
      {
        reservationFor: { serviceId: "cut", name: "Cut & finish" },
        startTime: at(0, "14:00"),
        endTime: at(0, "14:45"),
        totalPrice: eur(4800),
        notes: "Hi, I'd like a cut and finish this afternoon, around 2pm if you can.",
      },
      "Maya Chen",
      "mcp_public",
      2,
      booking,
    ),
    view(
      "o1042",
      "order",
      "received",
      {
        orderedItem: [
          { name: "Repair shampoo 250 ml", quantity: 1, price: eur(2400) },
          { name: "Wide-tooth comb", quantity: 1, price: eur(1250) },
        ],
        totalPrice: eur(3650),
        delivery: { method: "pickup", when: at(3, "10:00") },
      },
      "Joana Reis",
      "form",
      18,
      [
        { event: "accept", label: "Accept order" },
        { event: "decline", label: "Decline" },
      ],
    ),
    view(
      "daniel",
      "quote_request",
      "received",
      {
        itemOffered: { name: "Colour correction" },
        description: "I'd like to fix a home colour gone orange. What would it cost?",
      },
      "Daniel Okafor",
      "email",
      60,
      [{ event: "quote", label: "Send quote" }],
    ),
    view("lea", "message", "answered", { text: "Is there parking nearby?" }, "Lea Brandt", "mcp_public", 180),
    view(
      "ana",
      "booking",
      "confirmed",
      { reservationFor: { serviceId: "cut", name: "Cut" }, startTime: at(0, "09:30"), endTime: at(0, "10:00") },
      "Ana Ribeiro",
      "mcp_public",
      900,
    ),
    view(
      "tom",
      "booking",
      "confirmed",
      {
        reservationFor: { serviceId: "beard", name: "Beard trim" },
        startTime: at(0, "12:15"),
        endTime: at(0, "12:35"),
      },
      "Tom Hale",
      "form",
      1300,
    ),
    view(
      "ines",
      "booking",
      "confirmed",
      { reservationFor: { serviceId: "colour", name: "Colour" }, startTime: at(0, "16:30"), endTime: at(0, "18:00") },
      "Inês Duarte",
      "mcp_public",
      2000,
    ),
    view(
      "o1043",
      "order",
      "paid",
      {
        orderedItem: [{ name: "Hair oil", quantity: 1, price: eur(1900) }],
        totalPrice: eur(1900),
        delivery: { method: "delivery" },
      },
      "Rui Santos",
      "form",
      400,
    ),
  ].map(said);
}

/** What the spam filter held and put aside (ADR-041), as the inbox lists them for the owner. */
function screenedViews() {
  const sender = (address: string) => ({ address, company_domain: null, app: false });
  const held = [
    {
      ...view(
        "amara",
        "booking",
        "requested",
        {
          reservationFor: { serviceId: "cut", name: "Cut & finish" },
          startTime: at(1, "11:00"),
          endTime: at(1, "11:45"),
          totalPrice: eur(4800),
        },
        "Amara Nwosu",
        "form",
        40,
        [
          { event: "confirm", label: "Confirm booking" },
          { event: "decline", label: "Decline" },
        ],
      ),
      spam: {
        screen: "held",
        chip: "Many new requests",
        cause: "many_new",
        may_be_customer: true,
        certain: true,
        sender: sender("amara.nwosu@example.com"),
      },
    },
    {
      ...view(
        "bulk",
        "order",
        "received",
        {
          orderedItem: [{ name: "Repair shampoo 250 ml", quantity: 60, price: eur(2400) }],
          totalPrice: eur(144000),
          delivery: { method: "delivery" },
        },
        null,
        "mcp_public",
        300,
      ),
      spam: {
        screen: "held",
        chip: "Sent many times",
        cause: "wave",
        may_be_customer: false,
        certain: true,
        sender: sender("orders@bulk-supply.example"),
      },
    },
  ];
  const aside = [
    {
      ...view(
        "rank",
        "message",
        "spam",
        {
          text: "We guarantee your salon the top 3 search results in 30 days with our backlink package. Free audit?",
        },
        "Ravi Kumar",
        "form",
        90,
        [{ event: "unspam", label: "Not spam" }],
      ),
      spam: {
        screen: "aside",
        chip: "Sales pitch",
        cause: "pitches",
        may_be_customer: false,
        certain: false,
        sender: sender("ravi@rankboost.example"),
      },
    },
  ];
  return { held, aside };
}

/** What the item screen says about one of them: our reasons, and the passage the AI check found. */
function why(id: string) {
  if (id === "amara")
    return {
      verdict: "hold",
      reasons: ["This sender made 6 new requests today."],
      quotes: [],
      by: "spam_filter",
      learning: false,
      released_by: null,
      at: ago(40),
    };
  if (id === "rank")
    return {
      verdict: "aside",
      reasons: ["Sales pitch: SEO."],
      quotes: ["We guarantee your salon the top 3 search results in 30 days"],
      by: "ai_check",
      learning: false,
      released_by: null,
      at: ago(90),
    };
  return {
    verdict: "hold",
    reasons: ["The same message came from 14 senders this week."],
    quotes: [],
    by: "spam_filter",
    learning: false,
    released_by: null,
    at: ago(300),
  };
}

function slots() {
  const out: { startTime: string }[] = [];
  const lists = [
    ["10:00", "11:30", "16:00", "17:15"],
    ["13:00", "15:30", "16:15", "17:00"],
    ["09:30", "12:00", "14:30", "18:00"],
    ["10:45", "13:15", "15:00", "16:30"],
  ];
  lists.forEach((times, i) => {
    for (const t of times) out.push({ startTime: at(i + 1, t) });
  });
  return { service: { id: "cut", name: "Cut & finish", durationMin: 45 }, slots: out };
}

export async function demoDeps(q: URLSearchParams): Promise<Deps> {
  const offline = q.has("offline");
  const base = webNative(null);
  const store = new Map<string, string>();
  const entries: InboxEntry[] = [
    { alias: "ib_al", origin: ORIGIN, name: "Atelier Lumen", deviceId: "d1", addedAt: 0 },
    { alias: "ib_cn", origin: "https://inbox.cafenorte.example", name: "Café Norte", deviceId: "d2", addedAt: 0 },
    { alias: "ib_sk", origin: "https://inbox.studiokiln.example", name: "Studio Kiln", deviceId: "d3", addedAt: 0 },
  ];
  if (!q.has("fresh")) store.set("inboxes", JSON.stringify(entries));
  for (const e of entries) store.set(`tokens.${e.alias}`, "sdi_pr_demo");
  const native: Native = {
    ...base,
    deviceName: async () => "Pixel 8",
    secureGet: async (k) => store.get(k) ?? null,
    secureSet: async (k, v) => void store.set(k, v),
    secureRemove: async (k) => void store.delete(k),
    sign: async () => "demo",
    pushStatus: async () => ({ available: true, permission: "granted" }),
  };
  const all = views();
  const screened = screenedViews();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (offline) throw new TypeError("offline");
    const url = new URL(input);
    const path = url.pathname;
    if (path === "/v1/phone/token")
      return json({ access_token: "sdi_pa_demo", expires_in: 600, refresh_token: "sdi_pr_demo", device_id: "d1" });
    if (path === "/v1/phone/me")
      return json({
        phone: { id: "d1", name: "Pixel 8", push: "on" },
        notify: {
          kinds: { booking: true, order: true, quote: true, message: true, handled: false },
          quiet: { on: true, from: "21:00", to: "08:00" },
          details: false,
        },
        business: {
          name: url.host.includes("cafenorte")
            ? "Café Norte"
            : url.host.includes("kiln")
              ? "Studio Kiln"
              : "Atelier Lumen",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        push_available: true,
      });
    if (path === "/v1/phone/phones")
      return json({
        phones: [
          { id: "d1", name: "Pixel 8", created_at: ago(9000), last_seen_at: ago(1), push: "on" },
          { id: "d9", name: "Galaxy A54", created_at: ago(20000), last_seen_at: ago(2 * 1440), push: "on" },
        ],
        this: "d1",
      });
    if (path === "/v1/phone/notify") return json({ notify: JSON.parse(String(init?.body ?? "{}")) });
    if (path === "/v1/phone/spam" || path === "/v1/phone/spam/emails")
      return json({
        filters: ["pitches", "scams"],
        held_now: screened.held.length,
        this_week: { aside: 23 },
        emails: { held_digest: true, weekly_summary: true, ...JSON.parse(String(init?.body ?? "{}")) },
      });
    if (path === "/v1/availability") return json(slots());
    if (path === "/v1/owner/items") {
      if (url.searchParams.get("screen") === "held") return json({ items: screened.held, next_cursor: null });
      if (url.searchParams.get("state") === "spam") return json({ items: screened.aside, next_cursor: null });
      const items = url.host.includes("kiln") ? [] : url.host.includes("cafenorte") ? all.slice(1, 2) : all;
      return json({ items, next_cursor: null });
    }
    const m = /^\/v1\/owner\/items\/([^/]+)$/.exec(path);
    if (m) {
      const v = all.find((x) => x.item.id === m[1]);
      const s = [...screened.held, ...screened.aside].find((x) => x.item.id === m[1]);
      if (s)
        return json({ ...s, spam: { ...s.spam, ...why(s.item.id) }, events: [], thread: [], mail: [], draft: null });
      return v ? json({ ...v, events: [], thread: [], mail: [], draft: null }) : json({ detail: "Not found" }, 404);
    }
    return json({ ok: true });
  };
  const screen = q.get("screen");
  const initial: Route | undefined =
    screen === "item" || screen === "propose" || screen === "confirm"
      ? { name: "item", id: q.get("id") ?? "maya", action: screen === "item" ? undefined : screen }
      : screen === "today" || screen === "settings" || screen === "inboxes" || screen === "connect"
        ? { name: screen }
        : screen === "held" || screen === "spam"
          ? { name: "screened", which: screen }
          : undefined;
  return { native, fetch: fetchImpl, kv: localStorage, allowLocal: true, initial };
}
