import { addLocalDays, daysBetween, instantOf } from "@surfingdog/core";
import {
  ACCOUNT,
  AUTH_CODE,
  BUNK,
  CARD_LAKE,
  CLIENT,
  FLEX_BUNK,
  FLEX_LAKE,
  LAKE,
  OWN_CLIENT,
  PRICES,
  PROPERTY,
} from "../../fixtures/property/apaleo";
import { type FakePlatform, fakePlatform, json } from "../platform";

/**
 * A local apaleo (ADR-033 §8.4), answering the paths and shapes of apaleo's public OpenAPI files
 * (`test/fixtures/property/apaleo.ts` names them): its identity server's token endpoint (authorization
 * code, refresh token, client credentials; one-hour tokens); properties, unit groups, rate plans and their
 * rates; unit-group availability in time slices; offers; bookings made with an `Idempotency-Key` that
 * answers the same request the same way for 24 hours and refuses the key with other parameters;
 * reservations found by `externalCode` (apaleo's filter matches the start of it); the amend and cancel
 * actions, which refuse a night it cannot sell; JSON Patch on a reservation; webhook subscriptions,
 * each made only once the address answers the health check apaleo sends it (`deliver`), as the
 * webhook guide says. Reservations carry their own gross total.
 * A reservation's guarantee must be at least its rate plan's. Times come back in UTC, as apaleo may
 * send them. `$force`, payment accounts and authorizations answer 403 and are counted: the inbox must
 * never call them. Nothing here is apaleo's code.
 */

const API = "https://api.apaleo.com";
const ZONE = PROPERTY.timeZone;
const GUARANTEES = ["PM6Hold", "CreditCard", "Prepayment", "Company"];

interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unitGroup: string;
  readonly minGuaranteeType: string;
  readonly channelCodes: string[];
}

interface Reservation {
  id: string;
  bookingId: string;
  status: "Confirmed" | "InHouse" | "CheckedOut" | "Canceled" | "NoShow";
  arrival: string;
  departure: string;
  unitGroup: string;
  ratePlan: string;
  adults: number;
  childrenAges: number[];
  externalCode: string;
  guaranteeType: string;
  primaryGuest?: Record<string, unknown>;
  comment?: string;
}

export interface FakeApaleo {
  readonly platform: FakePlatform;
  readonly reservations: Map<string, Reservation>;
  readonly bookings: Map<string, { id: string; reservationIds: string[]; booker: Record<string, unknown> }>;
  readonly subscriptions: Map<string, Record<string, unknown>>;
  /** Requests to `$force`, payment-account or authorization paths: never any. */
  readonly forbidden: string[];
  /** The redirect address and verifier each code exchange carried. */
  readonly exchanges: Record<string, string>[];
  advance(ms: number): void;
  now(): number;
  sell(unitGroup: string, night: string, count?: number): void;
  free(unitGroup: string, night: string): number;
  /** A valid access token, as a connection would hold one. */
  issue(): string;
  /**
   * Where apaleo's health check goes as a subscription is made: the inbox's answer (its status). None,
   * and nobody answers: no subscription is made.
   */
  deliver: ((url: string, body: string) => Promise<number>) | null;
  /** Called before each amend is applied, with how many came before; false refuses it. */
  beforeAmend: ((before: number) => boolean | undefined) | null;
}

/** A local night as apaleo may give it: the start of its time slice (noon there), in UTC. */
function sliceFrom(night: string): string {
  return new Date(instantOf(night, "12:00", ZONE)).toISOString().replace(".000Z", "Z");
}
function sliceTo(night: string): string {
  return new Date(instantOf(addLocalDays(night, 1), "10:00", ZONE)).toISOString().replace(".000Z", "Z");
}

