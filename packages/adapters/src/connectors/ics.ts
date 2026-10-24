import {
  type ConnectContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttpResponse,
  mergeIntervals,
  secretField,
  subtractIntervals,
} from "@surfingdog/core";
import { z } from "zod";
import { busyFromICal, parseICal } from "./caldav/ical";
import { isOwnUid } from "./caldav/index";

/**
 * A calendar by its private link (ADR-022): the address a calendar gives for subscribing to it, which
 * ends in `.ics` (Google's secret address in iCal format, Outlook's published calendar, any app's
 * subscription link). Busy times only: nothing is written there. It is how a calendar that cannot
 * connect here yet (Google before this inbox has a Google client, Outlook) still takes the owner's
 * busy times off what is offered. The link is the secret: anyone holding it reads the calendar, so it
 * is sealed like a password and never shown again.
 */

export const icsForm = z.object({
  url: secretField(z.string().trim().min(8).max(2048), {
    label: "Calendar link",
    input: "url",
    help: "The private link your calendar gives for subscribing; it ends in .ics.",
    placeholder: "https://…/basic.ics",
  }),
});

/** Calendars hold years of events; an answer up to this size is read. */
const MAX_BYTES = 10 * 1024 * 1024;

/** The link as fetched: `webcal://` is https, and nothing else but https is followed. */
function normalise(raw: string): string {
  const trimmed = raw.trim();
  const url = /^webcals?:\/\//i.test(trimmed) ? trimmed.replace(/^webcals?:\/\//i, "https://") : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectorError("config", "That is not a link. Copy the private link that ends in .ics.", {
      field: "url",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new ConnectorError("config", "A calendar link starts with https:// or webcal://.", { field: "url" });
  }
  parsed.hash = "";
  return parsed.toString();
}

async function fetchCalendar(ctx: Pick<ConnectContext, "http">, url: string): Promise<string> {
  let res: ConnectorHttpResponse;
  try {
    res = await ctx.http.request({
      method: "GET",
      url,
      headers: { accept: "text/calendar, text/plain;q=0.5" },
      followRedirects: true,
      maxBytes: MAX_BYTES,
      timeoutMs: 20_000,
    });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "config") {
      throw new ConnectorError(error.code, error.message, { field: "url" });
    }
    throw error;
  }
  const host = new URL(res.url).hostname;
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
    throw new ConnectorError(
      "auth",
      "That calendar link does not open. Copy the private link again from your calendar and press Connect again.",
      { field: "url" },
    );
  }
  if (res.status === 429) throw new ConnectorError("rate_limited", `${host} asked this inbox to wait.`);
  if (res.status >= 500) {
    throw new ConnectorError(
      "unreachable",
      `${host} is not answering properly; this inbox tries again in a few minutes.`,
    );
  }
  if (res.status !== 200 || !/BEGIN:VCALENDAR/i.test(res.text)) {
    throw new ConnectorError("config", "That link does not give a calendar. Copy the private link that ends in .ics.", {
      field: "url",
    });
  }
  return res.text;
}

/** The calendar's own name, when it gives one (`X-WR-CALNAME`), else the host it is at. */
function nameOf(text: string, url: string): string {
  const cal = parseICal(text).find((c) => c.name === "VCALENDAR");
  const name = cal?.props.find((p) => p.name === "X-WR-CALNAME")?.value.trim();
  return (name || new URL(url).hostname).slice(0, 120);
}

async function idOf(url: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Outlook, as the calendar card names it (ADR-026 §6): the link Outlook publishes for a calendar, with
 * Outlook's own steps. Busy times only, which is what Outlook offers without a Microsoft app of ours.
 */
export const ICS_PRESETS: NonNullable<ConnectorDefinition["presets"]> = [
  {
    id: "outlook",
    label: "Outlook",
    values: {},
    fields: {
      url: {
        label: "Outlook calendar link",
        help: "The ICS link Outlook gives when you publish your calendar.",
        steps: [
          "In Outlook on the web: Settings → Calendar → Shared calendars.",
          "Under Publish a calendar, choose your calendar and Can view when I'm busy.",
          "Press Publish, then copy the ICS link.",
        ],
      },
    },
    note: "Busy times only: bookings are not added to Outlook.",
  },
];

export function icsConnector(): ConnectorDefinition {
  return {
    kind: "ics",
    title: "Calendar link",
    group: "calendars",
    // A stylist's own calendar link: busy times only (ADR-035): tied to them, it takes only their times off and holds only their bookings.
    perResource: true,
    capabilities: ["busy_times"],
    auth: "form",
    form: icsForm,
    note: "Busy times only: bookings are not added here.",
    presets: ICS_PRESETS,

    async connect(ctx, input) {
      const url = normalise(input.url ?? "");
      const text = await fetchCalendar(ctx, url);
      return {
        account: nameOf(text, url),
        // The link's hash: the link itself is the secret, and is sealed.
        externalId: await idOf(url),
        secret: { url },
        calendars: [],
        destinations: [],
        defaults: { busy: [], destination: null },
      };
    },

    async busy(ctx, window) {
      const url = ctx.secret.url ?? "";
      if (!url) throw new ConnectorError("auth", "The saved calendar link is missing. Connect it again.");
      const text = await fetchCalendar(ctx, url);
      const busy = busyFromICal(text, window, {
        timezone: ctx.inbox.timezone,
        skipUid: (uid) => isOwnUid(uid, ctx.inbox.id),
      });
      // The inbox's own bookings that a connection wrote into this calendar, by their times.
      return mergeIntervals(subtractIntervals(busy, ctx.own.spans), window);
    },
  };
}
