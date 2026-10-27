import type { Db } from "../db";
import type { SecretBox } from "../secrets/box";
import { WriteError } from "../write/errors";
import { buildPrompt, type JudgePort, runJudge } from "./judge";
import { judgeText } from "./mask";
import type { BusinessContext } from "./screen";

/**
 * The owner's own AI model, on their own server (ADR-029 §11.5): one of three providers, a model from
 * that provider's own list, and the key they paste once, sealed and never shown again. It reads for
 * the spam filters the owner switched on, as a model the operator set up does. A hosted inbox never
 * takes one (D12): its host pays for the reading. The provider calls themselves are the host's
 * (`ModelKit`), so core never reaches the network.
 */

export const MODEL_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const isModelProvider = (v: unknown): v is ModelProvider =>
  v === "anthropic" || v === "openai" || v === "gemini";

/** How the owner app names each provider. */
export const PROVIDER_NAMES: Readonly<Record<ModelProvider, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

/** A model a provider lists, as its chooser shows it. */
export interface ModelChoice {
  readonly id: string;
  readonly name: string;
}

/** What the host gives the inbox to use an owner's own key: a judge from it, and the provider's list. */
export interface ModelKit {
  judge(cfg: { readonly provider: ModelProvider; readonly model: string; readonly key: string }): JudgePort;
  /** The provider's own list of models for this key; throws a `ModelKitError` when the key or the provider fails. */
  models(cfg: { readonly provider: ModelProvider; readonly key: string }): Promise<readonly ModelChoice[]>;
}

/** Why a provider could not be used: the key was refused, or the provider could not be reached. */
export class ModelKitError extends Error {
  constructor(
    readonly reason: "key" | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "ModelKitError";
  }
}

/** The card in Settings → Integrations → Your AI model. */
export interface ModelCard {
  /** An owner may bring a model here: their own server, with somewhere to keep the key. */
  readonly offered: boolean;
  /** Why not, when not: `hosted` (the host reads), `no_secret` (nothing to seal a key with). */
  readonly not_offered: "hosted" | "no_secret" | null;
  /** Set up by whoever runs the server (`SPAM_MODEL_*`): nothing to change here. */
  readonly set_by_server: { readonly provider: string; readonly model: string } | null;
  readonly own: {
    readonly provider: ModelProvider;
    readonly provider_name: string;
    readonly model: string;
    readonly set_at: string;
    readonly tested: { readonly at: string; readonly pitch: boolean; readonly customer: boolean } | null;
  } | null;
  readonly providers: readonly { readonly id: ModelProvider; readonly name: string }[];
  readonly can_change: boolean;
}

/** What Test found: whether the sales pitch was spotted and the customer came through. */
export type ModelTest =
  | { readonly ok: true; readonly pitch: boolean; readonly customer: boolean }
  | { readonly ok: false; readonly why: string };

const ROW_ID = "own";

export interface StoredModel {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly keyEnc: string;
  readonly setAt: number;
  readonly testedAt: number | null;
  readonly test: { readonly pitch: boolean; readonly customer: boolean } | null;
}

export async function storedModel(db: Db): Promise<StoredModel | null> {
  const { rows } = await db.client.query({
    sql: "SELECT provider, model, key_enc, set_at, tested_at, test FROM spam_model WHERE id = ?",
    params: [ROW_ID],
    method: "all",
  });
  const r = rows[0];
  if (!r || !isModelProvider(r[0])) return null;
  let test: StoredModel["test"] = null;
  try {
    test = r[5] ? (JSON.parse(String(r[5])) as StoredModel["test"]) : null;
  } catch {
    test = null;
  }
  return {
    provider: r[0],
    model: String(r[1]),
    keyEnc: String(r[2]),
    setAt: Number(r[3]),
    testedAt: r[4] === null || r[4] === undefined ? null : Number(r[4]),
    test,
  };
}

export function openKey(secrets: SecretBox, keyEnc: string): Promise<string> {
  return secrets.open("model-key", ROW_ID, keyEnc);
}

