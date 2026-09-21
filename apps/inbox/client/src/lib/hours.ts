import type { Closure, Weekday, Weekly, Window } from "./types";

/** Opening hours as the grid edits them: seven days, each open or closed with up to six windows. */
export const WEEKDAYS: readonly { readonly key: Weekday; readonly label: string; readonly short: string }[] = [
  { key: "mon", label: "Monday", short: "Mon" },
  { key: "tue", label: "Tuesday", short: "Tue" },
  { key: "wed", label: "Wednesday", short: "Wed" },
  { key: "thu", label: "Thursday", short: "Thu" },
  { key: "fri", label: "Friday", short: "Fri" },
  { key: "sat", label: "Saturday", short: "Sat" },
  { key: "sun", label: "Sunday", short: "Sun" },
];

export const MAX_WINDOWS = 6;
export const DEFAULT_WINDOW: Window = ["09:00", "18:00"];

export type Draft = Record<Weekday, readonly Window[]>;

export function toDraft(weekly: Weekly): Draft {
  const draft = {} as Draft;
  for (const { key } of WEEKDAYS) draft[key] = (weekly[key] ?? []).map(([a, b]) => [a, b] as const);
  return draft;
}

/** Closed days leave the document, as the API expects. */
export function toWeekly(draft: Draft): Weekly {
  const out: Record<string, Window[]> = {};
  for (const { key } of WEEKDAYS) {
    if (draft[key].length > 0) out[key] = draft[key].map(([a, b]) => [a, b]);
  }
  return out as Weekly;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "18:00" + 60 → "19:00", never past 23:59. */
export function plusMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = Math.min((h ?? 0) * 60 + (m ?? 0) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The window to add after the last one: it starts where that one ended and runs an hour. */
export function nextWindow(windows: readonly Window[]): Window {
  const last = windows[windows.length - 1];
  if (!last) return DEFAULT_WINDOW;
  const start = last[1] >= "23:00" ? "09:00" : last[1];
  return [start, plusMinutes(start, 60)];
}

/** The first thing wrong with the draft, as a sentence, or null. */
export function checkDraft(draft: Draft): string | null {
  for (const { key, label } of WEEKDAYS) {
    const windows = draft[key];
    if (windows.length > MAX_WINDOWS) return `${label} can have at most ${MAX_WINDOWS} opening windows.`;
    for (const [open, close] of windows) {
      if (!HHMM.test(open) || !HHMM.test(close)) return `${label} has a time that is not HH:MM.`;
      if (close <= open) return `${label} closes at ${close}, before it opens at ${open}.`;
    }
    const sorted = [...windows].sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && cur[0] < prev[1])
        return `${label} has overlapping windows (${prev.join("–")} and ${cur.join("–")}).`;
    }
  }
  return null;
}

/** "Mon–Fri 09:00–18:00 · Sat 09:00–13:00", for lists and summaries. */
export function describeWeekly(weekly: Weekly): string {
  const groups: { days: string[]; text: string }[] = [];
  for (const { key, short } of WEEKDAYS) {
    const windows = weekly[key] ?? [];
    if (windows.length === 0) continue;
    const text = windows.map(([a, b]) => `${a}–${b}`).join(", ");
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(short);
    else groups.push({ days: [short], text });
  }
  if (groups.length === 0) return "Closed all week";
  return groups
    .map((g) => `${g.days.length > 2 ? `${g.days[0]}–${g.days[g.days.length - 1]}` : g.days.join(", ")} ${g.text}`)
    .join(" · ");
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function checkClosures(closures: readonly Closure[]): string | null {
  for (const c of closures) {
    if (!YMD.test(c.from) || !YMD.test(c.to)) return "Every closed period needs a first and a last day.";
    if (c.to < c.from) return `A closed period ends (${c.to}) before it starts (${c.from}).`;
  }
  return null;
}
