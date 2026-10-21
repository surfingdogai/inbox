import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type HookEvent,
  type Interval,
  mergeIntervals,
  type OutboundRequest,
  type RequestRef,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { constantTimeEqual, hmacSha256Base64, hmacSha256Hex } from "../hook-sign";
import { jsonOf, splitName } from "./common";

/**
 * Housecall Pro (ADR-034 §5), with the business's own API key: "Any Housecall Pro user on the MAX plan
 * has access to creating API keys, and you are welcome to reference our open API docs to build an
 * integration on their behalf" (https://docs.housecallpro.com). A request the owner takes on becomes a
 * lead (`POST /leads`, with the customer inline), which shows in the Job inbox once its API Leads
 * channel is on; the scheduled jobs are the busy times visits are offered around. Leads take no files:
 * the photos stay in the business's inbox, linked from the lead's note.
 *
 * Housecall Pro chooses its own ids, so a lead is written with a tag naming the request, and a lead whose
 * answer never came is looked for by that tag among the newest before it is written again. Webhooks
 * (MAX plan, set up by the owner in Housecall Pro) are signed: `Api-Signature`, an HMAC-SHA-256 under the
 * signing secret over `Api-Timestamp + "." + body`; the docs do not say hex or base64, so both are
 * checked, in constant time, and a webhook is only ever a nudge to read the schedule again.
 *
 * Sources, read 21 Oct 2026: the reference `reference/housecall.v1.yaml` of the public Stoplight project
 * (docs.housecallpro.com/docs/housecall-public-api), its `docs/authentication.md` and `docs/webhooks.md`.
 */

export const HOUSECALLPRO_API = "https://api.housecallpro.com";
/** Pages of scheduled jobs one read takes (100 a page). */
const MAX_PAGES = 5;
/** A webhook older or newer than this is refused: it may be a replay. */
const TOLERANCE_S = 300;

export const housecallproForm = z.object({
  api_key: secretField(z.string().trim().min(10).max(200), {
    label: "API key",
    help: "In Housecall Pro (MAX plan): App Store → API Key Management → Generate. Turn on API Leads in Job inbox settings too.",
    link: {
      href: "https://help.housecallpro.com/en/articles/12062219-api-leads-in-job-inbox",
      text: "API leads in your Job inbox",
    },
  }),
  signing_secret: secretField(z.string().trim().max(200).optional(), {
    label: "Webhook signing secret",
    help: "Only if you set up webhooks in Housecall Pro: the signing secret it shows.",
    advanced: true,
  }),
});

