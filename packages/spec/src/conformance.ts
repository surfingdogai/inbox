import type { z } from "zod";
import { MANIFEST_PATH, manifestSchema, readDoorsElsewhere, receiptPayloadSchema } from "./base";
import { doorTrackingParams } from "./door-platforms";
import { parseReceiptClaims, RULES_V6, receiptAckPayloadV2Schema, receiptPayloadV2Schema } from "./network/receipts";

/**
 * The conformance check: hand it a manifest, a receipt or an acknowledgement, and it says whether it holds to the
 * published specs (https://surfingdog.ai/spec/), and why not. It runs the same schemas the specs publish and the
 * rules a JSON Schema cannot say (an origin, a key's thumbprint, an entry a reader drops), and, given the inbox's
 * keys, the signature. WebCrypto only, so it runs unchanged in a browser, on Node and in workerd.
 *
 * A receipt's and an acknowledgement's codes are the ones a network answers and `@surfingdog/sdk` throws: malformed,
 * bad_alg, bad_typ, unknown_key, bad_signature, bad_payload, wrong_issuer, not_yet, and for an acknowledgement
 * expired. The vectors in `vectors/receipts*.json` decide them.
 */

export type ConformanceKind = "manifest" | "receipt" | "acknowledgement";

export interface ConformanceFinding {
  /** Where, as a JSON path: `$.receipt_keys.keys[0].kid`, or `$` for the whole thing. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ConformanceReport {
  /** What it was read as; null when it is neither JSON nor a compact JWS. */
  readonly kind: ConformanceKind | null;
  /** True when there is no error. Warnings never fail a check. */
  readonly ok: boolean;
  /** The format and version read: `surfingdog-inbox/0`, `receipt claims v2`… */
  readonly version: string | null;
  readonly errors: readonly ConformanceFinding[];
  readonly warnings: readonly ConformanceFinding[];
  /** What was checked and held, in words, for a reader who wants to know what "ok" covered. */
  readonly passed: readonly string[];
}

export interface ReceiptCheckOptions {
  /** The inbox's keys: its JWKS, its manifest, or an array of public JWKs. Without them the signature is not checked. */
  readonly keys?: unknown;
  /** The inbox the receipt is expected from (`https://…`): anything else is `wrong_issuer`. */
  readonly issuer?: string | undefined;
  /** Milliseconds since the epoch; defaults to the clock. */
  readonly now?: number | undefined;
  /**
   * The network rules version the reader takes; defaults to 6, the one read since 27 September 2026 (amendments and
   * refunds). A code option only: what a reader of an earlier date takes is said by its date.
   */
  readonly rules?: number | undefined;
}

export interface AcknowledgementCheckOptions {
  /** The receipt it acknowledges, its compact JWS: `sha` is checked against it. */
  readonly receipt?: string | undefined;
  /** The receipt's id at the inbox: `rcp` is checked against it. */
  readonly receiptId?: string | undefined;
  /** When it reached the inbox, milliseconds since the epoch: the inbox takes one at most an hour old. Without it the age is not checked. */
  readonly now?: number | undefined;
}

export const RECEIPT_TYP = "sdi-receipt+jws";
export const ACK_TYP = "sdi-receipt-ack+jws";
/** How far ahead of the clock a receipt or an acknowledgement may be dated. */
export const MAX_FUTURE_SECONDS = 300;
/** How old an acknowledgement may be when it reaches the inbox. */
export const ACK_WINDOW_SECONDS = 3600;

const ED25519 = { name: "Ed25519" } as const;
const B64U43 = /^[A-Za-z0-9_-]{43}$/;

class Findings {
  readonly errors: ConformanceFinding[] = [];
  readonly warnings: ConformanceFinding[] = [];
  readonly passed: string[] = [];
  error(path: string, code: string, message: string) {
    this.errors.push({ path, code, message });
  }
  warn(path: string, code: string, message: string) {
    this.warnings.push({ path, code, message });
  }
  report(kind: ConformanceKind | null, version: string | null): ConformanceReport {
    return {
      kind,
      ok: this.errors.length === 0,
      version,
      errors: this.errors,
      warnings: this.warnings,
      passed: this.passed,
    };
  }
}

/** A JSON path for a Zod issue's path: `$.agent_policy.tiers[0]`. */
function pathOf(path: readonly PropertyKey[]): string {
  let out = "$";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : `.${String(p)}`;
  return out;
}

