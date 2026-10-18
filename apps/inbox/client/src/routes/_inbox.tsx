import { createFileRoute, Outlet, redirect, useParams } from "@tanstack/react-router";
import { ItemList } from "../components/ItemList";
import { Rail } from "../components/Rail";
import { ensureSignedIn } from "../lib/auth";
import { type Filter, parseFilter } from "../lib/filters";
import { useBusiness, useCounts, useIntegrations, useSettings } from "../lib/queries";

export interface InboxSearch {
  readonly f?: Filter;
  readonly q?: string;
}

/** The three panes. Children render into the detail pane; phones show either the list or the detail. */
export const Route = createFileRoute("/_inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => {
    const f = parseFilter(search.f);
    const q = typeof search.q === "string" ? search.q.trim() : "";
    return { ...(f && f !== "all" ? { f } : {}), ...(q ? { q } : {}) };
  },
  beforeLoad: async ({ location }) => {
    if (!(await ensureSignedIn())) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: InboxLayout,
});

function InboxLayout() {
  const { f, q } = Route.useSearch();
  const filter: Filter = f ?? "all";
  const { id } = useParams({ strict: false });
  const settings = useSettings();
  const business = useBusiness();
  const testMode = settings.data?.doc.testMode ?? false;
  const counts = useCounts(testMode);
  // A calendar that stopped syncing is said where the owner looks every day, not only in Settings.
  const broken = useIntegrations().data?.connections.find((c) => c.status === "error");
  const failing = broken ? { title: broken.title, error: broken.last_error } : undefined;
  const name = business.data?.name || settings.data?.doc.business.name || "Inbox";
  const tz = business.data?.timezone ?? settings.data?.doc.business.timezone;

  return (
    <div className="inbox glass" data-view={id ? "detail" : "list"}>
      <Rail name={name} filter={filter} q={q} counts={counts.data} testMode={testMode} failing={failing} />
      <ItemList filter={filter} q={q} sandbox={testMode} selected={id} tz={tz} />
      <section className="detail" aria-label="Item">
        <Outlet />
      </section>
    </div>
  );
}
