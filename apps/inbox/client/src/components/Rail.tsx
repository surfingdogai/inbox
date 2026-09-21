import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import clsx from "clsx";
import { CheckCheck, CircleAlert, Inbox, LogOut, type LucideIcon, Settings } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { signOut } from "../lib/auth";
import { type Counts, countFor, FILTERS, type Filter } from "../lib/filters";
import { TYPE_CLASS } from "../lib/format";
import { ThemeSwitch } from "./ThemeSwitch";

/** The filters without a type carry an icon, so the rail still reads when it collapses to icons. */
const ICONS: Partial<Record<Filter, LucideIcon>> = { needs: CircleAlert, all: Inbox, done: CheckCheck };

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
      <div className="h" title={name}>
        <Inbox className="icon" aria-hidden="true" />
        <span className="label">{name}</span>
      </div>
      {FILTERS.map((f) => {
        if (f.key === "refund" && !(counts && counts.byType.refund > 0)) return null;
        const Icon = ICONS[f.key];
        const n = countFor(counts, f.key);
        return (
          <FilterLink
            key={f.key}
            search={{ ...(f.key === "all" ? {} : { f: f.key }), ...(q ? { q } : {}) }}
            current={filter === f.key}
            label={n ? `${f.label} (${n})` : f.label}
          >
            <span>
              {f.type ? (
                <i className={`dot dot-${TYPE_CLASS[f.type]}`} />
              ) : (
                Icon && <Icon className="icon" aria-hidden="true" />
              )}
              <span className="label">{f.label}</span>
            </span>
            <span className="n">{n}</span>
          </FilterLink>
        );
      })}
      <div className="foot">
        <span className="pill" title={testMode ? "New items are sandbox items" : undefined}>
          <i className={clsx("dot", testMode && "dot-warning")} />
          {testMode ? "Test mode on" : "Test mode off"}
        </span>
        <Link to="/settings" className="rail-link" aria-label="Settings" title="Settings">
          <span>
            <Settings className="icon" aria-hidden="true" />
            <span className="label">Settings</span>
          </span>
        </Link>
        <ThemeSwitch compact />
        <button type="button" className="rail-link" onClick={() => void leave()} aria-label="Sign out" title="Sign out">
          <span>
            <LogOut className="icon" aria-hidden="true" />
            <span className="label">Sign out</span>
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
  label,
  children,
}: {
  search: { f?: Filter; q?: string };
  current: boolean;
  label: string;
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
      title={label}
      aria-label={label}
      data-current={current ? "true" : undefined}
      aria-current={current ? "true" : undefined}
    >
      {children}
    </a>
  );
}
