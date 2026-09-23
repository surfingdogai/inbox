import { parseCredential } from "./credentials.js";
import { type AgentKeyInput, resolveAgentKey } from "./keys.js";
import { signRequest } from "./sign.js";

/**
 * The three calls an agent that signs makes to the person's network, once, at setup (ADR-017 §2.3,
 * §7.1): ask for a sign-in code by email, trade the code for a 24-hour session, and delegate the
 * agent's key to the person's pass. After that the agent carries the pass reference instead of the
 * pass and signs its requests; the pass's secret form stops working, so a copy of it is worthless.
 */

export class NetworkCallError extends Error {
  readonly status: number;
  /** The problem document's `code`, like `not_signed_in` or `bad_code`, when there is one. */
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "NetworkCallError";
    this.status = status;
    this.code = code;
  }
}

interface CallOptions {
  /** `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch | undefined;
}

/** The network's API origin from a host (`network.surfingdog.ai`), an origin, or any string of the person's. */
export function networkUrl(network: string): string {
  const fromCredential = parseCredential(network);
  const host = fromCredential ? fromCredential.host : network.replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    throw new TypeError("network is a host like network.surfingdog.ai, its https origin, or a key or pass it issued");
  }
  return `https://${host}`;
}

/**
 * A person gave you their key: trade it once for a pass of your own (`POST /v1/passes`), keep the
 * pass, and forget the key. `label` names you in the person's list of passes, like "Travel
 * assistant". A key makes at most ten passes a day.
 */
export async function passFromKey(
  input: { readonly key: string; readonly label: string } & CallOptions,
): Promise<{ pass: string }> {
  const c = parseCredential(input.key);
  if (c?.kind !== "key") throw new TypeError("key is the person's key, sdkey1_…");
  const label = input.label.trim().slice(0, 64);
  if (!label) throw new TypeError("label names this assistant, like Travel assistant");
  const r = (await call({ ...input, network: `https://${c.host}` }, "/v1/passes", { key: input.key, label })) as {
    pass?: unknown;
  };
  if (typeof r.pass !== "string") throw new NetworkCallError(502, null, "the network's answer has no pass");
  return { pass: r.pass };
}

/**
 * Step 1: the network emails a six-digit code to the person's address, if it knows the address.
 * It always answers the same, so nothing here says whether it does.
 */
export async function requestSignInCode(
  input: { readonly network: string; readonly email: string } & CallOptions,
): Promise<void> {
  await call(input, "/v1/recovery/start", { email: input.email, purpose: "sign_in" });
}

/** Step 2: the code the person read out → a session for 24 hours. */
export async function signIn(
  input: { readonly network: string; readonly email: string; readonly code: string } & CallOptions,
): Promise<{ session: string; expires_at: string }> {
  const r = (await call(input, "/v1/recovery/finish", {
    email: input.email,
    code: input.code,
    purpose: "sign_in",
  })) as { session?: unknown; expires_at?: unknown };
  if (typeof r.session !== "string") throw new NetworkCallError(502, null, "the network's answer has no session");
  return { session: r.session, expires_at: String(r.expires_at ?? "") };
}

/**
 * Step 3: delegates your key to the person's pass (`POST /v1/delegations`, with the session and
 * signed by the key itself). Keep the returned `pass_ref`: from now on carry it, sign every
 * request, and forget the pass.
 */
export async function delegate(
  input: {
    readonly network?: string | undefined;
    readonly session: string;
    /** The pass, or its reference. */
    readonly pass: string;
    readonly key: AgentKeyInput;
    readonly now?: number | undefined;
  } & CallOptions,
): Promise<{ pass_ref: string; jkt: string; bound: boolean }> {
  const c = parseCredential(input.pass);
  if (!c || c.kind === "key") throw new TypeError("pass is the person's pass or its reference");
  if (!/^sdps_[a-z2-7]{32}$/.test(input.session)) throw new TypeError("session is sdps_… from signIn");
  const key = await resolveAgentKey(input.key);
  const base = networkUrl(input.network ?? input.pass);
  const url = `${base}/v1/delegations`;
  const body = JSON.stringify({ pass: input.pass });
  const signed = await signRequest({
    method: "POST",
    url,
    body,
    key,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.session}` },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const r = (await send(input, url, body, signed.headers)) as { pass_ref?: unknown; jkt?: unknown; bound?: unknown };
  if (typeof r.pass_ref !== "string") throw new NetworkCallError(502, null, "the network's answer has no pass_ref");
  return { pass_ref: r.pass_ref, jkt: String(r.jkt ?? key.thumbprint), bound: r.bound === true };
}

async function call(input: { readonly network: string } & CallOptions, path: string, body: unknown): Promise<unknown> {
  const url = `${networkUrl(input.network)}${path}`;
  const text = JSON.stringify(body);
  return send(input, url, text, { "Content-Type": "application/json" });
}

async function send(opts: CallOptions, url: string, body: string, headers: Record<string, string>): Promise<unknown> {
  const res = await (opts.fetch ?? fetch)(url, {
    method: "POST",
    body,
    headers: { accept: "application/json", ...headers },
    redirect: "manual",
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300) {
    const p = (parsed ?? {}) as { code?: unknown; detail?: unknown; title?: unknown };
    const code = typeof p.code === "string" ? p.code : null;
    const detail =
      typeof p.detail === "string" ? p.detail : typeof p.title === "string" ? p.title : `HTTP ${res.status}`;
    throw new NetworkCallError(res.status, code, detail);
  }
  return parsed ?? {};
}
