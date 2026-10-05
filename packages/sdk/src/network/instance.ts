import { b64u, base64, fromB64u, sha256, utf8 } from "../agent/encoding.js";
import { thumbprint } from "../agent/keys.js";
import {
  dictionaryMember,
  paramInteger,
  paramString,
  parseDictionary,
  type SfMember,
  serializeMember,
  serializeString,
} from "./sfv.js";

/**
 * `sdi-instance/1` (network protocol §3): an inbox signing its calls to a network, and a network
 * checking them. RFC 9421 HTTP Message Signatures with Ed25519, under the inbox's receipt key: the
 * `keyid` is a `kid` from the `receipt_keys` of the inbox's own manifest, and the covered
 * `Sdi-Instance` header holds the inbox's origin.
 *
 * Covered, in this order: `"@method"`, `"@authority"`, `"@path"`, `"@query"` when the URL has one,
 * `"content-digest"` when there is a body, then `"sdi-instance"`. Parameters: `created`, `expires`
 * (at most 300 s later), `keyid`, `alg="ed25519"`, `tag="sdi-instance"` and a random `nonce`.
 *
 * Both halves are pure (keys and bytes in, headers and verdicts out); the replay record a network
 * keeps, and fetching manifests, are the caller's. `packages/spec/vectors/signatures.json` holds
 * them to the inbox's and the Surfing Dog network's implementations.
 */

export const TAG_INSTANCE = "sdi-instance";
export const SIGNATURE_WINDOW_SECONDS = 300;
export const SIGNATURE_SKEW_SECONDS = 60;

/** An Ed25519 public key as a manifest publishes it under `receipt_keys`. */
export interface InstancePublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly kid?: string;
}

/** The inbox's receipt key: the private half, and the `kid` its manifest publishes it under. */
export interface InstanceSigningKey {
  readonly kid: string;
  readonly privateJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string; readonly d: string };
}

export interface SignInstanceInput {
  readonly method: string;
  /** The network's URL for the call; its host is what the signature names (`@authority`). */
  readonly url: string;
  /** The body exactly as it will be sent. A string is sent as UTF-8. */
  readonly body?: string | Uint8Array | null | undefined;
  /** The inbox's origin, `https://<domain>`: what `Sdi-Instance` carries. */
  readonly instance: string;
  readonly key: InstanceSigningKey;
  /** Headers to send that the signature need not cover (Content-Type, …). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Milliseconds since the epoch; defaults to the clock. */
  readonly now?: number | undefined;
  /** `expires − created`, 1 to 300 seconds; 300 by default. */
  readonly windowSeconds?: number | undefined;
  /** A nonce of your own; a random one by default. `null` for none (only to reproduce a vector). */
  readonly nonce?: string | null | undefined;
  readonly label?: string | undefined;
}

export interface SignedInstanceRequest {
  /** Every header to send: yours, plus Sdi-Instance, Content-Digest, Signature-Input and Signature. */
  readonly headers: Record<string, string>;
  readonly signatureInput: string;
  readonly signature: string;
  readonly signatureBase: string;
}

/**
 * Signs one call to a network. Send the returned headers with it, and the body byte for byte:
 *
 *   const signed = await signInstanceRequest({ method: "POST", url, body, instance, key });
 *   await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...signed.headers } });
 */
export async function signInstanceRequest(input: SignInstanceInput): Promise<SignedInstanceRequest> {
  const method = input.method.toUpperCase();
  const url = new URL(input.url);
  const body = bytesOf(input.body);
  const window = input.windowSeconds ?? SIGNATURE_WINDOW_SECONDS;
  if (!Number.isInteger(window) || window < 1 || window > SIGNATURE_WINDOW_SECONDS) {
    throw new RangeError(`windowSeconds is 1 to ${SIGNATURE_WINDOW_SECONDS}`);
  }
  const label = input.label ?? "sig1";
  const headers: Record<string, string> = { ...(input.headers ?? {}), "Sdi-Instance": input.instance };
  if (body.length > 0) headers["Content-Digest"] = await contentDigestOf(body);
  const components = [...derived(input.url, body), { name: "sdi-instance" }];
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const nonce = input.nonce === undefined ? b64u(crypto.getRandomValues(new Uint8Array(16))) : input.nonce;
  const signatureInput =
    `(${components.map(componentId).join(" ")})` +
    `;created=${created};expires=${created + window}` +
    `;keyid=${serializeString(input.key.kid)};alg="ed25519";tag="${TAG_INSTANCE}"` +
    (nonce === null ? "" : `;nonce=${serializeString(nonce)}`);
  const header = getter(headers);
  const signatureBase = baseOf(components, signatureInput, {
    method,
    authority: url.host,
    path: url.pathname || "/",
    query: url.search.replace(/^\?/, ""),
    header,
  });
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: input.key.privateJwk.x, d: input.key.privateJwk.d, key_ops: ["sign"], ext: true },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = base64(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(signatureBase) as BufferSource)),
  );
  headers["Signature-Input"] = `${label}=${signatureInput}`;
  headers.Signature = `${label}=:${signature}:`;
  return { headers, signatureInput, signature, signatureBase };
}

