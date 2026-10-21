import { minorUnits, scheduleProblem } from "@surfingdog/spec";
import { z } from "zod";
import { moneyIn } from "../customer/format";
import type { CustomerLang } from "../customer/lang";
import { type Money, moneySchema } from "../domain/types";
import type { FieldProblem } from "../write/errors";

/**
 * A trade's quote (ADR-034 §4): an estimate or a fixed price, the stages it is paid in (the payment
 * schedule of ADR-032, adding up to the total: a deposit, a payment at a stage, the balance on
 * completion), what coming out or a visit costs and whether accepting takes it off, and whether the
 * prices include tax. The business sets every amount; nothing here prices anything.
 */

const fee = z.object({ amount: moneySchema, creditedIfAccepted: z.boolean().default(false) });

/** What `quote`'s input takes beyond a quote's own, as the owner or their AI sends it. */
export const tradeQuoteInput = {
  kind: z
    .enum(["estimate", "fixed"])
    .optional()
    .describe("estimate: the price may move with the work; fixed: it will not."),
  stages: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.enum(["immediate", "deferred", "at_property"]),
        amount: moneySchema,
        due_at: z.iso.datetime({ offset: true }).optional(),
        label: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(4)
    .optional()
    .describe("How it is paid, adding up to the total: a deposit (immediate), stages (deferred, by due_at), on site."),
  callOutFee: fee.optional().describe("What coming out costs, and whether accepting takes it off."),
  visitFee: fee.optional().describe("What a visit to quote costs, and whether accepting takes it off."),
  tax: z
    .object({
      included: z.boolean(),
      lines: z
        .array(z.object({ name: z.string().min(1).max(80), amount: moneySchema }))
        .max(5)
        .optional(),
    })
    .optional()
    .describe("Whether the prices include tax; when not, the tax lines on top."),
};

export const quoteLineKind = z.enum(["labour", "materials", "other"]).optional();

export interface TradeQuoteTerms {
  readonly totalPrice: Money;
  readonly kind?: "estimate" | "fixed" | undefined;
  readonly stages?:
    | readonly {
        readonly id: string;
        readonly type: "immediate" | "deferred" | "at_property";
        readonly amount: Money;
        readonly due_at?: string | undefined;
        readonly label?: string | undefined;
      }[]
    | undefined;
  readonly callOutFee?: { readonly amount: Money; readonly creditedIfAccepted: boolean } | undefined;
  readonly visitFee?: { readonly amount: Money; readonly creditedIfAccepted: boolean } | undefined;
  readonly tax?:
    | {
        readonly included: boolean;
        readonly lines?: readonly { readonly name: string; readonly amount: Money }[] | undefined;
      }
    | undefined;
}

/**
 * What is wrong with a trade's quote, by field: stages that do not add up to the total or are in
 * another currency, a stage paid later with no date, two stages with one id, a fee or a tax line in
 * another currency. Empty when it can be sent.
 */
export function tradeQuoteProblems(q: TradeQuoteTerms, now: number, prefix = "input"): FieldProblem[] {
  const out: FieldProblem[] = [];
  const currency = q.totalPrice.currency.toUpperCase();
  const same = (m: Money) => m.currency.toUpperCase() === currency;
  if (minorUnits(currency) === null) {
    out.push({ path: `${prefix}.totalPrice.currency`, problem: "invalid", message: `${currency} is not a currency` });
    return out;
  }
  if (q.stages) {
    const problem = scheduleProblem(
      q.stages.map((s) => ({ amount: { value: s.amount.value, currency: s.amount.currency.toUpperCase() } })),
      { value: q.totalPrice.value, currency },
    );
    if (problem)
      out.push({ path: `${prefix}.stages`, problem: "invalid", message: `${problem}: they add up to the total` });
    const ids = new Set<string>();
    q.stages.forEach((s, i) => {
      if (ids.has(s.id)) out.push({ path: `${prefix}.stages.${i}.id`, problem: "invalid", message: "each stage once" });
      ids.add(s.id);
      if (s.type === "deferred" && !s.due_at) {
        out.push({ path: `${prefix}.stages.${i}.due_at`, problem: "missing", message: "when a later stage is due" });
      }
      if (s.due_at && Date.parse(s.due_at) <= now) {
        out.push({ path: `${prefix}.stages.${i}.due_at`, problem: "invalid", message: "must be in the future" });
      }
    });
  }
  for (const key of ["callOutFee", "visitFee"] as const) {
    const f = q[key];
    if (f && !same(f.amount)) {
      out.push({
        path: `${prefix}.${key}.amount.currency`,
        problem: "invalid",
        message: `must be ${currency}, the total's`,
      });
    }
  }
  q.tax?.lines?.forEach((l, i) => {
    if (!same(l.amount)) {
      out.push({
        path: `${prefix}.tax.lines.${i}.amount.currency`,
        problem: "invalid",
        message: `must be ${currency}`,
      });
    }
  });
  return out;
}