function zodFindings(f: Findings, error: z.ZodError, code: string, prefix: readonly PropertyKey[] = []) {
  for (const issue of error.issues) f.error(pathOf([...prefix, ...issue.path]), code, issue.message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* --- bytes ---------------------------------------------------------------------------------------------------------- */

const encoder = new TextEncoder();

function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** The RFC 7638 thumbprint of an Ed25519 public key: what a receipt's `kid` is. */
export async function ed25519Thumbprint(x: string): Promise<string> {
  return sha256(`{"crv":"Ed25519","kty":"OKP","x":${JSON.stringify(x)}}`);
}

async function verifyEd25519(x: string, signingInput: string, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x, ext: true }, ED25519, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(ED25519, key, signature as BufferSource, encoder.encode(signingInput));
  } catch {
    return false;
  }
}

/* --- the manifest --------------------------------------------------------------------------------------------------- */

/** An https origin: scheme and host (and port), nothing after it, no trailing slash. */
function httpsOrigin(value: string): { ok: boolean; why?: string } {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, why: "is not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, why: "is not https" };
  if (u.username || u.password) return { ok: false, why: "carries a user or a password" };
  if (value !== u.origin) return { ok: false, why: `is not an origin: write ${u.origin}` };
  return { ok: true };
}

/**
 * Checks a discovery manifest (`/.well-known/agent-inbox.json`): its schema, then what a schema cannot say. `instance`
 * and `review_services` are https origins; `item_types` names each kind once; every receipt key is an Ed25519 public
 * key (never a private one) whose `kid` is its RFC 7638 thumbprint; every entry of `doors_elsewhere` is one a reader
 * keeps; the protocols' addresses are https.
 */
export async function checkManifest(input: unknown): Promise<ConformanceReport> {
  const f = new Findings();
  if (!isObject(input)) {
    f.error("$", "not_an_object", "A manifest is a JSON object.");
    return f.report("manifest", null);
  }
  const version = typeof input.spec === "string" ? input.spec : null;
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) f.passed.push("Every field has the type and the bounds the schema gives it.");
  else zodFindings(f, parsed.error, "schema");

  if (typeof input.instance === "string") {
    const o = httpsOrigin(input.instance);
    if (o.ok) f.passed.push("instance is an https origin.");
    else f.error("$.instance", "not_origin", `instance ${o.why}.`);
  }

  if (Array.isArray(input.item_types)) {
    const seen = new Set<unknown>();
    input.item_types.forEach((t, i) => {
      if (seen.has(t)) f.error(`$.item_types[${i}]`, "duplicate", `${String(t)} is listed twice.`);
      seen.add(t);
    });
    if (!seen.has("message")) {
      f.warn("$.item_types", "no_message", "No message: an agent cannot ask this business anything here.");
    }
  }

  if (isObject(input.protocols)) {
    for (const [name, url] of Object.entries(input.protocols)) {
      if (typeof url === "string" && url.startsWith("http://")) {
        f.warn(`$.protocols.${name}`, "insecure_url", `${name} is served over http: agents expect https.`);
      }
    }
    if (Object.keys(input.protocols).length === 0) {
      f.warn("$.protocols", "no_doors", "No protocol is listed: an agent finds no door to use.");
    }
  }

  if (Array.isArray(input.review_services)) {
    input.review_services.forEach((s, i) => {
      if (typeof s !== "string") return;
      const o = httpsOrigin(s);
      if (!o.ok)
        f.error(`$.review_services[${i}]`, "not_origin", `A network is named by its https origin: this ${o.why}.`);
    });
  }

  const keys = isObject(input.receipt_keys) && Array.isArray(input.receipt_keys.keys) ? input.receipt_keys.keys : [];
  let goodKeys = 0;
  for (const [i, k] of keys.entries()) {
    const at = `$.receipt_keys.keys[${i}]`;
    if (!isObject(k)) continue;
    if ("d" in k) {
      f.error(
        `${at}.d`,
        "private_key",
        "This is a private key. Remove d now, and replace the key: it is no longer secret.",
      );
    }
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string" || !B64U43.test(k.x)) {
      f.error(
        at,
        "bad_key",
        "A receipt key is an Ed25519 public JWK: kty OKP, crv Ed25519, x of 43 base64url characters.",
      );
      continue;
    }
    if (k.alg !== undefined && k.alg !== "EdDSA") f.error(`${at}.alg`, "bad_alg", "A receipt key's alg is EdDSA.");
    const kid = await ed25519Thumbprint(k.x);
    if (k.kid === undefined) {
      f.warn(`${at}.kid`, "no_kid", `No kid: readers work it out as the key's thumbprint, ${kid}.`);
    } else if (k.kid !== kid) {
      f.error(
        `${at}.kid`,
        "kid_mismatch",
        `kid is the key's RFC 7638 thumbprint, ${kid}; receipts naming this kid will not verify.`,
      );
    } else {
      goodKeys++;
    }
  }
  if (keys.length > 0 && goodKeys === keys.length)
    f.passed.push("Every receipt key is an Ed25519 public key named by its thumbprint.");
  if (keys.length === 0)
    f.warn("$.receipt_keys.keys", "no_keys", "No receipt key: this inbox cannot issue receipts anyone can check.");

  if (Array.isArray(input.doors_elsewhere)) {
    const kept = readDoorsElsewhere(input);
    input.doors_elsewhere.forEach((e, i) => {
      const entry = isObject(e) ? e : {};
      const k = kept.find((k) => k.item_type === entry.item_type && k.url === entry.url);
      if (!k) {
        f.error(
          `$.doors_elsewhere[${i}]`,
          "dropped",
          "A reader drops this entry: one of the five item types, once, not one in item_types, at an https address on a named host.",
        );
        return;
      }
      if (entry.platform !== undefined && k.platform === undefined) {
        f.warn(
          `$.doors_elsewhere[${i}].platform`,
          "platform_dropped",
          "A reader keeps this door without its platform: a token of vocab/door-platforms.json that takes this kind of request, with the URL the business's own page there.",
        );
      }
      const tracking = doorTrackingParams(k.url);
      if (tracking.length) {
        f.warn(
          `$.doors_elsewhere[${i}].url`,
          "tracking",
          `The address carries tracking or affiliate parameters (${tracking.join(", ")}): send people to the page itself.`,
        );
      }
    });
  }

  if (f.errors.length === 0) f.passed.push(`It can be served at ${MANIFEST_PATH} as it is.`);
  return f.report("manifest", version);
}

