import type { MailOut } from "@surfingdog/platform";
import { runRulesForEvent } from "../rules/engine";
import { type NotifyPayload, notifyHandler } from "./notify";
import { JobRunner } from "./runner";

export * from "./notify";
export * from "./runner";
export * from "./schedule";

/** The standard runner: notifications now, rules and receipts as they land. */
export function createRunner(deps: { mailOut: MailOut; baseUrl?: string | undefined }): JobRunner {
  return new JobRunner()
    .register("notify", notifyHandler(deps.mailOut, deps.baseUrl ? { baseUrl: deps.baseUrl } : {}))
    .register("rules", async (job, { db, now }) => {
      const p = job.payload as { itemId: string; eventId: string; trigger: string };
      const r = await runRulesForEvent(db, { ...p, now });
      return {
        note: `${r.evaluated} evaluated, ${r.matched.length} matched, ${r.actions} actions${r.errors.length ? `; ${r.errors.join(" | ")}` : ""}`,
      };
    })
    .register("issue_receipt", async () => ({ note: "receipts arrive in the next release" }))
    .register("review_fact", async () => ({ note: "review facts arrive in a later release" }));
}

export type { NotifyPayload };
