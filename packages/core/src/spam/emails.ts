import type { MailOut } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import { oneLine } from "../customer/format";
import type { Db } from "../db";
import {
  autoHeaders,
  type ComposedMail,
  mailByJob,
  mailDomain,
  senderOf,
  sendLogged,
  storeMail,
} from "../jobs/mail-log";
import { capOwnerAlerts, ownerAddressOf } from "../jobs/notify";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { localDay, startOfDay } from "../negotiation/withdrawal";
import { readSettings, type Settings } from "../settings/schema";
import { chipOf } from "./copy";
import { mask } from "./mask";

/**
 * The spam filter's two emails to the owner (ADR-029 §11.6), each only when there is something to say:
 * a short one in the morning naming what was held since the day before, and a summary on Mondays of
 * what was put aside, with the three that looked most like customers. Both go through the mail log like
 * every owner alert, count toward the alerts an hour, and fold into the hour's digest past it. Their
 * links open the owner app, where a person signs in as usual: nothing in an email changes anything.
 */

/** The morning email: what was held since the day before. */
export const SPAM_HELD_DIGEST_KIND = "spam_held_digest";
/** Mondays: what was put aside in the week. */
export const SPAM_WEEKLY_KIND = "spam_weekly";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The digest goes at nine in the morning, the summary at eight on Mondays, in the business's own time. */
const DIGEST_HOUR = 9;
const WEEKLY_HOUR = 8;
/** At most this many held requests are named in the digest; the rest wait under Held. */
const DIGEST_LINES = 10;

interface EmailPayload {
  /** When it was due: the digest names what was held in the day before it, the summary the week. */
  readonly at: number;
}

async function timezoneOf(db: Db, settings: Settings): Promise<string> {
  const { rows } = await db.client.query({ sql: "SELECT timezone FROM business LIMIT 1", params: [], method: "all" });
  const tz = rows[0]?.[0];
  return typeof tz === "string" && tz ? tz : settings.business.timezone || "UTC";
}

/** The next moment a business's wall clock shows `hour`:00 on a day `ok` accepts, after `now`. */
export function nextLocal(
  now: number,
  tz: string,
  hour: number,
  ok: (day: string) => boolean = () => true,
): {
  readonly day: string;
  readonly at: number;
} {
  const today = localDay(now, tz);
  for (let i = 0; i < 9; i++) {
    // Noon of each following day finds its date whatever the clocks did overnight.
    const day = i === 0 ? today : localDay(startOfDay(today, tz) + i * DAY + 12 * HOUR, tz);
    const at = startOfDay(day, tz) + hour * HOUR;
    if (at > now && ok(day)) return { day, at };
  }
  const day = localDay(now + DAY, tz);
  return { day, at: startOfDay(day, tz) + hour * HOUR };
}

const isMonday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 1;

/**
 * Makes sure the next digest and the next summary are due (the quarter-hour sweep calls it): one job
 * per day and per Monday, each at its hour in the business's time. Whether they go is decided as they
 * run, from the owner's settings then.
 */
export async function scheduleSpamEmails(db: Db, now: number): Promise<void> {
  const settings = await readSettings(db);
  const tz = await timezoneOf(db, settings);
  const digest = nextLocal(now, tz, DIGEST_HOUR);
  await ensureJob(db, SPAM_HELD_DIGEST_KIND, `${SPAM_HELD_DIGEST_KIND}:${digest.day}`, {
    now,
    runAt: digest.at,
    payload: { at: digest.at } satisfies EmailPayload,
  });
  const weekly = nextLocal(now, tz, WEEKLY_HOUR, isMonday);
  await ensureJob(db, SPAM_WEEKLY_KIND, `${SPAM_WEEKLY_KIND}:${weekly.day}`, {
    now,
    runAt: weekly.at,
    payload: { at: weekly.at } satisfies EmailPayload,
  });
}

/**
 * Who asked, as the owner knows them: the name they gave, else their email's domain. A name is the
 * sender's own words: masked as what the AI check reads is, so no address or link in it is live here.
 */
function whoOf(name: unknown, email: unknown): string {
  if (typeof name === "string" && name.trim()) return mask(oneLine(name.trim()));
  if (typeof email === "string" && email.includes("@")) return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return "Someone new";
}

