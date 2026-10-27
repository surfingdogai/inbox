import type { Statement } from "@surfingdog/platform";
import type { Db } from "../db";
import type { Contact, ItemFlags, ItemType } from "../domain/types";
import type { IdentityInput, MatchPlan } from "../identity/match";
import type { SecretBox } from "../secrets/box";
import { readSettings, type Settings } from "../settings/schema";
import { type Caller, isCustomer } from "../write/caller";
import { WriteError } from "../write/errors";
import { SHARED_MAIL_PROVIDERS } from "./data";
import { answerSignals, type Decision, decide } from "./decide";
import { basicLearningUntil, type FilterState, filterStates } from "./filters";
import { checkBudgets, countFirstStatements, handlesOf, type SenderHandles, standingOf } from "./handles";
import { buildPrompt, type JudgeMessage, type JudgePort, lendAnswer, runJudge } from "./judge";
import { listOf } from "./lists";
import { judgeText } from "./mask";
import { checksSoFar, countStatement } from "./meter";
import { emailDomain, hostOf, linkDomains, normalise, registrableDomain } from "./normalise";
import { asksBankChange, isGibberish, phraseHits } from "./phrases";
import { hamming, NEAR_BITS, NO_REPEATS, type Print, printOf, printStatement, repeatsOf, sha256Hex } from "./prints";
import { agentSignals } from "./signals/agent";
import { contentSignals, looksLike, PROVIDER_DOMAINS } from "./signals/content";
import { emailSignals } from "./signals/email";
import { formSignals } from "./signals/form";
import {
  type AiOutcome,
  type CheckedAnswer,
  type Door,
  type Filter,
  type FilterChoice,
  SCREEN_DEADLINE_MS,
  SCREEN_OF,
  SCREENED_TYPES,
  type Screen,
  type ScreenInput,
  type Signal,
  type Source,
  type Verdict,
} from "./types";

/**
 * The spam filter's door (ADR-029 §4): what a stranger's new request is, decided as it is written.
 * What can be decided at once is: certain signals, budgets, everything local, a cached AI answer.
 * Only what waits on another server — the AI check, a mail domain's DNS — makes the item `pending`,
 * and then every effect of the create is written with a deadline, so if the screening never finishes
 * the request arrives anyway. The doors pass facts; this decides.
 */

/** How a host runs the filter: whether its AI may be used, which filters an inbox may switch on, its caps. */
export interface SpamHostPolicy {
  readonly ai: boolean;
  readonly filters: readonly Filter[];
  readonly dayCap: number;
  readonly monthCap: number;
  /** How Settings names who reads; null for the generic line. */
  readonly reader: string | null;
  readonly billing: "off" | "shadow" | "on";
  readonly price: { readonly currency: string; readonly perFilterMonthMinor: number } | null;
}

/** What the filter is plugged into: the database, the secret box, and what the host attached. */
export interface SpamDeps {
  readonly db: Db;
  readonly secrets: SecretBox | null;
  judge(): JudgePort | null;
  host(): SpamHostPolicy | null;
  resolveMail(): ((domain: string) => Promise<boolean | null>) | null;
}

/** What a create hands the filter. */
export interface DoorContext {
  readonly caller: Caller;
  readonly type: ItemType;
  readonly screen: ScreenInput;
  readonly contact?: Contact | undefined;
  readonly message?: string | undefined;
  readonly subject?: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly match: MatchPlan;
  readonly identity?: IdentityInput | undefined;
  readonly sandbox: boolean;
  readonly now: number;
}

/** What the filter decided at the door, for the create to write in its batch. */
export interface DoorScreen {
  /** `items.screen`; null when the request was never screened (a sender the business knows). */
  readonly screen: Screen | null;
  readonly verdict: Verdict | "pending" | null;
  readonly decision: Decision | null;
  /** Flags the item takes: a person needed, and the label, for a delivered-with-a-label item. */
  readonly flags: Partial<ItemFlags>;
  /** No acknowledgement goes to the sender (a certain bot signal: nothing to prove, nobody to tell). */
  readonly noAck: boolean;
  /** The verdict row, the print, the handles' counts and the day's counters: written with the item. */
  readonly statements: (itemId: string) => Statement[];
}

const NOT_SCREENED: DoorScreen = {
  screen: null,
  verdict: null,
  decision: null,
  flags: {},
  noAck: false,
  statements: () => [],
};

/** The words a request carries, by its type: what is printed, matched and judged. */
export function wordsOf(
  type: ItemType,
  payload: Record<string, unknown>,
  message: string | undefined,
): { text: string; note: boolean } {
  const notes = typeof payload.notes === "string" ? payload.notes : "";
  switch (type) {
    case "message":
      return { text: String(payload.text ?? ""), note: false };
    case "quote_request": {
      const offered = (payload.itemOffered as { name?: string } | undefined)?.name ?? "";
      const description = String(payload.description ?? "");
      return { text: description.startsWith(offered) ? description : `${offered}\n${description}`.trim(), note: false };
    }
    default:
      return {
        text: [notes, message ?? ""]
          .filter((t) => t.trim())
          .join("\n")
          .trim(),
        note: true,
      };
  }
}

