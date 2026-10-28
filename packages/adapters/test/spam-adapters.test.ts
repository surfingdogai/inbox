import { buildPrompt, runJudge } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { chatJudge, geminiJudge, judgeFromEnv, messagesJudge } from "../src/spam";
import { ownModelKit, smallFirst } from "../src/spam/kit";

/**
 * The spam filter's model adapters (ADR-041 §7.5), against recorded answers: what each sends,
 * how each reads what comes back, and how each says why nothing usable did. Nothing here reaches a
 * network; the fetch each is given answers from a list.
 */

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function recorder(answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = answers.shift();
    if (!next) throw new Error("no recorded answer left");
    return next();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });

const { request, nonce } = buildPrompt(
  {
    name: "Panadería Sol",
    description: "A bakery",
    offers: ["Sourdough loaf", "Birthday cake"],
    languages: ["es", "en"],
  },
  {
    kind: "message",
    door: "email",
    displayName: "Growth Team",
    domain: "rankfast.example",
    provider: "a company domain",
    subject: "Page one of Google",
    linkDomains: [],
    attachments: "none",
    text: "We can get your bakery to page one of Google in 30 days. Reply YES for a free audit.",
  },
  { nonce: "n0nce-recorded-01", boundary: "----- recorded-boundary -----" },
);
const sentText = "We can get your bakery to page one of Google in 30 days. Reply YES for a free audit.";

const answer = {
  check: nonce,
  kind: "sales_pitch",
  certainty: "high",
  customer_intent: false,
  talks_to_filter: false,
  topic: "seo",
  quotes: ["page one of Google in 30 days"],
};

const message = (text: string, stop = "end_turn", usage = { input_tokens: 812, output_tokens: 61 }) => ({
  id: "msg_recorded",
  type: "message",
  role: "assistant",
  model: "a-model",
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  usage,
});

const noSleep = { sleep: async () => {} };
const signal = () => new AbortController().signal;

describe("the messages adapter", () => {
  it("sends one system prompt and one message, thinking off, low effort, the answer held to the schema", async () => {
    const r = recorder([json(200, message(JSON.stringify(answer)))]);
    const port = messagesJudge({
      apiKey: "sk-test-recorded",
      model: "a-model",
      baseURL: "https://models.example.net",
      fetch: r.fetchImpl,
    });
    const out = await runJudge(port, request, { nonce, text: sentText }, noSleep);
    expect(out).toMatchObject({
      ok: true,
      answer: { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["page one of google in 30 days"] },
      tokensIn: 812,
      tokensOut: 61,
    });
    const [call] = r.sent;
    expect(call?.url).toBe("https://models.example.net/v1/messages");
    expect(call?.headers.get("x-api-key")).toBe("sk-test-recorded");
    expect(call?.body).toEqual({
      model: "a-model",
      max_tokens: 300,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
    });
    // The key goes in its header and nowhere else.
    expect(JSON.stringify(call?.body)).not.toContain("sk-test-recorded");
  });

  it("says a refusal is a refusal, and an answer cut short is not an answer", async () => {
    const r = recorder([json(200, message("", "refusal")), json(200, message('{"check":', "max_tokens"))]);
    const port = messagesJudge({ apiKey: "k", model: "a-model", fetch: r.fetchImpl });
    expect(await port.judge(request, signal())).toEqual({ ok: false, why: "refused", tokensIn: 812, tokensOut: 61 });
    expect(await port.judge(request, signal())).toEqual({ ok: false, why: "invalid", tokensIn: 812, tokensOut: 61 });
  });

  it("asks a model that will not switch thinking off once more without it, and remembers", async () => {
    const r = recorder([
      json(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "thinking.type: disabled is not supported for this model" },
      }),
      json(200, message(JSON.stringify(answer))),
      json(200, message(JSON.stringify(answer))),
    ]);
    const port = messagesJudge({ apiKey: "k", model: "a-model", fetch: r.fetchImpl });
    expect((await port.judge(request, signal())).ok).toBe(true);
    expect((await port.judge(request, signal())).ok).toBe(true);
    expect(r.sent.map((s) => "thinking" in s.body)).toEqual([true, false, false]);
  });

  it("tells a wrong key from a model that is down, and core tries a model that is down once more", async () => {
    const auth = recorder([
      json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    ]);
    expect(await messagesJudge({ apiKey: "k", model: "m", fetch: auth.fetchImpl }).judge(request, signal())).toEqual({
      ok: false,
      why: "auth",
    });
    const down = recorder([
      json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      json(500, { type: "error", error: { type: "api_error", message: "Internal" } }),
    ]);
    const out = await runJudge(
      messagesJudge({ apiKey: "k", model: "m", fetch: down.fetchImpl }),
      request,
      { nonce, text: sentText },
      noSleep,
    );
    expect(out).toEqual({ ok: false, why: "unavailable", tokensIn: 0, tokensOut: 0 });
    expect(down.sent).toHaveLength(2);
    const busy = recorder([json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } })]);
    expect(await messagesJudge({ apiKey: "k", model: "m", fetch: busy.fetchImpl }).judge(request, signal())).toEqual({
      ok: false,
      why: "unavailable",
    });
  });

  it("hands core an answer that fails its checks as it came, and core turns it down", async () => {
    const wrongCheck = recorder([json(200, message(JSON.stringify({ ...answer, check: "something else" })))]);
    expect(
      await runJudge(
        messagesJudge({ apiKey: "k", model: "m", fetch: wrongCheck.fetchImpl }),
        request,
        { nonce, text: sentText },
        noSleep,
      ),
    ).toEqual({
      ok: false,
      why: "invalid: check value",
      tokensIn: 812,
      tokensOut: 61,
    });
  });
});

