import Anthropic from "@anthropic-ai/sdk";
import { type ModelChoice, type ModelKit, ModelKitError, type ModelProvider } from "@surfingdog/core";
import { chatJudge } from "./chat";
import { messagesJudge } from "./messages";

/**
 * How an owner's own AI model is reached on their own server (ADR-041 §11.5): Anthropic through its own
 * SDK, OpenAI and Google Gemini through their chat-completions APIs. The models come from each
 * provider's own list for the key, so no model is ever named here; only the ones that answer in text
 * are offered. The key travels only to its provider, through the host's outbound fetch.
 */

const OPENAI = "https://api.openai.com/v1";
/** Gemini's chat-completions door, which takes the same requests and the same JSON schema. */
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Models a provider lists that cannot read a message and answer in text: images, sound, embeddings, search. */
const NOT_TEXT =
  /(embed|tts|whisper|dall-e|image|imagen|audio|realtime|transcribe|moderation|search|davinci|babbage|aqa|veo|lyria|computer-use|live)/i;

/** A provider's smaller, cheaper models by name: what the spam check needs, and what the owner pays least for. */
const SMALL = /haiku|mini|nano|flash|lite|small/i;

/** The models with the small ones first, each group in the order it came: the owner pays per check. */
export function smallFirst(models: readonly ModelChoice[]): ModelChoice[] {
  return [...models.filter((m) => SMALL.test(m.id)), ...models.filter((m) => !SMALL.test(m.id))];
}

export function ownModelKit(fetchImpl?: typeof fetch): ModelKit {
  const doFetch = fetchImpl ?? fetch;
  return {
    judge({ provider, model, key }) {
      if (provider === "anthropic") return messagesJudge({ apiKey: key, model, fetch: fetchImpl });
      return chatJudge({ url: provider === "openai" ? OPENAI : GEMINI, apiKey: key, model, fetch: fetchImpl });
    },
    async models({ provider, key }) {
      if (provider === "anthropic") return smallFirst(await anthropicModels(key, fetchImpl));
      return smallFirst(await chatModels(provider, key, doFetch));
    },
  };
}

async function anthropicModels(key: string, fetchImpl?: typeof fetch): Promise<ModelChoice[]> {
  const client = new Anthropic({
    apiKey: key,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    maxRetries: 0,
    timeout: 8_000,
  });
  const out: ModelChoice[] = [];
  try {
    for await (const m of client.models.list()) {
      out.push({ id: m.id, name: m.display_name || m.id });
      if (out.length >= 100) break;
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new ModelKitError("key", "the key was refused");
    }
    throw new ModelKitError("unreachable", "the provider did not answer");
  }
  return out;
}

async function chatModels(
  provider: Exclude<ModelProvider, "anthropic">,
  key: string,
  doFetch: typeof fetch,
): Promise<ModelChoice[]> {
  let res: Response;
  try {
    res = await doFetch(`${provider === "openai" ? OPENAI : GEMINI}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ModelKitError("unreachable", "the provider did not answer");
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ModelKitError("key", "the key was refused");
  }
  if (!res.ok) throw new ModelKitError("unreachable", `the provider answered ${res.status}`);
  let body: { data?: { id?: unknown }[] } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ModelKitError("unreachable", "the provider's answer was not readable");
  }
  const ids = (body.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id.replace(/^models\//, "") : ""))
    .filter((id) => id && !NOT_TEXT.test(id))
    .filter((id) => (provider === "gemini" ? /gemini|gemma/i.test(id) : /^(gpt|o\d|chatgpt)/i.test(id)));
  return [...new Set(ids)].sort().map((id) => ({ id, name: id }));
}