/** The business as the filter knows it: its name, what it does and offers, its own domains. */
export interface BusinessContext {
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly offers: readonly string[];
  readonly ownDomains: readonly string[];
  readonly providerDomains: readonly string[];
  readonly settings: Settings;
}

export async function businessContext(db: Db, settings?: Settings): Promise<BusinessContext> {
  const s = settings ?? (await readSettings(db));
  const { rows: b } = await db.client.query({
    sql: "SELECT name, domain, languages FROM business LIMIT 1",
    params: [],
    method: "all",
  });
  const name = String(b[0]?.[0] ?? "") || s.business.name;
  const languages = (() => {
    try {
      const v = JSON.parse(String(b[0]?.[2] ?? "null"));
      return Array.isArray(v) && v.length ? v.map(String) : s.business.languages;
    } catch {
      return s.business.languages;
    }
  })();
  const { rows: offered } = await db.client.query({
    sql: `SELECT name FROM (SELECT name, 0 AS k FROM services WHERE active = 1
                            UNION ALL SELECT name, 1 AS k FROM products WHERE active = 1) ORDER BY k LIMIT 30`,
    params: [],
    method: "all",
  });
  const { rows: linked } = await db.client.query({
    sql: "SELECT DISTINCT kind FROM connectors WHERE status <> 'disabled'",
    params: [],
    method: "all",
  });
  const domains = [
    b[0]?.[1] ? String(b[0][1]) : null,
    s.directory.url ? hostOf(s.directory.url) : null,
    emailDomain(s.email.fromAddress),
    emailDomain(s.email.replyTo),
    emailDomain(s.notifications.ownerEmail),
  ]
    .filter((d): d is string => Boolean(d))
    .map(registrableDomain)
    .filter((d) => !SHARED_MAIL_PROVIDERS.has(d));
  return {
    name,
    description: s.directory.description,
    languages,
    offers: offered.map((r) => String(r[0])),
    ownDomains: [...new Set(domains)],
    providerDomains: linked.flatMap((r) => PROVIDER_DOMAINS[String(r[0])] ?? []),
    settings: s,
  };
}

/** Whether the words name one of the business's own services or products: then they may be a customer's. */
export function namesOwnOffer(normalised: string, offers: readonly string[]): boolean {
  const plain = stripMarks(normalised);
  return offers.some((o) => {
    const name = stripMarks(normalise(o));
    return name.length >= 3 && plain.includes(name);
  });
}

function stripMarks(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * Whether the business already knows this sender: a strong match with a party the business acted
 * on — answered, confirmed, let in or said was not spam. Ignoring someone makes nobody known.
 */
export async function businessActed(db: Db, partyId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: `SELECT 1 FROM items i
           WHERE (i.party_id = ? OR i.party_id IN (SELECT merged_into FROM parties WHERE id = ? AND merged_into IS NOT NULL)
                  OR i.party_id IN (SELECT id FROM parties WHERE merged_into = ?))
             AND (EXISTS (SELECT 1 FROM thread_entries t WHERE t.item_id = i.id AND t.direction = 'out')
               OR EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id
                            AND e.actor_kind IN ('owner', 'staff', 'owner_ai', 'rule', 'integration', 'connector')
                            AND e.event NOT IN ('flags', 'rule_skipped'))
               OR EXISTS (SELECT 1 FROM spam_verdicts v WHERE v.item_id = i.id
                            AND v.owner_verdict IN ('not_spam', 'let_in', 'looks_fine')))
           LIMIT 1`,
    params: [partyId, partyId, partyId],
    method: "all",
  });
  return rows.length > 0;
}

/** The filters on, and what each does; who reads with AI. */
interface Running {
  readonly states: Map<Filter, FilterState>;
  readonly on: Set<Filter>;
  readonly choices: Map<Filter, FilterChoice>;
  readonly learning: Set<Source>;
}

async function running(deps: SpamDeps, now: number): Promise<Running> {
  const states = await filterStates(deps.db, now);
  const host = deps.host();
  const allowed = host ? new Set(host.filters) : null;
  const on = new Set<Filter>();
  const choices = new Map<Filter, FilterChoice>();
  const learning = new Set<Source>();
  for (const [filter, s] of states) {
    if (!s.on || (allowed && !allowed.has(filter))) continue;
    on.add(filter);
    choices.set(filter, s.choice);
    if (s.learningUntil !== null) learning.add(filter);
  }
  if ((await basicLearningUntil(deps.db, now)) !== null) learning.add("basic");
  return { states, on, choices, learning };
}

/** Whether an AI check may run now for this inbox, and why not. */
export async function aiRoom(deps: SpamDeps, settings: Settings, now: number): Promise<"room" | "none" | "capped"> {
  const judge = deps.judge();
  const host = deps.host();
  if (!judge) return "none";
  if (host && !host.ai) return "none";
  const so = await checksSoFar(deps.db, now);
  if (host) {
    if (so.day >= host.dayCap || so.month >= host.monthCap) return "capped";
    return "room";
  }
  const month = settings.spam.monthlyChecks;
  if (month > 0 && so.month >= month) return "capped";
  return "room";
}

const DOOR_WORDS: Readonly<Record<Door, JudgeMessage["door"]>> = {
  form: "website form",
  site_form: "website form",
  email: "email",
  agent: "AI agent door",
};