const chat = (content: string | null, finish = "stop", extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-recorded",
  object: "chat.completion",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...extra } }],
  usage: { prompt_tokens: 790, completion_tokens: 58 },
});

describe("the chat-completions adapter", () => {
  it("sends the prompt with the answer held to the schema, strict, at temperature 0", async () => {
    const r = recorder([json(200, chat(JSON.stringify(answer)))]);
    const port = chatJudge({
      url: "https://llm.example.net/v1/",
      apiKey: "gsk_recorded",
      model: "open-model",
      fetch: r.fetchImpl,
    });
    const out = await runJudge(port, request, { nonce, text: sentText }, noSleep);
    expect(out).toMatchObject({
      ok: true,
      answer: { kind: "sales_pitch", topic: "seo" },
      tokensIn: 790,
      tokensOut: 58,
    });
    const [call] = r.sent;
    expect(call?.url).toBe("https://llm.example.net/v1/chat/completions");
    expect(call?.headers.get("authorization")).toBe("Bearer gsk_recorded");
    expect(call?.body).toEqual({
      model: "open-model",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "spam_check", strict: true, schema: request.schema },
      },
    });
  });

  it("needs no key for a model server of the operator's own", async () => {
    const r = recorder([json(200, chat(JSON.stringify(answer)))]);
    await chatJudge({ url: "http://127.0.0.1:11434/v1", model: "local", fetch: r.fetchImpl }).judge(request, signal());
    expect(r.sent[0]?.headers.get("authorization")).toBeNull();
  });

  it("asks a model that refuses temperature once more without it, and remembers", async () => {
    const r = recorder([
      json(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }),
      json(200, chat(JSON.stringify(answer))),
      json(200, chat(JSON.stringify(answer))),
    ]);
    const port = chatJudge({ url: "https://llm.example.net/v1", model: "m", fetch: r.fetchImpl });
    expect((await port.judge(request, signal())).ok).toBe(true);
    expect((await port.judge(request, signal())).ok).toBe(true);
    expect(r.sent.map((s) => "temperature" in s.body)).toEqual([true, false, false]);
  });

  it("says why nothing usable came back", async () => {
    const r = recorder([
      json(200, chat(null, "stop", { refusal: "I can't help with that." })),
      json(200, chat('{"check":', "length")),
      json(401, { error: { message: "bad key" } }),
      json(503, { error: { message: "unavailable" } }),
      json(400, { error: { message: "model not found" } }),
      () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const port = chatJudge({ url: "https://llm.example.net/v1", model: "m", fetch: r.fetchImpl });
    const whys: string[] = [];
    for (let i = 0; i < 6; i++) {
      const out = await port.judge(request, signal());
      whys.push(out.ok ? "ok" : out.why);
    }
    expect(whys).toEqual(["refused", "invalid", "auth", "unavailable", "invalid", "invalid"]);
  });

  it("gives up on a model that never answers, by core's clock", async () => {
    const hang = (async (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })) as typeof fetch;
    const out = await runJudge(
      chatJudge({ url: "https://llm.example.net/v1", model: "m", fetch: hang }),
      request,
      { nonce, text: sentText },
      {
        ...noSleep,
        limits: { attemptMs: 20, retryAfterMs: 0, totalMs: 100 },
      },
    );
    expect(out).toEqual({ ok: false, why: "timeout", tokensIn: 0, tokensOut: 0 });
  });
});

