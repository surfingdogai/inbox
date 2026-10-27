import type { JudgePort, JudgeRequest, JudgeResult } from "@surfingdog/core";
import { messagesJudge } from "./messages";

/**
 * The spam filter's AI check over a chat-completions API (ADR-029 §7.5), the shape many providers and
 * local model servers speak: `POST {url}/chat/completions`, the answer held to the JSON schema core
 * gives (`response_format: json_schema`, strict), at most 300 tokens, temperature 0 — dropped once
 * for a model that refuses it. Only what came back is reported; core keeps the time and the checks.
 */
export interface ChatJudgeOptions {
  /** The API's base, up to and without `/chat/completions`. */
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly fetch?: typeof fetch | undefined;
}

interface ChatAnswer {
  readonly choices?: readonly {
    readonly finish_reason?: string;
    readonly message?: { readonly content?: string | null; readonly refusal?: string | null };
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export function chatJudge(o: ChatJudgeOptions): JudgePort {
  const doFetch = o.fetch ?? fetch;
  const endpoint = `${o.url.replace(/\/+$/, "")}/chat/completions`;
  let temperature = true;
  const ask = async (
    req: JudgeRequest,
    signal: AbortSignal,
  ): Promise<{ status: number; json: ChatAnswer | null; text: string }> => {
    const res = await doFetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens,
        ...(temperature ? { temperature: 0 } : {}),
        response_format: { type: "json_schema", json_schema: { name: "spam_check", strict: true, schema: req.schema } },
      }),
    });
    const text = await res.text();
    let json: ChatAnswer | null = null;
    try {
      json = JSON.parse(text) as ChatAnswer;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
  return {
    async judge(req, signal): Promise<JudgeResult> {
      const started = Date.now();
      try {
        let r = await ask(req, signal);
        if (r.status === 400 && temperature && /temperature/i.test(r.text)) {
          temperature = false;
          r = await ask(req, signal);
        }
        if (r.status === 401 || r.status === 403) return { ok: false, why: "auth" };
        if (r.status === 429 || r.status >= 500) return { ok: false, why: "unavailable" };
        if (r.status !== 200 || !r.json) return { ok: false, why: "invalid" };
        const tokensIn = r.json.usage?.prompt_tokens ?? 0;
        const tokensOut = r.json.usage?.completion_tokens ?? 0;
        const choice = r.json.choices?.[0];
        if (choice?.message?.refusal) return { ok: false, why: "refused", tokensIn, tokensOut };
        if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
          return { ok: false, why: "invalid", tokensIn, tokensOut };
        }
        return { ok: true, answer: choice.message.content, tokensIn, tokensOut, ms: Date.now() - started };
      } catch {
        return { ok: false, why: signal.aborted ? "timeout" : "unavailable" };
      }
    },
  };
}

/**
 * The model the operator set up for the spam filter, from the inbox's environment (ADR-029 §7.2):
 * `SPAM_MODEL_API` (`messages` or `chat`), `SPAM_MODEL_URL` (a chat API's base, a local model server's
 * too), `SPAM_MODEL_KEY`, `SPAM_MODEL` (the model's id) and `SPAM_MODEL_NAME` (how Settings names it).
 * Null when none is set up: the filters then look for known phrases only.
 */
export function judgeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): { readonly judge: JudgePort; readonly provider: string; readonly model: string } | null {
  const api = env.SPAM_MODEL_API?.trim();
  const model = env.SPAM_MODEL?.trim();
  if (!api || !model) return null;
  const name = env.SPAM_MODEL_NAME?.trim() || model;
  if (api === "messages") {
    const key = env.SPAM_MODEL_KEY?.trim();
    if (!key) return null;
    return {
      judge: messagesJudge({ apiKey: key, model, baseURL: env.SPAM_MODEL_URL?.trim() || undefined, fetch: fetchImpl }),
      provider: "Messages API",
      model: name,
    };
  }
  if (api === "chat") {
    const url = env.SPAM_MODEL_URL?.trim();
    if (!url || !/^https?:\/\//.test(url)) return null;
    return {
      judge: chatJudge({ url, apiKey: env.SPAM_MODEL_KEY?.trim() || undefined, model, fetch: fetchImpl }),
      provider: new URL(url).hostname,
      model: name,
    };
  }
  return null;
}
