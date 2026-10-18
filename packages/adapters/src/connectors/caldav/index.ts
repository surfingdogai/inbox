import {
  type CalendarChoice,
  type ConnectorDefinition,
  ConnectorError,
  field,
  type Interval,
  mergeIntervals,
  type RunContext,
  secretField,
} from "@surfingdog/core";
import { z } from "zod";
import { CalDavClient } from "./client";
import { buildEvent } from "./ical";

/**
 * Any calendar that speaks CalDAV (ADR-020): iCloud, Fastmail, Nextcloud, and the rest. The owner
 * gives an email and an app password; the server is found from a preset, from the email's domain,
 * or, only when neither works, from an address under More options.
 */

export const caldavForm = z.object({
  username: field(z.string().trim().min(1).max(320), {
    label: "Email",
    input: "email",
    autocomplete: "username",
    placeholder: "you@example.com",
  }),
  password: secretField(z.string().min(1).max(512), {
    label: "App password",
    help: "One made for this inbox in your calendar's settings, not your usual password.",
  }),
  server: field(z.string().trim().max(2048).optional(), {
    label: "Server address",
    input: "url",
    placeholder: "https://calendar.example.com",
    help: "Only if your calendar is not found from your email.",
    advanced: true,
  }),
});

export const CALDAV_PRESETS = [
  {
    id: "icloud",
    label: "iCloud",
    values: { server: "https://caldav.icloud.com" },
    fields: {
      username: { label: "Apple Account email", placeholder: "you@icloud.com" },
      password: {
        label: "App-specific password",
        help: "Not your Apple Account password: make one for this inbox, under Sign-In and Security.",
        link: { href: "https://account.apple.com/account/manage", text: "Make one at account.apple.com" },
      },
    },
  },
  {
    id: "fastmail",
    label: "Fastmail",
    values: { server: "https://caldav.fastmail.com" },
    fields: {
      username: { label: "Fastmail email" },
      password: {
        label: "App password",
        help: "Make one with access to calendars, in Settings → Privacy & Security.",
        link: { href: "https://www.fastmail.help/hc/en-us/articles/360058752854", text: "How to make one" },
      },
    },
  },
  {
    id: "nextcloud",
    label: "Nextcloud",
    values: {},
    fields: {
      server: {
        label: "Nextcloud address",
        placeholder: "https://cloud.example.com",
        help: undefined,
        advanced: false,
        required: true,
      },
      username: { label: "Username", input: "text" as const, placeholder: undefined },
      password: { label: "App password", help: "Make one in Settings → Security → Devices & sessions." },
    },
  },
  {
    id: "other",
    label: "Other",
    values: {},
    note: "Any calendar that speaks CalDAV.",
  },
] as const;

/** The UID of the event this inbox writes for a booking: its own, and recognisable as such. */
export function ownUid(itemId: string, host: string): string {
  return `sdi-${itemId}@${host}`;
}

export function isOwnUid(uid: string, host: string): boolean {
  return uid.startsWith("sdi-") && uid.endsWith(`@${host}`);
}

function client(ctx: { readonly http: RunContext["http"] }, secret: Readonly<Record<string, string>>): CalDavClient {
  const username = secret.username ?? "";
  const password = secret.password ?? "";
  if (!username || !password)
    throw new ConnectorError("auth", "The saved email or app password is missing. Connect it again.");
  return new CalDavClient(ctx.http, { username, password });
}

function defaultDestination(calendars: readonly CalendarChoice[]): string | null {
  const writable = calendars.filter((c) => c.writable && !/remind|task|to-?do/i.test(c.name));
  return (writable[0] ?? calendars.find((c) => c.writable))?.id ?? null;
}

function strip(calendars: readonly (CalendarChoice & { components?: readonly string[] })[]): CalendarChoice[] {
  return calendars.map(({ id, name, writable }) => ({ id, name, writable }));
}

export function caldavConnector(): ConnectorDefinition {
  return {
    kind: "caldav",
    title: "Calendar",
    group: "calendars",
    capabilities: ["busy_times", "write_bookings"],
    auth: "form",
    form: caldavForm,
    presets: CALDAV_PRESETS,

    async connect(ctx, input) {
      const username = (input.username ?? "").trim();
      const password = input.password ?? "";
      const server = input.server?.trim() || undefined;
      const found = await new CalDavClient(ctx.http, { username, password }).discover(server);
      const calendars = strip(found.calendars);
      return {
        account: username,
        externalId: found.principal,
        secret: { username, password },
        extra: { principal: found.principal, home: found.home },
        calendars,
        destinations: calendars.filter((c) => c.writable),
        defaults: { busy: calendars.map((c) => c.id), destination: defaultDestination(calendars) },
      };
    },

    async refresh(ctx) {
      const home = String(ctx.extra.home ?? "");
      if (!home) throw new ConnectorError("config", "This calendar's address is missing. Connect it again.");
      const calendars = strip(await client(ctx, ctx.secret).calendars(home));
      return { account: ctx.secret.username ?? "", calendars, destinations: calendars.filter((c) => c.writable) };
    },

    async busy(ctx, window) {
      const dav = client(ctx, ctx.secret);
      const known = new Set(ctx.calendars.map((c) => c.id));
      const out: Interval[] = [];
      for (const id of ctx.busyCalendars) {
        if (!known.has(id)) continue;
        out.push(
          ...(await dav.busy(id, window, {
            timezone: ctx.inbox.timezone,
            skipUid: (uid) => isOwnUid(uid, ctx.inbox.host),
            skipHref: (href) => ctx.own.ids.has(href),
          })),
        );
      }
      return mergeIntervals(out, window);
    },

    bookings: {
      async put(ctx, booking, link) {
        const target = ctx.destination ?? defaultDestination(ctx.destinations);
        if (!target || !ctx.destinations.some((d) => d.id === target && d.writable)) {
          throw new ConnectorError("not_found", "Choose a calendar for bookings in Settings → Integrations.");
        }
        const dav = client(ctx, ctx.secret);
        const href = `${target.endsWith("/") ? target : `${target}/`}sdi-${booking.itemId}.ics`;
        let etag = link?.etag ?? null;
        // Moved to another calendar: out of the old one first, then into the new.
        if (link?.externalId && link.externalId !== href) {
          await dav.remove(link.externalId);
          etag = null;
        }
        const ics = buildEvent({
          uid: ownUid(booking.itemId, ctx.inbox.host),
          start: booking.start,
          end: booking.end,
          title: booking.title,
          description: booking.description,
          url: booking.url,
          itemId: booking.itemId,
          now: ctx.now,
        });
        const written = await dav.put(href, ics, link?.externalId === href ? etag : null);
        return { externalId: href, etag: written, calendar: target };
      },
      async remove(ctx, link) {
        if (!link.externalId) return;
        await client(ctx, ctx.secret).remove(link.externalId);
      },
    },
  };
}