const gemini = (text: string, finish = "STOP", usage: Record<string, number> = {}) => ({
  candidates: [{ index: 0, finishReason: finish, content: { role: "model", parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 805, candidatesTokenCount: 57, thoughtsTokenCount: 12, ...usage },
  modelVersion: "gemini-3.1-flash-lite",
});

describe("the Gemini adapter", () => {
  it("sends one generateContent call: the key in its header, the answer held to the schema, thinking minimal, nothing stored", async () => {
    const key = "AQ.Ab8RN6recorded-auth-key-0123456789";
    const r = recorder([json(200, gemini(JSON.stringify(answer)))]);
    const port = geminiJudge({ apiKey: key, model: "gemini-3.1-flash-lite", fetch: r.fetchImpl });
    const out = await runJudge(port, request, { nonce, text: sentText }, noSleep);
    expect(out).toMatchObject({
      ok: true,
      answer: { kind: "sales_pitch", certainty: "high", topic: "seo", quotes: ["page one of google in 30 days"] },
      tokensIn: 805,
      // Thinking is billed as output: it counts as output does.
      tokensOut: 69,
    });
    const [call] = r.sent;
    expect(call?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    expect(call?.headers.get("x-goog-api-key")).toBe(key);
    expect(call?.headers.get("authorization")).toBeNull();
    expect(call?.body).toEqual({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        maxOutputTokens: 300,
        responseMimeType: "application/json",
        responseJsonSchema: request.schema,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
      store: false,
    });
    // The key goes in its header and nowhere else: not the address, not the body.
    expect(call?.url).not.toContain(key);
    expect(JSON.stringify(call?.body)).not.toContain(key);
    // Sampling is left at Google's defaults, as Google asks for Gemini 3.
    expect(JSON.stringify(call?.body)).not.toMatch(/temperature|topP|topK/);
  });

  it("turns thinking off on Gemini 2.5, and asks a model that refuses the setting once more without it", async () => {
    const r = recorder([
      json(400, {
        error: { code: 400, message: "Thinking level is not supported for this model.", status: "INVALID_ARGUMENT" },
      }),
      json(200, gemini(JSON.stringify(answer))),
      json(200, gemini(JSON.stringify(answer))),
      json(200, gemini(JSON.stringify(answer))),
    ]);
    const port = geminiJudge({ apiKey: "k", model: "gemini-9-lite", fetch: r.fetchImpl });
    expect((await port.judge(request, signal())).ok).toBe(true);
    expect((await port.judge(request, signal())).ok).toBe(true);
    const old = geminiJudge({ apiKey: "k", model: "gemini-2.5-flash-lite", fetch: r.fetchImpl });
    expect((await old.judge(request, signal())).ok).toBe(true);
    const thinking = r.sent.map((s) => (s.body.generationConfig as Record<string, unknown>).thinkingConfig ?? null);
    expect(thinking).toEqual([{ thinkingLevel: "minimal" }, null, null, { thinkingBudget: 0 }]);
  });

  it("says why nothing usable came back", async () => {
    const r = recorder([
      json(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 800 } }),
      json(200, gemini("", "SAFETY")),
      json(200, gemini('{"check":', "MAX_TOKENS")),
      json(400, {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      }),
      json(403, { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } }),
      json(429, { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }),
      json(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }),
      json(404, { error: { code: 404, message: "models/gemini-x is not found", status: "NOT_FOUND" } }),
      () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const port = geminiJudge({ apiKey: "k", model: "gemini-3.1-flash-lite", fetch: r.fetchImpl });
    const whys: string[] = [];
    for (let i = 0; i < 9; i++) {
      const out = await port.judge(request, signal());
      whys.push(out.ok ? "ok" : out.why);
    }
    expect(whys).toEqual([
      "refused",
      "refused",
      "invalid",
      "auth",
      "auth",
      "unavailable",
      "unavailable",
      "invalid",
      "invalid",
    ]);
  });

  it("gives up on a model that never answers, by core's clock", async () => {
    const hang = (async (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })) as typeof fetch;
    const out = await runJudge(
      geminiJudge({ apiKey: "k", model: "gemini-3.1-flash-lite", fetch: hang }),
      request,
      { nonce, text: sentText },
      { ...noSleep, limits: { attemptMs: 20, retryAfterMs: 0, totalMs: 100 } },
    );
    expect(out).toEqual({ ok: false, why: "timeout", tokensIn: 0, tokensOut: 0 });
  });
});

