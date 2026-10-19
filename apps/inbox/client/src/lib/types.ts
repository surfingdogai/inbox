import type {
  Action,
  AttachmentRef,
  Availability,
  BusinessProfile,
  CalendarChoice,
  Closure,
  Condition,
  ConnectedAppView,
  ConnectionView,
  CreatedKey,
  CustomerSummary,
  DeliveryView,
  DnsRow,
  EmailChannelView,
  EraseResult,
  FeedConnector,
  FormField,
  ForwardView,
  GalleryCard,
  GalleryWay,
  HostSender,
  IntegrationsView,
  Item,
  ItemDetail,
  ItemType,
  ItemView,
  KeyList,
  KeyView,
  MailProvider,
  Money,
  NetworkView,
  Page,
  PaymentView,
  Profile,
  ReceiptStatus,
  ReceiptView,
  RefusalView,
  RuleDefinition,
  RuleView,
  Settings,
  TestEventResult,
  TransitionResult,
  WebhookView,
  WebhookWithSecret,
  Weekly,
} from "@surfingdog/core";

/**
 * The shapes the owner app consumes. Type-only imports from core: nothing of the server is bundled,
 * and the app cannot drift from what the API returns.
 */
export type {
  Action,
  AttachmentRef,
  Availability,
  BusinessProfile,
  CalendarChoice,
  Closure,
  Condition,
  ConnectedAppView,
  ConnectionView,
  CreatedKey,
  CustomerSummary,
  DeliveryView,
  DnsRow,
  EmailChannelView,
  EraseResult,
  FeedConnector,
  FormField,
  ForwardView,
  GalleryCard,
  GalleryWay,
  HostSender,
  IntegrationsView,
  Item,
  ItemDetail,
  ItemType,
  ItemView,
  KeyList,
  KeyView,
  MailProvider,
  Money,
  NetworkView,
  Page,
  PaymentView,
  Profile,
  ReceiptStatus,
  ReceiptView,
  RefusalView,
  RuleDefinition,
  RuleView,
  Settings,
  TestEventResult,
  TransitionResult,
  WebhookView,
  WebhookWithSecret,
  Weekly,
};

/** Whether this inbox sends email (`GET /v1/owner/mail`). */
export interface MailStatus {
  readonly service: boolean;
  readonly sender: boolean;
  readonly links: boolean;
}

/** One receipt as the API returns it on an item. */
export type Receipt = ReceiptView;

export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;
export type ThreadEntry = ItemDetail["thread"][number];
/** An email about an item, and what became of it. */
export type Mail = ItemDetail["mail"][number];
/** Who is asking, as the owner sees it (ADR-017 §8.2). */
export type Customer = NonNullable<ItemDetail["customer"]>;
export type ItemEvent = ItemDetail["events"][number];
export type Transition = ItemView["transitions"][number];
/** Who is asking, as the owner sees it; never sent to customers. */
export type Party = NonNullable<ItemView["party"]>;

export interface SettingsDoc {
  readonly doc: Settings;
  readonly version: number;
  /** Settings paths that hold a secret the read left out, e.g. `email.inboundSecret`. */
  readonly redacted?: readonly string[] | undefined;
  /** Settings the host set or holds, dotted (`email`, `notifications.appUrl`): shown, never changed here. */
  readonly locked?: readonly string[] | undefined;
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
  /** Only items with an email that could not be sent. */
  readonly mail_failed?: boolean | undefined;
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
  /** A fixed price is for the whole booking unless it is per person. */
  readonly per?: "booking" | "person" | undefined;
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
  /** Whether a customer may suggest a price of their own for it, while price counters are on (0/1). */
  readonly negotiable?: number | undefined;
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
  /** null takes the price off: priced on request. */
  readonly price: ServicePrice | null;
  readonly active: boolean;
  readonly sort: number;
  readonly negotiable: boolean;
}>;

export interface ProductRow {
  readonly id: string;
  readonly sku: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: Money;
  readonly stock: number | null;
  readonly active: number;
  readonly negotiable?: number | undefined;
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
  readonly negotiable: boolean;
}>;