/** Keeps the owner's model: the key sealed under this row, so a copy elsewhere opens nothing. */
export async function saveModel(
  db: Db,
  secrets: SecretBox,
  o: {
    readonly provider: ModelProvider;
    readonly model: string;
    readonly key: string;
    readonly byUser: string;
    readonly now: number;
  },
): Promise<void> {
  const sealed = await secrets.seal("model-key", ROW_ID, o.key);
  await db.client.query({
    sql: `INSERT INTO spam_model (id, provider, model, key_enc, by_user, set_at, tested_at, test)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, model = excluded.model, key_enc = excluded.key_enc,
            by_user = excluded.by_user, set_at = excluded.set_at, tested_at = NULL, test = NULL`,
    params: [ROW_ID, o.provider, o.model, sealed, o.byUser, o.now],
    method: "run",
  });
}

export async function removeModel(db: Db): Promise<boolean> {
  const r = await db.client.query({ sql: "DELETE FROM spam_model WHERE id = ?", params: [ROW_ID], method: "run" });
  return r.changes > 0;
}

export async function recordTest(db: Db, test: { pitch: boolean; customer: boolean }, now: number): Promise<void> {
  await db.client.query({
    sql: "UPDATE spam_model SET tested_at = ?, test = ? WHERE id = ?",
    params: [now, JSON.stringify(test), ROW_ID],
    method: "run",
  });
}

/**
 * The two samples Test sends (ADR-029 §11.5): a sales pitch the filter should spot, and a customer
 * asking a price in Japanese, who should come through. Nothing of the inbox's own messages is sent.
 */
export const TEST_SAMPLES = {
  pitch:
    "Hello, I came across your website and noticed it is not on the first page of search results. Our team builds backlinks and guest posts that will put you at the top within 30 days, guaranteed. Reply today for a free audit and our price list.",
  customer: "こんにちは。来週の土曜日に4人で伺いたいのですが、料金はおいくらですか？予約はできますか？",
} as const;

/** Asks the model about both samples, as the filter would: masked, inside a boundary, checked. */
export async function testModel(
  port: JudgePort,
  business: Pick<BusinessContext, "name" | "description" | "offers" | "languages">,
  opts: Parameters<typeof runJudge>[3] = {},
): Promise<ModelTest> {
  const ask = async (text: string) => {
    const masked = judgeText(text);
    const prompt = buildPrompt(
      {
        name: business.name,
        description: business.description,
        offers: business.offers,
        languages: business.languages,
      },
      {
        kind: "message",
        door: "website form",
        displayName: null,
        domain: "example.org",
        provider: "a company domain",
        subject: null,
        linkDomains: [],
        attachments: "none",
        text: masked,
      },
    );
    return runJudge(port, prompt.request, { nonce: prompt.nonce, text: masked }, opts);
  };
  const [pitch, customer] = [await ask(TEST_SAMPLES.pitch), await ask(TEST_SAMPLES.customer)];
  if (!pitch.ok) return { ok: false, why: pitch.why };
  if (!customer.ok) return { ok: false, why: customer.why };
  const unwanted = (k: string) => k === "sales_pitch" || k === "scam" || k === "junk";
  return {
    ok: true,
    pitch: pitch.answer.kind === "sales_pitch" && pitch.answer.certainty !== "low",
    customer: !(unwanted(customer.answer.kind) && customer.answer.certainty !== "low"),
  };
}

/** A provider's refusal in the owner's words. */
export function kitProblem(error: unknown, provider: ModelProvider): WriteError {
  const name = PROVIDER_NAMES[provider];
  if (error instanceof ModelKitError && error.reason === "key") {
    return new WriteError("invalid_input", `${name} didn't accept this key. Copy it again from your ${name} account.`, {
      fields: [{ path: "key", problem: "invalid", message: `${name} didn't accept this key.` }],
    });
  }
  return new WriteError("unavailable", `${name} couldn't be reached just now. Try again in a minute.`, {
    details: { reason: "provider_unreachable" },
  });
}
