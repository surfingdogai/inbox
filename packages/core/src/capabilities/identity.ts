import type { MailOut, Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import { payloadSchemas } from "../domain/types";
import { collectCarried } from "../identity/carried";
import { checkCode, createCode, type VerifyTarget } from "../identity/codes";
import { emailOf, maskEmail, rootParty } from "../identity/contacts";
import { customerHistory } from "../identity/history";
import { linkedParty } from "../identity/match";
import { issuanceStatements, passesFor, pendingFor } from "../identity/pending";
import {
  AGENT_GUIDE_URL,
  type AgentSeen,
  type IdentityAnswer,
  type IdentityPort,
  type IssueResult,
  NO_AGENT,
  type Presentation,
  type PresentResult,
} from "../identity/types";
import { senderOf } from "../jobs/notify";
import { secretHash } from "../protocol/credentials";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { type Caller, isCustomer, nowOf, type TrustTier } from "../write/caller";
import { findIdempotent } from "../write/common";
import { type CreateInput, type CreateResult, createItem } from "../write/create";
import { WriteError } from "../write/errors";

/**
 * People and customers at the doors (ADR-017 §2.1, §8.1–§8.4): the create that presents what the
 * agent carried and asks for a first key, the answer's `identity` block, a pass recognising its
 * person on the status, cancel and acknowledge doors, and the one-time code. The calls to networks
 * go through the host's `IdentityPort`; without one (or without `INBOX_SECRET_KEY`) the inbox
 * neither issues nor checks passes and everything else works as before.
 */
export const RULES_AFTER_ISSUANCE_MS = 4_000;

const EMPTY: PresentResult = { presentations: [], notes: [] };

/** What a door hands a create beside the create itself: the agent's strings. */
export interface CarriedInput {
  readonly pass?: string | undefined;
  readonly key?: string | undefined;
}

export class IdentityCapabilities {
  private port: IdentityPort | null = null;
  private mail: MailOut | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
  ) {}

  /** The host's network calls (`@surfingdog/adapters`). */
  attachPort(port: IdentityPort | null): void {
    this.port = port;
  }

  /** How one-time codes are sent. */
  attachMail(mail: MailOut | null): void {
    this.mail = mail;
  }

  /**
   * A create with its person (§2.1, §8.1): what the agent carried is presented first (in parallel,
   * time-boxed, failing open), the item is created with the match, presentations and links in its
   * batch, and then — for a booking or an order with an email and nothing carried — every network
   * that issues is asked for a key, whose answers land in a second batch. The answer carries the
   * `identity` block; a retry is answered from what is stored and asks no network again.
   */
  async create(caller: Caller, input: CreateInput, carried: CarriedInput): Promise<CreateResult> {
    const now = nowOf(caller);
    const { credentials } = collectCarried(carried.pass, carried.key, caller.carried);
    const agent = caller.agent ?? NO_AGENT;
    if (caller.idempotency && (await findIdempotent(this.db, caller.idempotency))) {
      const replayed = await createItem(this.db, caller, input);
      return { ...replayed, identity: await this.answer(replayed.view.item.id, {}, audienceOf(caller)) };
    }
    // Nothing is asked of a network for a request the create would refuse anyway.
    const valid = payloadSchemas[input.type]?.safeParse(input.payload).success === true;
    const port = isCustomer(caller) && valid ? this.port : null;
    const email = input.contact?.email;
    const presented = port && credentials.length ? await this.present(port, credentials, agent, email, now) : EMPTY;
    // A first contact (§2.1): a customer's booking or order with an email and nothing carried —
    // by mail, only when the gateway authenticated the sender.
    const issueAt =
      port &&
      credentials.length === 0 &&
      email &&
      (input.type === "booking" || input.type === "order") &&
      (caller.actor.channel !== "email" || caller.tier === "verified_principal") &&
      this.secrets &&
      (await port.canSign())
        ? issuingNetworks(await readSettings(this.db))
        : [];
    const tier = tierOf(caller, agent, presented.presentations);
    const result = await createItem(this.db, tier === caller.tier ? caller : { ...caller, tier }, {
      ...input,
      identity: {
        agent,
        presentations: presented.presentations,
        authenticatedEmail: caller.actor.channel === "email" && caller.tier === "verified_principal",
        issueAt,
        rulesDelayMs: issueAt.length ? RULES_AFTER_ISSUANCE_MS : 0,
      },
    });
    if (result.replayed) {
      return { ...result, identity: await this.answer(result.view.item.id, {}, audienceOf(caller)) };
    }
    let issued: IssueResult[] = [];
    if (port && email && issueAt.length && this.secrets) {
      const itemId = result.view.item.id;
      try {
        issued = await port.issue({ itemId, email, agent, networks: issueAt, now });
        const weak = (await this.matchOf(itemId)) === "weak";
        await this.db.batch([
          ...(await issuanceStatements(this.secrets, itemId, weak ? null : result.view.item.partyId, issued, now)),
          rulesDueNow(itemId, now),
        ]);
      } catch {
        // Nothing lost: the rows and the retry jobs were written with the item, and they ask again.
        issued = [];
        await this.db.client.query(rulesDueNow(itemId, now)).catch(() => undefined);
      }
    }
    return {
      ...result,
      identity: await this.answer(result.view.item.id, { presented, issued }, audienceOf(caller)),
    };
  }

  /**
   * On the status, cancel and acknowledge doors (§8.4): what the agent carried is presented, and a
   * person linked to a party here acts as that party — the same customer, recognised strongly.
   */
  async recognise(caller: Caller, carried: CarriedInput): Promise<{ caller: Caller; presented: PresentResult }> {
    if (!isCustomer(caller) || !this.port) return { caller, presented: EMPTY };
    const { credentials } = collectCarried(carried.pass, carried.key, caller.carried);
    if (!credentials.length) return { caller, presented: EMPTY };
    const now = nowOf(caller);
    const presented = await this.present(this.port, credentials, caller.agent ?? NO_AGENT, undefined, now);
    if (caller.actor.partyId) return { caller, presented };
    for (const p of presented.presentations) {
      const party = await linkedParty(this.db, p.network, p.ppid);
      if (!party) continue;
      await this.db.client.query({
        sql: `UPDATE person_links SET pass_hash = COALESCE(?, pass_hash), person = ?, updated_at = ?
               WHERE network = ? AND ppid = ?`,
        params: [p.passHash ?? null, JSON.stringify(p.person), now, p.network, p.ppid],
        method: "run",
      });
      return { caller: { ...caller, actor: { ...caller.actor, partyId: party } }, presented };
    }
    return { caller, presented };
  }

  /** An acknowledgement an agent signed rather than counter-signed (§3.4): forwarded as `agent_key`. */
  async forwardAck(
    caller: Caller,
    carried: CarriedInput,
    sha: string,
  ): Promise<{ network: string; presentation: string }[]> {
    const agent = caller.agent ?? NO_AGENT;
    if (!agent.signature) {
      throw new WriteError(
        "invalid_input",
        "an acknowledgement by receipt_id must be signed (sdi-agent/1) by a key delegated to the pass reference it carries; otherwise send counter_signature",
        {
          fields: [{ path: "receipt_id", problem: "invalid", message: "sign the request, or send counter_signature" }],
        },
      );
    }
    const { credentials } = collectCarried(carried.pass, carried.key, caller.carried);
    if (!this.port || credentials.length === 0) {
      throw new WriteError("invalid_input", "carry the pass reference the signing key is delegated to", {
        fields: [{ path: "pass", problem: "missing", message: "the pass reference (sdpass1_<host>_<id>)" }],
      });
    }
    const r = await this.port.present({ credentials, agent, purpose: "ack", sha, now: nowOf(caller) });
    if (r.presentations.length === 0) {
      const why = r.notes.map((n) => `${n.network.replace(/^https:\/\//, "")}: ${n.note}`).join("; ");
      throw new WriteError(
        "invalid_input",
        `no network took the acknowledgement${why ? ` (${why})` : ""}; the signing key must be delegated to the pass reference`,
        { details: { notes: r.notes } },
      );
    }
    return r.presentations.map((p) => ({ network: p.network, presentation: p.presentationId }));
  }

  /**
   * The `identity` block of a create or status answer (§8.4). Passes a first contact got are handed
   * back as long as they are kept (seven days); a pass a key became, only in the answer that made it.
   * Passes are the customer's, so who reads decides which (`PassAudience`): the item's creator gets
   * them all; someone recognised by a pass alone only the passes they presented; the business
   * itself (its owner, its AI, an integration key) reading through a customer's door, none.
   */
  async answer(
    itemId: string,
    fresh: { presented?: PresentResult; issued?: readonly IssueResult[] } = {},
    audience: PassAudience = "creator",
  ): Promise<IdentityAnswer> {
    const { rows } = await this.db.client.query({
      sql: "SELECT customer_match, possible_party_id FROM items WHERE id = ?",
      params: [itemId],
      method: "all",
    });
    const match = String(rows[0]?.[0] ?? "none");
    const recognised = (match === "strong" || match === "weak" ? match : "none") as IdentityAnswer["recognised"];
    const possible = rows[0]?.[1] ? String(rows[0][1]) : null;
    const passes = new Map<string, string>();
    if (audience !== "business") {
      for (const r of fresh.issued ?? []) if (r.outcome === "issued") passes.set(r.network, r.pass);
      // A pass the network made from a key this caller presented is theirs.
      for (const p of fresh.presented?.presentations ?? []) if (p.pass) passes.set(p.network, p.pass);
      const held = new Set((fresh.presented?.presentations ?? []).flatMap((p) => (p.passHash ? [p.passHash] : [])));
      for (const p of await passesFor(this.db, this.secrets, itemId)) {
        if (passes.has(p.network)) continue;
        // The item's first passes go back to its creator; to anyone else only a pass they hold.
        if (audience === "creator" || held.has(await secretHash(p.pass))) passes.set(p.network, p.pass);
      }
    }
    const networks = new Map<string, string>();
    for (const r of await pendingFor(this.db, itemId)) networks.set(r.network, stateWord(r.state));
    for (const p of fresh.presented?.presentations ?? []) networks.set(p.network, "presented");
    for (const n of fresh.presented?.notes ?? []) if (!networks.has(n.network)) networks.set(n.network, n.note);
    const { rows: sent } = await this.db.client.query({
      sql: "SELECT 1 FROM customer_codes WHERE item_id = ? AND used_at IS NULL LIMIT 1",
      params: [itemId],
      method: "all",
    });
    const knownEmail =
      recognised === "weak" && possible !== null ? await emailOf(this.db, await rootParty(this.db, possible)) : null;
    return {
      recognised,
      passes: [...passes.entries()].map(([network, pass]) => ({ network, pass })),
      verify: { available: knownEmail !== null, sent_to: knownEmail && sent.length ? maskEmail(knownEmail) : null },
      networks: [...networks.entries()].map(([network, state]) => ({ network, state })),
      guide: AGENT_GUIDE_URL,
    };
  }

  /**
   * One-time codes (§8.2): without `code`, six digits go to the address the business has for the
   * customer it may be; with one, it is checked and, when right, the customer is recognised.
   */
  async verify(
    target: VerifyTarget,
    code: string | undefined,
    now: number,
  ): Promise<{ sent_to: string } | { recognised: "strong" }> {
    const settings = await readSettings(this.db);
    if (code === undefined) {
      if (!this.mail) {
        throw new WriteError("nothing_to_verify", "We cannot send email right now, so we cannot send a code.");
      }
      const req = await createCode(this.db, target, settings, now);
      await this.mail.send({ ...senderOf(settings), to: [req.email], ...codeMail(settings, req.code) });
      return { sent_to: req.sentTo };
    }
    await checkCode(this.db, target, code, settings, now);
    return { recognised: "strong" };
  }

  /**
   * What the owner sees about who is asking (§8.2, §8.3): how sure the inbox is, the customer it may
   * be ("may be Ana Silva, unconfirmed"), the business's own history with them ("a customer you
   * know"), what each network presented, and how the agent signed.
   */
  async customerView(item: { id: string; partyId: string }): Promise<CustomerView> {
    const { rows } = await this.db.client.query({
      sql: "SELECT customer_match, possible_party_id, agent_level, agent_directory FROM items WHERE id = ?",
      params: [item.id],
      method: "all",
    });
    const r = rows[0] ?? [];
    const match = r[0] === null || r[0] === undefined ? null : String(r[0]);
    let possible: CustomerView["possible"] = null;
    if (r[1]) {
      const id = await rootParty(this.db, String(r[1]));
      const { rows: p } = await this.db.client.query({
        sql: "SELECT display_name FROM parties WHERE id = ?",
        params: [id],
        method: "all",
      });
      possible = { party_id: id, name: p[0]?.[0] ? String(p[0][0]) : null };
    }
    const history = await customerHistory(this.db, item.partyId, item.id);
    // What each network said of the person: on this item when the agent presented them, else the
    // last standing a network gave for the customer this item belongs to (§2.2: per network, each
    // authoritative for its own people; a business sees only what an agent presented to it).
    const { rows: pres } = await this.db.client.query({
      sql: `SELECT network, person, created_at, 'this_item' FROM item_presentations WHERE item_id = ?
            UNION ALL
            SELECT l.network, l.person, l.updated_at, 'earlier' FROM person_links l
             WHERE l.party_id = ? AND l.person IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM item_presentations p WHERE p.item_id = ? AND p.network = l.network)
            ORDER BY 1`,
      params: [item.id, item.partyId, item.id],
      method: "all",
    });
    return {
      match,
      possible,
      known: match === "strong" && history.items > 0,
      history,
      persons: pres.slice(0, 8).map((p) => personOf(String(p[0]), p[1], Number(p[2]), p[3] === "earlier")),
      agent: { level: r[2] ? String(r[2]) : "none", platform: r[3] ? String(r[3]) : null },
    };
  }

  private async matchOf(itemId: string): Promise<string | null> {
    const { rows } = await this.db.client.query({
      sql: "SELECT customer_match FROM items WHERE id = ?",
      params: [itemId],
      method: "all",
    });
    const m = rows[0]?.[0];
    return m === undefined || m === null ? null : String(m);
  }

  private async present(
    port: IdentityPort,
    credentials: readonly string[],
    agent: AgentSeen,
    email: string | undefined,
    now: number,
  ): Promise<PresentResult> {
    try {
      return await port.present({ credentials, agent, email, purpose: "request", now });
    } catch {
      // Fail open (R25): whatever went wrong, the customer is new here, never refused.
      return EMPTY;
    }
  }
}

