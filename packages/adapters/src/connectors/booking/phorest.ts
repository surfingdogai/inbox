import {
  type ConnectContext,
  type Connected,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  field,
  instantOf,
  type LinkState,
  minorAmount,
  minorUnits,
  type OutboundBooking,
  type RunContext,
  type SetupSnapshot,
  type SystemSlot,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { basicAuth, retryAfterMs } from "../http";

/**
 * Phorest, a salon's own booking system (ADR-035), from its public reference
 * (https://developer.phorest.com/, read 20 October 2026; the pages each call cites are named beside it):
 *
 * - **Credentials are the salon's own.** Phorest issues API access when the salon asks its support team
 *   (https://developer.phorest.com/docs/getting-started.md): a username with the `global/` prefix, a
 *   password, and the business's id. Basic authentication. The salon picks Phorest's EU server or its US
 *   one (United States, Canada and Australia), as Phorest's own reference asks.
 * - **Start from it** (`setup_in`): the branch's services the salon offers online (`internetEnabled`),
 *   with each member of staff's own price (their own, `userPrices`, before their level's,
 *   `staffCategories.prices` by `staffCategoryId`) and length (`userDurations`); its staff (who is
 *   hidden from online booking is left out) and a week of their rosters as weekly hours. A branch that
 *   names no currency gives no prices: a person prices those services.
 * - **Its times** (`availability_in`): "List appointment availabilities", for one service, with one
 *   member of staff or anyone. Only a schedule's start is sure (its end is optional): the inbox gives
 *   one with no end its own length with that member of staff.
 * - **Written first** (`write_bookings`): "Create a booking" as ACTIVE, for the salon's own client
 *   (found by the inbox's own id for them, `externalId`, else created); the inbox confirms only once
 *   Phorest answered with its booking. A booking with no answer is looked for among the client's
 *   appointments that day. "Cancel a booking" when it is cancelled here. A move is made in Phorest.
 * - **No webhooks** (Phorest has none): nothing is pushed to the inbox.
 *
 * Phorest's reference states no payments through its API, so none is ever sent: the deposit, if any,
 * is paid on the business's own payment platform, never through Phorest.
 *
 * **Switched off** (`PHOREST_READY`) until the company confirms Phorest lets a salon's own credentials
 * be used by a tool like this one: until then the card says "Needs setup".
 */
export const PHOREST_READY = false;

/**
 * How times are sent to Phorest: as instants (`…Z`), which is how this reads its reference ("date-time",
 * ISO 8601), or as the branch's local wall time with no offset. Not confirmed against a test branch yet
 * (the founder's checklist): `local` is kept working beside it, so the switch is one word.
 */
export type PhorestTimes = "instant" | "local";
export const PHOREST_TIMES: PhorestTimes = "instant";

export const PHOREST_SERVERS = {
  eu: "https://api-gateway-eu.phorest.com/third-party-api-server",
  us: "https://api-gateway-us.phorest.com/third-party-api-server",
} as const;
export type PhorestRegion = keyof typeof PHOREST_SERVERS;

export const PHOREST_DOCS = "https://surfingdog.ai/docs/connectors/phorest";

/** The rate Phorest states on every endpoint: 100 requests a second. */
export const PHOREST_RPS = 100;

export const phorestForm = z.object({
  region: field(z.enum(["eu", "us"]), {
    label: "Phorest server",
    hidden: true,
  }),
  business_id: field(z.string().trim().min(4).max(64), {
    label: "Business ID",
    help: "In the email Phorest sent with your API access.",
    link: { href: "https://developer.phorest.com/docs/getting-started.md", text: "How to ask Phorest" },
  }),
  username: field(z.string().trim().min(3).max(200), {
    label: "API username",
    help: "As Phorest gave it, starting global/.",
    placeholder: "global/you@yoursalon.example",
    input: "email",
    autocomplete: "off",
  }),
  password: secretField(z.string().min(1).max(200), {
    label: "API password",
    help: "The password Phorest gave with it, not your Phorest sign-in.",
  }),
});

type Ctx = Pick<ConnectContext, "http"> & { readonly secret: Readonly<Record<string, string>> };

interface Where {
  readonly base: string;
  readonly businessId: string;
}

function whereOf(
  ctx: Pick<RunContext, "extra">,
): Where & { readonly branchId: string; readonly zone: string; readonly currency: string } {
  const e = ctx.extra as { region?: unknown; businessId?: unknown; branches?: unknown };
  const region = e.region === "us" ? "us" : "eu";
  const branches = Array.isArray(e.branches) ? (e.branches as Branch[]) : [];
  const chosen = (ctx as { choices?: Readonly<Record<string, string | null>> }).choices?.branch;
  const branch = branches.find((b) => b.id === chosen) ?? branches[0];
  if (typeof e.businessId !== "string" || !branch) {
    throw new ConnectorError("config", "Connect Phorest again: this connection does not say which branch it is.");
  }
  return {
    base: PHOREST_SERVERS[region],
    businessId: e.businessId,
    branchId: branch.id,
    zone: branch.zone,
    currency: branch.currency,
  };
}

interface Branch {
  readonly id: string;
  readonly name: string;
  readonly zone: string;
  readonly currency: string;
}

/** The username as Phorest wants it: with the `global/` prefix, which it is often given without. */
export function phorestUsername(raw: string): string {
  const u = raw.trim();
  return u.toLowerCase().startsWith("global/") ? u : `global/${u}`;
}

async function call(
  ctx: Ctx,
  where: Where,
  method: string,
  path: string,
  opts: { readonly body?: unknown; readonly query?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ res: ConnectorHttpResponse; json: unknown }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) q.set(k, v);
  const url = `${where.base}/api/business/${encodeURIComponent(where.businessId)}${path}${q.size ? `?${q}` : ""}`;
  const res = await ctx.http.request({
    method,
    url,
    headers: {
      authorization: basicAuth(phorestUsername(ctx.secret.username ?? ""), ctx.secret.password ?? ""),
      accept: "application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(
      "auth",
      "Phorest did not take that username and password. Check them in Phorest's email, and the server (Europe, or the Americas and Australia).",
      { field: "password" },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Phorest asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Phorest is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json };
}

/** Phorest's error detail, in its own words, short. */
function detailOf(json: unknown): string {
  const d = (json as { detail?: unknown } | null)?.detail;
  return typeof d === "string" && d.trim() ? d.trim().slice(0, 200) : "Phorest said no.";
}

function embedded<T>(json: unknown, key: string): T[] {
  const e = (json as { _embedded?: Record<string, unknown> } | null)?._embedded;
  const list = e?.[key];
  return Array.isArray(list) ? (list as T[]) : [];
}

function pages(json: unknown): number {
  const p = (json as { page?: { totalPages?: unknown } } | null)?.page;
  return typeof p?.totalPages === "number" ? p.totalPages : 1;
}

/** Every page of a list, at most ten (2,000 entries at 200 a page). */
async function all<T>(
  ctx: Ctx,
  where: Where,
  path: string,
  key: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 10; page++) {
    const { res, json } = await call(ctx, where, "GET", path, { query: { ...query, size: "200", page: String(page) } });
    if (res.status === 404) throw new ConnectorError("not_found", "Phorest does not know that business or branch.");
    if (res.status !== 200) throw new ConnectorError("bad_response", "Phorest answered with something unexpected.");
    out.push(...embedded<T>(json, key));
    if (page + 1 >= pages(json)) break;
  }
  return out;
}

/** A price Phorest gives in its currency's units ("25.5") as minor units; null when it is not one. */
function money(value: unknown, currency: string): { value: number; currency: string } | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const e = minorUnits(currency);
  if (e === null) return null;
  const minor = minorAmount(value.toFixed(Math.min(6, Math.max(e, 2))), e);
  return minor === null ? null : { value: minor, currency };
}