/** "Fri 30 Oct, 15:00", in the business's time. */
export function heldWhenWords(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const part = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(d);
    }
  };
  return `${part({ weekday: "short", day: "numeric", month: "short" }).replace(/,/g, "")}, ${part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

/** What a held request was for, in a few words. */
export function heldWhat(type: string, startTime: string | null, tz: string): string {
  if (type === "booking") {
    const when = startTime ? heldWhenWords(startTime, tz) : "";
    return when ? `Booking request for ${when}` : "Booking request";
  }
  if (type === "order") return "Order";
  if (type === "quote_request") return "Quote request";
  return "Message";
}

/** The first line of what someone wrote, short enough for a line in an email. */
export function firstLine(text: string, max = 80): string {
  const line =
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .find((l) => l.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The digest's subject and body (ADR-029 §11.6), from its lines; null with nothing new held. */
export function heldDigestMail(
  lines: readonly { readonly who: string; readonly what: string; readonly chip: string }[],
  total: number,
  link: string,
): { readonly subject: string; readonly text: string } | null {
  if (total === 0) return null;
  const shown = lines.slice(0, DIGEST_LINES);
  return {
    subject: total === 1 ? "1 held for you to check" : `${total} held for you to check`,
    text: [
      "The spam filter held these since yesterday. Nothing is lost, and nobody was told. Let in anything that's yours:",
      "",
      ...shown.map((l) => `· ${[l.who, l.what, l.chip].filter(Boolean).join(" — ")}`),
      ...(total > shown.length ? [`· and ${total - shown.length} more`] : []),
      "",
      ...(link ? [`Open Held: ${link}`, ""] : []),
      "You get this when something new is held. Change it in Settings → Spam.",
    ].join("\n"),
  };
}

/** The Monday summary's subject and body (ADR-029 §11.6); null when nothing was put aside. */
export function weeklyMail(
  aside: number,
  held: number,
  closest: readonly { readonly who: string; readonly line: string }[],
  link: string,
): { readonly subject: string; readonly text: string } | null {
  if (aside === 0) return null;
  const were = aside === 1 ? "1 message was put aside this week" : `${aside} messages were put aside this week`;
  const heldNow = held > 0 ? `, and ${held} ${held === 1 ? "is" : "are"} held` : "";
  return {
    subject: `Spam this week: ${aside} put aside`,
    text: [
      `${were}${heldNow}.`,
      ...(closest.length
        ? [
            "",
            "These looked the most like customers; worth a glance:",
            ...closest.map((c) => `· ${c.who}${c.line ? ` — “${c.line}”` : ""}`),
          ]
        : []),
      "",
      ...(link ? [`See everything under Spam: ${link}`, ""] : []),
      "You get this on Mondays when something was put aside. Turn it off in Settings → Spam.",
    ].join("\n"),
  };
}

/** The held requests since the day before, newest last, with who, what and the chip. */
async function heldSince(
  db: Db,
  from: number,
  to: number,
  tz: string,
): Promise<{ total: number; lines: { who: string; what: string; chip: string }[] }> {
  const { rows } = await db.client.query({
    sql: `SELECT i.type, json_extract(i.payload, '$.startTime'), p.display_name, (SELECT c.value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1),
                 v.cause, v.learning
            FROM items i JOIN parties p ON p.id = i.party_id LEFT JOIN spam_verdicts v ON v.item_id = i.id
           WHERE i.screen = 'held' AND COALESCE(i.sandbox, 0) = 0 AND i.screen_at >= ? AND i.screen_at < ?
           ORDER BY i.screen_at, i.id`,
    params: [from, to],
    method: "all",
  });
  return {
    total: rows.length,
    lines: rows.map((r) => ({
      who: whoOf(r[2], r[3]),
      what: heldWhat(String(r[0]), r[1] === null || r[1] === undefined ? null : String(r[1]), tz),
      chip: chipOf(Number(r[5]) === 1 ? "learning" : r[4] === null || r[4] === undefined ? null : String(r[4])),
    })),
  };
}

/** What was put aside in the week, how many are held now, and the three nearest the line. */
async function weekOf(
  db: Db,
  from: number,
  to: number,
): Promise<{ aside: number; held: number; closest: { who: string; line: string }[] }> {
  const { rows: count } = await db.client.query({
    sql: `SELECT COUNT(*) FROM items WHERE screen = 'aside' AND COALESCE(sandbox, 0) = 0 AND screen_at >= ? AND screen_at < ?`,
    params: [from, to],
    method: "all",
  });
  const { rows: heldRows } = await db.client.query({
    sql: "SELECT COUNT(*) FROM items WHERE screen = 'held' AND COALESCE(sandbox, 0) = 0",
    params: [],
    method: "all",
  });
  // The least certain first, then the nearest the line: what a person would most want to look at again.
  const { rows: near } = await db.client.query({
    sql: `SELECT p.display_name, (SELECT c.value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1),
                 (SELECT t.body_text FROM thread_entries t WHERE t.item_id = i.id AND t.direction = 'in'
                   ORDER BY t.created_at, t.id LIMIT 1)
            FROM items i JOIN parties p ON p.id = i.party_id JOIN spam_verdicts v ON v.item_id = i.id
           WHERE i.screen = 'aside' AND COALESCE(i.sandbox, 0) = 0 AND i.screen_at >= ? AND i.screen_at < ?
             AND v.owner_verdict IS NULL
           ORDER BY v.certain ASC,
                    CASE json_extract(v.answer, '$.certainty') WHEN 'low' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
                    v.score ASC, i.id
           LIMIT 3`,
    params: [from, to],
    method: "all",
  });
  return {
    aside: Number(count[0]?.[0] ?? 0),
    held: Number(heldRows[0]?.[0] ?? 0),
    // What a put-aside message says, masked: a scam's link reaches the owner as "[link to example.com]",
    // never as a link to press in an email from their own inbox. The whole text is in the app.
    closest: near.map((r) => ({
      who: whoOf(r[0], r[1]),
      line: typeof r[2] === "string" ? firstLine(mask(r[2])) : "",
    })),
  };
}

function appLink(settings: Settings, baseUrl: string | undefined, filter: "held" | "spam"): string {
  const app = (settings.notifications.appUrl ?? baseUrl ?? "").replace(/\/+$/, "");
  return app ? `${app}/?f=${filter}` : "";
}

/** One owner email from the spam filter, through the mail log: stored once, sent once. */
function spamMailHandler(
  mailOut: MailOut,
  opts: { readonly baseUrl?: string | undefined },
  build: (
    db: Db,
    settings: Settings,
    at: number,
  ) => Promise<{ readonly template: string; readonly subject: string; readonly text: string } | string>,
): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as Partial<EmailPayload>;
    const at = typeof p.at === "number" ? p.at : now;
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    if (!logged) {
      const built = await build(db, settings, at);
      if (typeof built === "string") return { note: built };
      const composed: ComposedMail = await capOwnerAlerts(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: built.template,
          lang: "en",
          subject: oneLine(built.subject),
          text: built.text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        now,
      );
      logged = await storeMail(db, composed, mailDomain(sender?.from.address, publicUrl), now);
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };
    const address = await ownerAddressOf(db, settings);
    if (!address || !sender) {
      await db.client.query({
        sql: "UPDATE outbound_mail SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?",
        params: [address ? "no_sender" : "no_address", now, logged.id],
        method: "run",
      });
      return { note: `not sent: ${address ? "no sender" : "no address"}` };
    }
    const sent = await sendLogged(
      db,
      mailOut,
      logged,
      {
        ...sender,
        to: [address],
        subject: logged.subject,
        text: logged.bodyText,
        headers: autoHeaders({ automatic: true, template: logged.template }),
      },
      { final: job.attempts >= job.maxAttempts, now },
    );
    return { note: sent === null ? "not sent: held back" : "sent to the owner" };
  };
}

/** The morning digest of what was held since the day before (`spam_held_digest`). */
export function spamHeldDigestHandler(
  mailOut: MailOut,
  opts: { readonly baseUrl?: string | undefined } = {},
): JobHandler {
  return spamMailHandler(mailOut, opts, async (db, settings, at) => {
    if (!settings.spam.heldDigest) return "the owner switched the morning email off";
    const tz = await timezoneOf(db, settings);
    const held = await heldSince(db, at - DAY, at, tz);
    const mail = heldDigestMail(held.lines, held.total, appLink(settings, opts.baseUrl, "held"));
    if (!mail) return "nothing new was held";
    return { template: "owner.spam_held_digest", ...mail };
  });
}

/** Monday's summary of what was put aside in the week (`spam_weekly`). */
export function spamWeeklyHandler(mailOut: MailOut, opts: { readonly baseUrl?: string | undefined } = {}): JobHandler {
  return spamMailHandler(mailOut, opts, async (db, settings, at) => {
    if (!settings.spam.weeklySummary) return "the owner switched the summary off";
    const week = await weekOf(db, at - 7 * DAY, at);
    const mail = weeklyMail(week.aside, week.held, week.closest, appLink(settings, opts.baseUrl, "spam"));
    if (!mail) return "nothing was put aside this week";
    return { template: "owner.spam_weekly", ...mail };
  });
}
