import type { PrivateJwk, PublicJwk } from "../receipts/sign";
import { b64u, thumbprint, unb64u } from "../receipts/sign";
import {
  dictionaryMember,
  paramInteger,
  paramString,
  parseDictionary,
  parseInnerList,
  parseItem,
  parseList,
  type SfMember,
  serializeMember,
  serializeString,
} from "./sfv";

/**
 * Signed requests (ADR-017 §2.4): RFC 9421 HTTP Message Signatures with Ed25519, in two profiles.
 *
 *   sdi-instance/1  an inbox calling a network. `keyid` is a `kid` from the `receipt_keys` of the
 *                   inbox's own manifest; the covered `Sdi-Instance` header holds its origin.
 *   sdi-agent/1     a customer's agent calling an inbox (or a network, to delegate its key). Tagged
 *                   `sdi-agent` with the key in `Sdi-Agent-Key`, or `web-bot-auth` with a platform
 *                   directory named by `Signature-Agent` (Web Bot Auth).
 *
 * Both cover `"@method"`, `"@authority"`, `"@path"`, `"@query"` when there is one, and
 * `"content-digest"` (RFC 9530, sha-256) when there is a body; `created` and `expires` bound the
 * signature to at most 300 s, with 60 s of clock skew either way.
 *
 * Ed25519 is deterministic: two identical requests in the same second would carry the same
 * signature, and a network refuses the second as a replay. Every signature made here therefore has
 * a random `nonce` parameter, which verification ignores but which changes the signature base.
 *
 * Signing and verification are pure (keys and bytes in, headers and verdicts out) and run
 * unchanged on Node and in a Worker; replay records, directory fetches and limits belong to the
 * caller. `packages/spec/vectors/signatures.json` holds this code and the network's to each other.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;
export const SIGNATURE_SKEW_SECONDS = 60;
export const TAG_INSTANCE = "sdi-instance";
export const TAG_AGENT = "sdi-agent";
export const TAG_WEB_BOT_AUTH = "web-bot-auth";
export const DEFAULT_SIGNATURE_LABEL = "sig1";
/** Where a platform publishes its agents' keys (Web Bot Auth), under the origin `Signature-Agent` names. */
export const SIGNATURE_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ED25519 = { name: "Ed25519" } as const;

/** One covered component: a name, and for a dictionary header the member it selects (`;key="…"`). */
export interface SignatureComponent {
  readonly name: string;
  readonly key?: string;
}

/** The component's identifier as it appears in a signature base and in `Signature-Input`. */
export function componentId(c: SignatureComponent): string {
  return serializeString(c.name) + (c.key === undefined ? "" : `;key=${serializeString(c.key)}`);
}

export type HeaderSource = Headers | Readonly<Record<string, string>>;

/** RFC 9421 §2.1: a field's lines, each trimmed, joined with ", "; null when absent. */
function headerGetter(source: HeaderSource): (name: string) => string | null {
  if (typeof (source as Headers).get === "function") {
    const h = source as Headers;
    return (name) => h.get(name);
  }
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(source as Record<string, string>)) {
    const key = k.toLowerCase();
    const trimmed = v.replace(/^[ \t]+|[ \t]+$/g, "");
    lower.set(key, lower.has(key) ? `${lower.get(key)}, ${trimmed}` : trimmed);
  }
  return (name) => lower.get(name.toLowerCase()) ?? null;
}

function bodyBytes(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === null || body === undefined) return new Uint8Array();
  return typeof body === "string" ? encoder.encode(body) : body;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** RFC 9530 with sha-256, the only algorithm the profiles use: `sha-256=:<base64>:`. */
export async function contentDigest(body: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes(body) as BufferSource);
  return `sha-256=:${base64(new Uint8Array(digest))}:`;
}

/** The derived components of a request, from its URL. `@authority` is supplied, never read off a Host header. */
interface RequestView {
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  /** Without the leading "?"; "" when there is none. */
  readonly query: string;
  readonly header: (name: string) => string | null;
}

function viewOf(method: string, url: string, authority: string, header: (name: string) => string | null): RequestView {
  const u = new URL(url);
  return { method, authority, path: u.pathname || "/", query: u.search.replace(/^\?/, ""), header };
}