/* --- receipts ------------------------------------------------------------------------------------------------------- */

/** A compact JWS with every space and line break taken out: none belongs in one. */
function compact(jws: string): string {
  return jws.replace(/\s+/g, "");
}

/**
 * Who reads claims under network rules version n, said by date: rules 6 (27 September 2026) added amendments and
 * refunds; rules 5 and earlier are the readers before it.
 */
function readerOf(rules: number): string {
  return rules >= RULES_V6 ? "since 27 September 2026" : "from before 27 September 2026";
}

interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

function parseJws(jws: string): ParsedJws | null {
  const parts = jws.trim().split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromB64u(part))) as unknown;
    const header = decode(h);
    const payload = decode(p);
    if (!isObject(header) || !isObject(payload)) return null;
    return { header, payload, signingInput: `${h}.${p}`, signature: fromB64u(s) };
  } catch {
    return null;
  }
}

interface PublicKey {
  readonly x: string;
  readonly kid?: string | undefined;
}

/** The keys out of a JWKS, a manifest (`receipt_keys`) or an array; null when there is nothing to read them from. */
export function receiptKeysOf(keys: unknown): PublicKey[] | null {
  const list = Array.isArray(keys)
    ? keys
    : isObject(keys) && Array.isArray(keys.keys)
      ? keys.keys
      : isObject(keys) && isObject(keys.receipt_keys) && Array.isArray(keys.receipt_keys.keys)
        ? keys.receipt_keys.keys
        : null;
  if (list === null) return null;
  return list
    .filter((k): k is Record<string, unknown> => isObject(k) && k.kty === "OKP" && k.crv === "Ed25519")
    .filter((k) => typeof k.x === "string")
    .map((k) => ({ x: k.x as string, kid: typeof k.kid === "string" ? k.kid : undefined }));
}

/**
 * Checks a receipt, a compact JWS (ADR-016; claims v2, ADR-017 §3.2; rules version 6): its header, its claims, and
 * with the inbox's keys its signature. The first failing check of the header or the signature stops the rest, as a
 * network stops; every claim that is wrong is listed.
 */
