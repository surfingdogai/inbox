import type { MailOut } from "@surfingdog/platform";
import { businessFacts } from "../customer/audience";
import type { Db } from "../db";
import { type AttachmentRef, attachmentsOf, readAttachment, removeAttachment } from "../email/attachments";
import { inboundOf } from "../email/channel";
import { queueForwardCheck } from "../email/check";
import {
  addForward,
  CHECK_WAIT_MS,
  clearConfirmation,
  type Forward,
  forwardById,
  isMailProvider,
  listForwards,
  MAIL_PROVIDER_NAMES,
  MAIL_PROVIDERS,
  type MailProvider,
  removeForward,
} from "../email/forwards";
import { plusAddress, splitAddress } from "../email/tokens";
import { senderOf } from "../jobs/mail-log";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, isOwnerAssistant, isOwnerInPerson, isPerson, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";

/**
 * The email channel, as the owner sees and sets it (ADR-026): the inbox's own address, the
 * business's existing addresses forwarded to it with where each stands, and who customers' emails
 * are from. Reading is anyone's at the business; changing where mail goes is the owner's in person.
 */

/** A DNS row the business adds so mail can be sent from its own domain, as the host gives it. */
export interface DnsRow {
  readonly type: "CNAME" | "TXT" | "MX";
  /** The full name, e.g. `abc._domainkey.shop.example`. */
  readonly name: string;
  readonly value: string;
  readonly priority?: number | undefined;
  /** What the host's last look at the business's DNS found: there and right, or not (yet). */
  readonly ok?: boolean | undefined;
  /** Why it is there, in a few words ("signs your email", "takes returned email"). */
  readonly purpose?: string | undefined;
}

/** Sending from the business's own address, as a host that offers it says it stands. */
export interface HostSender {
  /** The address asked for, or null when none was. */
  readonly address: string | null;
  /**
   * `dns`: the rows are waiting to be added; `verifying`: they are there and the sending service is
   * checking them; `verified`: email goes from the address; `failed`: what was there stopped
   * checking out; `unavailable`: this host cannot send from a business's own domain yet.
   */
  readonly state: "none" | "dns" | "verifying" | "verified" | "failed" | "unavailable";
  readonly records: readonly DnsRow[];
  readonly checkedAt: string | null;
  /** Why it stands where it does, in the owner's words, when something is wrong. */
  readonly problem?: string | null | undefined;
  /**
   * Where the business's DNS is run, as its name servers tell, and that provider's steps for adding
   * the rows: shown with them. Absent when the host could not tell.
   */
  readonly dnsProvider?: { readonly name: string; readonly steps: readonly string[] } | null | undefined;
}

/**
 * What a host that sends this inbox's mail offers the owner: sending from the business's own domain,
 * asked for and checked through it (a hosted inbox's control plane). Absent on an inbox run on one's
 * own server, which sends through the mail service its operator set up.
 */
export interface EmailHost {
  sender(): HostSender;
  /** Asks to send from `address` (an address on the business's own domain), or to stop when null. */
  request(address: string | null): Promise<void>;
  /** Asks the host to look at the DNS again now. */
  check(): Promise<void>;
}

export interface ForwardView {
  readonly id: string;
  readonly address: string;
  readonly provider: MailProvider;
  readonly provider_name: string;
  readonly state: Forward["state"];
  /** A check is out and has not come back yet. */
  readonly checking: boolean;
  readonly plus_ok: boolean;
  /** What the provider sent, named by its own proven sender (`provider`), never by what the owner picked. */
  readonly confirmation: {
    from: string;
    provider: string;
    code: string | null;
    url: string | null;
    at: string;
  } | null;
  readonly check_sent_at: string | null;
  readonly check_seen_at: string | null;
  readonly last_seen_at: string | null;
  readonly created_at: string;
}