/* --- verification -------------------------------------------------------------------------- */

/** Why a signature was refused: the code a network answers with `401` (§3). */
export type InstanceSignatureCode = "bad_signature" | "expired" | "unknown_instance";

export class InstanceSignatureError extends Error {
  readonly code: InstanceSignatureCode;

  constructor(code: InstanceSignatureCode, message: string) {
    super(message);
    this.name = "InstanceSignatureError";
    this.code = code;
  }
}

export interface VerifyInstanceInput {
  readonly method: string;
  /** The URL as it arrived: its path and query are signed. */
  readonly url: string;
  readonly headers: Headers | Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | null | undefined;
  /**
   * The `@authority` values this network answers to: its own canonical host (with a port only when
   * not the default), never the request's Host header.
   */
  readonly authorities: readonly string[];
  /**
   * The receipt keys the manifest of the instance `Sdi-Instance` names publishes, as the network
   * last fetched it; null when the network does not know that instance (`unknown_instance`).
   */
  readonly keysFor: (domain: string) => Promise<readonly InstancePublicJwk[] | null>;
  /** Milliseconds; defaults to the clock. */
  readonly now?: number | undefined;
}

export interface VerifiedInstanceRequest {
  /** The instance's domain, lowercase: whose request this is. */
  readonly domain: string;
  readonly keyid: string;
  readonly created: number;
  readonly expires: number;
  readonly authority: string;
  readonly signatureBase: string;
  /** `sig:` + hex SHA-256 of the signature bytes: keep it until `replayUntil` and refuse it again. */
  readonly replayKey: string;
  /** Unix seconds: `expires` + 60. */
  readonly replayUntil: number;
}

/**
 * Checks an sdi-instance/1 signature as a network must (§3): the first signature tagged
 * `sdi-instance`, `alg` ed25519, the time window, the components it must cover, the body's digest,
 * and the signature under a receipt key of the named instance's manifest. Throws
 * `InstanceSignatureError` with the code to answer; the replay check is the caller's.
 */
