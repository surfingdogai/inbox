import { useMemo, useState } from "react";
import { stateWord } from "../../../inbox/client/src/lib/format";
import type { ItemView } from "../../../inbox/client/src/lib/types";
import { useApp } from "../context";
import {
  ago,
  badgeOf,
  calendarWords,
  cardAmount,
  cardLine,
  cardTitle,
  channelPhrase,
  KIND_WORD,
  needsYou,
  spamFoot,
} from "../lib/view";
import { CheckIcon, ChevronDown, SearchIcon } from "./icons";
import { Nav } from "./Nav";
import { CannotReach } from "./Offline";
import { UpdateLine } from "./Update";

/** The inbox (the approved Main screen): what needs the owner, everything open, and what was handled. */
export function Inbox() {
  const app = useApp();
  const [tab, setTab] = useState<"needs" | "all">("needs");
  const [query, setQuery] = useState<string | null>(null);
  const tz = app.me?.business.timezone;
  const name = app.me?.business.name || app.active?.name || "";

  const { needs, open, handled } = useMemo(() => {
    const q = query?.trim().toLowerCase() ?? "";
    const match = (v: ItemView) =>
      !q || `${cardTitle(v, tz)} ${cardLine(v, tz)} ${v.party?.email ?? ""}`.toLowerCase().includes(q);
    const all = app.views.filter(match);
    return {
      needs: all.filter(needsYou),
      open: all.filter((v) => v.item.closedAt === null),
      handled: all.filter((v) => !needsYou(v)).slice(0, 5),
    };
  }, [app.views, query, tz]);

  const shown = tab === "needs" ? needs : open;
  // What the spam filter holds and put aside, a quiet line under the list (ADR-029 §12).
  const foot = spamFoot(app.spam);
  return (
    <div className="screen">
      <header className="head">
        <div className="head-row">
          <button type="button" className="switcher" onClick={() => app.go({ name: "inboxes" })}>
            <span className="badge">{badgeOf(name)}</span>
            <span>{name}</span>
            <ChevronDown />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Search"
            onClick={() => setQuery((q) => (q === null ? "" : null))}
          >
            <SearchIcon />
          </button>
        </div>
        <h1>Inbox</h1>
        {query !== null && (
          <label className="field">
            <span className="sr-only">Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="A name, a service…" />
          </label>
        )}
        <div className="segment" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={tab === "needs"} onClick={() => setTab("needs")}>
            Needs you {needs.length > 0 && <span className="count">{needs.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>
            All
          </button>
        </div>
      </header>
      <main className="body">
        <UpdateLine />
        {shown.length === 0 && !app.loading && !app.listLoaded && app.offline && <CannotReach inbox={name} />}
        {shown.length === 0 && !app.loading && app.listLoaded && (
          <div className="empty">
            <b>{tab === "needs" ? "All clear" : "Nothing open"}</b>
            {tab === "needs" ? "Nothing waits for you right now." : "New requests appear here."}
          </div>
        )}
        {shown.map((v) => (
          <Card key={v.item.id} view={v} tz={tz} onOpen={() => app.go({ name: "item", id: v.item.id })} />
        ))}
        {tab === "needs" && handled.length > 0 && (
          <>
            <div className="section-label">Handled</div>
            {handled.map((v) => (
              <button
                type="button"
                key={v.item.id}
                className="card soft"
                onClick={() => app.go({ name: "item", id: v.item.id })}
              >
                <div className="meta">
                  <span>
                    <span className={`chip ${v.item.type}`}>{KIND_WORD[v.item.type]}</span>
                    {stateWord(v.item.state).toLowerCase()}
                    {v.by_rules ? " by your rules" : ""}
                  </span>
                  <span>{ago(v.item.updatedAt)}</span>
                </div>
                <div className="what">
                  {cardTitle(v, tz)} · {cardLine(v, tz)}
                </div>
              </button>
            ))}
          </>
        )}
        {foot && (
          <div className="spam-foot">
            {foot.held && (
              <>
                <button type="button" onClick={() => app.go({ name: "screened", which: "held" })}>
                  {foot.held}
                </button>
                <span aria-hidden="true">·</span>
              </>
            )}
            <button type="button" onClick={() => app.go({ name: "screened", which: "spam" })}>
              {foot.spam}
            </button>
          </div>
        )}
      </main>
      <Nav current="inbox" />
    </div>
  );
}

function Card({ view, tz, onOpen }: { view: ItemView; tz: string | undefined; onOpen: () => void }) {
  const { queued } = useApp();
  const waiting = queued.some((a) => a.itemId === view.item.id);
  const amount = cardAmount(view.item);
  const calendar = calendarWords(view, tz);
  return (
    <button type="button" className="card" onClick={onOpen}>
      <div className="meta">
        <span>
          <span className={`chip ${view.item.type}`}>{KIND_WORD[view.item.type]}</span>
          {channelPhrase(view.item)}
        </span>
        <span>{ago(view.item.createdAt)}</span>
      </div>
      <div className="who">{cardTitle(view, tz)}</div>
      <div className="what">{cardLine(view, tz)}</div>
      {(amount || waiting || calendar) && (
        <div className="foot">
          {waiting ? (
            <span>Waiting to send</span>
          ) : calendar?.free ? (
            <span className="free">
              <CheckIcon />
              {calendar.line}
            </span>
          ) : (
            <span>{calendar?.line ?? ""}</span>
          )}
          {amount && <b>{amount}</b>}
        </div>
      )}
    </button>
  );
}
