import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemeMode, useTheme } from "../lib/theme";

const MODES: readonly { key: ThemeMode; label: string; Icon: LucideIcon }[] = [
  { key: "system", label: "System", Icon: Monitor },
  { key: "light", label: "Day", Icon: Sun },
  { key: "dark", label: "Night", Icon: Moon },
];

/** Day, night or the system's choice. `compact` shows icons only. */
export function ThemeSwitch({ compact, className }: { compact?: boolean | undefined; className?: string | undefined }) {
  const [mode, setMode] = useTheme();
  return (
    <fieldset className={className ? `seg ${className}` : "seg"}>
      <legend className="sr-only">Theme</legend>
      {MODES.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          aria-pressed={mode === key}
          aria-label={compact ? label : undefined}
          title={label}
          onClick={() => setMode(key)}
        >
          <Icon className="icon-sm" aria-hidden="true" />
          {!compact && <span>{label}</span>}
        </button>
      ))}
    </fieldset>
  );
}

/** On a phone: one button that steps through system, day and night, its icon the mode now. */
export function ThemeButton({ className }: { className?: string | undefined }) {
  const [mode, setMode] = useTheme();
  const at = MODES.findIndex((m) => m.key === mode);
  const now = MODES[at] ?? MODES[0];
  const next = MODES[(at + 1) % MODES.length] ?? MODES[0];
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
