import { useSyncExternalStore } from "react";

/**
 * Day and night follow the system by default; a choice sets `data-theme` on <html> and is kept in
 * localStorage. index.html applies the stored choice before the first paint.
 */
export type ThemeMode = "system" | "light" | "dark";
const STORAGE_KEY = "sdi.theme";
const listeners = new Set<() => void>();

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

/** At start-up: index.html already applied the stored choice; this keeps the attribute in step. */
export function initTheme(): void {
  applyTheme(readTheme());
}

export function setTheme(mode: ThemeMode): void {
  try {
    if (mode === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // no storage: the choice lasts for this page
  }
  applyTheme(mode);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribe, readTheme, () => "system" as const);
  return [mode, setTheme];
}
