import {
  b64uEncode,
  jwkThumbprint,
  pairingMatch,
  pkceS256,
  proofStatement,
  sha256b64u,
} from "../../../../packages/core/src/phones/crypto";
import { inboxOrigin, type PhoneLink } from "../../../../packages/core/src/phones/links";
import type { Account, GrantedInbox } from "./account";
import { type DeviceKey, lockWords, type Native, NativeError } from "./native";

/**
 * The inboxes this phone is connected to, and their tokens (ADR-028). An operator who looks after
 * several businesses connects each inbox once; each has its own device key on the phone (its alias),
 * its own refresh token in secure storage, and its own short access token in memory.
 *
 * A refresh token is useless without the device key: every refresh is signed with it, and the key
 * never leaves the phone's keystore. The key signs only shortly after the owner unlocked the phone or
 * the app; past that, the app asks for the fingerprint or face and signs again.
 *
 * Pairing with a QR code takes two steps: the phone trades the code for tokens that open nothing yet,
 * shows the inbox's address and two digits, and waits for the owner to press Confirm on the computer,
 * where the same two digits show. Only then is the inbox kept on the phone.
 *
 * Signing in with an email code (Amendment 4) takes the same two steps when the owner already has a
 * confirmed phone: this one shows two digits and waits for that phone's Confirm, or, when the owner
 * doesn't have it, waits a day, kept on the phone meanwhile (`waitingUntil`) and opening nothing.
 */
export interface InboxEntry {
  /** Where this inbox's keys are kept on the phone: one alias per inbox, never reused. */
  readonly alias: string;
  readonly origin: string;
  readonly name: string;
  readonly deviceId: string;
  readonly addedAt: number;
  /** The relay's id for this phone at this inbox: which inbox's key opens a notification naming it. */
  readonly relayDevice?: string | undefined;
  /**
   * "I don't have my other phone": when this phone is let in, unless the owner stops it from another
   * phone or from the email. Until then the inbox opens nothing here but whether it came.
   */
  readonly waitingUntil?: number | undefined;
}

/**
 * A phone that waits for a yes: the owner's Confirm on the computer (a QR code), or on the owner's
 * other phone (an email code, when the owner has a confirmed phone already). Kept in memory only.
 */
export interface PendingPhone {
  readonly alias: string;
  readonly origin: string;
  readonly name: string;
  readonly deviceId: string;
  /** The two digits this phone worked out, which the computer or the other phone must show too. */
  readonly match: string;
  readonly answer: TokenAnswer;
  /** Where the yes comes from. */
  readonly waitsOn: "computer" | "phone";
  /** How long "I don't have my other phone" makes it wait, in hours (a day, or three). */
  readonly waitHours?: number | undefined;
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
  readonly state?: "pending" | "connected";
  readonly match?: string;
  /** For a phone that waits for the owner's other phone: how long "I don't have my other phone" waits. */
  readonly wait_hours?: number;
  readonly inbox?: { readonly origin: string; readonly name: string };
}

/** A refusal from an inbox, with its own sentence and code. */
export class InboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** What the inbox's problem said beside its sentence (the screen an item was on, a time to wait). */
    readonly details?: Record<string, unknown>,
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

/**
 * How long the fingerprint or face may take before what needed it gives up. A prompt that could not
 * show (the app went to the background as it was asked for) never answers: this settles it, so no
 * refresh waits on it for good.
 */
export const UNLOCK_WAIT_MS = 60_000;

const LIST_KEY = "inboxes";
const tokenKey = (alias: string) => `tokens.${alias}`;
const verifierKey = (origin: string) => `link.${origin}`;
/** The push token last registered with an inbox (lib/push.ts). */
export const pushSentKey = (alias: string) => `push.${alias}`;

async function problem(res: Response): Promise<InboxError> {
  try {
    const p = (await res.json()) as {
      detail?: string;
      code?: string;
      error?: string;
      details?: Record<string, unknown>;
    };
    return new InboxError(
      p.detail ?? `The inbox answered ${res.status}.`,
      res.status,
      p.code ?? p.error ?? `http_${res.status}`,
      p.details && typeof p.details === "object" ? p.details : undefined,
    );
  } catch {
    return new InboxError(`The inbox answered ${res.status}.`, res.status, `http_${res.status}`);
  }
}

