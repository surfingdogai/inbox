import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { hashApiKey } from "../access/keys";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import { ensureJob } from "../jobs/schedule";
import { business, phoneDevices, phonePairings } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { WriteError } from "../write/errors";
import {
  b64uDecode,
  cleanDeviceKey,
  encryptPush,
  jwkThumbprint,
  opaqueKey,
  PROOF_SKEW_MS,
  pairingMatch,
  pkceS256,
  proofStatement,
  sha256b64u,
  verifyProof,
} from "./crypto";
import { shownPhoneName } from "./names";
import { encodePayload, testPayload } from "./payload";
import { DEFAULT_PREFS, type NotifyPrefs, notifyPrefsSchema, readPrefs } from "./prefs";
import type { PushRelay, RelayRegistration } from "./relay";

/**
 * The owner's phones (ADR-028). A phone is paired from the owner app (Settings → Phone): a QR code
 * carries the inbox's address and a one-time secret that works once, for five minutes. The phone
 * scans it and trades it, with a proof signed by a device key it made in its own keystore, for a
 * refresh token bound to that key and short access tokens to the owner's API. Or the owner asks on
 * the phone for a sign-in link by email; the phone holds the PKCE verifier, so the link is useless to
 * any other app that opens it.
 *
 * A code on a screen can be seen by someone else (a screen share, a photo, over a shoulder), so a phone
 * paired with one waits: the owner app shows "Pixel 8 wants to connect · 47", the phone shows the same
 * two digits and the inbox's address, and only the owner's Confirm on the computer lets the phone in.
 * Until then its tokens open `GET /v1/phone/me` and nothing else, and five minutes without an answer
 * remove it. A phone connected by an emailed link needs no confirming: the mailbox was the proof.
 *
 * Unless the owner has a phone already that can say yes (ADR-028 Amendment 4): confirmed, and signed in
 * within its refresh token's two months. Then a new phone that came by a link the inbox's host made
 * after its own email code waits for that phone's yes: the same two digits on both screens, and
 * Confirm or "Not mine" on the phone the owner has. An owner who has lost that phone says so, and the
 * new one waits a day (three, when none of the owner's phones would hear of it) while every phone and
 * the email are told, each with a way to stop it. A phone stopped so pauses new links for a day, and
 * the owner is told that someone used a code sent to them. Emailed links wait the same way only once
 * `emailedLinksWait` is on: the phone app released before Amendment 4 cannot wait.
 *
 * What this does not do: a code read out to a phisher, who began the sign-in and so holds its
 * verifier, opens a first phone at once (the owner is told after, by email). And the same mailbox's
 * code signs in to the owner app on the web, whose QR code a computer confirms with no phone's yes.
 *
 * A phone acts as the owner in person, through the owner's API only, and only for what the phone
 * app does: the inbox, its items and their answers. Everything else (settings, keys, money floors,
 * downloads) stays the owner app's on a computer, whatever the phone's tokens say.
 */
export const PAIRING_PREFIX = "sdi_pp_";
export const PHONE_ACCESS_PREFIX = "sdi_pa_";
export const PHONE_REFRESH_PREFIX = "sdi_pr_";
/** A QR code works for five minutes; a link in an email for fifteen. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const LINK_TTL_MS = 15 * 60_000;
/** Access tokens last ten minutes; the refresh token two months, renewed on every use. */
export const PHONE_ACCESS_TTL_MS = 10 * 60_000;
export const PHONE_REFRESH_TTL_MS = 60 * 86_400_000;
/** A lost answer to a refresh may be asked again this long after it, by the same phone. */
export const REFRESH_GRACE_MS = 60_000;
/** A phone paired by QR code waits this long for the owner's Confirm on the computer, then goes. */
export const CONFIRM_TTL_MS = 5 * 60_000;
/** A link the inbox's host makes after its own email code: the phone redeems it at once. */
export const HOST_LINK_TTL_MS = 10 * 60_000;
/** A phone that came by a link waits this long for the owner's other phone to say yes, then goes. */
export const PHONE_CONFIRM_TTL_MS = 15 * 60_000;
/** "I don't have my other phone": the new phone is let in a day later, unless it was stopped. */
export const WAIT_MS = 24 * 3_600_000;
/** The same, when none of the owner's phones would hear of it (notifications off, or not seen in a month). */
export const WAIT_LONG_MS = 72 * 3_600_000;
/** A phone heard from this recently, with notifications on, is told of a new phone at once. */
export const HEARD_FROM_MS = 30 * 86_400_000;
/** After a new phone was stopped ("Not mine", or the email's "Stop it"), no new link is made for this long. */
export const STOPPED_PAUSE_MS = 24 * 3_600_000;
/** After that day, it has this long to come back and be let in; then it goes. */
export const WAIT_GRACE_MS = 7 * 86_400_000;
/** The job that asks the owner's other phones about a new one (ADR-028 Amendment 4). */
export const PHONE_ASK_KIND = "phone_ask";
/** Phones one inbox may have at once. */
export const MAX_PHONES = 20;
/** Wrong verifiers a sign-in link takes before it stops working. */
export const MAX_LINK_ATTEMPTS = 3;
/** Sign-in links one owner address is sent in an hour. */
export const MAX_LINKS_PER_HOUR = 3;
/** `last_seen_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;

export type PushState = "off" | "on" | "lost" | "error" | "unavailable";

/** A phone as Settings → Phone lists it. Nothing secret. */
export interface PhoneView {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  /** Whether notifications reach it: `on`, `off` (never set up), `lost` (its app is gone), `error`. */
  readonly push: PushState;
  readonly push_error: string | null;
}

export interface PhoneTokens {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly device_id: string;
}

export interface PhonePrincipal {
  readonly deviceId: string;
  readonly userId: string;
  readonly name: string;
  /** False while a phone paired by QR code waits for the owner's Confirm: it may only ask who it is. */
  readonly confirmed: boolean;
  /**
   * Where the yes comes from while it waits: the computer (a QR code) or the owner's other phone (a
   * phone that came by a link while its owner had a confirmed phone). Null once confirmed.
   */
  readonly waitsOn: "computer" | "phone" | null;
}

/** How a phone came: a QR code, an emailed link, or a link from the inbox's host. */
export type PhoneVia = "qr" | "link" | "host";

/** A new phone waiting for the yes of one the owner has (`GET /v1/phone/pairings`). */
export interface PhoneAsk {
  readonly id: string;
  readonly phone: PhoneView;
  /** The two digits the new phone shows. */
  readonly match: string;
  /** "I don't have my other phone": when it is let in unless stopped; null while it waits for a yes. */
  readonly wait_until: string | null;
}

/** What became of a QR code, as Settings → Phone polls it. */
export type PairingState =
  | { readonly state: "waiting" | "expired" }
  | { readonly state: "confirm"; readonly phone: PhoneView; readonly match: string }
  | { readonly state: "paired"; readonly phone?: PhoneView };

interface SealedPush {
  readonly device: string;
  readonly secret: string;
  readonly p256dh: string;
  readonly auth: string;
}

