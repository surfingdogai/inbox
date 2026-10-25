import { Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck, Bot, Copy, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { problemOf } from "../lib/api";
import { type Filter, filterLabel, paramsFor, visibleIn, withQuery } from "../lib/filters";
import { partyName, relativeTime, slotShort, snippetFor, TYPE_CLASS, titleFor } from "../lib/format";
import { ownerLocale } from "../lib/geo";
import { useEmailChannel, useItemPages, useSettings, useSpam } from "../lib/queries";
import {
  ACT_LABEL,
  deskChip,
  HELD_EMPTY,
  HELD_TOP,
  heldOrder,
  heldWhat,
  heldWho,
  keepLine,
  MAY_BE_CUSTOMER,
  rowTag,
  SPAM_EMPTY,
  SPAM_TOP,
} from "../lib/spam";
import type { ItemView } from "../lib/types";
import { ErrorState, SkeletonRows, Sun } from "./Feedback";
import { StatePill } from "./Pills";
import { useSpamActions } from "./SpamActions";

/** The item list: rows for the current filter, a search box, and "load more" over the API's cursor. */
export function ItemList({
  filter,
  q,
  sandbox,
  selected,
  tz,
  head,
}: {
  filter: Filter;
  q: string | undefined;
  sandbox: boolean;
  selected: string | undefined;
  tz: string | undefined;
  /** Above the search: a kitchen's pause on a phone (ADR-040). */
  head?: ReactNode;
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

  const { hidden } = useSpamActions();
  const listed = (pages.data?.pages ?? [])
    .flatMap((p) => p.items)
    .filter((v) => visibleIn(filter, v) && !hidden.has(v.item.id));
  // Under Held, what may be a customer after all comes first (ADR-029 §11.1).
  const views = filter === "held" ? heldOrder(listed) : listed;
  const label = filterLabel(filter);
  const screened = filter === "held" || filter === "spam";

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
      <ForwardConfirm />
      {head}
      {screened && <ScreenTop filter={filter} />}
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
        {views.map((v) =>
          screened ? (
            <ScreenRow key={v.item.id} view={v} filter={filter} selected={v.item.id === selected} tz={tz} />
          ) : (
            <Row key={v.item.id} view={v} selected={v.item.id === selected} tz={tz} />
          ),
        )}
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
  const locale = ownerLocale(tz);
  // Delivered with a label by the spam filter (ADR-029 §11.1): a small chip before the subject.
  const warned = deskChip(view);
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
            {/* An order for a time says when, with its day unless it is today (ADR-040). */}
            {item.type === "order" && item.payload.fulfil?.slot && (
              <span className="row-slot">{slotShort(item.payload.fulfil.slot.start, tz)} · </span>
            )}
            {warned && <span className="spam-chip">{warned}</span>}
            {titleFor(item, locale)}
          </span>
          <span className="s"> {snippetFor(item, tz, locale)}</span>
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
  if (filter === "spam") return <SpamEmpty />;
  if (filter === "held") {
    return (
      <div className="state">
        <h3>{HELD_EMPTY}</h3>
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

/**
 * A mail provider's forwarding confirmation waiting for the owner (ADR-026 §2): one line, linking to
 * Settings → Email, where its code and link are. Nothing is opened or typed for them.
 */
function ForwardConfirm() {
  const email = useEmailChannel();
  const waiting = email.data?.forwards.find((f) => f.confirmation);
  if (!waiting) return null;
  return (
    <p className="test-banner" role="status">
      {waiting.confirmation?.provider || waiting.provider_name} asks you to confirm forwarding from {waiting.address}.{" "}
      <Link to="/settings/email">Open it</Link>
    </p>
  );
}

/** The line above Held and Spam: what they are, and for Spam how many this week (ADR-029 §11.1). */
function ScreenTop({ filter }: { filter: Filter }) {
  const spam = useSpam();
  if (filter === "held") return <p className="screen-top">{HELD_TOP}</p>;
  const week = spam.data?.this_week.aside;
  return (
    <p className="screen-top">
      {SPAM_TOP}
      {week !== undefined && <small className="screen-week">This week: {week}</small>}
    </p>
  );
}

function SpamEmpty() {
  const settings = useSettings();
  const keep = settings.data?.doc.spam?.keepDays ?? 0;
  return (
    <div className="state">
      <h3>{SPAM_EMPTY}</h3>
      <p className="fine">{keepLine(keep)}</p>
    </div>
  );
}

/**
 * A row under Held or Spam: who, what and one chip, with the act a person most likely means on the
 * row itself — Let it in · Spam under Held, Not spam under Spam.
 */
function ScreenRow({
  view,
  filter,
  selected,
  tz,
}: {
  view: ItemView;
  filter: Filter;
  selected: boolean;
  tz: string | undefined;
}) {
  const { act } = useSpamActions();
  const { item } = view;
  const tag = rowTag(view.spam);
  const acts = filter === "held" ? (["let_in", "spam"] as const) : (["not_spam"] as const);
  const customer = tag === MAY_BE_CUSTOMER;
  return (
    <div className="row screen-row" data-selected={selected ? "true" : undefined}>
      <i className={`dot dot-${TYPE_CLASS[item.type]}`} />
      <Link to="/items/$id" params={{ id: item.id }} search={(prev) => prev} className="row-text screen-open">
        <div className="row-line">
          {filter === "held" ? (
            <>
              <span className="who">{heldWho(view)}</span>
              <span className="screen-what"> · {heldWhat(view, tz)}</span>
            </>
          ) : (
            <>
              <span className="who">{partyName(view.party)}</span>
              <span className="screen-what"> · {snippetFor(item, tz)}</span>
            </>
          )}
        </div>
        {tag && <span className={customer ? "spam-chip is-customer" : "spam-chip"}>{tag}</span>}
      </Link>
      <time className="row-time" dateTime={item.createdAt} title={item.createdAt}>
        {relativeTime(item.createdAt)}
      </time>
      <div className="screen-acts">
        {acts.map((a) => (
          <button key={a} type="button" className="btn btn-ghost btn-xs" onClick={() => act(view, a)}>
            {ACT_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  );
}
