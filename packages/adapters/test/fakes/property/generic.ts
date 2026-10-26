import {
  type AriRow,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type LinkState,
  type OutboundStay,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { hmacSha256Hex, verifyHexHmac } from "../../../src/connectors/hook-sign";
import { type FakePlatform, fakePlatform } from "../platform";

/**
 * A generic property system, as a fake (ADR-037 §8): no real channel manager or property management
 * system is ever called, and nothing here is any vendor's API. It is the shape every one of them has —
 * properties, rooms, rates, availability night by night, bookings written with our own reference and
 * found again by it, cancelled by status, never deleted — so the stays layer and the contract kit can
 * be proved against it, and each real adapter later against its own recorded fixtures.
 *
 * Its modes are the ways real systems behave:
 * - write guards: `check` refuses a booking (or a move) onto a full night; `oversell` takes it, goes
 *   below none and flags the booking as overbooked, its own definite word the inbox reads back before it
 *   promises anything;
 * - hold styles: a `hold` that `blocks` the room, or one that does not;
 * - rate limits: a credit budget per five minutes, said in every answer's headers, and 429 when spent;
 * - webhooks that arrive twice and out of order (`hints`), never to be believed;
 * - writes that do not answer (`unreachable`), never answer, or answer late but land (`slow_lands`).
 */

export const HOST = "api.stays.example.com";
export const API_KEY = "fake-key-0123456789";
const HOOK_SECRET = "fake-hook-secret-0123456789";

/** A webhook as the fake would send it: the body, and its signature over those bytes. */
export async function signedHint(hint: {
  seq: number;
  roomId: string;
  from: string;
  to: string;
}): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify({ id: `evt_${hint.seq}`, room: hint.roomId, from: hint.from, to: hint.to });
  return { body, signature: await hmacSha256Hex(HOOK_SECRET, body) };
}
const BASE = `https://${HOST}/v1`;

export interface FakeRoom {
  readonly id: string;
  readonly name: string;
  units: number;
  readonly capacity?: { adults: number; children: number; total: number };
  /** Rate id → nightly price, minor units. */
  readonly prices: Readonly<Record<string, number>>;
  /** What the system adds besides the nightly price (a cleaning fee, a tax), as a property system says it. */
  readonly charges?: readonly ("cleaning" | "tax" | "deposit" | "extra")[];
}

export interface FakeBooking {
  readonly id: string;
  readonly reference: string;
  readonly roomIds: readonly string[];
  checkIn: string;
  checkOut: string;
  status: "hold" | "provisional" | "confirmed" | "cancelled";
  price: number;
  guest?: { name: string; email?: string };
}

export interface FakePropertySystem {
  readonly platform: FakePlatform;
  readonly definition: ConnectorDefinition;
  readonly rooms: Map<string, FakeRoom>;
  readonly bookings: Map<string, FakeBooking>;
  /** Nights another channel sold, by room: what the system's own calendar holds. */
  readonly sold: Map<string, number>;
  readonly mode: {
    guard: "check" | "oversell";
    hold: "blocks" | "nonblocking";
    write: "ok" | "refuse" | "unreachable" | "never" | "slow_lands";
    /** Whether reading a booking back answers, or fails (a read-back that cannot be made). */
    readBack: "ok" | "fails";
    /** How many looks by our reference miss before one finds it (an index that lags the write). */
    findMisses: number;
    credits: number;
    /** When the credits come back, ms from the fake's own clock. */
    resetsInMs: number;
  };
  /** The webhooks it would send about these nights: twice, the later first. */
  hints(
    roomId: string,
    from: string,
    to: string,
  ): { readonly roomId: string; readonly from: string; readonly to: string; readonly seq: number }[];
  /** Units free on a night, as the system counts them. */
  free(roomId: string, night: string): number;
}

function nightsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d < Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