type DeviceRow = typeof phoneDevices.$inferSelect;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * A phone as the owner is shown it. Its name is its own say: shown only when it reads like a phone's,
 * else its kind (`shownPhoneName`), wherever the owner reads it, the confirm sheet and the emails too.
 */
function viewOf(row: DeviceRow): PhoneView {
  return {
    id: row.id,
    name: shownPhoneName(row.name, row.platform),
    platform: row.platform,
    created_at: new Date(row.createdAt).toISOString(),
    last_seen_at: iso(row.lastSeenAt),
    push: row.pushState as PushState,
    push_error: row.pushError,
  };
}

/**
 * A phone's name as it sends it, on one line and short: "Pixel 8", "Galaxy S24". Kept as sent; the owner
 * is shown it only when it reads like a phone's (`viewOf`).
 */
export function cleanPhoneName(value: unknown): string {
  const s = typeof value === "string" ? value.replace(/[\p{C}\s]+/gu, " ").trim() : "";
  return (s || "Phone").slice(0, 60);
}

function cleanPlatform(value: unknown): "android" | "ios" {
  return value === "ios" ? "ios" : "android";
}

const bad = (message: string, path?: string) =>
  new WriteError("invalid_input", message, path ? { fields: [{ path, problem: "invalid", message }] } : undefined);

/**
 * Who a phone's access token is: the phone and the owner it signs in as. Null when unknown, expired
 * or removed. A function of the database alone, so the doors resolve it as they resolve keys.
 */
