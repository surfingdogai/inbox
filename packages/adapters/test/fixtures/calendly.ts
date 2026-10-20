import { hmacSha256Hex } from "../../src/index";
import { type FakePlatform, fakePlatform, json } from "../fakes/platform";

/**
 * Calendly as its API v2 documents it (ADR-030), for the Calendly connector's tests: no test calls
 * Calendly. Shapes follow the documented examples, read 20 October 2026:
 *
 * - `GET /users/me`: https://developer.calendly.com/api-docs/calendly-api/users/get-current-user
 * - `GET /event_types`: https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-types
 * - `GET /user_busy_times`: https://developer.calendly.com/api-docs/calendly-api/availability/list-user-busy-times
 *   (seven days a call at most; no start in the past)
 * - `POST /invitees`: https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee
 *   (paid plans only: the Free plan is answered 403)
 * - `POST /scheduled_events/{uuid}/cancellation`:
 *   https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-scheduled-event-cancellation
 * - `POST /webhook_subscriptions`: https://developer.calendly.com/api-docs/calendly-api/webhooks/create-webhook-subscription
 * - the signed delivery: https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures and
 *   https://developer.calendly.com/api-docs/calendly-api/webhooks/get-sample-webhook-data
 *
 * The account is a plumber in Cape Town, its customers named in isiXhosa, Afrikaans and English.
 */

export const API = "https://api.calendly.com";
/** Made up, in the shape of a Calendly personal access token (a JWT). */
export const TOKEN = "eyJraWQiOiJ0ZXN0IiwidHlwIjoiUEFUIiwiYWxnIjoiRVMyNTYifQ.eyJzdWIiOiJraGFueWlzYSJ9.c2lnbmF0dXJl";
export const USER = `${API}/users/KHANYISA0000001`;
export const ORG = `${API}/organizations/ORGCAPETOWN0001`;
export const OWNER_EMAIL = "bookings@khanyisa.example.com";
export const SCHEDULING_URL = "https://calendly.com/khanyisa-plumbing";

export const ME = {
  resource: {
    uri: USER,
    name: "Khanyisa Plumbing",
    slug: "khanyisa-plumbing",
    email: OWNER_EMAIL,
    scheduling_url: SCHEDULING_URL,
    timezone: "Africa/Johannesburg",
    avatar_url: null,
    created_at: "2024-03-02T08:04:05.678123Z",
    updated_at: "2026-08-07T06:05:04.321123Z",
    current_organization: ORG,
    resource_type: "User",
    locale: "en",
    time_notation: "24h",
  },
};

/** One event type as Calendly lists it, with what a test changes. */
export function eventType(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    admin_managed: false,
    booking_method: "instant",
    color: "#0a7c66",
    created_at: "2025-01-02T03:04:05.678123Z",
    custom_questions: [
      {
        name: "Anything we should know before we arrive?",
        type: "text",
        position: 0,
        enabled: true,
        required: false,
        answer_choices: [],
        include_other: false,
      },
    ],
    deleted_at: null,
    description_html: null,
    description_plain: null,
    duration: 60,
    duration_options: null,
    internal_note: null,
    is_paid: false,
    kind: "solo",
    locale: "en",
    locations: [{ kind: "physical", location: "14 Bree Street, Cape Town" }],
    name: "Workshop visit",
    pooling_type: null,
    position: 0,
    profile: { type: "User", name: "Khanyisa Plumbing", owner: USER },
    scheduling_url: `${SCHEDULING_URL}/${id.toLowerCase()}`,
    secret: false,
    slug: id.toLowerCase(),
    type: "StandardEventType",
    updated_at: "2026-09-07T06:05:04.321123Z",
    uri: `${API}/event_types/${id}`,
    ...over,
  };
}