/** The local date and time of an instant in a zone: what Phorest's appointments are written in. */
export function localOf(ms: number, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

interface PhorestService {
  readonly serviceId?: string;
  readonly name?: string;
  readonly internetName?: string;
  readonly duration?: number;
  readonly price?: number;
  readonly archived?: boolean;
  readonly isAddonOnly?: boolean;
  readonly internetEnabled?: boolean;
  readonly disqualifiedStaff?: readonly string[];
  /** A price by staff level: `prices[].id` is a member of staff's `staffCategoryId`. */
  readonly staffCategories?: { readonly prices?: readonly { readonly id?: string; readonly price?: number }[] };
  readonly userPrices?: readonly { readonly userRef?: string; readonly price?: number }[];
  readonly userDurations?: readonly { readonly userRef?: string; readonly duration?: number }[];
}

interface PhorestStaff {
  readonly staffId?: string;
  readonly userId?: string;
  readonly staffCategoryId?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly archived?: boolean;
  readonly hideFromOnlineBookings?: boolean;
  readonly disqualifiedServices?: readonly string[];
}

interface TimeOfDay {
  readonly hourOfDay?: number;
  readonly minuteOfHour?: number;
}

function hhmm(t: TimeOfDay | undefined): string | null {
  if (!t || typeof t.hourOfDay !== "number") return null;
  return `${String(t.hourOfDay).padStart(2, "0")}:${String(t.minuteOfHour ?? 0).padStart(2, "0")}`;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** A roster for the coming week as weekly hours: each day's working slots, the time off cut out. */
export function weeklyFromRoster(
  slots: readonly {
    readonly date?: string;
    readonly type?: string;
    readonly startTime?: TimeOfDay;
    readonly endTime?: TimeOfDay;
    readonly timeOffStartTime?: TimeOfDay;
    readonly timeOffEndTime?: TimeOfDay;
  }[],
): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const s of slots) {
    if (s.type !== "WORKING" || !s.date) continue;
    const start = hhmm(s.startTime);
    const end = hhmm(s.endTime);
    if (!start || !end || end <= start) continue;
    const day = DAYS[new Date(`${s.date}T12:00:00Z`).getUTCDay()];
    if (!day || out[day]) continue;
    const offStart = hhmm(s.timeOffStartTime);
    const offEnd = hhmm(s.timeOffEndTime);
    out[day] =
      offStart && offEnd && offStart > start && offEnd < end && offEnd > offStart
        ? [
            [start, offStart],
            [offEnd, end],
          ]
        : [[start, end]];
  }
  return out;
}

