import type { JudgePort, JudgeRequest, JudgeResult } from "@surfingdog/core";

/**
 * The spam filter's AI check over Google's Gemini API itself (ADR-041 §7.5), with a plain fetch: one
 * `generateContent` call with the system prompt and the message, the answer held to the JSON schema
 * core gives (`responseJsonSchema`), at most 300 tokens, thinking turned as low as the model goes
 * (`minimal` on Gemini 3, none on 2.5) and dropped once for a model that refuses it, the sampling left
 * at Google's defaults, and `store: false`, so the project's own request logs never keep it whatever the
 * project's setting. The key goes in `x-goog-api-key`, the header Google documents for both kinds of
 * key, standard and authorization. Only what came back is reported; core keeps the time and the checks.
 */
export interface GeminiJudgeOptions {
  readonly apiKey: string;
  /** The model's id as Google's model list gives it, `gemini-3.1-flash-lite` for example. */
  readonly model: string;
  /** Another address for the same API; Google's own unless set. */
  readonly baseURL?: string | undefined;
  /** The outbound fetch the host allows; a test's recorded answers. */
  readonly fetch?: typeof fetch | undefined;
}

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiAnswer {
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: { readonly parts?: readonly { readonly text?: string; readonly thought?: boolean }[] };
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
  };
}

/** Why Google stopped that is a refusal: what the message says, or the answer would have said, was blocked. */
const REFUSED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** Thinking as low as it goes: Gemini 2.5 turns it off with a budget of none; Gemini 3 and later go to minimal. */
const leastThinking = (model: string) =>
  /^gemini-2(\.|-)/i.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };

export function geminiJudge(o: GeminiJudgeOptions): JudgePort {
  const doFetch = o.fetch ?? fetch;
  const base = (o.baseURL ?? GEMINI_API).replace(/\/+$/, "");
  const endpoint = `${base}/models/${encodeURIComponent(o.model)}:generateContent`;
  let thinking = true;
  const ask = async (
    req: JudgeRequest,
    signal: AbortSignal,
  ): Promise<{ status: number; json: GeminiAnswer | null; text: string }> => {
    const res = await doFetch(endpoint, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          responseMimeType: "application/json",
          responseJsonSchema: req.schema,
          ...(thinking ? { thinkingConfig: leastThinking(o.model) } : {}),
        },
        store: false,
      }),
    });
    const text = await res.text();
    let json: GeminiAnswer | null = null;
    try {
      json = JSON.parse(text) as GeminiAnswer;
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
        // A model that takes no thinking setting: asked again without it, once, and not sent it again.
        if (r.status === 400 && thinking && /thinking/i.test(r.text)) {
          thinking = false;
          r = await ask(req, signal);
        }
        // Google answers a key it does not know with a 400 that says so.
        if (
          r.status === 401 ||
          r.status === 403 ||
          (r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(r.text))
        ) {
          return { ok: false, why: "auth" };
        }
        if (r.status === 429 || r.status >= 500) return { ok: false, why: "unavailable" };
        if (r.status !== 200 || !r.json) return { ok: false, why: "invalid" };
        const usage = r.json.usageMetadata;
        const tokensIn = usage?.promptTokenCount ?? 0;
        // Thinking is billed as output, so it counts against the day's budget as output does.
        const tokensOut = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
        if (r.json.promptFeedback?.blockReason) return { ok: false, why: "refused", tokensIn, tokensOut };
        const candidate = r.json.candidates?.[0];
        const finish = candidate?.finishReason ?? "";
        if (REFUSED.has(finish)) return { ok: false, why: "refused", tokensIn, tokensOut };
        const answer = (candidate?.content?.parts ?? [])
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join("");
        if (finish !== "STOP" || !answer) return { ok: false, why: "invalid", tokensIn, tokensOut };
        return { ok: true, answer, tokensIn, tokensOut, ms: Date.now() - started };
      } catch {
        return { ok: false, why: signal.aborted ? "timeout" : "unavailable" };
      }
    },
  };
}