/** The account's event types: three bookings can go to, and four that they cannot. */
export const EVENT_TYPES = [
  // Booked at the workshop: a place the business sets.
  eventType("ETWORKSHOP60"),
  // A video call: Calendly makes the meeting.
  eventType("ETVIDEO30", {
    name: "Video quote",
    duration: 30,
    position: 1,
    locations: [{ kind: "google_conference" }],
  }),
  // Two ways in, the first asks the customer: the business's own phone is taken.
  eventType("ETCALL15", {
    name: "Phone advice",
    duration: 15,
    position: 2,
    locations: [{ kind: "outbound_call" }, { kind: "inbound_call", phone_number: "+27 21 555 0142" }],
  }),
  // The customer says where: the inbox does not hold their address for Calendly.
  eventType("ETCALLOUT90", { name: "Call-out", duration: 90, position: 3, locations: [{ kind: "ask_invitee" }] }),
  // Shared with others who booked it: cancelling it would cancel them too.
  eventType("ETCLASS120", { name: "DIY class", duration: 120, kind: "group", position: 4 }),
  // A poll, not a booking.
  eventType("ETPOLL45", { name: "Site meeting poll", duration: 45, booking_method: "poll", position: 5 }),
  // A question the customer must answer.
  eventType("ETQUOTE45", {
    name: "Renovation quote",
    duration: 45,
    position: 6,
    custom_questions: [
      {
        name: "Address of the property",
        type: "text",
        position: 0,
        enabled: true,
        required: true,
        answer_choices: [],
        include_other: false,
      },
    ],
  }),
];

export function page(collection: unknown[], next: string | null = null) {
  return {
    collection,
    pagination: {
      count: collection.length,
      next_page: next ? `${API}/event_types?page_token=${next}` : null,
      previous_page: null,
      next_page_token: next,
      previous_page_token: null,
    },
  };
}

export interface FakeCalendly {
  readonly platform: FakePlatform;
  readonly token: { value: string };
  /** Answered to `GET /user_busy_times`, by time, and filtered to the window asked for. */
  readonly busy: { type: string; start_time: string; end_time: string; [k: string]: unknown }[];
  /** Events made (`POST /invitees`), by id, with what was sent. */
  readonly events: Map<
    string,
    { body: Record<string, unknown>; status: "active" | "canceled"; start: string; end: string; type: string }
  >;
  readonly webhooks: Map<string, { url: string; signingKey: string; events: string[]; state: string }>;
  /** What Calendly answers to the next bookings: a slot it refuses, another field it refuses, or the Free plan. */
  refuse: "slot" | "field" | "plan" | null;
  /** Webhooks need a paid plan: false answers 403 to `POST /webhook_subscriptions`. */
  paid: boolean;
  /** Another answer to `GET /user_busy_times`: 424, a calendar Calendly checks could not be read. */
  busyStatus: number | null;
  eventTypes: Record<string, unknown>[];
}