export async function verifyInstanceRequest(input: VerifyInstanceInput): Promise<VerifiedInstanceRequest> {
  const header = getter(input.headers);
  const body = bytesOf(input.body);
  const { parsed, bytes } = select(header);
  if (parsed.alg !== "ed25519") throw new InstanceSignatureError("bad_signature", 'alg must be "ed25519"');
  if (!parsed.keyid) throw new InstanceSignatureError("bad_signature", "keyid is required");
  const { created, expires } = window(parsed, Math.floor((input.now ?? Date.now()) / 1000));
  const need = [...derived(input.url, body), { name: "sdi-instance" }].map(componentId);
  for (const id of need) {
    if (!parsed.components.some((c) => componentId(c) === id)) {
      throw new InstanceSignatureError("bad_signature", `the signature must cover ${id}`);
    }
  }
  if (body.length > 0 && !(await digestMatches(header, body))) {
    throw new InstanceSignatureError("bad_signature", "Content-Digest does not match the body");
  }
  const domain = instanceDomainOf(header("sdi-instance") ?? "");
  if (!domain) throw new InstanceSignatureError("unknown_instance", "Sdi-Instance must be the instance's https origin");
  const keys = await input.keysFor(domain);
  if (!keys) throw new InstanceSignatureError("unknown_instance", `${domain} is not an instance this network knows`);
  let jwk: InstancePublicJwk | undefined;
  for (const k of keys) {
    if (!isEd25519PublicJwk(k)) continue;
    if ((k.kid ?? (await thumbprint(k))) === parsed.keyid) {
      jwk = k;
      break;
    }
  }
  if (!jwk)
    throw new InstanceSignatureError(
      "bad_signature",
      "the instance's manifest publishes no receipt key with that keyid",
    );
  const url = new URL(input.url);
  const own = url.host;
  const candidates = [...new Set(input.authorities.includes(own) ? [own, ...input.authorities] : input.authorities)];
  const method = input.method.toUpperCase();
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  for (const authority of candidates.slice(0, 9)) {
    const signatureBase = baseOf(parsed.components, parsed.raw, {
      method,
      authority,
      path: url.pathname || "/",
      query: url.search.replace(/^\?/, ""),
      header,
    });
    if (
      await crypto.subtle.verify({ name: "Ed25519" }, key, bytes as BufferSource, utf8(signatureBase) as BufferSource)
    ) {
      const sum = await sha256(bytes);
      return {
        domain,
        keyid: parsed.keyid,
        created,
        expires,
        authority,
        signatureBase,
        replayKey: `sig:${[...sum].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        replayUntil: expires + SIGNATURE_SKEW_SECONDS,
      };
    }
  }
  throw new InstanceSignatureError("bad_signature", "the signature does not verify");
}

/**
 * The instance an `Sdi-Instance` header names, `https://<domain>` (port 443 and a lone "/"
 * tolerated), as its lowercase domain; null when it is not such an origin.
 */
export function instanceDomainOf(origin: string): string | null {
  const m = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?\/?$/.exec(origin.trim());
  if (!m) return null;
  const domain = (m[1] as string).toLowerCase().replace(/\.$/, "");
  return domain.includes(".") ? domain : null;
}

/** An Ed25519 public JWK: `OKP`, `Ed25519` and a 32-byte `x`. */
export function isEd25519PublicJwk(jwk: unknown): jwk is InstancePublicJwk {
  const k = jwk as { kty?: unknown; crv?: unknown; x?: unknown } | null;
  if (k?.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") return false;
  try {
    return fromB64u(k.x).length === 32;
  } catch {
    return false;
  }
}

/* --- internals ----------------------------------------------------------------------------- */

interface Component {
  readonly name: string;
  readonly key?: string;
}

interface Parsed {
  readonly label: string;
  readonly components: readonly Component[];
  readonly created?: number;
  readonly expires?: number;
  readonly keyid: string;
  readonly alg: string;
  readonly raw: string;
}

interface View {
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly header: (name: string) => string | null;
}

const COMPONENT_NAME = /^@?[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]*$/;

function componentId(c: Component): string {
  return serializeString(c.name) + (c.key === undefined ? "" : `;key=${serializeString(c.key)}`);
}

function bytesOf(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === null || body === undefined) return new Uint8Array();
  return typeof body === "string" ? utf8(body) : body;
}

async function contentDigestOf(body: Uint8Array): Promise<string> {
  return `sha-256=:${base64(await sha256(body))}:`;
}

/** RFC 9421 §2.1: a field's lines, each trimmed, joined with ", "; null when absent. */
function getter(source: Headers | Readonly<Record<string, string>>): (name: string) => string | null {
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

/** The components every signed request covers first, in order (§3). */
function derived(url: string, body: Uint8Array): Component[] {
  const out: Component[] = [{ name: "@method" }, { name: "@authority" }, { name: "@path" }];
  if (new URL(url).search.length > 1) out.push({ name: "@query" });
  if (body.length > 0) out.push({ name: "content-digest" });
  return out;
}

function componentValue(c: Component, v: View): string {
  switch (c.name) {
    case "@method":
      return v.method;
    case "@authority":
      return v.authority;
    case "@path":
      return v.path;
    case "@query":
      return `?${v.query}`;
  }
  if (c.name.startsWith("@")) throw new InstanceSignatureError("bad_signature", `unsupported component ${c.name}`);
  const value = v.header(c.name);
  if (value === null) throw new InstanceSignatureError("bad_signature", `a covered header is missing: ${c.name}`);
  if (c.key === undefined) return value;
  let dict: SfMember[];
  try {
    dict = parseDictionary(value);
  } catch {
    throw new InstanceSignatureError("bad_signature", `${c.name} is not a structured dictionary`);
  }
  const m = dictionaryMember(dict, c.key);
  if (!m) throw new InstanceSignatureError("bad_signature", `${c.name} has no member ${c.key}`);
  return serializeMember(m);
}

/** RFC 9421 §2.5: one line per component, then `"@signature-params": ` and the input as sent. */
function baseOf(components: readonly Component[], paramsRaw: string, v: View): string {
  let out = "";
  for (const c of components) {
    const value = componentValue(c, v);
    if (/[\r\n]/.test(value)) throw new InstanceSignatureError("bad_signature", "a covered value spans lines");
    out += `${componentId(c)}: ${value}\n`;
  }
  return `${out}"@signature-params": ${paramsRaw}`;
}

/** The first signature tagged sdi-instance, and its 64 bytes from `Signature`. */
function select(header: (name: string) => string | null): { parsed: Parsed; bytes: Uint8Array } {
  const rawInput = header("signature-input");
  if (rawInput === null) throw new InstanceSignatureError("bad_signature", "the request is not signed");
  let inputs: SfMember[];
  try {
    inputs = parseDictionary(rawInput);
  } catch {
    throw new InstanceSignatureError("bad_signature", "Signature-Input is not a structured dictionary");
  }
  const chosen = inputs.find((m) => m.list && paramString(m.params, "tag") === TAG_INSTANCE);
  if (!chosen?.list) throw new InstanceSignatureError("bad_signature", "no signature is tagged sdi-instance");
  const components: Component[] = [];
  const seen = new Set<string>();
  for (const it of chosen.inner) {
    if (it.bare.kind !== "string" || !COMPONENT_NAME.test(it.bare.value)) {
      throw new InstanceSignatureError("bad_signature", "a covered component is not a lowercase name");
    }
    let c: Component = { name: it.bare.value };
    for (const p of it.params) {
      if (p.key !== "key" || p.value.kind !== "string" || c.key !== undefined) {
        throw new InstanceSignatureError("bad_signature", `unsupported component parameter ${p.key}`);
      }
      c = { name: c.name, key: p.value.value };
    }
    const id = componentId(c);
    if (seen.has(id)) throw new InstanceSignatureError("bad_signature", "a component is covered twice");
    seen.add(id);
    components.push(c);
  }
  const created = paramInteger(chosen.params, "created");
  const expires = paramInteger(chosen.params, "expires");
  const parsed: Parsed = {
    label: chosen.key,
    components,
    ...(created === undefined ? {} : { created }),
    ...(expires === undefined ? {} : { expires }),
    keyid: paramString(chosen.params, "keyid") ?? "",
    alg: paramString(chosen.params, "alg") ?? "",
    raw: chosen.raw,
  };
  const rawSig = header("signature");
  if (rawSig === null) throw new InstanceSignatureError("bad_signature", "Signature-Input has no Signature");
  let sigs: SfMember[];
  try {
    sigs = parseDictionary(rawSig);
  } catch {
    throw new InstanceSignatureError("bad_signature", "Signature is not a structured dictionary");
  }
  const m = dictionaryMember(sigs, parsed.label);
  if (!m || m.list || m.item.bare.kind !== "bytes" || m.item.bare.value.length !== 64) {
    throw new InstanceSignatureError("bad_signature", `Signature has no 64-byte value for ${parsed.label}`);
  }
  return { parsed, bytes: m.item.bare.value };
}

/** §3's times: 0 < expires − created ≤ 300 s; created at most 60 s ahead; expires at most 60 s behind. */
function window(p: Parsed, now: number): { created: number; expires: number } {
  const { created, expires } = p;
  if (created === undefined || expires === undefined) {
    throw new InstanceSignatureError("bad_signature", "created and expires are required");
  }
  const d = expires - created;
  if (d <= 0 || d > SIGNATURE_WINDOW_SECONDS) {
    throw new InstanceSignatureError("bad_signature", "expires must be after created, by at most 300 seconds");
  }
  if (created > now + SIGNATURE_SKEW_SECONDS)
    throw new InstanceSignatureError("expired", "the signature is dated in the future");
  if (expires < now - SIGNATURE_SKEW_SECONDS) throw new InstanceSignatureError("expired", "the signature has expired");
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
  const sum = await sha256(body);
  const got = m.item.bare.value;
  if (got.length !== sum.length) return false;
  let diff = 0;
  for (let i = 0; i < sum.length; i++) diff |= (got[i] as number) ^ (sum[i] as number);
  return diff === 0;
}
