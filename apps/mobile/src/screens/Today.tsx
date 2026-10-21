import { useMemo, useState } from "react";
import { formatDay } from "../../../inbox/client/src/lib/format";
import { useApp } from "../context";
import { cardTitle, today } from "../lib/view";
import { Nav } from "./Nav";
import { CannotReach } from "./Offline";

/** Today (the approved screen): the day's bookings in order, what asks for a time today, orders to prepare. */
export function Today() {
  const app = useApp();
  const tz = app.me?.business.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now] = useState(() => Date.now());
  const day = useMemo(() => today(app.views, now, tz), [app.views, now, tz]);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: tz,
  }).format(new Date(now));
  return (
    <div className="screen">
      <header className="head" style={{ gap: 4 }}>
        <div className="sub">{date}</div>
        <h1>Today</h1>
        <div className="pills">
          <span>
            {day.bookings} booking{day.bookings === 1 ? "" : "s"}
          </span>
          {day.toConfirm > 0 && <span className="violet">{day.toConfirm} to confirm</span>}
          {day.orders.length > 0 && (
            <span className="lagoon">
              {day.orders.length} order{day.orders.length === 1 ? "" : "s"} to prepare
            </span>
          )}
        </div>
      </header>
      <main className="body" style={{ padding: "8px 20px 20px" }}>
        {day.rows.length === 0 && !app.listLoaded && app.offline && (
          <CannotReach inbox={app.me?.business.name || app.active?.name || ""} />
        )}
        {day.rows.length === 0 && app.listLoaded && (
          <div className="empty">
            <b>Nothing booked today</b>
            New bookings for today appear here.
          </div>
        )}
        <div className="timeline">
          {day.rows.map((r) => (
            <Row key={`${r.at}${r.title}`} row={r} onOpen={(id) => app.go({ name: "item", id })} />
          ))}
        </div>
        {day.orders.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 10 }}>
              Orders to prepare
            </div>
            <div className="rows">
              {day.orders.map((v) => (
                <button
                  type="button"
                  key={v.item.id}
                  style={{ border: 0, background: "none", padding: 0, width: "100%", fontSize: 14 }}
                  onClick={() => app.go({ name: "item", id: v.item.id })}
                >
                  <span>{cardTitle(v)}</span>
                  <span className="sub">
                    {v.item.type === "order" && v.item.payload.delivery?.when
                      ? formatDay(v.item.payload.delivery.when, tz)
                      : v.item.state === "paid"
                        ? "paid"
                        : ""}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </main>
      <Nav current="today" />
    </div>
  );
}

function Row({ row, onOpen }: { row: ReturnType<typeof today>["rows"][number]; onOpen: (id: string) => void }) {
  return (
    <>
      <div className="at">{row.at}</div>
      {row.kind === "free" ? (
        <div className="slot free">{row.title}</div>
      ) : row.kind === "ask" ? (
        <div className="slot ask">
          <div>
            <b>{row.title}</b>
            <span>{row.line}</span>
          </div>
          {row.itemId && (
            <button type="button" className="btn primary sm" onClick={() => row.itemId && onOpen(row.itemId)}>
              Review
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="slot"
          style={{ textAlign: "left", font: "inherit", color: "inherit" }}
          onClick={() => row.itemId && onOpen(row.itemId)}
        >
          <b>{row.title}</b>
          <span>{row.line}</span>
        </button>
      )}
    </>
  );
}
