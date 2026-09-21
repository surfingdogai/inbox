import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemeMode, useTheme } from "../lib/theme";

const MODES: readonly { key: ThemeMode; label: string; Icon: LucideIcon }[] = [
  { key: "system", label: "System", Icon: Monitor },
  { key: "light", label: "Day", Icon: Sun },
  { key: "dark", label: "Night", Icon: Moon },
];

/** Day, night or the system's choice. `compact` shows icons only. */
export function ThemeSwitch({ compact }: { compact?: boolean | undefined }) {
  const [mode, setMode] = useTheme();
  return (
    <fieldset className="seg">
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
