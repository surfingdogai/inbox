import {
  ACCENT_TONES,
  accentIn,
  LOOK_ACCENTS,
  LOOK_THEMES,
  type LogoSlot,
  type LookAccent,
  type LookTheme,
  THEME_TONES,
  type ThemeTones,
} from "@surfingdog/core/look";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { qk, useSaveSettings, useSettings } from "./queries";
import { applyTheme, readTheme } from "./theme";
import type { SettingsDoc } from "./types";

/**
 * The business's look in the owner app (Settings → Look): its theme on <html> as `data-look`, its
 * accent as `data-accent` with its two tones, kept in localStorage so index.html paints them first.
 * The owner's own Day or Night still wins; Auto follows the look (`lib/theme.ts`).
 */

const STORAGE_KEY = "sdi.look";
const VARS = ["--accent-day", "--accent-day-fg", "--accent-night", "--accent-night-fg"] as const;

export interface LookChoice {
  readonly theme: LookTheme;
  readonly accent: LookAccent;
}

/** The four tones an accent sets on <html>; none for Ink, the theme's own ink. */
export function accentVars(accent: LookAccent): Readonly<Record<(typeof VARS)[number], string>> | null {
  if (accent === "ink") return null;
  const t = ACCENT_TONES[accent];
  return {
    "--accent-day": t.day,
    "--accent-day-fg": t.dayFg,
    "--accent-night": t.night,
    "--accent-night-fg": t.nightFg,
  };
}

const isTheme = (v: unknown): v is LookTheme => (LOOK_THEMES as readonly unknown[]).includes(v);
const isAccent = (v: unknown): v is LookAccent => (LOOK_ACCENTS as readonly unknown[]).includes(v);

/** The look kept for the first paint: what is not a known theme or accent reads as the default. */
export function readLookCache(raw: string | null): LookChoice {
  try {
    const v = JSON.parse(raw ?? "null") as { theme?: unknown; accent?: unknown } | null;
    return { theme: isTheme(v?.theme) ? v.theme : "standard", accent: isAccent(v?.accent) ? v.accent : "ink" };
  } catch {
    return { theme: "standard", accent: "ink" };
  }
}

/** What index.html reads before the first paint: the names and the tones it sets. */
function cacheOf(look: LookChoice): string {
  const vars = accentVars(look.accent);
  return JSON.stringify({
    theme: look.theme,
    accent: look.accent,
    ...(vars
      ? {
          day: vars["--accent-day"],
          dayFg: vars["--accent-day-fg"],
          night: vars["--accent-night"],
          nightFg: vars["--accent-night-fg"],
        }
      : {}),
  });
}

export function applyLook(look: LookChoice): void {
  const root = document.documentElement;
  if (look.theme === "standard") root.removeAttribute("data-look");
  else root.setAttribute("data-look", look.theme);
  const vars = accentVars(look.accent);
  for (const name of VARS) root.style.removeProperty(name);
  if (vars) {
    root.setAttribute("data-accent", look.accent);
    for (const name of VARS) root.style.setProperty(name, vars[name]);
  } else {
    root.removeAttribute("data-accent");
  }
  try {
    if (look.theme === "standard" && look.accent === "ink") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, cacheOf(look));
  } catch {
    // no storage: the look is painted from the settings once they load
  }
  applyTheme(readTheme());
}

/** Keeps <html> in step with the settings: on the inbox and in Settings. */
export function useLookSync(): void {
  const look = useSettings().data?.doc.look;
  const theme = look?.theme;
  const accent = look?.accent;
  useEffect(() => {
    if (theme && accent) applyLook({ theme, accent });
  }, [theme, accent]);
}

/** How long a choice waits for the next one before it is saved: arrow keys step through every one. */
const SAVE_AFTER_MS = 300;

/**
 * The theme and accent as the owner picks them (Settings → Look): shown at once, saved one at a
 * time. Arrow keys move a radio group's choice on every press, so a save waits for a pause and for
 * the save before it, then sends the latest choice with the version the settings have then. The
 * choice goes back only when that last save fails, and `failed` hears why.
 */
