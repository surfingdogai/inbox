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
/** Midnight at the end of a day: a window may close then, never open. */
export const MIDNIGHT = "24:00";
/** The whole day, as the inbox keeps it. */
export const ALL_DAY: Window = ["00:00", MIDNIGHT];

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

/** Whether a day's windows are the whole day: open 24 hours. */
export function isAllDay(windows: readonly Window[] | undefined): boolean {
  return windows?.length === 1 && windows[0]?.[0] === ALL_DAY[0] && windows[0]?.[1] === ALL_DAY[1];
}

const OPENS = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSES = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const fromMinutes = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

/** "18:00" + 60 → "19:00", never past midnight at the end of the day (24:00). */
export function plusMinutes(hhmm: string, minutes: number): string {
  return fromMinutes(Math.min(toMinutes(hhmm) + minutes, 24 * 60));
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
      if (!OPENS.test(open) || !CLOSES.test(close)) return `${label} has a time that is not HH:MM.`;
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

/** A day's windows as words: `09:00–13:00, 14:00–18:00`, or `open 24 hours`. */
function dayWords(windows: readonly Window[]): string {
  return isAllDay(windows) ? "open 24 hours" : windows.map(([a, b]) => `${a}–${b}`).join(", ");
}

/**
 * "Mon–Fri 09:00–18:00 · Sat 09:00–13:00", for lists and summaries. A day open from 00:00 to 24:00 is
 * "open 24 hours"; every day so is "Open all the time".
 */
export function describeWeekly(weekly: Weekly): string {
  if (WEEKDAYS.every(({ key }) => isAllDay(weekly[key]))) return "Open all the time";
  const groups: { days: string[]; text: string }[] = [];
  for (const { key, short } of WEEKDAYS) {
    const windows = weekly[key] ?? [];
    if (windows.length === 0) continue;
    const text = dayWords(windows);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(short);
    else groups.push({ days: [short], text });
  }
  if (groups.length === 0) return "Closed all week";
  return groups
    .map((g) => `${g.days.length > 2 ? `${g.days[0]}–${g.days[g.days.length - 1]}` : g.days.join(", ")} ${g.text}`)
    .join(" · ");
}

// ---- quick starts and copying -----------------------------------------------------------------

export type HoursPresetKey = "weekdays" | "weekdays_sat" | "always";

const days = (keys: readonly Weekday[], windows: readonly Window[]): Draft => {
  const draft = {} as Draft;
  for (const { key } of WEEKDAYS) draft[key] = keys.includes(key) ? windows : [];
  return draft;
};
const WEEK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

/** The three ways most businesses open, one click each. */
export const HOURS_PRESETS: readonly { readonly key: HoursPresetKey; readonly label: string; readonly draft: Draft }[] =
  [
    { key: "weekdays", label: "Weekdays 9–6", draft: days(WEEK, [["09:00", "18:00"]]) },
    {
      key: "weekdays_sat",
      label: "Weekdays + Saturday morning",
      draft: { ...days(WEEK, [["09:00", "18:00"]]), sat: [["09:00", "13:00"]] },
    },
    { key: "always", label: "Open all the time", draft: days([...WEEK, "sat", "sun"], [ALL_DAY]) },
  ];

/** The preset a draft is exactly, or null. */
export function presetOf(draft: Draft): HoursPresetKey | null {
  const same = (a: Draft, b: Draft) => WEEKDAYS.every(({ key }) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
  return HOURS_PRESETS.find((p) => same(p.draft, draft))?.key ?? null;
}

/** Every day as `from` is: its windows, open 24 hours, or closed. */
export function copyToAll(draft: Draft, from: Weekday): Draft {
  const out = {} as Draft;
  for (const { key } of WEEKDAYS) out[key] = draft[from].map(([a, b]) => [a, b] as const);
  return out;
}

// ---- the times a window can start and end at -------------------------------------------------

/** Every `step` minutes through the day: openings from 00:00, closings up to 24:00. */
export function timeSteps(step = 15): { readonly opens: readonly string[]; readonly closes: readonly string[] } {
  const opens: string[] = [];
  for (let m = 0; m < 24 * 60; m += step) opens.push(fromMinutes(m));
  return { opens, closes: [...opens.slice(1), MIDNIGHT] };
}

/** The steps, with `keep` in its place when it is off them (a 09:10 set before), so a choice never goes blank. */
export function withValue(steps: readonly string[], keep: string): readonly string[] {
  if (!keep || steps.includes(keep)) return steps;
  return [...steps, keep].sort();
}

/** Whether this browser writes times on a 12-hour clock. */
export function twelveHour(locale?: string): boolean {
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h12" || cycle === "h11";
  } catch {
    return false;
  }
}

/** A time as the owner reads it: `09:00` on a 24-hour clock, `9:00 AM` on a 12-hour one; 24:00 is midnight. */
export function timeLabel(hhmm: string, hour12: boolean): string {
  if (!hour12) return hhmm;
  if (hhmm === MIDNIGHT) return "Midnight";
  const total = toMinutes(hhmm);
  const h = Math.floor(total / 60);
  const m = String(total % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function checkClosures(closures: readonly Closure[]): string | null {
  for (const c of closures) {
    if (!YMD.test(c.from) || !YMD.test(c.to)) return "Every closed period needs a first and a last day.";
    if (c.to < c.from) return `A closed period ends (${c.to}) before it starts (${c.from}).`;
  }
  return null;
}
