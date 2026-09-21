import { authHeaders } from "./auth";
import type {
  Availability,
  BusinessProfile,
  Closure,
  ItemDetail,
  ItemView,
  ListParams,
  Page,
  Preset,
  PresetKey,
  Problem,
  ProblemField,
  ProductBody,
  ProductRow,
  Profile,
  ProfileBody,
  ReplyBody,
  RuleBody,
  RuleDefinition,
  RuleTest,
  RuleView,
  ServiceBody,
  ServiceRow,
  SettingsBody,
  SettingsDoc,
  TransitionBody,
  TransitionResult,
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

const item = (id: string) => `/v1/owner/items/${encodeURIComponent(id)}`;

export const api = {
  business: () => call<BusinessProfile>("GET", "/v1/business", { public: true }),
  /** Sign-in by email: the server mails a link (or logs it when no mail provider is set up). */
  requestMagicLink: (email: string, redirect: string | undefined) =>
    call<{ ok: boolean; message: string }>("POST", "/auth/magic-link", {
      body: { email, ...(redirect ? { redirect } : {}) },
      public: true,
    }),
  /** Sign-in by key: the settings document is the cheapest owner-only read. */
  verifyKey: (key: string) => call<SettingsDoc>("GET", "/v1/owner/settings", { key }),
  listItems: (params: ListParams) => call<Page<ItemView>>("GET", "/v1/owner/items", { query: { ...params } }),
  getItem: (id: string) => call<ItemDetail>("GET", item(id)),
  transition: (id: string, body: TransitionBody) =>
    call<TransitionResult>("POST", `${item(id)}/transitions`, { body, idempotent: true }),
  reply: (id: string, body: ReplyBody) =>
    call<TransitionResult | ItemView>("POST", `${item(id)}/replies`, { body, idempotent: true }),
  getSettings: () => call<SettingsDoc>("GET", "/v1/owner/settings"),
  putSettings: (body: SettingsBody) => call<SettingsDoc>("PUT", "/v1/owner/settings", { body }),

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
  availability: () => call<Availability>("GET", "/v1/owner/availability"),
  putWeekly: (weekly: Weekly, serviceId?: string) =>
    call<Availability>("PUT", "/v1/owner/availability", {
      body: { weekly, ...(serviceId ? { service_id: serviceId } : {}) },
    }),
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
  testRule: (definition: RuleDefinition, itemId: string) =>
    call<RuleTest>("POST", "/v1/owner/rules/test", { body: { definition, item_id: itemId } }),
};
