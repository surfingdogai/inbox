import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { ItemType } from "../domain/types";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { type Caller, isOwnerInPerson, isPerson } from "../write/caller";
import { WriteError } from "../write/errors";
import type { ItemSpamSummary } from "../write/views";
import { chipOf } from "./copy";
import { DISPOSABLE_MAIL, SHARED_MAIL_PROVIDERS } from "./data";
import {
  basicLearningUntil,
  closeWithdrawnStatements,
  endLearningStatement,
  filterStates,
  switchFilterStatements,
} from "./filters";
import { itemHandles, trustHandleStatements } from "./handles";
import type { JudgePort } from "./judge";
import {
  addToListStatements,
  type ListEntry,
  type ListKind,
  type ListName,
  listEntries,
  removeFromListStatement,
} from "./lists";
import { checksSoFar, countStatement, type SpamUsage, spamUsage } from "./meter";
import {
  isModelProvider,
  kitProblem,
  MODEL_PROVIDERS,
  type ModelCard,
  type ModelChoice,
  type ModelKit,
  type ModelProvider,
  type ModelTest,
  openKey,
  PROVIDER_NAMES,
  recordTest,
  removeModel,
  saveModel,
  storedModel,
  testModel,
} from "./model";
import { emailDomain, foldAddress, normalise, registrableDomain } from "./normalise";
import { prunePrintsStatement } from "./prints";
import { blockChoiceOf, createEventOf, releasedEffects, releaseScreenStatement, teachStatements } from "./release";
import {
  aiRoom,
  businessContext,
  type DoorContext,
  type DoorScreen,
  type JudgeOptions,
  namesOwnOffer,
  runScreenJob,
  type ScreenJobResult,
  type SpamDeps,
  type SpamHostPolicy,
  screenAtDoor,
  wordsOf,
} from "./screen";
import { dayOf, FILTERS, type Filter, type FilterChoice, isFilter } from "./types";

/**
 * The spam filter's capabilities (ADR-029): the door's screening, the job's, and what the owner does
 * with it — the filters, the lists, Let it in, Not spam, Spam. The host attaches the model it pays
 * for (hosted) or the owner's own (self-hosted), the DNS lookup, and its policy; without a model the
 * filters look for known phrases only, and the free protection works the same either way.
 */

/** How Settings says who reads with AI. */
export type Reader = "hosted_ai" | "hosted_phrases" | "own_model" | "no_model";

export interface SpamStatus {
  readonly basic: { readonly learning_until: string | null };
  readonly filters: readonly {
    readonly filter: Filter;
    readonly on: boolean;
    readonly choice: FilterChoice;
    readonly learning_until: string | null;
    /** Whether this inbox may switch it on (a host may offer fewer). */
    readonly allowed: boolean;
    readonly this_month: { readonly aside: number; readonly brought_back: number };
  }[];
  readonly reader: Reader;
  /** The model on one's own server, as the operator or the owner set it up. */
  readonly model: { readonly provider: string; readonly model: string; readonly set_by_server: boolean } | null;
  /** How Settings names who reads on a hosted inbox; null for the generic line. */
  readonly reader_name: string | null;
  readonly checks: {
    readonly today: number;
    readonly this_month: number;
    readonly day_cap: number | null;
    readonly month_cap: number | null;
    /** Until when the AI check rests because a cap was reached; null while it has room. */
    readonly resting_until: string | null;
    /** The model's tokens this month, read and written: what an owner's own key paid for. */
    readonly tokens_this_month: number;
  };
  readonly billing: {
    readonly state: "off" | "shadow" | "on" | "self_hosted";
    readonly price: { readonly currency: string; readonly per_filter_month_minor: number } | null;
  };
  readonly this_month: { readonly aside: number; readonly held: number; readonly brought_back: number };
  readonly held_now: number;
  /** Put aside in the last seven days, by anyone: the Spam list's "This week". */
  readonly this_week: { readonly aside: number };
  readonly lists: { readonly allow: readonly ListEntry[]; readonly block: readonly ListEntry[] };
  /** Whether this caller may change any of it: the owner or staff, signed in, in person. */
  readonly can_change: boolean;
}

/** The model on one's own server, for Settings: who provides it, which one, and who set it up. */
export interface ModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly setByServer: boolean;
}

export class SpamCapabilities implements SpamDeps {
  private port: JudgePort | null = null;
  private policy: SpamHostPolicy | null = null;
  private resolver: ((domain: string) => Promise<boolean | null>) | null = null;
  private modelInfo: ModelInfo | null = null;
  private judgeOptions: JudgeOptions = {};
  /** How the host reaches an owner's own model provider (own server only). */
  private kit: ModelKit | null = null;
  /** The owner's own model as last read, and the port made from it. */
  private own: { readonly setAt: number; readonly port: JudgePort; readonly info: ModelInfo } | null = null;

  constructor(
    readonly db: Db,
    readonly secrets: SecretBox | null,
  ) {}