/** A Calendly with one account, served to the inbox's own connector client. */
export function fakeCalendly(): FakeCalendly {
  const platform = fakePlatform();
  const c: FakeCalendly = {
    platform,
    token: { value: TOKEN },
    busy: [],
    events: new Map(),
    webhooks: new Map(),
    refuse: null,
    paid: true,
    busyStatus: null,
    eventTypes: EVENT_TYPES.map((t) => structuredClone(t)),
  };
  const authed = (req: { headers: Headers }) => req.headers.get("authorization") === `Bearer ${c.token.value}`;
  const unauthorized = () =>
    json({ title: "Unauthenticated", message: "The access token is invalid" }, 401, { "x-ratelimit-limit": "500" });
  let n = 0;
  platform
    .on("GET", `${API}/users/me`, (req) => (authed(req) ? json(ME) : unauthorized()))
    .on("GET", `${API}/event_types`, (req) => {
      if (!authed(req)) return unauthorized();
      if (req.url.searchParams.get("user") !== USER) return json({ title: "Invalid Argument" }, 400);
      return json(page(c.eventTypes));
    })
    .on("GET", `${API}/event_types/:id`, (req) => {
      if (!authed(req)) return unauthorized();
      const t = c.eventTypes.find((e) => e.uri === `${API}/event_types/${req.params.id}`);
      return t ? json({ resource: t }) : json({ title: "Resource Not Found", message: "" }, 404);
    })
    .on("GET", `${API}/user_busy_times`, (req) => {
      if (!authed(req)) return unauthorized();
      if (c.busyStatus) {
        return json({ title: "External Calendar Error", message: "Unable to access external calendar" }, c.busyStatus);
      }
      const from = Date.parse(req.url.searchParams.get("start_time") ?? "");
      const to = Date.parse(req.url.searchParams.get("end_time") ?? "");
      if (!(to > from) || to - from > 7 * 86_400_000) {
        return json({ title: "Invalid Argument", message: "The supplied parameters are invalid." }, 400);
      }
      return json({
        collection: c.busy.filter((b) => Date.parse(b.end_time) > from && Date.parse(b.start_time) < to),
      });
    })
    .on("POST", `${API}/invitees`, (req) => {
      if (!authed(req)) return unauthorized();
      if (c.refuse === "plan") {
        return json({ title: "Permission Denied", message: "Please upgrade your Calendly account to Standard" }, 403);
      }
      if (c.refuse === "field") {
        return json(
          {
            title: "Invalid Argument",
            message: "The supplied parameters are invalid.",
            details: [{ parameter: "location", message: "does not match the event type's location" }],
          },
          400,
        );
      }
      if (c.refuse === "slot") {
        return json(
          {
            title: "Invalid Argument",
            message: "The supplied parameters are invalid.",
            details: [{ parameter: "start_time", message: "The selected time is no longer available." }],
          },
          400,
        );
      }
      const body = JSON.parse(req.body) as Record<string, unknown>;
      const type = c.eventTypes.find((e) => e.uri === body.event_type);
      if (!type) return json({ title: "Resource Not Found", message: "" }, 404);
      const start = String(body.start_time);
      const end = new Date(Date.parse(start) + Number(type.duration) * 60_000).toISOString();
      const id = `EV${String(++n).padStart(14, "0")}`;
      c.events.set(id, { body, status: "active", start, end, type: String(type.uri) });
      const invitee = body.invitee as Record<string, unknown>;
      return json(
        {
          resource: {
            uri: `${API}/scheduled_events/${id}/invitees/IN${String(n).padStart(14, "0")}`,
            email: invitee.email,
            name: invitee.name,
            status: "active",
            questions_and_answers: [],
            timezone: invitee.timezone,
            event: `${API}/scheduled_events/${id}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tracking: {
              utm_campaign: null,
              utm_medium: null,
              utm_term: null,
              salesforce_uuid: null,
              ...(body.tracking as object),
            },
            text_reminder_number: null,
            rescheduled: false,
            old_invitee: null,
            new_invitee: null,
            cancel_url: `https://calendly.com/cancellations/IN${n}`,
            reschedule_url: `https://calendly.com/reschedulings/IN${n}`,
          },
        },
        201,
      );
    })
    .on("POST", `${API}/scheduled_events/:id/cancellation`, (req) => {
      if (!authed(req)) return unauthorized();
      const e = c.events.get(req.params.id ?? "");
      if (!e) return json({ title: "Resource Not Found", message: "" }, 404);
      if (e.status === "canceled") {
        return json({ title: "Permission Denied", message: "Event has already been canceled" }, 403);
      }
      e.status = "canceled";
      return json(
        { resource: { canceled_by: "Khanyisa Plumbing", reason: "Cancelled in the inbox", canceler_type: "host" } },
        201,
      );
    })
    .on("GET", `${API}/scheduled_events`, (req) => {
      if (!authed(req)) return unauthorized();
      const q = req.url.searchParams;
      const min = Date.parse(q.get("min_start_time") ?? "");
      const max = Date.parse(q.get("max_start_time") ?? "");
      const email = q.get("invitee_email");
      const list = [...c.events.entries()]
        .filter(([, e]) => e.status === (q.get("status") ?? e.status))
        .filter(([, e]) => Date.parse(e.start) >= min && Date.parse(e.start) < max)
        .filter(([, e]) => !email || (e.body.invitee as { email?: unknown }).email === email)
        .map(([id, e]) => ({
          uri: `${API}/scheduled_events/${id}`,
          name: "Workshop visit",
          status: e.status,
          start_time: e.start,
          end_time: e.end,
          event_type: e.type,
        }));
      return json(page(list));
    })
    .on("GET", `${API}/scheduled_events/:id/invitees`, (req) => {
      if (!authed(req)) return unauthorized();
      const e = c.events.get(req.params.id ?? "");
      if (!e) return json({ title: "Resource Not Found", message: "" }, 404);
      return json(
        page([
          {
            uri: `${API}/scheduled_events/${req.params.id}/invitees/IN1`,
            email: (e.body.invitee as { email?: unknown }).email,
            name: (e.body.invitee as { name?: unknown }).name,
            status: e.status,
            tracking: e.body.tracking ?? null,
          },
        ]),
      );
    })
    .on("POST", `${API}/webhook_subscriptions`, (req) => {
      if (!authed(req)) return unauthorized();
      if (!c.paid) {
        return json({ title: "Permission Denied", message: "Please upgrade your Calendly account to Standard" }, 403);
      }
      const body = JSON.parse(req.body) as { url: string; events: string[]; signing_key: string };
      if ([...c.webhooks.values()].some((w) => w.url === body.url)) {
        return json({ title: "Already Exists", message: "Hook with this url already exists" }, 409);
      }
      const id = `WH${String(++n).padStart(14, "0")}`;
      c.webhooks.set(id, { url: body.url, signingKey: body.signing_key, events: body.events, state: "active" });
      return json({ resource: webhookResource(id, body.url, "active") }, 201);
    })
    .on("GET", `${API}/webhook_subscriptions`, (req) => {
      if (!authed(req)) return unauthorized();
      return json(page([...c.webhooks.entries()].map(([id, w]) => webhookResource(id, w.url, w.state))));
    })
    .on("GET", `${API}/webhook_subscriptions/:id`, (req) => {
      if (!authed(req)) return unauthorized();
      const w = c.webhooks.get(req.params.id ?? "");
      return w ? json({ resource: webhookResource(req.params.id ?? "", w.url, w.state) }) : json({}, 404);
    })
    .on("DELETE", `${API}/webhook_subscriptions/:id`, (req) => {
      if (!authed(req)) return unauthorized();
      return c.webhooks.delete(req.params.id ?? "")
        ? new Response(null, { status: 204 })
        : json({ title: "Resource Not Found" }, 404);
    });
  return c;
}

