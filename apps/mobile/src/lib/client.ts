import { DEFAULT_PREFS, type NotifyPrefs } from "../../../../packages/core/src/phones/prefs";
import type { ItemDetail, ItemView, Page } from "../../../inbox/client/src/lib/types";
import type { PublicFacts, PublicService } from "./chips";
import type { QueuedAction, SendResult } from "./offline";
import { type Fetch, type InboxEntry, InboxError, movedTo, type Sessions } from "./session";

/**
 * One inbox, as the phone talks to it: the owner's own API for the items (held by the inbox to what a
 * phone may do), the phone's door for its settings, and the public door for free times. Every call
 * carries this phone's access token; a 401 gets one fresh token and one more try.
 */
export interface PhoneMe {
  readonly phone: {
    readonly id: string;
    readonly name: string;
    readonly push: string;
    readonly confirmed?: boolean;
    /** While it waits: who says yes, and when a day's wait ends. */
    readonly waits_on?: "computer" | "phone";
    readonly wait_until?: string;
  };
  readonly notify: NotifyPrefs;
  readonly business: { readonly name: string; readonly timezone: string };
  /** How long a price the phone sends can be accepted when it gives no date: the inbox's setting (hours). */
  readonly offer_valid_hours?: number;
  readonly push_available: boolean;
}

/** The spam filter, as the phone shows it (ADR-041 §12): which filters are on, what waits, the two emails. */
export interface PhoneSpam {
  readonly filters: readonly ("pitches" | "scams" | "junk")[];
  readonly held_now: number;
  readonly this_week: { readonly aside: number };
  readonly emails: { readonly held_digest: boolean; readonly weekly_summary: boolean };
}

export interface PhoneRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  readonly push: string;
}

/** A new phone that asked to connect, waiting for this phone's yes (ADR-028 Amendment 4). */
export interface PhoneAsk {
  readonly id: string;
  readonly phone: PhoneRow & { readonly platform?: string };
  /** The two digits the new phone shows. */
  readonly match: string;
  /** "I don't have my other phone": when it is let in unless stopped; null while it waits for a yes. */
  readonly wait_until: string | null;
}

export interface Slots {
  readonly service: { readonly id: string; readonly name: string; readonly durationMin: number };
  readonly slots: readonly { readonly startTime: string }[];
}

/** An inbox's answer: its JSON, or its refusal as an InboxError with the inbox's own sentence. */
async function answer<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let detail = `The inbox answered ${res.status}.`;
  let code = `http_${res.status}`;
  let details: Record<string, unknown> | undefined;
  try {
    const p = (await res.json()) as { detail?: string; code?: string; details?: Record<string, unknown> };
    detail = p.detail ?? detail;
    code = p.code ?? code;
    details = p.details && typeof p.details === "object" ? p.details : undefined;
  } catch {
    // not JSON
  }
  throw new InboxError(detail, res.status, code, details);
}

export class InboxClient {
  private at: InboxEntry;