  /**
   * What the host plugs in. `judge`: the model (hosted: its own, behind its caps; own server: the
   * operator's or the owner's); `host`: the hosted policy (absent on one's own server); `resolveMail`:
   * whether a mail domain takes mail at all.
   */
  attach(o: {
    readonly judge?: JudgePort | null | undefined;
    readonly host?: SpamHostPolicy | null | undefined;
    readonly resolveMail?: ((domain: string) => Promise<boolean | null>) | null | undefined;
    readonly model?: ModelInfo | null | undefined;
    /** How long a check may take: shorter in a test. */
    readonly judgeOptions?: JudgeOptions | undefined;
    /** How the owner's own model is reached, on their own server (Settings → Integrations → Your AI model). */
    readonly kit?: ModelKit | null | undefined;
  }): void {
    if (o.judgeOptions !== undefined) this.judgeOptions = o.judgeOptions;
    if (o.kit !== undefined) this.kit = o.kit;
    if (o.judge !== undefined) this.port = o.judge;
    if (o.host !== undefined) this.policy = o.host;
    if (o.resolveMail !== undefined) this.resolver = o.resolveMail;
    if (o.model !== undefined) this.modelInfo = o.model;
  }

  judge(): JudgePort | null {
    return this.port ?? this.own?.port ?? null;
  }

  /** Whether the owner may bring their own model: their own server, a key box, nothing set by the server. */
  private ownOffered(): boolean {
    return this.policy === null && this.port === null && this.kit !== null && this.secrets !== null;
  }

  /**
   * The owner's own model, read again when it changed (another isolate or process may have saved one):
   * one small read before each screening and each status.
   */
  private async refreshOwn(): Promise<void> {
    if (!this.ownOffered() || !this.kit || !this.secrets) {
      this.own = null;
      return;
    }
    const row = await storedModel(this.db).catch(() => null);
    if (!row) {
      this.own = null;
      return;
    }
    if (this.own?.setAt === row.setAt) return;
    try {
      const key = await openKey(this.secrets, row.keyEnc);
      this.own = {
        setAt: row.setAt,
        port: this.kit.judge({ provider: row.provider, model: row.model, key }),
        info: { provider: PROVIDER_NAMES[row.provider], model: row.model, setByServer: false },
      };
    } catch {
      // A key sealed under a secret this server no longer holds: as if none were set.
      this.own = null;
    }
  }

  host(): SpamHostPolicy | null {
    return this.policy;
  }

  resolveMail(): ((domain: string) => Promise<boolean | null>) | null {
    return this.resolver;
  }

  /**
   * Whether new messages may be read by the AI check now: a model to ask, a host that lets it read, and
   * a filter on. The business's privacy page says so while it is (ADR-029 §14).
   */
  async readsWithAi(now: number): Promise<boolean> {
    await this.refreshOwn();
    if (!this.judge() || (this.policy && !this.policy.ai)) return false;
    const allowed = this.policy ? new Set<string>(this.policy.filters) : null;
    for (const s of (await filterStates(this.db, now)).values())
      if (s.on && (!allowed || allowed.has(s.filter))) return true;
    return false;
  }

  /** Screens a create at its door (`createItem` calls this). */
  async atDoor(ctx: DoorContext): Promise<DoorScreen> {
    await this.refreshOwn();
    return screenAtDoor(this, ctx);
  }

  /** The `spam_screen` job. */
  async screen(input: {
    readonly itemId: string;
    readonly eventId: string;
    readonly now: number;
  }): Promise<ScreenJobResult> {
    await this.refreshOwn();
    return runScreenJob(this, input, this.judgeOptions);
  }

  /** The filters a host withdrew are switched off, as the system: run as the inbox starts. */
  async applyHost(now: number): Promise<void> {
    const host = this.policy;
    if (!host) return;
    const statements = await closeWithdrawnStatements(this.db, new Set(host.filters), now);
    if (statements.length) await this.db.batch(statements);
  }

  // ---- what the owner sees ----------------------------------------------------------------------

