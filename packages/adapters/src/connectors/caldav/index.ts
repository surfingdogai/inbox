import {
  type CalendarChoice,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorHttp,
  field,
  type Interval,
  mergeIntervals,
  type RunContext,
  secretField,
  subtractIntervals,
} from "@surfingdog/core";
import { z } from "zod";
import { lookupMx } from "../dns";
import { CalDavClient } from "./client";
import { buildEvent } from "./ical";

/**
 * Any calendar that speaks CalDAV (ADR-022): iCloud, Fastmail, Nextcloud, and the rest. The owner
 * gives an email and an app password; the server is found from a preset, from the email's domain,
 * or, only when neither works, from an address under More options. A Google or Microsoft mailbox is
 * told at once where it connects instead: no app password opens their calendars over CalDAV.
 */

export const caldavForm = z.object({
  username: field(z.string().trim().min(1).max(320), {
    label: "Email",
    input: "email",
    // An address, never a "username": a browser that sees a username beside a password takes the
    // form for a sign-up and fills in a password of its own.
    autocomplete: "email",
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
        help: "Not your Apple Account password. Apple shows it once: copy it.",
        link: {
          href: "https://account.apple.com/account/manage/section/security",
          text: "Make one: Sign-In and Security → App-Specific Passwords",
        },
      },
    },
  },
  {
    id: "fastmail",
    label: "Fastmail",
    values: { server: "https://caldav.fastmail.com" },
    fields: {
      username: { label: "Fastmail email", placeholder: "you@fastmail.com" },
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
      username: { label: "Username", input: "text" as const, placeholder: undefined, autocomplete: "off" },
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

/**
 * The UID of the event this inbox writes for a booking: its own, and recognisable as such by the
 * inbox's own id, never its host (which moves to the business's own domain, and is the same
 * placeholder for every inbox that has none).
 */
export function ownUid(itemId: string, instanceId: string): string {
  return `sdi-${itemId}@${instanceId}.inbox`;
}

export function isOwnUid(uid: string, instanceId: string): boolean {
  return uid.startsWith("sdi-") && uid.endsWith(`@${instanceId}.inbox`);
}

function client(
  ctx: { readonly http: RunContext["http"]; readonly extra: RunContext["extra"] },
  secret: Readonly<Record<string, string>>,
): CalDavClient {
  const username = secret.username ?? "";
  const password = secret.password ?? "";
  if (!username || !password)
    throw new ConnectorError("auth", "The saved email or app password is missing. Connect it again.");
  return new CalDavClient(ctx.http, { username, password }, { authHost: signedInAt(ctx.extra) });
}

/** The host that asked for the password when it was connected: the only one it goes to. */
function signedInAt(extra: RunContext["extra"]): string | null {
  if (typeof extra.authHost === "string" && extra.authHost) return extra.authHost;
  try {
    return new URL(String(extra.principal ?? "")).hostname || null;
  } catch {
    return null;
  }
}

function defaultDestination(calendars: readonly CalendarChoice[]): string | null {
  const writable = calendars.filter((c) => c.writable && !/remind|task|to-?do/i.test(c.name));
  return (writable[0] ?? calendars.find((c) => c.writable))?.id ?? null;
}

function strip(calendars: readonly (CalendarChoice & { components?: readonly string[] })[]): CalendarChoice[] {
  return calendars.map(({ id, name, writable }) => ({ id, name, writable }));
}

const GOOGLE_MAIL = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_MAIL = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

/**
 * A mailbox at Google or Microsoft, from the email's domain or, for a domain of the business's own,
 * the mail servers it names: their calendars do not open with an app password over CalDAV.
 */
async function mailboxAt(http: ConnectorHttp, email: string): Promise<"google" | "microsoft" | null> {
  const domain = email
    .slice(email.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
  if (!domain || !email.includes("@")) return null;
  if (GOOGLE_MAIL.has(domain)) return "google";
  if (MICROSOFT_MAIL.test(domain)) return "microsoft";
  const mx = await lookupMx(http, domain);
  if (mx.some((h) => h === "google.com" || h.endsWith(".google.com") || h.endsWith(".googlemail.com"))) {
    return "google";
  }
  if (mx.some((h) => h.endsWith(".protection.outlook.com") || h.endsWith(".outlook.com"))) return "microsoft";
  return null;
}

export interface CalDavOptions {
  /** Whether this inbox connects Google Calendar now, so a Gmail owner is sent the right way. */
  readonly googleReady?: boolean | undefined;
}

export function caldavConnector(opts: CalDavOptions = {}): ConnectorDefinition {
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
      if (!server) {
        const at = await mailboxAt(ctx.http, username);
        if (at === "google") {
          throw new ConnectorError(
            "config",
            opts.googleReady
              ? "Google calendars connect with Google: choose Google above."
              : "Google calendars connect with Google, coming soon here. Until then, use Calendar link.",
            { field: "username" },
          );
        }
        if (at === "microsoft") {
          throw new ConnectorError(
            "config",
            "Outlook calendars connect by the link Outlook publishes: choose Outlook above.",
            {
              field: "username",
            },
          );
        }
      }
      const dav = new CalDavClient(ctx.http, { username, password });
      const found = await dav.discover(server);
      const calendars = strip(found.calendars);
      return {
        account: username,
        externalId: found.principal,
        secret: { username, password },
        extra: { principal: found.principal, home: found.home, authHost: dav.signedInAt },
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
            skipUid: (uid) => isOwnUid(uid, ctx.inbox.id),
            skipHref: (href) => ctx.own.ids.has(href),
          })),
        );
      }
      // The inbox's own bookings that another connection wrote here (Cal.com writing into this
      // calendar) carry no UID of ours: they are taken out by their times.
      return mergeIntervals(subtractIntervals(out, ctx.own.spans), window);
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
          uid: ownUid(booking.itemId, ctx.inbox.id),
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
