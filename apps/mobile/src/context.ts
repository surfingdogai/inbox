import { createContext, useContext } from "react";
import type { ItemDetail, ItemView } from "../../inbox/client/src/lib/types";
import type { Account } from "./lib/account";
import type { PublicFacts } from "./lib/chips";
import type { InboxClient, PhoneMe, PhoneSpam } from "./lib/client";
import type { Native } from "./lib/native";
import type { QueuedAction } from "./lib/offline";
import type { QuickReplies } from "./lib/replies";
import type { InboxEntry, Sessions } from "./lib/session";
import type { UpdateState } from "./lib/update";

export type Route =
  | { readonly name: "inbox" }
  | { readonly name: "today" }
  | { readonly name: "settings" }
  | { readonly name: "inboxes" }
  | { readonly name: "connect" }
  /** What the spam filter holds, or everything put aside (ADR-041 §12). */
  | { readonly name: "screened"; readonly which: "held" | "spam" }
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
  /** Signing in with an email code from Surfing Dog, for an inbox it hosts (ADR-028 Amendment 4). */
  readonly account: Account;
  readonly inboxes: readonly InboxEntry[];
  readonly active: InboxEntry | null;
  readonly client: InboxClient | null;
  /** A client for any inbox on the phone, not only the one in front (a new phone's confirm sheet). */
  clientFor(entry: InboxEntry): InboxClient;
  /** "Try the demo": the app on the demo shop, read-only, with nothing on the phone (lib/client.ts). */
  readonly demo: boolean;
  tryDemo(): void;
  leaveDemo(): void;
  readonly me: PhoneMe | null;
  /** The spam filter as this inbox has it: null until read, or from an inbox without one. */
  readonly spam: PhoneSpam | null;
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
  act(itemId: string, kind: QueuedAction["kind"], body: Record<string, unknown>, label: string): Promise<void>;
  /** The owner's quick replies for the inbox in front, kept on this phone; null in the demo. */
  readonly replies: QuickReplies | null;
  /**
   * The public prices and languages of the inbox in front, for the chips: read from its public door,
   * and kept on the phone so the chips are there offline too. Null when neither can be had.
   */
  facts(): Promise<PublicFacts | null>;
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
  setSpam(spam: PhoneSpam): void;
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("no app");
  return app;
}
