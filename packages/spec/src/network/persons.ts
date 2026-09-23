import { z } from "zod";
import {
  jktSchema,
  keyStringSchema,
  passRefSchema,
  passStringSchema,
  ppidSchema,
  presentationIdSchema,
  publicIdSchema,
  receiptShaSchema,
  sessionStringSchema,
  tierSchema,
  timestampSchema,
} from "./common";
import { outcomeCodeSchema } from "./receipts";

/**
 * Persons, keys, passes and presentations (ADR-017 §2, §5.3, §7.1–7.2). A person never signs up:
 * an inbox asks for a key on a first booking or order (`POST /v1/persons`), and afterwards presents
 * what the customer's agent carries (`POST /v1/presentations`). Both calls are signed sdi-instance/1.
 * There is no lookup of a person by email or anything else.
 */

/** §5.3's person object: the whole of what a presentation tells a business. */
export const personStandingSchema = z.object({
  tier: tierSchema,
  score: z.number().min(0).max(1).describe("Stored to 6 decimals; compared as floor(score × 10⁴ + 0.5)."),
  kept: z.int().min(0),
  broken: z.int().min(0),
  businesses: z.int().min(0).describe("Mutually unrelated businesses with kept outcomes of this person's."),
  email_proven: z.boolean().describe("The person proved the address with an emailed code."),
  since: timestampSchema,
  unusual_use: z.boolean().describe("The pass was seen at over 10 businesses in 24 h, or has two signing keys."),
  rules: z.int().min(1).describe("The rules version in force, as GET /v1/ranking publishes it."),
});
export type PersonStanding = z.infer<typeof personStandingSchema>;

/**
 * The agent that carried the person, as the inbox saw it: a label for the pass ("ChatGPT"), and
 * when it signed, its key's thumbprint and its platform's directory. Recorded, never trusted.
 */
