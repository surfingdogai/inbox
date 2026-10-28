import { authHeaders } from "./auth";
import { attachmentName } from "./download";
import type {
  AddFeedBody,
  AgentPaymentView,
  AuthorizeBody,
  Availability,
  BusinessProfile,
  CatalogueStatus,
  Closure,
  ConnectBody,
  ConnectionPatch,
  ConnectionView,
  CreatedKey,
  CreateKeyBody,
  CreateWebhookBody,
  CustomerSummary,
  DeliveryView,
  DiscoveryResult,
  DiscoveryView,
  EmailChannelView,
  EraseResult,
  FeedConnector,
  Floor,
  ForwardView,
  HostSender,
  IntegrationsView,
  ItemDetail,
  ItemView,
  KeyList,
  KeyView,
  ListParams,
  MailProvider,
  MailStatus,
  ModelCard,
  ModelChoice,
  ModelTest,
  NetworkView,
  Page,
  PatchWebhookBody,
  PaymentView,
  PhoneView,
  Preset,
  PresetKey,
  Problem,
  ProblemField,
  ProductBody,
  ProductRow,
  Profile,
  ProfileBody,
  ReceiptStatus,
  ReplyBody,
  RuleBody,
  RuleDefinition,
  RuleTest,
  RuleView,
  ServiceBody,
  ServiceRow,
  SettingsBody,
  SettingsDoc,
  SpamStatus,
  TestEventResult,
  TransitionBody,
  TransitionResult,
  WebhookView,
  WebhookWithSecret,
  Weekly,
} from "./types";

/**
 * The owner API over fetch. Every refusal becomes an ApiProblem carrying the problem document, so
 * screens show the API's own sentence and the fields it names.
 */
export class ApiProblem extends Error implements Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly fields: readonly ProblemField[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(p: Problem) {
    super(p.detail);
    this.name = "ApiProblem";
    this.type = p.type;
    this.title = p.title;
    this.status = p.status;
    this.detail = p.detail;
    this.code = p.code;
    this.fields = p.fields;
    this.details = p.details;
  }

  /** The message for one input path, matched on its tail ("business.currency" ⊂ "doc.business.currency"). */
  field(path: string): string | undefined {
    return this.fields?.find((f) => f.path === path || f.path.endsWith(`.${path}`))?.message;
  }
}

export function problemOf(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ApiProblem({ type: "about:blank", title: "Error", status: 0, code: "client", detail: message });
}

let unauthorizedHandler: (() => void) | undefined;
/** Called once per refused owner call (401): the app clears the key and goes to sign-in. */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

type Query = Record<string, string | number | boolean | undefined>;

interface CallOptions {
  readonly query?: Query;
  readonly body?: unknown;
  /** Try this key instead of the stored one (sign-in). A 401 then stays local. */
  readonly key?: string;
  /** Send a fresh Idempotency-Key so a retried write is answered, not repeated. */
  readonly idempotent?: boolean;
  readonly public?: boolean;
  /** Let the request finish after the page goes away (an act sent as the owner leaves, before its Undo ran out). */
  readonly keepalive?: boolean;
}

async function problemFrom(res: Response): Promise<Problem> {
  const fallback: Problem = {
    type: "about:blank",
    title: res.statusText || "Error",
    status: res.status,
    code: `http_${res.status}`,
    detail:
      res.status === 401
        ? "You are not signed in here any more. Sign in again to continue."
        : `The inbox answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`,
  };
  try {
    const body = (await res.json()) as Partial<Problem> & { error?: string };
    if (typeof body.detail === "string") {
      return { ...fallback, ...body, code: body.code ?? fallback.code, status: body.status ?? res.status };
    }
    if (typeof body.error === "string") return { ...fallback, code: body.error };
  } catch {
    // not JSON: keep the fallback sentence
  }
  return fallback;
}

async function call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  else if (!opts.public) Object.assign(headers, authHeaders());
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["idempotency-key"] = crypto.randomUUID();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "include",
      ...(opts.keepalive ? { keepalive: true } : {}),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiProblem({
      type: "about:blank",
      title: "Unreachable",
      status: 0,
      code: "network",
      detail: `Could not reach the inbox at ${url.origin}. Check the server is running, then try again.`,
    });
  }
  if (res.ok) return (await res.json()) as T;
  const problem = await problemFrom(res);
  if (res.status === 401 && !opts.key) unauthorizedHandler?.();
  throw new ApiProblem(problem);
}

