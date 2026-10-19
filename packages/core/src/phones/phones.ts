import { and, eq, isNull } from "drizzle-orm";
import { hashApiKey } from "../access/keys";
import type { Db } from "../db";
import { randomToken, ulid } from "../ids";
import { business, phoneDevices, phonePairings } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { WriteError } from "../write/errors";
import {
  b64uDecode,
  cleanDeviceKey,
  encryptPush,
  jwkThumbprint,
  PROOF_SKEW_MS,
  pkceS256,
  proofStatement,
  sha256b64u,
  verifyProof,
} from "./crypto";
import { encodePayload, testPayload } from "./payload";
import { DEFAULT_PREFS, type NotifyPrefs, notifyPrefsSchema, readPrefs } from "./prefs";
import type { PushRelay, RelayRegistration } from "./relay";

/**
 * The owner's phones (ADR-026). A phone is paired from the owner app (Settings → Phone): a QR code
 * carries the inbox's address and a one-time secret that works once, for five minutes. The phone
 * scans it and trades it, with a proof signed by a device key it made in its own keystore, for a
 * refresh token bound to that key and short access tokens to the owner's API. Or the owner asks on
 * the phone for a sign-in link by email; the phone holds the PKCE verifier, so the link is useless to
 * any other app that opens it.
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
}

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

function viewOf(row: DeviceRow): PhoneView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    created_at: new Date(row.createdAt).toISOString(),
    last_seen_at: iso(row.lastSeenAt),
    push: row.pushState as PushState,
    push_error: row.pushError,
  };
}

/** A phone's name as it sends it, on one line and short: "Pixel 8", "Galaxy S24". */
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
    sql: `SELECT d.id, d.user_id, d.name, d.last_seen_at
            FROM phone_tokens t JOIN phone_devices d ON d.id = t.device_id
           WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
             AND d.revoked_at IS NULL`,
    params: [await hashApiKey(token), now],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  const [deviceId, userId, name, lastSeen] = r as [string, string, string, number | null];
  if (lastSeen === null || now - lastSeen >= TOUCH_EVERY_MS) {
    await db.client.query({
      sql: "UPDATE phone_devices SET last_seen_at = ? WHERE id = ?",
      params: [now, deviceId],
      method: "run",
    });
  }
  return { deviceId, userId, name };
}

