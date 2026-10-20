import { type InstanceSigningKey, signInstanceRequest } from "../protocol/httpsig";
import { b64uEncode } from "./crypto";

/**
 * The inbox's side of the push relay (ADR-026, docs/protocol/push-relay.md). The relay is the one
 * place that holds the credentials for Google's push service (and Apple's, later): every inbox,
 * hosted or on its owner's own server, registers its owner's phones there and hands it messages
 * already encrypted for each phone. The relay can read none of them.
 *
 * - `POST /v1/devices` registers a phone's push token and answers a device id and a secret. The
 *   relay keeps only the secret's hash; only this inbox holds the secret. The call proves which
 *   inbox makes it: an inbox on its own server signs it sdi-instance/1 with its receipt key (the
 *   relay reads the key from the inbox's manifest); a hosted inbox asks its host's control plane,
 *   which vouches for it (`RelayRegistrar`).
 * - `PUT /v1/devices/{device}` replaces the push token when the phone's changes.
 * - `DELETE /v1/devices/{device}` forgets it.
 * - `POST /v1/devices/{device}/messages` hands over one encrypted message, with an idempotency `id`
 *   that is the same on every try of one notification.
 * The last three carry `Authorization: Bearer <secret>`.
 */
export const DEFAULT_RELAY = "https://push.surfingdog.ai";
export const APP_ID = "ai.surfingdog.inbox";

export interface RelayRegistration {
  readonly device: string;
  readonly secret: string;
}

export type RelaySend =
  | { readonly ok: true }
  /** The phone's app is gone (uninstalled, or its token replaced): stop sending to it. */
  | { readonly ok: false; readonly gone: true; readonly status: number }
  | { readonly ok: false; readonly gone: false; readonly status: number; readonly retryAfterS?: number };

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The relay's own code (`bad_signature`, `limited`, `device_limit`…), when it gave one. */
    readonly code?: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface PushRelay {
  register(input: { platform: "android" | "ios"; token: string; sender: string }): Promise<RelayRegistration>;
  updateToken(reg: RelayRegistration, token: string): Promise<void>;
  remove(reg: RelayRegistration): Promise<void>;
  send(
    reg: RelayRegistration,
    message: Uint8Array,
    opts: {
      ttlS: number;
      urgency: "high" | "normal";
      /** Opaque, 1–64 of `[A-Za-z0-9_-]`: a later message with the same one replaces an undelivered one. */
      collapse?: string;
      /** Opaque, the same on every try of one notification: the relay delivers it once. */
      id?: string;
    },
  ): Promise<RelaySend>;
}

/** What registering a phone sends, whoever carries it to the relay. */
export interface RegisterBody {
  readonly app: string;
  readonly platform: "android" | "ios";
  readonly token: string;
  /** The inbox's own https origin. */
  readonly sender: string;
}

/** The relay's answer to a registration, as it came: its status, its JSON, and how long to wait when told to. */
export interface RegisterAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterS?: number | undefined;
}

/**
 * How a registration reaches the relay and proves which inbox it is for: signed by the inbox itself
 * (`signedRegistrar`), or, for a hosted inbox, through its host's control plane, which vouches for it.
 */
export type RelayRegistrar = (body: RegisterBody) => Promise<RegisterAnswer>;

function retryAfter(res: Response): number | undefined {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Registration signed sdi-instance/1 with the inbox's receipt key, `Sdi-Instance` its origin: the
 * relay reads the key from `https://<origin host>/.well-known/agent-inbox.json`. Each try is signed
 * anew (a signature is used once). `signer` is null without INBOX_SECRET_KEY: then nothing is sent.
 */
export function signedRegistrar(
  base: string,
  fetchImpl: typeof fetch,
  signer: () => Promise<InstanceSigningKey | null>,
  opts: { readonly timeoutMs?: number; readonly now?: () => number } = {},
): RelayRegistrar {
  const url = `${base.replace(/\/+$/, "")}/v1/devices`;
  return async (body) => {
    const key = await signer();
    if (!key) throw new RelayError("this inbox has no receipt key to sign with (INBOX_SECRET_KEY)", 0, "no_key");
    const text = JSON.stringify(body);
    const signed = await signInstanceRequest({
      method: "POST",
      url,
      body: text,
      instance: body.sender,
      key,
      ...(opts.now ? { now: opts.now() } : {}),
    });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...signed.headers,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "SurfingDogInbox",
      },
      body: text,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    return { status: res.status, body: await res.json().catch(() => null), retryAfterS: retryAfter(res) };
  };
}