function componentValue(c: SignatureComponent, req: RequestView): string {
  switch (c.name) {
    case "@method":
      return req.method;
    case "@authority":
      return req.authority;
    case "@path":
      return req.path;
    case "@query":
      return `?${req.query}`;
  }
  if (c.name.startsWith("@")) throw new SignatureFailure("bad_signature", `unsupported derived component ${c.name}`);
  const value = req.header(c.name);
  if (value === null) throw new SignatureFailure("bad_signature", `a covered header is missing: ${c.name}`);
  if (c.key === undefined) return value;
  let dict: SfMember[];
  try {
    dict = parseDictionary(value);
  } catch {
    throw new SignatureFailure("bad_signature", `${c.name} is not a structured dictionary`);
  }
  const m = dictionaryMember(dict, c.key);
  if (!m) throw new SignatureFailure("bad_signature", `${c.name} has no member ${c.key}`);
  return serializeMember(m);
}

/** RFC 9421 §2.5: one line per component, then `"@signature-params": ` and the input exactly as sent. */
function buildBase(components: readonly SignatureComponent[], paramsRaw: string, req: RequestView): string {
  let out = "";
  for (const c of components) {
    const v = componentValue(c, req);
    if (/[\r\n]/.test(v)) throw new SignatureFailure("bad_signature", "a covered value spans lines");
    out += `${componentId(c)}: ${v}\n`;
  }
  return `${out}"@signature-params": ${paramsRaw}`;
}

/** The components §2.4 requires of any signed request, in the order they are signed. */
function derivedComponents(url: string, body: Uint8Array): SignatureComponent[] {
  const out: SignatureComponent[] = [{ name: "@method" }, { name: "@authority" }, { name: "@path" }];
  if (new URL(url).search.length > 1) out.push({ name: "@query" });
  if (body.length > 0) out.push({ name: "content-digest" });
  return out;
}

/** A random `nonce`: 16 bytes, base64url. */
export function signatureNonce(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(16)));
}

/* --- signing ------------------------------------------------------------------------------- */

export interface SignRequestInput {
  readonly method: string;
  /** The full URL the request goes to; its host (lowercase, port only when not the default) is `@authority`. */
  readonly url: string;
  readonly body?: string | Uint8Array | null;
  /** Headers sent with the request that the signature must see, such as `Sdi-Instance`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Components covered after the derived ones, in this order (header names lowercase). */
  readonly covered?: readonly SignatureComponent[];
  readonly keyid: string;
  readonly privateJwk: PrivateJwk;
  readonly tag: string;
  /** Unix seconds. */
  readonly created: number;
  readonly expires: number;
  /** Omitted: a random one. Pass `null` for none (only to reproduce a signature made without one). */
  readonly nonce?: string | null;
  readonly label?: string;
}

export interface SignedRequest {
  /** Every header to send: the ones given, plus `Content-Digest` (with a body), `Signature-Input` and `Signature`. */
  readonly headers: Record<string, string>;
  readonly label: string;
  /** The inner list with its parameters, as it appears in `Signature-Input` after `<label>=`. */
  readonly signatureInput: string;
  /** Standard base64 of the 64 signature bytes, as it appears between the colons of `Signature`. */
  readonly signature: string;
  readonly signatureBase: string;
}

export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  const method = input.method.toUpperCase();
  const body = bodyBytes(input.body);
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (body.length > 0) headers["Content-Digest"] = await contentDigest(body);
  const components = [...derivedComponents(input.url, body), ...(input.covered ?? [])];
  const nonce = input.nonce === undefined ? signatureNonce() : input.nonce;
  const signatureInput =
    `(${components.map(componentId).join(" ")})` +
    `;created=${input.created};expires=${input.expires}` +
    `;keyid=${serializeString(input.keyid)};alg="ed25519";tag=${serializeString(input.tag)}` +
    (nonce === null ? "" : `;nonce=${serializeString(nonce)}`);
  const url = new URL(input.url);
  const signatureBase = buildBase(
    components,
    signatureInput,
    viewOf(method, input.url, url.host, headerGetter(headers)),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: input.privateJwk.x, d: input.privateJwk.d, key_ops: ["sign"], ext: true },
    ED25519,
    false,
    ["sign"],
  );
  const signature = base64(
    new Uint8Array(await crypto.subtle.sign(ED25519, key, encoder.encode(signatureBase) as BufferSource)),
  );
  const label = input.label ?? DEFAULT_SIGNATURE_LABEL;
  headers["Signature-Input"] = `${label}=${signatureInput}`;
  headers.Signature = `${label}=:${signature}:`;
  return { headers, label, signatureInput, signature, signatureBase };
}