export function genericPropertySystem(opts: {
  readonly propertyId?: string;
  readonly name?: string;
  readonly currency?: string;
  readonly timezone?: string;
  readonly rooms: readonly FakeRoom[];
}): FakePropertySystem {
  const platform = fakePlatform();
  const propertyId = opts.propertyId ?? "P1";
  const rooms = new Map<string, FakeRoom>(opts.rooms.map((r) => [r.id, { ...r }]));
  const bookings = new Map<string, FakeBooking>();
  const sold = new Map<string, number>();
  const mode: FakePropertySystem["mode"] = {
    guard: "check",
    hold: "blocks",
    write: "ok",
    readBack: "ok",
    findMisses: 0,
    credits: 100,
    resetsInMs: 300_000,
  };
  let n = 0;
  let seq = 0;

  const taken = (roomId: string, night: string) => {
    let used = sold.get(`${roomId}|${night}`) ?? 0;
    for (const b of bookings.values()) {
      if (b.status === "cancelled" || !b.roomIds.includes(roomId)) continue;
      if (b.status === "hold" && mode.hold === "nonblocking") continue;
      if (night >= b.checkIn && night < b.checkOut) used += b.roomIds.filter((r) => r === roomId).length;
    }
    return used;
  };
  const free = (roomId: string, night: string) => (rooms.get(roomId)?.units ?? 0) - taken(roomId, night);

  /** Every answer spends a credit and says what is left; spent, the answer is 429. */
  const answer = (status: number, body: unknown): Response => {
    if (mode.credits <= 0) {
      return new Response(JSON.stringify({ error: "credits spent" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(Math.ceil(mode.resetsInMs / 1000)),
          "x-credits-remaining": "0",
          "x-credits-resets-in": String(mode.resetsInMs),
        },
      });
    }
    mode.credits -= 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-credits-remaining": String(mode.credits),
        "x-credits-resets-in": String(mode.resetsInMs),
      },
    });
  };
  const authorised = (headers: Headers) => headers.get("authorization") === `Bearer ${API_KEY}`;

  platform
    .on("GET", `${BASE}/properties`, (req) =>
      authorised(req.headers)
        ? answer(200, [
            {
              id: propertyId,
              name: opts.name ?? "Fake property",
              currency: opts.currency ?? "EUR",
              timezone: opts.timezone ?? "UTC",
            },
          ])
        : new Response(null, { status: 401 }),
    )
    .on("GET", `${BASE}/properties/:id/rooms`, () =>
      answer(
        200,
        [...rooms.values()].map((r) => ({
          id: r.id,
          name: r.name,
          units: r.units,
          capacity: r.capacity,
          ...(r.charges ? { charges: r.charges } : {}),
        })),
      ),
    )
    .on("GET", `${BASE}/properties/:id/rates`, () => {
      const ids = new Set<string>();
      for (const r of rooms.values()) for (const id of Object.keys(r.prices)) ids.add(id);
      return answer(
        200,
        [...ids].map((id) => ({ id, name: id })),
      );
    })
    .on("GET", `${BASE}/properties/:id/availability`, (req) => {
      const from = req.url.searchParams.get("from") ?? "";
      const to = req.url.searchParams.get("to") ?? "";
      const nights = nightsBetween(from, to);
      // At most 120 nights an answer: a longer window says how far it got.
      const shown = nights.slice(0, 120);
      const rows = [...rooms.values()].flatMap((r) =>
        shown.map((night) => ({ room: r.id, night, units: free(r.id, night), prices: r.prices })),
      );
      return answer(200, { rows, ...(shown.length < nights.length ? { until: nights[shown.length] } : {}) });
    })
    .on("GET", `${BASE}/bookings/:id`, (req) => {
      const b = bookings.get(req.params.id ?? "");
      if (!b) return answer(404, { error: "no such booking" });
      if (mode.readBack === "fails") return new Response("bad gateway", { status: 502 });
      // The system's own overbooking flag: any night of this booking with more booked than rooms.
      const overbooked =
        b.status !== "cancelled" &&
        b.roomIds.some((r) => nightsBetween(b.checkIn, b.checkOut).some((night) => free(r, night) < 0));
      return answer(200, {
        id: b.id,
        status: b.status,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        overbooked,
        ...(b.guest ? { guest: b.guest } : {}),
      });
    })
    .on("GET", `${BASE}/bookings`, (req) => {
      const ref = req.url.searchParams.get("reference");
      if (mode.findMisses > 0) {
        mode.findMisses -= 1;
        return answer(200, []);
      }
      const found = [...bookings.values()].filter((b) => b.reference === ref);
      return answer(
        200,
        found.map((b) => ({ id: b.id, status: b.status })),
      );
    })
    .on("POST", `${BASE}/bookings`, async (req) => {
      const body = JSON.parse(req.body) as {
        reference: string;
        rooms: string[];
        checkIn: string;
        checkOut: string;
        status: FakeBooking["status"];
        price: number;
        guest?: FakeBooking["guest"];
      };
      const again = [...bookings.values()].find((b) => b.reference === body.reference);
      if (again) return answer(200, { id: again.id, status: again.status });
      if (mode.write === "refuse") return answer(409, { error: "not free" });
      const nights = nightsBetween(body.checkIn, body.checkOut);
      const short = body.rooms.some((r) =>
        nights.some((night) => free(r, night) < body.rooms.filter((x) => x === r).length),
      );
      if (short && mode.guard === "check" && !(body.status === "hold" && mode.hold === "nonblocking")) {
        return answer(409, { error: "not free" });
      }
      const id = `B${++n}`;
      const booking: FakeBooking = {
        id,
        reference: body.reference,
        roomIds: body.rooms,
        checkIn: body.checkIn,
        checkOut: body.checkOut,
        status: body.status,
        price: body.price,
        ...(body.guest ? { guest: body.guest } : {}),
      };
      if (mode.write === "unreachable") return new Response("bad gateway", { status: 502 });
      if (mode.write === "never") return new Promise<Response>(() => {});
      bookings.set(id, booking);
      if (mode.write === "slow_lands") return new Promise<Response>(() => {});
      return answer(201, { id, status: booking.status });
    })
    .on("PATCH", `${BASE}/bookings/:id`, (req) => {
      const b = bookings.get(req.params.id ?? "");
      if (!b) return answer(404, { error: "no such booking" });
      if (mode.write === "refuse") return answer(409, { error: "not free" });
      const body = JSON.parse(req.body) as Partial<FakeBooking> & { rooms?: string[] };
      const next = {
        checkIn: body.checkIn ?? b.checkIn,
        checkOut: body.checkOut ?? b.checkOut,
        roomIds: body.rooms ?? b.roomIds,
      };
      // A move onto nights or rooms that are full: refused under `check`, taken under `oversell`.
      const own = (roomId: string, night: string) =>
        b.status !== "cancelled" && b.roomIds.includes(roomId) && night >= b.checkIn && night < b.checkOut
          ? b.roomIds.filter((r) => r === roomId).length
          : 0;
      const short = next.roomIds.some((r) =>
        nightsBetween(next.checkIn, next.checkOut).some(
          (night) => free(r, night) + own(r, night) < next.roomIds.filter((x) => x === r).length,
        ),
      );
      if (short && mode.guard === "check") return answer(409, { error: "not free" });
      if (mode.write === "unreachable") return new Response("bad gateway", { status: 502 });
      b.checkIn = next.checkIn;
      b.checkOut = next.checkOut;
      (b as { roomIds: readonly string[] }).roomIds = next.roomIds;
      if (body.status) b.status = body.status;
      if (body.guest) b.guest = body.guest;
      if (body.price !== undefined) b.price = body.price;
      return answer(200, { id: b.id, status: b.status });
    })
    .on("POST", `${BASE}/bookings/:id/cancel`, (req) => {
      const b = bookings.get(req.params.id ?? "");
      if (!b) return answer(404, { error: "no such booking" });
      b.status = "cancelled";
      return answer(200, { id: b.id, status: b.status });
    });

  const call = async (
    ctx: RunContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ res: ConnectorHttpResponse; json: unknown }> => {
    const res = await ctx.http.request({
      method,
      url: `${BASE}${path}`,
      headers: {
        authorization: `Bearer ${ctx.secret.api_key ?? ""}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 20_000,
    });
    if (res.status === 401) throw new ConnectorError("auth", "The key was not taken.");
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", "The system asked to wait.", {
        retryAfterMs: Number(res.headers.get("x-credits-resets-in") ?? 60_000),
      });
    }
    if (res.status === 409) throw new ConnectorError("refused", "Those nights are no longer free.");
    if (res.status >= 500) throw new ConnectorError("unreachable", "The system is not answering properly.");
    if (res.status >= 400) throw new ConnectorError("bad_response", `The system answered ${res.status}.`);
    return { res, json: JSON.parse(res.text) };
  };

  const definition: ConnectorDefinition = {
    kind: "fake_property",
    title: "Fake property system",
    group: "lodging",
    capabilities: ["stay_inventory", "write_stays", "stay_events"],
    auth: "form",
    form: z.object({ api_key: secretField(z.string().min(8).max(200), { label: "API key" }) }),
    async connect(ctx, input) {
      const res = await ctx.http.request({
        method: "GET",
        url: `${BASE}/properties`,
        headers: { authorization: `Bearer ${input.api_key ?? ""}` },
      });
      if (res.status === 401) throw new ConnectorError("auth", "That key was not taken.", { field: "api_key" });
      const props = JSON.parse(res.text) as { id: string; name: string }[];
      return {
        account: props[0]?.name ?? "Fake property system",
        externalId: "fake-account",
        secret: { api_key: input.api_key ?? "", hook_secret: HOOK_SECRET },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      };
    },
    stays: {
      async properties(ctx) {
        return (await call(ctx, "GET", "/properties")).json as {
          id: string;
          name: string;
          currency?: string;
          timezone?: string;
        }[];
      },
      async rooms(ctx, id) {
        return (await call(ctx, "GET", `/properties/${id}/rooms`)).json as {
          id: string;
          name: string;
          units: number;
        }[];
      },
      async ratePlans(ctx, id) {
        return (await call(ctx, "GET", `/properties/${id}/rates`)).json as { id: string; name: string }[];
      },
      async ari(ctx, id, window) {
        const { json } = await call(ctx, "GET", `/properties/${id}/availability?from=${window.from}&to=${window.to}`);
        const body = json as {
          rows: { room: string; night: string; units: number; prices: Record<string, number> }[];
          until?: string;
        };
        const rows: AriRow[] = body.rows.map((r) => ({
          roomId: r.room,
          night: r.night,
          units: r.units,
          prices: r.prices,
        }));
        return body.until ? { rows, until: body.until } : rows;
      },
      credits(res) {
        const left = res.headers.get("x-credits-remaining");
        const resets = res.headers.get("x-credits-resets-in");
        return left === null ? null : { remaining: Number(left), resetsInMs: Number(resets ?? 300_000) };
      },
    },
    // Its word that some nights changed: signed over the exact bytes, and only ever a hint to read again.
    hooks: {
      topics: ["nights.changed"],
      async verify(ctx, request) {
        const signature = request.headers.get("x-fake-signature");
        if (!(await verifyHexHmac(ctx.secret.hook_secret ?? "", request.body, signature))) {
          throw new ConnectorError("refused", "The signature does not check out.");
        }
        const body = JSON.parse(request.body) as { id?: unknown; room?: unknown; from?: unknown; to?: unknown };
        return {
          eventId: String(body.id),
          topic: "nights.changed",
          refs: [`${String(body.room)}:${String(body.from)}:${String(body.to)}`],
        };
      },
      async read(_ctx, event) {
        return event.refs.map((ref) => {
          const [room, from, to] = ref.split(":");
          return { kind: "stay_nights" as const, roomIds: room ? [room] : [], from: from ?? "", to: to ?? "" };
        });
      },
    },
    stayWriter: {
      async put(ctx, stay: OutboundStay, link: LinkState | null, status) {
        if (link?.externalId) {
          await call(ctx, "PATCH", `/bookings/${link.externalId}`, {
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
            rooms: stay.rooms.map((r) => r.roomId),
            status,
            price: stay.rooms.reduce((a, r) => a + r.price.value, 0),
            ...(stay.guest ? { guest: stay.guest } : {}),
          });
          return link;
        }
        const { json } = await call(ctx, "POST", "/bookings", {
          reference: stay.key,
          rooms: stay.rooms.map((r) => r.roomId),
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          status,
          price: stay.rooms.reduce((a, r) => a + r.price.value, 0),
          ...(stay.guest ? { guest: stay.guest } : {}),
        });
        return { externalId: (json as { id: string }).id, etag: null, calendar: null };
      },
      async cancel(ctx, link) {
        await call(ctx, "POST", `/bookings/${link.externalId}/cancel`);
      },
      async find(ctx, stay) {
        const { json } = await call(ctx, "GET", `/bookings?reference=${encodeURIComponent(stay.key)}`);
        const found = (json as { id: string }[])[0];
        return found ? { externalId: found.id, etag: null, calendar: null } : null;
      },
      async oversold(ctx, _stay, link) {
        const { json } = await call(ctx, "GET", `/bookings/${encodeURIComponent(link.externalId ?? "")}`);
        return (json as { overbooked?: unknown }).overbooked === true;
      },
    },
  };

  return {
    platform,
    definition,
    rooms,
    bookings,
    sold,
    mode,
    free,
    hints(roomId, from, to) {
      const a = { roomId, from, to, seq: ++seq };
      const b = { roomId, from, to, seq: ++seq };
      // Twice, the later one first: a body is a hint to read again, never what is so.
      return [b, a, b];
    },
  };
}