export async function checkReceipt(jws: string, opts: ReceiptCheckOptions = {}): Promise<ConformanceReport> {
  const f = new Findings();
  const parsed = parseJws(jws);
  if (!parsed) {
    f.error("$", "malformed", "A receipt is a compact JWS: three base64url parts, the first two JSON objects.");
    return f.report("receipt", null);
  }
  const { header, payload } = parsed;
  if (header.alg !== "EdDSA") {
    f.error("$.header.alg", "bad_alg", `A receipt is signed EdDSA, not ${String(header.alg)}.`);
    return f.report("receipt", null);
  }
  if (header.typ !== RECEIPT_TYP) {
    f.error(
      "$.header.typ",
      "bad_typ",
      `A receipt's typ is ${RECEIPT_TYP}${header.typ === ACK_TYP ? ": this is an acknowledgement" : ""}.`,
    );
    return f.report("receipt", null);
  }
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) {
    f.error("$.header.kid", "unknown_key", "A receipt names its key by kid.");
    return f.report("receipt", null);
  }
  f.passed.push(`The header is EdDSA and ${RECEIPT_TYP}, with a kid.`);

  const keys = opts.keys === undefined ? null : receiptKeysOf(opts.keys);
  if (opts.keys !== undefined && keys === null) {
    f.error("$keys", "malformed", 'The keys are a JWKS ({"keys": […]}), a manifest, or an array of public JWKs.');
    return f.report("receipt", null);
  }
  if (keys) {
    let key: PublicKey | undefined = keys.find((k) => k.kid === kid);
    if (!key) {
      for (const k of keys) if (k.kid === undefined && (await ed25519Thumbprint(k.x)) === kid) key = k;
    }
    if (!key) {
      f.error("$.header.kid", "unknown_key", `None of the keys given is ${kid}.`);
      return f.report("receipt", null);
    }
    if (!(await verifyEd25519(key.x, parsed.signingInput, parsed.signature))) {
      f.error(
        "$",
        "bad_signature",
        "The signature does not match that key: the receipt was changed, or signed by another key.",
      );
      return f.report("receipt", null);
    }
    f.passed.push("The signature verifies against the inbox's key.");
  } else {
    f.warn(
      "$",
      "signature_not_checked",
      "The signature was not checked: give the inbox's keys (its JWKS or its manifest).",
    );
  }

  const rules = opts.rules ?? RULES_V6;
  const claims = parseReceiptClaims(payload, { rules });
  const ver = payload.ver;
  const version = ver === undefined || ver === 1 ? "claims v1" : ver === 2 ? "claims v2" : null;
  if (!claims) {
    if (version === null) {
      f.error("$.payload.ver", "bad_payload", "ver is 1 (or absent) or 2.");
    } else {
      const schema = ver === 2 ? receiptPayloadV2Schema : receiptPayloadSchema;
      const r = schema.safeParse(payload);
      if (!r.success) zodFindings(f, r.error, "bad_payload", ["payload"]);
      else f.error("$.payload", "bad_payload", `A reader ${readerOf(rules)} refuses these claims.`);
    }
    return f.report("receipt", version);
  }
  f.passed.push(`The claims are well formed (${version}, as read ${readerOf(rules)}).`);

  const iss = claims.claims.iss;
  const o = httpsOrigin(iss);
  if (!o.ok) f.warn("$.payload.iss", "not_origin", `iss ${o.why}: a network finds the keys at this origin.`);
  if (opts.issuer !== undefined && iss !== opts.issuer.replace(/\/$/, "")) {
    f.error("$.payload.iss", "wrong_issuer", `Issued by ${iss}, not ${opts.issuer}.`);
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (claims.claims.iat > now + MAX_FUTURE_SECONDS) {
    f.error("$.payload.iat", "not_yet", "Dated more than five minutes ahead of the clock.");
  }
  if (f.errors.length === 0)
    f.passed.push(`Its hash, which an acknowledgement names, is ${await sha256(compact(jws))}.`);
  return f.report("receipt", version);
}

/**
 * Checks an acknowledgement, the customer's agent's compact JWS over a receipt (ADR-016): its header and the key it
 * carries, its signature, its claims, and, given them, the receipt it names (`sha`), the receipt's id (`rcp`) and
 * the time it reached the inbox.
 */