/** The instance's receipt key, as `createKeyStore(...).active()` returns it. */
export interface InstanceSigningKey {
  readonly kid: string;
  readonly privateJwk: PrivateJwk;
}

export interface SignInstanceInput {
  readonly method: string;
  readonly url: string;
  readonly body?: string | Uint8Array | null;
  /** This inbox's origin, `https://<domain>`: what `Sdi-Instance` carries. */
  readonly instance: string;
  readonly key: InstanceSigningKey;
  /** Milliseconds; defaults to the clock. */
  readonly now?: number;
  /** `expires − created`, at most 300 (the default). */
  readonly windowSeconds?: number;
  readonly nonce?: string | null;
  readonly label?: string;
}

/**
 * sdi-instance/1: an inbox's request to a network, signed with its receipt key. The returned
 * headers go on the request as they are (add `Content-Type` beside them); the body must be sent
 * byte for byte as signed.
 */
export async function signInstanceRequest(input: SignInstanceInput): Promise<SignedRequest> {
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const window = Math.min(Math.max(1, input.windowSeconds ?? SIGNATURE_WINDOW_SECONDS), SIGNATURE_WINDOW_SECONDS);
  return signRequest({
    method: input.method,
    url: input.url,
    body: input.body ?? null,
    headers: { "Sdi-Instance": input.instance },
    covered: [{ name: "sdi-instance" }],
    keyid: input.key.kid,
    privateJwk: input.key.privateJwk,
    tag: TAG_INSTANCE,
    created,
    expires: created + window,
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    ...(input.label === undefined ? {} : { label: input.label }),
  });
}

/* --- verification -------------------------------------------------------------------------- */

/** Why a signature did not verify: `Sdi-Signature: invalid; reason="<code>"`, or a network's 401 code. */
export type SignatureFailureCode = "bad_signature" | "expired" | "unknown_key" | "unknown_instance";

export class SignatureFailure extends Error {
  constructor(
    readonly code: SignatureFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SignatureFailure";
  }
}

/** A signature's parameters, as read from `Signature-Input`. */
export interface ParsedSignatureInput {
  readonly label: string;
  readonly components: readonly SignatureComponent[];
  readonly created?: number;
  readonly expires?: number;
  readonly keyid: string;
  readonly alg: string;
  readonly tag: string;
  /** The inner list and its parameters exactly as received. */
  readonly raw: string;
}

const COMPONENT_NAME = /^@?[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]*$/;

function inputFrom(label: string, m: SfMember): ParsedSignatureInput {
  if (!m.list) throw new SignatureFailure("bad_signature", "a signature's input is an inner list");
  const components: SignatureComponent[] = [];
  const seen = new Set<string>();
  for (const it of m.inner) {
    if (it.bare.kind !== "string" || !COMPONENT_NAME.test(it.bare.value)) {
      throw new SignatureFailure("bad_signature", "a covered component is not a lowercase name");
    }
    let c: SignatureComponent = { name: it.bare.value };
    for (const p of it.params) {
      if (p.key !== "key" || p.value.kind !== "string" || c.key !== undefined) {
        throw new SignatureFailure("bad_signature", `unsupported component parameter ${p.key}`);
      }
      c = { name: c.name, key: p.value.value };
    }
    const id = componentId(c);
    if (seen.has(id)) throw new SignatureFailure("bad_signature", "a component is covered twice");
    seen.add(id);
    components.push(c);
  }
  const created = paramInteger(m.params, "created");
  const expires = paramInteger(m.params, "expires");
  return {
    label,
    components,
    ...(created === undefined ? {} : { created }),
    ...(expires === undefined ? {} : { expires }),
    keyid: paramString(m.params, "keyid") ?? "",
    alg: paramString(m.params, "alg") ?? "",
    tag: paramString(m.params, "tag") ?? "",
    raw: m.raw,
  };
}

const covers = (input: ParsedSignatureInput, id: string) => input.components.some((c) => componentId(c) === id);

