import { Capacitor, registerPlugin } from "@capacitor/core";
import { b64uEncode } from "../../../../packages/core/src/phones/crypto";

/**
 * What only the phone itself can do (ADR-026), behind one interface: on Android the app's own native
 * plugin (`InboxNative`, android/app/src/main/java/ai/surfingdog/inbox), and in a browser (development,
 * the screenshots, the tests) a stand-in on Web Crypto and localStorage that is never shipped as the
 * app's way of keeping secrets.
 *
 * - The device key: an ECDSA P-256 key per inbox, made in the Android Keystore and never exported. The
 *   inbox keeps its public half; the phone signs with it to pair and to refresh its tokens.
 * - Secure storage: the refresh tokens and the offline cache's key, encrypted under a Keystore key.
 * - Biometrics: BiometricPrompt, to open the app and before an Accept from a notification.
 * - Push: the FCM token, and per inbox an ECDH key and an authentication secret whose private halves
 *   stay with the native code that decrypts each notification, even while the app is closed.
 */
export interface DeviceKey {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface NativeInbox {
  /** The alias the inbox's keys are kept under on this phone. */
  readonly alias: string;
  readonly origin: string;
  readonly name: string;
}

export interface Native {
  readonly platform: "android" | "ios" | "web";
  deviceName(): Promise<string>;
  deviceKey(alias: string): Promise<DeviceKey>;
  sign(alias: string, data: string): Promise<string>;
  deleteKeys(alias: string): Promise<void>;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureRemove(key: string): Promise<void>;
  canAuthenticate(): Promise<boolean>;
  authenticate(reason: string): Promise<boolean>;
  /** Whether this build can receive notifications at all (Firebase configured), and the permission. */
  pushStatus(): Promise<{ available: boolean; permission: "granted" | "denied" | "prompt" }>;
  requestPushPermission(): Promise<"granted" | "denied" | "prompt">;
  pushToken(): Promise<string | null>;
  pushKeys(alias: string): Promise<{ p256dh: string; auth: string }>;
  /** The inboxes the notification service may decrypt for, and the names it shows them under. */
  setInboxes(inboxes: readonly NativeInbox[]): Promise<void>;
  onPushToken(listener: (token: string) => void): void;
}

interface InboxNativePlugin {
  deviceName(): Promise<{ name: string }>;
  deviceKey(o: { alias: string }): Promise<{ x: string; y: string }>;
  sign(o: { alias: string; data: string }): Promise<{ signature: string }>;
  deleteKeys(o: { alias: string }): Promise<void>;
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
  secureRemove(o: { key: string }): Promise<void>;
  canAuthenticate(): Promise<{ available: boolean }>;
  authenticate(o: { reason: string }): Promise<{ ok: boolean }>;
  pushStatus(): Promise<{ available: boolean; permission: "granted" | "denied" | "prompt" }>;
  requestPushPermission(): Promise<{ permission: "granted" | "denied" | "prompt" }>;
  pushToken(): Promise<{ token: string | null }>;
  pushKeys(o: { alias: string }): Promise<{ p256dh: string; auth: string }>;
  setInboxes(o: { inboxes: readonly NativeInbox[] }): Promise<void>;
  addListener(event: "pushToken", fn: (e: { token: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

function androidNative(): Native {
  const p = registerPlugin<InboxNativePlugin>("InboxNative");
  return {
    platform: "android",
    deviceName: async () => (await p.deviceName()).name,
    deviceKey: async (alias) => {
      const k = await p.deviceKey({ alias });
      return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
    },
    sign: async (alias, data) => (await p.sign({ alias, data })).signature,
    deleteKeys: (alias) => p.deleteKeys({ alias }),
    secureGet: async (key) => (await p.secureGet({ key })).value,
    secureSet: (key, value) => p.secureSet({ key, value }),
    secureRemove: (key) => p.secureRemove({ key }),
    canAuthenticate: async () => (await p.canAuthenticate()).available,
    authenticate: async (reason) => (await p.authenticate({ reason })).ok,
    pushStatus: () => p.pushStatus(),
    requestPushPermission: async () => (await p.requestPushPermission()).permission,
    pushToken: async () => (await p.pushToken()).token,
    pushKeys: (alias) => p.pushKeys({ alias }),
    setInboxes: (inboxes) => p.setInboxes({ inboxes }),
    onPushToken: (fn) => void p.addListener("pushToken", (e) => fn(e.token)),
  };
}

/**
 * The browser stand-in. Device keys are non-extractable Web Crypto keys kept in IndexedDB; stored
 * values go to localStorage under a prefix. Good for development and tests, and labelled as such: the
 * app on a phone never uses it.
 */
export function webNative(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()): Native {
  const keys = new Map<string, CryptoKeyPair>();
  const prefix = "sdi.phone.";
  const idb = typeof indexedDB === "undefined" ? null : indexedDB;
  const openDb = () =>
    new Promise<IDBDatabase | null>((resolve) => {
      if (!idb) return resolve(null);
      const req = idb.open("sdi-phone", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  const load = async (alias: string): Promise<CryptoKeyPair | null> => {
    const mem = keys.get(alias);
    if (mem) return mem;
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction("keys").objectStore("keys").get(alias);
      req.onsuccess = () => resolve((req.result as CryptoKeyPair | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  };
  const save = async (alias: string, pair: CryptoKeyPair) => {
    keys.set(alias, pair);
    const db = await openDb();
    db?.transaction("keys", "readwrite").objectStore("keys").put(pair, alias);
  };
  const pair = async (alias: string): Promise<CryptoKeyPair> => {
    const have = await load(alias);
    if (have) return have;
    const made = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await save(alias, made);
    return made;
  };
  return {
    platform: "web",
    deviceName: async () => "This browser",
    deviceKey: async (alias) => {
      const pub = await crypto.subtle.exportKey("jwk", (await pair(alias)).publicKey);
      return { kty: "EC", crv: "P-256", x: pub.x ?? "", y: pub.y ?? "" };
    },
    sign: async (alias, data) => {
      const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        (await pair(alias)).privateKey,
        new TextEncoder().encode(data),
      );
      return b64uEncode(new Uint8Array(sig));
    },
    deleteKeys: async (alias) => {
      keys.delete(alias);
      const db = await openDb();
      db?.transaction("keys", "readwrite").objectStore("keys").delete(alias);
    },
    secureGet: async (key) => storage?.getItem(prefix + key) ?? null,
    secureSet: async (key, value) => storage?.setItem(prefix + key, value),
    secureRemove: async (key) => storage?.removeItem(prefix + key),
    canAuthenticate: async () => false,
    authenticate: async () => true,
    pushStatus: async () => ({ available: false, permission: "denied" }),
    requestPushPermission: async () => "denied",
    pushToken: async () => null,
    pushKeys: async () => {
      // Never used to receive anything: the browser has no notification service of ours.
      const auth = crypto.getRandomValues(new Uint8Array(16));
      return { p256dh: "", auth: b64uEncode(auth) };
    },
    setInboxes: async () => undefined,
    onPushToken: () => undefined,
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let current: Native | null = null;
export function native(): Native {
  if (!current) current = Capacitor.getPlatform() === "android" ? androidNative() : webNative();
  return current;
}

/** For tests and the screenshots: put a stand-in in place. */
export function setNative(n: Native): void {
  current = n;
}
