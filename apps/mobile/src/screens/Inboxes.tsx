import { useApp } from "../context";
import { badgeOf } from "../lib/view";
import { ChevronLeft, PlusIcon } from "./icons";
import { OfflineBanner } from "./Offline";

/** Your inboxes (the approved screen): for people who look after more than one business. */
export function Inboxes() {
  const app = useApp();
  return (
    <div className="screen">
      {app.offlineSince !== null && <OfflineBanner since={app.offlineSince} queued={app.queued.length} />}
      <header className="head" style={{ gap: 6 }}>
        <div className="head-row">
          <button type="button" className="back" onClick={() => app.go({ name: "inbox" })}>
            <ChevronLeft />
            Inbox
          </button>
        </div>
        <h1>Your inboxes</h1>
        <div className="sub">For people who look after more than one business</div>
      </header>
      <main className="body">
        {app.inboxes.map((e) => {
          const n = app.needCounts[e.alias];
          return (
            <button
              type="button"
              key={e.alias}
              className="card"
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
              aria-current={app.active?.alias === e.alias ? "true" : undefined}
              onClick={() => app.choose(e)}
            >
              <span className="badge lg">{badgeOf(e.name)}</span>
              <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <span className="who" style={{ fontSize: 15 }}>
                  {e.name}
                </span>
                <span className="sub">{new URL(e.origin).host}</span>
              </span>
              <span className="sub" style={{ whiteSpace: "nowrap" }}>
                {n === undefined ? "" : n === 0 ? "All clear" : `${n} need${n === 1 ? "s" : ""} you`}
              </span>
            </button>
          );
        })}
        <button type="button" className="btn" style={{ marginTop: 6 }} onClick={() => app.go({ name: "connect" })}>
          <PlusIcon />
          Add an inbox
        </button>
      </main>
    </div>
  );
}