const KIND_WORDS: Readonly<Record<string, JudgeMessage["kind"]>> = {
  message: "message",
  quote_request: "quote request",
  booking: "booking note",
  order: "order note",
};

/** A cached AI answer for the same words in the last week: a mass mailing costs one check. */
async function cachedAnswer(db: Db, sha: string, now: number): Promise<CheckedAnswer | null> {
  const { rows } = await db.client.query({
    sql: "SELECT answer FROM spam_cache WHERE sha = ? AND at >= ?",
    params: [sha, now - 7 * 86_400_000],
    method: "all",
  });
  const raw = rows[0]?.[0];
  if (raw === undefined || raw === null) return null;
  try {
    return JSON.parse(String(raw)) as CheckedAnswer;
  } catch {
    return null;
  }
}

/**
 * An answer already given this week for this very text, or — so that a reworded mass mailing costs a
 * few AI checks, not one per copy — for a text a few words from it that another sender sent. Only an
 * answer that found no customer in it is lent to a near text, with only the quotes this text holds:
 * a customer's words sent first can never vouch for a pitch that copies them.
 */
async function reusableAnswer(
  db: Db,
  o: { readonly print: Print; readonly sender: string | null; readonly text: string; readonly now: number },
): Promise<CheckedAnswer | null> {
  const exact = await cachedAnswer(db, o.print.sha, o.now);
  if (exact) return exact;
  if (!o.print.substantial) return null;
  const since = o.now - 7 * 86_400_000;
  const { rows } = await db.client.query({
    sql: `SELECT p.sim, c.answer FROM spam_prints p JOIN spam_cache c ON c.sha = p.sha
           WHERE p.at >= ? AND c.at >= ? AND p.sender <> ?
             AND (p.b0 = ? OR p.b1 = ? OR p.b2 = ? OR p.b3 = ? OR p.b4 = ? OR p.b5 = ? OR p.b6 = ? OR p.b7 = ?)
           ORDER BY p.at DESC LIMIT 100`,
    params: [since, since, o.sender ?? "", ...o.print.bands],
    method: "all",
  });
  for (const r of rows) {
    if (hamming(String(r[0]), o.print.sim) > NEAR_BITS) continue;
    let answer: CheckedAnswer;
    try {
      answer = JSON.parse(String(r[1])) as CheckedAnswer;
    } catch {
      continue;
    }
    if (answer.kind === "customer" || answer.kind === "unclear" || answer.customerIntent) continue;
    return lendAnswer(answer, o.text);
  }
  return null;
}

/** Who sent an item, as its print names them. */
async function printSenderOf(db: Db, itemId: string): Promise<string | null> {
  const { rows } = await db.client.query({
    sql: "SELECT sender FROM spam_prints WHERE item_id = ?",
    params: [itemId],
    method: "all",
  });
  const v = rows[0]?.[0];
  return v === undefined || v === null ? null : String(v);
}

/** Whether a mail domain takes mail, as checked within thirty days; null when not known. */
async function cachedMail(db: Db, domain: string, now: number): Promise<boolean | null> {
  const { rows } = await db.client.query({
    sql: "SELECT mail FROM spam_domains WHERE domain = ? AND checked_at >= ?",
    params: [domain, now - 30 * 86_400_000],
    method: "all",
  });
  const v = rows[0]?.[0];
  return v === undefined || v === null ? null : Number(v) === 1;
}

/** Everything a screening reads, for the door and again for the job. */
interface Reading {
  readonly text: string;
  readonly note: boolean;
  readonly normalised: string;
  readonly print: Print | null;
  readonly domains: readonly string[];
  readonly email: string | undefined;
}

async function readingOf(
  type: ItemType,
  payload: Record<string, unknown>,
  message: string | undefined,
  subject: string | undefined,
  contact: Contact | undefined,
  html?: string,
): Promise<Reading> {
  const words = wordsOf(type, payload, message);
  const text =
    type === "message" && subject && !words.text.includes(subject) ? `${subject}\n${words.text}` : words.text;
  const normalised = normalise(text);
  return {
    text,
    note: words.note,
    normalised,
    print: normalised ? await printOf(normalised) : null,
    domains: linkDomains(text, html),
    email: contact?.email,
  };
}

/** The phrase signals of the filters that are on. */
function phraseSignals(normalised: string, raw: string, on: ReadonlySet<Filter>): Signal[] {
  const out: Signal[] = [];
  const hits = phraseHits(normalised, on);
  const pitches = hits.filter((h) => h.filter === "pitches").length;
  if (pitches > 0) out.push({ c: "pitch_phrases", w: pitches >= 2 ? 3 : 2, f: "pitches" });
  if (hits.some((h) => h.filter === "scams")) out.push({ c: "scam_phrases", w: 3, f: "scams" });
  if (on.has("junk") && isGibberish(raw.normalize("NFKC").toLowerCase())) out.push({ c: "gibberish", w: 3, f: "junk" });
  return out;
}

