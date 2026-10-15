import clsx from "clsx";
import { Copy, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useRef, useState } from "react";
import type { ApiProblem } from "../lib/api";
import {
  ALL_DAY,
  checkClosures,
  checkDraft,
  copyToAll,
  DEFAULT_WINDOW,
  type Draft,
  HOURS_PRESETS,
  isAllDay,
  MAX_WINDOWS,
  nextWindow,
  presetOf,
  timeLabel,
  timeSteps,
  toDraft,
  toWeekly,
  twelveHour,
  WEEKDAYS,
  withValue,
} from "../lib/hours";
import type { Closure, Weekday, Weekly } from "../lib/types";
import { Switch } from "./Form";

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

/** The value the first opening time takes for a day open all day. */
const ALL_DAY_VALUE = "all-day";

/** A time to open or close at, every quarter of an hour, as this browser writes times; 24:00 closes at midnight. */
function TimeSelect({
  value,
  kind,
  label,
  allDay,
  onChange,
}: {
  value: string;
  kind: "opens" | "closes";
  label: string;
  /** Offer "Open 24 hours" first (the day's first opening time only). */
  allDay?: boolean | undefined;
  onChange: (value: string) => void;
}) {
  const steps = useMemo(() => timeSteps(15), []);
  const hour12 = useMemo(() => twelveHour(), []);
  const times = withValue(kind === "opens" ? steps.opens : steps.closes, value === ALL_DAY_VALUE ? "" : value);
  return (
    <select
      className={clsx("input time-select", value === ALL_DAY_VALUE && "is-all-day")}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      {allDay && <option value={ALL_DAY_VALUE}>Open 24 hours</option>}
      {times.map((t) => (
        <option key={t} value={t}>
          {timeLabel(t, hour12)}
        </option>
      ))}
    </select>
  );
}

/**
 * The weekly grid: each day open or closed; open, either all day or up to six windows picked from
 * the clock. Three quick starts above it, and any day copied to the rest in one press.
 */
