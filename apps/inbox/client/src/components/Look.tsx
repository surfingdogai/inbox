import {
  ACCENT_LABELS,
  LOOK_ACCENTS,
  LOOK_THEMES,
  type LookAccent,
  type LookTheme,
  THEME_LABELS,
} from "@surfingdog/core/look";
import type { CSSProperties } from "react";
import { accentTone, tonesOf } from "../lib/look";

/**
 * Settings → Look, drawn: four small pages to choose a theme from, seven dots for the accent, and
 * what customers see with both. Pickers only; each press saves.
 */

const vars = (v: Record<string, string>) => v as CSSProperties;

export function ThemeSwatches({
  theme,
  accent,
  disabled,
  onChoose,
}: {
  theme: LookTheme;
  accent: LookAccent;
  disabled?: boolean | undefined;
  onChoose: (theme: LookTheme) => void;
}) {
  return (
    <fieldset className="chips-field" disabled={disabled}>
      <legend className="label">Theme</legend>
      <div role="radiogroup" aria-label="Theme" className="look-swatches">
        {LOOK_THEMES.map((t) => {
          const tones = tonesOf(t);
          const a = accentTone(t, accent);
          return (
            <label key={t} className="look-swatch">
              <input
                type="radio"
                className="sr-only"
                name="look-theme"
                value={t}
                checked={theme === t}
                onChange={() => onChoose(t)}
              />
              <span
                className="look-mini"
                data-look={t}
                aria-hidden="true"
                style={vars({ "--m-bg": tones.bg, "--m-fg": tones.fg, "--m-rule": tones.rule, "--m-accent": a.accent })}
              >
                <i className="m-line" />
                <i className="m-line m-second" />
                <i className="m-rule" />
                <i className="m-button" />
              </span>
              <span className="look-name">{THEME_LABELS[t].name}</span>
              <span className="look-line">{THEME_LABELS[t].line}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function AccentDots({
  theme,
  accent,
  disabled,
  onChoose,
}: {
  theme: LookTheme;
  accent: LookAccent;
  disabled?: boolean | undefined;
  onChoose: (accent: LookAccent) => void;
}) {
  const tones = tonesOf(theme);
  return (
    <fieldset className="chips-field" disabled={disabled}>
      <legend className="label">Accent</legend>
      <div className="look-dots-row">
        {/* On the theme's own ground, as customers see them, whatever this app's ground is now. */}
        <div
          role="radiogroup"
          aria-label="Accent"
          className="look-dots"
          style={vars({ "--m-bg": tones.bg, "--m-fg": tones.fg, "--m-rule": tones.rule })}
        >
          {LOOK_ACCENTS.map((a) => (
            <label key={a} className="look-dot" title={ACCENT_LABELS[a]}>
              <input
                type="radio"
                className="sr-only"
                name="look-accent"
                value={a}
                checked={accent === a}
                onChange={() => onChoose(a)}
              />
              <span aria-hidden="true" style={vars({ "--d": accentTone(theme, a).accent })} />
              <span className="sr-only">{ACCENT_LABELS[a]}</span>
            </label>
          ))}
        </div>
        <span className="look-chosen" aria-hidden="true">
          {ACCENT_LABELS[accent]}
        </span>
      </div>
      <p className="fine">For buttons and links.</p>
    </fieldset>
  );
}

/** What a customer's page looks like with this look: the logo or the name, a heading, a line, a button, a link. */
export function LookPreview({
  theme,
  accent,
  business,
  logoUrl,
}: {
  theme: LookTheme;
  accent: LookAccent;
  business: string;
  logoUrl: string | null;
}) {
  const tones = tonesOf(theme);
  const a = accentTone(theme, accent);
  return (
    <figure className="look-figure">
      <figcaption className="label">What your customers see</figcaption>
      <div
        className="look-preview"
        data-look={theme}
        style={vars({
          "--p-bg": tones.bg,
          "--p-fg": tones.fg,
          "--p-muted": tones.muted,
          "--p-rule": tones.rule,
          "--p-accent": a.accent,
          "--p-accent-fg": a.label,
        })}
      >
        <p className="biz">
          {logoUrl && <img src={logoUrl} alt="" />}
          {business}
        </p>
        <p className="h">Your booking</p>
        <p className="t">Tuesday at 10:00, for an hour.</p>
        <p className="acts">
          <span className="b">Confirm</span>
          <span className="l">Ask a question</span>
        </p>
      </div>
      <p className="fine">Emails stay light, whatever the theme.</p>
    </figure>
  );
}
