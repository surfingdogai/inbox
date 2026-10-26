import { createContext, useContext } from "react";
import type { ItemDetail, ItemView } from "../../inbox/client/src/lib/types";
import type { InboxClient, PhoneMe } from "./lib/client";
import type { Native } from "./lib/native";
import type { QueuedAction } from "./lib/offline";
import type { InboxEntry, Sessions } from "./lib/session";
import type { UpdateState } from "./lib/update";

export type Route =
  | { readonly name: "inbox" }
  | { readonly name: "today" }
  | { readonly name: "settings" }
  | { readonly name: "inboxes" }
  | { readonly name: "connect" }
  | {
      readonly name: "item";
      readonly id: string;
      readonly action?: string | undefined;
      /** What the notification that opened it said: shown while the item cannot be read. */
      readonly hint?: { readonly title: string; readonly body: string } | undefined;
    };

/** What every screen reads and does (ADR-028): the active inbox, its items, and the way to act. */
export interface App {
  readonly native: Native;
  readonly sessions: Sessions;
  readonly inboxes: readonly InboxEntry[];
  readonly active: InboxEntry | null;
  readonly client: InboxClient | null;
  readonly me: PhoneMe | null;
  readonly views: readonly ItemView[];
  readonly loading: boolean;
  /** The active inbox cannot be reached. */
  readonly offline: boolean;
  /** When the shown list was read from the inbox, while offline; null when nothing of it is on the phone. */
  readonly cachedAt: number | null;
  /** A real list is shown: read from the inbox now, or from the phone's cache. Not yet: say so, never "All clear". */
  readonly listLoaded: boolean;
  readonly queued: readonly QueuedAction[];
  readonly route: Route;
  /** Each inbox's count of what needs the owner, for Your inboxes. */
  readonly needCounts: Readonly<Record<string, number>>;
  go(route: Route): void;
  back(): void;
  choose(entry: InboxEntry): void;
  refresh(): Promise<void>;
  /** What needs the owner in every inbox: from each one's cache at once, then from the inbox when online. */
  countAll(): Promise<void>;
  loadItem(id: string): Promise<ItemDetail | null>;
  /** Does it now if the inbox can be reached, else keeps it to send when it can. */
  act(itemId: string, kind: "transition" | "reply", body: Record<string, unknown>, label: string): Promise<void>;
  connected(entry: InboxEntry): Promise<void>;
  removeActive(): Promise<void>;
  toast(text: string): void;
  setMe(me: PhoneMe): void;
  /** This build's version and versionCode, once read. */
  readonly appInfo: { readonly version: string; readonly build: number } | null;
  /** Whether a newer version is ready on the download page. */
  readonly update: UpdateState;
  /** Android's back button closes this first while it returns true (an open sheet); returns its removal. */
  onBack(handler: () => boolean): () => void;
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("no app");
  return app;
}
