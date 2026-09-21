import type {
  BusinessProfile,
  Item,
  ItemDetail,
  ItemType,
  ItemView,
  Money,
  Page,
  Settings,
  TransitionResult,
} from "@surfingdog/core";

/**
 * The shapes the owner app consumes. Type-only imports from core: nothing of the server is bundled,
 * and the app cannot drift from what the API returns.
 */
export type { BusinessProfile, Item, ItemDetail, ItemType, ItemView, Money, Page, Settings, TransitionResult };

export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;
export type ThreadEntry = ItemDetail["thread"][number];
export type ItemEvent = ItemDetail["events"][number];
export type Transition = ItemView["transitions"][number];

export interface SettingsDoc {
  readonly doc: Settings;
  readonly version: number;
}

/** RFC 9457 problem document, as every refusal comes back. */
export interface ProblemField {
  readonly path: string;
  readonly problem: string;
  readonly message: string;
}
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly fields?: readonly ProblemField[] | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface ListParams {
  readonly type?: ItemType | undefined;
  readonly state?: string | undefined;
  readonly needs_human?: boolean | undefined;
  readonly open_only?: boolean | undefined;
  readonly sandbox?: boolean | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TransitionBody {
  readonly event: string;
  readonly input?: Record<string, unknown> | undefined;
  readonly reason?: string | undefined;
  readonly expected_version?: number | undefined;
}

export interface ReplyBody {
  readonly body: string;
  readonly internal: boolean;
}

export interface SettingsBody {
  readonly doc: Record<string, unknown>;
  readonly expected_version?: number | undefined;
}
