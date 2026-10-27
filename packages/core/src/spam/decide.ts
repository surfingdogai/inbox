import type { ItemType } from "../domain/types";
import {
  ASIDE_AT,
  type CheckedAnswer,
  type Filter,
  type FilterChoice,
  NO_PROOF,
  type Signal,
  type Source,
  type Verdict,
  WARN_AT,
} from "./types";

/**
 * Deciding (ADR-041 §6). The points add up; under 3 the request is delivered, from 3 it is labelled,
 * from 6 — or with any certain signal — it reaches the aside band. Then caps, each of which can only
 * lower the outcome: a sender the business knows, a request that names the business's own offer, a
 * network pass, a filter set to label only, a filter still learning, an AI answer without proof, an
 * owner already alerted. Last, the band becomes the verdict its type allows: a message is put aside;
 * a booking or an order is held for proof, never put aside; a quote request is held, and put aside
 * only for what is certain.
 */

export interface DecideInput {
  readonly type: ItemType;
  readonly signals: readonly Signal[];
  /**
   * A sender the business knows (only checks that point at a third party ran), or one a person let
   * through, named by an address nothing vouched for: either is only ever labelled.
   */
  readonly trusted?: boolean | undefined;
  /** It names one of the business's own services or products. */
  readonly veto?: boolean | undefined;
  /** What each filter that is on does with what it is sure of. */
  readonly choices?: ReadonlyMap<Filter, FilterChoice> | undefined;
  /** The sources still in their learning week ('basic' for the free protection's point-based part). */
  readonly learning?: ReadonlySet<Source> | undefined;
  /** The AI check's answer, after the code checked it. */
  readonly answer?: CheckedAnswer | null | undefined;
  /** The owner was alerted already (its deadline passed before the verdict). */
  readonly alerted?: boolean | undefined;
}

export interface Decision {
  readonly verdict: Verdict;
  /** The strongest cause: a signal's code, or the filter's (`pitches`, `scams`, `junk`). */
  readonly cause: string | null;
  readonly score: number;
  /** A certain signal decided it. */
  readonly certain: boolean;
  /** A learning week turned what would have been put aside or held into a label. */
  readonly learning: boolean;
  /** The chip a delivered-with-a-label item carries; null when it carries none. */
  readonly label: string | null;
  /** Nothing the sender does releases it, and nobody is sent an acknowledgement: a certain bot signal. */
  readonly noProof: boolean;
}

/** Signals about how a request came, not what it says: a customer's words never veto these. */
export const DOOR_CODES: ReadonlySet<string> = new Set([
  "trap",
  "no_key",
  "key_invalid",
  "too_fast",
  "key_replayed",
  "key_stale",
  "name_link",
  "markup",
  "server_marked",
  "dmarc_fail",
  "display_other",
  "poses_as_us",
  "reply_elsewhere",
  "disposable",
  "no_mail",
  "many_new",
  "blocked",
]);

/**
 * The points, as they add up. The AI check finding a customer takes points off what the filters
 * found, never off the free protection's: switching a filter on can only ever put more aside, so a
 * model fooled into "customer" returns a message at most to where it would be with the filters off.
 */
function sum(signals: readonly Signal[]): number {
  let basic = 0;
  let filters = 0;
  let customer = 0;
  for (const s of signals) {
    if (s.c === "ai_customer") customer += s.w;
    else if (s.f === "pitches" || s.f === "scams" || s.f === "junk") filters += s.w;
    else basic += s.w;
  }
  return basic + Math.max(0, filters + customer);
}
/**
 * Whether what the door saw reaches the aside band on its own (a forged key sent in a moment): no
 * answer of the AI check can lower that, so none is asked for.
 */
export const decidedAtDoor = (signals: readonly Signal[]): boolean =>
  signals.filter((s) => DOOR_CODES.has(s.c)).reduce((n, s) => n + s.w, 0) >= ASIDE_AT;

const positive = (signals: readonly Signal[], source: Source) =>
  signals.filter((s) => s.f === source && s.w > 0).reduce((n, s) => n + s.w, 0);

/** The cause the owner reads first: a certain signal, else the filter or signal that weighed most. */
function causeOf(signals: readonly Signal[]): string | null {
  const certain = signals.find((s) => s.x === 1);
  if (certain) return certain.c;
  const bySource = new Map<string, number>();
  for (const s of signals) {
    if (s.w <= 0) continue;
    const key = s.f === "basic" ? s.c : s.f;
    bySource.set(key, (bySource.get(key) ?? 0) + s.w);
  }
  let best: [string, number] | null = null;
  for (const entry of bySource) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0] ?? null;
}