/** A relay's refusal as a sentence for Settings → Phone's records, never shown as it is to anyone else. */
function refusal(what: string, answer: RegisterAnswer): RelayError {
  const code =
    answer.body && typeof answer.body === "object" && typeof (answer.body as { code?: unknown }).code === "string"
      ? String((answer.body as { code: string }).code).slice(0, 40)
      : undefined;
  return new RelayError(
    `${what} answered ${answer.status}${code ? ` (${code})` : ""}`,
    answer.status,
    code,
    answer.retryAfterS,
  );
}

/**
 * A relay over fetch. `fetchImpl` is the host's outbound fetch; the relay's address is a setting.
 * `registrar` is how a registration is proved: by default the inbox signs it (`signer`, its receipt
 * key); a hosted inbox passes its control plane's.
 */
export function httpRelay(
  base: string,
  fetchImpl: typeof fetch = fetch,
  opts: {
    readonly registrar?: RelayRegistrar | undefined;
    readonly signer?: (() => Promise<InstanceSigningKey | null>) | undefined;
    readonly timeoutMs?: number;
  } = {},
): PushRelay {
  const root = base.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const registrar =
    opts.registrar ?? signedRegistrar(root, fetchImpl, opts.signer ?? (async () => null), { timeoutMs });
  const call = async (method: string, path: string, body: unknown, secret: string): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "SurfingDogInbox",
      authorization: `Bearer ${secret}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetchImpl(`${root}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const device = (reg: RelayRegistration) => `/v1/devices/${encodeURIComponent(reg.device)}`;
  return {
    async register(input) {
      const answer = await registrar({ app: APP_ID, ...input });
      if (answer.status !== 201 && answer.status !== 200) throw refusal("the relay", answer);
      const b = answer.body as { device?: unknown; secret?: unknown } | null;
      if (typeof b?.device !== "string" || typeof b.secret !== "string")
        throw new RelayError("the relay answered without a device and a secret", 502);
      return { device: b.device, secret: b.secret };
    },
    async updateToken(reg, token) {
      const res = await call("PUT", device(reg), { token }, reg.secret);
      if (!res.ok) throw new RelayError(`the relay answered ${res.status}`, res.status);
    },
    async remove(reg) {
      const res = await call("DELETE", device(reg), undefined, reg.secret);
      // Already gone is gone.
      if (!res.ok && res.status !== 404 && res.status !== 410)
        throw new RelayError(`the relay answered ${res.status}`, res.status);
    },
    async send(reg, message, o) {
      const res = await call(
        "POST",
        `${device(reg)}/messages`,
        {
          payload: b64uEncode(message),
          ttl: o.ttlS,
          urgency: o.urgency,
          ...(o.collapse ? { collapse: o.collapse } : {}),
          ...(o.id ? { id: o.id } : {}),
        },
        reg.secret,
      );
      // 409: an earlier try with this id is delivering it. Done either way.
      if (res.ok || res.status === 409) return { ok: true };
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
      const wait = retryAfter(res);
      return { ok: false, gone: false, status: res.status, ...(wait ? { retryAfterS: wait } : {}) };
    },
  };
}

/** The relay's address from the host's setting: a URL, `off`, or nothing for the default. */
export function relayAddress(value: string | undefined | null): string | null {
  const v = (value ?? "").trim();
  if (v === "off" || v === "none" || v === "0") return null;
  if (!v) return DEFAULT_RELAY;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)))
      return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    // fall through
  }
  return null;
}
