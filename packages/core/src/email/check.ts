import type { MailOut } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import type { Db } from "../db";
import { autoHeaders, mailByJob, mailDomain, senderOf, sendLogged, storeMail } from "../jobs/mail-log";
import type { JobHandler } from "../jobs/runner";
import { ensureJob } from "../jobs/schedule";
import { readSettings } from "../settings/schema";
import { CHECK_HEADER, LOOP_HEADER, loopMark } from "./channel";
import { CHECK_WAIT_MS, checkLapsed, startCheck } from "./forwards";

/**
 * The live "forwarding works" check (ADR-026 §2): the inbox emails the business's own address and
 * watches for the email to come back through the forward. The first goes to the address's plus form,
 * which proves plus addresses arrive too; if it is not back in three minutes, one goes to the address
 * itself; if that is not back in three more, the forward is "not yet". The email goes to the
 * business, never to a customer, and says what it is.
 */
export const EMAIL_CHECK_KIND = "email_check";

export interface EmailCheckPayload {
  readonly forwardId: string;
  readonly step: "send" | "follow";
  readonly plain?: boolean | undefined;
}

/** Queues a check now (the owner pressed "Check forwarding", or added the address). */
export async function queueForwardCheck(db: Db, forwardId: string, now: number): Promise<void> {
  // One check at a time per address and per minute: a second press within it is the same check.
  await ensureJob(db, EMAIL_CHECK_KIND, `${EMAIL_CHECK_KIND}:send:${forwardId}:${Math.floor(now / 60_000)}`, {
    now,
    payload: { forwardId, step: "send" } satisfies EmailCheckPayload,
  });
}

/** The words of a check email, for the business's own mailbox. */
export function checkMailText(o: { address: string; token: string }): { subject: string; text: string } {
  return {
    subject: `Forwarding check ${o.token}`,
    text: [
      `This is a check from your inbox, sent to ${o.address}.`,
      "",
      "If forwarding works, it comes straight back and your inbox shows that forwarding works. If you can read this in your mailbox, your mail provider kept a copy, which is fine.",
      "",
      "You can delete this email.",
    ].join("\n"),
  };
}

export function emailCheckHandler(mailOut: MailOut, opts: { baseUrl?: string | undefined } = {}): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as EmailCheckPayload;
    if (p.step === "follow") {
      const next = await checkLapsed(db, { forwardId: p.forwardId, now });
      if (next === "plain") {
        await ensureJob(db, EMAIL_CHECK_KIND, `${EMAIL_CHECK_KIND}:plain:${p.forwardId}:${job.id}`, {
          now,
          payload: { forwardId: p.forwardId, step: "send", plain: true } satisfies EmailCheckPayload,
        });
        return { note: "not back through the plus address: trying the address itself" };
      }
      return { note: next === "not_yet" ? "not back yet" : "came back" };
    }
    const settings = await readSettings(db);
    const publicUrl = opts.baseUrl ?? settings.notifications.appUrl ?? "";
    const facts = await businessFacts(db, settings);
    const sender = senderOf(settings, { transport: mailOut, publicUrl, business: facts.name });
    let logged = await mailByJob(db, job.id);
    let to: string | null = null;
    let token: string | null = null;
    if (!logged) {
      const started = await startCheck(db, p.forwardId, { plain: p.plain === true, now });
      if (!started) return { note: "no check: the address is gone, or had its checks for today" };
      to = started.to;
      token = started.token;
      const words = checkMailText({ address: started.forward.address, token });
      logged = await storeMail(
        db,
        {
          itemId: null,
          jobKey: job.id,
          recipient: "owner",
          template: "forward.check",
          lang: "en",
          subject: words.subject,
          text: words.text,
          ...(sender ? {} : { skip: "no_sender" as const }),
        },
        mailDomain(sender?.from.address, publicUrl),
        now,
      );
    } else {
      // A retry of the same check: the address and token are in what was stored.
      token = /\b(c[a-z2-7]{16})\b/.exec(logged.subject)?.[1] ?? null;
      const { rows } = await db.client.query({
        sql: `SELECT f.address, f.check_plain FROM mail_tokens t JOIN email_forwards f ON f.id = t.forward_id
               WHERE t.token = ?`,
        params: [token ?? ""],
        method: "all",
      });
      const r = rows[0];
      if (r && token) {
        const [local, domain] = String(r[0]).split("@");
        to = Number(r[1]) === 1 ? String(r[0]) : `${local}+${token}@${domain}`;
      }
    }
    if (logged.status === "skipped") return { note: `not sent: ${logged.skipReason ?? "skipped"}` };
    if (logged.status === "sent" || logged.status === "failed") return { note: `already ${logged.status}` };
    if (!sender || !to || !token) return { note: "not sent: nothing to send from, or the address is gone" };
    const sent = await sendLogged(
      db,
      mailOut,
      logged,
      {
        ...sender,
        to: [to],
        subject: logged.subject,
        text: logged.bodyText,
        headers: {
          ...autoHeaders({ automatic: true, template: logged.template }),
          [LOOP_HEADER]: await loopMark(db, now),
          [CHECK_HEADER]: token,
        },
      },
      { final: job.attempts >= job.maxAttempts, now },
    );
    if (sent === null) return { note: "check not sent: held back" };
    await ensureJob(db, EMAIL_CHECK_KIND, `${EMAIL_CHECK_KIND}:follow:${token}`, {
      now,
      runAt: now + CHECK_WAIT_MS,
      payload: { forwardId: p.forwardId, step: "follow" } satisfies EmailCheckPayload,
    });
    return { note: "check sent to the business's own address" };
  };
}
