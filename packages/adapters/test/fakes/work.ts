import type { FakePlatform, FakeRequest } from "./platform";
import { json } from "./platform";

/**
 * Job tools as local fakes (ADR-039 §5), each answering the way its published reference says, with
 * shapes transcribed from it. No real job tool is ever called.
 *
 * - ServiceM8: https://developer.servicem8.com/reference/createjobs.md (x-record-uuid, `{"errorCode":0,
 *   "message":"OK"}`), getjobs.md (404 `Resource not found…`), listvendors.md, listjobactivities.md,
 *   createattachments.md (one multipart POST), docs/pagination.md (`x-next-cursor`),
 *   post_object_webhook_subscription.md (`{"success": true}`), and the 429 bodies of every reference page.
 * - Housecall Pro: reference/housecall.v1.yaml of its public Stoplight project (`Authorization: Token`,
 *   `GET /company`, `POST /leads` 201 Lead, `GET /leads` and `GET /jobs` paginated lists).
 * - Fergus: https://api.fergus.com/docs/json (`{"result": …, "data": …}`, `POST /enquiries` 201,
 *   `POST /attachments` multipart 201, `GET /calendarEvents`, `retry-after` on 429).
 * - Jobber: the GraphQL schema of github.com/GetJobber/Jobber-AppTemplate-RailsAPI (`db/schema.json`)
 *   and its `X-JOBBER-GRAPHQL-VERSION` header.
 */

/** The fields of a multipart body, by name (the file's own as `filename`). */
export function formFields(req: FakeRequest): Record<string, string> {
  const type = req.headers.get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  if (!boundary) return {};
  const out: Record<string, string> = {};
  for (const part of req.body.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]+)"/.exec(part)?.[1];
    const value = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    out[name] = filename ? `file:${filename}:${value.length}` : value;
  }
  return out;
}

/** Whether any request carried what looks like card data: no fake may ever see one. */
export function cardDataSent(p: FakePlatform): boolean {
  return p.seen.some((r) => /card_?number|"cvc"|"cvv"|"pan"|exp_month/i.test(r.body));
}

/* --- ServiceM8 ----------------------------------------------------------------- */

export const SM8 = "https://api.servicem8.com/api_1.0";

export interface Sm8State {
  key: string;
  readonly records: Map<string, Record<string, unknown>>;
  readonly attachments: Record<string, string>[];
  readonly subscriptions: URLSearchParams[];
  activities: Record<string, unknown>[];
  pageSize: number;
}

export function fakeServiceM8(p: FakePlatform, key = "smk-fundiflow-0001"): Sm8State {
  const state: Sm8State = {
    key,
    records: new Map(),
    attachments: [],
    subscriptions: [],
    activities: [],
    pageSize: 1000,
  };
  const authed = (req: FakeRequest) =>
    req.headers.get("x-api-key") === state.key || req.headers.get("authorization") === `Bearer ${state.key}`;
  const denied = () =>
    json({ errorCode: "401", message: "Authentication failed. Please check your API key or OAuth token." }, 401);
  p.on("GET", `${SM8}/vendor.json`, (req) =>
    authed(req)
      ? json([
          {
            uuid: "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
            active: 1,
            name: "Fundi Flow Plumbing",
            currency: "KES",
            timezone_name: "Africa/Nairobi",
            // getvendors.md: "The minute of the day (from midnight) when the business opens", as strings.
            ...Object.fromEntries(
              ["monday", "tuesday", "wednesday", "thursday", "friday"].flatMap((d) => [
                [`opening_time_${d}`, "480"],
                [`closing_time_${d}`, "1020"],
              ]),
            ),
            opening_time_saturday: "540",
            closing_time_saturday: "780",
            opening_time_sunday: "0",
            closing_time_sunday: "0",
          },
        ])
      : denied(),
  );
  p.on("GET", `${SM8}/jobactivity.json`, (req) => {
    if (!authed(req)) return denied();
    const cursor = req.url.searchParams.get("cursor") ?? "-1";
    const start = cursor === "-1" ? 0 : Number(cursor);
    const page = state.activities.slice(start, start + state.pageSize);
    const next = start + state.pageSize < state.activities.length ? String(start + state.pageSize) : null;
    return json(page, 200, next ? { "x-next-cursor": next } : {});
  });
  p.on("GET", `${SM8}/:object/:file`, (req) => {
    if (!authed(req)) return denied();
    const uuid = (req.params.file ?? "").replace(/\.json$/, "");
    const r = state.records.get(`${req.params.object}:${uuid}`);
    return r
      ? json(r)
      : json(
          { errorCode: "404", message: "Resource not found. The requested record does not exist or has been deleted." },
          404,
        );
  });
  p.on("POST", `${SM8}/attachment.json`, (req) => {
    if (!authed(req)) return denied();
    const f = formFields(req);
    state.attachments.push(f);
    if (f.uuid) state.records.set(`attachment:${f.uuid}`, { uuid: f.uuid, related_object_uuid: f.related_object_uuid });
    return json({ errorCode: 0, message: "OK" }, 200, { "x-record-uuid": f.uuid ?? "" });
  });
  for (const object of ["company", "job", "jobcontact"]) {
    p.on("POST", `${SM8}/${object}.json`, (req) => {
      if (!authed(req)) return denied();
      const body = JSON.parse(req.body) as Record<string, unknown>;
      const uuid = String(body.uuid ?? crypto.randomUUID());
      state.records.set(`${object}:${uuid}`, { ...body, uuid, active: 1 });
      return json({ errorCode: 0, message: "OK" }, 200, { "x-record-uuid": uuid });
    });
  }
  p.on("POST", "https://api.servicem8.com/webhook_subscriptions/object", (req) => {
    if (!authed(req)) return denied();
    state.subscriptions.push(new URLSearchParams(req.body));
    return json({ success: true });
  });
  return state;
}