/** Security checks that point at a third party: what even a known sender gets, as a label only. */
function securitySignals(
  door: ScreenInput,
  reading: Reading,
  business: BusinessContext,
  on: ReadonlySet<Filter>,
): Signal[] {
  const out: Signal[] = [];
  if (door.email?.serverMarked) out.push({ c: "server_marked", w: 6, f: "basic" });
  const content = contentSignals({
    text: reading.text,
    html: door.email?.html,
    email: undefined,
    ownDomains: business.ownDomains,
    providerDomains: business.providerDomains,
    linkDomains: reading.domains,
    repeats: NO_REPEATS,
  });
  for (const s of content) if (s.c === "lookalike" || s.c === "link_mismatch" || s.c === "link_disguised") out.push(s);
  if (on.has("scams") && asksBankChange(reading.normalised)) out.push({ c: "bank_change_known", w: 3, f: "scams" });
  return out;
}

export async function screenAtDoor(deps: SpamDeps, ctx: DoorContext): Promise<DoorScreen> {
  if (!isCustomer(ctx.caller) || !SCREENED_TYPES.has(ctx.type)) return NOT_SCREENED;
  const db = deps.db;
  const now = ctx.now;
  const settings = await readSettings(db);
  const business = await businessContext(db, settings);
  const run = await running(deps, now);
  const reading = await readingOf(ctx.type, ctx.payload, ctx.message, ctx.subject, ctx.contact, ctx.screen.email?.html);
  const agent = ctx.identity?.agent ?? ctx.caller.agent;
  const passes = (ctx.identity?.presentations ?? []).map((p) => ({ network: p.network, ppid: p.ppid }));
  const sender = await handlesOf(deps.secrets, {
    email: reading.email,
    agent,
    passes,
    carriedFor: ctx.caller.carriedFor,
  });
  const listed = await listOf(db, { email: reading.email, thumbprint: agent?.thumbprint });
  const standing = await standingOf(db, sender.handles, now);
  const strong = ctx.match.match === "strong" && ctx.match.joinPartyId !== undefined;
  const known =
    ctx.caller.tier === "reputed_principal" ||
    listed === "allow" ||
    standing.trusted ||
    (strong && (await businessActed(db, ctx.match.joinPartyId as string)));

  // A sender the business knows is never screened: only what points at a third party is checked,
  // and it can only label ("Confirm by phone before paying"): a hijacked mailbox is flagged and seen.
  if (known && listed !== "block") {
    const security = securitySignals(ctx.screen, reading, business, run.on);
    if (security.length === 0) return NOT_SCREENED;
    const decision = decide({ type: ctx.type, signals: security, trusted: true });
    const label = security.some((s) => s.c === "bank_change_known")
      ? "bank_change_known"
      : (decision.label ?? security[0]?.c ?? "basic");
    return verdictRow(ctx, { ...decision, verdict: "warn", label }, security, {
      ai: "none",
      learning: false,
      known: true,
    });
  }

  const signals: Signal[] = [];
  if (listed === "block") signals.push({ c: "blocked", w: 6, f: "basic", x: 1 });
  const fields = { name: ctx.contact?.name, texts: [reading.text, ctx.contact?.name ?? ""] };
  if (ctx.screen.form) signals.push(...formSignals(ctx.screen.door, ctx.screen.form, fields, now));
  if (ctx.screen.email && reading.email) {
    signals.push(
      ...emailSignals(
        { ...ctx.screen.email, displayName: ctx.screen.email.displayName ?? ctx.contact?.name },
        reading.email,
        { name: business.name, domains: business.ownDomains },
      ),
    );
  }
  // Repeats count senders nobody vouches for: a network's pass or a vouched platform's key speaks for
  // its person, and many people's assistants write a booking the same way.
  const vouchedFor =
    (ctx.screen.door === "agent" && passes.length > 0) || (ctx.screen.door === "agent" && sender.vouched);
  const found =
    reading.print && sender.first && !vouchedFor
      ? await repeatsOf(db, { print: reading.print, sender: sender.first.ref, domains: reading.domains, now })
      : NO_REPEATS;
  // The same words in a booking or an order note are a person's request said the usual way: they
  // count as points there, never as a wave on their own.
  const repeats = ctx.type === "booking" || ctx.type === "order" ? { ...found, same: Math.min(found.same, 3) } : found;
  const mailDomain = emailDomain(reading.email);
  const noMail =
    mailDomain && !SHARED_MAIL_PROVIDERS.has(mailDomain)
      ? await cachedMail(db, mailDomain, now).then((v) => (v === null ? null : !v))
      : null;
  signals.push(
    ...contentSignals({
      text: reading.text,
      html: ctx.screen.email?.html,
      email: reading.email,
      ownDomains: business.ownDomains,
      providerDomains: business.providerDomains,
      linkDomains: reading.domains,
      repeats,
      noMail,
    }),
  );
  // Budgets, for strangers: past a day's budget the request waits; past a ceiling an agent comes back later.
  const pass = ctx.screen.door === "agent" && passes.length > 0;
  const budget = checkBudgets(sender, standing, { pass });
  if (budget.ceiling && ctx.screen.door === "agent") {
    throw new WriteError("too_many_requests", tooManyWords(ctx.caller.locale ?? ctx.contact?.locale), {
      details: { retry_after_s: 3_600 },
    });
  }
  signals.push(...agentSignals({ pass, vouched: ctx.screen.door === "agent" && sender.vouched, over: budget.over }));
  signals.push(...phraseSignals(reading.normalised, reading.text, run.on));
  const veto = namesOwnOffer(reading.normalised, business.offers);

  // The AI check: a stranger's first contact, with a filter on, no certain signal, enough words, room left.
  let ai: AiOutcome = "none";
  let answer: CheckedAnswer | null = null;
  const certain = signals.some((s) => s.x === 1);
  const enough = reading.note ? reading.text.length >= 20 : reading.text.length >= 20 || reading.domains.length > 0;
  let pending = false;
  if (run.on.size > 0 && !certain && enough && !ctx.sandbox) {
    const room = await aiRoom(deps, settings, now);
    if (room === "room") {
      const cached = reading.print
        ? await reusableAnswer(db, {
            print: reading.print,
            sender: sender.first?.ref ?? null,
            text: judgeText(reading.text),
            now,
          })
        : null;
      if (cached) {
        ai = "reused";
        answer = cached;
        signals.push(...answerSignals(cached, run.on));
      } else pending = true;
    } else if (room === "capped") ai = "capped";
    else ai = "skipped";
  }
  // A mail domain nobody looked up yet is looked up with the AI check, never alone.
  if (pending) {
    const score = signals.reduce((n, s) => n + s.w, 0);
    return pendingRow(ctx, signals, score, reading, sender);
  }
  const decision = decide({
    type: ctx.type,
    signals,
    veto: veto || answer?.customerIntent === true,
    choices: run.choices,
    learning: run.learning,
    answer,
  });
  return verdictRow(ctx, decision, signals, { ai, learning: decision.learning, reading, sender, answer, known: false });
}

