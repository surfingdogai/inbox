import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  type Interval,
  mergeIntervals,
  type OutboundRequest,
  type RequestRef,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { retryAfterMs } from "../http";
import { fileName, jsonOf, multipart, tagFrom } from "./common";

/**
 * Fergus (ADR-034 §5), with a Personal Access Token the business makes in Fergus ("Access to the APIs
 * is provided via a Personal Access Token (PAT) or via OAuth"; Fergus API Terms, api.fergus.com/docs).
 * A request the owner takes on becomes an enquiry (`POST /enquiries`, source "Online request"), with the
 * customer's photos and plans attached to it (`POST /attachments`, entity `enquiry`); calendar events
 * are the busy times visits are offered around. Fergus has no webhooks in its reference: the schedule
 * is read on every sync.
 *
 * Fergus chooses its ids, so an enquiry carries a short reference of the inbox's own in its words, by
 * which one whose answer never came is found again (`filterSearchText`) before it is written again. A
 * token lasts 365 days ("Fergus API Personal Access Tokens"): when it was connected is kept, so the
 * owner is told before it runs out. Limits: 100 requests a minute per company, `retry-after` on a 429.
 *
 * Source, read 21 Oct 2026: the OpenAPI document served at https://api.fergus.com/docs/json (Fergus
 * API 3.1.0), and https://help.fergus.com/en/articles/14605426-fergus-api-personal-access-tokens-pats.
 */

export const FERGUS_API = "https://api.fergus.com";
/** What an enquiry's source says in Fergus. */
export const FERGUS_SOURCE = "Online request";
/** A Personal Access Token's life. */
export const FERGUS_TOKEN_DAYS = 365;
/** Months of calendar one read takes. */
const MAX_MONTHS = 4;

export const fergusForm = z.object({
  token: secretField(z.string().trim().min(10).max(500), {
    label: "Personal access token",
    help: "In Fergus, as an admin: Settings → API → Personal access tokens → New. It is shown once, and lasts a year.",
    link: {
      href: "https://help.fergus.com/en/articles/14605426-fergus-api-personal-access-tokens-pats",
      text: "How to make a token",
    },
  }),
});