/* --- Housecall Pro --------------------------------------------------------------- */

export const HCP = "https://api.housecallpro.com";

export interface HcpState {
  key: string;
  readonly leads: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
}

export function fakeHousecallPro(p: FakePlatform, key = "hcp-southerncross-key"): HcpState {
  const state: HcpState = { key, leads: [], jobs: [] };
  const authed = (req: FakeRequest) => req.headers.get("authorization") === `Token ${state.key}`;
  const denied = () => json({ error: "unauthorized" }, 401);
  p.on("GET", `${HCP}/company`, (req) =>
    authed(req) ? json({ id: "cmp_8b2f", name: "Southern Cross Renovations", time_zone: "Australia/Perth" }) : denied(),
  );
  p.on("GET", `${HCP}/leads`, (req) => {
    if (!authed(req)) return denied();
    const size = Number(req.url.searchParams.get("page_size") ?? 10);
    const page = Number(req.url.searchParams.get("page") ?? 1);
    const newest = [...state.leads].reverse();
    return json({
      page,
      page_size: size,
      total_pages: Math.max(1, Math.ceil(newest.length / size)),
      total_items: newest.length,
      leads: newest.slice((page - 1) * size, page * size),
    });
  });
  p.on("POST", `${HCP}/leads`, (req) => {
    if (!authed(req)) return denied();
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const lead = { id: `lea_${state.leads.length + 1}`, number: state.leads.length + 1, status: "open", ...body };
    state.leads.push(lead);
    return json(lead, 201);
  });
  p.on("GET", `${HCP}/jobs`, (req) => {
    if (!authed(req)) return denied();
    return json({ page: 1, page_size: 100, total_pages: 1, total_items: state.jobs.length, jobs: state.jobs });
  });
  return state;
}

/* --- Fergus ------------------------------------------------------------------------ */

export const FERGUS = "https://api.fergus.com";

export interface FergusState {
  token: string;
  readonly enquiries: Record<string, unknown>[];
  readonly attachments: Record<string, string>[];
  events: Record<string, unknown>[];
}