export async function checkAcknowledgement(
  jws: string,
  opts: AcknowledgementCheckOptions = {},
): Promise<ConformanceReport> {
  const f = new Findings();
  const parsed = parseJws(jws);
  if (!parsed) {
    f.error(
      "$",
      "malformed",
      "An acknowledgement is a compact JWS: three base64url parts, the first two JSON objects.",
    );
    return f.report("acknowledgement", null);
  }
  const { header, payload } = parsed;
  if (header.alg !== "EdDSA") {
    f.error("$.header.alg", "bad_alg", `An acknowledgement is signed EdDSA, not ${String(header.alg)}.`);
    return f.report("acknowledgement", null);
  }
  if (header.typ !== undefined && header.typ !== ACK_TYP) {
    f.error("$.header.typ", "bad_typ", `An acknowledgement's typ is ${ACK_TYP}.`);
    return f.report("acknowledgement", null);
  }
  const jwk = header.jwk;
  if (
    !isObject(jwk) ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !B64U43.test(jwk.x)
  ) {
    f.error("$.header.jwk", "malformed", "The header carries the agent's Ed25519 public key as jwk.");
    return f.report("acknowledgement", null);
  }
  if ("d" in jwk)
    f.error(
      "$.header.jwk.d",
      "private_key",
      "The header carries a private key. Make a new key: this one is no longer secret.",
    );
  if (!(await verifyEd25519(jwk.x, parsed.signingInput, parsed.signature))) {
    f.error("$", "bad_signature", "The signature does not match the key in the header.");
    return f.report("acknowledgement", null);
  }
  f.passed.push("The signature verifies against the key in its header.");
  if (header.typ === undefined) f.warn("$.header.typ", "no_typ", `Say what it is: typ ${ACK_TYP}.`);

  const claims = receiptAckPayloadV2Schema.safeParse(payload);
  if (!claims.success) {
    zodFindings(f, claims.error, "bad_payload", ["payload"]);
    return f.report("acknowledgement", null);
  }
  f.passed.push("Its claims are rcp, sha and iat, with pas only as a pass reference.");
  const version = claims.data.pas === undefined ? "v1" : "v1, with a pass reference";

  if (opts.receiptId !== undefined && claims.data.rcp !== opts.receiptId) {
    f.error("$.payload.rcp", "bad_payload", `It names receipt ${claims.data.rcp}, not ${opts.receiptId}.`);
  }
  if (opts.receipt !== undefined) {
    if (claims.data.sha !== (await sha256(compact(opts.receipt)))) {
      f.error("$.payload.sha", "bad_payload", "sha is not this receipt's hash: it acknowledges another receipt.");
    } else {
      f.passed.push("sha is the hash of the receipt given.");
    }
  } else {
    f.warn("$.payload.sha", "receipt_not_given", "sha was not checked: paste the receipt it acknowledges.");
  }
  if (opts.now !== undefined) {
    const now = Math.floor(opts.now / 1000);
    if (claims.data.iat > now + MAX_FUTURE_SECONDS)
      f.error("$.payload.iat", "not_yet", "Dated more than five minutes ahead.");
    else if (claims.data.iat < now - ACK_WINDOW_SECONDS)
      f.error("$.payload.iat", "expired", "More than an hour old: an inbox refuses it.");
  } else {
    f.warn("$.payload.iat", "age_not_checked", "Its age was not checked: an inbox takes one at most an hour old.");
  }
  return f.report("acknowledgement", version);
}

/* --- anything ------------------------------------------------------------------------------------------------------- */

/**
 * Reads what was pasted and checks it as what it is: a JSON object is a manifest; a compact JWS is a receipt or, by
 * its typ, an acknowledgement. `keys` (a JWKS or a manifest, as an object or as JSON text) is for a receipt's
 * signature, `receipt` for an acknowledgement's.
 */
export async function checkDocument(
  text: string,
  opts: { keys?: unknown; receipt?: string; receiptId?: string; now?: number } = {},
): Promise<ConformanceReport> {
  if (text.trim().startsWith("{")) {
    const t = text.trim();
    let doc: unknown;
    try {
      doc = JSON.parse(t);
    } catch (e) {
      const f = new Findings();
      f.error("$", "not_json", `This is not JSON: ${(e as Error).message}`);
      return f.report(null, null);
    }
    return checkManifest(doc);
  }
  // A compact JWS pasted from an email or a terminal may be broken across lines: no part of one holds a space.
  const t = compact(text);
  const parsed = parseJws(t);
  if (!parsed) {
    const f = new Findings();
    f.error("$", "unknown", "Paste a manifest (JSON), a receipt or an acknowledgement (a compact JWS: xxx.yyy.zzz).");
    return f.report(null, null);
  }
  let keys = opts.keys;
  if (typeof keys === "string") {
    try {
      keys = keys.trim() === "" ? undefined : JSON.parse(keys);
    } catch {
      const f = new Findings();
      f.error("$keys", "malformed", "The keys are not JSON: paste a JWKS or a manifest.");
      return f.report(parsed.header.typ === ACK_TYP || "jwk" in parsed.header ? "acknowledgement" : "receipt", null);
    }
  }
  if (parsed.header.typ === ACK_TYP || "jwk" in parsed.header) {
    return checkAcknowledgement(t, { receipt: opts.receipt, receiptId: opts.receiptId, now: opts.now });
  }
  return checkReceipt(t, { keys, now: opts.now });
}
