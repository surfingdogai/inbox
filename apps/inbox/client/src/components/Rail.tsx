import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import clsx from "clsx";
import { Inbox, LogOut, Settings } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { signOut } from "../lib/auth";
import { type Counts, countFor, FILTERS, type Filter } from "../lib/filters";
import { TYPE_CLASS } from "../lib/format";
import { ThemeSwitch } from "./ThemeSwitch";

/** The filters rail: what needs you, everything, each type with its count, and what is done. */
export function Rail({
  name,
  filter,
  q,
  counts,
  testMode,
}: {
  name: string;
  filter: Filter;
  q: string | undefined;
  counts: Counts | undefined;
  testMode: boolean;
}) {
  const navigate = useNavigate();
  const leave = async () => {
    await signOut();
    void navigate({ to: "/login" });
  };
  return (
    <nav className="rail" aria-label="Inbox">
      <div className="h">
        <Inbox className="icon" aria-hidden="true" />
        {name}
      </div>
      {FILTERS.map((f) => {
        if (f.key === "refund" && !(counts && counts.byType.refund > 0)) return null;
        return (
          <FilterLink
            key={f.key}
            search={{ ...(f.key === "all" ? {} : { f: f.key }), ...(q ? { q } : {}) }}
            current={filter === f.key}
          >
            <span>
              {f.type && <i className={`dot dot-${TYPE_CLASS[f.type]}`} />}
              {f.label}
            </span>
            <span className="n">{countFor(counts, f.key)}</span>
          </FilterLink>
        );
      })}
      <div className="foot">
        <span className="pill" title={testMode ? "New items are sandbox items" : undefined}>
          <i className={clsx("dot", testMode && "dot-warning")} />
          {testMode ? "Test mode on" : "Test mode off"}
        </span>
        <Link to="/settings" className="rail-link">
          <span>
            <Settings className="icon" aria-hidden="true" />
            Settings
          </span>
        </Link>
        <ThemeSwitch compact />
        <button type="button" className="rail-link" onClick={() => void leave()}>
          <span>
            <LogOut className="icon" aria-hidden="true" />
            Sign out
          </span>
        </button>
      </div>
    </nav>
  );
}

/**
 * A filter is a search-param variant of the same route, so the router's own notion of an "active"
 * link (which stamps aria-current on every one of them) does not apply: a plain anchor with the
 * built href, marked current by the filter in the URL.
 */
function FilterLink({
  search,
  current,
  children,
}: {
  search: { f?: Filter; q?: string };
  current: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const href = router.buildLocation({ to: "/", search }).href;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigate({ to: "/", search });
  };
  return (
    <a
      href={href}
      onClick={onClick}
      className="rail-link"
      data-current={current ? "true" : undefined}
      aria-current={current ? "true" : undefined}
    >
      {children}
    </a>
  );
}
