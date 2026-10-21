import { type DatedPolicy, type Policy, policySchema, type TableRules, tableRulesSchema } from "@surfingdog/spec";
import type { Db } from "../db";
import type { Money } from "../domain/types";
import { datePolicy, policySentence } from "../policy/index";
import { WriteError } from "../write/errors";
import { kitchenContext } from "./context";
import { kitchenMoney, kitchenWords } from "./words";

/**
 * Tables (ADR-036): a service whose places are people (`capacity_unit: people`): covers per sitting,
 * its duration the turn time. Its rules (`table_rules`) are the business's:
 *
 * - `maxParty`: the largest party booked online; above it, or above `quoteAbove` when that is set, the
 *   request becomes a request for a price (an event, a private room), which the business answers with a
 *   quote. Between the two, the customer is asked to get in touch.
 * - `deposit`: an amount per person from a party size, held as the booking's deposit (the same field a
 *   salon's deposit uses, ADR-035), with the policy dated for the booking.
 * - `setAside`: the covers a sitting keeps for direct bookings. A party that fits in what is left of them
 *   confirms at once (the service's capacity is set to them, and nothing more); a larger party, and every
 *   table when none are set aside, is confirmed by a person, who seats it from the whole room.
 * - `policy`: the table's cancellation policy, read back to the customer before they are bound.
 */

export interface TableService {
  readonly id: string;
  readonly name: string;
  readonly durationMin: number;
  readonly rules: TableRules;
  readonly policy: Policy | null;
}

const storedSchema = tableRulesSchema.extend({ policy: policySchema.nullable().optional() });

/** A service's table rules, when its places are people and it has them. */
export async function tableServiceOf(db: Db, serviceId: string): Promise<TableService | null> {
  const { rows } = await db.client.query({
    sql: "SELECT id, name, duration_min, capacity_unit, table_rules FROM services WHERE id = ?",
    params: [serviceId],
    method: "all",
  });
  const r = rows[0];
  if (!r || String(r[3]) !== "people") return null;
  let raw: unknown = r[4];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const parsed = storedSchema.safeParse(raw ?? { maxParty: 8 });
  const rules = parsed.success ? parsed.data : { maxParty: 8 };
  const { policy, ...plain } = rules as TableRules & { policy?: Policy | null };
  return { id: String(r[0]), name: String(r[1]), durationMin: Number(r[2]), rules: plain, policy: policy ?? null };
}

/** What a table booking turns into: a booking with its deposit and policy, or a request for a price. */
export type TablePlan =
  | { readonly kind: "booking"; readonly adds: Record<string, unknown> }
  | { readonly kind: "quote"; readonly words: string };

/** What a booking of a table becomes, by its party, and what the inbox adds to it. */
export async function planTable(
  db: Db,
  table: TableService,
  payload: {
    readonly partySize?: number | undefined;
    readonly startTime: string;
    readonly totalPrice?: Money | undefined;
  },
  lang: string,
  now: number,
): Promise<TablePlan> {
  const ctx = await kitchenContext(db);
  const w = kitchenWords(lang, ctx.name);
  const party = payload.partySize ?? 0;
  if (party < 1) {
    throw new WriteError("invalid_input", "Say how many people the table is for (payload.partySize).", {
      fields: [{ path: "payload.partySize", problem: "missing", message: "how many people" }],
    });
  }
  const r = table.rules;
  const quoteFrom = r.quoteAbove ?? r.maxParty;
  if (party > quoteFrom) return { kind: "quote", words: w.tableQuote(party) };
  if (party > r.maxParty) {
    throw new WriteError("invalid_input", w.tableTooLarge(r.maxParty), {
      fields: [{ path: "payload.partySize", problem: "invalid", message: w.tableTooLarge(r.maxParty) }],
      details: { reason: "party_too_large", max_party: r.maxParty },
    });
  }
  const adds: Record<string, unknown> = {};
  if (r.deposit && party >= r.deposit.fromParty) {
    const value = r.deposit.perPerson.value * party;
    if (Number.isSafeInteger(value) && value > 0) {
      adds.deposit = {
        amount: { value, currency: r.deposit.perPerson.currency.toUpperCase() },
        refundable: table.policy?.deposit?.refundable ?? true,
      };
    }
  }
  if (table.policy) {
    const total = payload.totalPrice ??
      (adds.deposit as { amount: Money } | undefined)?.amount ?? { value: 0, currency: ctx.currency };
    adds.policy = datePolicy(table.policy, {
      start: { at: Date.parse(payload.startTime) },
      zone: ctx.timezone,
      total,
      bookedAt: now,
    });
  }
  return { kind: "booking", adds };
}

const DEPOSIT_WORDS: Readonly<Record<string, (amount: string, refundable: boolean) => string>> = {
  en: (a, r) =>
    `A deposit of ${a} holds the table${r ? ", given back with a free cancellation" : ", kept if it is cancelled"}.`,
  es: (a, r) =>
    `Un depósito de ${a} reserva la mesa${r ? ", que se devuelve si cancelas a tiempo" : ", que no se devuelve si cancelas"}.`,
  fr: (a, r) =>
    `Un acompte de ${a} retient la table${r ? ", rendu en cas d'annulation gratuite" : ", conservé en cas d'annulation"}.`,
  de: (a, r) =>
    `Eine Anzahlung von ${a} hält den Tisch${r ? ", zurück bei kostenloser Stornierung" : ", die bei Stornierung einbehalten wird"}.`,
  it: (a, r) =>
    `Un acconto di ${a} tiene il tavolo${r ? ", restituito con una cancellazione gratuita" : ", trattenuto se si cancella"}.`,
  pt: (a, r) =>
    `Um depósito de ${a} segura a mesa${r ? ", devolvido com um cancelamento gratuito" : ", que fica retido se cancelar"}.`,
  ja: (a, r) =>
    `${a}のデポジットでお席をお取りします${r ? "。無料でキャンセルできる期間内のキャンセルなら返金されます" : "。キャンセルの場合は返金されません"}。`,
};

/** What a table booking says of its deposit and policy before the customer is bound. */
export function tableWords(
  payload: {
    readonly deposit?: { readonly amount: Money; readonly refundable: boolean } | undefined;
    readonly policy?: DatedPolicy | undefined;
    readonly totalPrice?: Money | undefined;
  },
  a: { readonly lang: string },
): string {
  const out: string[] = [];
  const lang = a.lang.slice(0, 2);
  if (payload.deposit) {
    const words = DEPOSIT_WORDS[lang] ?? (DEPOSIT_WORDS.en as (x: string, r: boolean) => string);
    out.push(words(kitchenMoney(payload.deposit.amount, lang), payload.deposit.refundable));
  }
  if (payload.policy) {
    const total = payload.totalPrice ??
      payload.deposit?.amount ?? { value: 0, currency: payload.policy.noShow.currency };
    out.push(policySentence(payload.policy, { lang, total }));
  }
  return out.join(" ");
}