export class PhoneCapabilities {
  private relay: PushRelay | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
  ) {}

  /** How push reaches the phones: the host's relay, or none (`INBOX_PUSH_RELAY=off`). */
  attachRelay(relay: PushRelay | null): void {
    this.relay = relay;
  }

  /**
   * Whether notifications can work here, and if not why: the relay is off, or there is no
   * `INBOX_SECRET_KEY` to seal what push needs (the relay's secret, the phone's push keys).
   */
  pushAvailability(): { available: boolean; reason: "no_relay" | "no_secret_key" | null } {
    if (!this.relay) return { available: false, reason: "no_relay" };
    if (!this.secrets) return { available: false, reason: "no_secret_key" };
    return { available: true, reason: null };
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
    await this.db.client.query({
      sql: "DELETE FROM phone_pairings WHERE used_at IS NULL AND expires_at < ?",
      params: [now - 86_400_000],
      method: "run",
    });
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

  /** What became of a QR code: still waiting, used by a phone (which), or past its minutes. */
  async pairingStatus(
    userId: string,
    id: string,
    now: number,
  ): Promise<{ state: "waiting" | "paired" | "expired"; phone?: PhoneView }> {
    const [row] = await this.db.orm
      .select()
      .from(phonePairings)
      .where(and(eq(phonePairings.id, id), eq(phonePairings.userId, userId), eq(phonePairings.kind, "qr")));
    if (!row) throw new WriteError("not_found", "No such code.");
    if (row.usedAt !== null && row.deviceId) {
      const [device] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, row.deviceId));
      return device ? { state: "paired", phone: viewOf(device) } : { state: "paired" };
    }
    return { state: row.expiresAt > now ? "waiting" : "expired" };
  }

  /** The person a phone signs in as. */
  async ownerOf(deviceId: string): Promise<string> {
    return (await this.device(deviceId)).userId;
  }

  async listPhones(): Promise<PhoneView[]> {
    return (await this.livePhones()).map(viewOf);
  }

  private async livePhones(): Promise<DeviceRow[]> {
    return this.db.orm
      .select()
      .from(phoneDevices)
      .where(isNull(phoneDevices.revokedAt))
      .orderBy(phoneDevices.createdAt);
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
  async pair(input: Readonly<Record<string, unknown>>, origin: string, now: number): Promise<PhoneTokens> {
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
    return this.makePhone(row.id, row.userId, key, input, now);
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

  /** The phone that asked for the link redeems it, with its verifier and a proof from the same key. */
  async redeemLink(input: Readonly<Record<string, unknown>>, origin: string, now: number): Promise<PhoneTokens> {
    const secret = typeof input.secret === "string" ? input.secret : "";
    const verifier = typeof input.verifier === "string" ? input.verifier : "";
    if (!secret.startsWith(PAIRING_PREFIX)) throw bad("That is not a sign-in link from this inbox.", "secret");
    if (verifier.length < 43 || verifier.length > 128) throw bad("verifier must be 43 to 128 characters", "verifier");
    const key = await this.checkProof(input, "link", origin, await sha256b64u(secret), now);
    const [row] = await this.db.orm
      .select()
      .from(phonePairings)
      .where(and(eq(phonePairings.secretHash, await hashApiKey(secret)), eq(phonePairings.kind, "link")));
    const expired = () =>
      new WriteError("code_expired", "That link has expired or was used already. Ask for a new one on the phone.");
    if (!row || row.usedAt !== null || row.expiresAt <= now || row.attempts >= MAX_LINK_ATTEMPTS) throw expired();
    const sameKey = row.deviceKey === (await jwkThumbprint(key));
    if (!sameKey || (await pkceS256(verifier)) !== row.codeChallenge) {
      await this.db.client.query({
        sql: "UPDATE phone_pairings SET attempts = attempts + 1 WHERE id = ?",
        params: [row.id],
        method: "run",
      });
      throw new WriteError("not_allowed", "Open the link on the phone that asked for it.", {
        details: { reason: "other_phone" },
      });
    }
    return this.makePhone(row.id, row.userId, key, input, now);
  }

  /** A new access token, and a new refresh token in place of the one presented, signed for by the phone. */
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
      sql: `SELECT t.device_id, t.expires_at, t.revoked_at, d.key_jwk
              FROM phone_tokens t JOIN phone_devices d ON d.id = t.device_id
             WHERE t.token_hash = ? AND t.kind = 'refresh' AND d.revoked_at IS NULL`,
      params: [hash],
      method: "all",
    });
    const r = rows[0];
    if (!r) throw invalid();
    const [deviceId, expiresAt, revokedAt, keyJwk] = r as [string, number, number | null, string];
    if (expiresAt <= now) throw invalid();
    // Without the device key's signature nothing changes, whatever the token: a copy of it is no use.
    await this.checkProof(
      { ...input, device_key: JSON.parse(keyJwk) },
      "refresh",
      origin,
      await sha256b64u(token),
      now,
    );
    if (revokedAt !== null) {
      // Used before. Right after, from the phone itself, it is a lost answer asked again: what that
      // answer gave is withdrawn and the phone gets another. Later, it is not explained: out it goes.
      if (now - revokedAt > REFRESH_GRACE_MS) {
        await this.removePhone(deviceId, now);
        throw invalid();
      }
      await this.db.client.query({
        sql: "UPDATE phone_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        params: [now, deviceId],
        method: "run",
      });
    }
    const tokens = await this.issue(deviceId, now, hash);
    await this.db.client.batch([
      {
        sql: "UPDATE phone_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
        params: [now, hash],
        method: "run",
      },
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
    purpose: "pair" | "link" | "refresh",
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

  /** Spends a pairing and makes the phone and its first tokens, in one write, or nothing. */
  private async makePhone(
    pairingId: string,
    userId: string,
    key: JsonWebKey,
    input: { name?: unknown; platform?: unknown },
    now: number,
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
        sql: `INSERT INTO phone_devices (id, user_id, name, platform, key_jwk, key_thumbprint, notify, push_state, created_at, last_seen_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, 'off', ?, ? WHERE ${claimed}`,
        params: [
          deviceId,
          userId,
          cleanPhoneName(input.name),
          cleanPlatform(input.platform),
          JSON.stringify(key),
          thumb,
          JSON.stringify(DEFAULT_PREFS),
          now,
          now,
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
    phone: PhoneView;
    notify: NotifyPrefs;
    business: { name: string; timezone: string };
    push_available: boolean;
  }> {
    const row = await this.device(deviceId);
    const [b] = await this.db.orm.select({ name: business.name, timezone: business.timezone }).from(business);
    return {
      phone: viewOf(row),
      notify: readPrefs(row.notify),
      business: { name: b?.name ?? "", timezone: b?.timezone ?? "UTC" },
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
  ): Promise<{ push: PushState; error: string | null }> {
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
    return { push: "on", error: null };
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
    opts: { urgency: "high" | "normal"; ttlS: number; collapse?: string },
    now: number,
  ): Promise<{ sent: boolean; note: string }> {
    const [row] = await this.db.orm.select().from(phoneDevices).where(eq(phoneDevices.id, deviceId));
    if (!row || row.revokedAt !== null) return { sent: false, note: "phone removed" };
    if (row.pushState !== "on" || !this.relay) return { sent: false, note: `push ${row.pushState}` };
    const reg = await this.registration(row);
    if (!reg) return { sent: false, note: "push keys unreadable" };
    const message = await encryptPush(reg.keys, plaintext);
    const r = await this.relay.send(reg, message, opts);
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
    return this.deliver(deviceId, encodePayload(testPayload(now, b?.name ?? "")), { urgency: "high", ttlS: 600 }, now);
  }

  /** The phones that hear about anything at all: live, with push on. */
  async listeners(): Promise<DeviceRow[]> {
    return this.db.orm
      .select()
      .from(phoneDevices)
      .where(and(isNull(phoneDevices.revokedAt), eq(phoneDevices.pushState, "on")));
  }
}
