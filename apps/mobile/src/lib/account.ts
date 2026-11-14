import { b64uEncode, pkceS256 } from "../../../../packages/core/src/phones/crypto";
import { APP_SCHEME, inboxOrigin } from "../../../../packages/core/src/phones/links";
import type { DeviceKey, Native } from "./native";
import type { Fetch } from "./session";

/**
 * Signing in from the phone (ADR-028 Amendment 4): an owner whose inbox Surfing Dog hosts connects
 * this phone with a code Surfing Dog emails them, from any mail provider, with no computer and no QR
 * code. This is the hosted service's small app API, by native HTTP, with no cookies:
 *
 *   POST /v1/app/signin {email, challenge, device: {platform}} → 202 {id, to, resend_in}, alike for every address
 *   POST /v1/app/signin/{id}/resend                          → 202
 *   POST /v1/app/signin/{id}/confirm {code, verifier}        → {grant, expires_in, inboxes}
 *   POST /v1/app/inboxes/{id}/link {grant, challenge, device_key} → {inbox, link: {secret, expires_at}}
 *
 * The verifier never leaves the phone before the code is confirmed, so a code read by someone else, or
 * the email's button opened by another app, is no use without this phone. The link is then redeemed at
 * the inbox itself (Sessions.connectHosted), with a second verifier and the inbox's own device key.
 */
export const ACCOUNT_ORIGIN = "https://app.surfingdog.ai";

/** How long a sign-in waits on the phone for its code: its codes are sent again for half an hour at most. */
export const SIGNIN_KEEP_MS = 30 * 60_000;

/** A sign-in this phone started: kept in secure storage until it is confirmed, given up or too old. */
export interface PendingSignIn {
  readonly id: string;
  /** The address the code went to, as the service masks it ("k•••@example.com"). */
  readonly to: string;
  /** When the last code was asked for, for "Send a new code (0:45)". */
  readonly sentAt: number;
  readonly resendIn: number;
  readonly startedAt: number;
  /** Codes asked for in this sign-in, the first included: three an hour at most. */
  readonly sends?: number | undefined;
}

/** An inbox the signed-in address owns, as the service lists it. */
export interface GrantedInbox {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly state: string;
  /** False for one that takes no new phone now (paused, closing, still being set up). */
  readonly can_connect: boolean;
}

/** A confirmed code: a grant that opens one of these inboxes once, for minutes. */
export interface Granted {
  readonly grant: string;
  readonly expiresAt: number;
  readonly inboxes: readonly GrantedInbox[];
}

/** The service's refusal, with its own sentence. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
  get offline(): boolean {
    return this.status === 0;
  }
}

const KEEP = "account.signin";
const ID = /^[A-Za-z0-9_-]{22}$/;
const CODE = /^\d{6}$/;

/**
 * What the button in the code email hands the app: `ai.surfingdog.inbox://code?i=<sign-in>&c=<code>`,
 * by an intent pinned to the app's package on Android. Null for anything else.
 */
export function readCodeLink(url: string): { id: string; code: string } | null {
  if (!url.startsWith(`${APP_SCHEME}://`)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.host || u.pathname.replace(/^\/+/, "")) !== "code") return null;
  const id = u.searchParams.get("i") ?? "";
  const code = (u.searchParams.get("c") ?? "").replace(/\s+/g, "");
  return ID.test(id) && CODE.test(code) ? { id, code } : null;
}

/**
 * What a notification about an inbox opens (`ai.surfingdog.inbox://open?o=<inbox>`): the inbox's
 * origin, or null for anything else.
 */
export function readOpenLink(url: string, allowLocal = false): string | null {
  if (!url.startsWith(`${APP_SCHEME}://`)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.host || u.pathname.replace(/^\/+/, "")) !== "open") return null;
  return inboxOrigin(u.searchParams.get("o") ?? "", allowLocal);
}

/** Words for the owner when the service's answer says nothing they can read. */
const OUR_SIDE = "Something went wrong on our side. Try again.";

async function problem(res: Response): Promise<AccountError> {
  try {
    const p = (await res.json()) as { detail?: string; code?: string };
    return new AccountError(p.detail || OUR_SIDE, res.status, p.code ?? `http_${res.status}`);
  } catch {
    return new AccountError(OUR_SIDE, res.status, `http_${res.status}`);
  }
}

/** A kept sign-in as the screens see it: never its verifier. */
function shown(k: PendingSignIn): PendingSignIn {
  return { id: k.id, to: k.to, sentAt: k.sentAt, resendIn: k.resendIn, startedAt: k.startedAt, sends: k.sends ?? 1 };
}

