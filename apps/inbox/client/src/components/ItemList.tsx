import { Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck, Bot, Copy, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { problemOf } from "../lib/api";
import { type Filter, filterLabel, paramsFor, visibleIn, withQuery } from "../lib/filters";
import { partyName, relativeTime, snippetFor, TYPE_CLASS, TYPE_WORD } from "../lib/format";
import { useItemPages } from "../lib/queries";
import type { ItemView } from "../lib/types";
import { ErrorState, SkeletonRows, Sun } from "./Feedback";
import { StatePill } from "./Pills";

/** The item list: rows for the current filter, a search box, and "load more" over the API's cursor. */
export function ItemList({
  filter,
  q,
  sandbox,
  selected,
  tz,
}: {
  filter: Filter;
  q: string | undefined;
  sandbox: boolean;
  selected: string | undefined;
  tz: string | undefined;
}) {
  const pages = useItemPages(paramsFor(filter, q, sandbox));
  const navigate = useNavigate();
  const [draft, setDraft] = useState(q ?? "");

  // The box follows the URL (back button, rail links) …
  useEffect(() => {
    setDraft(q ?? "");
  }, [q]);
  // … and the URL follows the box, a beat after the last key.
  useEffect(() => {
    const next = draft.trim();
    if (next === (q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({ to: ".", search: (prev) => withQuery(prev, next || undefined) });
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, q, navigate]);

  const views = (pages.data?.pages ?? []).flatMap((p) => p.items).filter((v) => visibleIn(filter, v));
  const label = filterLabel(filter);

  return (
    <section className="list" aria-label={label}>
      <div className="top">
        <h2>{label}</h2>
        {pages.isFetching && !pages.isPending && <output className="spinner" aria-label="Refreshing" />}
      </div>
      {sandbox && (
        <p className="test-banner" role="status">
          Test mode is on: customers get no emails and nothing reaches a network.
        </p>
      )}
      <div className="search">
        <Search className="icon" aria-hidden="true" />
        <input
          className="input"
          type="search"
          placeholder="Search the conversations"
          aria-label="Search the conversations"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <div className="rows">
        {pages.isPending && <SkeletonRows n={4} />}
        {pages.isError && (
          <ErrorState
            title="Could not load the inbox"
            text={problemOf(pages.error).detail}
            onRetry={() => void pages.refetch()}
          />
        )}
        {pages.isSuccess && views.length === 0 && <Empty filter={filter} q={q} label={label} />}
        {views.map((v) => (
          <Row key={v.item.id} view={v} selected={v.item.id === selected} tz={tz} />
        ))}
        {pages.hasNextPage && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void pages.fetchNextPage()}
            disabled={pages.isFetchingNextPage}
          >
            {pages.isFetchingNextPage && <span className="spinner" aria-hidden="true" />}
            Load more
          </button>
        )}
      </div>
    </section>
  );
}

/** Who · what on up to two lines, then the snippet; time on the right, the state at the end. */
function Row({ view, selected, tz }: { view: ItemView; selected: boolean; tz: string | undefined }) {
  const { item, party } = view;
  return (
    <Link
      to="/items/$id"
      params={{ id: item.id }}
      search={(prev) => prev}
      className="row"
      data-selected={selected ? "true" : undefined}
    >
      <i className={`dot dot-${TYPE_CLASS[item.type]}`} />
      <div className="row-text">
        <div className="row-line">
          <span className="who">
            {partyName(party)}
            {party?.kind === "agent" && <Bot className="icon-xs glyph" role="img" aria-label="Agent" />}
            {party?.verified && <BadgeCheck className="icon-xs glyph verified" role="img" aria-label="Verified" />}
            {" · "}
            {item.subject?.trim() || TYPE_WORD[item.type]}
          </span>
          <span className="s"> {snippetFor(item, tz)}</span>
        </div>
      </div>
      <div className="m">
        <span className="row-when">
          {item.flags.needsHuman && (
            <i className="dot dot-warning" title="Needs you">
              <span className="sr-only">Needs you</span>
            </i>
          )}
          <time dateTime={item.updatedAt} title={item.updatedAt}>
            {relativeTime(item.updatedAt)}
          </time>
        </span>
        <div className="row-pills">
          {item.flags.sandbox && <span className="pill pill-xs">Sandbox</span>}
          <StatePill state={item.state} small />
        </div>
      </div>
    </Link>
  );
}

function Empty({ filter, q, label }: { filter: Filter; q: string | undefined; label: string }) {
  const [copied, setCopied] = useState(false);
  if (q) {
    return (
      <div className="state">
        <h3>No matches for “{q}”</h3>
        <p>Search looks through the conversation text. Try another word, or clear the search.</p>
      </div>
    );
  }
  if (filter === "all") {
    const address = `${window.location.origin}/.well-known/agent-inbox.json`;
    const copy = () => {
      void navigator.clipboard.writeText(address).then(() => setCopied(true));
    };
    return (
      <div className="state">
        <Sun />
        <h3>No requests yet</h3>
        <p>Share your inbox address, or point an agent at it to see what arrives.</p>
        <div className="rowx center">
          <button type="button" className="btn btn-primary btn-sm" onClick={copy}>
            <Copy className="icon" aria-hidden="true" />
            {copied ? "Address copied" : "Copy address"}
          </button>
          <a className="btn btn-secondary btn-sm" href="/openapi.json" target="_blank" rel="noreferrer">
            API document
          </a>
        </div>
      </div>
    );
  }
  if (filter === "needs") {
    return (
      <div className="state">
        <h3>Nothing needs you</h3>
        <p>Items flagged for a human decision appear here. Everything open is under All.</p>
      </div>
    );
  }
  if (filter === "done") {
    return (
      <div className="state">
        <h3>Nothing done yet</h3>
        <p>Items land here once they are completed, declined, cancelled or closed.</p>
      </div>
    );
  }
  return (
    <div className="state">
      <h3>No open {label.toLowerCase()}</h3>
      <p>New ones appear here as they arrive. Everything open is under All.</p>
    </div>
  );
}
