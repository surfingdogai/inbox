import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { StatePill } from "../components/Pills";
import { api, problemOf } from "../lib/api";
import {
  formatClock,
  formatDay,
  localDateKey,
  partyName,
  relativeTime,
  TYPE_CLASS,
  TYPE_PLURAL,
  TYPE_WORD,
} from "../lib/format";
import { useBusiness, useCounts, useSettings } from "../lib/queries";
import type { ItemType, ItemView } from "../lib/types";

export const Route = createFileRoute("/_inbox/")({
  component: TodayPane,
});

const TYPES: readonly ItemType[] = ["booking", "order", "quote_request", "message", "refund"];

/**
 * The first screen: what is on today, what waits for a person, and the last things that happened.
 * Everything comes from the list endpoint with filters; each line opens its item.
 */
function TodayPane() {
  const settings = useSettings();
  const business = useBusiness();
  const sandbox = settings.data?.doc.testMode ?? false;
  const tz = business.data?.timezone ?? settings.data?.doc.business.timezone;
  const counts = useCounts(sandbox);
  const bookings = useQuery({
    queryKey: ["today", "bookings", sandbox],
    queryFn: () => api.listItems({ type: "booking", open_only: true, sandbox, limit: 100 }),
    staleTime: 30_000,
  });
  const latest = useQuery({
    queryKey: ["today", "latest", sandbox],
    queryFn: () => api.listItems({ open_only: false, sandbox, limit: 3 }),
    staleTime: 15_000,
  });
  const now = Date.now();
  const todayKey = localDateKey(now, tz);
  const todays = (bookings.data?.items ?? [])
    .flatMap((v) =>
      v.item.type === "booking"
        ? [{ view: v, start: v.item.payload.startTime, name: v.item.payload.reservationFor.name }]
        : [],
    )
    .filter((b) => localDateKey(b.start, tz) === todayKey)
    .sort((a, b) => a.start.localeCompare(b.start));
  const waiting = TYPES.map((type) => ({ type, n: counts.data?.needsByType[type] ?? 0 })).filter((w) => w.n > 0);

  return (
    <div className="today">
      <div className="today-head">
        <div className="eyebrow">Today</div>
        <h2 className="today-date">{formatDay(new Date(now).toISOString(), tz)}</h2>
      </div>

      <section className="card glass stack">
        <h3 className="sec">Bookings today</h3>
        {bookings.isPending && <div className="skeleton sk-line" />}
        {bookings.isError && <p className="hint error">{problemOf(bookings.error).detail}</p>}
        {bookings.isSuccess && todays.length === 0 && <p className="hint">No bookings today.</p>}
        {todays.length > 0 && (
          <ul className="today-list">
            {todays.map((b) => (
              <li key={b.view.item.id}>
                <Line view={b.view} when={formatClock(b.start, tz)}>
                  <b>{partyName(b.view.party)}</b> <span>{b.name}</span>
                </Line>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card glass stack">
        <h3 className="sec">Waiting for you</h3>
        {counts.isPending && <div className="skeleton sk-line" />}
        {counts.isError && <p className="hint error">{problemOf(counts.error).detail}</p>}
        {counts.isSuccess && waiting.length === 0 && <p className="hint">Nothing needs a person right now.</p>}
        {waiting.length > 0 && (
          <ul className="today-list">
            {waiting.map((w) => (
              <li key={w.type}>
                <Link to="/" search={{ f: w.type }} className="today-line">
                  <span className="when">
                    <i className={`dot dot-${TYPE_CLASS[w.type]}`} />
                  </span>
                  <span className="what">
                    <b>
                      {w.n} {(w.n === 1 ? TYPE_WORD[w.type] : TYPE_PLURAL[w.type]).toLowerCase()}
                    </b>{" "}
                    <span>{w.n === 1 ? "needs" : "need"} you</span>
                  </span>
                  <span />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card glass stack">
        <h3 className="sec">Latest</h3>
        {latest.isPending && <div className="skeleton sk-line" />}
        {latest.isError && <p className="hint error">{problemOf(latest.error).detail}</p>}
        {latest.isSuccess && latest.data.items.length === 0 && (
          <p className="hint">Nothing has happened yet. Share your inbox address to get started.</p>
        )}
        {latest.data && latest.data.items.length > 0 && (
          <ul className="today-list">
            {latest.data.items.map((v) => (
              <li key={v.item.id}>
                <Line view={v} when={relativeTime(v.item.updatedAt, now)}>
                  <b>{partyName(v.party)}</b> <span>{v.item.subject?.trim() || TYPE_WORD[v.item.type]}</span>
                </Line>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Line({ view, when, children }: { view: ItemView; when: string; children: React.ReactNode }) {
  return (
    <Link to="/items/$id" params={{ id: view.item.id }} search={(prev) => prev} className="today-line">
      <span className="when">{when}</span>
      <span className="what">{children}</span>
      <StatePill state={view.item.state} small />
    </Link>
  );
}
