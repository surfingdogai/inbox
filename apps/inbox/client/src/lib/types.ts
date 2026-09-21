import type {
  Action,
  Availability,
  BusinessProfile,
  Closure,
  Condition,
  Item,
  ItemDetail,
  ItemType,
  ItemView,
  Money,
  Page,
  Profile,
  RuleDefinition,
  RuleView,
  Settings,
  TransitionResult,
  Weekly,
} from "@surfingdog/core";

/**
 * The shapes the owner app consumes. Type-only imports from core: nothing of the server is bundled,
 * and the app cannot drift from what the API returns.
 */
export type {
  Action,
  Availability,
  BusinessProfile,
  Closure,
  Condition,
  Item,
  ItemDetail,
  ItemType,
  ItemView,
  Money,
  Page,
  Profile,
  RuleDefinition,
  RuleView,
  Settings,
  TransitionResult,
  Weekly,
};

export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;
export type ThreadEntry = ItemDetail["thread"][number];
export type ItemEvent = ItemDetail["events"][number];
export type Transition = ItemView["transitions"][number];
/** Who is asking, as the owner sees it; never sent to customers. */
export type Party = NonNullable<ItemView["party"]>;

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

// ---- setup: profile, services, products, hours, rules ------------------------------------

export type ProfileBody = Partial<{
  readonly name: string;
  readonly domain: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: readonly string[];
}>;

export type PriceModel = "fixed" | "from" | "quote";
export interface ServicePrice {
  readonly model: PriceModel;
  readonly value?: number | undefined;
  readonly currency?: string | undefined;
}

/** A services row as the API returns it (camelCase, active as 0/1, times in ms). */
export interface ServiceRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly durationMin: number;
  readonly bufferBeforeMin: number;
  readonly bufferAfterMin: number;
  readonly capacity: number;
  readonly granularityMin: number;
  readonly price: ServicePrice | null;
  readonly active: number;
  readonly sort: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Fields of POST/PATCH /services (snake_case, all optional on PATCH). */
export type ServiceBody = Partial<{
  readonly name: string;
  readonly description: string;
  readonly duration_min: number;
  readonly buffer_before_min: number;
  readonly buffer_after_min: number;
  readonly capacity: number;
  readonly granularity_min: number;
  readonly price: ServicePrice;
  readonly active: boolean;
  readonly sort: number;
}>;

export interface ProductRow {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: Money;
  readonly stock: number | null;
  readonly active: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ProductBody = Partial<{
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price: Money;
  readonly stock: number | null;
  readonly active: boolean;
}>;

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Window = readonly [string, string];

export interface RuleBody {
  readonly name?: string | undefined;
  readonly priority?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly definition?: RuleDefinition | undefined;
  readonly expected_version?: number | undefined;
}

export type PresetKey = "appointments" | "trades" | "shop";
export interface Preset {
  readonly key: PresetKey;
  readonly name: string;
  readonly rules: readonly {
    readonly name: string;
    readonly priority: number;
    readonly summary: string;
    readonly definition: RuleDefinition;
  }[];
}

export interface RuleTest {
  readonly matched: boolean;
  readonly summary: string;
  readonly would: readonly string[];
  readonly item: { readonly id: string; readonly type: string; readonly state: string };
  readonly facts: { readonly slotIsFree: boolean | null; readonly withinBusinessHours: boolean | null };
}