/** A call the inbox answers with a file: the file and the name it gives it, or the problem, as `call`. */
async function file(path: string, body: unknown): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(new URL(path, window.location.origin), {
      method: "POST",
      headers: { accept: "application/zip", "content-type": "application/json", ...authHeaders() },
      credentials: "include",
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiProblem({
      type: "about:blank",
      title: "Unreachable",
      status: 0,
      code: "network",
      detail: "Could not reach the inbox. Check the server is running, then try again.",
    });
  }
  if (res.ok)
    return { blob: await res.blob(), filename: attachmentName(res.headers.get("content-disposition"), "inbox.zip") };
  const problem = await problemFrom(res);
  if (res.status === 401) unauthorizedHandler?.();
  throw new ApiProblem(problem);
}

/** A file the inbox gives as a download (GET): the file and its name, or the problem, as `call`. */
async function download(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(new URL(path, window.location.origin), {
      headers: { accept: "application/octet-stream", ...authHeaders() },
      credentials: "include",
    });
  } catch {
    throw new ApiProblem({
      type: "about:blank",
      title: "Unreachable",
      status: 0,
      code: "network",
      detail: "Could not reach the inbox. Check the server is running, then try again.",
    });
  }
  if (res.ok)
    return { blob: await res.blob(), filename: attachmentName(res.headers.get("content-disposition"), fallbackName) };
  const problem = await problemFrom(res);
  if (res.status === 401) unauthorizedHandler?.();
  throw new ApiProblem(problem);
}

const item = (id: string) => `/v1/owner/items/${encodeURIComponent(id)}`;
const customerPath = (partyId: string) => `/v1/owner/customers/${encodeURIComponent(partyId)}`;