export interface EmailChannelView {
  /** The inbox's own address, and an example of a conversation's. Null when it has none. */
  readonly inbound: {
    readonly address: string;
    readonly set_by_host: boolean;
    readonly conversation_example: string;
  } | null;
  readonly sending: {
    /** Who customers' email is from now, and in whose name. */
    readonly from: string | null;
    readonly name: string;
    /** `own`: the business's own address; `host`: the host's address in the business's name; `settings`: the address Settings name; `none`: nothing to send from. */
    readonly mode: "own" | "host" | "settings" | "none";
    /** Sending from the business's own address through the host, when the host offers it. */
    readonly own: HostSender | null;
  };
  /** Where customers' replies go: their conversation's own address, the address Settings name, or nowhere. */
  readonly replies: "conversation" | "settings" | "none";
  /** The address customers' replies go to when Settings name it (`replies` is `settings`), if known. */
  readonly reply_to: string | null;
  /** The only domain Customers reply to may be on, when the host restricts it (a hosted inbox's own). */
  readonly reply_domain: string | null;
  /** The owner can answer an alert by replying to it. */
  readonly owner_replies: boolean;
  readonly forwards: readonly ForwardView[];
  readonly providers: readonly { readonly id: MailProvider; readonly name: string }[];
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function view(f: Forward, now: number): ForwardView {
  return {
    id: f.id,
    address: f.address,
    provider: f.provider,
    provider_name: MAIL_PROVIDER_NAMES[f.provider],
    state: f.state,
    // Out, not back, and still within the two waits (the plus address, then the address itself).
    checking: f.checkSentAt !== null && f.checkSeenAt === null && now - f.checkSentAt < 2 * CHECK_WAIT_MS + 60_000,
    plus_ok: f.plusOk,
    confirmation: f.confirmation
      ? {
          from: f.confirmation.from,
          provider: f.confirmation.provider || MAIL_PROVIDER_NAMES[f.provider],
          code: f.confirmation.code,
          url: f.confirmation.url,
          at: new Date(f.confirmation.at).toISOString(),
        }
      : null,
    check_sent_at: iso(f.checkSentAt),
    check_seen_at: iso(f.checkSeenAt),
    last_seen_at: iso(f.lastSeenAt),
    created_at: new Date(f.createdAt).toISOString(),
  };
}

export class EmailChannelCapabilities {
  private host: EmailHost | null = null;
  private hostInbound = false;

  constructor(
    private readonly db: Db,
    private readonly mail: () => MailOut | null,
    private readonly baseUrl: string | undefined,
  ) {}

  /** The host's say over sending (hosted inboxes); `inboundSetByHost` when its address is the host's. */
  attachHost(host: EmailHost | null, inboundSetByHost = false): void {
    this.host = host;
    this.hostInbound = inboundSetByHost;
  }

  async status(caller: Caller): Promise<EmailChannelView> {
    requireBusiness(caller);
    const now = nowOf(caller);
    const settings = await readSettings(this.db);
    const inbound = inboundOf(settings);
    const facts = await businessFacts(this.db, settings);
    const transport = this.mail();
    const publicUrl = this.baseUrl ?? settings.notifications.appUrl ?? "";
    const sender = senderOf(settings, { transport, publicUrl, business: facts.name });
    const own = this.host ? this.host.sender() : null;
    const from = sender?.from.address ?? null;
    const fromDomain = from ? splitAddress(from)?.domain : undefined;
    const mode: EmailChannelView["sending"]["mode"] = !sender
      ? "none"
      : own?.state === "verified" && own.address && splitAddress(own.address)?.domain === fromDomain
        ? "own"
        : transport?.pinned
          ? "host"
          : "settings";
    return {
      inbound: inbound
        ? {
            address: inbound,
            set_by_host: this.hostInbound,
            conversation_example: plusAddress(inbound, "t…") ?? inbound,
          }
        : null,
      sending: { from, name: sender?.from.name ?? facts.name, mode, own },
      replies: inbound ? "conversation" : sender?.replyTo || transport?.replies !== false ? "settings" : "none",
      reply_to: inbound ? null : (sender?.replyTo ?? null),
      reply_domain: transport?.pinned ? (transport.replyOwnDomain ?? null) : null,
      owner_replies: inbound !== null,
      forwards: (await listForwards(this.db)).map((f) => view(f, now)),
      providers: MAIL_PROVIDERS.map((id) => ({ id, name: MAIL_PROVIDER_NAMES[id] })),
    };
  }

  /** The addresses this inbox's email goes out from: what an owner's answer quotes as the alert's sender. */
  async sendingAddresses(): Promise<string[]> {
    const settings = await readSettings(this.db);
    const transport = this.mail();
    const publicUrl = this.baseUrl ?? settings.notifications.appUrl ?? "";
    const sender = senderOf(settings, { transport, publicUrl });
    return [sender?.from.address, transport?.sender?.address, settings.email.fromAddress].filter(
      (a): a is string => typeof a === "string" && a.includes("@"),
    );
  }

  /** Adds an address the business forwards here (or changes its provider). The owner checks it once it is set up. */
  async addForward(caller: Caller, input: { address: string; provider: string }): Promise<ForwardView> {
    requireOwnerInPerson(caller, "Only the owner can choose which addresses forward to this inbox.");
    if (!isMailProvider(input.provider)) {
      throw new WriteError("invalid_input", "choose a mail provider", {
        fields: [{ path: "provider", problem: "invalid", message: `one of ${MAIL_PROVIDERS.join(", ")}` }],
      });
    }
    const now = nowOf(caller);
    const settings = await readSettings(this.db);
    const f = await addForward(this.db, {
      address: input.address,
      provider: input.provider,
      inbound: inboundOf(settings),
      now,
    });
    return view(f, now);
  }

  async removeForward(caller: Caller, id: string): Promise<{ removed: boolean }> {
    requireOwnerInPerson(caller, "Only the owner can change which addresses forward to this inbox.");
    return { removed: await removeForward(this.db, id) };
  }