/** The first and the other names of a customer, as Phorest asks for both. */
function names(full: string | null): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/u).filter(Boolean);
  const firstName = (parts[0] ?? "Client").slice(0, 60);
  const lastName = (parts.slice(1).join(" ") || firstName).slice(0, 60);
  return { firstName, lastName };
}

/** The salon's own client for the inbox's customer: found by the inbox's own id for them, else made. */
async function clientFor(ctx: RunContext, booking: OutboundBooking, create: boolean): Promise<string | null> {
  const where = whereOf(ctx);
  const ref = booking.customer?.ref;
  if (!ref) throw new ConnectorError("config", "This booking has no customer to book in Phorest.");
  // https://developer.phorest.com/reference/getclients.md: filter by externalId.
  const found = await call(ctx, where, "GET", "/client", { query: { externalId: ref, size: "1" } });
  if (found.res.status === 200) {
    const id = embedded<{ clientId?: string }>(found.json, "clients")[0]?.clientId;
    if (id) return id;
  }
  if (!create) return null;
  const n = names(booking.customer?.name ?? booking.customerName);
  // https://developer.phorest.com/reference/createclient.md
  const made = await call(ctx, where, "POST", "/client", {
    body: {
      ...n,
      externalId: ref,
      creatingBranchId: where.branchId,
      ...(booking.customer?.email ? { email: booking.customer.email } : {}),
      ...(booking.customer?.phone ? { mobile: booking.customer.phone } : {}),
    },
  });
  const id = (made.json as { clientId?: unknown } | null)?.clientId;
  if (made.res.status === 400) throw new ConnectorError("refused", detailOf(made.json));
  if ((made.res.status !== 201 && made.res.status !== 200) || typeof id !== "string") {
    throw new ConnectorError("bad_response", "Phorest did not say which client it made.");
  }
  return id;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A time as Phorest is sent it (`PHOREST_TIMES`): an instant, or the branch's wall time. */
export function phorestTime(ms: number, zone: string, times: PhorestTimes): string {
  if (times === "instant") return iso(ms);
  const local = localOf(ms, zone);
  return `${local.date}T${local.time}`;
}

/** A time Phorest answered with: an instant when it has an offset, else the branch's wall time. */
function readTime(value: unknown, zone: string): number {
  const text = String(value ?? "");
  if (!text) return Number.NaN;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return Date.parse(text);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(text);
  return m ? instantOf(m[1] as string, `${m[2]}:${m[3] ?? "00"}`, zone) : Number.NaN;
}

export function phorestConnector(
  opts: { readonly ready?: boolean | undefined; readonly times?: PhorestTimes | undefined } = {},
): ConnectorDefinition {
  const switchedOn = opts.ready ?? PHOREST_READY;
  const times = opts.times ?? PHOREST_TIMES;
  return {
    kind: "phorest",
    title: "Phorest",
    group: "booking",
    capabilities: ["setup_in", "availability_in", "write_bookings"],
    auth: "form",
    form: phorestForm,
    presets: [
      // The connection is named "Phorest" whichever server it is on: the gallery's ways name the server
      // ("Phorest · Europe", "Phorest · Americas & Australia").
      { id: "eu", label: "Phorest", values: { region: "eu" } },
      { id: "us", label: "Phorest", values: { region: "us" } },
    ],
    note: "Bookings are written to Phorest first, and confirmed here once Phorest took them.",
    disconnectNote: "Ask Phorest to switch off the API access it gave you, if nothing else uses it.",
    ready: () => (switchedOn ? true : "Phorest is not switched on here yet."),
    whenNotReady: {
      status: "setup",
      hint: "Not available yet. When it is, you connect with the API access Phorest gives your salon.",
      href: PHOREST_DOCS,
      tag: "Not available yet",
    },

    async connect(ctx, input): Promise<Connected> {
      const region: PhorestRegion = input.region === "us" ? "us" : "eu";
      const businessId = (input.business_id ?? "").trim();
      const secret = { username: phorestUsername(input.username ?? ""), password: input.password ?? "" };
      const where = { base: PHOREST_SERVERS[region], businessId };
      // https://developer.phorest.com/reference/getbranches.md
      const { res, json } = await call({ http: ctx.http, secret }, where, "GET", "/branch", { query: { size: "200" } });
      if (res.status === 404) {
        throw new ConnectorError("config", "Phorest does not know that business ID on this server.", {
          field: "business_id",
        });
      }
      if (res.status !== 200) throw new ConnectorError("bad_response", "Phorest answered with something unexpected.");
      const branches: Branch[] = embedded<{
        branchId?: string;
        name?: string;
        timeZone?: string;
        currencyCode?: string;
      }>(json, "branches")
        .filter((b) => typeof b.branchId === "string")
        .map((b) => ({
          id: String(b.branchId),
          name: String(b.name ?? b.branchId).slice(0, 120),
          zone: typeof b.timeZone === "string" ? b.timeZone : ctx.inbox.timezone,
          // No currency named: no price is read in a guessed one; a person prices those services.
          currency: typeof b.currencyCode === "string" ? b.currencyCode.toUpperCase() : "",
        }));
      if (branches.length === 0) {
        throw new ConnectorError("config", "That Phorest business has no branch to book.", { field: "business_id" });
      }
      return {
        account: branches[0]?.name ?? businessId,
        externalId: `${region}:${businessId}`,
        secret,
        extra: { region, businessId, branches },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
        choices: [
          {
            key: "branch",
            label: "Branch",
            options: branches.map((b) => ({ id: b.id, name: b.name })),
            value: branches[0]?.id ?? null,
          },
        ],
      };
    },

    setup: {
      async read(ctx): Promise<SetupSnapshot> {
        const where = whereOf(ctx);
        const branch = `/branch/${encodeURIComponent(where.branchId)}`;
        // https://developer.phorest.com/reference/getservices.md and getstafflist.md
        const [svcs, people] = await Promise.all([
          all<PhorestService>(ctx, where, `${branch}/service`, "services"),
          all<PhorestStaff>(ctx, where, `${branch}/staff`, "staffs"),
        ]);
        const staff = people.filter((p) => p.staffId && !p.archived && !p.hideFromOnlineBookings);
        // A week of rosters, from tomorrow: https://developer.phorest.com/reference/getstaffworktimetables.md
        const from = localOf(ctx.now + 86_400_000, where.zone).date;
        const to = localOf(ctx.now + 7 * 86_400_000, where.zone).date;
        let rosters: { staffId?: string; timeSlots?: Parameters<typeof weeklyFromRoster>[0] }[] = [];
        try {
          rosters = await all(ctx, where, `${branch}/staff/worktimetable`, "workTimeTables", {
            from_date: from,
            to_date: to,
          });
        } catch (error) {
          if (!(error instanceof ConnectorError) || error.code === "auth") throw error;
          rosters = [];
        }
        // What the salon hides from online booking is not something to book here either.
        const services = svcs
          .filter((s) => s.serviceId && !s.archived && !s.isAddonOnly && s.internetEnabled !== false)
          .map((s) => {
            const id = String(s.serviceId);
            const gives = staff
              .filter((p) => !(s.disqualifiedStaff ?? []).includes(String(p.staffId)))
              .filter((p) => !(p.disqualifiedServices ?? []).includes(id))
              .map((p) => String(p.staffId));
            const overrides = staff
              .map((p) => {
                // Their own price first, then their level's, as Phorest prices them.
                const own =
                  s.userPrices?.find((u) => u.userRef === p.userId) ??
                  (p.staffCategoryId ? s.staffCategories?.prices?.find((c) => c.id === p.staffCategoryId) : undefined);
                const length = s.userDurations?.find((u) => u.userRef === p.userId);
                const price = own ? money(own.price, where.currency) : null;
                return {
                  staff: String(p.staffId),
                  ...(price ? { price } : {}),
                  ...(typeof length?.duration === "number" ? { durationMin: length.duration } : {}),
                };
              })
              .filter((o) => o.price !== undefined || o.durationMin !== undefined)
              .filter((o) => gives.includes(o.staff));
            return {
              externalId: id,
              name: String(s.internetName || s.name || id).slice(0, 120),
              ...(typeof s.duration === "number" && s.duration > 0 ? { durationMin: s.duration } : {}),
              price: money(s.price, where.currency),
              staff: gives,
              ...(overrides.length ? { overrides } : {}),
            };
          });
        return {
          source: { kind: "phorest", account: `${where.businessId}/${where.branchId}`, readAt: ctx.now },
          services,
          staff: staff.map((p) => {
            const roster = rosters.find((r) => r.staffId === p.staffId);
            const hours = roster?.timeSlots ? weeklyFromRoster(roster.timeSlots) : {};
            return {
              externalId: String(p.staffId),
              name: [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || String(p.staffId),
              ...(Object.keys(hours).length ? { hours } : {}),
            };
          }),
        };
      },
    },

    availability: {
      async slots(ctx, q): Promise<readonly SystemSlot[]> {
        const where = whereOf(ctx);
        // https://developer.phorest.com/reference/checkappointmentavailability.md
        const { res, json } = await call(
          ctx,
          where,
          "POST",
          `/branch/${encodeURIComponent(where.branchId)}/appointments/availability`,
          {
            body: {
              startTime: phorestTime(q.from, where.zone, times),
              endTime: phorestTime(q.to, where.zone, times),
              isOnlineAvailability: true,
              clientServiceSelections: [
                {
                  serviceSelections: [
                    { serviceId: q.serviceExternalId, ...(q.staffExternalId ? { staffId: q.staffExternalId } : {}) },
                  ],
                },
              ],
            },
          },
        );
        if (res.status === 400) throw new ConnectorError("refused", detailOf(json));
        if (res.status !== 200) throw new ConnectorError("bad_response", "Phorest answered with something unexpected.");
        const data = (json as { data?: unknown } | null)?.data;
        const out: SystemSlot[] = [];
        let given = 0;
        for (const slot of Array.isArray(data) ? data : []) {
          const schedules = (slot as { clientSchedules?: { serviceSchedules?: unknown[] }[] }).clientSchedules ?? [];
          for (const cs of schedules) {
            for (const s of cs.serviceSchedules ?? []) {
              given++;
              const x = s as { serviceId?: unknown; staffId?: unknown; startTime?: unknown; endTime?: unknown };
              // Only the start is sure: a schedule with no end takes the inbox's own length for it.
              const start = readTime(x.startTime, where.zone);
              const end = x.endTime === undefined || x.endTime === null ? undefined : readTime(x.endTime, where.zone);
              if (x.serviceId !== q.serviceExternalId || typeof x.staffId !== "string") continue;
              if (!Number.isFinite(start) || (end !== undefined && !(end > start))) continue;
              out.push({ start, ...(end !== undefined ? { end } : {}), staffExternalId: x.staffId });
            }
          }
        }
        // Times it gave that none could be read: not "nothing free"; the inbox's own times are offered.
        if (given > 0 && out.length === 0) {
          throw new ConnectorError("bad_response", "Phorest gave times this inbox could not read.");
        }
        return out;
      },
    },

    bookings: {
      async put(ctx, booking, link): Promise<LinkState> {
        if (link?.externalId) {
          // Already in Phorest: the same times are nothing to do; a move is made in Phorest itself.
          if (
            (link.start === undefined || link.start === booking.start) &&
            (link.end === undefined || link.end === booking.end)
          ) {
            return { ...link, start: booking.start, end: booking.end };
          }
          throw new ConnectorError("refused", "This booking moved here: move it in Phorest too.");
        }
        if (!booking.serviceExternalId || !booking.staffExternalId) {
          throw new ConnectorError(
            "config",
            "That service or member of staff did not come from Phorest, so Phorest cannot book it.",
          );
        }
        const where = whereOf(ctx);
        const clientId = await clientFor(ctx, booking, true);
        // https://developer.phorest.com/reference/createbooking.md
        const { res, json } = await call(ctx, where, "POST", `/branch/${encodeURIComponent(where.branchId)}/booking`, {
          body: {
            clientId,
            bookingStatus: "ACTIVE",
            ...(booking.note ? { note: booking.note } : {}),
            clientAppointmentSchedules: [
              {
                clientId,
                serviceSchedules: [
                  {
                    serviceId: booking.serviceExternalId,
                    staffId: booking.staffExternalId,
                    startTime: phorestTime(booking.start, where.zone, times),
                    endTime: phorestTime(booking.end, where.zone, times),
                  },
                ],
              },
            ],
          },
        });
        if (res.status === 400) throw new ConnectorError("refused", detailOf(json));
        if (res.status === 404) throw new ConnectorError("not_found", "Phorest does not know that business or branch.");
        const bookingId = (json as { bookingId?: unknown } | null)?.bookingId;
        if ((res.status !== 201 && res.status !== 200) || typeof bookingId !== "string") {
          throw new ConnectorError("bad_response", "Phorest did not say which booking it made.");
        }
        return { externalId: bookingId, etag: null, calendar: where.branchId, start: booking.start, end: booking.end };
      },

      async remove(ctx, link): Promise<void> {
        if (!link.externalId) return;
        const where = whereOf(ctx);
        // https://developer.phorest.com/reference/cancelbooking.md
        const { res, json } = await call(
          ctx,
          where,
          "POST",
          `/branch/${encodeURIComponent(where.branchId)}/booking/${encodeURIComponent(link.externalId)}/cancel`,
        );
        if (res.status === 200 || res.status === 204 || res.status === 404) return;
        if (res.status === 400) {
          const detail = detailOf(json);
          // Cancelled there already: done. Too late under Phorest's own policy: a person cancels it there.
          if (/already/i.test(detail)) return;
          throw new ConnectorError("refused", `Phorest would not cancel it (${detail}): cancel it in Phorest.`);
        }
        throw new ConnectorError("bad_response", "Phorest answered with something unexpected.");
      },

      async find(ctx, booking): Promise<LinkState | null> {
        if (!booking.serviceExternalId || !booking.staffExternalId) return null;
        const where = whereOf(ctx);
        const clientId = await clientFor(ctx, booking, false);
        if (!clientId) return null;
        const local = localOf(booking.start, where.zone);
        // https://developer.phorest.com/reference/getappointments.md
        const { res, json } = await call(
          ctx,
          where,
          "GET",
          `/branch/${encodeURIComponent(where.branchId)}/appointment`,
          {
            query: {
              client_id: clientId,
              staff_id: booking.staffExternalId,
              from_date: local.date,
              to_date: local.date,
              size: "200",
            },
          },
        );
        if (res.status !== 200) return null;
        const hit = embedded<{
          bookingId?: string;
          serviceId?: string;
          appointmentDate?: string;
          startTime?: string;
          activationState?: string;
          deleted?: boolean;
        }>(json, "appointments").find(
          (a) =>
            a.serviceId === booking.serviceExternalId &&
            a.appointmentDate === local.date &&
            (a.startTime ?? "").slice(0, 5) === local.time.slice(0, 5) &&
            a.activationState !== "CANCELED" &&
            a.deleted !== true,
        );
        return hit?.bookingId
          ? { externalId: hit.bookingId, etag: null, calendar: where.branchId, start: booking.start, end: booking.end }
          : null;
      },
    },
  };
}