export function HoursEditor({
  initial,
  title,
  hint,
  unset,
  note,
  pending,
  error,
  onSave,
}: {
  initial: Weekly;
  title: string;
  hint?: string | undefined;
  /** Nothing saved yet: the grid starts empty, and says so. */
  unset?: boolean | undefined;
  /** Beside the title: where these hours were read, for the owner to check. */
  note?: ReactNode;
  pending: boolean;
  error: ApiProblem | null;
  onSave: (weekly: Weekly) => void;
}) {
  const nextId = useRef(1);
  const fromDraft = (draft: Draft): Rows => {
    const out = {} as Rows;
    for (const { key } of WEEKDAYS) out[key] = draft[key].map(([from, to]) => ({ id: nextId.current++, from, to }));
    return out;
  };
  const [rows, setRows] = useState<Rows>(() => fromDraft(toDraft(unset ? {} : initial)));
  const [local, setLocal] = useState<string | null>(null);
  const setDay = (day: Weekday, windows: readonly WindowRow[]) => setRows((r) => ({ ...r, [day]: windows }));
  const row = ([from, to]: readonly [string, string]): WindowRow => ({ id: nextId.current++, from, to });
  const current = presetOf(asDraft(rows));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const draft = asDraft(rows);
    const problem = checkDraft(draft);
    setLocal(problem);
    if (!problem) onSave(toWeekly(draft));
  };
  return (
    <form className="stack hours-grid" onSubmit={submit}>
      <div>
        <div className="sec-line">
          <h3 className="sec">{title}</h3>
          {note}
        </div>
        {unset && <p className="hint">No opening hours yet. Agents can book once you save some.</p>}
        {hint && <p className="lede small">{hint}</p>}
      </div>
      <fieldset className="chips presets">
        <legend className="sr-only">Quick starts</legend>
        {HOURS_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="chip"
            aria-pressed={current === p.key}
            onClick={() => setRows(fromDraft(p.draft))}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      <div>
        {WEEKDAYS.map(({ key, label }) => {
          const windows = rows[key];
          const open = windows.length > 0;
          const allDay = isAllDay(windows.map((w) => [w.from, w.to] as const));
          const copy = (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={`Copy ${label} to every day`}
              title="Copy to every day"
              onClick={() => setRows(fromDraft(copyToAll(asDraft(rows), key)))}
            >
              <Copy className="icon-sm" aria-hidden="true" />
            </button>
          );
          return (
            <div className="hours-day" key={key}>
              <Switch checked={open} onChange={(v) => setDay(key, v ? [row(DEFAULT_WINDOW)] : [])}>
                <span className="hours-label">{label}</span>
              </Switch>
              <div className="hours-windows">
                {!open && <span className="hint hours-closed">Closed</span>}
                {allDay ? (
                  <div className="hours-window">
                    <TimeSelect
                      kind="opens"
                      label={`${label}, opens`}
                      allDay
                      value={ALL_DAY_VALUE}
                      onChange={(v) =>
                        v !== ALL_DAY_VALUE &&
                        setDay(key, [row([v, DEFAULT_WINDOW[1] > v ? DEFAULT_WINDOW[1] : "24:00"])])
                      }
                    />
                    <span className="hours-actions">{copy}</span>
                  </div>
                ) : (
                  windows.map((w, i) => (
                    <div className="hours-window" key={w.id}>
                      <TimeSelect
                        kind="opens"
                        label={`${label}, opens`}
                        allDay={i === 0 && windows.length === 1}
                        value={w.from}
                        onChange={(v) =>
                          v === ALL_DAY_VALUE
                            ? setDay(key, [row(ALL_DAY)])
                            : setDay(
                                key,
                                windows.map((x) => (x.id === w.id ? { ...x, from: v } : x)),
                              )
                        }
                      />
                      <span className="hours-dash" aria-hidden="true">
                        –
                      </span>
                      <TimeSelect
                        kind="closes"
                        label={`${label}, closes`}
                        value={w.to}
                        onChange={(v) =>
                          setDay(
                            key,
                            windows.map((x) => (x.id === w.id ? { ...x, to: v } : x)),
                          )
                        }
                      />
                      <span className="hours-actions">
                        {i === 0 ? (
                          <>
                            {windows.length < MAX_WINDOWS && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm btn-icon"
                                aria-label={`Add hours on ${label}`}
                                title="Add hours, for a break"
                                onClick={() =>
                                  setDay(key, [
                                    ...windows,
                                    row(nextWindow(windows.map((x) => [x.from, x.to] as const))),
                                  ])
                                }
                              >
                                <Plus className="icon-sm" aria-hidden="true" />
                              </button>
                            )}
                            {copy}
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-icon"
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
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      {(local || error) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          Save hours
        </button>
      </div>
    </form>
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
  const [rows, setRows] = useState<ClosureDraft[]>(() =>
    initial.map((c, i) => ({ id: i + 1, from: c.from, to: c.to, reason: c.reason ?? "" })),
  );
  const [nextId, setNextId] = useState(initial.length + 1);
  const [local, setLocal] = useState<string | null>(null);
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
        <p className="lede small">Whole days with no bookings, like holidays. Dates are in the business time zone.</p>
      </div>
      {rows.length === 0 && <p className="hint">No closed days planned.</p>}
      {rows.map((r) => (
        <div className="closure-row" key={r.id}>
          <input
            className="input"
            type="date"
            value={r.from}
            aria-label="First closed day"
            onChange={(e) => update(r.id, { from: e.target.value })}
          />
          <span className="hours-dash">–</span>
          <input
            className="input"
            type="date"
            value={r.to}
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
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Remove this closed period"
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
      <div className="rowx">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setRows((rs) => [...rs, { id: nextId, from: "", to: "", reason: "" }]);
            setNextId((n) => n + 1);
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          Add closed days
        </button>
        <span className="sp" />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          Save closed days
        </button>
      </div>
    </form>
  );
}