/**
 * What a trade's quote adds to its terms, only what it holds: a quote without them keeps its terms
 * (and their fingerprint) as they were. Estimate or fixed is `quoteKind` there: an offer's own `kind`
 * (a quote) is fingerprinted beside its terms.
 */
export function tradeQuoteTerms(q: Partial<TradeQuoteTerms>): TradeTerms {
  return {
    ...(q.kind ? { quoteKind: q.kind } : {}),
    ...(q.stages?.length ? { stages: q.stages } : {}),
    ...(q.callOutFee ? { callOutFee: q.callOutFee } : {}),
    ...(q.visitFee ? { visitFee: q.visitFee } : {}),
    ...(q.tax ? { tax: q.tax } : {}),
  };
}

/** A trade's quote as an offer's terms hold it. */
export interface TradeTerms {
  readonly quoteKind?: TradeQuoteTerms["kind"];
  readonly stages?: TradeQuoteTerms["stages"];
  readonly callOutFee?: TradeQuoteTerms["callOutFee"];
  readonly visitFee?: TradeQuoteTerms["visitFee"];
  readonly tax?: TradeQuoteTerms["tax"];
}

const WORDS = {
  en: {
    estimate: "This is an estimate: the final price may move with the work.",
    fixed: "This is a fixed price.",
    stages: (list: string) => `It is paid in stages: ${list}.`,
    now: "now",
    onSite: "on the day",
    by: (date: string) => `by ${date}`,
    callOut: (amount: string, credited: boolean) =>
      credited ? `Coming out costs ${amount}, taken off if you accept.` : `Coming out costs ${amount}.`,
    visit: (amount: string, credited: boolean) =>
      credited ? `The visit costs ${amount}, taken off if you accept.` : `The visit costs ${amount}.`,
    taxIn: "Prices include tax.",
    taxOut: (lines: string) => (lines ? `Tax is added on top: ${lines}.` : "Tax is added on top."),
  },
  pt: {
    estimate: "Isto é uma estimativa: o preço final pode mudar com o trabalho.",
    fixed: "Este é um preço fixo.",
    stages: (list: string) => `É pago por fases: ${list}.`,
    now: "agora",
    onSite: "no dia",
    by: (date: string) => `até ${date}`,
    callOut: (amount: string, credited: boolean) =>
      credited ? `A deslocação custa ${amount}, descontada se aceitar.` : `A deslocação custa ${amount}.`,
    visit: (amount: string, credited: boolean) =>
      credited ? `A visita custa ${amount}, descontada se aceitar.` : `A visita custa ${amount}.`,
    taxIn: "Os preços incluem impostos.",
    taxOut: (lines: string) => (lines ? `Os impostos acrescem: ${lines}.` : "Os impostos acrescem."),
  },
} as const;

/** A trade's quote in words, for the summary the customer says yes to: empty for a quote without them. */
export function tradeQuoteWords(q: TradeQuoteTerms, lang: CustomerLang, dateText: (iso: string) => string): string {
  const w = WORDS[lang];
  const out: string[] = [];
  if (q.kind === "estimate") out.push(w.estimate);
  else if (q.kind === "fixed" && q.stages?.length) out.push(w.fixed);
  if (q.stages?.length) {
    const list = q.stages
      .map((s) => {
        const when =
          s.type === "immediate" ? w.now : s.type === "at_property" ? w.onSite : w.by(dateText(s.due_at ?? ""));
        const label = s.label?.trim() ? `${s.label.trim()} ` : "";
        return `${label}${moneyIn(s.amount, lang)} ${when}`;
      })
      .join("; ");
    out.push(w.stages(list));
  }
  if (q.callOutFee) out.push(w.callOut(moneyIn(q.callOutFee.amount, lang), q.callOutFee.creditedIfAccepted));
  if (q.visitFee) out.push(w.visit(moneyIn(q.visitFee.amount, lang), q.visitFee.creditedIfAccepted));
  if (q.tax) {
    out.push(
      q.tax.included
        ? w.taxIn
        : w.taxOut((q.tax.lines ?? []).map((l) => `${l.name} ${moneyIn(l.amount, lang)}`).join(", ")),
    );
  }
  return out.join(" ");
}
