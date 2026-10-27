import Anthropic from "@anthropic-ai/sdk";
import type { JudgePort, JudgeRequest, JudgeResult } from "@surfingdog/core";

/**
 * The spam filter's AI check over the Messages API (ADR-041 §7.5), with the provider's own SDK: one
 * system prompt, one user message, the answer held to the JSON schema core gives, thinking off, low
 * effort, at most 300 tokens. Core keeps the time, the one retry and every check on the answer; this
 * only says what came back, or why nothing usable did. The model and the key come from whoever runs the
 * inbox (never from a tenant's settings); a model that refuses to have thinking switched off is asked
 * again without it, and remembered for as long as the process runs.
 */
export interface MessagesJudgeOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Another address for the same API (a gateway in front of it). */
  readonly baseURL?: string | undefined;
  /** The outbound fetch the host allows; a test's recorded answers. */
  readonly fetch?: typeof fetch | undefined;
}

export function messagesJudge(o: MessagesJudgeOptions): JudgePort {
  const client = new Anthropic({
    apiKey: o.apiKey,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    // Core keeps the time and decides on the one retry.
    maxRetries: 0,
    timeout: 8_000,
  });
  let thinkingOff = true;
  const ask = async (req: JudgeRequest, signal: AbortSignal): Promise<JudgeResult> => {
    const started = Date.now();
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: o.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      ...(thinkingOff ? { thinking: { type: "disabled" } } : {}),
      output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
    };
    const res = await client.messages.create(params, { signal });
    const tokensIn = res.usage.input_tokens;
    const tokensOut = res.usage.output_tokens;
    if (res.stop_reason === "refusal") return { ok: false, why: "refused", tokensIn, tokensOut };
    if (res.stop_reason !== "end_turn") return { ok: false, why: "invalid", tokensIn, tokensOut };
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { ok: true, answer: text, tokensIn, tokensOut, ms: Date.now() - started };
  };
  return {
    async judge(req, signal) {
      try {
        return await ask(req, signal);
      } catch (error) {
        // A model that keeps thinking on: asked again without the field, once, and not sent it again.
        if (thinkingOff && error instanceof Anthropic.BadRequestError && /thinking/i.test(error.message)) {
          thinkingOff = false;
          try {
            return await ask(req, signal);
          } catch (again) {
            return failure(again, signal);
          }
        }
        return failure(error, signal);
      }
    },
  };
}

function failure(error: unknown, signal: AbortSignal): JudgeResult {
  if (
    signal.aborted ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIUserAbortError
  ) {
    return { ok: false, why: "timeout" };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { ok: false, why: "auth" };
  }
  if (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return { ok: false, why: "unavailable" };
  }
  if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) return { ok: false, why: "unavailable" };
  return { ok: false, why: "invalid" };
}
