import { addLocalDays, dateIn, instantOf } from "@surfingdog/core";
import {
  ACCESS_TOKEN,
  ADULTS,
  BREAKFAST,
  CHILDREN,
  CLIENT_TOKEN,
  DORM,
  DOUBLE,
  ENTERPRISE,
  FLEX,
  PRICES,
  SERVICE,
  STAFF,
} from "../../fixtures/property/mews";
import { type FakePlatform, fakePlatform, json } from "../platform";

/**
 * A local Mews (ADR-033 §8.4), speaking the Connector API as its documentation describes it
 * (`test/fixtures/property/mews.ts` names the pages): every operation a POST of JSON to
 * `https://api.mews.com/api/connector/v1/<operation>` with the two tokens and the client's name in the
 * body; 401 for a token it does not know; 403 for a rule it applies (a night it has no room for when
 * `CheckOverbooking` is on, which is the default); 429 with `Retry-After` past 200 requests per access
 * token in a sliding 30 seconds. Reservations live in groups, `Optional` ones are let go by Mews at their
 * `ReleasedUtc`, and a night is a time unit starting at midnight in the enterprise's zone. An update
 * checks nothing, as its documentation promises nothing: it may leave a night below none. Nothing here
 * is Mews's code; the demo environment is never called, by this or anything else.
 */

const BASE = "https://api.mews.com/api/connector/v1";
const ZONE = ENTERPRISE.TimeZoneIdentifier;
const LIVE = new Set(["Confirmed", "Optional", "Started"]);

interface Reservation {
  Id: string;
  GroupId: string;
  ServiceId: string;
  Number: string;
  State: string;
  Origin: string;
  StartUtc: string;
  EndUtc: string;
  ReleasedUtc: string | null;
  CancelledUtc: string | null;
  CreatedUtc: string;
  UpdatedUtc: string;
  RequestedCategoryId: string;
  RateId: string;
  CustomerId: string;
  PersonCounts: { AgeCategoryId: string; Count: number }[];
}

export interface FakeMews {
  readonly platform: FakePlatform;
  readonly reservations: Map<string, Reservation>;
  readonly notes: { Id: string; OrderId: string; Text: string; Type: string }[];
  readonly customers: Map<string, { Id: string; LastName: string; FirstName?: string; Email?: string }>;
  /** Moves the fake's clock on: an `Optional` reservation past its release is let go. */
  advance(ms: number): void;
  now(): number;
  /** Rooms sold by another channel on a night. */
  sell(categoryId: string, night: string, count?: number): void;
  /** Units free on a night, as Mews counts them (below none when overbooked). */
  free(categoryId: string, night: string): number;
  /** Spends the access token's 200 requests, so the next one is told to wait. */
  exhaust(): void;
  /** Every request's body as JSON, by operation, for what was sent. */
  bodies(operation: string): Record<string, unknown>[];
}

function nightsOf(r: Pick<Reservation, "StartUtc" | "EndUtc">): string[] {
  const from = dateIn(Date.parse(r.StartUtc), ZONE);
  const to = dateIn(Date.parse(r.EndUtc), ZONE);
  const out: string[] = [];
  for (let n = from; n < to; n = addLocalDays(n, 1)) out.push(n);
  return out;
}

function amount(value: number) {
  const gross = Math.round(value * 100) / 100;
  const net = Math.round((gross / 1.1) * 100) / 100;
  return {
    Currency: ENTERPRISE.Currency,
    NetValue: net,
    GrossValue: gross,
    TaxValues: [{ Code: "AT-2020-R", Value: Math.round((gross - net) * 100) / 100 }],
    Breakdown: {
      Items: [{ TaxRateCode: "AT-2020-R", NetValue: net, TaxValue: Math.round((gross - net) * 100) / 100 }],
    },
  };
}