export function decide(input: DecideInput): Decision {
  const signals = input.signals;
  const score = Math.round(sum(signals) * 10) / 10;
  const certainSignal = signals.find((s) => s.x === 1);
  const certain = certainSignal !== undefined;
  let band: "deliver" | "warn" | "aside" =
    certain || score >= ASIDE_AT ? "aside" : score >= WARN_AT ? "warn" : "deliver";
  let learning = false;
  const cause = causeOf(signals);
  const atMostWarn = () => {
    if (band === "aside") band = "warn";
  };

  // A sender the business knows is only ever labelled: a customer's hijacked mailbox is flagged and seen.
  if (input.trusted) atMostWarn();
  if (band === "aside" && !certain) {
    // Which sources the band needs: without that source's points, added up the same way, it would not
    // reach it. A model's "customer" taking the filter's points off leaves the free protection's whole.
    const needs = (source: Source) =>
      positive(signals, source) > 0 && sum(signals.filter((s) => s.f !== source)) < ASIDE_AT;
    const words = signals.filter((s) => s.w > 0 && !DOOR_CODES.has(s.c)).reduce((n, s) => n + s.w, 0);
    const content = words > 0 && score - words < ASIDE_AT;
    // The business's own offer named, or a pass presented: what the words alone would do labels at most.
    if (input.veto && content) atMostWarn();
    if (content && signals.some((s) => s.c === "pass")) atMostWarn();
    // The AI finding it asks for what the business offers lowers only what the filters found: a model
    // told "customer" never brings back what the free protection puts aside alone.
    const filtered = (s: Signal) => s.f === "pitches" || s.f === "scams" || s.f === "junk" || s.f === "ai";
    const filtersNeeded =
      signals.some((s) => filtered(s) && s.w > 0) && sum(signals.filter((s) => !filtered(s))) < ASIDE_AT;
    if (input.answer?.customerIntent && filtersNeeded) atMostWarn();
    for (const [filter, choice] of input.choices ?? []) if (choice === "label" && needs(filter)) atMostWarn();
    for (const source of input.learning ?? []) {
      if (band === "aside" && needs(source)) {
        band = "warn";
        learning = true;
      }
    }
    // An AI answer can put a message aside on its own only when it is sure, quotes the message word
    // for word, and nothing in the message asks for what the business offers.
    const ai = signals.filter((s) => s.c === "ai_kind" && s.w > 0).reduce((n, s) => n + s.w, 0);
    if (band === "aside" && ai > 0 && score - ai < ASIDE_AT && input.type === "message") {
      const a = input.answer;
      if (a?.certainty !== "high" || a.quotes.length === 0 || a.customerIntent) atMostWarn();
    }
  }
  if (input.alerted) atMostWarn();
  // What speaks to an assistant or a filter is never delivered without a label.
  if (band === "deliver" && signals.some((s) => s.c === "talks_to_filter" || s.c === "ai_talks_to_filter"))
    band = "warn";

  let verdict: Verdict;
  if (band === "deliver") verdict = "deliver";
  else if (band === "warn") verdict = "warn";
  else if (input.type === "message") verdict = "aside";
  else if (input.type === "quote_request" && certainSignal && NO_PROOF.has(certainSignal.c)) verdict = "aside";
  else verdict = "hold";
  const noProof =
    (verdict === "hold" || verdict === "aside") && certainSignal !== undefined && NO_PROOF.has(certainSignal.c);
  const label = verdict === "warn" ? (learning ? "learning" : (cause ?? "basic")) : null;
  return { verdict, cause, score, certain: certain && verdict !== "warn", learning, label, noProof };
}

/** The AI check's answer as points (ADR-041 §5.4), for the filters that are on. */
export function answerSignals(answer: CheckedAnswer, on: ReadonlySet<Filter>): Signal[] {
  const out: Signal[] = [];
  const filter: Filter | null =
    answer.kind === "sales_pitch"
      ? "pitches"
      : answer.kind === "scam"
        ? "scams"
        : answer.kind === "junk"
          ? "junk"
          : null;
  if (filter && on.has(filter)) {
    const w = answer.certainty === "high" ? 6 : answer.certainty === "medium" ? 3 : 1;
    out.push({ c: "ai_kind", w, f: filter });
  }
  if (answer.kind === "customer" && answer.certainty !== "low") {
    out.push({ c: "ai_customer", w: answer.certainty === "high" ? -4 : -2, f: "ai" });
  }
  if (answer.talksToFilter) out.push({ c: "ai_talks_to_filter", w: 3, f: "ai" });
  return out;
}