/** The first signature tagged with one of `tags`, and its bytes and raw text from `Signature`. */
function selectSignature(
  header: (name: string) => string | null,
  tags: readonly string[],
): { input: ParsedSignatureInput; bytes: Uint8Array; text: string } {
  const rawInput = header("signature-input");
  if (rawInput === null) throw new SignatureFailure("bad_signature", "the request is not signed");
  let inputs: SfMember[];
  try {
    inputs = parseDictionary(rawInput);
  } catch {
    throw new SignatureFailure("bad_signature", "Signature-Input is not a structured dictionary");
  }
  const chosen = inputs.find((m) => m.list && tags.includes(paramString(m.params, "tag") ?? ""));
  if (!chosen) throw new SignatureFailure("bad_signature", `no signature is tagged ${tags.join(" or ")}`);
  const input = inputFrom(chosen.key, chosen);
  const rawSig = header("signature");
  if (rawSig === null) throw new SignatureFailure("bad_signature", "Signature-Input has no Signature");
  let sigs: SfMember[];
  try {
    sigs = parseDictionary(rawSig);
  } catch {
    throw new SignatureFailure("bad_signature", "Signature is not a structured dictionary");
  }
  const m = dictionaryMember(sigs, input.label);
  if (!m || m.list || m.item.bare.kind !== "bytes" || m.item.bare.value.length !== 64) {
    throw new SignatureFailure("bad_signature", `Signature has no 64-byte value for ${input.label}`);
  }
  const text = m.raw.slice(1, m.raw.indexOf(":", 1));
  return { input, bytes: m.item.bare.value, text };
}

/** §2.4's times: 0 < expires − created ≤ 300 s; created at most 60 s ahead; expires at most 60 s behind. */
function checkWindow(input: ParsedSignatureInput, nowSeconds: number): { created: number; expires: number } {
  const { created, expires } = input;
  if (created === undefined || expires === undefined) {
    throw new SignatureFailure("bad_signature", "created and expires are required");
  }
  const d = expires - created;
  if (d <= 0 || d > SIGNATURE_WINDOW_SECONDS) {
    throw new SignatureFailure("bad_signature", "expires must be after created, by at most 300 seconds");
  }
  if (created > nowSeconds + SIGNATURE_SKEW_SECONDS) {
    throw new SignatureFailure("expired", "the signature is dated in the future");
  }
  if (expires < nowSeconds - SIGNATURE_SKEW_SECONDS) throw new SignatureFailure("expired", "the signature has expired");
  return { created, expires };
}

async function digestMatches(header: (name: string) => string | null, body: Uint8Array): Promise<boolean> {
  const v = header("content-digest");
  if (v === null) return false;
  let dict: SfMember[];
  try {
    dict = parseDictionary(v);
  } catch {
    return false;
  }
  const m = dictionaryMember(dict, "sha-256");
  if (!m || m.list || m.item.bare.kind !== "bytes") return false;
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  const got = m.item.bare.value;
  if (got.length !== sum.length) return false;
  let diff = 0;
  for (let i = 0; i < sum.length; i++) diff |= (got[i] as number) ^ (sum[i] as number);
  return diff === 0;
}

/** An Ed25519 public JWK: `OKP`, `Ed25519` and a 32-byte `x`. */
export function isEd25519PublicJwk(jwk: unknown): jwk is PublicJwk {
  const k = jwk as { kty?: unknown; crv?: unknown; x?: unknown } | null;
  if (k?.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string" || !/^[A-Za-z0-9_-]+$/.test(k.x)) {
    return false;
  }
  try {
    return unb64u(k.x).length === 32;
  } catch {
    return false;
  }
}

async function ed25519Verify(jwk: PublicJwk, message: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true },
    ED25519,
    false,
    ["verify"],
  );
  return crypto.subtle.verify(ED25519, key, signature as BufferSource, encoder.encode(message) as BufferSource);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifyRequestInput {
  readonly method: string;
  /** The URL as it arrived: its path and query are signed. */
  readonly url: string;
  readonly headers: HeaderSource;
  readonly body?: string | Uint8Array | null;
  /** The `@authority` values this receiver answers to (host, with a port only when not the default). */
  readonly authorities: readonly string[];
  /** Milliseconds. */
  readonly now: number;
}