  constructor(
    entry: InboxEntry,
    private readonly sessions: Sessions,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {
    this.at = entry;
  }

  /** The inbox, at the address it answers at now (it may have moved since this client was made). */
  get entry(): InboxEntry {
    return this.at;
  }

  /**
   * One call. An inbox that answers it has moved (`movedTo`) is followed once, and the call made again
   * at its new address. When the inbox there says this phone was removed, it is signed out, as the old
   * address could have said itself; when the new address cannot be reached or is not that inbox, the
   * old address's answer stands.
   */
  protected async call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.callAt<T>(method, path, opts);
    } catch (error) {
      const to = movedTo(error);
      if (!to || to === this.at.origin) throw error;
      try {
        this.at = await this.sessions.follow(this.at, to);
      } catch (refused) {
        if (refused instanceof InboxError && refused.code === "signed_out") throw refused;
        throw error;
      }
      return this.callAt<T>(method, path, opts);
    }
  }

  private async callAt<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<T> {
    const send = async (fresh: boolean): Promise<Response> => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.auth !== false) headers.authorization = `Bearer ${await this.sessions.token(this.entry, fresh)}`;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
      try {
        return await this.fetchImpl(`${this.entry.origin}${path}`, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch {
        throw new InboxError("You're offline, or the inbox can't be reached.", 0, "network");
      }
    };
    let res = await send(false);
    if (res.status === 401 && opts.auth !== false) res = await send(true);
    return answer<T>(res);
  }

  /** What needs the owner (open items a rule flagged, or nobody has answered), or everything open. */
  items(filter: "needs" | "all", cursor?: string): Promise<Page<ItemView>> {
    const q = new URLSearchParams({ open_only: "true", limit: "40" });
    if (filter === "needs") q.set("needs_human", "true");
    if (cursor) q.set("cursor", cursor);
    return this.call("GET", `/v1/owner/items?${q}`);
  }

  /** What the spam filter holds, or everything put aside (ADR-041 §12). */
  screened(which: "held" | "spam"): Promise<Page<ItemView>> {
    const q = new URLSearchParams({ open_only: "false", limit: "40" });
    if (which === "held") q.set("screen", "held");
    else q.set("state", "spam");
    return this.call("GET", `/v1/owner/items?${q}`);
  }

  /** Let it in, Looks fine, or Spam on something held: one press each, a person's own. */
  spamAct(id: string, act: "let-in" | "looks-fine" | "spam", idempotencyKey: string): Promise<unknown> {
    return this.call("POST", `/v1/owner/items/${encodeURIComponent(id)}/${act}`, { body: {}, idempotencyKey });
  }

  spam(): Promise<PhoneSpam> {
    return this.call("GET", "/v1/phone/spam");
  }

  setSpamEmails(body: { held_digest?: boolean; weekly_summary?: boolean }): Promise<PhoneSpam> {
    return this.call("PUT", "/v1/phone/spam/emails", { body });
  }

  /** Recent items, open or not: the Handled list and Today read from it. */
  recent(): Promise<Page<ItemView>> {
    return this.call("GET", "/v1/owner/items?open_only=false&limit=60");
  }

  item(id: string): Promise<ItemDetail> {
    return this.call("GET", `/v1/owner/items/${encodeURIComponent(id)}`);
  }

  transition(id: string, body: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    return this.call("POST", `/v1/owner/items/${encodeURIComponent(id)}/transitions`, { body, idempotencyKey });
  }

  reply(id: string, text: string, idempotencyKey: string): Promise<unknown> {
    return this.call("POST", `/v1/owner/items/${encodeURIComponent(id)}/replies`, {
      body: { body: text, internal: false },
      idempotencyKey,
    });
  }

  /**
   * The price sheet's Send: the offer an item's state takes, built as the inbox builds it (a quote for
   * a request for a price), with every check it makes (`POST /v1/owner/items/{id}/offers`).
   */
  offer(id: string, body: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    return this.call("POST", `/v1/owner/items/${encodeURIComponent(id)}/offers`, { body, idempotencyKey });
  }

  /** A draft your AI, a rule or another system made outside your limits, sent as it is. */
  sendDraft(id: string, draftId: string, idempotencyKey: string): Promise<unknown> {
    return this.call("POST", `/v1/owner/items/${encodeURIComponent(id)}/offers/draft/send`, {
      body: { draft_id: draftId },
      idempotencyKey,
    });
  }

  /** The draft dropped, unsent: only that one, never a newer one. */
  dropDraft(id: string, draftId: string): Promise<{ dropped: boolean }> {
    const q = new URLSearchParams({ draft_id: draftId });
    return this.call("DELETE", `/v1/owner/items/${encodeURIComponent(id)}/offers/draft?${q}`);
  }

  /** Free start times for a service, from the business's own public door (at most 14 days). */
  slots(serviceId: string, from: string, to: string): Promise<Slots> {
    const q = new URLSearchParams({ service_id: serviceId, from, to });
    return this.call<Slots>("GET", `/v1/availability?${q}`, { auth: false });
  }

  /**
   * What the chips are made from, from the business's own public door with no token, as any assistant
   * reads it: its services and their prices, and the languages and currency it gave.
   */
  async facts(now: number = Date.now()): Promise<PublicFacts> {
    const [services, business] = await Promise.all([
      this.call<{ items: PublicService[] }>("GET", "/v1/services?limit=100", { auth: false }),
      this.call<{ languages?: string[]; currency?: string }>("GET", "/v1/business", { auth: false }),
    ]);
    return {
      services: services.items ?? [],
      languages: business.languages ?? [],
      currency: business.currency ?? "EUR",
      at: now,
    };
  }

  me(): Promise<PhoneMe> {
    return this.call("GET", "/v1/phone/me");
  }

  setNotify(prefs: NotifyPrefs): Promise<{ notify: NotifyPrefs }> {
    return this.call("PUT", "/v1/phone/notify", { body: prefs });
  }

  registerPush(push: {
    token: string;
    p256dh: string;
    auth: string;
  }): Promise<{ push: string; error: string | null; relay_device?: string }> {
    return this.call("PUT", "/v1/phone/push", { body: push });
  }

  /** The relay's id for this phone at this inbox, kept beside the inbox for the notification service. */
  keepRelayDevice(device: string): Promise<void> {
    return this.sessions.setRelayDevice(this.entry.alias, device);
  }

  test(): Promise<{ sent: boolean; note: string }> {
    return this.call("POST", "/v1/phone/test");
  }

  /** The owner's phones, and which one this is. */
  phones(): Promise<{ phones: PhoneRow[]; this: string }> {
    return this.call("GET", "/v1/phone/phones");
  }

  removePhone(id: string): Promise<{ removed: true }> {
    return this.call("DELETE", `/v1/phone/phones/${encodeURIComponent(id)}`);
  }

  /** New phones that wait for this one's yes. */
  async phoneAsks(): Promise<readonly PhoneAsk[]> {
    return (await this.call<{ pairings: PhoneAsk[] }>("GET", "/v1/phone/pairings")).pairings;
  }

  /** Confirm, after the fingerprint or face: signed with this phone's key, which signs only after an unlock. */
  async confirmPhone(id: string): Promise<{ state: "paired"; phone: PhoneRow }> {
    const proof = await this.sessions.confirmProof(this.entry, id);
    return this.call("POST", `/v1/phone/pairings/${encodeURIComponent(id)}/confirm`, { body: proof });
  }

  /** Not mine: the new phone is removed before it opens anything. */
  refusePhone(id: string): Promise<{ removed: boolean }> {
    return this.call("POST", `/v1/phone/pairings/${encodeURIComponent(id)}/refuse`, { body: {} });
  }
}

