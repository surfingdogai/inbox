import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { ensureSignedIn } from "../lib/auth";

/** Settings: who the business is, what it offers, when it is open, what runs on its own, who it reports to. */
export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ location }) => {
    if (!(await ensureSignedIn())) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <main className="page page-narrow">
      <div className="page-head">
        <Link to="/" className="btn btn-ghost btn-sm">
          <ArrowLeft className="icon" aria-hidden="true" />
          Inbox
        </Link>
        <h1>Settings</h1>
        <ThemeSwitch />
      </div>
      <nav className="tabs subnav" aria-label="Settings sections">
        <Link to="/settings" className="tab" activeOptions={{ exact: true }}>
          General
        </Link>
        <Link to="/settings/services" className="tab">
          Services
        </Link>
        <Link to="/settings/availability" className="tab">
          Availability
        </Link>
        <Link to="/settings/rules" className="tab">
          Rules
        </Link>
        <Link to="/settings/integrations" className="tab">
          Integrations
        </Link>
        <Link to="/settings/networks" className="tab">
          Networks
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}