/** "We have had many new requests from you. Please try again later." in the sender's language. */
export function tooManyWords(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith("pt")
    ? "Recebemos muitos pedidos novos seus. Por favor, tente mais tarde."
    : "We have had many new requests from you. Please try again later.";
}

function pendingRow(
  ctx: DoorContext,
  signals: readonly Signal[],
  score: number,
  reading: Reading,
  sender: SenderHandles,
): DoorScreen {
  return {
    screen: "pending",
    verdict: "pending",
    decision: null,
    flags: {},
    noAck: false,
    statements: (itemId) => [
      {
        sql: `INSERT OR IGNORE INTO spam_verdicts (item_id, door, verdict, cause, certain, score, signals, ai, learning, created_at)
              VALUES (?, ?, 'pending', NULL, 0, ?, ?, 'none', 0, ?)`,
        params: [itemId, ctx.screen.door, Math.round(score * 10) / 10, JSON.stringify(signals), ctx.now],
        method: "run",
      },
      ...strangerStatements(itemId, ctx, reading, sender),
    ],
  };
}

function strangerStatements(itemId: string, ctx: DoorContext, reading: Reading, sender: SenderHandles): Statement[] {
  const out: Statement[] = [];
  if (reading.print && sender.first) {
    out.push(
      printStatement({
        itemId,
        sender: sender.first.ref,
        print: reading.print,
        domains: reading.domains,
        now: ctx.now,
      }),
    );
  }
  out.push(...countFirstStatements(sender.handles, ctx.now));
  return out;
}

