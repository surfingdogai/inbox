import type { ReactElement } from "react";
import { useApp } from "../context";
import { InboxIcon, SettingsIcon, TodayIcon } from "./icons";

/** The three tabs the approved design gives the phone: Inbox, Today, Settings. */
export function Nav({ current }: { current: "inbox" | "today" | "settings" }) {
  const app = useApp();
  const tab = (name: "inbox" | "today" | "settings", label: string, Icon: () => ReactElement) => (
    <button type="button" aria-current={current === name ? "page" : undefined} onClick={() => app.go({ name })}>
      <Icon />
      {label}
    </button>
  );
  return (
    <nav className="nav" aria-label="Main">
      {tab("inbox", "Inbox", InboxIcon)}
      {tab("today", "Today", TodayIcon)}
      {tab("settings", "Settings", SettingsIcon)}
    </nav>
  );
}