/** The owner's lowest prices (ADR-018 §4): what their AI, rules and other systems may go down to. */
export interface Floor {
  readonly kind: "product" | "service";
  readonly ref_id: string;
  readonly floor_minor: number;
  readonly updated_at: string;
}

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
  /** What a run would hold back on this item, in plain words: a rule reading a customer's record only helps them. */
  readonly skipped?: readonly string[];
  readonly item: { readonly id: string; readonly type: string; readonly state: string };
  readonly facts: { readonly slotIsFree: boolean | null; readonly withinBusinessHours: boolean | null };
}

/** Connecting a feed. No credentials: that is the point of a feed. */
export interface AddFeedBody {
  readonly url: string;
  readonly name?: string | undefined;
  readonly currency?: string | undefined;
  readonly deactivate_missing?: boolean | undefined;
}

export interface CreateWebhookBody {
  readonly url: string;
  readonly events: readonly string[];
  readonly payload_style: "thin" | "full";
  /** Extra headers sent with every delivery; values are sealed and never shown again. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type PatchWebhookBody = Partial<
  Omit<CreateWebhookBody, "headers"> & {
    readonly active: boolean;
    /** Merged: a name with null removes that header. */
    readonly headers: Readonly<Record<string, string | null>>;
  }
>;

// ---- keys: one named, scoped, revocable key per system that connects ----------------------

export interface CreateKeyBody {
  readonly name: string;
  readonly preset?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly expires_at?: string | undefined;
}

/** `POST /v1/owner/integrations`: a connection made with a form. */
export interface ConnectBody {
  readonly kind: string;
  readonly preset?: string | undefined;
  readonly values: Readonly<Record<string, string>>;
  /** Connect this connection again in place: only its secret fields, every choice kept. */
  readonly connection_id?: string | undefined;
}

/** `PATCH /v1/owner/integrations/{id}`: what the owner chooses. */
export interface ConnectionPatch {
  readonly busy_on?: boolean;
  readonly bookings_on?: boolean;
  readonly busy_calendars?: readonly string[];
  readonly destination?: string | null;
  readonly services?: readonly string[] | null;
  readonly paused?: boolean;
  /** A payment platform: accepted orders get a link to pay (ADR-023). */
  readonly pay_on?: boolean;
}

/** The lines that lead an agent from the business's own site to this inbox (`GET /v1/owner/discovery`). */
export interface DiscoverySnippets {
  readonly manifest: string;
  readonly llms_line: string;
  readonly llms_file: string;
  readonly link_tag: string;
  readonly link_header: string;
  readonly json_ld: string;
  readonly dns_name: string;
  readonly dns_value: string;
  readonly well_known: string;
  readonly robots: string;
}

export interface DiscoveryView {
  readonly domain: string | null;
  readonly domainFrom: "website" | "host" | "inbox" | null;
  readonly host: string | null;
  readonly name: string;
  readonly manifest: string | null;
  readonly snippets: DiscoverySnippets | null;
  readonly checker: string;
}

/** One thing Surfing Dog's checker looked at (`POST /v1/owner/discovery/check`). */
export interface DiscoveryItem {
  readonly id: "cname" | "manifest" | "robots" | "well_known" | "llms_txt" | "link" | "schema_org" | "dns_txt";
  readonly need: "required" | "recommended" | "optional";
  readonly state: "ok" | "missing" | "wrong" | "blocked" | "unreadable";
  readonly detail: string;
  readonly fix?: string | undefined;
  readonly fix_lines?: string | undefined;
}

/** The check as the inbox read it (the spec's DiscoveryAnswer): a state this version does not know is left out. */
export interface DiscoveryResult {
  readonly domain: string;
  readonly host: string;
  readonly manifest: string;
  readonly checked_at: string;
  readonly ready: boolean;
  readonly state?: "ready" | "unreachable" | "blocked" | "robots_unreadable" | "dns_only" | "no_way" | undefined;
  readonly ways: number;
  readonly site_ways?: number | undefined;
  readonly platform?: "wordpress" | "shopify" | "wix" | "squarespace" | undefined;
  readonly next: string;
  readonly items: readonly DiscoveryItem[];
}