export function fakeFergus(p: FakePlatform, token = "fergus-pat-elektro"): FergusState {
  const state: FergusState = { token, enquiries: [], attachments: [], events: [] };
  const authed = (req: FakeRequest) => req.headers.get("authorization") === `Bearer ${state.token}`;
  const denied = () => json({ result: "error", message: "Unauthorized" }, 401);
  p.on("GET", `${FERGUS}/company`, (req) =>
    authed(req)
      ? json({
          result: "success",
          data: { guid: "8a7d2c1e-elektro", prefix: "EB", name: "Elektro Brandt", active: true },
        })
      : denied(),
  );
  p.on("GET", `${FERGUS}/enquiries`, (req) => {
    if (!authed(req)) return denied();
    const text = req.url.searchParams.get("filterSearchText") ?? "";
    const list = state.enquiries.filter((e) => String(e.description ?? "").includes(text));
    return json({ result: "success", data: list, paging: { perPage: 10, pageCount: 1, links: {} } });
  });
  p.on("POST", `${FERGUS}/enquiries`, (req) => {
    if (!authed(req)) return denied();
    const body = JSON.parse(req.body) as Record<string, unknown>;
    if (!body.name || !body.description || !body.source)
      return json({ result: "error", message: "name, description and source" }, 400);
    const enquiry = {
      id: 100 + state.enquiries.length,
      status: "TODO",
      createdAt: new Date(0).toISOString(),
      ...body,
      links: [],
    };
    state.enquiries.push(enquiry);
    return json({ result: "success", data: enquiry }, 201);
  });
  p.on("GET", `${FERGUS}/attachments`, (req) => {
    if (!authed(req)) return denied();
    const id = req.url.searchParams.get("entityId");
    return json({
      result: "success",
      data: state.attachments.filter((a) => a.entityId === id).map((a) => ({ fileName: a.fileName })),
    });
  });
  p.on("POST", `${FERGUS}/attachments`, (req) => {
    if (!authed(req)) return denied();
    const f = formFields(req);
    const fileName = /^file:([^:]+):/.exec(f.file ?? "")?.[1] ?? "";
    state.attachments.push({ ...f, fileName });
    return json(
      {
        result: "success",
        data: { id: state.attachments.length, entityType: f.entityType, entityId: Number(f.entityId), fileName },
      },
      201,
    );
  });
  p.on("GET", `${FERGUS}/calendarEvents`, (req) =>
    authed(req) ? json({ result: "success", data: state.events }) : denied(),
  );
  return state;
}

/* --- Jobber -------------------------------------------------------------------------- */

export const JOBBER = "https://api.getjobber.com/api";

export interface JobberState {
  token: string;
  readonly requests: { id: string; title: string; jobberWebUri: string }[];
  readonly clients: Record<string, unknown>[];
  readonly notes: string[];
  visits: { id: string; startAt: string; endAt: string }[];
  readonly versions: string[];
}

export function fakeJobber(p: FakePlatform, token = "jobber-access-1"): JobberState {
  const state: JobberState = { token, requests: [], clients: [], notes: [], visits: [], versions: [] };
  p.on("POST", `${JOBBER}/oauth/token`, () =>
    json({ access_token: state.token, refresh_token: "jobber-refresh-1", expires_in: 3600 }),
  );
  p.on("POST", `${JOBBER}/graphql`, (req) => {
    state.versions.push(req.headers.get("x-jobber-graphql-version") ?? "");
    if (req.headers.get("authorization") !== `Bearer ${state.token}`) return json({ message: "Unauthorized" }, 401);
    const { query, variables } = JSON.parse(req.body) as { query: string; variables: Record<string, unknown> };
    if (query.includes("requests(searchTerm")) {
      const term = String(variables.term ?? "");
      return json({ data: { requests: { nodes: state.requests.filter((r) => r.title.includes(term)) } } });
    }
    if (query.includes("clients(searchTerm")) {
      const term = String(variables.term ?? "");
      const nodes = state.clients
        .filter((c) => JSON.stringify(c).includes(term))
        .map((c) => ({
          id: c.id,
          emails: c.emails ?? [],
          phones: c.phones ?? [],
          clientProperties: { nodes: [{ id: `${String(c.id)}P` }] },
        }));
      return json({ data: { clients: { nodes } } });
    }
    if (query.includes("requestSettings"))
      return json({ data: { requestSettings: { forms: { nodes: [{ id: "Z2lkOi8vRm9ybS8x" }] } } } });
    if (query.includes("clientCreate")) {
      const id = `Z2lkOi8vQ2xpZW50LyR${state.clients.length + 1}`;
      state.clients.push({ id, ...(variables.input as Record<string, unknown>) });
      return json({
        data: { clientCreate: { client: { id, clientProperties: { nodes: [{ id: `${id}P` }] } }, userErrors: [] } },
      });
    }
    if (query.includes("requestCreateNote")) {
      state.notes.push(String((variables.input as { message?: string }).message ?? ""));
      return json({ data: { requestCreateNote: { userErrors: [] } } });
    }
    if (query.includes("requestCreate")) {
      const input = variables.input as { title: string };
      const r = {
        id: `Z2lkOi8vUmVxdWVzdC8${state.requests.length + 1}`,
        title: input.title,
        jobberWebUri: "https://secure.getjobber.com/requests/1",
      };
      state.requests.push(r);
      return json({ data: { requestCreate: { request: r, userErrors: [] } } });
    }
    if (query.includes("visits(")) {
      return json({ data: { visits: { nodes: state.visits, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("account"))
      return json({ data: { account: { id: "Z2lkOi8vQWNjb3VudC85", name: "Sur Techos" } } });
    return json({ errors: [{ message: "unknown query" }] }, 200);
  });
  return state;
}
