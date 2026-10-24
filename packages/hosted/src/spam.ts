import { chatJudge, messagesJudge } from "@surfingdog/adapters";
import type { JudgePort, SpamHostPolicy } from "@surfingdog/core";
import type { Ledger } from "./ledger";
import type { PolicyPayload } from "./types";

/**
 * The spam filter on a hosted inbox (ADR-029 §7.2, §15.3). The founder's decision: we pay for the AI,
 * and the filters are a cost per inbox × filters switched on. So the model is ours — its key lives in
 * the shard's environment only, never in a tenant's file, settings, policy, download, answers or logs —
 * and every check an inbox makes is reserved in the shared ledger before it is made: within the
 * inbox's day's and month's caps, and within the runtime's own token budget for the day across every
 * inbox here. Over any of them the check is not made, and the filters look for known phrases only.
 * What a policy does not allow (no `spam` block, `ai: false`) asks no model at all.
 */

/** The model's settings, from the shard's environment. */
export interface HostedModel {
  readonly judge: JudgePort;
  /** The runtime's token budget for a day, every inbox together. */
  readonly dailyTokens: number;
}

/**
 * `HOSTED_SPAM_MODEL_API` (`messages` or `chat`), `HOSTED_SPAM_MODEL_URL`, `HOSTED_SPAM_MODEL`,
 * `HOSTED_SPAM_MODEL_KEY` and `HOSTED_SPAM_DAILY_TOKENS` (50 million by default). Null when the model is
 * not set up: no hosted inbox's filter asks one.
 */
export function hostedModelFrom(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): HostedModel | null {
  const api = env.HOSTED_SPAM_MODEL_API?.trim();
  const model = env.HOSTED_SPAM_MODEL?.trim();
  const key = env.HOSTED_SPAM_MODEL_KEY?.trim();
  const url = env.HOSTED_SPAM_MODEL_URL?.trim() || undefined;
  if (!api || !model || !key) return null;
  const tokens = Number(env.HOSTED_SPAM_DAILY_TOKENS?.trim() || 50_000_000);
  const dailyTokens = Number.isInteger(tokens) && tokens > 0 ? tokens : 50_000_000;
  if (api === "messages")
    return { judge: messagesJudge({ apiKey: key, model, baseURL: url, fetch: fetchImpl }), dailyTokens };
  if (api === "chat" && url) return { judge: chatJudge({ url, apiKey: key, model, fetch: fetchImpl }), dailyTokens };
  return null;
}

/** The policy's `spam` block, as the inbox's spam filter reads it; null when the policy has none. */
export function spamHostPolicy(p: PolicyPayload): SpamHostPolicy | null {
  const s = p.spam;
  if (!s) return null;
  return {
    ai: s.ai,
    filters: s.filters,
    dayCap: s.day_cap,
    monthCap: s.month_cap,
    reader: s.reader,
    billing: s.billing,
    price: s.price ? { currency: s.price.currency, perFilterMonthMinor: s.price.per_filter_month_minor } : null,
  };
}

/**
 * The model, for one inbox: asked only when the policy lets our AI read for it, and each check reserved
 * in the ledger first. A reservation refused is `capped`: the check is not made.
 */
export function tenantJudge(o: {
  readonly model: HostedModel | null;
  readonly ledger: Ledger;
  readonly tenantId: string;
  readonly policy: SpamHostPolicy | null;
}): JudgePort | null {
  const { model, policy } = o;
  if (!model || !policy?.ai) return null;
  return {
    async judge(req, signal) {
      const reserved = o.ledger.reserveJudge(o.tenantId, {
        day: policy.dayCap,
        month: policy.monthCap,
        dailyTokens: model.dailyTokens,
      });
      if (reserved !== "ok") return { ok: false, why: "capped" };
      const r = await model.judge.judge(req, signal);
      const tokensIn = r.ok ? r.tokensIn : (r.tokensIn ?? 0);
      const tokensOut = r.ok ? r.tokensOut : (r.tokensOut ?? 0);
      if (tokensIn || tokensOut) o.ledger.recordJudge(o.tenantId, tokensIn, tokensOut);
      return r;
    },
  };
}