export const api = {
  business: () => call<BusinessProfile>("GET", "/v1/business", { public: true }),
  /**
   * Sign-in by email: the server mails a link and a code (or writes the email to its log while it
   * has no address to send from).
   */
  requestMagicLink: (email: string, redirect: string | undefined) =>
    call<{ ok: boolean; message: string }>("POST", "/auth/magic-link", {
      body: { email, ...(redirect ? { redirect } : {}) },
      public: true,
    }),
  /** The code from the sign-in email, instead of its link: sets the session cookie. */
  signInWithCode: (email: string, code: string) =>
    call<{ ok: boolean; redirect: string }>("POST", "/auth/code", { body: { email, code }, public: true }),
  /** A fresh code to the owner's own address, before changing it (the owner signed in, in person). */
  stepUp: (purpose: "email_change") =>
    call<{ ok: boolean; sent_to: string; expires_in: number }>("POST", "/auth/step-up", {
      body: { purpose },
      public: true,
    }),
  /** Asks to sign in with another address: a link goes there, to confirm in this browser. */
  changeEmail: (email: string, code: string) =>
    call<{ ok: boolean; sent_to: string }>("POST", "/auth/email", { body: { email, code }, public: true }),
  /** Sign-in by key: the settings document is the cheapest owner-only read. */
  verifyKey: (key: string) => call<SettingsDoc>("GET", "/v1/owner/settings", { key }),
  listItems: (params: ListParams) => call<Page<ItemView>>("GET", "/v1/owner/items", { query: { ...params } }),
  getItem: (id: string) => call<ItemDetail>("GET", item(id)),
  transition: (id: string, body: TransitionBody) =>
    call<TransitionResult>("POST", `${item(id)}/transitions`, { body, idempotent: true }),
  reply: (id: string, body: ReplyBody) =>
    call<TransitionResult | ItemView>("POST", `${item(id)}/replies`, { body, idempotent: true }),
  /** Sends the draft automation made outside the owner's limits, as it is (the owner in person only). */
  sendDraft: (id: string, draftId: string) =>
    call<TransitionResult>("POST", `${item(id)}/offers/draft/send`, { body: { draft_id: draftId }, idempotent: true }),
  dropDraft: (id: string, draftId: string) =>
    call<{ dropped: boolean }>("DELETE", `${item(id)}/offers/draft`, { query: { draft_id: draftId } }),
  getSettings: () => call<SettingsDoc>("GET", "/v1/owner/settings"),
  receiptStatus: () => call<ReceiptStatus>("GET", "/v1/owner/receipts"),
  putSettings: (body: SettingsBody) => call<SettingsDoc>("PUT", "/v1/owner/settings", { body }),
  /** `reportable`: whether a network could verify this inbox at its address now (absent from an older server). */
  networks: () => call<{ networks: NetworkView[]; reportable?: boolean }>("GET", "/v1/owner/networks"),
  /** A new key to sign receipts with; the old one signs nothing more from this inbox (the owner in person only). */
  replaceReceiptKey: () =>
    call<{ retired: string[]; active: string }>("POST", "/v1/owner/receipt-keys/rotate", {
      body: {},
      idempotent: true,
    }),
  /** "Let agents find your inbox": the lines for the business's own site (ADR-024). */
  discovery: () => call<DiscoveryView>("GET", "/v1/owner/discovery"),
  /** Surfing Dog's checker reads the site, when the owner asks. */
  checkDiscovery: () => call<DiscoveryResult>("POST", "/v1/owner/discovery/check"),
  /** Whether email goes out at all, has an address to go from, and can carry answer links. */
  mailStatus: () => call<MailStatus>("GET", "/v1/owner/mail"),
  // The email channel (ADR-026).
  emailChannel: () => call<EmailChannelView>("GET", "/v1/owner/email"),
  emailProvider: (address: string) =>
    call<{ provider: MailProvider; name: string }>("GET", "/v1/owner/email/provider", { query: { address } }),
  addForward: (body: { address: string; provider: MailProvider }) =>
    call<ForwardView>("POST", "/v1/owner/email/forwards", { body }),
  removeForward: (id: string) =>
    call<{ removed: boolean }>("DELETE", `/v1/owner/email/forwards/${encodeURIComponent(id)}`),
  checkForward: (id: string) =>
    call<ForwardView>("POST", `/v1/owner/email/forwards/${encodeURIComponent(id)}/check`, { body: {} }),
  confirmedForward: (id: string) =>
    call<ForwardView>("POST", `/v1/owner/email/forwards/${encodeURIComponent(id)}/confirmed`, { body: {} }),
  setSender: (address: string | null) => call<HostSender>("PUT", "/v1/owner/email/sender", { body: { address } }),
  checkSender: () => call<HostSender>("POST", "/v1/owner/email/sender/check", { body: {} }),
  /** A person at the business deletes one kept file. */
  removeAttachment: (id: string) =>
    call<{ removed: true; item_id: string }>("DELETE", `/v1/owner/attachments/${encodeURIComponent(id)}`),
  /** One attached file, as a download. */
  attachment: (id: string) => download(`/v1/owner/attachments/${encodeURIComponent(id)}`, "attachment"),

  // ---- one customer: their data, networks off, erasure ----
  customer: (partyId: string) => call<CustomerSummary>("GET", customerPath(partyId)),
  exportCustomer: (partyId: string) => call<unknown>("GET", `${customerPath(partyId)}/export`),
  /** Six digits to the owner's own address, which a download needs. */
  /** Whether a download works here: a 501 `not_available` says how to copy the database instead. */
  downloadAvailable: () => call<{ available: true; leaving?: boolean }>("GET", "/v1/owner/download"),
  downloadCode: () => call<{ sent_to: string; expires_at: string }>("POST", "/v1/owner/download/code", { body: {} }),
  /** The whole inbox as a zip, for the code just emailed; with the receipt key only when asked for. */
  downloadInbox: (code: string, receiptKeys = false) =>
    file("/v1/owner/download", receiptKeys ? { code, receipt_keys: true } : { code }),
  stopNetworks: (partyId: string, itemId?: string) =>
    call<CustomerSummary>("POST", `${customerPath(partyId)}/networks-off`, {
      body: itemId ? { item_id: itemId } : {},
    }),
  /** Without `confirm` the answer is a 409 `confirm_erase` saying what would be erased, and the value to send. */
  eraseCustomer: (partyId: string, confirm?: string) =>
    call<EraseResult>("POST", `${customerPath(partyId)}/erase`, { body: confirm ? { confirm } : {} }),

  // ---- setup: who the business is, what it offers, when it is open, what runs on its own ----
  profile: () => call<Profile>("GET", "/v1/owner/profile"),
  putProfile: (body: ProfileBody) => call<Profile>("PUT", "/v1/owner/profile", { body }),
  services: () => call<{ items: ServiceRow[] }>("GET", "/v1/owner/services"),
  createService: (body: ServiceBody) => call<ServiceRow>("POST", "/v1/owner/services", { body }),
  patchService: (id: string, body: ServiceBody) =>
    call<ServiceRow>("PATCH", `/v1/owner/services/${encodeURIComponent(id)}`, { body }),
  archiveService: (id: string) => call<ServiceRow>("DELETE", `/v1/owner/services/${encodeURIComponent(id)}`),
  products: () => call<{ items: ProductRow[] }>("GET", "/v1/owner/products"),
  createProduct: (body: ProductBody) => call<ProductRow>("POST", "/v1/owner/products", { body }),
  patchProduct: (id: string, body: ProductBody) =>
    call<ProductRow>("PATCH", `/v1/owner/products/${encodeURIComponent(id)}`, { body }),
  archiveProduct: (id: string) => call<ProductRow>("DELETE", `/v1/owner/products/${encodeURIComponent(id)}`),
  /** The owner's one tap on a barcode their AI proposed (ADR-029). */
  confirmBarcode: (id: string) => call<ProductRow>("POST", `/v1/owner/products/${encodeURIComponent(id)}/barcode`),
  /** Your products on networks: the switch, what is listed, what needs a look (ADR-029). */
  catalogue: () => call<CatalogueStatus>("GET", "/v1/owner/catalogue"),
  skuBarcodes: (use: boolean) => call<{ used: number }>("POST", "/v1/owner/catalogue/sku-barcodes", { body: { use } }),
  floors: () => call<{ floors: Floor[] }>("GET", "/v1/owner/catalogue/floors"),
  putFloor: (kind: Floor["kind"], refId: string, floorMinor: number | null) =>
    call<{ floors: Floor[] }>("PUT", "/v1/owner/catalogue/floors", {
      body: { floors: [{ kind, ref_id: refId, floor_minor: floorMinor }] },
    }),
  availability: () => call<Availability>("GET", "/v1/owner/availability"),
  putWeekly: (weekly: Weekly, serviceId?: string) =>
    call<Availability>("PUT", "/v1/owner/availability", {
      body: { weekly, ...(serviceId ? { service_id: serviceId } : {}) },
    }),
  clearOverride: (serviceId: string) =>
    call<Availability>("DELETE", `/v1/owner/availability/${encodeURIComponent(serviceId)}`),
  putClosures: (closures: readonly Closure[]) =>
    call<Availability>("PUT", "/v1/owner/availability/closures", { body: { closures } }),
  rules: () => call<{ items: RuleView[] }>("GET", "/v1/owner/rules"),
  presets: () => call<{ items: Preset[] }>("GET", "/v1/owner/rules/presets"),
  applyPreset: (key: PresetKey, replace: boolean) =>
    call<{ items: RuleView[] }>("POST", `/v1/owner/rules/presets/${key}`, { body: { replace } }),
  createRule: (body: RuleBody) => call<RuleView>("POST", "/v1/owner/rules", { body }),
  patchRule: (id: string, body: RuleBody) =>
    call<RuleView>("PATCH", `/v1/owner/rules/${encodeURIComponent(id)}`, { body }),
  deleteRule: (id: string) => call<{ deleted: true }>("DELETE", `/v1/owner/rules/${encodeURIComponent(id)}`),
  testRule: (definition: RuleDefinition, itemId: string, name?: string) =>
    call<RuleTest>("POST", "/v1/owner/rules/test", {
      body: { definition, item_id: itemId, ...(name?.trim() ? { name: name.trim() } : {}) },
    }),

  // ---- integrations: what comes in, and where events go ----
  integrations: () => call<IntegrationsView>("GET", "/v1/owner/integrations"),
  connect: (body: ConnectBody) => call<ConnectionView>("POST", "/v1/owner/integrations", { body, idempotent: true }),
  authorizeIntegration: (body: AuthorizeBody) =>
    call<{ authorize_url: string }>("POST", "/v1/owner/integrations/authorize", {
      body: { ...body, return_to: "/settings/integrations" },
    }),
  /** A new link for a connection that serves one: the old one stops at once (ADR-030). */
  newConnectionLink: (id: string) =>
    call<ConnectionView>("POST", `/v1/owner/integrations/${encodeURIComponent(id)}/link`, { idempotent: true }),
  /** Propose the shop's total to the customer, for an order whose link is held (ADR-030). */
  proposeShopTotal: (id: string) =>
    call<TransitionResult>("POST", `/v1/owner/items/${encodeURIComponent(id)}/payments/shop-total`, {
      idempotent: true,
    }),
  /** Stop waiting for a payment from the customer's assistant that Stripe never answered (ADR-042). */
  stopWaiting: (id: string, paymentId: string) =>
    call<{
      item_id: string;
      payment_id: string;
      outcome: "stopped" | "paid" | "processing" | "not_charged";
      looked_up: boolean;
    }>("POST", `/v1/owner/items/${encodeURIComponent(id)}/payments/stop-waiting`, {
      body: { payment_id: paymentId },
      idempotent: true,
    }),
  updateConnection: (id: string, body: ConnectionPatch) =>
    call<ConnectionView>("PATCH", `/v1/owner/integrations/${encodeURIComponent(id)}`, { body, idempotent: true }),
  syncConnection: (id: string) =>
    call<{ queued: true; connection_id: string }>("POST", `/v1/owner/integrations/${encodeURIComponent(id)}/sync`, {
      idempotent: true,
    }),
  removeConnection: (id: string) =>
    call<{ removed: true; left_in_calendar: number; links_closed?: number; links_closing?: number }>(
      "DELETE",
      `/v1/owner/integrations/${encodeURIComponent(id)}`,
      { idempotent: true },
    ),
  /** An order's pay links in the business's own Stripe or Mollie account (ADR-023). */
  itemPayments: (id: string) =>
    call<{
      item_id: string;
      payments: PaymentView[];
      none: string | null;
      link_is_ours: boolean;
      /** What customers' assistants paid directly (ADR-042). */
      agent_payments?: AgentPaymentView[];
    }>("GET", `/v1/owner/items/${encodeURIComponent(id)}/payments`),
  feeds: () => call<{ items: FeedConnector[] }>("GET", "/v1/owner/feeds"),
  addFeed: (body: AddFeedBody) => call<FeedConnector>("POST", "/v1/owner/feeds", { body }),
  importFeed: (id: string) =>
    call<{ queued: true; connector_id: string }>("POST", `/v1/owner/feeds/${encodeURIComponent(id)}/import`),
  removeFeed: (id: string) =>
    call<{ removed: true; deactivated: number }>("DELETE", `/v1/owner/feeds/${encodeURIComponent(id)}`),
  webhooks: () => call<{ items: WebhookView[] }>("GET", "/v1/owner/webhooks"),
  /** The only call that ever returns the signing secret. Show it once; it cannot be read back. */
  createWebhook: (body: CreateWebhookBody) => call<WebhookWithSecret>("POST", "/v1/owner/webhooks", { body }),
  patchWebhook: (id: string, body: PatchWebhookBody) =>
    call<WebhookView>("PATCH", `/v1/owner/webhooks/${encodeURIComponent(id)}`, { body }),
  deleteWebhook: (id: string) => call<{ deleted: true }>("DELETE", `/v1/owner/webhooks/${encodeURIComponent(id)}`),
  rotateWebhookSecret: (id: string) =>
    call<WebhookWithSecret>("POST", `/v1/owner/webhooks/${encodeURIComponent(id)}/rotate-secret`),
  testWebhook: (id: string) => call<TestEventResult>("POST", `/v1/owner/webhooks/${encodeURIComponent(id)}/test`),
  deliveries: (id: string) =>
    call<{ items: DeliveryView[] }>("GET", `/v1/owner/webhooks/${encodeURIComponent(id)}/deliveries`),

  // ---- phones (ADR-028): a QR code to connect one, Confirm, the phones, a test, removing one ----
  phones: () =>
    call<{
      phones: PhoneView[];
      push: { available: boolean; reason: "no_relay" | "no_secret_key" | null; hosted: boolean };
      /** Where the Android app is got, once there is a place: null until then. */
      get_app: string | null;
    }>("GET", "/v1/owner/phones"),
  /** A one-time code for a phone to scan; it works once, for five minutes. */
  createPairing: () => call<{ id: string; qr: string; expires_at: string }>("POST", "/v1/owner/phones/pairings"),
  /** Waiting; a phone waiting for Confirm, with the two digits it shows; connected; or run out. */
  pairingStatus: (id: string) =>
    call<
      | { state: "waiting" | "expired" }
      | { state: "confirm"; phone: PhoneView; match: string }
      | { state: "paired"; phone?: PhoneView }
    >("GET", `/v1/owner/phones/pairings/${encodeURIComponent(id)}`),
  confirmPairing: (id: string) =>
    call<{ state: "paired"; phone: PhoneView }>("POST", `/v1/owner/phones/pairings/${encodeURIComponent(id)}/confirm`),
  refusePairing: (id: string) =>
    call<{ removed: boolean }>("POST", `/v1/owner/phones/pairings/${encodeURIComponent(id)}/refuse`),
  testPhone: (id: string) =>
    call<{ sent: boolean; note: string }>("POST", `/v1/owner/phones/${encodeURIComponent(id)}/test`),
  removePhone: (id: string) => call<{ removed: true }>("DELETE", `/v1/owner/phones/${encodeURIComponent(id)}`),

  // ---- the spam filter (ADR-041) ----
  spam: () => call<SpamStatus>("GET", "/v1/owner/spam"),
  setSpamFilter: (filter: "pitches" | "scams" | "junk", body: { on: boolean; choice?: "aside" | "label" }) =>
    call<SpamStatus>("PUT", `/v1/owner/spam/filters/${filter}`, { body }),
  setSpamAi: (on: boolean) => call<SpamStatus>("PUT", "/v1/owner/spam/ai", { body: { on } }),
  startSpamFilter: (filter: "basic" | "pitches" | "scams" | "junk") =>
    call<SpamStatus>("POST", `/v1/owner/spam/filters/${filter}/start`, { body: {} }),
  removeSpamListEntry: (body: { list: "allow" | "block"; kind: string; value: string }) =>
    call<{ removed: boolean }>("DELETE", "/v1/owner/spam/lists", { body }),
  letDomainThrough: (domain: string, itemId?: string) =>
    call<{ added: boolean }>("POST", "/v1/owner/spam/lists/domains", {
      body: { domain, ...(itemId ? { item_id: itemId } : {}) },
    }),
  letIn: (id: string, keepalive = false) =>
    call<{ released: boolean; time_passed: boolean }>("POST", `${item(id)}/let-in`, {
      body: {},
      idempotent: true,
      keepalive,
    }),
  looksFine: (id: string, keepalive = false) =>
    call<{ released: boolean }>("POST", `${item(id)}/looks-fine`, { body: {}, idempotent: true, keepalive }),
  markHeldSpam: (id: string, keepalive = false) =>
    call<{ block: { kind: string; value: string } | null }>("POST", `${item(id)}/spam`, {
      body: {},
      idempotent: true,
      keepalive,
    }),
  alwaysPutAside: (id: string) => call<{ added: boolean }>("POST", `${item(id)}/always-put-aside`, { body: {} }),
  /** A transition sent as the owner leaves the page, before its Undo ran out. */
  transitionKeepalive: (id: string, body: TransitionBody) =>
    call<TransitionResult>("POST", `${item(id)}/transitions`, { body, idempotent: true, keepalive: true }),
  // Your AI model, on one's own server (ADR-041 §11.5): the key goes to the inbox once, never back.
  spamModel: () => call<ModelCard>("GET", "/v1/owner/spam/model"),
  spamModels: (provider: string, key?: string) =>
    call<{ models: ModelChoice[] }>("POST", "/v1/owner/spam/model/models", {
      body: { provider, ...(key ? { key } : {}) },
    }),
  setSpamModel: (body: { provider: string; model: string; key?: string }) =>
    call<ModelCard>("PUT", "/v1/owner/spam/model", { body }),
  testSpamModel: () => call<ModelTest>("POST", "/v1/owner/spam/model/test", { body: {} }),
  removeSpamModel: () => call<ModelCard>("DELETE", "/v1/owner/spam/model"),

  // ---- keys: one named, scoped, revocable key per system that connects ----
  keys: () => call<KeyList>("GET", "/v1/owner/api-keys"),
  /** The only call that ever returns a key. Show it once; it cannot be read back. */
  createKey: (body: CreateKeyBody) => call<CreatedKey>("POST", "/v1/owner/api-keys", { body, idempotent: true }),
  revokeKey: (id: string) =>
    call<KeyView>("DELETE", `/v1/owner/api-keys/${encodeURIComponent(id)}`, { idempotent: true }),
  disconnectApp: (id: string) =>
    call<{ disconnected: number }>("DELETE", `/v1/owner/connected-apps/${encodeURIComponent(id)}`, {
      idempotent: true,
    }),
};

/** The one owner call, for screens that keep their own endpoints beside `api` (stays: `lib/property.ts`). */
export const ownerCall = call;
