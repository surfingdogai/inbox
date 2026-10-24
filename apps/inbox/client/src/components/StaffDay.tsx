import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { formatClock } from "../lib/format";
import { useAvailability } from "../lib/queries";
import { blockLines, minutesIn, todayIn, useStaff, useStaffDay } from "../lib/staff";
import type { Weekly } from "../lib/types";
import "./staff.css";

/**
 * The day by staff (ADR-035), on the inbox home of a salon: a thin column for each person in the
 * owner's order, their bookings placed by the hour, a request dashed until it is confirmed, and a
 * column for bookings with nobody yet. The day runs the business's hours that day (and any booking
 * outside them); each column is shaded outside that person's own hours, and says "Off" for someone not
 * working that day. Only the columns scroll sideways, under the hours, which stay in view. Shown only
 * once the business lists staff.
 */
export function StaffDayCard({
  tz,
  compact = false,
}: {
  tz: string | undefined;
  /** Above the list on a phone: a day with nothing booked is one line, not an empty grid. */
  compact?: boolean;
}) {
  const zone = tz ?? "UTC";
  const staff = useStaff();
  const listed = (staff.data?.items ?? []).some((s) => s.active);
  const [offset, setOffset] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const date = todayIn(zone, Date.now() + offset * 86_400_000);
  const day = useStaffDay(date, listed);
  const availability = useAvailability();
  if (!listed) return null;
  const columns = day.data?.columns ?? [];
  const all = columns.flatMap((c) => c.bookings);
  const weekday = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? "mon";
  const open = windowsOf(availability.data?.weekly, weekday);
  // The business's hours that day, and any booking outside them; nine to six when it set none.
  const opens = open.length ? Math.min(...open.map((w) => w[0])) : 9 * 60;
  const closes = open.length ? Math.max(...open.map((w) => w[1])) : 18 * 60;
  const first = Math.min(opens, ...all.map((b) => minutesIn(b.start, zone)));
  const last = Math.max(closes, ...all.map((b) => minutesIn(b.end, zone)));
  const from = Math.max(0, Math.floor(first / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil(last / 60) * 60);
  const people = new Map((staff.data?.items ?? []).map((s) => [s.id, s]));
  // Their own hours that day, else the business's.
  const hoursOf = (id: string | undefined) => {
    const own = id ? people.get(id)?.hours : null;
    return own ? windowsOf(own, weekday) : open;
  };
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
      {day.isSuccess && compact && all.length === 0 && (
        <p className="hint">{offset === 0 ? "Nothing booked today." : "Nothing booked that day."}</p>
      )}
      {day.isSuccess && !(compact && all.length === 0) && (
        <div
          className={`staffday-scroll${scrolled ? " is-scrolled" : ""}`}
          onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
        >
          <div
            className="staffday-grid"
            style={{ gridTemplateColumns: `36px repeat(${columns.length}, minmax(140px, 1fr))` }}
          >
            <div className="staffday-col staffday-ruler" style={{ minWidth: 36 }}>
              <div className="staffday-head">&nbsp;</div>
              <div className="staffday-times" style={{ height: px(to) }}>
                {hours.map((h) => (
                  <span key={h} style={{ top: px(h) }}>
                    {String(h / 60).padStart(2, "0")}
                  </span>
                ))}
              </div>
            </div>
            {columns.map((c) => {
              const works = c.staff ? hoursOf(c.staff.id) : null;
              const off = works !== null && works.length === 0;
              return (
                <div key={c.staff?.id ?? "nobody"} className="staffday-col">
                  {/* One height for every head, so each column's hours line up with the ruler's. */}
                  <div className="staffday-head" title={c.staff?.name ?? "Not given to anyone yet"}>
                    <span className="staff-avatar is-initials" aria-hidden="true">
                      {(c.staff?.name ?? "?").slice(0, 1)}
                    </span>
                    <span className="staffday-who">
                      <span className="staffday-name">{c.staff?.name ?? "Nobody yet"}</span>
                      <span className="staffday-count">
                        {c.bookings.length} booking{c.bookings.length === 1 ? "" : "s"}
                        {off && <span className="pill pill-xs">Off</span>}
                      </span>
                    </span>
                  </div>
                  <div className="staffday-track" style={{ height: px(to), ["--hour" as string]: `${hourPx}px` }}>
                    {works &&
                      outside(works, from, to).map(([a, b]) => (
                        <div
                          key={a}
                          className="staffday-off"
                          style={{ top: px(a), height: px(b) - px(a) }}
                          aria-hidden="true"
                        />
                      ))}
                    {c.bookings.map((b, i) => {
                      const top = px(minutesIn(b.start, zone));
                      const lane = lanes(c.bookings, zone)[i] ?? { at: 0, of: 1 };
                      const height = Math.max(18, px(minutesIn(b.end, zone)) - top - 2);
                      const request = b.state !== "confirmed" && b.state !== "completed";
                      const clock = formatClock(b.start, zone);
                      const lines = blockLines({
                        clock,
                        service: b.service,
                        customer: b.customer,
                        height,
                        narrow: lane.of > 1,
                      });
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
                          title={`${clock} ${b.service}${b.customer ? ` · ${b.customer}` : ""}`}
                          aria-label={`${clock} ${b.service}${b.customer ? `, ${b.customer}` : ""}`}
                        >
                          {lines.map((l) => (
                            <span key={l.id} className={l.id === "who" ? "staffday-line hint" : "staffday-line"}>
                              {l.clock && <b>{l.clock}</b>}
                              {l.clock && l.text ? " " : ""}
                              {l.text}
                            </span>
                          ))}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** A day's windows as minutes since midnight. */
function windowsOf(weekly: Weekly | null | undefined, day: string): [number, number][] {
  const list = ((weekly ?? {}) as Record<string, readonly (readonly [string, string])[] | undefined>)[day] ?? [];
  const min = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return list.map(([a, b]) => [min(a), min(b)] as [number, number]).filter(([a, b]) => b > a);
}

/** The stretches of [from, to) outside someone's windows: shaded on their column. */
function outside(windows: readonly [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of [...windows].sort((x, y) => x[0] - y[0])) {
    if (a > at) out.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
  }
  if (at < to) out.push([at, to]);
  return out.filter(([a, b]) => b > a);
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
