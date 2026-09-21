import { useSyncExternalStore } from "react";

/**
 * The one place that knows how the owner is authenticated. Today: an owner API key pasted at
 * sign-in and kept in localStorage. When sessions and passkeys arrive (ADR-004) this module swaps
 * to cookies and the rest of the app does not change.
 */
export const KEY_PREFIX = "sdi_own_";
const STORAGE_KEY = "sdi.owner_key";

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

export function isSignedIn(): boolean {
  return getKey() !== null;
}

export function signIn(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode without storage: the session lasts until the tab closes.
  }
  notify();
}

export function signOut(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  notify();
}

/** Headers for an owner call; empty when signed out so the API answers 401 and the app redirects. */
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

export function useSignedIn(): boolean {
  return useSyncExternalStore(subscribe, isSignedIn, () => false);
}