describe("the model the operator set up", () => {
  it("is read from the environment, and is none until it is complete", () => {
    expect(judgeFromEnv({})).toBeNull();
    expect(judgeFromEnv({ SPAM_MODEL_API: "messages", SPAM_MODEL: "a-model" })).toBeNull();
    expect(
      judgeFromEnv({ SPAM_MODEL_API: "chat", SPAM_MODEL: "m", SPAM_MODEL_URL: "ftp://llm.example.net" }),
    ).toBeNull();
    expect(judgeFromEnv({ SPAM_MODEL_API: "other", SPAM_MODEL: "m", SPAM_MODEL_KEY: "k" })).toBeNull();
    const messages = judgeFromEnv({
      SPAM_MODEL_API: "messages",
      SPAM_MODEL: "a-model",
      SPAM_MODEL_KEY: "k",
      SPAM_MODEL_NAME: "Small model",
    });
    expect(messages).toMatchObject({ provider: "Messages API", model: "Small model" });
    const local = judgeFromEnv({
      SPAM_MODEL_API: "chat",
      SPAM_MODEL: "local-8b",
      SPAM_MODEL_URL: "http://models.internal.example:8080/v1",
    });
    expect(local).toMatchObject({ provider: "models.internal.example", model: "local-8b" });
  });
});

describe("the owner's own model, chosen from the provider's list", () => {
  it("lists the small models first, each group in the provider's order: the owner pays for each check", async () => {
    const listed = {
      data: [{ id: "gpt-text-large" }, { id: "gpt-text-mini" }, { id: "gpt-text-nano" }, { id: "gpt-text-xl" }],
    };
    const kit = ownModelKit(
      (async () =>
        new Response(JSON.stringify(listed), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    const models = await kit.models({ provider: "openai", key: "sk-test-key-0001" });
    expect(models.map((m) => m.id)).toEqual(["gpt-text-mini", "gpt-text-nano", "gpt-text-large", "gpt-text-xl"]);
    expect(
      smallFirst([
        { id: "big-1", name: "Big" },
        { id: "big-1-haiku", name: "Haiku" },
      ]).map((m) => m.id),
    ).toEqual(["big-1-haiku", "big-1"]);
  });
});
