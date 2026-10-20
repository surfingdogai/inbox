import {
  BOOKING_ID,
  BRANCH,
  BRANCHES,
  BUSINESS,
  CLIENT_ID,
  ERROR_400,
  PASSWORD,
  PHOREST_US,
  ROSTERS,
  SERVICES,
  STAFF,
  USERNAME,
} from "../fixtures/phorest";
import { type FakePlatform, type FakeRequest, fakePlatform, json } from "./platform";

/**
 * A fake Phorest (ADR-035), on the fake platform: the routes the connector uses, answering in the
 * reference's shapes (fixtures/phorest.ts), with what a salon's Phorest would hold — its clients by the
 * inbox's own id, and the bookings made, by staff, service and time. It checks what a real one would:
 * basic authentication with the `global/` username, JSON bodies, and every request is kept so a test can
 * read what was sent. No card number, no payment ever goes to it: `cardFields` lists any it was sent.
 */
export interface FakePhorest {
  readonly platform: FakePlatform;
  readonly clients: Map<string, { clientId: string; body: Record<string, unknown> }>;
  readonly bookings: Map<
    string,
    { clientId: string; serviceId: string; staffId: string; start: string; end: string; status: string }
  >;
  /** Make the next booking be refused, as a taken time is (400). */
  refuseNext(): void;
  /** Take the next booking, then lose its answer on the way back, as a timeout does. */
  loseNextAnswer(): void;
  /** Any field that looked like card data, in anything the inbox sent. */
  cardFields(): string[];
}

const AUTH = `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`;
const base = `${PHOREST_US}/api/business/${BUSINESS}`;

