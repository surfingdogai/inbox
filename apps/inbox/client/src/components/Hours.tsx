import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useRef, useState } from "react";
import type { ApiProblem } from "../lib/api";
import {
  ALL_DAY,
  checkClosures,
  checkDraft,
  copyToAll,
  DEFAULT_WINDOW,
  type Draft,
  dayWords,
  everyDaySame,
  HOURS_PRESETS,
  isAllDay,
  laterThan,
  MAX_WINDOWS,
  nextWindow,
  plusMinutes,
  timeLabel,
  timeSteps,
  toDraft,
  toWeekly,
  twelveHour,
  WEEKDAYS,
  withValue,
} from "../lib/hours";
import type { Closure, Weekday, Weekly } from "../lib/types";
import { FormActions, Switch } from "./Form";

interface WindowRow {
  readonly id: number;
  readonly from: string;
  readonly to: string;
}
type Rows = Record<Weekday, readonly WindowRow[]>;

const asDraft = (rows: Rows): Draft => {
  const draft = {} as Draft;
  for (const { key } of WEEKDAYS) draft[key] = rows[key].map((w) => [w.from, w.to] as const);
  return draft;
};

/** A time to open or close at, every quarter of an hour, as this browser writes times; 24:00 closes at midnight. */
function TimeSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: string;
  options: readonly string[];
  label: string;
  onChange: (value: string) => void;
}) {
  const hour12 = useMemo(() => twelveHour(), []);
  return (
    <select className="input time-select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {withValue(options, value).map((t) => (
        <option key={t} value={t}>
          {timeLabel(t, hour12)}
        </option>
      ))}
    </select>
  );
}

/**
 * The weekly grid: each day open or closed; open, either 24 hours or up to six windows picked from
 * the clock, a closing time always after its opening one. Three quick starts above it (one-off
 * actions, not modes), and one "Copy to all days" on the first open day. A week open every day the
 * same way reads as one line until the owner asks to edit the days.
 *
 * With `onSave`, the editor saves on its own button, enabled once something changed. With `onChange`
 * instead, every change is passed up as it is made (the setup wizard saves it when it moves on).
 */