export function fakeApaleo(opts: { readonly units?: Readonly<Record<string, number>> } = {}): FakeApaleo {
  const platform = fakePlatform();
  const plans: Plan[] = [
    { ...FLEX_LAKE, minGuaranteeType: "PM6Hold", channelCodes: ["Direct", "Ibe"] },
    { ...FLEX_BUNK, minGuaranteeType: "PM6Hold", channelCodes: ["Direct"] },
    { ...CARD_LAKE, minGuaranteeType: "CreditCard", channelCodes: ["Direct"] },
    {
      id: "WHIO-OTA-LKV",
      code: "OTA",
      name: "Online agencies",
      unitGroup: LAKE.id,
      minGuaranteeType: "PM6Hold",
      channelCodes: ["BookingCom"],
    },
  ];
  const groups = [LAKE, BUNK].map((g) => ({ ...g, memberCount: opts.units?.[g.id] ?? g.memberCount }));
  let amends = 0;
  const reservations = new Map<string, Reservation>();
  const bookings: FakeApaleo["bookings"] = new Map();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, { body: string; status: number; answer: unknown; at: number }>();
  const tokens = new Map<string, number>();
  const sold = new Map<string, number>();
  const forbidden: string[] = [];
  const exchanges: Record<string, string>[] = [];
  let offset = 0;
  let n = 0;
  const now = () => Date.now() + offset;

  const issue = () => {
    const t = `fake-apaleo-access-${++n}`;
    tokens.set(t, now() + 3_600_000);
    return t;
  };
  const authorised = (headers: Headers) => {
    const t = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const until = tokens.get(t);
    return until !== undefined && until > now();
  };
  const nightsOf = (r: { arrival: string; departure: string }) =>
    Array.from({ length: Math.max(0, daysBetween(r.arrival, r.departure)) }, (_, i) => addLocalDays(r.arrival, i));
  const booked = (group: string, night: string, except?: string) => {
    let used = sold.get(`${group}|${night}`) ?? 0;
    for (const r of reservations.values()) {
      if (r.id === except || (r.status !== "Confirmed" && r.status !== "InHouse") || r.unitGroup !== group) continue;
      if (nightsOf(r).includes(night)) used++;
    }
    return used;
  };
  const free = (group: string, night: string, except?: string) =>
    (groups.find((g) => g.id === group)?.memberCount ?? 0) - booked(group, night, except);
  const unprocessable = (message: string) => json({ messages: [message] }, 422);
  const view = (r: Reservation) => ({
    id: r.id,
    bookingId: r.bookingId,
    status: r.status,
    property: { id: PROPERTY.id, code: PROPERTY.code, name: PROPERTY.name },
    ratePlan: { id: r.ratePlan, isSubjectToCityTax: false },
    unitGroup: { id: r.unitGroup },
    // Dates and times in UTC: the property's own date is read from them in its zone.
    arrival: sliceFrom(r.arrival),
    departure: sliceTo(addLocalDays(r.departure, -1)),
    adults: r.adults,
    childrenAges: r.childrenAges,
    externalCode: r.externalCode,
    channelCode: "Direct",
    guaranteeType: r.guaranteeType,
    ...(r.primaryGuest ? { primaryGuest: r.primaryGuest } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
    totalGrossAmount: { amount: (PRICES[r.unitGroup] ?? 0) * nightsOf(r).length, currency: "NZD" },
  });

  /** Checks a reservation's stay: its rate plan (and its unit group), its guarantee, its nights. */
  const checkStay = (body: Record<string, unknown>, except?: string): { plan: Plan; nights: string[] } | string => {
    const slices = Array.isArray(body.timeSlices) ? (body.timeSlices as { ratePlanId?: string }[]) : [];
    const arrival = String(body.arrival ?? "");
    const departure = String(body.departure ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !/^\d{4}-\d{2}-\d{2}$/.test(departure) || departure <= arrival) {
      return "Invalid arrival or departure.";
    }
    const nights = nightsOf({ arrival, departure });
    if (slices.length !== nights.length) return "One time slice per night is required.";
    const plan = plans.find((p) => p.id === slices[0]?.ratePlanId);
    if (!plan || slices.some((s) => s.ratePlanId !== plan.id)) return "Invalid rate plan.";
    if (!plan.channelCodes.includes("Direct")) return "The rate plan is not sold through this channel.";
    if (body.guaranteeType !== undefined) {
      if (GUARANTEES.indexOf(String(body.guaranteeType)) < GUARANTEES.indexOf(plan.minGuaranteeType)) {
        return "The guarantee is weaker than the rate plan requires.";
      }
    } else if (plan.minGuaranteeType !== "PM6Hold") {
      return "The guarantee is weaker than the rate plan requires.";
    }
    for (const night of nights) {
      if (free(plan.unitGroup, night, except) < 1) return `No availability for ${plan.unitGroup} on ${night}.`;
    }
    return { plan, nights };
  };

  platform
    // Never to be called: forcing, payment accounts, authorizations.
    .on("POST", `${API}/booking/v1/bookings/$force`, (req) => {
      forbidden.push(req.url.pathname);
      return json({}, 403);
    })
    .on("POST", `${API}/booking/v1/payment-accounts*`, (req) => {
      forbidden.push(req.url.pathname);
      return json({}, 403);
    })
    .on("POST", `${API}/booking/v1/authorizations*`, (req) => {
      forbidden.push(req.url.pathname);
      return json({}, 403);
    })
    .on("PUT", `${API}/booking/v1/reservation-actions/:id/amend/$force`, (req) => {
      forbidden.push(req.url.pathname);
      return json({}, 403);
    })
    .on("POST", "https://identity.apaleo.com/connect/token", (req) => {
      const f = new URLSearchParams(req.body);
      const grant = f.get("grant_type");
      if (grant === "authorization_code") {
        if (f.get("client_id") !== CLIENT.clientId || f.get("client_secret") !== CLIENT.clientSecret) {
          return json({ error: "invalid_client" }, 400);
        }
        if (f.get("code") !== AUTH_CODE) return json({ error: "invalid_grant" }, 400);
        exchanges.push(Object.fromEntries(f));
        return json({
          access_token: issue(),
          expires_in: 3600,
          token_type: "Bearer",
          refresh_token: "fake-apaleo-refresh-1",
          scope: String(f.get("scope") ?? "offline_access openid profile reservations.manage"),
        });
      }
      if (grant === "refresh_token") {
        if (f.get("refresh_token") !== "fake-apaleo-refresh-1" || f.get("client_id") !== CLIENT.clientId) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json({
          access_token: issue(),
          expires_in: 3600,
          token_type: "Bearer",
          refresh_token: "fake-apaleo-refresh-1",
        });
      }
      if (grant === "client_credentials") {
        if (f.get("client_id") !== OWN_CLIENT.client_id || f.get("client_secret") !== OWN_CLIENT.client_secret) {
          return json({ error: "invalid_client" }, 400);
        }
        return json({ access_token: issue(), expires_in: 3600, token_type: "Bearer" });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    });

  const authed = (method: string, url: string, handler: Parameters<FakePlatform["on"]>[2]) =>
    platform.on(method, url, (req) => (authorised(req.headers) ? handler(req) : json({}, 401)));

  authed("GET", `${API}/account/v1/accounts/current`, () =>
    json({ code: ACCOUNT.code, name: ACCOUNT.name, type: "Customer" }),
  );
  authed("GET", `${API}/inventory/v1/properties`, () =>
    json({
      properties: [
        { ...PROPERTY, isArchived: false, isTemplate: false, status: "Live" },
        {
          id: "WHIO-TPL",
          code: "TPL",
          name: "Template",
          timeZone: ZONE,
          currencyCode: "NZD",
          isArchived: false,
          isTemplate: true,
        },
      ],
      count: 2,
    }),
  );
  authed("GET", `${API}/inventory/v1/properties/:id`, (req) =>
    req.params.id === PROPERTY.id ? json({ ...PROPERTY, isArchived: false, status: "Live" }) : json({}, 404),
  );
  authed("GET", `${API}/inventory/v1/unit-groups`, (req) => {
    if (req.url.searchParams.get("propertyId") !== PROPERTY.id) return json({ unitGroups: [], count: 0 });
    return json({
      unitGroups: groups.map((g) => ({ ...g, description: g.name, type: "BedRoom", property: { id: PROPERTY.id } })),
      count: groups.length,
    });
  });
  authed("GET", `${API}/rateplan/v1/rate-plans`, (req) => {
    const channel = req.url.searchParams.get("channelCodes");
    const found = plans.filter((p) => !channel || channel.split(",").some((c) => p.channelCodes.includes(c)));
    return json({
      ratePlans: found.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        minGuaranteeType: p.minGuaranteeType,
        channelCodes: p.channelCodes,
        unitGroup: { id: p.unitGroup },
        property: { id: PROPERTY.id },
        isArchived: false,
      })),
      count: found.length,
    });
  });
  authed("GET", `${API}/rateplan/v1/rate-plans/:id/rates`, (req) => {
    const plan = plans.find((p) => p.id === req.params.id);
    if (!plan) return json({}, 404);
    const from = req.url.searchParams.get("from") ?? "";
    const to = req.url.searchParams.get("to") ?? "";
    const nights: string[] = [];
    for (let d = from; d <= to; d = addLocalDays(d, 1)) nights.push(d);
    return json({
      rates: nights.map((night) => ({
        from: sliceFrom(night),
        to: sliceTo(night),
        price: { amount: PRICES[plan.unitGroup] ?? 0, currency: "NZD" },
        restrictions: { closed: false, closedOnArrival: false, closedOnDeparture: false, minLengthOfStay: 1 },
      })),
      count: nights.length,
    });
  });
  authed("GET", `${API}/availability/v1/unit-groups`, (req) => {
    const from = req.url.searchParams.get("from") ?? "";
    const to = req.url.searchParams.get("to") ?? "";
    const nights: string[] = [];
    for (let d = from; d <= to; d = addLocalDays(d, 1)) nights.push(d);
    return json({
      timeSlices: nights.map((night) => ({
        from: sliceFrom(night),
        to: sliceTo(night),
        property: { id: PROPERTY.id },
        unitGroups: groups.map((g) => ({
          unitGroup: { id: g.id, code: g.code, name: g.name, type: "BedRoom" },
          physicalCount: g.memberCount,
          houseCount: g.memberCount,
          soldCount: booked(g.id, night),
          occupancy: 0,
          availableCount: free(g.id, night),
          sellableCount: free(g.id, night),
          allowedOverbookingCount: 0,
        })),
      })),
      count: nights.length,
    });
  });
  authed("GET", `${API}/booking/v1/offers`, (req) => {
    const q = req.url.searchParams;
    const arrival = q.get("arrival") ?? "";
    const departure = q.get("departure") ?? "";
    const nights = nightsOf({ arrival, departure });
    const wanted = q.get("unitGroupIds");
    const offers = plans
      .filter((p) => p.channelCodes.includes(q.get("channelCode") ?? "Direct") && (!wanted || p.unitGroup === wanted))
      .filter((p) => nights.every((night) => free(p.unitGroup, night) > 0))
      .map((p) => ({
        arrival: sliceFrom(arrival),
        departure: sliceTo(addLocalDays(departure, -1)),
        unitGroup: { id: p.unitGroup },
        ratePlan: { id: p.id, name: p.name, isSubjectToCityTax: false },
        minGuaranteeType: p.minGuaranteeType,
        availableUnits: Math.min(...nights.map((night) => free(p.unitGroup, night))),
        totalGrossAmount: { amount: (PRICES[p.unitGroup] ?? 0) * nights.length, currency: "NZD" },
        timeSlices: nights.map((night) => ({
          from: sliceFrom(night),
          to: sliceTo(night),
          availableUnits: free(p.unitGroup, night),
          baseAmount: { grossAmount: PRICES[p.unitGroup] ?? 0, currency: "NZD" },
          totalGrossAmount: { amount: PRICES[p.unitGroup] ?? 0, currency: "NZD" },
        })),
      }));
    return offers.length === 0 ? new Response(null, { status: 204 }) : json({ property: { id: PROPERTY.id }, offers });
  });
  authed("POST", `${API}/booking/v1/bookings`, (req) => {
    const key = req.headers.get("idempotency-key");
    if (key) {
      const kept = idempotency.get(key);
      if (kept && kept.at > now() - 24 * 3_600_000) {
        if (kept.body !== req.body)
          return json({ messages: ["The idempotency key was used with other parameters."] }, 409);
        return json(kept.answer, kept.status);
      }
    }
    const body = JSON.parse(req.body) as { booker?: { lastName?: string }; reservations?: Record<string, unknown>[] };
    if (!body.booker?.lastName) return unprocessable("The booker's last name is required.");
    const list = body.reservations ?? [];
    if (list.length === 0) return unprocessable("At least one reservation is required.");
    const checked: { plan: Plan; r: Record<string, unknown> }[] = [];
    for (const r of list) {
      if (r.channelCode !== "Direct") return unprocessable("Invalid channel code.");
      const c = checkStay(r);
      if (typeof c === "string") return unprocessable(c);
      // Two rooms of the same kind in one booking need two units.
      for (const night of c.nights) {
        const same = checked.filter((x) => x.plan.unitGroup === c.plan.unitGroup).length;
        if (free(c.plan.unitGroup, night) < same + 1) return unprocessable(`No availability for ${c.plan.unitGroup}.`);
      }
      checked.push({ plan: c.plan, r });
    }
    const bookingId = `WHIO-BK-${++n}`;
    const ids = checked.map(({ plan, r }, i) => {
      const id = `${bookingId}-${i + 1}`;
      reservations.set(id, {
        id,
        bookingId,
        status: "Confirmed",
        arrival: String(r.arrival),
        departure: String(r.departure),
        unitGroup: plan.unitGroup,
        ratePlan: plan.id,
        adults: Number(r.adults),
        childrenAges: Array.isArray(r.childrenAges) ? (r.childrenAges as number[]) : [],
        externalCode: String(r.externalCode ?? ""),
        guaranteeType: String(r.guaranteeType ?? plan.minGuaranteeType),
        ...(r.primaryGuest ? { primaryGuest: r.primaryGuest as Record<string, unknown> } : {}),
        ...(typeof r.comment === "string" ? { comment: r.comment } : {}),
      });
      return id;
    });
    bookings.set(bookingId, { id: bookingId, reservationIds: ids, booker: body.booker as Record<string, unknown> });
    const answer = { id: bookingId, reservationIds: ids.map((id) => ({ id })) };
    if (key) idempotency.set(key, { body: req.body, status: 201, answer, at: now() });
    return json(answer, 201);
  });
  authed("GET", `${API}/booking/v1/reservations`, (req) => {
    const q = req.url.searchParams;
    const code = q.get("externalCode");
    const booking = q.get("bookingId");
    const props = q.get("propertyIds");
    const found = [...reservations.values()].filter(
      (r) =>
        (!code || r.externalCode.startsWith(code)) &&
        (!booking || r.bookingId === booking) &&
        (!props || props.split(",").includes(PROPERTY.id)),
    );
    return found.length === 0
      ? new Response(null, { status: 204 })
      : json({ reservations: found.map(view), count: found.length });
  });
  authed("GET", `${API}/booking/v1/reservations/:id`, (req) => {
    const r = reservations.get(req.params.id ?? "");
    return r ? json(view(r)) : json({}, 404);
  });
  authed("PATCH", `${API}/booking/v1/reservations/:id`, (req) => {
    const r = reservations.get(req.params.id ?? "");
    if (!r) return json({}, 404);
    const ops = JSON.parse(req.body) as { op: string; path: string; value?: unknown }[];
    for (const op of ops) {
      if (op.path.toLowerCase() === "/primaryguest" && op.op === "replace") {
        r.primaryGuest = op.value as Record<string, unknown>;
      } else {
        return unprocessable(`The operation on ${op.path} is not allowed.`);
      }
    }
    return new Response(null, { status: 204 });
  });
  authed("PUT", `${API}/booking/v1/reservation-actions/:id/amend`, (req) => {
    const r = reservations.get(req.params.id ?? "");
    if (!r) return json({}, 404);
    if (r.status !== "Confirmed" && r.status !== "InHouse") return unprocessable("The reservation cannot be changed.");
    if (fake.beforeAmend?.(amends++) === false) return unprocessable("The reservation cannot be changed now.");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const c = checkStay({ ...body, guaranteeType: r.guaranteeType }, r.id);
    if (typeof c === "string") return unprocessable(c);
    r.arrival = String(body.arrival);
    r.departure = String(body.departure);
    r.ratePlan = c.plan.id;
    r.unitGroup = c.plan.unitGroup;
    r.adults = Number(body.adults);
    r.childrenAges = Array.isArray(body.childrenAges) ? (body.childrenAges as number[]) : [];
    return new Response(null, { status: 204 });
  });
  authed("PUT", `${API}/booking/v1/reservation-actions/:id/cancel`, (req) => {
    const r = reservations.get(req.params.id ?? "");
    if (!r) return json({}, 404);
    if (r.status !== "Confirmed") return unprocessable("Only a confirmed reservation can be canceled.");
    r.status = "Canceled";
    return new Response(null, { status: 204 });
  });
  authed("POST", "https://webhook.apaleo.com/v1/subscriptions", async (req) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    // apaleo checks the address first: a subscription is made only when its health check is answered.
    const status = fake.deliver
      ? await fake.deliver(
          String(body.endpointUrl),
          JSON.stringify({
            topic: "system",
            type: "healthcheck",
            id: `evt-hc-${n + 1}`,
            accountId: ACCOUNT.code,
            propertyIds: [PROPERTY.id],
            timestamp: now(),
          }),
        )
      : 0;
    if (status < 200 || status >= 300) return unprocessable("The endpoint did not answer the health check.");
    const id = `sub-${++n}`;
    subscriptions.set(id, body);
    return json({ id }, 201);
  });
  authed("DELETE", "https://webhook.apaleo.com/v1/subscriptions/:id", (req) => {
    subscriptions.delete(req.params.id ?? "");
    return new Response(null, { status: 204 });
  });

  const fake: FakeApaleo = {
    platform,
    reservations,
    bookings,
    subscriptions,
    forbidden,
    exchanges,
    advance(ms) {
      offset += ms;
    },
    now,
    sell(group, night, count = 1) {
      sold.set(`${group}|${night}`, (sold.get(`${group}|${night}`) ?? 0) + count);
    },
    free: (group, night) => free(group, night),
    issue,
    deliver: null,
    beforeAmend: null,
  };
  return fake;
}