function waitMs(res: ConnectorHttpResponse, now: number): number | undefined {
  const reset = Number(res.headers.get("ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - now, 1000), 3_600_000);
  return undefined;
}

async function call(
  ctx: Pick<ConnectContext, "http" | "now">,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ res: ConnectorHttpResponse; json: unknown }> {
  const res = await ctx.http.request({
    method,
    url: `${HOUSECALLPRO_API}${path}`,
    headers: {
      authorization: `Token ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError("auth", "Housecall Pro did not take that key. Make a new one and connect again.", {
      field: "api_key",
    });
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Housecall Pro asked this inbox to slow down.", {
      retryAfterMs: waitMs(res, ctx.now),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Housecall Pro is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json: jsonOf(res) };
}

/** The tag a lead carries for the request, by which the inbox finds it again. */
export const leadTag = (r: Pick<OutboundRequest, "reference">) => `Request ${r.reference}`;

/** A UTC time as Housecall Pro writes it ("2023-03-23T15:30:00", no zone), or with one. */
function utc(text: unknown): number | null {
  if (typeof text !== "string" || !text) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(t) ? t : null;
}

async function findLead(ctx: RunContext, r: OutboundRequest): Promise<RequestRef | null> {
  const tag = leadTag(r);
  for (let page = 1; page <= 3; page++) {
    const { res, json } = await call(
      ctx,
      ctx.secret.api_key ?? "",
      "GET",
      `/leads?sort_by=created_at&sort_direction=desc&page_size=100&page=${page}`,
    );
    if (res.status !== 200) throw new ConnectorError("bad_response", "Housecall Pro did not list its leads.");
    const j = (json ?? {}) as { leads?: { id?: unknown; tags?: unknown }[]; total_pages?: unknown };
    for (const lead of j.leads ?? []) {
      if (typeof lead.id === "string" && Array.isArray(lead.tags) && lead.tags.includes(tag))
        return { externalId: lead.id };
    }
    if (page >= Number(j.total_pages ?? 1)) break;
  }
  return null;
}

/**
 * `cleared`: whoever runs the server read Housecall Pro's API terms and found the inbox's use within them
 * (`JOB_TOOLS_CLEARED=housecallpro`). Until then the card says "set up": its terms page did not load
 * when this was built, and the API needs the business's MAX plan.
 */
export function housecallproConnector(opts: { readonly cleared?: boolean | undefined } = {}): ConnectorDefinition {
  const waiting = "Needs setup: waiting on Housecall Pro's API terms.";
  return {
    kind: "housecallpro",
    title: "Housecall Pro",
    group: "work",
    capabilities: ["requests_out", "busy_times"],
    auth: "form",
    ready: () => (opts.cleared ? true : waiting),
    whenNotReady: { status: "setup", hint: waiting, href: "https://surfingdog.ai/docs/job-tools/#housecall-pro" },
    form: housecallproForm,
    note: "Requests you take on arrive as leads in your Job inbox; scheduled jobs block those times. MAX plan.",
    action: "Connect Housecall Pro",
    disconnectNote: "Remove the API key in Housecall Pro: App Store → API Key Management.",

    async connect(ctx, input) {
      const key = (input.api_key ?? "").trim();
      if (!key) throw new ConnectorError("config", "Paste the API key.", { field: "api_key" });
      const { res, json } = await call(ctx, key, "GET", "/company");
      const c = (json ?? {}) as { id?: unknown; name?: unknown; time_zone?: unknown };
      if (res.status !== 200 || typeof c.id !== "string") {
        throw new ConnectorError("bad_response", "Housecall Pro did not say which company this is.");
      }
      const signing = (input.signing_secret ?? "").trim();
      return {
        account: typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Housecall Pro",
        externalId: c.id,
        secret: { api_key: key, ...(signing ? { signing_secret: signing } : {}) },
        extra: { timezone: typeof c.time_zone === "string" ? c.time_zone : "UTC" },
        calendars: [{ id: "schedule", name: "Scheduled jobs", writable: false, primary: true }],
        destinations: [],
        defaults: { busy: ["schedule"], destination: null },
      };
    },

    async busy(ctx, window) {
      const key = ctx.secret.api_key ?? "";
      const out: Interval[] = [];
      // A job that began up to a week before the window may still be going.
      const min = new Date(window.start - 7 * 86_400_000).toISOString();
      const max = new Date(window.end).toISOString();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const q = new URLSearchParams({
          scheduled_start_min: min,
          scheduled_start_max: max,
          page_size: "100",
          page: String(page),
        });
        const { res, json } = await call(ctx, key, "GET", `/jobs?${q}`);
        if (res.status !== 200) throw new ConnectorError("bad_response", "Housecall Pro did not send the schedule.");
        const j = (json ?? {}) as {
          jobs?: {
            work_status?: unknown;
            canceled_at?: unknown;
            deleted_at?: unknown;
            schedule?: { scheduled_start?: unknown; scheduled_end?: unknown };
          }[];
          total_pages?: unknown;
        };
        for (const job of j.jobs ?? []) {
          if (
            job.canceled_at ||
            job.deleted_at ||
            job.work_status === "user canceled" ||
            job.work_status === "pro canceled"
          )
            continue;
          const start = utc(job.schedule?.scheduled_start);
          const end = utc(job.schedule?.scheduled_end);
          if (start === null || end === null || end <= start || end <= window.start || start >= window.end) continue;
          out.push({ start, end });
        }
        if (page >= Number(j.total_pages ?? 1)) return mergeIntervals(out, window);
      }
      return { intervals: mergeIntervals(out, window), until: window.start };
    },

    requests: {
      async put(ctx, r) {
        const found = await findLead(ctx, r);
        if (found) return found;
        const { first, last } = splitName(r.customer.name);
        const address = r.site
          ? {
              street: r.site.streetAddress ?? "",
              city: r.site.addressLocality ?? "",
              state: r.site.addressRegion ?? "",
              zip: r.site.postalCode ?? "",
            }
          : null;
        const { res, json } = await call(ctx, ctx.secret.api_key ?? "", "POST", "/leads", {
          customer: {
            ...(first ? { first_name: first } : {}),
            ...(last ? { last_name: last } : {}),
            ...(r.customer.email ? { email: r.customer.email } : {}),
            ...(r.customer.phone ? { mobile_number: r.customer.phone } : {}),
            notifications_enabled: false,
            ...(address ? { addresses: [address] } : {}),
          },
          ...(address ? { address } : {}),
          note: `${r.title}\n\n${r.description}`.slice(0, 8_000),
          tags: [leadTag(r)],
        });
        const lead = (json ?? {}) as { id?: unknown };
        if ((res.status === 200 || res.status === 201) && typeof lead.id === "string") return { externalId: lead.id };
        if (res.status === 400 || res.status === 422) {
          throw new ConnectorError("refused", "Housecall Pro would not take the lead.");
        }
        throw new ConnectorError("bad_response", `Housecall Pro answered ${res.status} to the lead.`);
      },
      find: findLead,
    },

    hooks: {
      topics: ["job.scheduled", "job.updated", "job.canceled", "job.deleted"],
      async verify(ctx, request): Promise<HookEvent | null> {
        const secret = ctx.secret.signing_secret;
        if (!secret) throw new ConnectorError("refused", "No signing secret: this connection takes no webhooks.");
        const ts = request.headers.get("api-timestamp") ?? "";
        const sig = (request.headers.get("api-signature") ?? "").trim();
        if (!/^\d{9,11}$/.test(ts) || !sig) throw new ConnectorError("refused", "An unsigned request.");
        if (Math.abs(Number(ts) - Math.floor(ctx.now / 1000)) > TOLERANCE_S)
          throw new ConnectorError("refused", "An old request.");
        const message = `${ts}.${request.body}`;
        const [hex, b64] = await Promise.all([hmacSha256Hex(secret, message), hmacSha256Base64(secret, message)]);
        const ok = constantTimeEqual(hex, sig.toLowerCase()) || constantTimeEqual(b64, sig);
        if (!ok) throw new ConnectorError("refused", "The signature does not check out.");
        let body: { event?: unknown; event_occurred_at?: unknown; job?: { id?: unknown } } = {};
        try {
          body = JSON.parse(request.body) as typeof body;
        } catch {
          throw new ConnectorError("refused", "Not a Housecall Pro webhook.");
        }
        const event = typeof body.event === "string" ? body.event.slice(0, 60) : "";
        if (!event) return null;
        const id = typeof body.job?.id === "string" ? body.job.id.slice(0, 100) : "";
        return { eventId: `${event}:${id}:${ts}`, topic: event, refs: id ? [id] : [] };
      },
      async read() {
        return [{ kind: "busy" }];
      },
    },
  };
}
