import { parseCredential } from "./credentials.js";
import { b64u, fromB64u, fromUtf8, sha256, utf8 } from "./encoding.js";
import { type AgentKeyInput, resolveAgentKey, signBytes, thumbprint, verifyBytes } from "./keys.js";

/**
 * Receipts, from the customer's side (ADR-016, ADR-017 §3). A business's inbox signs a receipt when
 * it makes a promise — a booking confirmed, an order accepted or paid — and another for how it
 * ended. Your agent can check one against the keys the inbox publishes (`verifyReceipt`) and
 * counter-sign it (`signAck`), which a network counts as the customer's side of the record: signed
 * by a key delegated to the person's pass, it is verified evidence.
 */

export const RECEIPT_TYP = "sdi-receipt+jws";
export const ACK_TYP = "sdi-receipt-ack+jws";
/** How far ahead of the clock a receipt's `iat` may be (a network's rule too). */
export const MAX_FUTURE_SECONDS = 300;

export type ReceiptVerificationCode =
  | "malformed"
  | "bad_alg"
  | "bad_typ"
  | "unknown_key"
  | "bad_signature"
  | "bad_payload"
  | "wrong_issuer"
  | "not_yet";

/** Every refusal is this error; `code` says which check failed, as a network would name it. */
export class ReceiptVerificationError extends Error {
  readonly code: ReceiptVerificationCode;

  constructor(code: ReceiptVerificationCode, message: string) {
    super(message);
    this.name = "ReceiptVerificationError";
    this.code = code;
  }
}

/** A key an inbox publishes: in its manifest's `receipt_keys`, and at `/.well-known/jwks.json`. */
export interface ReceiptKey {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly kid?: string;
}

/** A receipt's claims (both versions: v2 adds `ver`, `due`, `out`, `ref` and the rest). */
export interface ReceiptClaims {
  /** The issuing inbox, an https origin. */
  readonly iss: string;
  /** The customer, pseudonymously: the same for one customer at one inbox, different elsewhere. */
  readonly sub: string;
  /** The item's id at the inbox. */
  readonly itm: string;
  readonly typ: string;
  /** `confirmed`, `paid`, `accepted` (promises) or `outcome`. */
  readonly knd: string;
  readonly iat: number;
  readonly nonce: string;
  readonly amt?: { readonly value: number; readonly currency: string };
  readonly pay?: string;
  readonly ver?: 2;
  /** With an outcome: how it ended, like `booking.completed`. */
  readonly out?: string;
  /** With an outcome: the nonce of the item's first promise. */
  readonly ref?: string;
  readonly due?: number;
  readonly end?: number;
  /** 1 when the system recorded it, not a person. */
  readonly aut?: 1;
  readonly per?: readonly { readonly n: string; readonly p: string }[];
}

export interface VerifiedReceipt {
  readonly claims: ReceiptClaims;
  /** 1 or 2. */
  readonly version: 1 | 2;
  readonly kid: string;
  /** base64url(SHA-256(the JWS)): what an acknowledgement names. */
  readonly sha: string;
}

export interface VerifyReceiptOptions {
  /** The inbox you expect it from (`https://…`): anything else is `wrong_issuer`. */
  readonly issuer?: string | undefined;
  /** Milliseconds since the epoch; defaults to the clock. */
  readonly now?: number | undefined;
}

/**
 * Verifies a receipt against the keys its inbox publishes — pass the JWKS, the manifest, or the
 * keys — and returns its claims. Throws `ReceiptVerificationError` otherwise. The algorithm comes
 * from this code, never from the token: anything but EdDSA is refused.
 */
export async function verifyReceipt(
  jws: string,
  keys: readonly ReceiptKey[] | { readonly keys: readonly ReceiptKey[] } | { readonly receipt_keys: unknown },
  options: VerifyReceiptOptions = {},
): Promise<VerifiedReceipt> {
  const { header, payload, signingInput, signature } = parseJws(jws);
  if (header.alg !== "EdDSA") throw new ReceiptVerificationError("bad_alg", "a receipt is signed EdDSA");
  if (header.typ !== RECEIPT_TYP) throw new ReceiptVerificationError("bad_typ", `this is not a ${RECEIPT_TYP}`);
  const kid = typeof header.kid === "string" ? header.kid : "";
  const key = await keyFor(keyList(keys), kid);
  if (!key?.x) throw new ReceiptVerificationError("unknown_key", `no published key with kid ${kid || "(none)"}`);
  if (!(await verifyBytes({ x: key.x }, utf8(signingInput), signature))) {
    throw new ReceiptVerificationError("bad_signature", "the signature does not match that key");
  }
  const version = claimsVersion(payload);
  if (version === null)
    throw new ReceiptVerificationError("bad_payload", claimsProblem(payload) ?? "the claims do not parse");
  const claims = payload as unknown as ReceiptClaims;
  if (options.issuer !== undefined && claims.iss !== options.issuer.replace(/\/$/, "")) {
    throw new ReceiptVerificationError("wrong_issuer", `issued by ${claims.iss}, not ${options.issuer}`);
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iat > now + MAX_FUTURE_SECONDS) throw new ReceiptVerificationError("not_yet", "dated in the future");
  return { claims, version, kid, sha: await receiptSha(jws) };
}

