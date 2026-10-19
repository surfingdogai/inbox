import { b64uEncode, pkceS256, proofStatement, sha256b64u } from "../../../../packages/core/src/phones/crypto";
import type { PhoneLink } from "../../../../packages/core/src/phones/links";
import type { Native } from "./native";

/**
 * The inboxes this phone is connected to, and their tokens (ADR-026). An operator who looks after
 * several businesses connects each inbox once; each has its own device key on the phone (its alias),
 * its own refresh token in secure storage, and its own short access token in memory.
 *
 * A refresh token is useless without the device key: every refresh is signed with it, and the key
 * never leaves the phone's keystore.
 */
export interface InboxEntry {
  /** Where this inbox's keys are kept on the phone: one alias per inbox, never reused. */
  readonly alias: string;
  readonly origin: string;
  readonly name: string;
  readonly deviceId: string;
  readonly addedAt: number;
}

interface Tokens {
  readonly access: string;
  readonly accessUntil: number;
  readonly refresh: string;
}

interface TokenAnswer {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly device_id: string;
  readonly inbox?: { readonly origin: string; readonly name: string };
}

/** A refusal from an inbox, with its own sentence and code. */
export class InboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InboxError";
  }
  /** The inbox could not be reached at all: offline, or it is down. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const LIST_KEY = "inboxes";
const tokenKey = (alias: string) => `tokens.${alias}`;
const verifierKey = (origin: string) => `link.${origin}`;

async function problem(res: Response): Promise<InboxError> {
  try {
    const p = (await res.json()) as { detail?: string; code?: string; error?: string };
    return new InboxError(
      p.detail ?? `The inbox answered ${res.status}.`,
      res.status,
      p.code ?? p.error ?? `http_${res.status}`,
    );
  } catch {
    return new InboxError(`The inbox answered ${res.status}.`, res.status, `http_${res.status}`);
  }
}

export class Sessions {
  private readonly access = new Map<string, Tokens>();
  private readonly refreshing = new Map<string, Promise<Tokens>>();

  constructor(
    private readonly native: Native,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async list(): Promise<InboxEntry[]> {
    try {
      const raw = await this.native.secureGet(LIST_KEY);
      const parsed = raw ? (JSON.parse(raw) as InboxEntry[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveList(list: readonly InboxEntry[]): Promise<void> {
    await this.native.secureSet(LIST_KEY, JSON.stringify(list));
    await this.native.setInboxes(list.map((e) => ({ alias: e.alias, origin: e.origin, name: e.name })));
  }

  private async post(url: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new InboxError("Could not reach the inbox. Check the connection and try again.", 0, "network");
    }
  }

  /** A signed statement, as the inbox checks it: what for, which inbox, a hash of the secret, when. */
  private async proof(alias: string, purpose: "pair" | "link" | "refresh", origin: string, secret: string) {
    const at = this.clock();
    const statement = proofStatement(purpose, origin, await sha256b64u(secret), at);
    return { at, proof: await this.native.sign(alias, statement) };
  }

  private static newAlias(): string {
    return `ib_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;
  }

  /** Keeps a new inbox and its first tokens. One inbox is connected once: again replaces it. */
  private async keep(alias: string, origin: string, answer: TokenAnswer): Promise<InboxEntry> {
    const entry: InboxEntry = {
      alias,
      origin,
      name: answer.inbox?.name || new URL(origin).host,
      deviceId: answer.device_id,
      addedAt: this.clock(),
    };
    await this.native.secureSet(tokenKey(alias), answer.refresh_token);
    this.access.set(alias, {
      access: answer.access_token,
      accessUntil: this.clock() + answer.expires_in * 1000 - 30_000,
      refresh: answer.refresh_token,
    });
    const before = await this.list();
    // Connected again to an inbox it was connected to: the old keys and token go.
    for (const old of before.filter((e) => e.origin === origin && e.alias !== alias)) {
      this.access.delete(old.alias);
      await this.native.secureRemove(tokenKey(old.alias));
      await this.native.deleteKeys(old.alias);
    }
    await this.saveList([...before.filter((e) => e.origin !== origin), entry]);
    return entry;
  }

  /** A QR code from Settings → Phone, scanned: pairs this phone with that inbox. */
  async pair(link: PhoneLink): Promise<InboxEntry> {
    if (link.kind !== "pair") throw new InboxError("That is a sign-in link, not a code to scan.", 400, "invalid_input");
    const alias = Sessions.newAlias();
    const key = await this.native.deviceKey(alias);
    const { at, proof } = await this.proof(alias, "pair", link.origin, link.secret);
    const res = await this.post(`${link.origin}/v1/phone/pair`, {
      secret: link.secret,
      device_key: key,
      at,
      proof,
      name: await this.native.deviceName(),
      platform: this.native.platform === "ios" ? "ios" : "android",
    });
    if (!res.ok) {
      await this.native.deleteKeys(alias);
      throw await problem(res);
    }
    return this.keep(alias, link.origin, (await res.json()) as TokenAnswer);
  }

  /**
   * "Email me a sign-in link instead": the verifier stays here, its challenge goes with the request,
   * and the device key that will redeem the link is named now.
   */
  async askForLink(origin: string, email: string): Promise<string> {
    const alias = Sessions.newAlias();
    const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    await this.native.secureSet(verifierKey(origin), JSON.stringify({ alias, verifier }));
    const res = await this.post(`${origin}/v1/phone/link`, {
      email,
      challenge: await pkceS256(verifier),
      device_key: await this.native.deviceKey(alias),
    });
    if (!res.ok) throw await problem(res);
    return ((await res.json()) as { message?: string }).message ?? "A link is on its way.";
  }

  /** The emailed link, opened on this phone: redeemed with the verifier and the key that asked. */
  async redeem(link: PhoneLink): Promise<InboxEntry> {
    const raw = await this.native.secureGet(verifierKey(link.origin));
    if (!raw) throw new InboxError("Ask for the link again from this phone.", 400, "no_verifier");
    const { alias, verifier } = JSON.parse(raw) as { alias: string; verifier: string };
    const { at, proof } = await this.proof(alias, "link", link.origin, link.secret);
    const res = await this.post(`${link.origin}/v1/phone/link/redeem`, {
      secret: link.secret,
      verifier,
      device_key: await this.native.deviceKey(alias),
      at,
      proof,
      name: await this.native.deviceName(),
      platform: this.native.platform === "ios" ? "ios" : "android",
    });
    if (!res.ok) throw await problem(res);
    await this.native.secureRemove(verifierKey(link.origin));
    return this.keep(alias, link.origin, (await res.json()) as TokenAnswer);
  }

  /**
   * An access token for an inbox: the one in memory while it lasts, else a new one for the refresh
   * token, signed for. Two calls at once share one refresh.
   */
  async token(entry: InboxEntry, force = false): Promise<string> {
    const have = this.access.get(entry.alias);
    if (have && !force && have.accessUntil > this.clock()) return have.access;
    const running = this.refreshing.get(entry.alias);
    if (running) return (await running).access;
    const work = this.refresh(entry).finally(() => this.refreshing.delete(entry.alias));
    this.refreshing.set(entry.alias, work);
    return (await work).access;
  }

  private async refresh(entry: InboxEntry): Promise<Tokens> {
    const refresh = this.access.get(entry.alias)?.refresh ?? (await this.native.secureGet(tokenKey(entry.alias)));
    if (!refresh) throw new InboxError("This phone is signed out of this inbox.", 401, "signed_out");
    const { at, proof } = await this.proof(entry.alias, "refresh", entry.origin, refresh);
    const res = await this.post(`${entry.origin}/v1/phone/token`, { refresh_token: refresh, at, proof });
    if (!res.ok) {
      const p = await problem(res);
      // Refused for good (removed in Settings → Phone, or the token is no longer valid): signed out.
      if (res.status === 401 || res.status === 403) throw new InboxError(p.message, 401, "signed_out");
      throw p;
    }
    const answer = (await res.json()) as TokenAnswer;
    // The new refresh token is kept before it is used, so a crash in between cannot lose the phone.
    await this.native.secureSet(tokenKey(entry.alias), answer.refresh_token);
    const tokens = {
      access: answer.access_token,
      accessUntil: this.clock() + answer.expires_in * 1000 - 30_000,
      refresh: answer.refresh_token,
    };
    this.access.set(entry.alias, tokens);
    return tokens;
  }

  /** Signs this phone out of an inbox: the inbox forgets it (when it can be reached), and so does the phone. */
  async remove(entry: InboxEntry): Promise<void> {
    try {
      const token = await this.token(entry);
      await this.fetchImpl(`${entry.origin}/v1/phone`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // Offline or already removed there: the owner can remove it in Settings → Phone too.
    }
    await this.forget(entry);
  }

  /** Forgets an inbox on this phone only (it was removed on the inbox's side). */
  async forget(entry: InboxEntry): Promise<void> {
    this.access.delete(entry.alias);
    await this.native.secureRemove(tokenKey(entry.alias));
    await this.native.deleteKeys(entry.alias);
    await this.saveList((await this.list()).filter((e) => e.alias !== entry.alias));
  }
}

/**
 * Where a business's inbox is, from its owner's email address: the domain's own pointer
 * (`/.well-known/agent-inbox.json`, ADR-024), else `inbox.<domain>` when one answers there.
 */
export async function findInbox(email: string, fetchImpl: Fetch): Promise<string | null> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const read = async (url: string): Promise<string | null> => {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      // The inbox's manifest names it: `instance` (packages/spec manifestSchema).
      const m = (await res.json()) as { spec?: unknown; instance?: unknown };
      if (typeof m.spec !== "string" || !m.spec.startsWith("surfingdog-inbox/") || typeof m.instance !== "string")
        return null;
      const at = m.instance;
      const u = new URL(at);
      return u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  return (
    (await read(`https://${domain}/.well-known/agent-inbox.json`)) ??
    (await read(`https://inbox.${domain}/.well-known/agent-inbox.json`))
  );
}