export function fakePhorest(): FakePhorest {
  const p = fakePlatform();
  const clients = new Map<string, { clientId: string; body: Record<string, unknown> }>();
  const bookings: FakePhorest["bookings"] = new Map();
  let refuse = false;
  let lose = false;
  let n = 0;
  const authed =
    (handler: (req: FakeRequest) => Response | Promise<Response>) =>
    (req: FakeRequest): Response | Promise<Response> =>
      req.headers.get("authorization") === AUTH ? handler(req) : json({ statusCode: 401, detail: "Unauthorized" }, 401);

  p.on(
    "GET",
    `${base}/branch`,
    authed(() => json(BRANCHES)),
  )
    .on(
      "GET",
      `${base}/branch/${BRANCH}/service`,
      authed(() => json(SERVICES)),
    )
    .on(
      "GET",
      `${base}/branch/${BRANCH}/staff`,
      authed(() => json(STAFF)),
    )
    .on(
      "GET",
      `${base}/branch/${BRANCH}/staff/worktimetable`,
      authed((req) =>
        req.url.searchParams.get("from_date") && req.url.searchParams.get("to_date")
          ? json(ROSTERS)
          : json({ statusCode: 400, detail: "from_date and to_date are required" }, 400),
      ),
    )
    .on(
      "POST",
      `${base}/branch/${BRANCH}/appointments/availability`,
      authed((req) => {
        const body = JSON.parse(req.body) as {
          startTime: string;
          clientServiceSelections: { serviceSelections: { serviceId: string; staffId?: string }[] }[];
        };
        const sel = body.clientServiceSelections[0]?.serviceSelections[0];
        const day = body.startTime.slice(0, 10);
        // Two free times the day asked: 17:00Z with either barber, 18:00Z with Mei alone.
        const slot = (start: string, end: string, staffId: string) => ({
          startTime: start,
          clientSchedules: [
            { serviceSchedules: [{ serviceId: sel?.serviceId, staffId, startTime: start, endTime: end }] },
          ],
        });
        const all = [
          slot(`${day}T17:00:00.000Z`, `${day}T17:45:00.000Z`, "G4iZa1VHaKCPcyv6Lt3BoA"),
          slot(`${day}T17:00:00.000Z`, `${day}T17:30:00.000Z`, "SE-J0emUgQnya14mOGdQS"),
          slot(`${day}T18:00:00.000Z`, `${day}T18:45:00.000Z`, "G4iZa1VHaKCPcyv6Lt3BoA"),
        ];
        const data = sel?.staffId
          ? all.filter((s) => s.clientSchedules[0]?.serviceSchedules[0]?.staffId === sel.staffId)
          : all;
        return json({ data });
      }),
    )
    .on(
      "GET",
      `${base}/client`,
      authed((req) => {
        const ref = req.url.searchParams.get("externalId") ?? "";
        const c = clients.get(ref);
        return json({
          _embedded: { clients: c ? [{ clientId: c.clientId, externalId: ref, ...c.body }] : [] },
          page: { size: 1, totalElements: c ? 1 : 0, totalPages: 1, number: 0 },
        });
      }),
    )
    .on(
      "POST",
      `${base}/client`,
      authed((req) => {
        const body = JSON.parse(req.body) as Record<string, unknown>;
        if (typeof body.firstName !== "string" || typeof body.lastName !== "string") {
          return json({ statusCode: 400, detail: "firstName and lastName are required" }, 400);
        }
        const clientId = n === 0 ? CLIENT_ID : `client-${n}`;
        n++;
        clients.set(String(body.externalId), { clientId, body });
        return json({ clientId, ...body, version: 1 }, 201);
      }),
    )
    .on(
      "POST",
      `${base}/branch/${BRANCH}/booking`,
      authed((req) => {
        if (refuse) {
          refuse = false;
          return json(ERROR_400, 400);
        }
        const body = JSON.parse(req.body) as {
          clientId: string;
          bookingStatus?: string;
          clientAppointmentSchedules: {
            clientId: string;
            serviceSchedules: { serviceId: string; staffId: string; startTime: string; endTime: string }[];
          }[];
        };
        const s = body.clientAppointmentSchedules[0]?.serviceSchedules[0];
        if (!s) return json({ statusCode: 400, detail: "no schedule" }, 400);
        const bookingId = bookings.size === 0 ? BOOKING_ID : `booking-${bookings.size}`;
        bookings.set(bookingId, {
          clientId: body.clientId,
          serviceId: s.serviceId,
          staffId: s.staffId,
          start: s.startTime,
          end: s.endTime,
          status: body.bookingStatus ?? "ACTIVE",
        });
        if (lose) {
          lose = false;
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return json({ ...body, bookingId }, 201);
      }),
    )
    .on(
      "POST",
      `${base}/branch/${BRANCH}/booking/:id/cancel`,
      authed((req) => {
        const b = bookings.get(req.params.id ?? "");
        if (!b) return json({ statusCode: 404, detail: "Not found" }, 404);
        if (b.status === "CANCELED") {
          return json({ statusCode: 400, detail: "The booking is already cancelled" }, 400);
        }
        b.status = "CANCELED";
        return new Response(null, { status: 200 });
      }),
    )
    .on(
      "GET",
      `${base}/branch/${BRANCH}/appointment`,
      authed((req) => {
        const q = req.url.searchParams;
        const toronto = (iso: string) => {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Toronto",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(iso));
          const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
          return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}:${g("second")}` };
        };
        const appointments = [...bookings.entries()]
          .filter(
            ([, b]) => b.clientId === q.get("client_id") && (!q.get("staff_id") || b.staffId === q.get("staff_id")),
          )
          .map(([bookingId, b]) => ({
            appointmentId: `appt-${bookingId}`,
            version: 1,
            appointmentDate: toronto(b.start).date,
            startTime: toronto(b.start).time,
            endTime: toronto(b.end).time,
            staffId: b.staffId,
            serviceId: b.serviceId,
            clientId: b.clientId,
            bookingId,
            activationState: b.status === "CANCELED" ? "CANCELED" : "ACTIVE",
            state: "BOOKED",
            deleted: false,
          }))
          .filter(
            (a) => a.appointmentDate >= (q.get("from_date") ?? "") && a.appointmentDate <= (q.get("to_date") ?? "9"),
          );
        return json({
          _embedded: { appointments },
          page: { size: 200, totalElements: appointments.length, totalPages: 1, number: 0 },
        });
      }),
    );
  return {
    platform: p,
    clients,
    bookings,
    refuseNext: () => {
      refuse = true;
    },
    loseNextAnswer: () => {
      lose = true;
    },
    cardFields: () =>
      p.seen.flatMap((r) => (/card|cvc|cvv|pan\b|iban|expiry/i.test(r.body) ? [`${r.method} ${r.url.pathname}`] : [])),
  };
}
