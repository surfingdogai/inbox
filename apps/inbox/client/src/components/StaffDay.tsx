import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { formatClock } from "../lib/format";
import { minutesIn, todayIn, useStaff, useStaffDay } from "../lib/staff";
import "./staff.css";

/**
 * The day by staff (ADR-035), on the inbox home of a salon: a thin column for each person in the
 * owner's order, their bookings placed by the hour, a request dashed until it is confirmed, and a
 * column for bookings with nobody yet. Shown only once the business lists staff.
 */
export function StaffDayCard({ tz }: { tz: string | undefined }) {
  const zone = tz ?? "UTC";
  const staff = useStaff();
  const listed = (staff.data?.items ?? []).some((s) => s.active);
  const [offset, setOffset] = useState(0);
  const date = todayIn(zone, Date.now() + offset * 86_400_000);
  const day = useStaffDay(date, listed);
  if (!listed) return null;
  const columns = day.data?.columns ?? [];
  const all = columns.flatMap((c) => c.bookings);
  // From an hour before the first booking (or nine) to an hour after the last (or six).
  const first = all.length ? Math.min(...all.map((b) => minutesIn(b.start, zone))) : 9 * 60;
  const last = all.length ? Math.max(...all.map((b) => minutesIn(b.end, zone))) : 18 * 60;
  const from = Math.max(0, Math.floor(Math.min(first, 9 * 60) / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil(Math.max(last, 18 * 60) / 60) * 60);
  const hourPx = 44;
  const px = (min: number) => ((min - from) / 60) * hourPx;
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  const label = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: zone,
  }).format(new Date(`${date}T12:00:00Z`));
  return (
    <section className="card glass stack staffday">
      <div className="rowx">
        <h3 className="sec">By staff · {label}</h3>
        <span className="sp" />
        <fieldset className="seg">
          <legend className="sr-only">Which day</legend>
          <button type="button" aria-label="The day before" onClick={() => setOffset((o) => o - 1)}>
            <ChevronLeft className="icon-sm" aria-hidden="true" />
          </button>
          <button type="button" aria-pressed={offset === 0} onClick={() => setOffset(0)}>
            Today
          </button>
          <button type="button" aria-label="The day after" onClick={() => setOffset((o) => o + 1)}>
            <ChevronRight className="icon-sm" aria-hidden="true" />
          </button>
        </fieldset>
      </div>
      {day.isError && <p className="hint error">{problemOf(day.error).detail}</p>}
      {day.isPending && <div className="skeleton sk-line" />}
      {day.isSuccess && (
        <div
          className="staffday-grid"
          style={{ gridTemplateColumns: `36px repeat(${columns.length}, minmax(140px, 1fr))` }}
        >
          <div className="staffday-col" style={{ minWidth: 36 }}>
            <div className="staffday-head">&nbsp;</div>
            <div className="staffday-times" style={{ height: px(to) }}>
              {hours.map((h) => (
                <span key={h} style={{ top: px(h) }}>
                  {String(h / 60).padStart(2, "0")}
                </span>
              ))}
            </div>
          </div>
          {columns.map((c) => (
            <div key={c.staff?.id ?? "nobody"} className="staffday-col">
              <div className="staffday-head">
                <span className="staff-avatar is-initials" aria-hidden="true">
                  {(c.staff?.name ?? "?").slice(0, 1)}
                </span>
                {c.staff?.name ?? "With nobody yet"}
                <span className="hint">· {c.bookings.length}</span>
              </div>
              <div className="staffday-track" style={{ height: px(to), ["--hour" as string]: `${hourPx}px` }}>
                {c.bookings.map((b, i) => {
                  const top = px(minutesIn(b.start, zone));
                  const lane = lanes(c.bookings, zone)[i] ?? { at: 0, of: 1 };
                  const height = Math.max(18, px(minutesIn(b.end, zone)) - top - 2);
                  const request = b.state !== "confirmed" && b.state !== "completed";
                  return (
                    <Link
                      key={b.id}
                      to="/items/$id"
                      params={{ id: b.id }}
                      search={(prev) => prev}
                      className={`staffday-block${request ? " is-request" : ""}${b.needsHuman ? " is-needs" : ""}`}
                      style={{
                        top,
                        height,
                        left: `calc(${(lane.at / lane.of) * 100}% + 4px)`,
                        width: `calc(${100 / lane.of}% - 6px)`,
                        right: "auto",
                      }}
                      title={`${formatClock(b.start, zone)} ${b.service}${b.customer ? ` · ${b.customer}` : ""}`}
                    >
                      <b>{formatClock(b.start, zone)}</b> {b.service}
                      {b.customer && <div className="hint">{b.customer}</div>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Side by side where bookings overlap (two requests for one person's afternoon): each gets a lane, and
 * the lanes of one overlapping run share the column.
 */
function lanes(
  bookings: readonly { readonly start: string; readonly end: string }[],
  zone: string,
): { at: number; of: number }[] {
  const spans = bookings.map((b, i) => ({ i, s: minutesIn(b.start, zone), e: minutesIn(b.end, zone) }));
  const order = [...spans].sort((a, b) => a.s - b.s || a.e - b.e);
  const out: { at: number; of: number }[] = bookings.map(() => ({ at: 0, of: 1 }));
  let run: typeof order = [];
  let runEnd = -1;
  const close = () => {
    const ends: number[] = [];
    const at = new Map<number, number>();
    for (const x of run) {
      let lane = ends.findIndex((end) => end <= x.s);
      if (lane < 0) lane = ends.push(x.e) - 1;
      else ends[lane] = x.e;
      at.set(x.i, lane);
    }
    for (const x of run) out[x.i] = { at: at.get(x.i) ?? 0, of: Math.max(1, ends.length) };
    run = [];
  };
  for (const x of order) {
    if (run.length > 0 && x.s >= runEnd) close();
    run.push(x);
    runEnd = Math.max(runEnd, x.e);
  }
  if (run.length > 0) close();
  return out;
}
