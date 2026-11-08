import type { MailOut } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import { oneLine } from "../customer/format";
import type { Db } from "../db";
import { readSettings } from "../settings/schema";
import { SHARED_MAIL_PROVIDERS } from "../spam/data";
import { emailDomain, registrableDomain } from "../spam/normalise";
import { noticeListedSql } from "../write/flags";
import { autoHeaders, mailByJob, mailDomain, senderOf, sendLogged, storeMail } from "./mail-log";
import { ownerAddressOf } from "./notify";
import type { JobHandler } from "./runner";
import { ensureJob } from "./schedule";

/**
 * Notices (ADR-026 §6) alert nobody, one by one. A day that brings a flood of them — one system sending by
 * the hundred, or someone filling the inbox — is told to the owner once, the day it starts: who sent how
 * many, all of it kept under Notices, and that one press deletes all of one sender's.
 */
export const NOTICES_DAY_KIND = "notices_day";

const DAY = 86_400_000;

/**
 * Who sent a notice, as its sender is counted and deleted together: the domain its address's domain
 * belongs to (`mail.bank.example` is `bank.example`), or the address itself on a domain many people
 * share (gmail.com). Null with no address.
 */
export function noticeSender(
  email: string | null | undefined,
): { readonly domain?: string; readonly address?: string } | null {
  const address = email?.trim().toLowerCase();
  const domain = emailDomain(address);
  if (!address || !domain) return null;
  const registered = registrableDomain(domain);
  return SHARED_MAIL_PROVIDERS.has(domain) || SHARED_MAIL_PROVIDERS.has(registered)
    ? { address }
    : { domain: registered };
}

/** The SQL that holds of a party's address from that sender, and its parameters. */
export function fromSenderSql(
  sender: NonNullable<ReturnType<typeof noticeSender>>,
  column: string,
): {
  sql: string;
  params: string[];
} {
  if (sender.address) return { sql: `lower(${column}) = ?`, params: [sender.address] };
  const domain = (sender.domain ?? "").replace(/[\\%_]/g, "\\$&");
  return {
    sql: `(lower(${column}) LIKE '%@' || ? ESCAPE '\\' OR lower(${column}) LIKE '%.' || ? ESCAPE '\\')`,
    params: [domain, domain],
  };
}

/** The day's email to the owner about its notices, queued once a day (UTC), at the first flood. */
export async function queueNoticesDay(db: Db, now: number): Promise<void> {
  const day = Math.floor(now / DAY);
  await ensureJob(db, NOTICES_DAY_KIND, `${NOTICES_DAY_KIND}:${day}`, {
    now,
    runAt: now,
    payload: { from: day * DAY },
  });
}

/**
 * The email: how many notices came today from each sender that sent the most, all kept, and how to
 * clear one sender's at once. Through the mail log like every other email, so a retry sends it once.
 */
export function noticesDayHandler(mailOut: MailOut, opts: { baseUrl?: string | undefined } = {}): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as { from: number };
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    if (!logged) {
      // Those Notices lists, as it lists them: never one put aside, by a mail server or the owner, which
      // is under Spam alone.
      const { rows } = await db.client.query({
        sql: `SELECT lower(json_extract(p.contact, '$.email')) FROM items i JOIN parties p ON p.id = i.party_id
               WHERE ${noticeListedSql("i.flags")} AND i.state <> 'spam'
                 AND COALESCE(i.screen, '') NOT IN ('pending', 'held', 'aside') AND i.created_at >= ?`,
        params: [p.from],
        method: "all",
      });
      const counts = new Map<string, number>();
      for (const [email] of rows) {
        const who = noticeSender(typeof email === "string" ? email : null);
        const name = who?.domain ?? who?.address ?? "no sender";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if (rows.length === 0) return { note: "no notices today" };
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const appUrl = settings.notifications.appUrl ?? "";
      const text = [
        `${rows.length} notices came today: emails from systems, which nobody answers. Most were from:`,
        "",
        ...top.map(([name, n]) => `- ${oneLine(name)}: ${n}`),
        "",
        "Every one is kept under Notices. To delete all of one sender's at once, open one of them and choose Delete all from this sender.",
        ...(appUrl ? ["", `Open: ${appUrl}`] : []),
      ].join("\n");
      logged = await storeMail(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: "owner.notices",
          lang: "en",
          subject: oneLine(`${rows.length} notices today, most from ${top[0]?.[0] ?? "one sender"}`),
          text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
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
    return { note: sent === null ? "not sent: held back" : "the day's notices told to the owner" };
  };
}