/** A signature that verified: everything a receiver needs to act on it, record it once and forward it. */
export interface VerifiedSignature {
  readonly tag: string;
  readonly label: string;
  readonly keyid: string;
  readonly jwk: PublicJwk;
  /** The `@authority` it was made for, one of the receiver's. */
  readonly authority: string;
  readonly created: number;
  readonly expires: number;
  readonly components: readonly SignatureComponent[];
  /** The inner list with parameters exactly as received (`signature_input` when forwarded). */
  readonly signatureInput: string;
  /** The base64 between the colons of `Signature`, as received (`signature` when forwarded). */
  readonly signature: string;
  /** The signature base that verified (`signature_base` when forwarded). */
  readonly signatureBase: string;
  /** `sig:` + hex SHA-256 of the signature bytes: the record that makes it single-use. */
  readonly replayKey: string;
  /** Unix seconds until which the replay record must be kept: `expires` + 60. */
  readonly replayUntil: number;
}

interface Profile {
  readonly tags: readonly string[];
  /** Checks `keyid`'s form. */
  readonly keyid: (keyid: string) => void;
  /** Components required beyond the derived ones. */
  readonly required: (input: ParsedSignatureInput, header: (name: string) => string | null) => string[];
  /** The key the signature must verify under. */
  readonly key: (input: ParsedSignatureInput, header: (name: string) => string | null) => Promise<PublicJwk>;
}

async function verifyWith(req: VerifyRequestInput, profile: Profile): Promise<VerifiedSignature> {
  const header = headerGetter(req.headers);
  const body = bodyBytes(req.body);
  const { input, bytes, text } = selectSignature(header, profile.tags);
  if (input.alg !== "ed25519") throw new SignatureFailure("bad_signature", 'alg must be "ed25519"');
  profile.keyid(input.keyid);
  const { created, expires } = checkWindow(input, Math.floor(req.now / 1000));
  const need = [...derivedComponents(req.url, body).map(componentId), ...profile.required(input, header)];
  for (const id of need) {
    if (!covers(input, id)) throw new SignatureFailure("bad_signature", `the signature must cover ${id}`);
  }
  if (body.length > 0 && !(await digestMatches(header, body))) {
    throw new SignatureFailure("bad_signature", "Content-Digest does not match the body");
  }
  const jwk = await profile.key(input, header);
  const method = req.method.toUpperCase();
  const own = new URL(req.url).host;
  const candidates = [...new Set(req.authorities.includes(own) ? [own, ...req.authorities] : req.authorities)].slice(
    0,
    9,
  );
  for (const authority of candidates) {
    const base = buildBase(input.components, input.raw, viewOf(method, req.url, authority, header));
    if (await ed25519Verify(jwk, base, bytes)) {
      return {
        tag: input.tag,
        label: input.label,
        keyid: input.keyid,
        jwk,
        authority,
        created,
        expires,
        components: input.components,
        signatureInput: input.raw,
        signature: text,
        signatureBase: base,
        replayKey: `sig:${await sha256Hex(bytes)}`,
        replayUntil: expires + SIGNATURE_SKEW_SECONDS,
      };
    }
  }
  throw new SignatureFailure("bad_signature", "the signature does not verify");
}

/* --- sdi-agent/1 ---------------------------------------------------------------------------- */

/** A key published by a platform's directory, or null when the directory does not list it (or cannot be read). */
export type PlatformKeyResolver = (platformOrigin: string, keyid: string) => Promise<PublicJwk | null>;

export interface VerifyAgentInput extends VerifyRequestInput {
  /** Looks `keyid` up in the directory of the platform `Signature-Agent` names; without it, `web-bot-auth` never verifies. */
  readonly platformKey?: PlatformKeyResolver;
}

export type AgentVerification =
  | { readonly status: "none" }
  | { readonly status: "invalid"; readonly code: SignatureFailureCode; readonly message: string }
  | ({
      readonly status: "verified";
      /** `vouched`: a platform's directory lists the key (Web Bot Auth); `self`: the agent's own key. */
      readonly level: "vouched" | "self";
      /** The platform's origin, for `vouched`. */
      readonly platform?: string;
      /** Whether `Sdi-Pass` was sent (and so is covered). */
      readonly coversPass: boolean;
    } & VerifiedSignature);

/**
 * The key in `Sdi-Agent-Key` under `label`: the standard base64 of a JSON JWK with exactly `kty`
 * `"OKP"`, `crv` `"Ed25519"` and `x`. Anything more — a private `d` above all — is refused.
 */