export const agentInfoSchema = z.object({
  label: z.string().max(64).optional(),
  jkt: jktSchema.optional(),
  directory: z
    .url()
    .regex(/^https:\/\//)
    .max(512)
    .optional(),
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

/** `POST /v1/persons` (sdi-instance/1): a first contact. */
export const personIssuanceRequestSchema = z.object({
  request_id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .describe("The item id: the network replays the same answer for the same request_id for 7 days."),
  email: z.string().min(3).max(320).describe("The customer's address; normalised by the network (§2)."),
  agent: agentInfoSchema.optional(),
  email_proof: z
    .enum(["otp", "dkim"])
    .optional()
    .describe("How this business proved the address: its one-time code, or authenticated mail (ADR-017 A1.7)."),
});
export type PersonIssuanceRequest = z.infer<typeof personIssuanceRequestSchema>;

/** `201`: the key (sent to the person by email), the first pass (back to the agent), and the presentation. */
export const personIssuedSchema = z.object({
  key: keyStringSchema,
  pass: passStringSchema,
  presentation: presentationIdSchema,
  ppid: ppidSchema,
  person: personStandingSchema,
});
export type PersonIssued = z.infer<typeof personIssuedSchema>;

/**
 * A signature the inbox verified, forwarded so the network can verify it again under the key
 * delegated to the pass (§7.2): the label's inner list with parameters exactly as received, the
 * base64 between the colons of `Signature`, and the UTF-8 signature base the inbox verified.
 */
export const agentKeySchema = z.object({
  jkt: jktSchema,
  pass_ref: passRefSchema,
  label: z.string().regex(/^[a-z*][a-z0-9_.*-]{0,63}$/),
  signature_input: z.string().max(4096),
  signature: z.string().max(128),
  signature_base: z.string().max(16384),
});
export type AgentKey = z.infer<typeof agentKeySchema>;

export const presentationPurposeSchema = z.enum(["request", "ack"]);

/** `POST /v1/presentations` (sdi-instance/1): exactly one of `pass`, `key` or `agent_key`. */
export const presentationRequestSchema = z
  .object({
    pass: passStringSchema.optional().describe("The pass's secret form; a bound pass needs agent_key instead."),
    key: keyStringSchema.optional().describe("Exchanged for a pass (returned in `pass`), reused for 24 h per agent."),
    agent_key: agentKeySchema.optional(),
    purpose: presentationPurposeSchema.default("request"),
    sha: receiptShaSchema.optional().describe("With purpose ack: the receipt acknowledged."),
    email: z.string().max(320).optional().describe("The item's email, so the answer says whether it is the person's."),
    agent: agentInfoSchema.optional(),
    email_proof: z
      .enum(["otp", "dkim"])
      .optional()
      .describe("How this business proved the address: its one-time code, or authenticated mail (ADR-017 A1.7)."),
  })
  .superRefine((r, ctx) => {
    const n = [r.pass, r.key, r.agent_key].filter((v) => v !== undefined).length;
    if (n !== 1) ctx.addIssue({ code: "custom", message: "send exactly one of pass, key or agent_key", path: [] });
    if (r.purpose === "ack" && r.sha === undefined) {
      ctx.addIssue({ code: "custom", message: "an ack names the receipt it acknowledges by sha", path: ["sha"] });
    }
  });
export type PresentationRequest = z.input<typeof presentationRequestSchema>;

export const emailMatchSchema = z.enum(["proven", "unproven", "no"]);

export const presentationResponseSchema = z.object({
  presentation: presentationIdSchema,
  ppid: ppidSchema,
  person: personStandingSchema,
  pass: passStringSchema.optional().describe("The pass a key was exchanged for."),
  email_match: emailMatchSchema.optional().describe("proven: the person's, proven by code; unproven; no."),
});
export type PresentationResponse = z.infer<typeof presentationResponseSchema>;

/** `POST /v1/passes`: the key mints a pass (at most 10 a day per key). */
export const passMintRequestSchema = z.object({ key: keyStringSchema, label: z.string().max(64).optional() });
export const passMintResponseSchema = z.object({ pass: passStringSchema });

/** `POST /v1/passes/revoke`: the pass itself, or `pass_id` (or a pass reference) with the person's session. */
export const passRevokeRequestSchema = z.union([
  z.object({ pass: z.union([passStringSchema, passRefSchema]) }),
  z.object({ pass_id: publicIdSchema }),
]);
export const passRevokeResponseSchema = z.object({ revoked: z.literal(true) });

/** `POST /v1/delegations`: session **and** sdi-agent/1 by the key being delegated. */
export const delegationRequestSchema = z.object({ pass: z.union([passStringSchema, passRefSchema]) });
export const delegationResponseSchema = z.object({ pass_ref: passRefSchema, jkt: jktSchema, bound: z.literal(true) });

/** `GET /v1/person` (session): the person's own record, each list newest first, at most 200. */
export const personViewSchema = z.object({
  standing: personStandingSchema,
  evidence: z.array(
    z.object({
      id: z.string(),
      business: z.string().describe("The business's domain."),
      out: outcomeCodeSchema,
      ledger: z.enum(["kept", "broken"]),
      state: z.string(),
      dated_at: timestampSchema,
      contest_id: z.string().nullable(),
      contest_status: z.string().optional(),
    }),
  ),
  keys: z.array(
    z.object({ key_id: publicIdSchema, created_at: timestampSchema, revoked_at: timestampSchema.nullable() }),
  ),
  passes: z.array(
    z.object({
      pass_id: publicIdSchema,
      pass_ref: passRefSchema,
      label: z.string(),
      issued_via: z.string(),
      created_at: timestampSchema,
      last_seen_at: timestampSchema.nullable(),
      revoked_at: timestampSchema.nullable(),
      bound: z.boolean(),
      unusual_use: z.boolean(),
    }),
  ),
  delegations: z.array(
    z.object({
      pass_ref: passRefSchema,
      jkt: jktSchema,
      label: z.string(),
      created_at: timestampSchema,
      revoked_at: timestampSchema.nullable(),
    }),
  ),
  presentations: z.array(
    z.object({
      id: presentationIdSchema,
      business: z.string(),
      purpose: presentationPurposeSchema,
      via: z.string(),
      pass_ref: passRefSchema,
      created_at: timestampSchema,
    }),
  ),
});
export type PersonView = z.infer<typeof personViewSchema>;

/** `POST /v1/person/contests` (session): a broken outcome about the person, to be counted half until withdrawn. */
export const contestRequestSchema = z.object({ evidence: z.string().min(1).max(64) });
export const contestCreatedSchema = z.object({ id: z.string() });

export const recoveryPurposeSchema = z.enum(["recover", "sign_in"]);

/** `POST /v1/recovery/start`: always `202`, whether or not the address is known. */
export const recoveryStartRequestSchema = z.object({ email: z.string().max(320), purpose: recoveryPurposeSchema });
export const recoveryStartResponseSchema = z.object({ ok: z.literal(true), message: z.string() });

/** `POST /v1/recovery/finish`: `sign_in` → a session; `recover` → a new key and pass on the same person. */
export const recoveryFinishRequestSchema = z.object({
  email: z.string().max(320),
  code: z.string().regex(/^[0-9]{6}$/),
  purpose: recoveryPurposeSchema,
});
export const recoverySessionSchema = z.object({ session: sessionStringSchema, expires_at: timestampSchema });
export const recoveredKeySchema = z.object({ key: keyStringSchema, pass: passStringSchema });
