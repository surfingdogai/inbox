import type { MailOut } from "@surfingdog/platform";
import type { ReceiptCapabilities } from "../receipts/capabilities";
import { runRulesForEvent } from "../rules/engine";
import { type NotifyPayload, notifyHandler } from "./notify";
import { JobRunner } from "./runner";

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
}): JobRunner {
  return new JobRunner()
    .register("notify", notifyHandler(deps.mailOut, deps.baseUrl ? { baseUrl: deps.baseUrl } : {}))
    .register("rules", async (job, { db, now }) => {
      const p = job.payload as { itemId: string; eventId: string; trigger: string };
      const r = await runRulesForEvent(db, { ...p, now });
      return {
        note: `${r.evaluated} evaluated, ${r.matched.length} matched, ${r.actions} actions${r.errors.length ? `; ${r.errors.join(" | ")}` : ""}`,
      };
    })
    .register("issue_receipt", async (job, { now }) => {
      const p = job.payload as { itemId: string; kind: "confirmed" | "paid" };
      if (!deps.receipts) return { note: "this runner has no receipt capability; nothing issued" };
      const r = await deps.receipts.issue(p.itemId, p.kind, now);
      // A skip is a decision, not a failure: the reason is recorded here and the job is done.
      // Retrying would not change the environment it is complaining about.
      if (r.outcome === "skipped") return { note: r.note };
      return { note: `${r.outcome} ${p.kind} receipt ${r.receipt.id}` };
    })
    .register("review_fact", async () => ({ note: "review facts arrive in a later release" }));
}

export type { NotifyPayload };