export function selfHeldKey(field: string | null, label: string): PublicJwk {
  if (field === null) throw new SignatureFailure("bad_signature", "Sdi-Agent-Key is missing");
  let dict: SfMember[];
  try {
    dict = parseDictionary(field);
  } catch {
    throw new SignatureFailure("bad_signature", "Sdi-Agent-Key is not a structured dictionary");
  }
  const m = dictionaryMember(dict, label);
  if (!m || m.list || m.item.bare.kind !== "bytes") {
    throw new SignatureFailure("bad_signature", `Sdi-Agent-Key has no key for ${label}`);
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(decoder.decode(m.item.bare.value)) as Record<string, unknown>;
  } catch {
    throw new SignatureFailure("bad_signature", "the agent key must be a JWK with exactly kty, crv and x");
  }
  const names = fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields) : [];
  if (names.length !== 3 || !["kty", "crv", "x"].every((n) => names.includes(n))) {
    throw new SignatureFailure("bad_signature", "the agent key must be a JWK with exactly kty, crv and x");
  }
  if (!names.every((n) => typeof fields[n] === "string")) {
    throw new SignatureFailure("bad_signature", "the agent key's members must be strings");
  }
  const jwk = { kty: fields.kty, crv: fields.crv, x: fields.x };
  if (!isEd25519PublicJwk(jwk))
    throw new SignatureFailure("bad_signature", "the agent key is not an Ed25519 public key");
  return jwk;
}

/**
 * The platform origin `Signature-Agent` names for a label: the dictionary member (`sig1="https://…"`),
 * or the legacy form, one string for the whole field. `covered` is the component that must be signed.
 */
export function signatureAgent(
  field: string | null,
  label: string,
): { readonly origin: string; readonly covered: SignatureComponent } {
  if (field === null) throw new SignatureFailure("bad_signature", "Signature-Agent is missing");
  let origin: string | undefined;
  let covered: SignatureComponent;
  try {
    const m = dictionaryMember(parseDictionary(field), label);
    if (m && !m.list && m.item.bare.kind === "string") origin = m.item.bare.value;
    covered = { name: "signature-agent", key: label };
  } catch {
    const item = parseItemOrNull(field);
    if (item?.bare.kind === "string") origin = item.bare.value;
    covered = { name: "signature-agent" };
  }
  if (origin === undefined)
    throw new SignatureFailure("bad_signature", `Signature-Agent names no platform for ${label}`);
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new SignatureFailure("bad_signature", "Signature-Agent must be an https origin");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname)) {
    throw new SignatureFailure("bad_signature", "Signature-Agent must be an https origin");
  }
  return { origin: u.origin, covered };
}

function parseItemOrNull(field: string) {
  try {
    return parseItem(field);
  } catch {
    return null;
  }
}

/** `Sdi-Pass`: an SF List of at most 8 strings of at most 200 characters; null when malformed. */
export function parsePassHeader(field: string): string[] | null {
  let list: SfMember[];
  try {
    list = parseList(field);
  } catch {
    return null;
  }
  if (list.length === 0 || list.length > 8) return null;
  const out: string[] = [];
  for (const m of list) {
    if (m.list || m.item.bare.kind !== "string" || m.item.bare.value.length > 200) return null;
    out.push(m.item.bare.value);
  }
  return out;
}

/** Whether a base's `"sdi-pass"` line (an SF List of strings) carries `ref`. */
function signedPassesName(lines: readonly string[], ref: string): boolean {
  const prefix = '"sdi-pass": ';
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    let list: SfMember[];
    try {
      list = parseList(line.slice(prefix.length));
    } catch {
      return false;
    }
    if (list.some((m) => !m.list && m.item.bare.kind === "string" && m.item.bare.value === ref)) return true;
  }
  return false;
}

/** `Sdi-Pass` as a sender writes it. */
export function formatPassHeader(passes: readonly string[]): string {
  return passes.map(serializeString).join(", ");
}

/**
 * sdi-agent/1 at a receiver (an inbox, or a network's delegation endpoint). An unsigned request is
 * `none`; a signature that fails is `invalid` with its reason, and the request then proceeds as
 * unsigned (§2.5) — only a replay, which the caller detects from `replayKey`, is refused.
 */