export function HoursEditor({
  initial,
  title,
  hint,
  unset,
  note,
  person = false,
  pending,
  error,
  onSave,
  onChange,
}: {
  initial: Weekly;
  title: string;
  /** One member of staff's hours: their days on or off, never "open all the time" or a 24-hour day. */
  person?: boolean | undefined;
  hint?: ReactNode;
  /** Nothing saved yet: the grid starts empty, and says so. */
  unset?: boolean | undefined;
  /** Beside the title: where these hours were read, for the owner to check. Gone once they change them. */
  note?: ReactNode;
  pending: boolean;
  error: ApiProblem | null;
  onSave?: ((weekly: Weekly) => void) | undefined;
  onChange?: ((weekly: Weekly) => void) | undefined;
}) {
  const nextId = useRef(1);
  const fromDraft = (draft: Draft): Rows => {
    const out = {} as Rows;
    for (const { key } of WEEKDAYS) out[key] = draft[key].map(([from, to]) => ({ id: nextId.current++, from, to }));
    return out;
  };
  const [start] = useState(() => toDraft(unset ? {} : initial));
  const [rows, setRowsState] = useState<Rows>(() => fromDraft(start));
  const [expanded, setExpanded] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const steps = useMemo(() => timeSteps(15), []);
  const draft = asDraft(rows);
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  const setRows = (next: Rows) => {
    setRowsState(next);
    setLocal(null);
    onChange?.(toWeekly(asDraft(next)));
  };
  const setDay = (day: Weekday, windows: readonly WindowRow[]) => setRows({ ...rows, [day]: windows });
  const row = ([from, to]: readonly [string, string]): WindowRow => ({ id: nextId.current++, from, to });
  const same = everyDaySame(draft);
  const collapsed = same !== null && !expanded;
  const firstOpen = WEEKDAYS.find(({ key }) => rows[key].length > 0)?.key;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !onSave) return;
    const problem = checkDraft(draft);
    setLocal(problem);
    if (!problem) onSave(toWeekly(draft));
  };
  // Inside another form (a member of staff's), it is part of that form: never a form of its own.
  const Tag = onSave ? "form" : "div";
  return (
    <Tag className="stack hours-grid" {...(onSave ? { onSubmit: submit } : {})}>
      <div>
        <div className="sec-line">
          <h3 className="sec">{title}</h3>
          {!dirty && note}
        </div>
        {hint && <p className="lede small">{hint}</p>}
      </div>
      <fieldset className="chips presets">
        <legend className="sr-only">Quick starts</legend>
        {HOURS_PRESETS.filter((p) => !person || p.key !== "always").map((p) => (
          <button
            key={p.key}
            type="button"
            className="chip chip-action"
            onClick={() => {
              setRows(fromDraft(p.draft));
              setExpanded(false);
            }}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      {collapsed ? (
        <div className="hours-day hours-every">
          <span className="hours-label">Every day</span>
          <span className="hours-summary">{dayWords(same, true)}</span>
          <button type="button" className="linkish" onClick={() => setExpanded(true)}>
            Edit days
          </button>
        </div>
      ) : (
        <div>
          {WEEKDAYS.map(({ key, label }) => {
            const windows = rows[key];
            const open = windows.length > 0;
            const allDay = isAllDay(windows.map((w) => [w.from, w.to] as const));
            return (
              <div className={clsx("hours-day", !open && "is-closed")} key={key}>
                <Switch checked={open} onChange={(v) => setDay(key, v ? [row(DEFAULT_WINDOW)] : [])}>
                  <span className="hours-label">{label}</span>
                </Switch>
                <div className="hours-windows">
                  {!open && <span className="hint hours-closed">{person ? "Off" : "Closed"}</span>}
                  {open && allDay && <span className="hours-summary">Open 24 hours</span>}
                  {open &&
                    !allDay &&
                    windows.map((w, i) => (
                      <div className="hours-window" key={w.id}>
                        <TimeSelect
                          label={`${label}, opens`}
                          options={steps.opens}
                          value={w.from}
                          onChange={(v) =>
                            setDay(
                              key,
                              windows.map((x) =>
                                // A closing time before the new opening one moves on with it.
                                x.id === w.id ? { ...x, from: v, to: x.to > v ? x.to : plusMinutes(v, 60) } : x,
                              ),
                            )
                          }
                        />
                        <span className="hours-dash" aria-hidden="true">
                          –
                        </span>
                        <TimeSelect
                          label={`${label}, closes`}
                          options={laterThan(steps.closes, w.from)}
                          value={w.to}
                          onChange={(v) =>
                            setDay(
                              key,
                              windows.map((x) => (x.id === w.id ? { ...x, to: v } : x)),
                            )
                          }
                        />
                        {i === 0 && windows.length < MAX_WINDOWS && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-icon hours-icon"
                            aria-label={`Add hours on ${label}, for a break`}
                            title="Add hours, for a break"
                            onClick={() =>
                              setDay(key, [...windows, row(nextWindow(windows.map((x) => [x.from, x.to] as const)))])
                            }
                          >
                            <Plus className="icon-sm" aria-hidden="true" />
                          </button>
                        )}
                        {i > 0 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-icon hours-icon"
                            aria-label={`Remove ${label} ${w.from}–${w.to}`}
                            onClick={() =>
                              setDay(
                                key,
                                windows.filter((x) => x.id !== w.id),
                              )
                            }
                          >
                            <X className="icon-sm" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ))}
                </div>
                {open && (
                  <span className="hours-end">
                    {!person && (
                      <button
                        type="button"
                        className="chip chip-toggle"
                        aria-pressed={allDay}
                        aria-label={`${label}: open 24 hours`}
                        onClick={() => setDay(key, [row(allDay ? DEFAULT_WINDOW : ALL_DAY)])}
                      >
                        24 h
                      </button>
                    )}
                    {key === firstOpen && (
                      <button
                        type="button"
                        className="linkish hours-copy"
                        onClick={() => setRows(fromDraft(copyToAll(draft, key)))}
                      >
                        Copy to all days
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(local || error) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      {onSave && (
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={pending || !dirty}>
            {pending && <span className="spinner" aria-hidden="true" />}
            Save hours
          </button>
        </FormActions>
      )}
    </Tag>
  );
}

interface ClosureDraft {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/** Whole days off: holidays, a closed week, a fair. */
export function ClosuresEditor({
  initial,
  pending,
  error,
  onSave,
}: {
  initial: readonly Closure[];
  pending: boolean;
  error: ApiProblem | null;
  onSave: (closures: readonly Closure[]) => void;
}) {
  const [start] = useState<ClosureDraft[]>(() =>
    initial.map((c, i) => ({ id: i + 1, from: c.from, to: c.to, reason: c.reason ?? "" })),
  );
  const [rows, setRows] = useState<ClosureDraft[]>(start);
  const [nextId, setNextId] = useState(initial.length + 1);
  const [local, setLocal] = useState<string | null>(null);
  const dirty = JSON.stringify(rows) !== JSON.stringify(start);
  const update = (id: number, patch: Partial<ClosureDraft>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const closures: Closure[] = rows.map((r) => ({
      from: r.from,
      to: r.to || r.from,
      ...(r.reason.trim() ? { reason: r.reason.trim() } : {}),
    }));
    const problem = checkClosures(closures);
    setLocal(problem);
    if (!problem) onSave(closures);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <h3 className="sec">Closed days</h3>
        <p className="lede small">Holidays and days off. No bookings on them.</p>
      </div>
      {rows.length === 0 && <p className="hint">None planned.</p>}
      {rows.map((r) => (
        <div className="closure-row" key={r.id}>
          <input
            className="input"
            type="date"
            value={r.from}
            aria-label="First closed day"
            onChange={(e) =>
              update(r.id, { from: e.target.value, to: r.to && r.to >= e.target.value ? r.to : e.target.value })
            }
          />
          <span className="hours-dash" aria-hidden="true">
            –
          </span>
          <input
            className="input"
            type="date"
            value={r.to}
            min={r.from || undefined}
            aria-label="Last closed day"
            onChange={(e) => update(r.id, { to: e.target.value })}
          />
          <input
            className="input"
            placeholder="Reason, optional"
            aria-label="Reason"
            value={r.reason}
            onChange={(e) => update(r.id, { reason: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon hours-icon"
            aria-label="Remove these closed days"
            onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
          >
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
      ))}
      {(local || error) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <FormActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm form-actions-start"
          onClick={() => {
            setRows((rs) => [...rs, { id: nextId, from: "", to: "", reason: "" }]);
            setNextId((n) => n + 1);
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          Add closed days
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !dirty}>
          {pending && <span className="spinner" aria-hidden="true" />}
          Save closed days
        </button>
      </FormActions>
    </form>
  );
}