export function fakeMews(opts: { readonly units?: Readonly<Record<string, number>> } = {}): FakeMews {
  const platform = fakePlatform();
  const reservations = new Map<string, Reservation>();
  const notes: FakeMews["notes"] = [];
  const customers: FakeMews["customers"] = new Map();
  const sold = new Map<string, number>();
  const units: Record<string, number> = { [DORM.Id]: DORM.units, [DOUBLE.Id]: DOUBLE.units, ...(opts.units ?? {}) };
  const calls: number[] = [];
  let offset = 0;
  let seq = 0;
  const now = () => Date.now() + offset;
  const id = (prefix: string) => {
    seq++;
    return `${prefix}${String(seq).padStart(4, "0")}-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  };
  const isoNow = () => new Date(now()).toISOString();

  /** Mews lets an unconfirmed reservation go at its release. */
  const release = () => {
    for (const r of reservations.values()) {
      if (r.State === "Optional" && r.ReleasedUtc && Date.parse(r.ReleasedUtc) <= now()) {
        r.State = "Canceled";
        r.CancelledUtc = r.ReleasedUtc;
      }
    }
  };
  const booked = (categoryId: string, night: string) => {
    release();
    let n = sold.get(`${categoryId}|${night}`) ?? 0;
    for (const r of reservations.values()) {
      if (LIVE.has(r.State) && r.RequestedCategoryId === categoryId && nightsOf(r).includes(night)) n++;
    }
    return n;
  };
  const free = (categoryId: string, night: string) => (units[categoryId] ?? 0) - booked(categoryId, night);

  const operation = (op: string, handler: (body: Record<string, unknown>) => Response) =>
    platform.on("POST", `${BASE}/${op}`, (req) => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        return json({ Message: "Invalid JSON" }, 400);
      }
      if (body.ClientToken !== CLIENT_TOKEN || body.AccessToken !== ACCESS_TOKEN || typeof body.Client !== "string") {
        return json({ Message: "Invalid tokens." }, 401);
      }
      // 200 requests per access token, in a sliding 30 seconds.
      const t = now();
      while (calls.length && (calls[0] ?? 0) <= t - 30_000) calls.shift();
      if (calls.length >= 200) {
        const wait = Math.max(1, Math.ceil(((calls[0] ?? t) + 30_000 - t) / 1000));
        return json({ Message: "Too many requests." }, 429, { "retry-after": String(wait) });
      }
      calls.push(t);
      return handler(body);
    });

  const page = <T>(items: T[], body: Record<string, unknown>, key: string, extra: Record<string, unknown> = {}) => {
    const limitation = (body.Limitation ?? {}) as { Count?: number; Cursor?: string };
    if (typeof limitation.Count !== "number") return json({ Message: "Invalid Limitation." }, 400);
    const start = limitation.Cursor ? Number(limitation.Cursor) : 0;
    const slice = items.slice(start, start + limitation.Count);
    const next = start + slice.length < items.length ? String(start + slice.length) : null;
    return json({ [key]: slice, ...(next ? { Cursor: next } : {}), ...extra });
  };
  const timeUnits = (body: Record<string, unknown>): string[] | null => {
    const first = Date.parse(String(body.FirstTimeUnitStartUtc));
    const last = Date.parse(String(body.LastTimeUnitStartUtc));
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
    const out: string[] = [];
    for (let n = dateIn(first, ZONE); n <= dateIn(last, ZONE); n = addLocalDays(n, 1)) out.push(n);
    return out.length > 367 ? null : out;
  };
  const unitStarts = (nights: string[]) =>
    nights.map((n) => new Date(instantOf(n, "00:00", ZONE)).toISOString().replace(".000Z", "Z"));
  const view = (r: Reservation) => ({
    Id: r.Id,
    ServiceId: r.ServiceId,
    GroupId: r.GroupId,
    AccountId: r.CustomerId,
    AccountType: "Customer",
    Number: r.Number,
    State: r.State,
    Origin: r.Origin,
    CreatedUtc: r.CreatedUtc,
    UpdatedUtc: r.UpdatedUtc,
    CancelledUtc: r.CancelledUtc,
    RateId: r.RateId,
    RequestedResourceCategoryId: r.RequestedCategoryId,
    ReleasedUtc: r.ReleasedUtc,
    ScheduledStartUtc: r.StartUtc,
    ScheduledEndUtc: r.EndUtc,
    PersonCounts: r.PersonCounts,
  });

  operation("configuration/get", () =>
    json({
      NowUtc: isoNow(),
      Enterprise: {
        Id: ENTERPRISE.Id,
        Name: ENTERPRISE.Name,
        TimeZoneIdentifier: ENTERPRISE.TimeZoneIdentifier,
        Currencies: [
          { Currency: "EUR", IsDefault: true, IsEnabled: true },
          { Currency: "CHF", IsDefault: false, IsEnabled: true },
        ],
        DefaultLanguageCode: "de-AT",
        Pricing: "Gross",
        Email: ENTERPRISE.Email,
        WebsiteUrl: ENTERPRISE.WebsiteUrl,
        IsPortfolio: false,
      },
    }),
  );
  operation("services/getAll", (body) => {
    const all = [
      {
        Id: SERVICE.Id,
        EnterpriseId: ENTERPRISE.Id,
        IsActive: true,
        Names: { "de-AT": "Unterkunft", "en-GB": SERVICE.Name },
        Data: {
          Discriminator: "Bookable",
          Value: {
            StartOffset: SERVICE.StartOffset,
            EndOffset: SERVICE.EndOffset,
            OccupancyStartOffset: SERVICE.StartOffset,
            OccupancyEndOffset: SERVICE.EndOffset,
            TimeUnitPeriod: "Day",
          },
        },
      },
      {
        Id: BREAKFAST.Id,
        EnterpriseId: ENTERPRISE.Id,
        IsActive: true,
        Names: { "en-GB": BREAKFAST.Name },
        Data: { Discriminator: "Additional", Value: { Promotions: {} } },
      },
    ];
    const ids = Array.isArray(body.ServiceIds) ? (body.ServiceIds as string[]) : null;
    return page(
      all.filter((s) => !ids || ids.includes(s.Id)),
      body,
      "Services",
    );
  });
  operation("resourceCategories/getAll", (body) => {
    if (!Array.isArray(body.ServiceIds)) return json({ Message: "Invalid ServiceIds." }, 400);
    const cats = (body.ServiceIds as string[]).includes(SERVICE.Id)
      ? [DORM, DOUBLE].map((c, i) => ({
          Id: c.Id,
          EnterpriseId: ENTERPRISE.Id,
          ServiceId: SERVICE.Id,
          IsActive: true,
          Type: c === DORM ? "Bed" : "Room",
          Names: { "en-GB": c.Name },
          ShortNames: { "en-GB": c.Name },
          Ordering: i,
          Capacity: c.Capacity,
          ExtraCapacity: 0,
        }))
      : [];
    return page(cats, body, "ResourceCategories");
  });
  operation("resourceCategoryAssignments/getAll", (body) => {
    const ids = Array.isArray(body.ResourceCategoryIds) ? (body.ResourceCategoryIds as string[]) : [];
    const out = ids.flatMap((c) =>
      Array.from({ length: units[c] ?? 0 }, (_, i) => ({
        Id: `${c.slice(0, 8)}-a${i}`,
        ResourceId: `${c.slice(0, 8)}-r${i}`,
        CategoryId: c,
        IsActive: true,
      })),
    );
    return page(out, body, "ResourceCategoryAssignments");
  });
  operation("rates/getAll", (body) =>
    page(
      [
        { Id: FLEX.Id, ServiceId: SERVICE.Id, IsActive: true, IsEnabled: true, IsPublic: true, Name: FLEX.Name },
        { Id: STAFF.Id, ServiceId: SERVICE.Id, IsActive: true, IsEnabled: true, IsPublic: false, Name: STAFF.Name },
      ],
      body,
      "Rates",
    ),
  );
  operation("rates/getPricing", (body) => {
    const nights = timeUnits(body);
    if (!nights) return json({ Message: "Invalid time interval." }, 400);
    if (body.RateId !== FLEX.Id && body.RateId !== STAFF.Id) return json({ Message: "Invalid RateId." }, 400);
    return json({
      Currency: ENTERPRISE.Currency,
      TimeUnitStartsUtc: unitStarts(nights),
      BaseAmountPrices: nights.map(() => amount(PRICES[DORM.Id] ?? 0)),
      CategoryPrices: [DORM, DOUBLE].map((c) => ({
        CategoryId: c.Id,
        AmountPrices: nights.map(() => amount(PRICES[c.Id] ?? 0)),
      })),
      CategoryAdjustments: [],
      AgeCategoryAdjustments: [],
    });
  });
  operation("services/getAvailability", (body) => {
    if (body.ServiceId !== SERVICE.Id) return json({ Message: "Invalid ServiceId." }, 400);
    const nights = timeUnits(body);
    if (!nights) return json({ Message: "Invalid time interval." }, 400);
    return json({
      CategoryAvailabilities: [DORM, DOUBLE].map((c) => ({
        CategoryId: c.Id,
        Availabilities: nights.map((n) => free(c.Id, n)),
        Adjustments: nights.map(() => 0),
      })),
      TimeUnitStartsUtc: unitStarts(nights),
    });
  });
  operation("ageCategories/getAll", (body) =>
    page(
      [
        {
          ...ADULTS,
          ServiceId: SERVICE.Id,
          MinimalAge: null,
          MaximalAge: null,
          IsActive: true,
          Names: { "en-GB": "Adults" },
        },
        { ...CHILDREN, ServiceId: SERVICE.Id, IsActive: true, Names: { "en-GB": "Children" } },
      ],
      body,
      "AgeCategories",
    ),
  );
  operation("reservations/price", (body) => {
    const list = Array.isArray(body.Reservations) ? (body.Reservations as Record<string, unknown>[]) : [];
    return json({
      ReservationPrices: list.map((r) => {
        const n = nightsOf({ StartUtc: String(r.StartUtc), EndUtc: String(r.EndUtc) }).length;
        return { Identifier: r.Identifier, TotalAmount: amount((PRICES[String(r.RequestedCategoryId)] ?? 0) * n) };
      }),
    });
  });
  operation("customers/getAll", (body) => {
    const emails = Array.isArray(body.Emails) ? (body.Emails as string[]) : [];
    return page(
      [...customers.values()].filter((c) => c.Email && emails.includes(c.Email)),
      body,
      "Customers",
    );
  });
  operation("customers/add", (body) => {
    if (typeof body.LastName !== "string" || !body.LastName) return json({ Message: "Invalid LastName." }, 400);
    const email = typeof body.Email === "string" ? body.Email : undefined;
    if (email && [...customers.values()].some((c) => c.Email === email) && body.OverwriteExisting !== true) {
      return json({ Message: "A customer with that email exists." }, 403);
    }
    const c = {
      Id: id("c"),
      LastName: body.LastName,
      ...(typeof body.FirstName === "string" ? { FirstName: body.FirstName } : {}),
      ...(email ? { Email: email } : {}),
    };
    customers.set(c.Id, c);
    return json(c);
  });
  operation("reservations/add", (body) => {
    if (body.ServiceId !== SERVICE.Id) return json({ Message: "Invalid ServiceId." }, 400);
    const list = Array.isArray(body.Reservations) ? (body.Reservations as Record<string, unknown>[]) : [];
    if (list.length === 0) return json({ Message: "Invalid Reservations." }, 400);
    const check = body.CheckOverbooking !== false;
    const want = new Map<string, number>();
    for (const r of list) {
      if (!customers.has(String(r.CustomerId))) return json({ Message: "Invalid CustomerId." }, 400);
      if (r.RateId !== FLEX.Id) return json({ Message: "Invalid RateId." }, 400);
      if (!(String(r.RequestedCategoryId) in units)) return json({ Message: "Invalid RequestedCategoryId." }, 400);
      if (r.State === "Optional" && !r.ReleasedUtc) return json({ Message: "Invalid ReleasedUtc." }, 400);
      for (const n of nightsOf({ StartUtc: String(r.StartUtc), EndUtc: String(r.EndUtc) })) {
        const key = `${String(r.RequestedCategoryId)}|${n}`;
        want.set(key, (want.get(key) ?? 0) + 1);
      }
    }
    if (check) {
      for (const [key, n] of want) {
        const [cat, night] = key.split("|");
        if (free(cat ?? "", night ?? "") < n) return json({ Message: "The reservations would overbook." }, 403);
      }
    }
    const group = id("g");
    const added = list.map((r) => {
      const res: Reservation = {
        Id: id("r"),
        GroupId: group,
        ServiceId: SERVICE.Id,
        Number: String(100 + seq),
        State: r.State === "Optional" ? "Optional" : "Confirmed",
        Origin: "Connector",
        StartUtc: String(r.StartUtc),
        EndUtc: String(r.EndUtc),
        ReleasedUtc: r.State === "Optional" ? String(r.ReleasedUtc) : null,
        CancelledUtc: null,
        CreatedUtc: isoNow(),
        UpdatedUtc: isoNow(),
        RequestedCategoryId: String(r.RequestedCategoryId),
        RateId: String(r.RateId),
        CustomerId: String(r.CustomerId),
        PersonCounts: (r.PersonCounts ?? []) as Reservation["PersonCounts"],
      };
      reservations.set(res.Id, res);
      if (typeof r.Notes === "string" && r.Notes)
        notes.push({ Id: id("n"), OrderId: res.Id, Text: r.Notes, Type: "General" });
      return { Identifier: r.Identifier, Reservation: { ...view(res), StartUtc: res.StartUtc, EndUtc: res.EndUtc } };
    });
    return json({ Reservations: added });
  });
  operation("reservations/getAll/2023-06-06", (body) => {
    release();
    const ids = Array.isArray(body.ReservationIds) ? (body.ReservationIds as string[]) : null;
    const groups = Array.isArray(body.ReservationGroupIds) ? (body.ReservationGroupIds as string[]) : null;
    const services = Array.isArray(body.ServiceIds) ? (body.ServiceIds as string[]) : null;
    const states = Array.isArray(body.States) ? (body.States as string[]) : null;
    const created = body.CreatedUtc as { StartUtc?: string; EndUtc?: string } | undefined;
    const list = [...reservations.values()].filter(
      (r) =>
        (!ids || ids.includes(r.Id)) &&
        (!groups || groups.includes(r.GroupId)) &&
        (!services || services.includes(r.ServiceId)) &&
        (!states || states.includes(r.State)) &&
        (!created ||
          (Date.parse(r.CreatedUtc) >= Date.parse(String(created.StartUtc)) &&
            Date.parse(r.CreatedUtc) < Date.parse(String(created.EndUtc)))),
    );
    return page(list.map(view), body, "Reservations");
  });
  operation("serviceOrderNotes/getAll", (body) => {
    const ids = Array.isArray(body.ServiceOrderIds) ? (body.ServiceOrderIds as string[]) : [];
    if (ids.length === 0) return json({ Message: "Invalid ServiceOrderIds." }, 400);
    return page(
      notes.filter((n) => ids.includes(n.OrderId)),
      body,
      "ServiceOrderNotes",
    );
  });
  operation("reservations/update", (body) => {
    release();
    const updates = Array.isArray(body.ReservationUpdates)
      ? (body.ReservationUpdates as Record<string, unknown>[])
      : [];
    for (const u of updates) {
      const r = reservations.get(String(u.ReservationId));
      if (!r) return json({ Message: "Invalid ReservationId." }, 400);
      if (!LIVE.has(r.State)) return json({ Message: "The reservation cannot be changed." }, 403);
    }
    // No overbooking check: the documentation promises none for an update.
    for (const u of updates) {
      const r = reservations.get(String(u.ReservationId)) as Reservation;
      const v = (k: string) => (u[k] as { Value?: unknown } | undefined)?.Value;
      if (typeof v("StartUtc") === "string") r.StartUtc = String(v("StartUtc"));
      if (typeof v("EndUtc") === "string") r.EndUtc = String(v("EndUtc"));
      if (typeof v("RequestedCategoryId") === "string") r.RequestedCategoryId = String(v("RequestedCategoryId"));
      if (typeof v("RateId") === "string") r.RateId = String(v("RateId"));
      if (Array.isArray(v("PersonCounts"))) r.PersonCounts = v("PersonCounts") as Reservation["PersonCounts"];
      r.UpdatedUtc = isoNow();
    }
    return json({ Reservations: updates.map((u) => view(reservations.get(String(u.ReservationId)) as Reservation)) });
  });
  operation("reservations/confirm", (body) => {
    release();
    const ids = Array.isArray(body.ReservationIds) ? (body.ReservationIds as string[]) : [];
    const list = ids.map((x) => reservations.get(x));
    if (list.some((r) => r?.State !== "Optional"))
      return json({ Message: "Only optional reservations can be confirmed." }, 403);
    for (const r of list as Reservation[]) {
      r.State = "Confirmed";
      r.ReleasedUtc = null;
      r.UpdatedUtc = isoNow();
    }
    return json({ ReservationIds: ids });
  });
  operation("reservations/cancel", (body) => {
    release();
    if (typeof body.Notes !== "string" || !body.Notes) return json({ Message: "Invalid Notes." }, 400);
    const ids = Array.isArray(body.ReservationIds) ? (body.ReservationIds as string[]) : [];
    const list = ids.map((x) => reservations.get(x));
    if (list.some((r) => !r || !LIVE.has(r.State) || r.State === "Started")) {
      return json({ Message: "The reservation cannot be canceled." }, 403);
    }
    for (const r of list as Reservation[]) {
      r.State = "Canceled";
      r.CancelledUtc = isoNow();
      r.UpdatedUtc = isoNow();
    }
    return json({ ReservationIds: ids });
  });
  operation("reservations/updateCustomer", (body) => {
    const r = reservations.get(String(body.ReservationId));
    if (!r || !customers.has(String(body.CustomerId))) return json({ Message: "Invalid ReservationId." }, 400);
    r.CustomerId = String(body.CustomerId);
    return json({});
  });

  return {
    platform,
    reservations,
    notes,
    customers,
    advance(ms) {
      offset += ms;
    },
    now,
    sell(categoryId, night, count = 1) {
      sold.set(`${categoryId}|${night}`, (sold.get(`${categoryId}|${night}`) ?? 0) + count);
    },
    free,
    exhaust() {
      const t = now();
      while (calls.length < 200) calls.push(t);
    },
    bodies(op) {
      return platform.seen
        .filter((r) => r.url.pathname === `/api/connector/v1/${op}`)
        .map((r) => JSON.parse(r.body) as Record<string, unknown>);
    },
  };
}