  async status(caller: Caller, now: number): Promise<SpamStatus> {
    await this.refreshOwn();
    const db = this.db;
    const states = await filterStates(db, now);
    const host = this.policy;
    const allowed = host ? new Set(host.filters) : new Set(FILTERS);
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const { rows: byCause } = await db.client.query({
      sql: `SELECT cause, SUM(CASE WHEN verdict = 'aside' THEN 1 ELSE 0 END), SUM(CASE WHEN owner_verdict = 'not_spam' THEN 1 ELSE 0 END)
              FROM spam_verdicts WHERE created_at >= ? GROUP BY cause`,
      params: [monthStart],
      method: "all",
    });
    const perCause = new Map(byCause.map((r) => [String(r[0]), { aside: Number(r[1] ?? 0), back: Number(r[2] ?? 0) }]));
    const usage = await spamUsage(db, { from: monthStart, to: now + 1 }, now);
    const so = await checksSoFar(db, now);
    const settings = await readSettings(db);
    const room = await aiRoom(this, settings, now);
    const dayCap = host ? host.dayCap : null;
    const monthCap = host ? host.monthCap : settings.spam.monthlyChecks > 0 ? settings.spam.monthlyChecks : null;
    const resting =
      room !== "capped"
        ? null
        : dayCap !== null && so.day >= dayCap && (monthCap === null || so.month < monthCap)
          ? new Date(
              Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1),
            ).toISOString()
          : new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)).toISOString();
    const { rows: heldRows } = await db.client.query({
      sql: "SELECT COUNT(*) FROM items WHERE screen = 'held'",
      params: [],
      method: "all",
    });
    const { rows: weekRows } = await db.client.query({
      sql: `SELECT COUNT(*) FROM items WHERE COALESCE(sandbox, 0) = 0 AND (state = 'spam' OR screen = 'aside')
              AND COALESCE(screen_at, closed_at, updated_at) >= ?`,
      params: [now - 7 * 86_400_000],
      method: "all",
    });
    const lists = await listEntries(db);
    const basic = await basicLearningUntil(db, now);
    const port = this.judge();
    const reader: Reader = host ? (host.ai && port ? "hosted_ai" : "hosted_phrases") : port ? "own_model" : "no_model";
    const modelInfo = this.port ? this.modelInfo : (this.own?.info ?? null);
    return {
      basic: { learning_until: basic ? new Date(basic).toISOString() : null },
      filters: FILTERS.map((filter) => {
        const s = states.get(filter);
        return {
          filter,
          on: s?.on === true && allowed.has(filter),
          choice: s?.choice ?? "aside",
          learning_until: s?.learningUntil ? new Date(s.learningUntil).toISOString() : null,
          allowed: allowed.has(filter),
          this_month: { aside: perCause.get(filter)?.aside ?? 0, brought_back: perCause.get(filter)?.back ?? 0 },
        };
      }),
      reader,
      model:
        !host && modelInfo
          ? {
              provider: modelInfo.provider,
              model: modelInfo.model,
              set_by_server: modelInfo.setByServer,
            }
          : null,
      reader_name: host?.reader ?? null,
      checks: {
        today: so.day,
        this_month: so.month,
        day_cap: dayCap,
        month_cap: monthCap,
        resting_until: resting,
        tokens_this_month: usage.tokens_in + usage.tokens_out,
      },
      billing: host
        ? {
            state: host.billing,
            price: host.price
              ? { currency: host.price.currency, per_filter_month_minor: host.price.perFilterMonthMinor }
              : null,
          }
        : { state: "self_hosted", price: null },
      this_month: { aside: usage.aside, held: usage.held, brought_back: usage.brought_back },
      held_now: Number(heldRows[0]?.[0] ?? 0),
      this_week: { aside: Number(weekRows[0]?.[0] ?? 0) },
      lists: { allow: lists.filter((l) => l.list === "allow"), block: lists.filter((l) => l.list === "block") },
      can_change: canChange(caller),
    };
  }

  /**
   * What the rows of a list say about the spam filter (ADR-029 §11.1): each one's chip, whether a
   * certain signal decided it, and whether it may be a customer after all — the AI check found one or
   * wasn't sure, it was held only for many new requests, or its words name something the business
   * offers and nothing certain held it. Those are listed first under Held.
   */
  async summaries(
    rows: readonly {
      readonly id: string;
      readonly screen: string | null;
      readonly type: string;
    }[],
  ): Promise<Map<string, ItemSpamSummary>> {
    const out = new Map<string, ItemSpamSummary>();
    if (rows.length === 0) return out;
    const marks = rows.map(() => "?").join(",");
    const ids = rows.map((r) => r.id);
    const { rows: found } = await this.db.client.query({
      sql: `SELECT item_id, verdict, cause, certain, answer, learning FROM spam_verdicts WHERE item_id IN (${marks})`,
      params: ids,
      method: "all",
    });
    const verdicts = new Map(found.map((r) => [String(r[0]), r]));
    const { rows: who } = await this.db.client.query({
      sql: `SELECT i.id, i.agent_thumbprint,
                   (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1)
              FROM items i WHERE i.id IN (${marks})`,
      params: ids,
      method: "all",
    });
    const senders = new Map(
      who.map((r) => {
        const address = r[2] === null || r[2] === undefined ? null : foldAddress(String(r[2]));
        const domain = address ? emailDomain(address) : null;
        const company = domain ? registrableDomain(domain) : null;
        return [
          String(r[0]),
          {
            address,
            company_domain:
              company && !SHARED_MAIL_PROVIDERS.has(company) && !DISPOSABLE_MAIL.has(company) ? company : null,
            app: !address && r[1] !== null && r[1] !== undefined,
          },
        ] as const;
      }),
    );
    const nobody = { address: null, company_domain: null, app: false } as const;
    // Words that name the business's own offer, for what was held on uncertain grounds.
    const unsure = rows.filter((r) => {
      const v = verdicts.get(r.id);
      return r.screen === "held" && v !== undefined && Number(v[3]) !== 1;
    });
    const named = new Set<string>();
    if (unsure.length > 0) {
      const business = await businessContext(this.db);
      const { rows: firsts } = await this.db.client.query({
        sql: `SELECT t.item_id, t.body_text, i.type, i.payload FROM thread_entries t JOIN items i ON i.id = t.item_id
               WHERE t.item_id IN (${unsure.map(() => "?").join(",")}) AND t.direction = 'in'
               ORDER BY t.created_at, t.id`,
        params: unsure.map((r) => r.id),
        method: "all",
      });
      const seen = new Set<string>();
      for (const f of firsts) {
        const id = String(f[0]);
        if (seen.has(id)) continue;
        seen.add(id);
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(f[3] ?? "{}")) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        const words = wordsOf(String(f[2]) as ItemType, payload, typeof f[1] === "string" ? f[1] : undefined).text;
        if (namesOwnOffer(normalise(words), business.offers)) named.add(id);
      }
    }
    for (const r of rows) {
      const v = verdicts.get(r.id);
      if (!v) {
        // A person put it aside: no chip, nothing to doubt.
        out.set(r.id, {
          screen: r.screen,
          chip: "",
          cause: null,
          may_be_customer: false,
          certain: false,
          sender: senders.get(r.id) ?? nobody,
        });
        continue;
      }
      const cause = v[2] === null || v[2] === undefined ? null : String(v[2]);
      const certain = Number(v[3]) === 1;
      const learning = Number(v[5]) === 1;
      type Answer = { readonly kind?: string; readonly customer_intent?: boolean };
      let answer: Answer | null = null;
      try {
        answer = v[4] ? (JSON.parse(String(v[4])) as Answer) : null;
      } catch {
        answer = null;
      }
      const warned = r.screen === "warned" || String(v[1]) === "warn";
      const doubts =
        answer !== null && (answer.kind === "customer" || answer.kind === "unclear" || answer.customer_intent === true);
      out.set(r.id, {
        screen: r.screen,
        chip: chipOf(learning ? "learning" : cause, warned),
        cause: learning ? "learning" : cause,
        may_be_customer: cause === "many_new" || (!certain && (doubts || named.has(r.id))),
        certain,
        sender: senders.get(r.id) ?? nobody,
      });
    }
    return out;
  }

  // ---- the owner's own AI model (own server) -----------------------------------------------------

  /** Settings → Integrations → Your AI model. */
  async modelCard(caller: Caller): Promise<ModelCard> {
    await this.refreshOwn();
    const row = this.ownOffered() ? await storedModel(this.db) : null;
    return {
      offered: this.ownOffered(),
      not_offered: this.policy ? "hosted" : this.port ? null : !this.secrets ? "no_secret" : null,
      set_by_server:
        this.port && !this.policy && this.modelInfo
          ? { provider: this.modelInfo.provider, model: this.modelInfo.model }
          : null,
      own: row
        ? {
            provider: row.provider,
            provider_name: PROVIDER_NAMES[row.provider],
            model: row.model,
            set_at: new Date(row.setAt).toISOString(),
            tested:
              row.testedAt !== null && row.test
                ? { at: new Date(row.testedAt).toISOString(), pitch: row.test.pitch, customer: row.test.customer }
                : null,
          }
        : null,
      providers: MODEL_PROVIDERS.map((id) => ({ id, name: PROVIDER_NAMES[id] })),
      can_change: canChange(caller) && this.ownOffered(),
    };
  }

  private requireOwnModel(caller: Caller): { kit: ModelKit; secrets: SecretBox } {
    requirePerson(caller);
    if (!this.ownOffered() || !this.kit || !this.secrets) {
      throw new WriteError(
        "not_allowed",
        this.policy
          ? "This inbox reads with its host's model; there is no key to add here."
          : this.port
            ? "Set by your server: nothing to change here."
            : "This server can't keep a key: set INBOX_SECRET_KEY first.",
        { details: { reason: this.policy ? "hosted" : this.port ? "set_by_server" : "no_secret" } },
      );
    }
    return { kit: this.kit, secrets: this.secrets };
  }

  /**
   * The provider's own list of models for a key the owner just pasted, or the one kept when none is
   * given for the same provider. The key is only used for the call: nothing is kept.
   */
  async listModels(
    caller: Caller,
    input: { readonly provider: string; readonly key?: string | undefined },
  ): Promise<{ readonly models: readonly ModelChoice[] }> {
    const { kit, secrets } = this.requireOwnModel(caller);
    const provider = providerOf(input.provider);
    const key = input.key?.trim() || (await this.keptKey(secrets, provider));
    try {
      return { models: await kit.models({ provider, key }) };
    } catch (error) {
      throw kitProblem(error, provider);
    }
  }

  /** Saves the owner's model: the key sealed, shown again to nobody. Without a key, the kept one stays. */
  async setModel(
    caller: Caller,
    input: { readonly provider: string; readonly model: string; readonly key?: string | undefined },
    now: number,
  ): Promise<ModelCard> {
    const { secrets } = this.requireOwnModel(caller);
    const provider = providerOf(input.provider);
    const model = input.model.trim();
    if (!model || model.length > 120) {
      throw new WriteError("invalid_input", "Choose a model from the list.", {
        fields: [{ path: "model", problem: "invalid", message: "Choose a model from the list." }],
      });
    }
    const key = input.key?.trim() || (await this.keptKey(secrets, provider));
    await saveModel(this.db, secrets, { provider, model, key, byUser: byUserOf(caller), now });
    this.own = null;
    return this.modelCard(caller);
  }

  /** Test: two samples through the model, as the filter would send them; what it found is kept. */
  async testOwnModel(caller: Caller, now: number): Promise<ModelTest> {
    this.requireOwnModel(caller);
    await this.refreshOwn();
    const port = this.own?.port;
    if (!port) throw new WriteError("wrong_state", "Save a model first, then test it.");
    const r = await testModel(port, await businessContext(this.db), this.judgeOptions);
    if (r.ok) await recordTest(this.db, { pitch: r.pitch, customer: r.customer }, now);
    return r;
  }

  /** Remove: the key is deleted, and the filters look for known phrases only again. */
  async removeOwnModel(caller: Caller): Promise<ModelCard> {
    this.requireOwnModel(caller);
    await removeModel(this.db);
    this.own = null;
    return this.modelCard(caller);
  }

  private async keptKey(secrets: SecretBox, provider: ModelProvider): Promise<string> {
    const row = await storedModel(this.db);
    if (!row || row.provider !== provider) {
      throw new WriteError("invalid_input", "Paste the key from your account.", {
        fields: [{ path: "key", problem: "missing", message: "Paste the key from your account." }],
      });
    }
    return openKey(secrets, row.keyEnc);
  }

  usage(range: { readonly from: number; readonly to: number }, now: number): Promise<SpamUsage> {
    return spamUsage(this.db, range, now);
  }

  // ---- what the owner changes, in person ---------------------------------------------------------

  /**
   * Switches a filter on or off, or changes what it does. Filters may carry a price: only the owner or
   * staff, signed in, in person, switch them — never their AI, a rule or a key.
   */
  async setFilter(
    caller: Caller,
    input: { readonly filter: string; readonly on: boolean; readonly choice?: FilterChoice | undefined },
    now: number,
  ): Promise<SpamStatus> {
    requirePerson(caller);
    if (!isFilter(input.filter)) {
      throw new WriteError("invalid_input", "filter is one of pitches, scams, junk", {
        fields: [{ path: "filter", problem: "invalid", message: "pitches, scams or junk" }],
      });
    }
    if (input.on && this.policy && !this.policy.filters.includes(input.filter)) {
      throw new WriteError("not_allowed", "This filter isn't offered on this inbox yet.", {
        details: { reason: "not_offered" },
      });
    }
    const statements = await switchFilterStatements(this.db, {
      filter: input.filter,
      on: input.on,
      choice: input.choice,
      byKind: caller.actor.kind,
      byId: caller.principal?.userId ?? caller.actor.id,
      now,
    });
    if (statements.length) await this.db.batch(statements);
    return this.status(caller, now);
  }

  /** "Start now": a filter, or the free protection, stops learning and starts putting aside. */
  async startNow(caller: Caller, input: { readonly filter: string }, now: number): Promise<SpamStatus> {
    requirePerson(caller);
    if (!isFilter(input.filter) && input.filter !== "basic") {
      throw new WriteError("invalid_input", "filter is one of basic, pitches, scams, junk");
    }
    await this.db.batch([endLearningStatement(input.filter as Filter | "basic", now)]);
    return this.status(caller, now);
  }

  /** Adds a sender to Always put aside: the owner's own choice, from an item. */
  async alwaysPutAside(caller: Caller, input: { readonly item_id: string }, now: number): Promise<{ added: boolean }> {
    requirePerson(caller);
    const choice = await blockChoiceOf(this.db, input.item_id);
    if (!choice) return { added: false };
    const party = await partyOf(this.db, input.item_id);
    await this.db.batch(
      addToListStatements({
        list: "block",
        kind: choice.kind,
        value: choice.value,
        partyId: party,
        itemId: input.item_id,
        byUser: byUserOf(caller),
        now,
      }),
    );
    return { added: true };
  }

  async removeListEntry(
    caller: Caller,
    input: { readonly list: string; readonly kind: string; readonly value: string },
  ): Promise<{ removed: boolean }> {
    requirePerson(caller);
    if (
      (input.list !== "allow" && input.list !== "block") ||
      !["address", "domain", "agent_key"].includes(input.kind)
    ) {
      throw new WriteError("invalid_input", "list is allow or block; kind is address, domain or agent_key");
    }
    const r = await this.db.client.query(
      removeFromListStatement(input.list as ListName, input.kind as ListKind, input.value),
    );
    return { removed: r.changes > 0 };
  }

  /** "Let everyone at {domain} through": a company's domain from an item a person let in. */
  async letDomainThrough(
    caller: Caller,
    input: { readonly domain: string; readonly item_id?: string | undefined },
    now: number,
  ): Promise<{ added: boolean }> {
    requirePerson(caller);
    const statements = addToListStatements({
      list: "allow",
      kind: "domain",
      value: input.domain,
      partyId: input.item_id ? await partyOf(this.db, input.item_id) : null,
      itemId: input.item_id ?? null,
      byUser: byUserOf(caller),
      now,
    });
    if (statements.length === 0) return { added: false };
    await this.db.batch(statements);
    return { added: true };
  }

  /**
   * Let it in: a held request goes on as if it had arrived now — the rules run, the webhooks go —
   * and the sender comes straight to the business from now on. A person only: the owner's AI never
   * releases anything. A booking whose time has passed is let in all the same, and said so.
   */
  async letIn(
    caller: Caller,
    input: { readonly item_id: string },
    now: number,
  ): Promise<{ released: boolean; time_passed: boolean }> {
    requirePerson(caller);
    const item = await this.screenOf(input.item_id);
    if (!item) throw new WriteError("not_found", "no such item");
    if (item.screen !== "held" && item.screen !== "pending" && !(item.screen === "aside" && item.state !== "spam")) {
      throw new WriteError(
        "wrong_state",
        "Only something held can be let in; Not spam brings back what was put aside.",
        {
          details: { screen: item.screen },
        },
      );
    }
    const eventId = await createEventOf(this.db, input.item_id);
    const statements: Statement[] = [releaseScreenStatement(input.item_id, ["held", "pending", "aside"], now)];
    if (eventId) {
      statements.push(
        {
          sql: `UPDATE jobs SET status = 'done', done_at = ?, last_error = 'let in', lease_until = NULL
                 WHERE dedupe_key IN (?, ?, ?, ?) AND status = 'queued'`,
          params: [now, `notify:${eventId}:owner`, `rules:${eventId}`, `rules:${eventId}:wait`, `fanout:${eventId}`],
          method: "run",
        },
        ...(await releasedEffects(this.db, {
          itemId: input.item_id,
          type: item.type,
          eventId,
          alertOwner: false,
          now,
        })),
      );
    }
    statements.push(
      ...(await teachStatements(this.db, this.secrets, {
        itemId: input.item_id,
        verdict: "let_in",
        byUser: byUserOf(caller),
        releasedBy: caller.actor.kind === "staff" ? "staff" : "owner",
        now,
      })),
      countStatement("released", now),
    );
    await this.db.batch(statements);
    const passed = item.type === "booking" && item.startAt !== null && Date.parse(item.startAt) <= now;
    return { released: true, time_passed: passed };
  }

  /** "Looks fine" on something delivered with a label: the label goes, and the sender is let through. */
  async looksFine(caller: Caller, input: { readonly item_id: string }, now: number): Promise<{ released: boolean }> {
    requirePerson(caller);
    const item = await this.screenOf(input.item_id);
    if (!item) throw new WriteError("not_found", "no such item");
    if (item.screen !== "warned") return { released: false };
    const statements: Statement[] = [
      releaseScreenStatement(input.item_id, ["warned"], now),
      {
        sql: "UPDATE items SET flags = json_remove(flags, '$.spamLabel'), version = version + 1, updated_at = ? WHERE id = ?",
        params: [now, input.item_id],
        method: "run",
      },
      ...(await teachStatements(this.db, this.secrets, {
        itemId: input.item_id,
        verdict: "looks_fine",
        byUser: byUserOf(caller),
        releasedBy: caller.actor.kind === "staff" ? "staff" : "owner",
        now,
      })),
    ];
    // The rules that could only flag it run again, now that a person said it is fine.
    const eventId = await createEventOf(this.db, input.item_id);
    if (eventId) {
      statements.push({
        sql: `INSERT OR IGNORE INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at)
              VALUES (?, 'rules', ?, ?, 'queued', 0, 8, ?, ?)`,
        params: [
          `${input.item_id}:fine`,
          JSON.stringify({ itemId: input.item_id, eventId, trigger: "item.created" }),
          now,
          `rules:${eventId}:released`,
          now,
        ],
        method: "run",
      });
    }
    await this.db.batch(statements);
    return { released: true };
  }

  /**
   * Spam, on something held (a booking or an order: they are never put aside on their own): it moves
   * from Held to Spam and lapses there by its own clock, telling nobody.
   */
  async markHeldSpam(
    caller: Caller,
    input: { readonly item_id: string },
    now: number,
  ): Promise<{ block: { kind: string; value: string } | null }> {
    requirePerson(caller);
    const item = await this.screenOf(input.item_id);
    if (!item) throw new WriteError("not_found", "no such item");
    if (item.screen !== "held" && item.screen !== "pending") {
      throw new WriteError("wrong_state", "Use Mark as spam on the item itself.", { details: { screen: item.screen } });
    }
    await this.db.batch([
      {
        sql: "UPDATE items SET screen = 'aside', screen_at = ? WHERE id = ? AND screen IN ('held', 'pending')",
        params: [now, input.item_id],
        method: "run",
      },
      ...(await teachStatements(this.db, this.secrets, {
        itemId: input.item_id,
        verdict: "spam",
        byUser: byUserOf(caller),
        releasedBy: null,
        now,
      })),
    ]);
    return { block: await blockChoiceOf(this.db, input.item_id) };
  }

  /**
   * After a person's Mark as spam or Not spam on an item (the message's and the quote's own
   * transitions): what they teach, and for Not spam on something the filter put aside, the effects it
   * held back — the rules and the webhooks, not the alert: the owner is looking at it.
   */
  async afterOwnerMark(caller: Caller, itemId: string, event: string, now: number): Promise<void> {
    if (!isPerson(caller)) return;
    if (event !== "mark_spam" && event !== "unspam") return;
    const item = await this.screenOf(itemId);
    if (!item) return;
    const statements: Statement[] = [
      ...(await teachStatements(this.db, this.secrets, {
        itemId,
        verdict: event === "mark_spam" ? "spam" : "not_spam",
        byUser: byUserOf(caller),
        releasedBy: event === "unspam" ? (caller.actor.kind === "staff" ? "staff" : "owner") : null,
        now,
      })),
    ];
    if (event === "unspam" && item.screen === "aside") {
      statements.push(releaseScreenStatement(itemId, ["aside"], now), countStatement("brought_back", now));
      const eventId = await createEventOf(this.db, itemId);
      if (eventId)
        statements.push(
          ...(await releasedEffects(this.db, { itemId, type: item.type, eventId, alertOwner: false, now })),
        );
    }
    await this.db.batch(statements);
  }

  /**
   * The sender pressed "Confirm it's me" in the email that acknowledged their request: their address
   * is proven, and their request goes on if it was held for an uncertain reason. What a bot did (a
   * hidden field, a form never drawn, a wave) stays where it is.
   */
  async confirmFromSender(itemId: string, now: number): Promise<"released" | "confirmed"> {
    const item = await this.screenOf(itemId);
    if (!item) return "confirmed";
    const handles = (await itemHandles(this.db, this.secrets, itemId)).handles.filter((h) => h.kind === "mailbox");
    const statements: Statement[] = [...trustHandleStatements(handles, "proven", now, item.partyId)];
    let released = false;
    if ((item.screen === "held" || item.screen === "pending") && !item.noProof) {
      released = true;
      statements.push(releaseScreenStatement(itemId, ["held", "pending"], now), countStatement("released", now));
      statements.push({
        sql: "UPDATE spam_verdicts SET released_by = 'sender' WHERE item_id = ? AND released_by IS NULL",
        params: [itemId],
        method: "run",
      });
      const eventId = await createEventOf(this.db, itemId);
      if (eventId) {
        statements.push({
          sql: `UPDATE jobs SET status = 'done', done_at = ?, last_error = 'confirmed', lease_until = NULL
                 WHERE dedupe_key IN (?, ?, ?, ?) AND status = 'queued'`,
          params: [now, `notify:${eventId}:owner`, `rules:${eventId}`, `rules:${eventId}:wait`, `fanout:${eventId}`],
          method: "run",
        });
        statements.push(
          ...(await releasedEffects(this.db, { itemId, type: item.type, eventId, alertOwner: true, now })),
        );
      }
    }
    if (statements.length) await this.db.batch(statements);
    return released ? "released" : "confirmed";
  }

  /** What the item screen of the owner app shows under "Why it's here". */
  async verdictOf(itemId: string): Promise<SpamVerdictView | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT verdict, cause, certain, score, signals, ai, answer, quotes, learning, owner_verdict, released_by, created_at, decided_at, door
              FROM spam_verdicts WHERE item_id = ?`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const json = (v: unknown) => {
      if (v === null || v === undefined) return null;
      try {
        return JSON.parse(String(v)) as unknown;
      } catch {
        return null;
      }
    };
    return {
      verdict: String(r[0]),
      cause: r[1] === null || r[1] === undefined ? null : String(r[1]),
      certain: Number(r[2]) === 1,
      score: Number(r[3]),
      signals: (json(r[4]) as SpamVerdictView["signals"]) ?? [],
      ai: String(r[5]),
      answer: json(r[6]) as SpamVerdictView["answer"],
      quotes: (json(r[7]) as string[] | null) ?? [],
      learning: Number(r[8]) === 1,
      owner_verdict: r[9] === null || r[9] === undefined ? null : String(r[9]),
      released_by: r[10] === null || r[10] === undefined ? null : String(r[10]),
      created_at: new Date(Number(r[11])).toISOString(),
      decided_at: r[12] === null || r[12] === undefined ? null : new Date(Number(r[12])).toISOString(),
      door: String(r[13]),
    };
  }

  /**
   * The daily housekeeping (`spam_daily`): prints and cached answers past their time, and — only when
   * the owner chose to keep what is put aside for 30 or 90 days — put-aside items older than that, with
   * their history, never one a person brought back; a bot's (a hidden field, a form never drawn) after
   * seven days whatever the choice.
   */
  async daily(now: number): Promise<{ readonly removed: number }> {
    const settings = await readSettings(this.db);
    await this.db.batch([
      prunePrintsStatement(now),
      { sql: "DELETE FROM spam_cache WHERE at < ?", params: [now - 7 * 86_400_000], method: "run" },
      { sql: "DELETE FROM spam_domains WHERE checked_at < ?", params: [now - 30 * 86_400_000], method: "run" },
    ]);
    const keep = settings.spam.keepDays;
    const { rows } = await this.db.client.query({
      sql: `SELECT i.id FROM items i JOIN spam_verdicts v ON v.item_id = i.id
             WHERE i.screen = 'aside' AND v.owner_verdict IS NULL
               AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.item_id = i.id)
               AND ((v.cause IN ('trap', 'no_key') AND i.created_at < ?) OR (? > 0 AND i.created_at < ?))
             LIMIT 200`,
      params: [now - 7 * 86_400_000, keep, now - keep * 86_400_000],
      method: "all",
    });
    const ids = rows.map((r) => String(r[0]));
    for (const id of ids) await this.db.batch(deleteItemStatements(id));
    return { removed: ids.length };
  }

  private async screenOf(itemId: string): Promise<{
    screen: string | null;
    type: string;
    state: string;
    partyId: string;
    startAt: string | null;
    noProof: boolean;
  } | null> {
    const { rows } = await this.db.client.query({
      sql: `SELECT i.screen, i.type, i.state, i.party_id, json_extract(i.payload, '$.startTime'),
                   COALESCE(v.certain, 0), v.cause
              FROM items i LEFT JOIN spam_verdicts v ON v.item_id = i.id WHERE i.id = ?`,
      params: [itemId],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    const cause = r[6] === null || r[6] === undefined ? null : String(r[6]);
    return {
      screen: r[0] === null || r[0] === undefined ? null : String(r[0]),
      type: String(r[1]),
      state: String(r[2]),
      partyId: String(r[3]),
      startAt: r[4] === null || r[4] === undefined ? null : String(r[4]),
      noProof:
        Number(r[5]) === 1 &&
        cause !== null &&
        ["trap", "no_key", "server_marked", "blocked", "wave", "like_marked"].includes(cause),
    };
  }
}

export interface SpamVerdictView {
  readonly verdict: string;
  readonly cause: string | null;
  readonly certain: boolean;
  readonly score: number;
  readonly signals: readonly { c: string; w: number; v?: number; f: string; x?: 1; d?: string }[];
  readonly ai: string;
  readonly answer: {
    kind: string;
    certainty: string;
    customer_intent: boolean;
    talks_to_filter: boolean;
    topic: string;
  } | null;
  readonly quotes: readonly string[];
  readonly learning: boolean;
  readonly owner_verdict: string | null;
  readonly released_by: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly door: string;
}

/** The owner or staff, signed in, in person: never their AI, a rule or a key handed to another system. */
export function canChange(caller: Caller): boolean {
  if (!isPerson(caller)) return false;
  const via = caller.principal?.via;
  if (caller.actor.kind === "owner") return isOwnerInPerson(caller);
  return via === undefined || via === "session" || via === "device";
}

function requirePerson(caller: Caller): void {
  if (!canChange(caller)) {
    throw new WriteError("not_allowed", "Only you can change this, signed in.", {
      details: { reason: "owner_in_person" },
    });
  }
}

function providerOf(value: string): ModelProvider {
  if (isModelProvider(value)) return value;
  throw new WriteError("invalid_input", "Choose Anthropic, OpenAI or Google Gemini.", {
    fields: [{ path: "provider", problem: "invalid", message: "Choose Anthropic, OpenAI or Google Gemini." }],
  });
}

function byUserOf(caller: Caller): string {
  return caller.principal?.userId ?? caller.actor.id;
}

async function partyOf(db: Db, itemId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT party_id FROM items WHERE id = ?",
    params: [itemId],
    method: "all",
  });
  const v = rows[0]?.[0];
  return v === undefined || v === null ? null : String(v);
}

/** Everything an item put aside holds, gone: its history, its conversation, its files, its print. */
function deleteItemStatements(id: string): Statement[] {
  const byItem = [
    "action_links",
    "blobs",
    "idempotency_keys",
    "reviews_outbox",
    "slot_claims",
    "search_fts",
    "item_presentations",
    "pending_identity",
    "customer_codes",
    "outbound_mail",
    "mail_refs",
    "item_offers",
    "offer_drafts",
    "connector_events",
    "connector_links",
    "connector_payments",
    "mail_tokens",
    "spam_prints",
    "spam_verdicts",
  ];
  return [
    {
      sql: "DELETE FROM mail_attachment_chunks WHERE attachment_id IN (SELECT id FROM mail_attachments WHERE item_id = ?)",
      params: [id],
      method: "run",
    },
    { sql: "DELETE FROM mail_attachments WHERE item_id = ?", params: [id], method: "run" },
    { sql: "DELETE FROM thread_entries WHERE item_id = ?", params: [id], method: "run" },
    { sql: "DELETE FROM item_events WHERE item_id = ?", params: [id], method: "run" },
    ...byItem.map((table) => ({ sql: `DELETE FROM ${table} WHERE item_id = ?`, params: [id], method: "run" as const })),
    { sql: "DELETE FROM items WHERE id = ? AND screen = 'aside'", params: [id], method: "run" },
  ];
}

export { dayOf };
