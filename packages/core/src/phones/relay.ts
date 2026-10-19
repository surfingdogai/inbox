import { b64uEncode } from "./crypto";

/**
 * The inbox's side of the push relay (ADR-026, docs/protocol/push-relay.md). The relay is the one
 * place that holds the credentials for Google's push service (and Apple's, later): every inbox,
 * hosted or on its owner's own server, registers its owner's phones there and hands it messages
 * already encrypted for each phone. The relay can read none of them.
 *
 * Four calls, JSON over https:
 * - `POST /v1/devices` registers a phone's push token, and answers a device id and a secret. Only
 *   the secret's hash is kept by the relay; only this inbox holds the secret.
 * - `PUT /v1/devices/{device}` replaces the push token when the phone's changes.
 * - `DELETE /v1/devices/{device}` forgets it.
 * - `POST /v1/devices/{device}/messages` hands over one encrypted message.
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
    opts: { ttlS: number; urgency: "high" | "normal"; collapse?: string },
  ): Promise<RelaySend>;
}

/** A relay over fetch. `fetchImpl` is the host's outbound fetch; the relay's address is a setting. */
export function httpRelay(base: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): PushRelay {
  const url = (path: string) => `${base.replace(/\/+$/, "")}${path}`;
  const call = async (method: string, path: string, body: unknown, secret?: string): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "SurfingDogInbox" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (secret) headers.authorization = `Bearer ${secret}`;
    const signal = AbortSignal.timeout(timeoutMs);
    return fetchImpl(url(path), {
      method,
      headers,
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const device = (reg: RelayRegistration) => `/v1/devices/${encodeURIComponent(reg.device)}`;
  return {
    async register(input) {
      const res = await call("POST", "/v1/devices", { app: APP_ID, ...input });
      if (res.status !== 201 && res.status !== 200) throw new RelayError(`relay answered ${res.status}`, res.status);
      const body = (await res.json().catch(() => null)) as { device?: unknown; secret?: unknown } | null;
      if (typeof body?.device !== "string" || typeof body.secret !== "string")
        throw new RelayError("relay answered without a device and a secret", 502);
      return { device: body.device, secret: body.secret };
    },
    async updateToken(reg, token) {
      const res = await call("PUT", device(reg), { token }, reg.secret);
      if (!res.ok) throw new RelayError(`relay answered ${res.status}`, res.status);
    },
    async remove(reg) {
      const res = await call("DELETE", device(reg), undefined, reg.secret);
      // Already gone is gone.
      if (!res.ok && res.status !== 404 && res.status !== 410)
        throw new RelayError(`relay answered ${res.status}`, res.status);
    },
    async send(reg, message, opts) {
      const res = await call(
        "POST",
        `${device(reg)}/messages`,
        {
          payload: b64uEncode(message),
          ttl: opts.ttlS,
          urgency: opts.urgency,
          ...(opts.collapse ? { collapse: opts.collapse } : {}),
        },
        reg.secret,
      );
      if (res.ok) return { ok: true };
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
      const retry = Number(res.headers.get("retry-after"));
      return {
        ok: false,
        gone: false,
        status: res.status,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterS: retry } : {}),
      };
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
