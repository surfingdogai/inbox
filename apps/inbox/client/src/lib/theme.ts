import { useSyncExternalStore } from "react";

/**
 * Day, night or Auto; a choice sets `data-theme` on <html> and is kept in localStorage. Auto follows
 * the business's look (Settings → Look, `data-look` on <html>): Dark is night, Minimal and Warm are
 * day, and Standard follows the device. index.html applies both before the first paint.
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

/** What `data-theme` is for a mode and the business's theme: null leaves it to the device. */
export function resolveTheme(mode: ThemeMode, look: string | null | undefined): "light" | "dark" | null {
  if (mode !== "system") return mode;
  if (look === "dark") return "dark";
  if (look === "minimal" || look === "warm") return "light";
  return null;
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const theme = resolveTheme(mode, root.getAttribute("data-look"));
  if (theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
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