/**
 * Where an inbox says it is now, from a refusal: a hosted inbox set up at its setup address and then
 * live at the business's own name answers every call at the old address 404, naming the new one
 * (`details.moved_to`, packages/hosted). Only an https origin is taken; anything else is no move.
 */
export function movedTo(error: unknown): string | null {
  if (!(error instanceof InboxError) || error.status !== 404) return null;
  const to = error.details?.moved_to;
  return typeof to === "string" ? inboxOrigin(to) : null;
}

export class Sessions {
  private readonly access = new Map<string, Tokens>();
  /** A refresh under way for an inbox, and whether it was a quiet one (it gives up rather than ask). */
  private readonly refreshing = new Map<string, { readonly work: Promise<Tokens>; readonly quiet: boolean }>();
  private readonly following = new Map<string, Promise<InboxEntry>>();
  private unlocking: Promise<boolean> | null = null;
  private front = true;
  private readonly moveListeners = new Set<(entry: InboxEntry, from: string) => void>();

  constructor(
    private readonly native: Native,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number = () => Date.now(),
    private readonly unlockWaitMs: number = UNLOCK_WAIT_MS,
  ) {}

  /**
   * Whether the app is in front. In the background the fingerprint or face is never asked for: no
   * prompt can show there, and one asked for then may never answer.
   */
  setFront(front: boolean): void {
    this.front = front;
  }

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
    await this.native.setInboxes(
      list.map((e) => ({ alias: e.alias, origin: e.origin, name: e.name, device: e.relayDevice })),
    );
  }

  /** What the inbox said the relay calls this phone there: kept, and told to the notification service. */
  async setRelayDevice(alias: string, device: string): Promise<void> {
    const list = await this.list();
    if (list.find((e) => e.alias === alias)?.relayDevice === device) return;
    await this.saveList(list.map((e) => (e.alias === alias ? { ...e, relayDevice: device } : e)));
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

  /**
   * A signed statement, as the inbox checks it: what for, which inbox, a hash of the secret, when. The
   * device key signs only shortly after an unlock: past that, the owner is asked once, and it signs.
   * A quiet one never asks: it gives up (`locked`) until the owner next unlocks.
   */
  private async proof(
    alias: string,
    purpose: "pair" | "link" | "refresh" | "confirm",
    origin: string,
    secret: string,
    quiet = false,
  ) {
    const statement = async () => {
      const at = this.clock();
      return { at, text: proofStatement(purpose, origin, await sha256b64u(secret), at) };
    };
    let s = await statement();
    try {
      return { at: s.at, proof: await this.native.sign(alias, s.text) };
    } catch (error) {
      if (error instanceof NativeError && error.code === "key_gone")
        throw new InboxError(
          `This phone's ${lockWords(this.native.platform).noun} changed. Connect it again.`,
          401,
          "signed_out",
        );
      if (!(error instanceof NativeError && error.code === "auth_required")) throw error;
    }
    const ok = !quiet && (await this.unlock());
    if (!ok) throw new InboxError("Unlock to open your inbox.", 423, "locked");
    s = await statement();
    return { at: s.at, proof: await this.native.sign(alias, s.text) };
  }

  /**
   * The fingerprint or face, asked once for every inbox that needs it at that moment: an operator's
   * inboxes refreshing together (Your inboxes, what waited from offline) share one prompt, and an
   * unlock lets every device key on the phone sign for a while. Never in the background, and never
   * waited on for longer than `unlockWaitMs`: a prompt that cannot show is no reason to wait for good.
   */
  private unlock(): Promise<boolean> {
    // One asked for already is shared, even when the prompt itself took the app out of front (an iPhone's).
    if (this.unlocking) return this.unlocking;
    if (!this.front) return Promise.resolve(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.unlockWaitMs);
    });
    const asked = this.native.authenticate("Confirm it's you", "To keep your inbox open").catch(() => false);
    const unlocking: Promise<boolean> = Promise.race([asked, gaveUp]).finally(() => {
      clearTimeout(timer);
      if (this.unlocking === unlocking) this.unlocking = null;
    });
    this.unlocking = unlocking;
    return unlocking;
  }

  private static newAlias(): string {
    return `ib_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;
  }

  /** The tokens a pending phone was given, in memory, so it can ask whether it came for as long as it waits. */
  private hold(alias: string, answer: TokenAnswer): void {
    this.access.set(alias, {
      access: answer.access_token,
      accessUntil: this.clock() + answer.expires_in * 1000 - 30_000,
      refresh: answer.refresh_token,
    });
  }

  /**
   * Keeps a new inbox and its tokens: the ones held in memory when a pending phone refreshed them
   * while it waited (the first refresh token is spent by then). One inbox is connected once: again
   * replaces it.
   */
  private async keep(
    alias: string,
    origin: string,
    answer: TokenAnswer,
    extra: { waitingUntil?: number } = {},
  ): Promise<InboxEntry> {
    const entry: InboxEntry = {
      alias,
      origin,
      name: answer.inbox?.name || new URL(origin).host,
      deviceId: answer.device_id,
      addedAt: this.clock(),
      ...(extra.waitingUntil ? { waitingUntil: extra.waitingUntil } : {}),
    };
    const held = this.access.get(alias);
    const tokens = held ?? {
      access: answer.access_token,
      accessUntil: this.clock() + answer.expires_in * 1000 - 30_000,
      refresh: answer.refresh_token,
    };
    await this.native.secureSet(tokenKey(alias), tokens.refresh);
    this.access.set(alias, tokens);
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

  /**
   * A QR code from Settings → Phone, scanned (and the inbox's address agreed to on the phone): trades
   * the code for tokens that open nothing until the owner confirms on the computer. Nothing is kept on
   * the phone yet.
   */
  async pair(link: PhoneLink): Promise<PendingPhone> {
    if (link.kind !== "pair") throw new InboxError("That is a sign-in link, not a code to scan.", 400, "invalid_input");
    if (!(await this.native.deviceSecure()))
      throw new InboxError(
        `Set a ${lockWords(this.native.platform).noun} on this phone first, then scan the code again.`,
        400,
        "no_screen_lock",
      );
    const alias = Sessions.newAlias();
    try {
      const key = await this.native.deviceKey(alias);
      const match = await pairingMatch(link.secret, await jwkThumbprint(key));
      const { at, proof } = await this.proof(alias, "pair", link.origin, link.secret);
      const res = await this.post(`${link.origin}/v1/phone/pair`, {
        secret: link.secret,
        device_key: key,
        at,
        proof,
        name: await this.native.deviceName(),
        platform: this.native.platform === "ios" ? "ios" : "android",
      });
      if (!res.ok) throw await problem(res);
      const answer = (await res.json()) as TokenAnswer;
      // The inbox must have seen this phone's key: the digits it shows the owner are worked out from it.
      if (answer.match !== undefined && answer.match !== match)
        throw new InboxError("That inbox answered for another phone. Show a new code.", 409, "mismatch");
      this.hold(alias, answer);
      return {
        alias,
        origin: link.origin,
        name: answer.inbox?.name || new URL(link.origin).host,
        deviceId: answer.device_id,
        match,
        answer,
        waitsOn: "computer",
      };
    } catch (error) {
      await this.native.deleteKeys(alias);
      if (error instanceof NativeError && error.code === "no_screen_lock")
        throw new InboxError(
          `Set a ${lockWords(this.native.platform).noun} on this phone first, then scan the code again.`,
          400,
          "no_screen_lock",
        );
      throw error;
    }
  }

  /** An inbox as a pending phone knows it, to ask whether it came. */
  private static entryOf(p: { alias: string; origin: string; name: string; deviceId: string }): InboxEntry {
    return { alias: p.alias, origin: p.origin, name: p.name, deviceId: p.deviceId, addedAt: 0 };
  }

  /**
   * Whether this phone was let in yet: confirmed on the computer or on the owner's other phone, or at
   * the end of its day's wait; refused (Not mine, stopped, or out of time); or still waiting. A quiet
   * look (the waiting screen's own, every two seconds) never asks for the fingerprint or face: when its
   * token cannot be renewed without an unlock, it says `locked`, and only the owner's press looks again.
   */
  async confirmed(
    pending: PendingPhone | InboxEntry,
    opts: { readonly quiet?: boolean } = {},
  ): Promise<"waiting" | "confirmed" | "refused" | "locked"> {
    let res: Response;
    try {
      const token = await this.token(Sessions.entryOf(pending), false, opts.quiet === true);
      res = await this.fetchImpl(`${pending.origin}/v1/phone/me`, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (error instanceof InboxError && error.code === "signed_out") return "refused";
      if (error instanceof InboxError && error.code === "locked") return "locked";
      return "waiting";
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return "refused";
    if (!res.ok) return "waiting";
    const me = (await res.json().catch(() => null)) as { phone?: { confirmed?: boolean } } | null;
    return me?.phone?.confirmed === true ? "confirmed" : "waiting";
  }

  /** Confirmed: the inbox is kept on the phone, with its tokens. */
  async finish(pending: PendingPhone): Promise<InboxEntry> {
    return this.keep(pending.alias, pending.origin, pending.answer);
  }

  /**
   * Given up on, or refused: the inbox forgets this phone when it can, and the key made for it goes.
   * Quietly: a wait that ran out, or Cancel, never asks for the fingerprint or face to say so; a phone
   * the inbox is not told of runs out of time there on its own.
   */
  async abandon(pending: PendingPhone): Promise<void> {
    try {
      if (this.access.has(pending.alias)) {
        await this.fetchImpl(`${pending.origin}/v1/phone`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${await this.token(Sessions.entryOf(pending), false, true)}` },
        });
      }
    } catch {
      // Offline, or gone already: it runs out of time on its own.
    }
    this.access.delete(pending.alias);
    await this.native.deleteKeys(pending.alias);
  }

  /**
   * An inbox Surfing Dog hosts, for an owner who confirmed an email code on this phone (`Account`): a
   * device key for it, a one-time link from the service for that key and a fresh verifier, redeemed at
   * the inbox itself. Connected at once, or, when the owner has a confirmed phone already, waiting for
   * that phone's yes with two digits on both.
   */
  async connectHosted(
    account: Account,
    grant: string,
    inbox: GrantedInbox,
  ): Promise<{ entry: InboxEntry } | { pending: PendingPhone }> {
    if (!(await this.native.deviceSecure()))
      throw new InboxError(`Set a ${lockWords(this.native.platform).noun} on this phone first.`, 400, "no_screen_lock");
    const alias = Sessions.newAlias();
    try {
      const key = await this.native.deviceKey(alias);
      const verifier = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
      const link = await account.link(grant, inbox, await pkceS256(verifier), key);
      const { at, proof } = await this.proof(alias, "link", link.origin, link.secret);
      const res = await this.post(`${link.origin}/v1/phone/link/redeem`, {
        secret: link.secret,
        verifier,
        device_key: key,
        at,
        proof,
        name: await this.native.deviceName(),
        platform: this.native.platform === "ios" ? "ios" : "android",
      });
      if (!res.ok) throw await problem(res);
      const answer = (await res.json()) as TokenAnswer;
      const named = { ...answer, inbox: { origin: link.origin, name: answer.inbox?.name || link.name } };
      return await this.landed(alias, link, key, named);
    } catch (error) {
      this.access.delete(alias);
      await this.native.deleteKeys(alias);
      if (error instanceof NativeError && error.code === "no_screen_lock")
        throw new InboxError(
          `Set a ${lockWords(this.native.platform).noun} on this phone first.`,
          400,
          "no_screen_lock",
        );
      throw error;
    }
  }

  /**
   * "I don't have my other phone": this phone is let in a day from now unless the owner stops it from
   * another phone or from the email. Kept on the phone meanwhile, opening nothing but whether it came.
   */
  async waitADay(pending: PendingPhone): Promise<InboxEntry> {
    if (pending.waitsOn !== "phone") throw new InboxError("This phone waits for your computer.", 409, "wrong_state");
    const token = await this.token(Sessions.entryOf(pending));
    let res: Response;
    try {
      res = await this.fetchImpl(`${pending.origin}/v1/phone/wait`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      throw new InboxError("Could not reach the inbox. Check the connection and try again.", 0, "network");
    }
    if (!res.ok) throw await problem(res);
    const until = Date.parse(((await res.json()) as { wait_until?: string }).wait_until ?? "");
    return this.keep(pending.alias, pending.origin, pending.answer, {
      waitingUntil: Number.isFinite(until) ? until : this.clock() + 86_400_000,
    });
  }

  /** A phone that waited its day was let in: the inbox opens on it as on any other. */
  async settled(entry: InboxEntry): Promise<InboxEntry> {
    const list = await this.list();
    const { waitingUntil: _done, ...rest } = list.find((e) => e.alias === entry.alias) ?? entry;
    await this.saveList(list.map((e) => (e.alias === entry.alias ? rest : e)));
    return rest;
  }

  /**
   * Confirm on the sheet, for a new phone that asked to connect: a statement signed with this phone's
   * key for that phone's id, which the key signs only shortly after an unlock.
   */
  async confirmProof(entry: InboxEntry, phoneId: string): Promise<{ at: number; proof: string }> {
    return this.proof(entry.alias, "confirm", entry.origin, phoneId);
  }

  /**
   * "Email me a sign-in link instead": the verifier stays here, its challenge goes with the request,
   * and the device key that will redeem the link is named now.
   */
  async askForLink(origin: string, email: string): Promise<string> {
    if (!(await this.native.deviceSecure()))
      throw new InboxError(`Set a ${lockWords(this.native.platform).noun} on this phone first.`, 400, "no_screen_lock");
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

  /**
   * A redeemed link's answer: the inbox kept, connected; or, when the owner has a phone already that
   * says yes first, a phone that waits for it, showing the same two digits as that phone, which the
   * inbox worked out from the link and this phone's key. Its tokens are held in memory meanwhile.
   */
  private async landed(
    alias: string,
    link: { origin: string; secret: string },
    key: DeviceKey,
    answer: TokenAnswer & { inbox: { origin: string; name: string } },
  ): Promise<{ entry: InboxEntry } | { pending: PendingPhone }> {
    if (answer.state !== "pending") return { entry: await this.keep(alias, link.origin, answer) };
    const match = await pairingMatch(link.secret, await jwkThumbprint(key));
    if (answer.match !== match)
      throw new InboxError("That inbox answered for another phone. Sign in again.", 409, "mismatch");
    this.hold(alias, answer);
    return {
      pending: {
        alias,
        origin: link.origin,
        name: answer.inbox.name,
        deviceId: answer.device_id,
        match,
        answer,
        waitsOn: "phone",
        waitHours: typeof answer.wait_hours === "number" ? answer.wait_hours : undefined,
      },
    };
  }

  /**
   * The emailed link, opened on this phone: redeemed with the verifier and the key that asked.
   * Connected; or, when the inbox has new phones wait for the owner's other phone, waiting for it.
   */
  async redeem(link: PhoneLink): Promise<{ entry: InboxEntry } | { pending: PendingPhone }> {
    const raw = await this.native.secureGet(verifierKey(link.origin));
    if (!raw) throw new InboxError("Ask for the link again from this phone.", 400, "no_verifier");
    const { alias, verifier } = JSON.parse(raw) as { alias: string; verifier: string };
    const key = await this.native.deviceKey(alias);
    const { at, proof } = await this.proof(alias, "link", link.origin, link.secret);
    const res = await this.post(`${link.origin}/v1/phone/link/redeem`, {
      secret: link.secret,
      verifier,
      device_key: key,
      at,
      proof,
      name: await this.native.deviceName(),
      platform: this.native.platform === "ios" ? "ios" : "android",
    });
    if (!res.ok) throw await problem(res);
    await this.native.secureRemove(verifierKey(link.origin));
    const answer = (await res.json()) as TokenAnswer;
    const named = { ...answer, inbox: { origin: link.origin, name: answer.inbox?.name || new URL(link.origin).host } };
    return this.landed(alias, link, key, named);
  }

  /**
   * An access token for an inbox: the one in memory while it lasts, else a new one for the refresh
   * token, signed for. Two calls at once share one refresh. A quiet call (a look the app takes on its
   * own, every half minute) never asks for the fingerprint or face: when the key will not sign without
   * it, it gives up (`locked`), and a call the owner made, waiting on it, tries again and may ask.
   */
  async token(entry: InboxEntry, force = false, quiet = false): Promise<string> {
    const have = this.access.get(entry.alias);
    if (have && !force && have.accessUntil > this.clock()) return have.access;
    for (let running = this.refreshing.get(entry.alias); running; running = this.refreshing.get(entry.alias)) {
      try {
        return (await running.work).access;
      } catch (error) {
        if (quiet || !running.quiet || !(error instanceof InboxError && error.code === "locked")) throw error;
      }
    }
    const record: { readonly work: Promise<Tokens>; readonly quiet: boolean } = {
      quiet,
      work: this.refresh(entry, quiet).finally(() => {
        if (this.refreshing.get(entry.alias) === record) this.refreshing.delete(entry.alias);
      }),
    };
    this.refreshing.set(entry.alias, record);
    return (await record.work).access;
  }

  private async refresh(entry: InboxEntry, quiet: boolean): Promise<Tokens> {
    const refresh = this.access.get(entry.alias)?.refresh ?? (await this.native.secureGet(tokenKey(entry.alias)));
    if (!refresh) throw new InboxError("This phone is signed out of this inbox.", 401, "signed_out");
    const { at, proof } = await this.proof(entry.alias, "refresh", entry.origin, refresh, quiet);
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

  /** Told when an inbox moved to a new address (`follow`): the entry as it is now, and where it was. */
  onMove(listener: (entry: InboxEntry, from: string) => void): () => void {
    this.moveListeners.add(listener);
    return () => {
      this.moveListeners.delete(listener);
    };
  }

  /**
   * An inbox said it is now at `to` (a hosted inbox gone live at the business's own name, `movedTo`).
   * The move is kept only once the inbox at `to` takes this phone's refresh token with a proof signed
   * for `to`: only the inbox that issued the token can, so an address that is not that inbox moves
   * nothing. The phone's keys, tokens and cache stay as they are, under the same alias.
   */
  async follow(entry: InboxEntry, to: string): Promise<InboxEntry> {
    const origin = inboxOrigin(to);
    if (!origin) throw new InboxError("That is not an inbox's address.", 400, "invalid_input");
    const current = (await this.list()).find((e) => e.alias === entry.alias);
    if (!current) throw new InboxError("This phone is signed out of this inbox.", 401, "signed_out");
    if (current.origin === origin) return current;
    const running = this.following.get(entry.alias);
    if (running) return running;
    const work = (async () => {
      const moved: InboxEntry = { ...current, origin };
      await this.token(moved, true);
      const list = await this.list();
      await this.saveList(list.map((e) => (e.alias === entry.alias ? { ...e, origin } : e)));
      for (const listener of this.moveListeners) listener(moved, current.origin);
      return moved;
    })().finally(() => this.following.delete(entry.alias));
    this.following.set(entry.alias, work);
    return work;
  }

  /** Signs this phone out of an inbox: the inbox forgets it (when it can be reached), and so does the phone. */
  async remove(entry: InboxEntry): Promise<void> {
    const signOut = async (at: InboxEntry) => {
      const res = await this.fetchImpl(`${at.origin}/v1/phone`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await this.token(at)}` },
      });
      if (res.status === 404) throw await problem(res);
    };
    try {
      try {
        await signOut(entry);
      } catch (error) {
        // At its new address now: signed out there, or the inbox would go on sending to this phone.
        const to = movedTo(error);
        if (!to) throw error;
        await signOut(await this.follow(entry, to));
      }
    } catch {
      // Offline or already removed there: the owner can remove it in Settings → Phone too.
    }
    await this.forget(entry);
  }

  /**
   * Forgets an inbox on this phone only (it was removed on the inbox's side): its tokens, its keys
   * (device and push) and what was registered for it. The app wipes its cached items too (`Box`).
   */
  async forget(entry: InboxEntry): Promise<void> {
    this.access.delete(entry.alias);
    await this.native.secureRemove(tokenKey(entry.alias));
    await this.native.secureRemove(pushSentKey(entry.alias));
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