async function call(
  ctx: Pick<ConnectContext, "http">,
  token: string,
  method: string,
  path: string,
  opts: { json?: unknown; bytes?: Uint8Array; contentType?: string } = {},
): Promise<{ res: ConnectorHttpResponse; json: unknown }> {
  const res = await ctx.http.request({
    method,
    url: `${FERGUS_API}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.contentType ? { "content-type": opts.contentType } : {}),
    },
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    ...(opts.bytes ? { bytes: opts.bytes, timeoutMs: 60_000 } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(
      "auth",
      "Fergus did not take that token: it may have run out. Make a new one and connect again.",
      {
        field: "token",
      },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "Fergus asked this inbox to slow down.", {
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      "Fergus is not answering properly; this inbox tries again in a few minutes.",
    );
  }
  return { res, json: jsonOf(res) };
}

const dataOf = (json: unknown) => (json && typeof json === "object" ? (json as { data?: unknown }).data : undefined);

/** The words an enquiry carries for the inbox to find it again by: the request's reference and the inbox's mark. */
async function refOf(ctx: RunContext, r: OutboundRequest): Promise<string> {
  return `Ref ${r.reference}-${await tagFrom(ctx.marker, r.key)}`;
}

async function findEnquiry(ctx: RunContext, r: OutboundRequest): Promise<RequestRef | null> {
  const ref = await refOf(ctx, r);
  const q = new URLSearchParams({
    filterSearchText: ref,
    filterSource: FERGUS_SOURCE,
    pageSize: "10",
    sortOrder: "desc",
  });
  const { res, json } = await call(ctx, ctx.secret.token ?? "", "GET", `/enquiries?${q}`);
  if (res.status !== 200) throw new ConnectorError("bad_response", "Fergus did not list its enquiries.");
  const list = dataOf(json);
  for (const e of Array.isArray(list) ? list : []) {
    const enquiry = e as { id?: unknown; description?: unknown };
    if (
      typeof enquiry.id === "number" &&
      typeof enquiry.description === "string" &&
      enquiry.description.includes(ref)
    ) {
      return { externalId: String(enquiry.id) };
    }
  }
  return null;
}

async function attach(ctx: RunContext, enquiryId: string, r: OutboundRequest): Promise<void> {
  if (r.files.length === 0) return;
  const token = ctx.secret.token ?? "";
  const q = new URLSearchParams({ entityType: "enquiry", entityId: enquiryId, pageSize: "100" });
  const { res, json } = await call(ctx, token, "GET", `/attachments?${q}`);
  const have = new Set<string>();
  if (res.status === 200) {
    const list = dataOf(json);
    for (const a of Array.isArray(list) ? list : []) {
      const n = (a as { fileName?: unknown }).fileName;
      if (typeof n === "string") have.add(n);
    }
  }
  for (const [i, f] of r.files.entries()) {
    // Phones and agents send several photos all called "image.jpg": each goes under a name of its own
    // on the request, by its place, so none is taken for one already there.
    const name = `${i + 1}-${fileName(f.name, f.contentType)}`;
    if (have.has(name)) continue;
    const form = multipart([
      { name: "entityType", value: "enquiry" },
      { name: "entityId", value: enquiryId },
      { name: "file", value: { filename: name, contentType: f.contentType, bytes: await f.read() } },
    ]);
    const up = await call(ctx, token, "POST", "/attachments", { bytes: form.body, contentType: form.contentType });
    if (up.res.status !== 201 && up.res.status !== 200) {
      throw new ConnectorError("bad_response", `Fergus did not take the file ${f.name} (${up.res.status}).`);
    }
  }
}

/** The first day of each month the window touches, as Fergus's calendar ranges are read. */
function months(window: Interval): string[] {
  const out: string[] = [];
  const d = new Date(window.start);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (let i = 0; i < MAX_MONTHS; i++) {
    const first = Date.UTC(y, m, 1);
    if (first >= window.end) break;
    out.push(`${new Date(first).toISOString().slice(0, 10)}T00:00:00+00:00`);
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * `cleared`: whoever runs the server confirmed with Fergus that a business's own token may be used by a
 * tool it chooses, as Fergus's API terms speak of an approved use case (`JOB_TOOLS_CLEARED=fergus`).
 * Until then the card says "set up".
 */
export function fergusConnector(opts: { readonly cleared?: boolean | undefined } = {}): ConnectorDefinition {
  const waiting = "Needs setup: waiting on Fergus's API terms.";
  return {
    kind: "fergus",
    title: "Fergus",
    group: "work",
    capabilities: ["requests_out", "busy_times"],
    auth: "form",
    ready: () => (opts.cleared ? true : waiting),
    whenNotReady: { status: "setup", hint: waiting, href: "https://surfingdog.ai/docs/job-tools/#which-tools" },
    form: fergusForm,
    note: "Requests you take on arrive as enquiries with their photos; your Fergus calendar blocks those times.",
    action: "Connect Fergus",
    disconnectNote: "Revoke the token in Fergus: Settings → API → Personal access tokens.",

    async connect(ctx, input) {
      const token = (input.token ?? "").trim();
      if (!token) throw new ConnectorError("config", "Paste the token.", { field: "token" });
      const { res, json } = await call(ctx, token, "GET", "/company");
      const c = (dataOf(json) ?? {}) as { guid?: unknown; name?: unknown };
      if (res.status !== 200 || typeof c.guid !== "string") {
        throw new ConnectorError("bad_response", "Fergus did not say which company this is.");
      }
      return {
        account: typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Fergus",
        externalId: c.guid,
        secret: { token },
        // When this token runs out, so the owner is told before it does.
        extra: { tokenExpiresAt: ctx.now + FERGUS_TOKEN_DAYS * 86_400_000 },
        calendars: [{ id: "calendar", name: "Fergus calendar", writable: false, primary: true }],
        destinations: [],
        defaults: { busy: ["calendar"], destination: null },
      };
    },

    async busy(ctx, window) {
      const token = ctx.secret.token ?? "";
      const out: Interval[] = [];
      const read = months(window);
      for (const from of read) {
        const q = new URLSearchParams({ filterDateFrom: from, filterCalendarRange: "MONTH", filterActiveOnly: "true" });
        const { res, json } = await call(ctx, token, "GET", `/calendarEvents?${q}`);
        if (res.status !== 200) throw new ConnectorError("bad_response", "Fergus did not send the calendar.");
        const list = dataOf(json);
        for (const e of Array.isArray(list) ? list : []) {
          const ev = e as { startTime?: unknown; endTime?: unknown; isActive?: unknown };
          if (ev.isActive === false) continue;
          const start = typeof ev.startTime === "string" ? Date.parse(ev.startTime) : Number.NaN;
          const end = typeof ev.endTime === "string" ? Date.parse(ev.endTime) : Number.NaN;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
          if (end <= window.start || start >= window.end) continue;
          out.push({ start, end });
        }
      }
      const last = read.at(-1);
      // Read as far as the months read go: past them nothing is offered.
      if (last) {
        const d = new Date(Date.parse(last));
        const until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        if (until < window.end) return { intervals: mergeIntervals(out, window), until };
      }
      return mergeIntervals(out, window);
    },

    requests: {
      async put(ctx, r) {
        const found = await findEnquiry(ctx, r);
        if (found) {
          await attach(ctx, found.externalId, r);
          return found;
        }
        const ref = await refOf(ctx, r);
        const s = r.site;
        const { res, json } = await call(ctx, ctx.secret.token ?? "", "POST", "/enquiries", {
          json: {
            name: (r.customer.name ?? r.title).slice(0, 200),
            ...(r.customer.email ? { email: r.customer.email } : {}),
            ...(r.customer.phone ? { phoneNumber: r.customer.phone } : {}),
            // The reference first: a long description is cut at its end, never the reference the
            // enquiry is found again by.
            description: `${ref}\n\n${r.title}\n\n${r.description}`.slice(0, 8_000),
            source: FERGUS_SOURCE,
            ...(s?.streetAddress ? { address1: s.streetAddress } : {}),
            ...(s?.addressLocality ? { addressCity: s.addressLocality } : {}),
            ...(s?.addressRegion ? { addressRegion: s.addressRegion } : {}),
            ...(s?.postalCode ? { addressPostcode: s.postalCode } : {}),
            ...(s?.addressCountry ? { addressCountry: s.addressCountry } : {}),
          },
        });
        const id = (dataOf(json) as { id?: unknown } | undefined)?.id;
        if (res.status === 201 && typeof id === "number") {
          await attach(ctx, String(id), r);
          return { externalId: String(id) };
        }
        if (res.status >= 400 && res.status < 500)
          throw new ConnectorError("refused", "Fergus would not take the enquiry.");
        throw new ConnectorError("bad_response", `Fergus answered ${res.status} to the enquiry.`);
      },
      find: findEnquiry,
    },
  };
}
