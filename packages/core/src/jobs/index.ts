import type { MailOut } from "@surfingdog/platform";
import type { InboxOutcomeCode, ReceiptKind } from "@surfingdog/spec";
import { EMAIL_CHECK_KIND, emailCheckHandler } from "../email/check";
import { BACKFILL_BATCH, backfillPartyContacts, PARTY_CONTACTS_BACKFILL_KIND } from "../identity/contacts";
import {
  PHONE_PUSH_KIND,
  PHONE_PUSH_ONE_KIND,
  phonePushFanoutHandler,
  phonePushOneHandler,
  withPhonePush,
} from "../phones/jobs";
import type { PhoneCapabilities } from "../phones/phones";
import type { ReceiptCapabilities } from "../receipts/capabilities";
import { runRulesForEvent } from "../rules/engine";
import type { SecretBox } from "../secrets/box";
import {
  SPAM_HELD_DIGEST_KIND,
  SPAM_WEEKLY_KIND,
  scheduleSpamEmails,
  spamHeldDigestHandler,
  spamWeeklyHandler,
} from "../spam/emails";
import { gateOf, holdsBack, SPAM_SCREEN_KIND, stillScreening } from "../spam/screen";
import { SPAM_SHARE_KIND } from "../spam/shared";
import { SCREEN_DEADLINE_MS } from "../spam/types";
import { LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "./lifecycle";
import { type NotifyPayload, notifyHandler, OWNER_DIGEST_KIND, ownerDigestHandler } from "./notify";
import type { JobHandler } from "./runner";
import { JobRunner } from "./runner";
import { ensureJob } from "./schedule";

export * from "./lifecycle";
export * from "./mail-log";
export * from "./notify";
export * from "./runner";
export * from "./schedule";

/**
 * The standard runner: notifications, rules, receipts. `receipts` is optional only so a seed or a
 * test that never confirms anything real can build a runner without a secret box; a job that does
 * arrive then records why nothing was issued instead of failing.
 */
export function createRunner(deps: {
  mailOut: MailOut;
  baseUrl?: string | undefined;
  receipts?: ReceiptCapabilities | undefined;
  /** Opens a first contact's key for the email that carries it to the customer (ADR-017 §2.1). */
  secrets?: SecretBox | null | undefined;
  /** The owner's phones (ADR-028): with them, a notification to each phone that wants one. */
  phones?: PhoneCapabilities | undefined;
  /** The spam filter (ADR-041): the screening that waits on an AI check, and its daily housekeeping. */
  spam?: SpamJobs | undefined;
}): JobRunner {
  const runner = new JobRunner()
    // The owner's phones hear of what the owner is emailed about, whether or not the email goes (ADR-028).
    .register(
      "notify",
      withPhonePush(
        notifyHandler(deps.mailOut, {
          ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
          secrets: deps.secrets ?? null,
        }),
      ),
    )
    // Owner alerts past the hour's cap, in one email at the end of the hour.
    .register(OWNER_DIGEST_KIND, ownerDigestHandler(deps.mailOut, deps.baseUrl ? { baseUrl: deps.baseUrl } : {}))
    // The live "forwarding works" check (ADR-026 §2): an email to the business's own address.
    .register(EMAIL_CHECK_KIND, emailCheckHandler(deps.mailOut, { baseUrl: deps.baseUrl }))
    .register("rules", async (job, { db, now }) => {
      const p = job.payload as { itemId: string; eventId: string; trigger: string };
      // Held or put aside by the spam filter (ADR-041): no rule runs. Still being screened, inside its
      // deadline: it waits for the verdict, or for the deadline, whichever comes first.
      const gate = await gateOf(db, p.itemId);
      if (holdsBack(gate)) return { note: "held by the spam filter: no rule runs" };
      if (gate && stillScreening(gate, now)) {
        await ensureJob(db, "rules", `rules:${p.eventId}:wait`, {
          now,
          runAt: gate.createdAt + SCREEN_DEADLINE_MS,
          payload: p,
        });
        return { note: "waiting for its screening" };
      }
      const r = await runRulesForEvent(db, { ...p, now, onlyFlags: gate?.screen === "warned" });
      return {
        note: `${r.evaluated} evaluated, ${r.matched.length} matched, ${r.actions} actions${r.errors.length ? `; ${r.errors.join(" | ")}` : ""}`,
      };
    })
    .register("issue_receipt", async (job, { db, now }) => {
      const p = job.payload as IssueReceiptPayload;
      if (!deps.receipts) return { note: "this runner has no receipt capability; nothing issued" };
      const r = await deps.receipts.issue(p.itemId, p.kind, now, {
        outcome: p.outcome,
        aut: p.aut === 1,
        eventId: p.eventId,
        offerId: p.offerId,
      });
      // A skip is a decision, not a failure: the reason is recorded here and the job is done.
      // Retrying would not change the environment it is complaining about.
      if (r.outcome === "skipped") return { note: r.note };
      // Waiting for a first contact's answer (ADR-017 §3.2): the same job again in a minute.
      if (r.outcome === "deferred") {
        await ensureJob(
          db,
          "issue_receipt",
          `receipt:${p.itemId}:${p.outcome ?? (p.offerId ? `${p.kind}:${p.offerId}` : p.kind)}:wait:${Math.floor(now / 60_000)}`,
          {
            now,
            runAt: now + 60_000,
            payload: p,
          },
        );
        return { note: r.note };
      }
      return { note: `${r.outcome} ${p.outcome ?? p.kind} receipt ${r.receipt.id}` };
    })
    .register("review_fact", async () => ({ note: "review facts arrive in a later release" }))
    .register(
      LIFECYCLE_SWEEP_KIND,
      withSpamDaily(
        deps.spam,
        withPhonePrune(
          deps.phones,
          lifecycleSweepHandler({ mailOut: deps.mailOut, secrets: deps.secrets ?? null, baseUrl: deps.baseUrl }),
        ),
      ),
    )
    // The contacts backfill (0009): resumable, 200 parties a run, each run queueing the next.
    .register(PARTY_CONTACTS_BACKFILL_KIND, async (job, { db, now }) => {
      const after = String((job.payload as { after?: unknown } | null)?.after ?? "");
      const r = await backfillPartyContacts(db, after, now);
      if (r.last && r.done === BACKFILL_BATCH) {
        await ensureJob(db, PARTY_CONTACTS_BACKFILL_KIND, `${PARTY_CONTACTS_BACKFILL_KIND}:${r.last}`, {
          now,
          payload: { after: r.last },
        });
      }
      return { note: `${r.done} part${r.done === 1 ? "y" : "ies"} after ${after || "the start"}` };
    });
  if (deps.spam) {
    const spam = deps.spam;
    runner
      // A stranger's request waiting on its AI check: decided, then its effects pulled forward or
      // cancelled. Run again at once, so what it made due runs in this same run.
      .register(SPAM_SCREEN_KIND, async (job, { now }) => {
        const p = job.payload as { itemId: string; eventId: string };
        const r = await spam.screen({ itemId: p.itemId, eventId: p.eventId, now });
        return { note: r.note, rerun: true };
      })
      // What this inbox says of one item, told to its host's shared list of known spam (ADR-041 §16).
      .register(SPAM_SHARE_KIND, async (job, { now }) => {
        const p = job.payload as { itemId: string };
        return spam.share(p.itemId, now);
      })
      .register(SPAM_DAILY_KIND, async (_job, { now }) => {
        const r = await spam.daily(now);
        return { note: `${r.removed} put-aside item${r.removed === 1 ? "" : "s"} past their time removed` };
      })
      // The owner's two emails from the filter (ADR-041 §11.6): only when there is something to say.
      .register(SPAM_HELD_DIGEST_KIND, spamHeldDigestHandler(deps.mailOut, { baseUrl: deps.baseUrl }))
      .register(SPAM_WEEKLY_KIND, spamWeeklyHandler(deps.mailOut, { baseUrl: deps.baseUrl }));
  }
  if (deps.phones) {
    runner
      .register(PHONE_PUSH_KIND, phonePushFanoutHandler(deps.phones))
      // One phone's notifications one after another; a slow relay delays only push.
      .register(PHONE_PUSH_ONE_KIND, phonePushOneHandler(deps.phones), { lane: () => "push" });
  }
  return runner;
}

/**
 * What a transition queues for a receipt: the kind, for an outcome which one and whether nobody
 * decided it, and for an amendment the change both sides agreed.
 */
export interface IssueReceiptPayload {
  readonly itemId: string;
  readonly kind: ReceiptKind;
  readonly eventId?: string;
  readonly outcome?: InboxOutcomeCode;
  readonly aut?: 0 | 1;
  readonly offerId?: string;
}

export type { NotifyPayload };

/** What the runner needs of the spam filter (`SpamCapabilities`). */
export interface SpamJobs {
  screen(input: {
    readonly itemId: string;
    readonly eventId: string;
    readonly now: number;
  }): Promise<{ readonly note: string }>;
  daily(now: number): Promise<{ readonly removed: number }>;
  share(itemId: string, now: number): Promise<{ readonly note: string }>;
}

/** The spam filter's daily housekeeping (ADR-041 §9.4): one a day, each run queueing the next. */
export const SPAM_DAILY_KIND = "spam_daily";

/**
 * The sweep makes sure the spam filter's housekeeping is due once a day (ADR-041): only where the
 * runner has a spam filter to run it.
 */
function withSpamDaily(spam: SpamJobs | undefined, sweep: JobHandler): JobHandler {
  if (!spam) return sweep;
  return async (job, ctx) => {
    const day = new Date(ctx.now).toISOString().slice(0, 10);
    await ensureJob(ctx.db, SPAM_DAILY_KIND, `${SPAM_DAILY_KIND}:${day}`, { now: ctx.now }).catch(() => undefined);
    // The morning digest and the Monday summary, each due at its hour in the business's time.
    await scheduleSpamEmails(ctx.db, ctx.now).catch(() => undefined);
    return sweep(job, ctx);
  };
}

/**
 * Each quarter hour's sweep tidies the phones first (ADR-028): phones nobody confirmed in time go,
 * and tokens nothing can use any more are deleted. A failure there never stops the sweep.
 */
function withPhonePrune(phones: PhoneCapabilities | undefined, sweep: JobHandler): JobHandler {
  if (!phones) return sweep;
  return async (job, ctx) => {
    if (((job.payload as { link?: number } | null)?.link ?? 0) === 0)
      await phones.prune(ctx.now).catch(() => undefined);
    return sweep(job, ctx);
  };
}