function webhookResource(id: string, url: string, state: string) {
  return {
    uri: `${API}/webhook_subscriptions/${id}`,
    callback_url: url,
    created_at: "2026-10-20T09:15:22.123456Z",
    updated_at: "2026-10-20T09:15:22.123456Z",
    retry_started_at: null,
    state,
    events: ["invitee.created", "invitee.canceled"],
    scope: "user",
    organization: ORG,
    user: USER,
    group: null,
    creator: USER,
  };
}

/** A delivery as Calendly sends it: `invitee.created` or `invitee.canceled`, signed over `t.body`. */
export async function delivery(
  signingKey: string,
  opts: {
    readonly event?: string;
    readonly eventId?: string;
    readonly inviteeId?: string;
    readonly name?: string;
    readonly email?: string;
    readonly at?: number;
    readonly tamper?: boolean;
  } = {},
): Promise<{ body: string; headers: Record<string, string> }> {
  const eventId = opts.eventId ?? "EVBOOKEDONCAL01";
  const body = JSON.stringify({
    event: opts.event ?? "invitee.created",
    created_at: "2026-11-02T08:00:01.000000Z",
    created_by: USER,
    payload: {
      cancel_url: "https://calendly.com/cancellations/INX",
      email: opts.email ?? "pieter.vandermerwe@example.com",
      event: `${API}/scheduled_events/${eventId}`,
      name: opts.name ?? "Pieter van der Merwe",
      rescheduled: false,
      scheduled_event: {
        event_type: `${API}/event_types/ETWORKSHOP60`,
        start_time: "2026-11-04T09:00:00.000000Z",
        end_time: "2026-11-04T10:00:00.000000Z",
        status: "active",
        uri: `${API}/scheduled_events/${eventId}`,
      },
      status: opts.event === "invitee.canceled" ? "canceled" : "active",
      timezone: "Africa/Johannesburg",
      tracking: { utm_source: null, utm_content: null },
      uri: `${API}/scheduled_events/${eventId}/invitees/${opts.inviteeId ?? "INPIETER000001"}`,
    },
  });
  const t = String(Math.floor((opts.at ?? Date.now()) / 1000));
  let v1 = await hmacSha256Hex(signingKey, `${t}.${body}`);
  if (opts.tamper) v1 = `${v1.slice(0, -1)}${v1.endsWith("0") ? "1" : "0"}`;
  return {
    body,
    headers: { "content-type": "application/json", "calendly-webhook-signature": `t=${t},v1=${v1}` },
  };
}