  /**
   * Sends a check to the business's own address now; it comes back if the forward works. A
   * confirmation shown for the address has been dealt with by then: it goes in the same step.
   */
  async checkForward(caller: Caller, id: string): Promise<ForwardView> {
    requireOwnerInPerson(caller, "Only the owner can send a forwarding check.");
    const now = nowOf(caller);
    const f = await forwardById(this.db, id);
    if (!f) throw new WriteError("not_found", "no such forwarded address");
    const settings = await readSettings(this.db);
    if (!inboundOf(settings)) {
      throw new WriteError(
        "not_allowed",
        "This inbox has no email address of its own yet, so nothing can come back to it.",
        {
          details: { reason: "no_inbound_address" },
        },
      );
    }
    if (f.confirmation) await clearConfirmation(this.db, id, now);
    await queueForwardCheck(this.db, id, now);
    const after = (await forwardById(this.db, id)) ?? f;
    return view({ ...after, checkSentAt: now, checkSeenAt: null }, now);
  }

  /** The owner dealt with the provider's confirmation: it is no longer shown. */
  async dismissConfirmation(caller: Caller, id: string): Promise<ForwardView> {
    requireOwnerInPerson(caller, "Only the owner can do this.");
    const now = nowOf(caller);
    await clearConfirmation(this.db, id, now);
    const f = await forwardById(this.db, id);
    if (!f) throw new WriteError("not_found", "no such forwarded address");
    return view(f, now);
  }

  /** Asks the host to send from the business's own address (null: stop). */
  async requestSender(caller: Caller, address: string | null): Promise<HostSender> {
    requireOwnerInPerson(caller, "Only the owner can choose the address customers' emails are from.");
    const host = this.host;
    if (!host) {
      throw new WriteError(
        "not_allowed",
        "This inbox sends through the mail service its server was set up with: the address is MAIL_FROM there, and its domain's records are that service's.",
        { details: { reason: "no_host" } },
      );
    }
    if (address !== null) {
      const a = splitAddress(address);
      const forwarded = (await listForwards(this.db)).find((f) => f.address === address.trim().toLowerCase());
      // Proven only by a check that came back through the forward (its secret token), never by headers.
      if (!a || !forwarded || forwarded.state !== "working" || forwarded.checkSeenAt === null) {
        throw new WriteError(
          "invalid_input",
          "Send from an address that forwards here and passed its check: it shows the address is the business's.",
          { fields: [{ path: "address", problem: "invalid", message: "a forwarded address that works" }] },
        );
      }
    }
    await host.request(address === null ? null : address.trim().toLowerCase());
    return host.sender();
  }

  async checkSender(caller: Caller): Promise<HostSender> {
    requireOwnerInPerson(caller, "Only the owner can do this.");
    if (!this.host) throw new WriteError("not_allowed", "No host sends this inbox's email.");
    await this.host.check();
    return this.host.sender();
  }

  async attachments(caller: Caller, itemId: string): Promise<AttachmentRef[]> {
    requireBusiness(caller);
    return attachmentsOf(this.db, itemId);
  }

  /** A person at the business deletes one kept file: its bytes go, the conversation says so. */
  async removeAttachment(caller: Caller, id: string): Promise<{ removed: true; item_id: string }> {
    requireBusiness(caller);
    if (!isPerson(caller)) {
      throw new WriteError("not_allowed", "Only a person at the business can delete a customer's file.", {
        details: { reason: "person_only" },
      });
    }
    const done = await removeAttachment(this.db, id);
    if (!done) throw new WriteError("not_found", "no such attachment, or it was not kept");
    return { removed: true, item_id: done.itemId };
  }

  /** One kept attachment, for the owner's download. */
  async attachment(
    caller: Caller,
    id: string,
  ): Promise<{ filename: string; contentType: string; itemId: string; bytes: Uint8Array }> {
    requireBusiness(caller);
    const a = await readAttachment(this.db, id);
    if (!a) throw new WriteError("not_found", "no such attachment, or it was not kept");
    // What the spam filter put aside or holds keeps its files shut until a person brings it back (ADR-041 §4.3).
    const { rows } = await this.db.client.query({
      sql: "SELECT state, screen FROM items WHERE id = ?",
      params: [a.itemId],
      method: "all",
    });
    const [state, screen] = (rows[0] ?? []) as [unknown, unknown];
    if (state === "spam" || screen === "aside" || screen === "held") {
      throw new WriteError("not_allowed", "Bring the message back to open its files.", { details: { reason: "spam" } });
    }
    return a;
  }
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "owner operations need an owner or staff principal");
}

/** The owner in person (never their AI, never a key handed to another system): where mail goes is theirs. */
function requireOwnerInPerson(caller: Caller, message: string): void {
  requireBusiness(caller);
  if (!isOwnerInPerson(caller) || isOwnerAssistant(caller)) {
    throw new WriteError("not_allowed", message, { details: { reason: "owner_only" } });
  }
}
