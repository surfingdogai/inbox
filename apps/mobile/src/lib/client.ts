import type { NotifyPrefs } from "../../../../packages/core/src/phones/prefs";
import type { ItemDetail, ItemView, Page } from "../../../inbox/client/src/lib/types";
import { type Fetch, type InboxEntry, InboxError, type Sessions } from "./session";

/**
 * One inbox, as the phone talks to it: the owner's own API for the items (held by the inbox to what a
 * phone may do), the phone's door for its settings, and the public door for free times. Every call
 * carries this phone's access token; a 401 gets one fresh token and one more try.
 */
export interface PhoneMe {
  readonly phone: { readonly id: string; readonly name: string; readonly push: string; readonly confirmed?: boolean };
  readonly notify: NotifyPrefs;
  readonly business: { readonly name: string; readonly timezone: string };
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

export interface Slots {
  readonly service: { readonly id: string; readonly name: string; readonly durationMin: number };
  readonly slots: readonly { readonly startTime: string }[];
}

export class InboxClient {
  constructor(
    readonly entry: InboxEntry,
    private readonly sessions: Sessions,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(
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

  /** Free start times for a service, from the business's own public door (at most 14 days). */
  slots(serviceId: string, from: string, to: string): Promise<Slots> {
    const q = new URLSearchParams({ service_id: serviceId, from, to });
    return this.call<Slots>("GET", `/v1/availability?${q}`, { auth: false });
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
}