function verdictRow(
  ctx: DoorContext,
  decision: Decision,
  signals: readonly Signal[],
  o: {
    readonly ai: AiOutcome;
    readonly learning: boolean;
    readonly known: boolean;
    readonly reading?: Reading;
    readonly sender?: SenderHandles;
    readonly answer?: CheckedAnswer | null;
  },
): DoorScreen {
  const verdict = decision.verdict;
  const screen = SCREEN_OF[verdict];
  const flags: Partial<ItemFlags> =
    verdict === "warn"
      ? {
          needsHuman: true,
          spamLabel: decision.label ?? "basic",
          ...(signals.some((s) => s.c === "talks_to_filter") || o.answer?.talksToFilter
            ? { untrustedInstructions: true }
            : {}),
        }
      : signals.some((s) => s.c === "talks_to_filter") || o.answer?.talksToFilter
        ? { untrustedInstructions: true }
        : {};
  const counter = verdict === "aside" ? "aside" : verdict === "hold" ? "held" : verdict === "warn" ? "warned" : null;
  return {
    screen,
    verdict,
    decision,
    flags,
    noAck: decision.noProof,
    statements: (itemId) => [
      {
        sql: `INSERT OR IGNORE INTO spam_verdicts (item_id, door, verdict, cause, certain, score, signals, ai, answer, quotes, learning, created_at, decided_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          itemId,
          ctx.screen.door,
          verdict,
          decision.cause,
          decision.certain ? 1 : 0,
          decision.score,
          JSON.stringify(signals),
          o.ai,
          o.answer
            ? JSON.stringify({
                kind: o.answer.kind,
                certainty: o.answer.certainty,
                customer_intent: o.answer.customerIntent,
                talks_to_filter: o.answer.talksToFilter,
                topic: o.answer.topic,
              })
            : null,
          o.answer?.quotes.length ? JSON.stringify(o.answer.quotes) : null,
          o.learning ? 1 : 0,
          ctx.now,
          ctx.now,
        ],
        method: "run",
      },
      ...(o.reading && o.sender ? strangerStatements(itemId, ctx, o.reading, o.sender) : []),
      ...(counter ? [countStatement(counter, ctx.now)] : []),
      ...(o.ai === "reused" ? [countStatement("reused", ctx.now)] : []),
      ...(o.ai === "capped" ? [countStatement("capped", ctx.now)] : []),
    ],
  };
}

// ---- the job ---------------------------------------------------------------------------------

export const SPAM_SCREEN_KIND = "spam_screen";

/** The dedupe keys of a create's effects: what the screening pulls forward or cancels. */
export function effectKeys(eventId: string): { readonly owner: string[]; readonly customer: string[] } {
  return {
    owner: [`notify:${eventId}:owner`, `rules:${eventId}`, `rules:${eventId}:wait`, `fanout:${eventId}`],
    customer: [`notify:${eventId}:customer`],
  };
}

/** Moves the create's effects to run now (deliver, warn): the screening is done. */
export function pullForwardStatement(eventId: string, now: number): Statement {
  const keys = effectKeys(eventId).owner;
  return {
    sql: `UPDATE jobs SET run_at = ? WHERE dedupe_key IN (${keys.map(() => "?").join(", ")}) AND status = 'queued' AND run_at > ?`,
    params: [now, ...keys, now],
    method: "run",
  };
}

/** Cancels the create's effects (hold: the owner's alert, the rules, the webhooks; aside: the acknowledgement too). */
export function cancelEffectsStatement(eventId: string, now: number, withAck: boolean): Statement {
  const keys = [...effectKeys(eventId).owner, ...(withAck ? effectKeys(eventId).customer : [])];
  return {
    sql: `UPDATE jobs SET status = 'done', done_at = ?, last_error = 'screened', lease_until = NULL
           WHERE dedupe_key IN (${keys.map(() => "?").join(", ")}) AND status = 'queued'`,
    params: [now, ...keys],
    method: "run",
  };
}

/** Whether the owner's alert for this create already went (its deadline passed): then a late verdict only labels. */
async function ownerAlerted(db: Db, eventId: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT status, COALESCE(last_error, '') FROM jobs WHERE dedupe_key = ?",
    params: [`notify:${eventId}:owner`],
    method: "all",
  });
  const r = rows[0];
  // Only an alert that went: one claimed in this same run waits behind the screening, and reads its verdict.
  return r !== undefined && r[0] === "done" && r[1] !== "screened";
}

/** What the job needs from the stored item to screen it as the door would have. */
async function storedItem(db: Db, itemId: string) {
  const { rows } = await db.client.query({
    sql: `SELECT i.type, i.payload, i.subject, i.channel, i.created_at, i.screen, i.version, i.state,
                 (SELECT body_text FROM thread_entries t WHERE t.item_id = i.id AND t.direction = 'in' ORDER BY t.created_at LIMIT 1),
                 (SELECT value FROM party_contacts c WHERE c.party_id = i.party_id AND c.kind = 'email' ORDER BY c.created_at LIMIT 1),
                 p.display_name,
                 (SELECT COUNT(*) FROM mail_attachments a WHERE a.item_id = i.id)
            FROM items i LEFT JOIN parties p ON p.id = i.party_id WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(r[1] ?? "{}")) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    type: String(r[0]) as ItemType,
    payload,
    subject: r[2] === null || r[2] === undefined ? undefined : String(r[2]),
    channel: String(r[3]),
    createdAt: Number(r[4]),
    screen: r[5] === null || r[5] === undefined ? null : String(r[5]),
    version: Number(r[6]),
    state: String(r[7]),
    firstMessage: r[8] === null || r[8] === undefined ? undefined : String(r[8]),
    email: r[9] === null || r[9] === undefined ? undefined : String(r[9]),
    displayName: r[10] === null || r[10] === undefined ? null : String(r[10]),
    attachments: Number(r[11] ?? 0),
  };
}

/** How long the AI check may take, and how it waits: shorter in a test. */
export interface JudgeOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly limits?: { readonly attemptMs: number; readonly retryAfterMs: number; readonly totalMs: number };
}

export interface ScreenJobResult {
  readonly note: string;
  readonly verdict: Verdict | null;
}

/**
 * The `spam_screen` job: the AI check (and a mail domain's DNS) for an item written `pending`, then
 * the verdict, applied: delivered (its effects pulled forward), labelled, held (its alert, rules and
 * webhooks cancelled; the acknowledgement kept), or put aside (everything cancelled). On any failure
 * it is decided on the local signals alone, and never held or put aside for want of an AI.
 */
