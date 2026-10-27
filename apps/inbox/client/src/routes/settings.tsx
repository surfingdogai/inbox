import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { ThemeButton, ThemeSwitch } from "../components/ThemeSwitch";
import { ensureSignedIn } from "../lib/auth";
import { foodKind } from "../lib/food";
import { useProperty } from "../lib/property";
import { useSettings } from "../lib/queries";
import { useWork } from "../lib/trades";

/** Settings: who the business is, how it is emailed, what is kept off the desk, what it offers, when it is open, how it is paid, what runs on its own, who it reports to. */
export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ location }) => {
    if (!(await ensureSignedIn())) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SettingsLayout,
});

function SettingsLayout() {
  const tabs = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // A place to stay has its own tab; another business never sees it.
  const property = useProperty();
  const stays = (property.data?.properties.length ?? 0) > 0 || path === "/settings/property";
  // A trade has Area and Work (ADR-039): it said where it works or how it takes work, or has a job tool,
  // or it takes requests for a price and no bookings (what a trade's setup starts with). A salon that
  // also quotes, or a shop, never sees them; a link straight to either still opens it.
  const settings = useSettings();
  const trades = useWork();
  const doors = settings.data?.doc.doors;
  const work =
    trades.data?.trade === true ||
    (doors !== undefined && doors.quoteRequest !== false && doors.booking === false) ||
    path === "/settings/area" ||
    path === "/settings/work";
  // A kitchen has Menu and Kitchen (ADR-040): it takes orders for a time, or its rules are a kitchen's.
  const food = foodKind(settings.data?.doc) || path === "/settings/menu" || path === "/settings/kitchen";
  // The tab you are on is always in view, on a phone too, where the row scrolls: again once the
  // Property tab, a trade's Area and Work or a kitchen's Menu and Kitchen appear, which move the tabs
  // after them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path and the tabs that appear are what move the current tab
  useEffect(() => {
    tabs.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [path, stays, work, food]);
  return (
    <main className="page page-narrow">
      <div className="page-head">
        <Link to="/" className="btn btn-ghost btn-sm">
          <ArrowLeft className="icon" aria-hidden="true" />
          Inbox
        </Link>
        <h1>Settings</h1>
        <ThemeSwitch className="theme-wide" />
        <ThemeButton className="theme-phone" />
      </div>
      <nav ref={tabs} className="tabs subnav" aria-label="Settings sections">
        <Link to="/settings" className="tab" activeOptions={{ exact: true }}>
          General
        </Link>
        <Link to="/settings/email" className="tab">
          Email
        </Link>
        <Link to="/settings/spam" className="tab">
          Spam
        </Link>
        <Link to="/settings/services" className="tab">
          Services
        </Link>
        {stays && (
          <Link to="/settings/property" className="tab">
            Property
          </Link>
        )}
        <Link to="/settings/availability" className="tab">
          Availability
        </Link>
        {food && (
          <>
            <Link to="/settings/menu" className="tab">
              Menu
            </Link>
            <Link to="/settings/kitchen" className="tab">
              Kitchen
            </Link>
          </>
        )}
        {work && (
          <>
            <Link to="/settings/area" className="tab">
              Area
            </Link>
            <Link to="/settings/work" className="tab">
              Work
            </Link>
          </>
        )}
        <Link to="/settings/payments" className="tab">
          Payments
        </Link>
        <Link to="/settings/rules" className="tab">
          Rules
        </Link>
        <Link to="/settings/integrations" className="tab">
          Integrations
        </Link>
        <Link to="/settings/keys" className="tab">
          Keys
        </Link>
        <Link to="/settings/phone" className="tab">
          Phone
        </Link>
        <Link to="/settings/networks" className="tab">
          Networks
        </Link>
        <Link to="/settings/found" className="tab">
          Be found
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}