export async function verifyAgentRequest(req: VerifyAgentInput): Promise<AgentVerification> {
  const header = headerGetter(req.headers);
  if (header("signature-input") === null) return { status: "none" };
  let platform: string | undefined;
  const coversPass = header("sdi-pass") !== null;
  try {
    const verified = await verifyWith(req, {
      tags: [TAG_WEB_BOT_AUTH, TAG_AGENT],
      keyid: (keyid) => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(keyid)) {
          throw new SignatureFailure("bad_signature", "keyid must be the key's RFC 7638 thumbprint");
        }
      },
      required: (input, h) => {
        const extra =
          input.tag === TAG_AGENT
            ? [componentId({ name: "sdi-agent-key", key: input.label })]
            : [componentId(signatureAgent(h("signature-agent"), input.label).covered)];
        if (coversPass) extra.push(componentId({ name: "sdi-pass" }));
        return extra;
      },
      key: async (input, h) => {
        if (input.tag === TAG_AGENT) {
          const jwk = selfHeldKey(h("sdi-agent-key"), input.label);
          if ((await thumbprint(jwk)) !== input.keyid) {
            throw new SignatureFailure("bad_signature", "keyid is not the thumbprint of the key in Sdi-Agent-Key");
          }
          return jwk;
        }
        const { origin } = signatureAgent(h("signature-agent"), input.label);
        const jwk = req.platformKey ? await req.platformKey(origin, input.keyid) : null;
        if (!jwk || !isEd25519PublicJwk(jwk) || (await thumbprint(jwk)) !== input.keyid) {
          throw new SignatureFailure("unknown_key", `the directory of ${origin} does not list this keyid`);
        }
        platform = origin;
        return { kty: "OKP", crv: "Ed25519", x: jwk.x };
      },
    });
    return {
      status: "verified",
      level: verified.tag === TAG_WEB_BOT_AUTH ? "vouched" : "self",
      ...(platform === undefined ? {} : { platform }),
      coversPass,
      ...verified,
    };
  } catch (e) {
    if (e instanceof SignatureFailure) return { status: "invalid", code: e.code, message: e.message };
    throw e;
  }
}

/* --- sdi-instance/1, for a receiver ---------------------------------------------------------- */

/**
 * The instance an `Sdi-Instance` header names: `https://<domain>` (port 443 and a lone "/" tolerated),
 * returned as its lowercase domain; null when it is not an origin.
 */
export function instanceDomainOf(origin: string): string | null {
  const m = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?\/?$/.exec(origin.trim());
  if (!m) return null;
  const domain = (m[1] as string).toLowerCase().replace(/\.$/, "");
  return domain.includes(".") ? domain : null;
}

export interface VerifyInstanceInput extends VerifyRequestInput {
  /** The receipt keys the instance's manifest publishes, for the domain `Sdi-Instance` names. */
  readonly keysFor: (domain: string) => Promise<readonly PublicJwk[] | null>;
}

/**
 * sdi-instance/1 as a network checks it. The inbox only signs; this exists so that the vectors are
 * checked in both directions in this repository, and for anyone building a network in TypeScript.
 */
export async function verifyInstanceRequest(
  req: VerifyInstanceInput,
): Promise<VerifiedSignature & { readonly domain: string }> {
  let domain = "";
  const verified = await verifyWith(req, {
    tags: [TAG_INSTANCE],
    keyid: (keyid) => {
      if (!keyid) throw new SignatureFailure("bad_signature", "keyid is required");
    },
    required: () => [componentId({ name: "sdi-instance" })],
    key: async (input, h) => {
      const named = instanceDomainOf(h("sdi-instance") ?? "");
      if (!named) throw new SignatureFailure("unknown_instance", "Sdi-Instance must be the instance's https origin");
      const keys = await req.keysFor(named);
      if (!keys) throw new SignatureFailure("unknown_instance", `${named} is not a listed instance of this network`);
      for (const k of keys) {
        if (!isEd25519PublicJwk(k)) continue;
        if ((k.kid ?? (await thumbprint(k))) === input.keyid) {
          domain = named;
          return k;
        }
      }
      throw new SignatureFailure("bad_signature", "the instance's manifest publishes no receipt key with that keyid");
    },
  });
  return { ...verified, domain };
}

/* --- forwarded signatures (agent_key, §7.2) --------------------------------------------------- */

/** What an inbox forwards to a network after verifying an agent's signature (§7.2). */
export interface AgentKey {
  readonly jkt: string;
  readonly pass_ref: string;
  readonly label: string;
  readonly signature_input: string;
  readonly signature: string;
  readonly signature_base: string;
}

