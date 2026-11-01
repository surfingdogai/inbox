/**
 * The business's look: four themes and seven accents, as data and nothing else, so the owner app
 * reads the same tones as the server (`@surfingdog/core/look`) without bundling the rest of core.
 *
 * - Standard is the look as it was before there was a choice: a default inbox looks as it always did.
 * - Every accent has a day tone with a white label and a night tone with a dark one. Each passes WCAG
 *   AA (4.5:1) as text on every ground it sits on and as a button's label (`look-palette.test.ts`).
 * - No accent is red: red says something went wrong, and nothing else.
 * - Ink is not a colour of its own: it is the theme's own ink, the button as it was.
 */

export const LOOK_THEMES = ["standard", "minimal", "dark", "warm"] as const;
export type LookTheme = (typeof LOOK_THEMES)[number];

export const LOOK_ACCENTS = ["ink", "blue", "teal", "green", "violet", "plum", "ochre"] as const;
export type LookAccent = (typeof LOOK_ACCENTS)[number];

/** The tones of a page in one theme. */
export interface ThemeTones {
  readonly scheme: "light" | "dark";
  readonly bg: string;
  readonly fg: string;
  readonly muted: string;
  readonly rule: string;
  /** Errors only. */
  readonly err: string;
}

/**
 * Each theme's tones. Standard follows the device, so it has a night too: its two rows are the
 * customer pages' own, as they were.
 */
export const THEME_TONES: Readonly<Record<LookTheme, ThemeTones>> = {
  standard: { scheme: "light", bg: "#ffffff", fg: "#111111", muted: "#555555", rule: "#dddddd", err: "#8a1c1c" },
  minimal: { scheme: "light", bg: "#ffffff", fg: "#111111", muted: "#666666", rule: "#eeeeee", err: "#8a1c1c" },
  dark: { scheme: "dark", bg: "#141414", fg: "#ececec", muted: "#a3a3a3", rule: "#2a2a2a", err: "#f19999" },
  warm: { scheme: "light", bg: "#faf6ef", fg: "#2b2420", muted: "#6b5f55", rule: "#e6dccd", err: "#8a1c1c" },
};

/** Standard at night, when the device is dark. */
export const STANDARD_NIGHT: ThemeTones = {
  scheme: "dark",
  bg: "#111111",
  fg: "#eeeeee",
  muted: "#aaaaaa",
  rule: "#333333",
  err: "#f19999",
};

/** An accent's two tones, and the label each carries on a button. */
export interface AccentTones {
  readonly day: string;
  readonly dayFg: string;
  readonly night: string;
  readonly nightFg: string;
}

/** The accents with a colour of their own (Ink is the theme's ink). */
export const ACCENT_TONES: Readonly<Record<Exclude<LookAccent, "ink">, AccentTones>> = {
  blue: { day: "#2357b5", dayFg: "#ffffff", night: "#8cb4ff", nightFg: "#111111" },
  teal: { day: "#0b6e75", dayFg: "#ffffff", night: "#5cd0d8", nightFg: "#111111" },
  green: { day: "#2a6e3f", dayFg: "#ffffff", night: "#7ccf92", nightFg: "#111111" },
  violet: { day: "#5b45c9", dayFg: "#ffffff", night: "#ad9bff", nightFg: "#111111" },
  plum: { day: "#7d3672", dayFg: "#ffffff", night: "#e29ad6", nightFg: "#111111" },
  ochre: { day: "#8a5300", dayFg: "#ffffff", night: "#efb75a", nightFg: "#111111" },
};

export const THEME_LABELS: Readonly<Record<LookTheme, { readonly name: string; readonly line: string }>> = {
  standard: { name: "Standard", line: "As it is today" },
  minimal: { name: "Minimal", line: "White, thin lines" },
  dark: { name: "Dark", line: "Dark pages" },
  warm: { name: "Warm", line: "Soft off-white" },
};

export const ACCENT_LABELS: Readonly<Record<LookAccent, string>> = {
  ink: "Ink",
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  violet: "Violet",
  plum: "Plum",
  ochre: "Ochre",
};

/** The business's logo, as the look names it: its file under `/p/logo/`, and its size in pixels. */
export interface LookLogo {
  /** `<the first 16 of its sha256><.png|.jpg|.webp>`: a new picture is a new name. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface Look {
  readonly theme: LookTheme;
  readonly accent: LookAccent;
  readonly logo: LookLogo | null;
}

export const DEFAULT_LOOK: Look = { theme: "standard", accent: "ink", logo: null };

/** Whether the look is the one every inbox starts with: nothing anyone sees changes then. */
export function isDefaultLook(look: Look): boolean {
  return look.theme === "standard" && look.accent === "ink" && look.logo === null;
}

const LOGO_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/** The logo as the settings keep it (`look.logo`). */
interface StoredLogo {
  readonly type: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/** The logo's file name: the first 16 of its sha256, with its extension. */
export function logoFile(logo: StoredLogo): string {
  return `${logo.sha256.slice(0, 16)}${LOGO_EXTENSION[logo.type] ?? ".png"}`;
}

/** The look in a settings document. */
export function lookOf(settings: {
  readonly look: { readonly theme: LookTheme; readonly accent: LookAccent; readonly logo: StoredLogo | null };
}): Look {
  const { theme, accent, logo } = settings.look;
  return {
    theme,
    accent,
    logo: logo ? { file: logoFile(logo), width: logo.width, height: logo.height } : null,
  };
}

/**
 * The accent as one theme shows it: its tone and its label, day or night. Ink is the theme's own
 * ink on its own ground, the button as it was.
 */
export function accentIn(accent: LookAccent, tones: ThemeTones): { readonly accent: string; readonly label: string } {
  if (accent === "ink") return { accent: tones.fg, label: tones.bg };
  const a = ACCENT_TONES[accent];
  return tones.scheme === "dark" ? { accent: a.night, label: a.nightFg } : { accent: a.day, label: a.dayFg };
}
