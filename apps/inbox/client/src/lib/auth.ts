import { useSyncExternalStore } from "react";

/**
 * The one place that knows how the owner is authenticated: the session cookie the magic-link flow
 * sets (/auth/magic-link → /auth/verify → sdi_session), or an owner API key kept in localStorage
 * for API-only owners. Every request goes out with `credentials: "include"`; the key, when there
 * is one, rides as a Bearer header and wins.
 */
export const KEY_PREFIX = "sdi_own_";
const STORAGE_KEY = "sdi.owner_key";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: "owner" | "staff";
}

const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

export function getKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The cookie's user. A positive answer is kept for the page's life; a negative one is asked again. */
let lookup: Promise<SessionUser | null> | null = null;
export function session(): Promise<SessionUser | null> {
  if (!lookup) {
    lookup = fetch("/auth/me", { credentials: "include", headers: { accept: "application/json" } })
      .then(async (res) => (res.ok ? ((await res.json()) as SessionUser) : null))
      .catch(() => null)
      .then((user) => {
        if (!user) lookup = null;
        return user;
      });
  }
  return lookup;
}

export function forgetSession(): void {
  lookup = null;
}

/**
 * Where to go after signing in: a path on this site, or nothing. `/login?redirect=…` is a link anyone
 * can send the owner, and a browser reads `//host`, `/\host` and `/<tab>/host` as another site, so
 * the value is resolved the way the browser would and kept only when it stays here.
 */
export function sameSitePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  const here = "https://inbox.invalid";
  try {
    const url = new URL(value, here);
    return url.origin === here ? `${url.pathname}${url.search}${url.hash}` : undefined;
  } catch {
    return undefined;
  }
}

/** A stored key counts at once; otherwise the cookie decides. Route guards await this. */
export async function ensureSignedIn(): Promise<boolean> {
  if (getKey()) return true;
  return (await session()) !== null;
}

export function signInWithKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode without storage: the key lasts until the tab closes.
  }
  notify();
}

/** Forgets the key and the session locally, without telling the server: the 401 path. */
export function dropCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  forgetSession();
  notify();
}

/** Signing out on purpose: end the cookie session on the server too. */
export async function signOut(): Promise<void> {
  dropCredentials();
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // Offline: the cookie dies with its expiry.
  }
}

/** Headers for an owner call: the key when there is one; otherwise the cookie goes on its own. */
export function authHeaders(): Record<string, string> {
  const key = getKey();
  return key ? { authorization: `Bearer ${key}` } : {};
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

export function useHasKey(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getKey() !== null,
    () => false,
  );
}
