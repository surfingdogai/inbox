import { Plus, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import type { ApiProblem } from "../lib/api";
import {
  checkClosures,
  checkDraft,
  DEFAULT_WINDOW,
  type Draft,
  MAX_WINDOWS,
  nextWindow,
  toDraft,
  toWeekly,
  WEEKDAYS,
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

/** The weekly grid: each day open or closed, with up to six windows of HH:MM. */
export function HoursEditor({
  initial,
  title,
  hint,
  pending,
  error,
  onSave,
}: {
  initial: Weekly;
  title: string;
  hint?: string | undefined;
  pending: boolean;
  error: ApiProblem | null;
  onSave: (weekly: Weekly) => void;
}) {
  const nextId = useRef(1);
  const [rows, setRows] = useState<Rows>(() => {
    const draft = toDraft(initial);
    const out = {} as Rows;
    for (const { key } of WEEKDAYS) out[key] = draft[key].map(([from, to]) => ({ id: nextId.current++, from, to }));
    return out;
  });
  const [local, setLocal] = useState<string | null>(null);
  const setDay = (day: Weekday, windows: readonly WindowRow[]) => setRows((r) => ({ ...r, [day]: windows }));
  const row = ([from, to]: readonly [string, string]): WindowRow => ({ id: nextId.current++, from, to });
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
        <h3 className="sec">{title}</h3>
        {hint && <p className="lede small">{hint}</p>}
      </div>
      {WEEKDAYS.map(({ key, label }) => {
        const windows = rows[key];
        const open = windows.length > 0;
        return (
          <div className="hours-day" key={key}>
            <Switch checked={open} onChange={(v) => setDay(key, v ? [row(DEFAULT_WINDOW)] : [])}>
              <span className="hours-label">{label}</span>
            </Switch>
            <div className="hours-windows">
              {!open && <span className="hint">Closed</span>}
              {windows.map((w) => (
                <div className="hours-window" key={w.id}>
                  <input
                    className="input"
                    type="time"
                    step={900}
                    value={w.from}
                    aria-label={`${label}, opens`}
                    onChange={(e) =>
                      setDay(
                        key,
                        windows.map((x) => (x.id === w.id ? { ...x, from: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="hours-dash">–</span>
                  <input
                    className="input"
                    type="time"
                    step={900}
                    value={w.to}
                    aria-label={`${label}, closes`}
                    onChange={(e) =>
                      setDay(
                        key,
                        windows.map((x) => (x.id === w.id ? { ...x, to: e.target.value } : x)),
                      )
                    }
                  />
                  {windows.length > 1 && (
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
                      <X className="icon" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              {open && windows.length < MAX_WINDOWS && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    setDay(key, [...windows, row(nextWindow(windows.map((x) => [x.from, x.to] as const)))])
                  }
                >
                  <Plus className="icon" aria-hidden="true" />
                  Add a window
                </button>
              )}
            </div>
          </div>
        );
      })}
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
