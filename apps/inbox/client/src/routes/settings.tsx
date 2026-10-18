import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { ThemeButton, ThemeSwitch } from "../components/ThemeSwitch";
import { ensureSignedIn } from "../lib/auth";

/** Settings: who the business is, what it offers, when it is open, how it is paid, what runs on its own, who it reports to. */
export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ location }) => {
    if (!(await ensureSignedIn())) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SettingsLayout,
});

function SettingsLayout() {
  const tabs = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The tab you are on is always in view, on a phone too, where the row scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is what moves the current tab
  useEffect(() => {
    tabs.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [path]);
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
        <Link to="/settings/services" className="tab">
          Services
        </Link>
        <Link to="/settings/availability" className="tab">
          Availability
        </Link>
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