/**
 * The one-time code email (ADR-017 §8.2), from the business in its own words: the customer asked
 * the business, or their assistant did, and nothing in it names anyone else.
 */
export function codeMail(
  settings: Awaited<ReturnType<typeof readSettings>>,
  code: string,
): { subject: string; text: string } {
  const name = settings.business.name.trim();
  const minutes = settings.customers.otp.ttlMinutes;
  return {
    subject: name ? `Your code for ${name}` : "Your code",
    text: [
      `${name ? `Your code for ${name}` : "Your code"} is ${code}. It works for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      "",
      "If you did not ask for it, you can ignore this email.",
    ].join("\n"),
  };
}

export interface CustomerView {
  readonly match: string | null;
  readonly possible: { readonly party_id: string; readonly name: string | null } | null;
  readonly known: boolean;
  readonly history: Awaited<ReturnType<typeof customerHistory>>;
  /** Per network that recognised the person, one entry (at most eight, §2.4). */
  readonly persons: readonly PersonView[];
  readonly agent: { readonly level: string; readonly platform: string | null };
}

/**
 * A person's standing at one network, as the owner is shown it (ADR-017 §5.3): the tier, the score,
 * kept and broken promises, how many unrelated businesses they kept them at, since when the network
 * has known them, whether they proved their address, whether their pass was used unusually, and
 * whether the network said so on this item or on an earlier one (`as_of` is when it said it).
 */
export interface PersonView {
  readonly network: string;
  readonly tier: "new" | "building" | "trusted";
  readonly score: number;
  readonly kept: number;
  readonly broken: number;
  readonly businesses: number;
  /** The person proved their address to the network with an emailed code. */
  readonly email_proven: boolean;
  /** When the network first knew them (ISO 8601), or null when it did not say. */
  readonly since: string | null;
  /** Their pass was seen at over ten businesses in a day, or with two signing keys; it still works. */
  readonly unusual_use: boolean;
  /** `this_item`: presented with this request; `earlier`: the last standing given for this customer. */
  readonly seen: "this_item" | "earlier";
  readonly as_of: string;
}

/**
 * The customer in a sentence or two, for the owner's AI (ADR-017 §8.2, §8.3): whether it is a
 * customer the business knows or may know, and how each network that presented the person knows
 * them. Empty when there is nothing beyond the party.
 */
export function customerSummary(c: CustomerView | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.match === "weak" && c.possible) {
    parts.push(
      `May be ${c.possible.name ?? "a customer you know"} (same email or phone, unconfirmed; a one-time code can prove it).`,
    );
  }
  if (c.known) {
    const h = c.history;
    const broken = [
      h.no_shows ? `${h.no_shows} no-show${h.no_shows === 1 ? "" : "s"}` : "",
      h.late_cancellations ? `${h.late_cancellations} late cancellation${h.late_cancellations === 1 ? "" : "s"}` : "",
      h.payment_failed ? `${h.payment_failed} failed payment${h.payment_failed === 1 ? "" : "s"}` : "",
      h.charged_back ? `${h.charged_back} charge-back${h.charged_back === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    parts.push(`A customer you know: ${h.completed} completed${broken.length ? `, ${broken.join(", ")}` : ""}.`);
  }
  for (const p of c.persons) {
    const host = p.network.replace(/^https:\/\//, "");
    const record = p.kept === 0 && p.broken === 0 ? "no record yet" : `${p.kept} kept, ${p.broken} broken`;
    const since = p.since ? `, known since ${p.since.slice(0, 7)}` : "";
    parts.push(
      `${p.tier} on ${host} (${record}${since}${p.seen === "earlier" ? `, as of ${p.as_of.slice(0, 10)}` : ""}).`,
    );
  }
  return parts.join(" ");
}

/** A stored person object, read leniently: a network's words are data, never trusted for shape. */
function personOf(network: string, raw: unknown, at: number, earlier: boolean): PersonView {
  const p = (typeof raw === "string" ? safeJson(raw) : null) as Record<string, unknown> | null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const tier = p?.tier === "building" || p?.tier === "trusted" ? p.tier : "new";
  const score = typeof p?.score === "number" && p.score >= 0 && p.score <= 1 ? p.score : 0;
  const since = typeof p?.since === "string" && Number.isFinite(Date.parse(p.since)) ? p.since : null;
  return {
    network,
    tier,
    score,
    kept: count(p?.kept),
    broken: count(p?.broken),
    businesses: count(p?.businesses),
    email_proven: p?.email_proven === true,
    since,
    unusual_use: p?.unusual_use === true,
    seen: earlier ? "earlier" : "this_item",
    as_of: new Date(Number.isFinite(at) ? at : 0).toISOString(),
  };
}

/**
 * The create's `rules` job, due at once: it waited `RULES_AFTER_ISSUANCE_MS` only so a first
 * contact's answers land before the rules read them (§8.1), and the request has just written them,
 * or found the networks not answering (the retry job asks again). Left 4 s ahead, it would miss the
 * one runner pass that follows the request on Workers (`waitUntil`) and wait for the next cron,
 * minutes later, where an owner's rule used to confirm a booking straight after the request (R18).
 */
function rulesDueNow(itemId: string, now: number): Statement {
  return {
    sql: `UPDATE jobs SET run_at = ? WHERE kind = 'rules' AND status = 'queued' AND run_at > ?
            AND dedupe_key = (SELECT 'rules:' || id FROM item_events WHERE item_id = ? AND seq = 1)`,
    params: [now, now, itemId],
    method: "run",
  };
}

/**
 * Who an `identity` block is for, and so which of the item's passes it may carry: its `creator`
 * (the access token, or the agent key the item was made with), someone recognised by a `presenter`'s
 * pass alone, or the `business` reading through a customer's door.
 */
export type PassAudience = "creator" | "presenter" | "business";

/** A create's answer goes to whoever made it: the customer, or the business itself. */
function audienceOf(caller: Caller): PassAudience {
  return isCustomer(caller) ? "creator" : "business";
}

/** The networks a first contact is asked of: switched on, and letting it issue. */
export function issuingNetworks(settings: Awaited<ReturnType<typeof readSettings>>): string[] {
  return Object.entries(settings.networks)
    .filter(([, n]) => n.enabled && n.issue)
    .map(([origin]) => origin)
    .sort();
}

/**
 * The trust tier a customer's request carries (§8.1): a platform-vouched agent — its platform
 * recognised by a network this inbox reports to, which the door decided — carrying a person a
 * network trusts is `reputed_principal`; any verified signature lifts an anonymous caller to
 * `signed_agent`; a key the owner issued stays `verified_principal`.
 */
export function tierOf(caller: Caller, agent: AgentSeen, presentations: readonly Presentation[]): TrustTier {
  if (agent.level === "vouched" && presentations.some((p) => p.person.tier === "trusted")) return "reputed_principal";
  if (caller.tier === "anonymous" && agent.level !== "none") return "signed_agent";
  return caller.tier;
}

function stateWord(state: string): string {
  switch (state) {
    case "issued":
      return "issued";
    case "exists":
      return "person_exists";
    case "asking":
    case "limited":
      return "pending";
    default:
      return state;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
