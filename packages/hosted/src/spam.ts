import { messagesJudge } from "@surfingdog/adapters";
import { FILTERS, type JudgePort, type SpamHostPolicy } from "@surfingdog/core";
import type { Ledger } from "./ledger";
import { type PolicyPayload, planOf } from "./types";

/**
 * The spam filter on a hosted inbox (ADR-041 §7.2, §15.3). The founder's decisions: Pro includes the
 * three filters, read by our AI, Claude Haiku from Anthropic, on our own Anthropic key; Free keeps basic
 * protection, with no AI. The key lives in the shard's environment only, never in a tenant's file,
 * settings, policy, download, answers or logs, and every check an inbox makes is reserved in the shared
 * ledger before it is made: within the inbox's day's and month's caps, and within the runtime's own
 * token budget for the day across every inbox here. Over any of them the check is not made, and the
 * filters look for known phrases only. Without the key no model is asked, and Settings says so.
 */

/** The model our AI check uses: Claude Haiku. */
export const HOSTED_SPAM_MODEL = "claude-haiku-5-5";

/** The caps on our AI check per inbox, unless the policy sets others. */
export const HOSTED_DAY_CAP = 150;
export const HOSTED_MONTH_CAP = 1_500;

/** The model's settings, from the shard's environment. */
export interface HostedModel {
  readonly judge: JudgePort;
  /** The runtime's token budget for a day, every inbox together. */
  readonly dailyTokens: number;
  /** Who reads, as Settings names them. */
  readonly name: string;
}

/**
 * `HOSTED_SPAM_ANTHROPIC_KEY` (our Anthropic key; unset, no model is asked), `HOSTED_SPAM_MODEL` (the
 * model's id, `claude-haiku-5-5` unless set) and `HOSTED_SPAM_DAILY_TOKENS` (50 million by default).
 * Null when the key is not set: no hosted inbox's filter asks a model, and the AI check is off.
 */
export function hostedModelFrom(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): HostedModel | null {
  const key = env.HOSTED_SPAM_ANTHROPIC_KEY?.trim();
  if (!key) return null;
  const model = env.HOSTED_SPAM_MODEL?.trim() || HOSTED_SPAM_MODEL;
  const tokens = Number(env.HOSTED_SPAM_DAILY_TOKENS?.trim() || 50_000_000);
  const dailyTokens = Number.isInteger(tokens) && tokens > 0 ? tokens : 50_000_000;
  return {
    judge: messagesJudge({ apiKey: key, model, fetch: fetchImpl }),
    dailyTokens,
    name: modelName(model),
  };
}

/** "Claude Haiku, by Anthropic": the model as an owner reads it, its provider named plainly. */
export function modelName(model: string): string {
  const family = /haiku/i.test(model) ? "Claude Haiku" : /sonnet/i.test(model) ? "Claude Sonnet" : "Claude";
  return `${family}, by Anthropic`;
}

/**
 * The policy's plan and `spam` limits, as the inbox's spam filter reads them. Pro: the three filters,
 * on unless a person switched one off, read by our AI when the model is set up and the policy does not
 * stop it. Free: no filters and no AI; basic protection works the same on both.
 */
export function spamHostPolicy(p: PolicyPayload, model: HostedModel | null): SpamHostPolicy {
  const pro = planOf(p) === "pro";
  const ai = pro && model !== null && p.spam?.ai !== false;
  return {
    plan: pro ? "pro" : "free",
    ai,
    filters: pro ? FILTERS : [],
    defaultOn: pro,
    dayCap: p.spam?.day_cap ?? HOSTED_DAY_CAP,
    monthCap: p.spam?.month_cap ?? HOSTED_MONTH_CAP,
    reader: ai && model ? model.name : null,
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
      // Sent, and back without its usage: about a token every three characters, and the whole answer.
      else if (!r.ok && (r.why === "timeout" || r.why === "unavailable"))
        o.ledger.recordJudgeEstimate((req.system.length + req.user.length) / 3 + req.maxTokens);
      return r;
    },
  };
}