export async function resolvePhoneAccess(db: Db, token: string, now: number): Promise<PhonePrincipal | null> {
  if (!token.startsWith(PHONE_ACCESS_PREFIX)) return null;
  const { rows } = await db.client.query({
    sql: `SELECT d.id, d.user_id, d.name, d.last_seen_at, d.confirmed_at, d.created_at, d.via, d.confirm_by, d.platform
            FROM phone_tokens t JOIN phone_devices d ON d.id = t.device_id
           WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
             AND d.revoked_at IS NULL`,
    params: [await hashApiKey(token), now],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  const [deviceId, userId, name, lastSeen, confirmedAt, createdAt, via, confirmBy, platform] = r as [
    string,
    string,
    string,
    number | null,
    number | null,
    number,
    string | null,
    number | null,
    string | null,
  ];
  // A phone nobody confirmed is gone once its minutes (or its day's wait) are up.
  if (confirmedAt === null && now > waitsUntil(createdAt, confirmBy)) return null;
  if (lastSeen === null || now - lastSeen >= TOUCH_EVERY_MS) {
    await db.client.query({
      sql: "UPDATE phone_devices SET last_seen_at = ? WHERE id = ?",
      params: [now, deviceId],
      method: "run",
    });
  }
  return {
    deviceId,
    userId,
    // What the item's history names it by, read by the owner as the sheet's words are.
    name: shownPhoneName(name, platform),
    confirmed: confirmedAt !== null,
    waitsOn: confirmedAt !== null ? null : waitsOnOf(via),
  };
}

/** Until when a phone nobody confirmed may still be confirmed: its own deadline, else a QR code's minutes. */
function waitsUntil(createdAt: number, confirmBy: number | null): number {
  return confirmBy ?? createdAt + CONFIRM_TTL_MS;
}

/** Who says yes to a phone that waits: the computer for a QR code, the owner's other phone for a link. */
function waitsOnOf(via: string | null): "computer" | "phone" {
  return via === "link" || via === "host" ? "phone" : "computer";
}

/**
 * How long "I don't have my other phone" waits: a day when one of the owner's phones would hear of it
 * at once (notifications on, and heard from in the last month), else three, for the owner to open the
 * app on one of them, where the sheet asks.
 */
function waitMs(answering: readonly DeviceRow[], now: number): number {
  const heard = answering.some((d) => d.pushState === "on" && (d.lastSeenAt ?? d.createdAt) > now - HEARD_FROM_MS);
  return heard ? WAIT_MS : WAIT_LONG_MS;
}

export class PhoneCapabilities {
  private relay: PushRelay | null = null;
  private hosted = false;
  /**
   * Whether a phone that came by an emailed link waits for the owner's other phone too, as one that
   * came by the host's link does. Off until the phone app that can wait is the oldest in use: the app
   * released before Amendment 4 (1.0.0) keeps a waiting phone as connected, and is stuck with it.
   */
  emailedLinksWait = false;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
  ) {}

  /**
   * How push reaches the phones: the host's relay, or none (`INBOX_PUSH_RELAY=off`). `hosted`: the
   * inbox is one a host runs for the business, whose owner has no server settings to change.
   */
  attachRelay(relay: PushRelay | null, opts: { hosted?: boolean } = {}): void {
    this.relay = relay;
    this.hosted = opts.hosted === true;
  }

  /**
   * Whether notifications can work here, and if not why: the relay is off, or there is no
   * `INBOX_SECRET_KEY` to seal what push needs (the relay's secret, the phone's push keys).
   */
  pushAvailability(): { available: boolean; reason: "no_relay" | "no_secret_key" | null; hosted: boolean } {
    const hosted = this.hosted;
    if (!this.relay) return { available: false, reason: "no_relay", hosted };
    if (!this.secrets) return { available: false, reason: "no_secret_key", hosted };
    return { available: true, reason: null, hosted };
  }

  // ---- the owner app: pairing, the list, removing ----

  /** A one-time secret for a QR code, for the owner signed in, in person. */
  async createPairing(userId: string, now: number): Promise<{ id: string; secret: string; expiresAt: number }> {
    const live = await this.livePhones();
    if (live.length >= MAX_PHONES)
      throw new WriteError("not_allowed", `This inbox has ${MAX_PHONES} phones already. Remove one first.`, {
        details: { reason: "too_many_phones" },
      });
    // An owner who presses "Add a phone" twice gets two codes; one that leaves a page open for an
    // hour does not keep making rows: codes past their minutes go when the next is made.
    await this.db.client.batch([
      {
        sql: "DELETE FROM phone_pairings WHERE used_at IS NULL AND expires_at < ?",
        params: [now - 86_400_000],
        method: "run",
      },
      ...this.dropUnconfirmed(now),
    ]);
    const id = ulid(now);
    const secret = `${PAIRING_PREFIX}${randomToken(32)}`;
    await this.db.orm.insert(phonePairings).values({
      id,
      secretHash: await hashApiKey(secret),
      kind: "qr",
      userId,
      expiresAt: now + PAIRING_TTL_MS,
      createdAt: now,
    });
    return { id, secret, expiresAt: now + PAIRING_TTL_MS };
  }

  /**
   * What became of a QR code: still waiting; used by a phone that waits for the owner's Confirm (which
   * phone, and the two digits it shows); confirmed; or past its minutes, or refused.
   */
  async pairingStatus(userId: string, id: string, now: number): Promise<PairingState> {
    const row = await this.pairingRow(userId, id);
    if (row.usedAt === null || !row.deviceId) return { state: row.expiresAt > now ? "waiting" : "expired" };
    const [device] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, row.deviceId));
    if (!device || device.revokedAt !== null) return { state: "expired" };
    if (device.confirmedAt !== null) return { state: "paired", phone: viewOf(device) };
    if (now - device.createdAt > CONFIRM_TTL_MS) {
      await this.removePhone(device.id, now);
      return { state: "expired" };
    }
    return { state: "confirm", phone: viewOf(device), match: device.pairMatch ?? "" };
  }

  /**
   * The owner's Confirm on the computer: the phone that used this code may now open the inbox. Only a
   * phone still waiting, within its minutes.
   */
  async confirmPairing(userId: string, id: string, now: number): Promise<PhoneView> {
    const row = await this.pairingRow(userId, id);
    const gone = () =>
      new WriteError("code_expired", "That phone waited too long, or was removed. Show a new code.", {
        details: { reason: "not_waiting" },
      });
    if (!row.deviceId) throw gone();
    const r = await this.db.client.query({
      sql: "UPDATE phone_devices SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND revoked_at IS NULL AND created_at >= ?",
      params: [now, row.deviceId, now - CONFIRM_TTL_MS],
      method: "run",
    });
    if (r.changes !== 1) throw gone();
    const [device] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, row.deviceId));
    if (!device) throw gone();
    return viewOf(device);
  }

  /** "Not mine": the phone that used this code is removed before it could do anything. */
  async refusePairing(userId: string, id: string, now: number): Promise<{ removed: boolean }> {
    const row = await this.pairingRow(userId, id);
    if (!row.deviceId) return { removed: false };
    const [device] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, row.deviceId));
    if (!device || device.revokedAt !== null || device.confirmedAt !== null) return { removed: false };
    await this.removePhone(device.id, now);
    return { removed: true };
  }

  private async pairingRow(userId: string, id: string): Promise<typeof phonePairings.$inferSelect> {
    const [row] = await this.db.orm
      .select()
      .from(phonePairings)
      .where(and(eq(phonePairings.id, id), eq(phonePairings.userId, userId), eq(phonePairings.kind, "qr")));
    if (!row) throw new WriteError("not_found", "No such code.");
    return row;
  }

  /**
   * Phones nobody confirmed in time, removed with their tokens: a QR code's after its minutes, one that
   * came by a link after its own deadline (the other phone's minutes, or the day's wait and a week).
   */
  private dropUnconfirmed(now: number): { sql: string; params: (string | number | null)[]; method: "run" }[] {
    const late = "confirmed_at IS NULL AND revoked_at IS NULL AND COALESCE(confirm_by, created_at + ?) < ?";
    return [
      {
        sql: `UPDATE phone_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND device_id IN
                (SELECT id FROM phone_devices WHERE ${late})`,
        params: [now, CONFIRM_TTL_MS, now],
        method: "run",
      },
      {
        sql: `UPDATE phone_devices SET revoked_at = ? WHERE ${late}`,
        params: [now, CONFIRM_TTL_MS, now],
        method: "run",
      },
    ];
  }

  /**
   * The hourly tidy: phones nobody confirmed, and tokens that can no longer be used for anything
   * (expired, or spent or revoked longer ago than a lost answer may be asked again).
   */
  async prune(now: number): Promise<void> {
    await this.db.client.batch([
      ...this.dropUnconfirmed(now),
      {
        sql: "DELETE FROM phone_tokens WHERE expires_at < ? OR revoked_at < ?",
        params: [now - REFRESH_GRACE_MS, now - REFRESH_GRACE_MS],
        method: "run",
      },
    ]);
  }

  /** The person a phone signs in as. */
  async ownerOf(deviceId: string): Promise<string> {
    return (await this.device(deviceId)).userId;
  }

  /** The phones connected (confirmed), every owner's or one person's. A phone waiting for Confirm is not one yet. */
  async listPhones(userId?: string): Promise<PhoneView[]> {
    const rows = await this.db.orm
      .select()
      .from(phoneDevices)
      .where(
        and(
          isNull(phoneDevices.revokedAt),
          isNotNull(phoneDevices.confirmedAt),
          ...(userId ? [eq(phoneDevices.userId, userId)] : []),
        ),
      )
      .orderBy(phoneDevices.createdAt);
    return rows.map(viewOf);
  }

  /** Every phone not removed, waiting ones included: what the limit counts. */
  private async livePhones(): Promise<DeviceRow[]> {
    return this.db.orm.select().from(phoneDevices).where(isNull(phoneDevices.revokedAt));
  }

  private async device(id: string): Promise<DeviceRow> {
    const [row] = await this.db.orm
      .select()
      .from(phoneDevices)
      .where(and(eq(phoneDevices.id, id), isNull(phoneDevices.revokedAt)));
    if (!row) throw new WriteError("not_found", "No such phone here.");
    return row;
  }

  /**
   * Removes a phone: its tokens stop at once, and the relay forgets it. Whatever the relay answers,
   * the phone is out: a relay that cannot be reached only means the phone may get one more
   * notification it cannot open, which it then drops.
   */
  async removePhone(id: string, now: number): Promise<{ removed: true }> {
    const row = await this.device(id);
    const reg = await this.registration(row).catch(() => null);
    await this.db.client.batch([
      {
        sql: "UPDATE phone_devices SET revoked_at = ?, push_state = 'off', push_device = NULL, push_enc = NULL WHERE id = ? AND revoked_at IS NULL",
        params: [now, id],
        method: "run",
      },
      {
        sql: "UPDATE phone_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        params: [now, id],
        method: "run",
      },
    ]);
    if (reg && this.relay) await this.relay.remove(reg).catch(() => undefined);
    return { removed: true };
  }

  // ---- the phone: pairing, the sign-in link, tokens ----

  /**
   * A phone trades a QR code's secret for its tokens. `proof` signs `proofStatement("pair", origin,
   * sha256(secret), at)` with the device key the phone sends, which proves it holds that key; the
   * secret is spent in the same write that makes the phone, so two phones racing with one code get
   * one phone between them.
   */
  async pair(
    input: Readonly<Record<string, unknown>>,
    origin: string,
    now: number,
  ): Promise<PhoneTokens & { state: "pending"; match: string }> {
    const secret = typeof input.secret === "string" ? input.secret : "";
    if (!secret.startsWith(PAIRING_PREFIX)) throw bad("That is not a code from Settings → Phone.", "secret");
    const key = await this.checkProof(input, "pair", origin, await sha256b64u(secret), now);
    const [row] = await this.db.orm
      .select()
      .from(phonePairings)
      .where(and(eq(phonePairings.secretHash, await hashApiKey(secret)), eq(phonePairings.kind, "qr")));
    if (!row || row.usedAt !== null || row.expiresAt <= now)
      throw new WriteError(
        "code_expired",
        "That code has expired or was used already. Show a new one in Settings → Phone.",
      );
    await this.db.client.batch(this.dropUnconfirmed(now));
    const match = await pairingMatch(secret, await jwkThumbprint(key));
    // Waits for the owner's Confirm on the computer, where the same two digits show.
    const tokens = await this.makePhone(row.id, row.userId, key, input, now, { match, via: "qr" });
    return { ...tokens, state: "pending", match };
  }

  /**
   * "Email me a sign-in link instead": a link to the owner's address, when it is one. The answer is
   * the same either way, so nobody learns from it who signs in here. `challenge` is the S256 of a
   * verifier only the asking phone holds, and `device_key` the key it will prove itself with.
   */
  async startLink(
    input: { email: unknown; challenge: unknown; device_key: unknown },
    now: number,
  ): Promise<{ secret: string; email: string; userId: string } | null> {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw bad("Type your email address.", "email");
    const challenge = typeof input.challenge === "string" ? input.challenge : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw bad("challenge must be a PKCE S256 challenge", "challenge");
    const key = cleanDeviceKey(input.device_key);
    if (!key) throw bad("device_key must be a public P-256 JWK", "device_key");
    const { rows } = await this.db.client.query({
      sql: "SELECT id FROM users WHERE lower(email) = ? AND role = 'owner' LIMIT 1",
      params: [email],
      method: "all",
    });
    const userId = rows[0]?.[0];
    if (typeof userId !== "string") return null;
    // The day after a new phone was stopped, nothing is sent: the same answer, as for anyone.
    if (await this.linksPaused(userId, now)) return null;
    const sent = await this.db.client.query({
      sql: "SELECT COUNT(*) FROM phone_pairings WHERE user_id = ? AND kind = 'link' AND created_at > ?",
      params: [userId, now - 3_600_000],
      method: "all",
    });
    if (Number(sent.rows[0]?.[0] ?? 0) >= MAX_LINKS_PER_HOUR) return null;
    const secret = `${PAIRING_PREFIX}${randomToken(32)}`;
    await this.db.orm.insert(phonePairings).values({
      id: ulid(now),
      secretHash: await hashApiKey(secret),
      kind: "link",
      userId,
      codeChallenge: challenge,
      deviceKey: await jwkThumbprint(key),
      expiresAt: now + LINK_TTL_MS,
      createdAt: now,
    });
    return { secret, email, userId };
  }

  /**
   * A link the inbox's host makes for its owner, right after the host's own email code proved the
   * address (ADR-028 Amendment 4): kept as an emailed link is, with no email sent from here, and
   * redeemed the same way, by the phone that holds the verifier and the device key. The owner's user
   * is made when the host names the address as the owner and nobody has signed in yet, as a first
   * handoff does; any other address that is not an owner here gets nothing.
   */
  async hostLink(
    input: { email: unknown; owner: unknown; challenge: unknown; device_key: unknown },
    now: number,
  ): Promise<{ secret: string; expiresAt: number; userId: string }> {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw bad("email must be the owner's address", "email");
    const challenge = typeof input.challenge === "string" ? input.challenge : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw bad("challenge must be a PKCE S256 challenge", "challenge");
    const key = cleanDeviceKey(input.device_key);
    if (!key) throw bad("device_key must be a public P-256 JWK", "device_key");
    const owner = typeof input.owner === "string" ? input.owner.trim().toLowerCase() : "";
    const userId = await this.ownerUser(email, owner, now);
    if (!userId)
      throw new WriteError("not_allowed", "That address does not sign in to this inbox.", {
        details: { reason: "not_owner" },
      });
    if (await this.linksPaused(userId, now))
      throw new WriteError("not_allowed", "A new phone was stopped, so new phones can't connect for a day after it.", {
        details: { reason: "phone_paused" },
      });
    const secret = `${PAIRING_PREFIX}${randomToken(32)}`;
    await this.db.orm.insert(phonePairings).values({
      id: ulid(now),
      secretHash: await hashApiKey(secret),
      kind: "host",
      userId,
      codeChallenge: challenge,
      deviceKey: await jwkThumbprint(key),
      expiresAt: now + HOST_LINK_TTL_MS,
      createdAt: now,
    });
    return { secret, expiresAt: now + HOST_LINK_TTL_MS, userId };
  }

  /**
   * The owner a host's link is for: the owner here with that address, or, on an inbox nobody has signed
   * in to yet, the address the host names as its owner, made the owner now. Null for anyone else.
   */
  private async ownerUser(email: string, owner: string, now: number): Promise<string | null> {
    const find = async () =>
      (
        await this.db.client.query({
          sql: "SELECT id, role FROM users WHERE lower(email) = ? LIMIT 1",
          params: [email],
          method: "all",
        })
      ).rows[0];
    const found = await find();
    if (found) return found[1] === "owner" ? String(found[0]) : null;
    if (!owner || email !== owner) return null;
    const { rows: anyone } = await this.db.client.query({ sql: "SELECT 1 FROM users LIMIT 1", method: "all" });
    if (anyone.length > 0) return null;
    await this.db.client.query({
      sql: "INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (email) DO NOTHING",
      params: [ulid(now), email, now],
      method: "run",
    });
    const made = await find();
    return made && made[1] === "owner" ? String(made[0]) : null;
  }

  /**
   * The phone that asked for the link redeems it, with its verifier and a proof from the same key. The
   * owner's mailbox was the proof, unless the owner has a phone already that can say yes and the link
   * is the host's (or `emailedLinksWait` is on): then the new phone waits for that phone's yes, showing
   * the same two digits (`state: "pending"`), and the owner's other phones are asked. `wait_hours` is
   * how long "I don't have my other phone" would then make it wait.
   */
  async redeemLink(
    input: Readonly<Record<string, unknown>>,
    origin: string,
    now: number,
  ): Promise<
    PhoneTokens & { state: "connected" | "pending"; match?: string; via: "link" | "host"; wait_hours?: number }
  > {
    const secret = typeof input.secret === "string" ? input.secret : "";
    const verifier = typeof input.verifier === "string" ? input.verifier : "";
    if (!secret.startsWith(PAIRING_PREFIX)) throw bad("That is not a sign-in link from this inbox.", "secret");
    if (verifier.length < 43 || verifier.length > 128) throw bad("verifier must be 43 to 128 characters", "verifier");
    const key = await this.checkProof(input, "link", origin, await sha256b64u(secret), now);
    const [row] = await this.db.orm
      .select()
      .from(phonePairings)
      .where(
        and(eq(phonePairings.secretHash, await hashApiKey(secret)), inArray(phonePairings.kind, ["link", "host"])),
      );
    const expired = () =>
      new WriteError("code_expired", "That link has expired or was used already. Ask for a new one on the phone.");
    if (!row || row.usedAt !== null || row.expiresAt <= now || row.attempts >= MAX_LINK_ATTEMPTS) throw expired();
    const thumb = await jwkThumbprint(key);
    if (row.deviceKey !== thumb || (await pkceS256(verifier)) !== row.codeChallenge) {
      await this.db.client.query({
        sql: "UPDATE phone_pairings SET attempts = attempts + 1 WHERE id = ?",
        params: [row.id],
        method: "run",
      });
      throw new WriteError("not_allowed", "Open the link on the phone that asked for it.", {
        details: { reason: "other_phone" },
      });
    }
    const via = row.kind === "host" ? "host" : "link";
    await this.db.client.batch(this.dropUnconfirmed(now));
    const asks = via === "host" || this.emailedLinksWait;
    const answering = asks ? await this.answeringPhones(row.userId, now) : [];
    if (answering.length === 0) {
      // The owner's mailbox was the proof, and there is no other phone to ask: nothing to confirm.
      const tokens = await this.makePhone(row.id, row.userId, key, input, now, { match: null, via });
      return { ...tokens, state: "connected", via };
    }
    // A phone the owner has says yes first: the same two digits on both screens.
    const match = await pairingMatch(secret, thumb);
    const tokens = await this.makePhone(row.id, row.userId, key, input, now, {
      match,
      via,
      confirmBy: now + PHONE_CONFIRM_TTL_MS,
    });
    await this.ask(tokens.device_id, "ask", now);
    return { ...tokens, state: "pending", match, via, wait_hours: waitMs(answering, now) / 3_600_000 };
  }

  /**
   * The owner's phones that can say yes to a new one: confirmed, with a refresh token still good
   * (signed in within its two months), and with an app that can. A phone not used since, or whose app
   * was removed long ago, can never answer, so it makes no new phone wait; nor does one whose app was
   * released before Amendment 4 (1.0.x), which has no sheet to say yes on. One that came by the host's
   * link can (only the app that says yes signs in that way); one that came by a QR code or an emailed
   * link can once its app looked for new phones (`answersAt`, `phoneAsks`).
   */
  private async answeringPhones(userId: string, now: number): Promise<DeviceRow[]> {
    const rows = (
      await this.db.orm
        .select()
        .from(phoneDevices)
        .where(
          and(eq(phoneDevices.userId, userId), isNull(phoneDevices.revokedAt), isNotNull(phoneDevices.confirmedAt)),
        )
    ).filter((r) => r.via === "host" || r.answersAt !== null);
    if (rows.length === 0) return [];
    const { rows: live } = await this.db.client.query({
      sql: `SELECT DISTINCT device_id FROM phone_tokens WHERE kind = 'refresh' AND revoked_at IS NULL AND expires_at > ?
              AND device_id IN (${rows.map(() => "?").join(", ")})`,
      params: [now, ...rows.map((r) => r.id)],
      method: "all",
    });
    const ok = new Set(live.map((r) => String(r[0])));
    return rows.filter((r) => ok.has(r.id));
  }

  /** Whether new links wait: a new phone of this person was stopped ("Not mine", "Stop it") in the last day. */
  private async linksPaused(userId: string, now: number): Promise<boolean> {
    const { rows } = await this.db.client.query({
      sql: "SELECT 1 FROM phone_devices WHERE user_id = ? AND stopped_at IS NOT NULL AND stopped_at > ? LIMIT 1",
      params: [userId, now - STOPPED_PAUSE_MS],
      method: "all",
    });
    return rows.length > 0;
  }

  /** Asks the owner's other phones about a waiting one, by a notification each (`PHONE_ASK_KIND`). */
  private async ask(deviceId: string, why: "ask" | "wait", now: number, hours?: number): Promise<void> {
    await ensureJob(this.db, PHONE_ASK_KIND, `${PHONE_ASK_KIND}:${deviceId}:${why}`, {
      now,
      payload: { deviceId, wait: why === "wait", ...(hours ? { hours } : {}) },
    }).catch(() => undefined);
  }

  /**
   * A new phone the owner may be asked about: still waiting for a yes (or for its day to pass), and
   * whose owner it is. Null once it was let in, stopped, or ran out of time.
   */
  async waiting(deviceId: string, now: number): Promise<DeviceRow | null> {
    const [row] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, deviceId));
    if (!row || row.revokedAt !== null || row.confirmedAt !== null || waitsOnOf(row.via) !== "phone") return null;
    return now > waitsUntil(row.createdAt, row.confirmBy) ? null : row;
  }

  /** One of the owner's phones that may answer for a new one: confirmed itself, never one that waits. */
  private async answering(deviceId: string): Promise<DeviceRow> {
    const me = await this.device(deviceId);
    if (me.confirmedAt === null)
      throw new WriteError("not_allowed", "Confirm this phone first.", { details: { reason: "phone_unconfirmed" } });
    return me;
  }

  /**
   * The new phones that wait for a yes from one of this person's phones: what its confirm sheet shows.
   * A phone whose app asks can say yes: from now on new phones wait for it (`answeringPhones`).
   */
  async phoneAsks(deviceId: string, now: number): Promise<PhoneAsk[]> {
    const me = await this.answering(deviceId);
    if (me.answersAt === null)
      await this.db.client.query({
        sql: "UPDATE phone_devices SET answers_at = ? WHERE id = ? AND answers_at IS NULL",
        params: [now, deviceId],
        method: "run",
      });
    const rows = await this.db.orm
      .select()
      .from(phoneDevices)
      .where(
        and(
          eq(phoneDevices.userId, me.userId),
          isNull(phoneDevices.revokedAt),
          isNull(phoneDevices.confirmedAt),
          inArray(phoneDevices.via, ["link", "host"]),
        ),
      )
      .orderBy(phoneDevices.createdAt);
    return rows
      .filter((r) => r.id !== deviceId && now <= waitsUntil(r.createdAt, r.confirmBy))
      .map((r) => ({ id: r.id, phone: viewOf(r), match: r.pairMatch ?? "", wait_until: iso(r.waitUntil) }));
  }

  /**
   * Confirm, on one of the owner's phones: the new phone that shows the same two digits may now open
   * the inbox. Signed with the confirming phone's device key, which signs only shortly after the owner
   * unlocked it: a yes is a person's, after their fingerprint or face, never a notification's.
   */
  async confirmByPhone(
    deviceId: string,
    id: string,
    input: { at?: unknown; proof?: unknown },
    origin: string,
    now: number,
  ): Promise<{ phone: PhoneView; by: PhoneView }> {
    const me = await this.answering(deviceId);
    await this.checkProof(
      { ...input, device_key: JSON.parse(me.keyJwk) },
      "confirm",
      origin,
      await sha256b64u(id),
      now,
    );
    const r = await this.db.client.query({
      sql: `UPDATE phone_devices SET confirmed_at = ?, confirm_by = NULL, stop_hash = NULL
             WHERE id = ? AND user_id = ? AND confirmed_at IS NULL AND revoked_at IS NULL AND via IN ('link', 'host')
               AND COALESCE(confirm_by, 0) >= ?`,
      params: [now, id, me.userId, now],
      method: "run",
    });
    if (r.changes !== 1)
      throw new WriteError("code_expired", "That phone waited too long, or was removed. Ask it to sign in again.", {
        details: { reason: "not_waiting" },
      });
    const [phone] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, id));
    if (!phone) throw new WriteError("not_found", "No such phone here.");
    return { phone: viewOf(phone), by: viewOf(me) };
  }

  /**
   * "Not mine", on one of the owner's phones: the new phone is removed before it could open anything,
   * and no new link is made for a day (`linksPaused`). The caller tells the owner that someone used a
   * code or a link sent to them.
   */
  async refuseByPhone(deviceId: string, id: string, now: number): Promise<{ removed: boolean; phone?: PhoneView }> {
    const me = await this.answering(deviceId);
    const row = await this.waiting(id, now);
    if (!row || row.userId !== me.userId) return { removed: false };
    await this.stop(row.id, now);
    return { removed: true, phone: viewOf(row) };
  }

  /** A new phone stopped: removed, and marked so that new links wait a day. */
  private async stop(id: string, now: number): Promise<void> {
    await this.removePhone(id, now);
    await this.db.client.query({
      sql: "UPDATE phone_devices SET stopped_at = ? WHERE id = ?",
      params: [now, id],
      method: "run",
    });
  }

  /**
   * "I don't have my other phone", on the new phone: it is let in a day from now (three, when none of
   * the owner's phones would hear of it), unless one of the owner's phones or the owner's email stops
   * it before. Every phone is asked again, and the caller emails the owner the token of the email's
   * "Not you? Stop it" link.
   */
  async startWait(deviceId: string, now: number): Promise<{ waitUntil: number; stopToken: string; hours: number }> {
    const me = await this.device(deviceId);
    const wait = waitMs(await this.answeringPhones(me.userId, now), now);
    const waitUntil = now + wait;
    const stopToken = randomToken(32);
    const r = await this.db.client.query({
      sql: `UPDATE phone_devices SET wait_until = ?, confirm_by = ?, stop_hash = ?
             WHERE id = ? AND confirmed_at IS NULL AND revoked_at IS NULL AND via IN ('link', 'host')
               AND wait_until IS NULL AND COALESCE(confirm_by, 0) >= ?`,
      params: [waitUntil, waitUntil + WAIT_GRACE_MS, await hashApiKey(stopToken), deviceId, now],
      method: "run",
    });
    if (r.changes !== 1)
      throw new WriteError("wrong_state", "This phone is not waiting for another phone's yes.", {
        details: { reason: "not_waiting" },
      });
    await this.ask(deviceId, "wait", now, wait / 3_600_000);
    return { waitUntil, stopToken, hours: wait / 3_600_000 };
  }

  /** The phone a "Not you? Stop it" link is about, while it still waits for its day; null otherwise. */
  async stoppable(token: string, now: number): Promise<DeviceRow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [row] = await this.db.orm
      .select()
      .from(phoneDevices)
      .where(eq(phoneDevices.stopHash, await hashApiKey(token)));
    if (!row?.waitUntil) return null;
    return (await this.waiting(row.id, now)) ? row : null;
  }

  /** "Not you? Stop it", from the owner's email: the waiting phone is removed, and new links wait a day. */
  async stopWait(token: string, now: number): Promise<{ removed: boolean; phone?: PhoneView; userId?: string }> {
    const row = await this.stoppable(token, now);
    if (!row) return { removed: false };
    await this.stop(row.id, now);
    return { removed: true, phone: viewOf(row), userId: row.userId };
  }

  /**
   * The new phone, back after its day: let in, when nothing stopped it (a stopped phone is removed, so
   * it never gets here). True when it was let in just now.
   */
  async settleWait(deviceId: string, now: number): Promise<boolean> {
    const r = await this.db.client.query({
      sql: `UPDATE phone_devices SET confirmed_at = ?, confirm_by = NULL, stop_hash = NULL
             WHERE id = ? AND confirmed_at IS NULL AND revoked_at IS NULL AND via IN ('link', 'host')
               AND wait_until IS NOT NULL AND wait_until <= ? AND COALESCE(confirm_by, 0) >= ?`,
      params: [now, deviceId, now, now],
      method: "run",
    });
    return r.changes === 1;
  }

  /**
   * A new access token, and a new refresh token in place of the one presented, signed for by the phone.
   *
   * The presented token is spent with a compare-and-set, so of two requests at once exactly one wins.
   * One that arrives after it was spent is a lost answer asked again only when it carries a newer proof
   * (`at` later than the proof that spent it), which only the phone's key can make: then what the first
   * answer gave is withdrawn and the phone gets fresh tokens. The same request again, a copy taken from
   * the wire or a log, is refused and changes nothing. Asked again after a minute, it is not explained:
   * the phone is removed.
   */
  async refresh(
    input: { refresh_token: unknown; proof: unknown; at: unknown },
    origin: string,
    now: number,
  ): Promise<PhoneTokens> {
    const token = typeof input.refresh_token === "string" ? input.refresh_token : "";
    const invalid = () =>
      new WriteError("not_allowed", "This phone is signed out. Connect it again from Settings → Phone.", {
        details: { reason: "invalid_grant" },
      });
    if (!token.startsWith(PHONE_REFRESH_PREFIX)) throw invalid();
    const hash = await hashApiKey(token);
    const { rows } = await this.db.client.query({
      sql: `SELECT t.device_id, t.expires_at, d.key_jwk, d.confirmed_at, d.via, d.confirm_by, d.created_at
              FROM phone_tokens t JOIN phone_devices d ON d.id = t.device_id
             WHERE t.token_hash = ? AND t.kind = 'refresh' AND d.revoked_at IS NULL`,
      params: [hash],
      method: "all",
    });
    const r = rows[0];
    if (!r) throw invalid();
    const [deviceId, expiresAt, keyJwk, confirmedAt, via, confirmBy, createdAt] = r as [
      string,
      number,
      string,
      number | null,
      string | null,
      number | null,
      number,
    ];
    // A phone still waiting for the owner's Confirm on the computer has nothing to refresh for. One
    // waiting for another phone's yes, or for its day to pass, may still ask whether it came.
    const waits = confirmedAt === null && waitsOnOf(via) === "phone" && now <= waitsUntil(createdAt, confirmBy);
    if (expiresAt <= now || (confirmedAt === null && !waits)) throw invalid();
    // Without the device key's signature nothing changes, whatever the token: a copy of it is no use.
    await this.checkProof(
      { ...input, device_key: JSON.parse(keyJwk) },
      "refresh",
      origin,
      await sha256b64u(token),
      now,
    );
    const at = input.at as number;
    const spent = await this.db.client.query({
      sql: "UPDATE phone_tokens SET revoked_at = ?, proof_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      params: [now, at, hash],
      method: "run",
    });
    if (spent.changes !== 1) {
      const { rows: was } = await this.db.client.query({
        sql: "SELECT revoked_at FROM phone_tokens WHERE token_hash = ?",
        params: [hash],
        method: "all",
      });
      const revokedAt = Number(was[0]?.[0] ?? 0);
      if (now - revokedAt > REFRESH_GRACE_MS) {
        await this.removePhone(deviceId, now);
        throw invalid();
      }
      // Only a newer proof asks again; the same one twice is a copy.
      const again = await this.db.client.query({
        sql: "UPDATE phone_tokens SET proof_at = ? WHERE token_hash = ? AND (proof_at IS NULL OR proof_at < ?)",
        params: [at, hash, at],
        method: "run",
      });
      if (again.changes !== 1) throw invalid();
      await this.db.client.query({
        sql: "UPDATE phone_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        params: [now, deviceId],
        method: "run",
      });
    }
    const tokens = await this.issue(deviceId, now, hash);
    await this.db.client.batch([
      ...tokens.statements,
      { sql: "UPDATE phone_devices SET last_seen_at = ? WHERE id = ?", params: [now, deviceId], method: "run" },
    ]);
    return tokens.tokens;
  }

  /** Who an access token is: the phone and the owner it signs in as. Null when unknown, expired or removed. */
  resolveAccess(token: string, now: number): Promise<PhonePrincipal | null> {
    return resolvePhoneAccess(this.db, token, now);
  }

  private async checkProof(
    input: { device_key?: unknown; proof?: unknown; at?: unknown },
    purpose: "pair" | "link" | "refresh" | "confirm",
    origin: string,
    hash: string,
    now: number,
  ): Promise<JsonWebKey> {
    const key = cleanDeviceKey(input.device_key);
    if (!key) throw bad("device_key must be a public P-256 JWK", "device_key");
    const at = typeof input.at === "number" ? input.at : Number.NaN;
    if (!Number.isFinite(at) || Math.abs(now - at) > PROOF_SKEW_MS)
      throw bad("The phone's clock is too far from ours. Set it to the right time and try again.", "at");
    const proof = typeof input.proof === "string" ? input.proof : "";
    if (!(await verifyProof(key, proofStatement(purpose, origin, hash, at), proof)))
      throw new WriteError("not_allowed", "The phone's proof does not match its key.", {
        details: { reason: "bad_proof" },
      });
    return key;
  }

  /**
   * Spends a pairing and makes the phone and its first tokens, in one write, or nothing. A phone with a
   * `match` waits for a yes: the owner's Confirm on the computer (a QR code), or on the owner's other
   * phone until `confirmBy` (a link); one without (a link, and no other phone) does not.
   */
  private async makePhone(
    pairingId: string,
    userId: string,
    key: JsonWebKey,
    input: { name?: unknown; platform?: unknown },
    now: number,
    opts: { match: string | null; via: PhoneVia; confirmBy?: number },
  ): Promise<PhoneTokens> {
    const thumb = await jwkThumbprint(key);
    const [taken] = await this.db.orm
      .select({ id: phoneDevices.id })
      .from(phoneDevices)
      .where(and(eq(phoneDevices.keyThumbprint, thumb), isNull(phoneDevices.revokedAt)));
    if (taken)
      throw new WriteError("wrong_state", "This phone is connected already.", { details: { phone: taken.id } });
    const deviceId = ulid(now);
    const tokens = await this.issue(deviceId, now);
    const claimed = `(SELECT device_id FROM phone_pairings WHERE id = ?) = ?`;
    const results = await this.db.client.batch([
      {
        sql: "UPDATE phone_pairings SET used_at = ?, device_id = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
        params: [now, deviceId, pairingId, now],
        method: "run",
      },
      {
        sql: `INSERT INTO phone_devices (id, user_id, name, platform, key_jwk, key_thumbprint, notify, push_state, pair_match, confirmed_at, created_at, last_seen_at, via, confirm_by)
              SELECT ?, ?, ?, ?, ?, ?, ?, 'off', ?, ?, ?, ?, ?, ? WHERE ${claimed}`,
        params: [
          deviceId,
          userId,
          cleanPhoneName(input.name),
          cleanPlatform(input.platform),
          JSON.stringify(key),
          thumb,
          JSON.stringify(DEFAULT_PREFS),
          opts.match,
          opts.match === null ? now : null,
          now,
          now,
          opts.via,
          opts.match === null ? null : (opts.confirmBy ?? null),
          pairingId,
          deviceId,
        ],
        method: "run",
      },
      ...tokens.statements.map((s) => ({
        ...s,
        sql: `${s.sql} WHERE ${claimed}`,
        params: [...(s.params ?? []), pairingId, deviceId],
      })),
    ]);
    if ((results[0]?.changes ?? 0) !== 1)
      throw new WriteError("code_expired", "That code has expired or was used already. Show a new one.");
    return tokens.tokens;
  }

  /** Two tokens for a phone, as the statements that store their hashes (`INSERT … SELECT`). */
  private async issue(
    deviceId: string,
    now: number,
    rotatedFrom?: string,
  ): Promise<{
    tokens: PhoneTokens;
    statements: { sql: string; params: (string | number | null)[]; method: "run" }[];
  }> {
    const access = `${PHONE_ACCESS_PREFIX}${randomToken(32)}`;
    const refresh = `${PHONE_REFRESH_PREFIX}${randomToken(32)}`;
    const insert =
      "INSERT INTO phone_tokens (token_hash, kind, device_id, expires_at, rotated_from, created_at) SELECT ?, ?, ?, ?, ?, ?";
    return {
      tokens: {
        access_token: access,
        token_type: "Bearer",
        expires_in: PHONE_ACCESS_TTL_MS / 1000,
        refresh_token: refresh,
        device_id: deviceId,
      },
      statements: [
        {
          sql: insert,
          params: [await hashApiKey(access), "access", deviceId, now + PHONE_ACCESS_TTL_MS, rotatedFrom ?? null, now],
          method: "run",
        },
        {
          sql: insert,
          params: [
            await hashApiKey(refresh),
            "refresh",
            deviceId,
            now + PHONE_REFRESH_TTL_MS,
            rotatedFrom ?? null,
            now,
          ],
          method: "run",
        },
      ],
    };
  }

  // ---- the phone, signed in: who it is, what it hears about, push ----

  async me(deviceId: string): Promise<{
    phone: PhoneView & {
      confirmed: boolean;
      /** While it waits: who says yes, the computer or the owner's other phone. */
      waits_on?: "computer" | "phone";
      /** "I don't have my other phone": when it is let in, unless stopped. */
      wait_until?: string;
    };
    notify: NotifyPrefs;
    business: { name: string; timezone: string };
    /** How long a price the phone sends can be accepted, when it gives no date (the inbox's setting). */
    offer_valid_hours: number;
    push_available: boolean;
  }> {
    const row = await this.device(deviceId);
    const [b] = await this.db.orm.select({ name: business.name, timezone: business.timezone }).from(business);
    const settings = await readSettings(this.db).catch(() => null);
    const waits = row.confirmedAt === null;
    return {
      phone: {
        ...viewOf(row),
        confirmed: !waits,
        ...(waits ? { waits_on: waitsOnOf(row.via) } : {}),
        ...(waits && row.waitUntil !== null ? { wait_until: new Date(row.waitUntil).toISOString() } : {}),
      },
      notify: readPrefs(row.notify),
      business: { name: b?.name ?? "", timezone: b?.timezone ?? "UTC" },
      offer_valid_hours: settings?.negotiation.offerValidHours ?? 48,
      push_available: this.pushAvailability().available,
    };
  }

  async setNotify(deviceId: string, input: unknown): Promise<NotifyPrefs> {
    await this.device(deviceId);
    const parsed = notifyPrefsSchema.safeParse(input);
    if (!parsed.success)
      throw new WriteError("invalid_input", "Those notification settings do not read.", {
        fields: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          problem: "invalid" as const,
          message: i.message,
        })),
      });
    if (parsed.data.tz) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: parsed.data.tz });
      } catch {
        throw bad("tz must be a time zone such as Europe/Lisbon", "tz");
      }
    }
    await this.db.client.query({
      sql: "UPDATE phone_devices SET notify = ? WHERE id = ?",
      params: [JSON.stringify(parsed.data), deviceId],
      method: "run",
    });
    return parsed.data;
  }

  /**
   * The phone's push token and push keys: registered with the relay (or its token replaced there),
   * and kept here sealed. The push token itself is handed to the relay and not kept: only the relay
   * needs it.
   */
  async registerPush(
    deviceId: string,
    input: { token: unknown; p256dh: unknown; auth: unknown },
    origin: string,
    now: number,
  ): Promise<{ push: PushState; error: string | null; relay_device?: string }> {
    const row = await this.device(deviceId);
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token || token.length > 4096) throw bad("token must be the phone's push token", "token");
    const p256dh = typeof input.p256dh === "string" ? input.p256dh : "";
    const auth = typeof input.auth === "string" ? input.auth : "";
    try {
      const point = b64uDecode(p256dh);
      if (point.length !== 65 || point[0] !== 4) throw new Error("p256dh");
      if (b64uDecode(auth).length !== 16) throw new Error("auth");
    } catch {
      throw bad("p256dh must be a P-256 point and auth 16 bytes, base64url", "p256dh");
    }
    const availability = this.pushAvailability();
    if (!this.relay || !this.secrets) {
      await this.setPush(deviceId, "unavailable", availability.reason);
      return { push: "unavailable", error: availability.reason };
    }
    let reg: RelayRegistration | null = await this.registration(row).catch(() => null);
    try {
      if (reg) {
        try {
          await this.relay.updateToken(reg, token);
        } catch {
          // The relay forgot it (or its secret changed): register afresh.
          reg = null;
        }
      }
      if (!reg) reg = await this.relay.register({ platform: cleanPlatform(row.platform), token, sender: origin });
    } catch (error) {
      const why = error instanceof Error ? error.message.slice(0, 200) : "relay unreachable";
      await this.setPush(deviceId, "error", why);
      return { push: "error", error: why };
    }
    const sealed: SealedPush = { device: reg.device, secret: reg.secret, p256dh, auth };
    await this.db.client.query({
      sql: "UPDATE phone_devices SET push_state = 'on', push_device = ?, push_enc = ?, push_error = NULL, pushed_at = COALESCE(pushed_at, ?) WHERE id = ?",
      params: [reg.device, await this.secrets.seal("phone-push", deviceId, JSON.stringify(sealed)), now, deviceId],
      method: "run",
    });
    // The relay names the device in every message it carries (`d`): the phone keeps it beside this
    // inbox's keys, to know which of them opens it.
    return { push: "on", error: null, relay_device: reg.device };
  }

  private async setPush(deviceId: string, state: PushState, error: string | null): Promise<void> {
    await this.db.client.query({
      sql: "UPDATE phone_devices SET push_state = ?, push_error = ? WHERE id = ?",
      params: [state, error, deviceId],
      method: "run",
    });
  }

  private async registration(row: DeviceRow): Promise<(RelayRegistration & { keys: SealedPush }) | null> {
    if (!row.pushEnc || !this.secrets) return null;
    const keys = JSON.parse(await this.secrets.open("phone-push", row.id, row.pushEnc)) as SealedPush;
    return { device: keys.device, secret: keys.secret, keys };
  }

  /**
   * Encrypts one payload for one phone and hands it to the relay. A phone whose app is gone is marked
   * `lost` (it registers again the next time the app opens); anything else the relay refuses is
   * thrown for the job to try again later, but a refusal of what was sent, which trying again would
   * not change.
   */
  async deliver(
    deviceId: string,
    plaintext: Uint8Array,
    opts: {
      urgency: "high" | "normal";
      ttlS: number;
      /** The item it is about: later notifications about it replace one not delivered yet. */
      item?: string;
      /** The same on every try of one notification (the job's id): the relay delivers it once. */
      key?: string;
    },
    now: number,
  ): Promise<{ sent: boolean; note: string }> {
    const [row] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, deviceId));
    if (!row || row.revokedAt !== null) return { sent: false, note: "phone removed" };
    if (row.pushState !== "on" || !this.relay) return { sent: false, note: `push ${row.pushState}` };
    const reg = await this.registration(row);
    if (!reg) return { sent: false, note: "push keys unreadable" };
    const message = await encryptPush(reg.keys, plaintext);
    // Neither the relay nor the push service sees an item's id or a job's: values only this inbox and
    // this phone can make, stable across retries.
    const secret = b64uDecode(reg.keys.auth);
    const r = await this.relay.send(reg, message, {
      urgency: opts.urgency,
      ttlS: opts.ttlS,
      ...(opts.item ? { collapse: await opaqueKey(secret, `collapse:${opts.item}`) } : {}),
      ...(opts.key ? { id: `n_${await opaqueKey(secret, `notify:${opts.key}`)}` } : {}),
    });
    if (r.ok) {
      await this.db.client.query({
        sql: "UPDATE phone_devices SET pushed_at = ? WHERE id = ?",
        params: [now, deviceId],
        method: "run",
      });
      return { sent: true, note: "sent" };
    }
    if (r.gone) {
      await this.setPush(deviceId, "lost", "The app on this phone stopped answering. Opening it again sets it up.");
      return { sent: false, note: "phone gone" };
    }
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 413) {
      await this.setPush(deviceId, "error", `the relay refused it (${r.status})`);
      return { sent: false, note: `refused ${r.status}` };
    }
    throw new Error(`relay answered ${r.status}`);
  }

  /** "Send a test" in Settings → Phone, or on the phone itself. */
  async sendTest(deviceId: string, now: number): Promise<{ sent: boolean; note: string }> {
    const row = await this.device(deviceId);
    if (row.pushState !== "on")
      throw new WriteError("wrong_state", "Notifications are not set up on this phone yet. Open the app on it once.", {
        details: { push: row.pushState },
      });
    const [b] = await this.db.orm.select({ name: business.name }).from(business);
    return this.deliver(
      deviceId,
      encodePayload(testPayload(now, b?.name ?? "")),
      { urgency: "high", ttlS: 600, key: `test:${now}` },
      now,
    );
  }

  /** The phones that hear about anything at all: connected, with push on. */
  async listeners(): Promise<DeviceRow[]> {
    return this.db.orm
      .select()
      .from(phoneDevices)
      .where(
        and(isNull(phoneDevices.revokedAt), isNotNull(phoneDevices.confirmedAt), eq(phoneDevices.pushState, "on")),
      );
  }
}