export class Account {
  constructor(
    private readonly native: Native,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly origin: string = ACCOUNT_ORIGIN,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw new AccountError("Could not reach Surfing Dog. Check the connection and try again.", 0, "network");
    }
  }

  /**
   * Asks for a code to `email`. The answer is the same whether or not the address has an inbox here:
   * the code comes only when it has one. The verifier stays in this phone's secure storage.
   */
  async start(email: string): Promise<PendingSignIn> {
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const res = await this.post("/v1/app/signin", {
      email: email.trim(),
      challenge: await pkceS256(verifier),
      // The kind of phone only: the code email says which kind asked, never a name whoever holds it typed.
      device: { platform: this.native.platform === "ios" ? "ios" : "android" },
    });
    if (res.status !== 202) throw await problem(res);
    const a = (await res.json()) as { id?: string; to?: string; resend_in?: number };
    if (!a.id || !ID.test(a.id)) throw new AccountError(OUR_SIDE, 502, "bad_answer");
    const now = this.clock();
    const kept: PendingSignIn & { verifier: string } = {
      id: a.id,
      to: a.to ?? "",
      sentAt: now,
      resendIn: Math.max(0, Math.min(600, Number(a.resend_in) || 60)),
      startedAt: now,
      sends: 1,
      verifier,
    };
    await this.native.secureSet(KEEP, JSON.stringify(kept));
    return shown(kept);
  }

  private async kept(): Promise<(PendingSignIn & { verifier: string }) | null> {
    try {
      const raw = await this.native.secureGet(KEEP);
      const k = raw ? (JSON.parse(raw) as PendingSignIn & { verifier: string }) : null;
      if (!k || !ID.test(k.id) || typeof k.verifier !== "string") return null;
      return this.clock() - k.startedAt > SIGNIN_KEEP_MS ? null : k;
    } catch {
      return null;
    }
  }

  /** The sign-in this phone is waiting on, if any (the app may have been closed while the email came). */
  async pending(): Promise<PendingSignIn | null> {
    const k = await this.kept();
    return k ? shown(k) : null;
  }

  /** "Send a new code": asked again for the same sign-in; the earlier codes keep working. */
  async resend(): Promise<PendingSignIn> {
    const k = await this.kept();
    if (!k) throw new AccountError("Start again: that sign-in is too old.", 410, "gone");
    const res = await this.post(`/v1/app/signin/${k.id}/resend`, {});
    if (res.status !== 202) throw await problem(res);
    const next = { ...k, sentAt: this.clock(), sends: (k.sends ?? 1) + 1 };
    await this.native.secureSet(KEEP, JSON.stringify(next));
    return shown(next);
  }

  /**
   * The code, typed or handed over by the email's button, with this phone's verifier: a grant to
   * connect one of the address's inboxes. A code from the button names its sign-in, which must be the
   * one this phone started: another phone's code does nothing here.
   */
  async confirm(code: string, id?: string): Promise<Granted> {
    const k = await this.kept();
    if (!k || (id !== undefined && id !== k.id))
      throw new AccountError("Ask for a code from this phone first.", 409, "no_signin");
    const typed = code.replace(/\s+/g, "");
    if (!CODE.test(typed)) throw new AccountError("Type the six digits from the email.", 422, "invalid_input");
    const res = await this.post(`/v1/app/signin/${k.id}/confirm`, { code: typed, verifier: k.verifier });
    if (!res.ok) throw await problem(res);
    const a = (await res.json()) as { grant?: string; expires_in?: number; inboxes?: GrantedInbox[] };
    if (typeof a.grant !== "string") throw new AccountError(OUR_SIDE, 502, "bad_answer");
    await this.forget();
    const inboxes = (Array.isArray(a.inboxes) ? a.inboxes : []).filter(
      (i) => typeof i.id === "string" && inboxOrigin(String(i.origin)) !== null,
    );
    return { grant: a.grant, expiresAt: this.clock() + (Number(a.expires_in) || 600) * 1000, inboxes };
  }

  /** Gives up on the sign-in waiting here ("Wrong email?", or done). */
  async forget(): Promise<void> {
    await this.native.secureRemove(KEEP);
  }

  /**
   * One of the granted inboxes, for this phone: a one-time link to redeem at the inbox's own address
   * with the verifier of `challenge` and the device key named now. Spends the grant.
   */
  async link(
    grant: string,
    inbox: GrantedInbox,
    challenge: string,
    deviceKey: DeviceKey,
  ): Promise<{ origin: string; name: string; secret: string }> {
    const res = await this.post(`/v1/app/inboxes/${encodeURIComponent(inbox.id)}/link`, {
      grant,
      challenge,
      device_key: deviceKey,
    });
    if (res.status !== 201) throw await problem(res);
    const a = (await res.json()) as {
      inbox?: { origin?: string; name?: string };
      link?: { secret?: string };
    };
    const origin = inboxOrigin(String(a.inbox?.origin ?? ""));
    const secret = a.link?.secret ?? "";
    if (!origin || !/^sdi_pp_[A-Za-z0-9_-]{43}$/.test(secret)) throw new AccountError(OUR_SIDE, 502, "bad_answer");
    return { origin, name: a.inbox?.name || inbox.name, secret };
  }
}
