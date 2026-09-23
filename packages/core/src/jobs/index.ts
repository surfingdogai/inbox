import type { MailOut } from "@surfingdog/platform";
import type { InboxOutcomeCode, ReceiptKind } from "@surfingdog/spec";
import { BACKFILL_BATCH, backfillPartyContacts, PARTY_CONTACTS_BACKFILL_KIND } from "../identity/contacts";
import type { ReceiptCapabilities } from "../receipts/capabilities";
import { runRulesForEvent } from "../rules/engine";
import type { SecretBox } from "../secrets/box";
import { LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler } from "./lifecycle";
import { type NotifyPayload, notifyHandler } from "./notify";
import { JobRunner } from "./runner";
import { ensureJob } from "./schedule";

export * from "./lifecycle";
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
}): JobRunner {
  return (
    new JobRunner()
      .register(
        "notify",
        notifyHandler(deps.mailOut, {
          ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
          secrets: deps.secrets ?? null,
        }),
      )
      .register("rules", async (job, { db, now }) => {
        const p = job.payload as { itemId: string; eventId: string; trigger: string };
        const r = await runRulesForEvent(db, { ...p, now });
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
        });
        // A skip is a decision, not a failure: the reason is recorded here and the job is done.
        // Retrying would not change the environment it is complaining about.
        if (r.outcome === "skipped") return { note: r.note };
        // Waiting for a first contact's answer (ADR-017 §3.2): the same job again in a minute.
        if (r.outcome === "deferred") {
          await ensureJob(
            db,
            "issue_receipt",
            `receipt:${p.itemId}:${p.outcome ?? p.kind}:wait:${Math.floor(now / 60_000)}`,
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
      .register(LIFECYCLE_SWEEP_KIND, lifecycleSweepHandler({ mailOut: deps.mailOut, secrets: deps.secrets ?? null }))
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
      })
  );
}

/** What a transition queues for a receipt: the kind, and for an outcome which one and whether nobody decided it. */
export interface IssueReceiptPayload {
  readonly itemId: string;
  readonly kind: ReceiptKind;
  readonly eventId?: string;
  readonly outcome?: InboxOutcomeCode;
  readonly aut?: 0 | 1;
}

export type { NotifyPayload };
