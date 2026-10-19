import { b64uDecode, b64uEncode } from "../../../../packages/core/src/phones/crypto";

/**
 * Offline (ADR-026): the last state of each inbox, kept encrypted on the phone, and what the owner
 * did while there was no connection, sent when it is back with the idempotency key it was given when
 * pressed, so a send that reached the inbox before the connection dropped is never done twice.
 *
 * The cache's key is 32 random bytes kept in the phone's secure storage (the Android Keystore); the
 * cache itself is ciphertext wherever it is stored.
 */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SecureStore {
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
}

const KEY_NAME = "cache.key";
const PREFIX = "sdi.cache.";

export class Box {
  private constructor(
    private readonly key: CryptoKey,
    private readonly kv: KV,
  ) {}

  static async open(secure: SecureStore, kv: KV): Promise<Box> {
    let raw = await secure.secureGet(KEY_NAME);
    if (!raw) {
      raw = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
      await secure.secureSet(KEY_NAME, raw);
    }
    const key = await crypto.subtle.importKey("raw", b64uDecode(raw) as BufferSource, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return new Box(key, kv);
  }

  async put(name: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(value));
    // The name is bound to the ciphertext: one inbox's cache cannot be swapped in for another's.
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) },
      this.key,
      data,
    );
    try {
      this.kv.setItem(PREFIX + name, `v1.${b64uEncode(iv)}.${b64uEncode(new Uint8Array(ct))}`);
    } catch {
      // Storage full or unavailable: the app works on, it only cannot show this offline.
    }
  }

  async get<T>(name: string): Promise<T | null> {
    const stored = this.kv.getItem(PREFIX + name);
    if (!stored) return null;
    const [v, iv, ct] = stored.split(".");
    if (v !== "v1" || !iv || !ct) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64uDecode(iv) as BufferSource, additionalData: new TextEncoder().encode(name) },
        this.key,
        b64uDecode(ct) as BufferSource,
      );
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch {
      return null;
    }
  }

  remove(name: string): void {
    this.kv.removeItem(PREFIX + name);
  }
}

/** One thing the owner did that has not reached the inbox yet. */
export interface QueuedAction {
  readonly id: string;
  /** The inbox (its alias on this phone). */
  readonly alias: string;
  readonly itemId: string;
  readonly kind: "transition" | "reply";
  readonly body: Record<string, unknown>;
  /** Sent as Idempotency-Key, the same on every try. */
  readonly key: string;
  /** What it is, in the owner's words, for the banner: "Accept 14:00". */
  readonly label: string;
  readonly at: number;
}

export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly offline: boolean; readonly reason: string };

const OUTBOX = "outbox";

export class Outbox {
  constructor(private readonly box: Box) {}

  async list(alias?: string): Promise<QueuedAction[]> {
    const all = (await this.box.get<QueuedAction[]>(OUTBOX)) ?? [];
    return alias ? all.filter((a) => a.alias === alias) : all;
  }

  async add(action: Omit<QueuedAction, "id" | "key" | "at">, now = Date.now()): Promise<QueuedAction> {
    const queued: QueuedAction = {
      ...action,
      id: crypto.randomUUID(),
      key: `phone-${crypto.randomUUID()}`,
      at: now,
    };
    await this.box.put(OUTBOX, [...(await this.list()), queued]);
    return queued;
  }

  /**
   * Sends what waits, oldest first. It stops at the first that cannot reach the inbox (still offline),
   * drops what the inbox refused (and says why), and keeps the rest for next time.
   */
  async flush(
    send: (a: QueuedAction) => Promise<SendResult>,
  ): Promise<{ sent: number; refused: { action: QueuedAction; reason: string }[]; left: number }> {
    const waiting = await this.list();
    const refused: { action: QueuedAction; reason: string }[] = [];
    let sent = 0;
    let i = 0;
    for (; i < waiting.length; i++) {
      const a = waiting[i];
      if (!a) continue;
      const r = await send(a);
      if (r.ok) sent++;
      else if (r.offline) break;
      else refused.push({ action: a, reason: r.reason });
    }
    const left = waiting.slice(i);
    await this.box.put(OUTBOX, left);
    return { sent, refused, left: left.length };
  }
}
