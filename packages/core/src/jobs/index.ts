import type { MailOut } from "@surfingdog/platform";
import { type NotifyPayload, notifyHandler } from "./notify";
import { JobRunner } from "./runner";

export * from "./notify";
export * from "./runner";

/** The standard runner: notifications now, rules and receipts as they land. */
export function createRunner(deps: { mailOut: MailOut; baseUrl?: string | undefined }): JobRunner {
  return new JobRunner()
    .register("notify", notifyHandler(deps.mailOut, deps.baseUrl ? { baseUrl: deps.baseUrl } : {}))
    .register("rules", async () => ({ note: "rules engine not enabled yet" }))
    .register("issue_receipt", async () => ({ note: "receipts arrive in the next release" }))
    .register("review_fact", async () => ({ note: "review facts arrive in a later release" }));
}

export type { NotifyPayload };