export function useLookChoice(
  saved: LookChoice,
  failed: (error: unknown) => void,
): [LookChoice, (patch: Partial<LookChoice>) => void] {
  const qc = useQueryClient();
  const { mutateAsync } = useSaveSettings();
  const [choice, setChoice] = useState<LookChoice | null>(null);
  const shown = choice ?? saved;
  // What the next save sends, whether one is on its way, and the wait: kept across renders, so a
  // render never sends anything by itself.
  const pending = useRef<LookChoice | null>(null);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ mutateAsync, failed });
  latest.current = { mutateAsync, failed };

  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        const version = qc.getQueryData<SettingsDoc>(qk.settings)?.version;
        try {
          await latest.current.mutateAsync({ doc: { look: next }, expected_version: version });
        } catch (error) {
          if (!pending.current) latest.current.failed(error);
        }
      }
      // All sent: what is shown is the settings' own again, saved or, after a failure, as they were.
      setChoice(null);
    } finally {
      sending.current = false;
    }
  }, [qc]);

  // Leaving the page sends what is waiting rather than dropping it.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void send();
    },
    [send],
  );

  const choose = (patch: Partial<LookChoice>) => {
    const next = { ...(pending.current ?? shown), ...patch };
    setChoice(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_AFTER_MS);
  };
  return [shown, choose];
}

/** A theme's tones as the owner sees them chosen here: Standard by day, as customers mostly do. */
export function tonesOf(theme: LookTheme): ThemeTones {
  return THEME_TONES[theme];
}

/** The accent as a theme shows it: the night tone on Dark, the day tone otherwise; Ink is the theme's ink. */
export function accentTone(theme: LookTheme, accent: LookAccent): { readonly accent: string; readonly label: string } {
  return accentIn(accent, tonesOf(theme));
}

/** As the inbox takes it (`look/logo.ts`); the inbox decides, this only says so at once. */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_HINT = "PNG, JPEG or WebP, up to 512 KB. Shown on your pages, in your emails and here.";
export const LOGO_DARK_HINT = "Optional, for a logo drawn in white: shown on dark pages in place of the logo.";

/** Why a picture would be refused, before it is sent; null when the inbox may take it. */
export function logoProblem(file: { readonly type: string; readonly size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return "A logo is a PNG, JPEG or WebP picture.";
  if (file.size > LOGO_MAX_BYTES) return "A logo is at most 512 KB.";
  return null;
}

/** The logo as this page shows it: its address once it is here, and whether it is still on its way. */
export interface LogoShown {
  /** A blob URL; null until it is here, and with no logo. */
  readonly url: string | null;
  /** The settings name a logo that has not arrived yet: its place is kept, not filled with another mark. */
  readonly waiting: boolean;
}

/** A logo, fetched once per picture (the owner's key or cookie goes with it, so never a plain `src`). */
export function useLogoUrl(sha256: string | null | undefined, slot: LogoSlot = "logo"): LogoShown {
  const v = sha256 ? sha256.slice(0, 16) : null;
  const file = useQuery({
    queryKey: qk.logo(v ?? "", slot),
    queryFn: async () => (await api.logo(v ?? "", slot)).blob,
    enabled: v !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  const blob = v ? file.data : undefined;
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return { url, waiting: v !== null && url === null && !file.isError };
}

/** Upload and remove a logo; the answer is the settings, as a save's is. */
export function useLogoWrite(slot: LogoSlot = "logo") {
  const qc = useQueryClient();
  const saved = (data: SettingsDoc) => qc.setQueryData(qk.settings, data);
  const upload = useMutation({ mutationFn: (file: Blob) => api.setLogo(file, slot), onSuccess: saved });
  const remove = useMutation({ mutationFn: () => api.removeLogo(slot), onSuccess: saved });
  return { upload, remove };
}