export function agentKeyOf(sig: VerifiedSignature, passRef: string): AgentKey {
  return {
    jkt: sig.keyid,
    pass_ref: passRef,
    label: sig.label,
    signature_input: sig.signatureInput,
    signature: sig.signature,
    signature_base: sig.signatureBase,
  };
}

/**
 * A forwarded signature as a network checks it (§7.2): the base ends with `"@signature-params": `
 * + `signature_input`; every line is the component `signature_input` names, in order; `@method`,
 * `@authority` and `@path` are covered and `@authority` is the presenting instance; it was created
 * within the last 300 s and has not expired; a covered `sdi-pass` carries `pass_ref`; and it verifies
 * under `x`. Returns the replay record's key and expiry.
 */
export async function verifyForwardedSignature(
  ak: AgentKey,
  x: string,
  instanceDomain: string,
  now: number,
): Promise<{ readonly replayKey: string; readonly replayUntil: number }> {
  const bad = (msg: string) => new SignatureFailure("bad_signature", msg);
  if (
    !/^[a-z*][a-z0-9_.*-]{0,63}$/.test(ak.label) ||
    ak.signature_input.length > 4096 ||
    ak.signature_base.length > 16384
  ) {
    throw bad("label, signature_input or signature_base is malformed");
  }
  let m: SfMember;
  try {
    m = parseInnerList(ak.signature_input);
  } catch {
    throw bad("signature_input is not an inner list with parameters");
  }
  const input = inputFrom(ak.label, m);
  if (input.tag !== TAG_AGENT && input.tag !== TAG_WEB_BOT_AUTH) {
    throw bad('the signature is not tagged "sdi-agent" or "web-bot-auth"');
  }
  if (input.alg !== "ed25519" || input.keyid !== ak.jkt) {
    throw bad("the signature's alg or keyid does not name the delegated key");
  }
  const t = Math.floor(now / 1000);
  if (
    input.created === undefined ||
    input.created < t - SIGNATURE_WINDOW_SECONDS ||
    input.created > t + SIGNATURE_SKEW_SECONDS
  ) {
    throw bad("the signature was not created within the last 300 seconds");
  }
  if (
    input.expires !== undefined &&
    (input.expires <= input.created || input.expires - input.created > SIGNATURE_WINDOW_SECONDS)
  ) {
    throw bad("expires must be after created, by at most 300 seconds");
  }
  if (input.expires !== undefined && input.expires < t - SIGNATURE_SKEW_SECONDS) throw bad("the signature has expired");
  const lines = ak.signature_base.split("\n");
  if (
    lines.length !== input.components.length + 1 ||
    lines[lines.length - 1] !== `"@signature-params": ${ak.signature_input}`
  ) {
    throw bad("signature_base does not end with the line signature_input names");
  }
  let authority = "";
  input.components.forEach((c, i) => {
    const prefix = `${componentId(c)}: `;
    const line = lines[i] as string;
    if (!line.startsWith(prefix)) throw bad("signature_base does not follow signature_input");
    if (c.name === "@authority" && c.key === undefined) authority = line.slice(prefix.length);
  });
  for (const id of ['"@method"', '"@authority"', '"@path"']) {
    if (!covers(input, id)) throw bad(`the signature must cover ${id}`);
  }
  if (authority !== instanceDomain)
    throw bad("the signature was made for another authority than the presenting instance");
  if (covers(input, '"sdi-pass"') && !signedPassesName(lines, ak.pass_ref)) {
    throw bad("the signed Sdi-Pass does not carry this pass reference");
  }
  let sig: Uint8Array;
  try {
    const bare = ak.signature.replace(/=+$/, "");
    const binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
    sig = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    throw bad("signature is not 64 bytes of base64");
  }
  if (sig.length !== 64) throw bad("signature is not 64 bytes of base64");
  if (!(await ed25519Verify({ kty: "OKP", crv: "Ed25519", x }, ak.signature_base, sig))) {
    throw bad("the forwarded signature does not verify under the delegated key");
  }
  return {
    replayKey: `sig:${await sha256Hex(sig)}`,
    replayUntil: input.created + SIGNATURE_WINDOW_SECONDS + SIGNATURE_SKEW_SECONDS,
  };
}