/**
 * "Try the demo" (store/play/app-content.md → App access): the app on Surfing Dog's demo bike shop,
 * read-only. The shop holds made-up examples and is set up again every night. No code, no sign-in and
 * no key on the phone: the demo's own doors (`/demo/phone/*`, apps/inbox/src/demo.ts) answer anyone,
 * and only read. Nothing pressed in the demo is sent anywhere, and the app says so.
 */
export const DEMO_ORIGIN = "https://demo.surfingdog.ai";
export const DEMO_ENTRY: InboxEntry = {
  alias: "demo",
  origin: DEMO_ORIGIN,
  name: "Oficina Maré",
  deviceId: "demo",
  addedAt: 0,
};
export const DEMO_READ_ONLY = "This is the demo: it shows examples, and nothing you press is sent.";

/** Where the demo answers what the phone asks a real inbox, or null when it is not a read. */
export function demoPath(method: string, path: string): string | null {
  if (method !== "GET") return null;
  const [p = "", q] = path.split("?");
  const query = q ? `?${q}` : "";
  if (p === "/v1/owner/items") return `/demo/phone/items${query}`;
  const item = /^\/v1\/owner\/items\/([^/]+)$/.exec(p);
  if (item) return `/demo/phone/items/${item[1]}`;
  // The shop's free times, prices and languages are on its public door, as at every inbox.
  if (p === "/v1/availability" || p === "/v1/services" || p === "/v1/business") return path;
  return null;
}

export class DemoClient extends InboxClient {
  constructor(
    sessions: Sessions,
    private readonly get: Fetch = (input, init) => fetch(input, init),
  ) {
    super(DEMO_ENTRY, sessions, get);
  }

  /** Reads only, with no token: anything else is refused here, before it leaves the phone. */
  protected override call<T>(method: string, path: string): Promise<T> {
    const at = demoPath(method, path);
    if (!at) return Promise.reject(new InboxError(DEMO_READ_ONLY, 403, "demo"));
    return this.read<T>(at);
  }

  private async read<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.get(`${DEMO_ORIGIN}${path}`, { headers: { accept: "application/json" } });
    } catch {
      throw new InboxError("You're offline, or the demo can't be reached.", 0, "network");
    }
    return answer<T>(res);
  }

  /** The shop, as Settings and the inbox name it. The demo sends no notifications. */
  override async me(): Promise<PhoneMe> {
    const shop = await this.read<{ business: { name: string; timezone: string } }>("/demo/phone/me");
    return {
      phone: { id: "demo", name: "This phone", push: "off", confirmed: true },
      notify: DEFAULT_PREFS,
      business: shop.business,
      push_available: false,
    };
  }

  override keepRelayDevice(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Whether something the owner did should wait on the phone and go later, rather than be dropped: the
 * inbox could not be reached, was briefly not answering (busy, being updated, a gateway in between),
 * or the phone's key needed an unlock the owner did not give just then. Only the inbox's own refusal
 * of the action (already answered, not allowed, signed out) drops it.
 */
export function sendLater(error: unknown): boolean {
  if (!(error instanceof InboxError)) return true;
  if (error.offline) return true;
  const s = error.status;
  return s === 408 || s === 423 || s === 425 || s === 429 || s >= 500;
}

/** Sends one thing done on the phone, as the outbox asks: done, to try again later, or refused for good. */
export async function sendQueued(c: InboxClient | undefined, a: QueuedAction): Promise<SendResult> {
  if (!c) return { ok: false, offline: false, reason: "That inbox is no longer on this phone." };
  try {
    if (a.kind === "reply") await c.reply(a.itemId, String(a.body.body ?? ""), a.key);
    else if (a.kind === "offer") await c.offer(a.itemId, a.body, a.key);
    else if (a.kind === "draft") await c.sendDraft(a.itemId, String(a.body.draft_id ?? ""), a.key);
    else await c.transition(a.itemId, a.body, a.key);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, offline: sendLater(error), reason };
  }
}
