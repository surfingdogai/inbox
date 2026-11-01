import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemeMode, useLookTheme, useTheme } from "../lib/theme";

type Mode = { key: ThemeMode; label: string; title: string; Icon: LucideIcon };

/**
 * System, day and night. Once the business chose a theme (Settings → Look), System is Auto: it
 * follows that theme (`lib/theme.ts`), not the device.
 */
function useModes(): readonly Mode[] {
  const auto = useLookTheme() !== null;
  return [
    auto
      ? { key: "system", label: "Auto", title: "As your business's look", Icon: Monitor }
      : { key: "system", label: "System", title: "System", Icon: Monitor },
    { key: "light", label: "Day", title: "Day", Icon: Sun },
    { key: "dark", label: "Night", title: "Night", Icon: Moon },
  ];
}

/** Day, night or the system's choice (Auto, with a theme chosen). `compact` shows icons only. */
export function ThemeSwitch({ compact, className }: { compact?: boolean | undefined; className?: string | undefined }) {
  const [mode, setMode] = useTheme();
  const modes = useModes();
  return (
    <fieldset className={className ? `seg ${className}` : "seg"}>
      <legend className="sr-only">Theme</legend>
      {modes.map(({ key, label, title, Icon }) => (
        <button
          key={key}
          type="button"
          aria-pressed={mode === key}
          aria-label={compact ? label : undefined}
          title={title}
          onClick={() => setMode(key)}
        >
          <Icon className="icon-sm" aria-hidden="true" />
          {!compact && <span>{label}</span>}
        </button>
      ))}
    </fieldset>
  );
}

/** On a phone: one button that steps through system (or Auto), day and night, its icon the mode now. */
export function ThemeButton({ className }: { className?: string | undefined }) {
  const [mode, setMode] = useTheme();
  const modes = useModes();
  const at = modes.findIndex((m) => m.key === mode);
  const now = modes[at] ?? modes[0];
  const next = modes[(at + 1) % modes.length] ?? modes[0];
  if (!now || !next) return null;
  const Icon = now.Icon;
  return (
    <button
      type="button"
      className={["btn btn-ghost btn-icon", className].filter(Boolean).join(" ")}
      aria-label={`Theme: ${now.label}. Switch to ${next.label}`}
      title={`Theme: ${now.label}`}
      onClick={() => setMode(next.key)}
    >
      <Icon className="icon" aria-hidden="true" />
    </button>
  );
}