/** base64url(SHA-256(the receipt's compact JWS, as UTF-8)), no padding: what `sha` and `ack.sha` carry. */
export async function receiptSha(receiptJws: string): Promise<string> {
  return b64u(await sha256(utf8(receiptJws)));
}

export interface SignAckInput {
  /** The receipt, its compact JWS exactly as the inbox gave it. */
  readonly receipt: string;
  /** Its id at the inbox (`receipt.id` in the item's receipts). */
  readonly receiptId: string;
  readonly key: AgentKeyInput;
  /** The person's pass reference (never the pass): names who acknowledges. */
  readonly passRef?: string | undefined;
  /** Milliseconds since the epoch; defaults to the clock. */
  readonly now?: number | undefined;
}

/**
 * Counter-signs a receipt: a compact JWS whose header carries your public key and whose payload
 * names the receipt by id and by hash — `{"rcp", "sha", "iat", "pas"?}`. Send it as
 * `counter_signature` to the inbox's acknowledge door (REST or MCP `acknowledge_receipt`).
 */
export async function signAck(input: SignAckInput): Promise<string> {
  const key = await resolveAgentKey(input.key);
  if (typeof input.receiptId !== "string" || input.receiptId.length < 1 || input.receiptId.length > 64) {
    throw new TypeError("receiptId is the receipt's id, 1 to 64 characters");
  }
  if (input.passRef !== undefined && parseCredential(input.passRef)?.kind !== "pass_ref") {
    throw new TypeError("passRef is a pass reference, sdpass1_<host>_<id>: never the pass itself");
  }
  parseJws(input.receipt);
  const header = { alg: "EdDSA", typ: ACK_TYP, jwk: { ...key.publicJwk, kid: key.thumbprint } };
  const payload = {
    rcp: input.receiptId,
    sha: await receiptSha(input.receipt),
    iat: Math.floor((input.now ?? Date.now()) / 1000),
    ...(input.passRef === undefined ? {} : { pas: input.passRef }),
  };
  const signingInput = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(payload)))}`;
  return `${signingInput}.${b64u(await signBytes(key, utf8(signingInput)))}`;
}

// ---- parsing ---------------------------------------------------------------------------------

interface ParsedJws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function parseJws(jws: string): ParsedJws {
  const parts = typeof jws === "string" ? jws.split(".") : [];
  if (parts.length !== 3) throw new ReceiptVerificationError("malformed", "a compact JWS has three parts");
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(fromUtf8(fromB64u(h))) as unknown;
    const payload = JSON.parse(fromUtf8(fromB64u(p))) as unknown;
    if (!isObject(header) || !isObject(payload)) throw new Error("not objects");
    return { header, payload, signingInput: `${h}.${p}`, signature: fromB64u(s) };
  } catch {
    throw new ReceiptVerificationError("malformed", "the header or the payload is not base64url JSON");
  }
}

function keyList(
  keys: readonly ReceiptKey[] | { readonly keys: readonly ReceiptKey[] } | { readonly receipt_keys: unknown },
): readonly ReceiptKey[] {
  if (Array.isArray(keys)) return keys;
  const k = keys as { keys?: unknown; receipt_keys?: unknown };
  const list = Array.isArray(k.keys)
    ? k.keys
    : isObject(k.receipt_keys) && Array.isArray((k.receipt_keys as { keys?: unknown }).keys)
      ? (k.receipt_keys as { keys: unknown[] }).keys
      : Array.isArray(k.receipt_keys)
        ? k.receipt_keys
        : [];
  return list.filter(isObject) as unknown as ReceiptKey[];
}

/** The key a receipt names: by `kid`, or for a published key without one, by its thumbprint. */
async function keyFor(keys: readonly ReceiptKey[], kid: string): Promise<ReceiptKey | undefined> {
  if (!kid) return undefined;
  const usable = keys.filter((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
  const named = usable.find((k) => k.kid === kid);
  if (named) return named;
  for (const k of usable) {
    if (k.kid === undefined && (await thumbprint({ kty: "OKP", crv: "Ed25519", x: k.x as string })) === kid) return k;
  }
  return undefined;
}

// ---- claims (ADR-016; ADR-017 §3.2) -----------------------------------------------------------

const ITEM_TYPES = new Set(["message", "quote_request", "booking", "order", "refund"]);
const V2_KINDS = new Set(["confirmed", "paid", "accepted", "outcome"]);
/** The eleven outcomes an inbox records, and the item type each belongs to. */
const OUTCOME_TYPES: Readonly<Record<string, "booking" | "order">> = {
  "booking.completed": "booking",
  "order.fulfilled": "order",
  "booking.cancelled_by_business": "booking",
  "order.not_fulfilled": "order",
  "booking.no_show_customer": "booking",
  "booking.cancelled_late_by_customer": "booking",
  "order.payment_failed": "order",
  "order.charged_back": "order",
  "booking.cancelled_by_customer": "booking",
  "order.cancelled_by_customer": "order",
  "order.lapsed": "order",
};
const MAX_TIME = 2 ** 37;
const HOST = /^(?:[a-z0-9-]|[a-z0-9-][a-z0-9.-]{0,251}[a-z0-9-])$/;

function claimsVersion(c: Record<string, unknown>): 1 | 2 | null {
  const problem = claimsProblem(c);
  if (problem !== null) return null;
  return c.ver === 2 ? 2 : 1;
}

/** Why a receipt's claims are refused, or null when they are well formed. */
function claimsProblem(c: Record<string, unknown>): string | null {
  const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
  const int = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  const money = (v: unknown, min: number) =>
    isObject(v) && int(v.value, min, Number.MAX_SAFE_INTEGER) && str(v.currency, 3, 3);
  if (c.ver !== undefined && c.ver !== 1 && c.ver !== 2) return "ver is 1 or 2";
  if (c.ver !== 2) {
    if (!isUrl(c.iss, false)) return "iss is a URL";
    if (!str(c.sub, 16, 64)) return "sub is 16 to 64 characters";
    if (!str(c.itm, 1, 64)) return "itm is 1 to 64 characters";
    if (typeof c.typ !== "string" || !ITEM_TYPES.has(c.typ)) return "typ is an item type";
    if (c.knd !== "confirmed" && c.knd !== "paid") return "a v1 receipt is confirmed or paid";
    if (!int(c.iat, 1)) return "iat is Unix seconds";
    if (typeof c.nonce !== "string" || !/^[0-9a-f]{32}$/.test(c.nonce)) return "nonce is 32 hex";
    if (c.amt !== undefined && !money(c.amt, Number.MIN_SAFE_INTEGER)) return "amt is {value, currency}";
    if (c.pay !== undefined && !str(c.pay, 0, 40)) return "pay is at most 40 characters";
    return null;
  }
  if (!isUrl(c.iss, true)) return "iss is an https origin";
  if (typeof c.sub !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(c.sub)) return "sub is 16 to 64 base64url";
  if (!str(c.itm, 1, 64)) return "itm is 1 to 64 characters";
  if (c.typ !== "booking" && c.typ !== "order") return "a v2 receipt is about a booking or an order";
  if (typeof c.knd !== "string" || !V2_KINDS.has(c.knd)) return "knd is confirmed, paid, accepted or outcome";
  if (!int(c.iat, 1)) return "iat is Unix seconds";
  if (typeof c.nonce !== "string" || !/^[0-9a-f]{32}$/.test(c.nonce)) return "nonce is 32 hex";
  if (c.amt !== undefined && !money(c.amt, 0)) return "amt is {value ≥ 0, currency}";
  if (c.pay !== undefined && !str(c.pay, 0, 40)) return "pay is at most 40 characters";
  if (!int(c.due, 1, MAX_TIME)) return "due is Unix seconds, at most 2^37";
  if (c.end !== undefined && !int(c.end, 1, MAX_TIME)) return "end is Unix seconds, at most 2^37";
  if (c.aut !== undefined && c.aut !== 1) return "aut is 1";
  if (c.per !== undefined) {
    if (!Array.isArray(c.per) || c.per.length > 8) return "per has at most 8 entries";
    for (const e of c.per) {
      if (!isObject(e) || typeof e.n !== "string" || !HOST.test(e.n) || e.n.length > 253)
        return "per names a network host";
      if (typeof e.p !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(e.p)) return "per names a presentation";
    }
  }
  if (c.knd === "outcome") {
    const t = typeof c.out === "string" ? OUTCOME_TYPES[c.out] : undefined;
    if (!t) return "an outcome names one of the inbox's outcomes";
    if (t !== c.typ) return `${String(c.out)} is not an outcome of a ${c.typ}`;
    if (typeof c.ref !== "string" || !/^[0-9a-f]{32}$/.test(c.ref)) return "an outcome names its promise's nonce";
  } else {
    if (c.out !== undefined) return "out belongs to an outcome";
    if (c.ref !== undefined) return "ref belongs to an outcome";
  }
  if (c.end !== undefined) {
    if (c.typ !== "booking") return "end is a booking's end";
    if ((c.end as number) < (c.due as number)) return "end must not be before due";
  }
  return null;
}

function isUrl(v: unknown, httpsOnly: boolean): boolean {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return httpsOnly ? u.protocol === "https:" : true;
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