export async function runScreenJob(
  deps: SpamDeps,
  input: { readonly itemId: string; readonly eventId: string; readonly now: number },
  opts: JudgeOptions = {},
): Promise<ScreenJobResult> {
  const db = deps.db;
  const now = input.now;
  const item = await storedItem(db, input.itemId);
  if (!item) return { note: "item gone", verdict: null };
  if (item.screen !== "pending") return { note: `already ${item.screen ?? "unscreened"}`, verdict: null };
  const { rows } = await db.client.query({
    sql: "SELECT door, signals FROM spam_verdicts WHERE item_id = ?",
    params: [input.itemId],
    method: "all",
  });
  const door = (String(rows[0]?.[0] ?? "agent") as Door) ?? "agent";
  let signals: Signal[] = [];
  try {
    signals = JSON.parse(String(rows[0]?.[1] ?? "[]")) as Signal[];
  } catch {
    signals = [];
  }
  const settings = await readSettings(db);
  const business = await businessContext(db, settings);
  const run = await running(deps, now);
  const reading = await readingOf(
    item.type,
    item.payload,
    item.type === "message" ? undefined : item.firstMessage,
    item.type === "message" && item.channel === "email" ? item.subject : undefined,
    item.email ? { email: item.email } : undefined,
  );

  // The mail domain, looked up once and kept a month.
  const domain = emailDomain(item.email);
  const extra: Statement[] = [];
  const resolve = deps.resolveMail();
  if (domain && resolve && !SHARED_MAIL_PROVIDERS.has(domain) && !signals.some((s) => s.c === "no_mail")) {
    let mail = await cachedMail(db, domain, now);
    if (mail === null) {
      mail = await Promise.race([
        resolve(domain).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
      ]);
      if (mail !== null) {
        extra.push({
          sql: "INSERT OR REPLACE INTO spam_domains (domain, mail, checked_at) VALUES (?, ?, ?)",
          params: [domain, mail ? 1 : 0, now],
          method: "run",
        });
      }
    }
    if (mail === false) signals.push({ c: "no_mail", w: 2, f: "basic", d: domain });
  }

  // The AI check.
  let ai: AiOutcome = "none";
  let answer: CheckedAnswer | null = null;
  let tokens = { in: 0, out: 0, ms: 0 };
  const port = deps.judge();
  const room = run.on.size > 0 ? await aiRoom(deps, settings, now) : "none";
  // Another copy may have been judged since this one came in: its answer is reused, not paid for again.
  const reused =
    port && room === "room" && reading.print
      ? await reusableAnswer(db, {
          print: reading.print,
          sender: await printSenderOf(db, input.itemId),
          text: judgeText(reading.text),
          now,
        })
      : null;
  if (reused) {
    ai = "reused";
    answer = reused;
    signals.push(...answerSignals(reused, run.on));
    extra.push(countStatement("reused", now));
  } else if (port && room === "room") {
    const masked = judgeText(reading.text);
    const providerShared = domain ? SHARED_MAIL_PROVIDERS.has(domain) : false;
    const { request, nonce } = buildPrompt(
      {
        name: business.name,
        description: business.description,
        offers: business.offers,
        languages: business.languages,
      },
      {
        kind: KIND_WORDS[item.type] ?? "message",
        door: DOOR_WORDS[door] ?? "AI agent door",
        displayName: item.displayName,
        domain: domain ?? null,
        provider: domain ? (providerShared ? "a free email provider" : "a company domain") : "unknown",
        subject: item.type === "message" ? (item.subject ?? null) : null,
        linkDomains: reading.domains,
        attachments: item.attachments > 0 ? `${item.attachments} file${item.attachments === 1 ? "" : "s"}` : "none",
        text: masked,
      },
    );
    // Reserved before the call, so a check that never comes back still counts against the caps.
    await db.batch([countStatement("judged", now)]);
    const outcome = await runJudge(port, request, { nonce, text: masked }, opts);
    tokens = { in: outcome.tokensIn, out: outcome.tokensOut, ms: outcome.ok ? outcome.ms : 0 };
    if (outcome.ok) {
      ai = "judged";
      answer = outcome.answer;
      signals.push(...answerSignals(outcome.answer, run.on));
      if (reading.print) {
        extra.push({
          sql: "INSERT OR REPLACE INTO spam_cache (sha, answer, at) VALUES (?, ?, ?)",
          params: [reading.print.sha, JSON.stringify(outcome.answer), now],
          method: "run",
        });
      }
    } else {
      ai = outcome.why === "capped" ? "capped" : "failed";
      extra.push(countStatement(ai === "capped" ? "capped" : "failed", now));
    }
    if (tokens.in) extra.push(countStatement("tokens_in", now, tokens.in));
    if (tokens.out) extra.push(countStatement("tokens_out", now, tokens.out));
  } else if (room === "capped") {
    ai = "capped";
    extra.push(countStatement("capped", now));
  } else if (run.on.size > 0) ai = "skipped";

  const veto = namesOwnOffer(reading.normalised, business.offers) || answer?.customerIntent === true;
  const alerted = await ownerAlerted(db, input.eventId);
  const decision = decide({
    type: item.type,
    signals,
    veto,
    choices: run.choices,
    learning: run.learning,
    answer,
    alerted,
  });
  const verdict = decision.verdict;
  const flags = verdict === "warn" ? { needsHuman: true, spamLabel: decision.label ?? "basic" } : null;
  const untrusted = signals.some((s) => s.c === "talks_to_filter") || answer?.talksToFilter === true;
  const statements: Statement[] = [
    ...extra,
    {
      sql: `UPDATE spam_verdicts SET verdict = ?, cause = ?, certain = ?, score = ?, signals = ?, ai = ?, answer = ?, quotes = ?,
                   learning = ?, tokens_in = ?, tokens_out = ?, ms = ?, decided_at = ?
             WHERE item_id = ? AND verdict = 'pending'`,
      params: [
        verdict,
        decision.cause,
        decision.certain ? 1 : 0,
        decision.score,
        JSON.stringify(signals),
        ai,
        answer
          ? JSON.stringify({
              kind: answer.kind,
              certainty: answer.certainty,
              customer_intent: answer.customerIntent,
              talks_to_filter: answer.talksToFilter,
              topic: answer.topic,
            })
          : null,
        answer?.quotes.length ? JSON.stringify(answer.quotes) : null,
        decision.learning ? 1 : 0,
        tokens.in || null,
        tokens.out || null,
        tokens.ms || null,
        now,
        input.itemId,
      ],
      method: "run",
    },
  ];
  const counter = verdict === "aside" ? "aside" : verdict === "hold" ? "held" : verdict === "warn" ? "warned" : null;
  if (counter) statements.push(countStatement(counter, now));
  const casScreen = (to: Screen) => ({
    sql: "UPDATE items SET screen = ?, screen_at = ? WHERE id = ? AND screen = 'pending'",
    params: [to, now, input.itemId],
    method: "run" as const,
  });
  if (verdict === "deliver" || verdict === "warn") {
    statements.push(casScreen(SCREEN_OF[verdict]), pullForwardStatement(input.eventId, now));
    if (flags || untrusted) {
      // The label, in the same batch: the item's flags merged, its version moved on so a writer who
      // read it before reads it again.
      const patch = { ...(flags ?? {}), ...(untrusted ? { untrustedInstructions: true } : {}) };
      statements.push({
        sql: `UPDATE items SET flags = json_patch(flags, ?), version = version + 1, updated_at = ? WHERE id = ?`,
        params: [JSON.stringify(patch), now, input.itemId],
        method: "run",
      });
    }
  } else if (verdict === "hold") {
    statements.push(casScreen("held"), cancelEffectsStatement(input.eventId, now, decision.noProof));
  } else {
    // Put aside: a message or a quote request goes to its spam state, as the system, and nothing it
    // started runs.
    statements.push(cancelEffectsStatement(input.eventId, now, true));
    statements.push(...asideStatements(input.itemId, item.state, item.version, now));
    statements.push(casScreen("aside"));
  }
  await db.batch(statements);
  return { note: `screened: ${verdict}${ai !== "none" ? ` (${ai})` : ""}`, verdict };
}

/** An item put aside by the system once it was written: its event and its state, compare-and-set on its version. */
export function asideStatements(itemId: string, state: string, version: number, now: number): Statement[] {
  return [
    {
      sql: `INSERT INTO item_events (id, item_id, seq, event, from_state, to_state, actor_kind, actor_id, reason, diff, meta, causation_id, depth, created_at)
            SELECT ?, ?, ?, 'mark_spam', ?, 'spam', 'system', 'spam_filter', NULL, NULL, ?, NULL, 0, ?
             WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND version = ? AND state IN ('open', 'answered', 'received', 'needs_info'))`,
      params: [
        `${itemId}:aside`,
        itemId,
        version + 1,
        state,
        JSON.stringify({ channel: "system" }),
        now,
        itemId,
        version,
      ],
      method: "run",
    },
    {
      sql: `UPDATE items SET state = 'spam', version = version + 1, updated_at = ?, closed_at = COALESCE(closed_at, ?)
             WHERE id = ? AND version = ? AND state IN ('open', 'answered', 'received', 'needs_info')`,
      params: [now, now, itemId, version],
      method: "run",
    },
  ];
}

// ---- what every effect checks as it runs -----------------------------------------------------

export interface Gate {
  readonly screen: string | null;
  readonly createdAt: number;
  readonly noProof: boolean;
}

/** An item's screen as an effect reads it when it runs. */
export async function gateOf(db: Db, itemId: string): Promise<Gate | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.screen, i.created_at, COALESCE((SELECT certain FROM spam_verdicts v WHERE v.item_id = i.id), 0),
                 (SELECT cause FROM spam_verdicts v WHERE v.item_id = i.id)
            FROM items i WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  const cause = r[3] === null || r[3] === undefined ? null : String(r[3]);
  return {
    screen: r[0] === null || r[0] === undefined ? null : String(r[0]),
    createdAt: Number(r[1]),
    noProof: Number(r[2]) === 1 && cause !== null && NO_PROOF_CAUSES.has(cause),
  };
}

const NO_PROOF_CAUSES = new Set(["trap", "no_key", "server_marked", "blocked", "wave", "like_marked"]);

/** Whether an effect for the business (an alert, a rule, a webhook, a push) holds back: the item is held or put aside. */
export function holdsBack(gate: Gate | null): boolean {
  return gate !== null && (gate.screen === "held" || gate.screen === "aside");
}

/** Whether the item is still being screened, inside its deadline: an effect that came early waits. */
export function stillScreening(gate: Gate | null, now: number): boolean {
  return gate !== null && gate.screen === "pending" && now - gate.createdAt < SCREEN_DEADLINE_MS;
}

/** The effects of a create written for a pending item: each with its deadline. */
export function deadlineOf(now: number): number {
  return now + SCREEN_DEADLINE_MS;
}

/** Keeps the hash helper close for the doors that need a stable id for anonymous senders. */
export { looksLike, sha256Hex };
