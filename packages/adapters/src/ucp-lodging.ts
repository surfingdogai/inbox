import {
  type Caller,
  type Capabilities,
  type Db,
  type Item,
  isCustomer,
  LINK_GRACE_MS,
  linkUrl,
  listProperties,
  lodgingWord,
  mintLinks,
  type PayloadOf,
  type PropertySetup,
  policySentence,
  readSettings,
  readSetup,
  rowToItem,
  type SecretBox,
  type StayLang,
  schema,
  stayLang,
  transitionItem,
  WriteError,
  whenWords,
} from "@surfingdog/core";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { scopeFor } from "./auth";
import { publicOrigin } from "./origin";
import type { CallerEnv } from "./rest";

/**
 * UCP Lodging (ADR-033 §6.5): a place to stay's instant rooms as the Universal Commerce Protocol's
 * draft booking capability shows them, mapped onto the stays doors. Switched off: nothing here is
 * mounted unless whoever runs the inbox sets INBOX_UCP_LODGING=on, and the profile says so only while
 * the property has a room it can confirm at once.
 *
 * Source, read in public and pinned (Apache-2.0, the UCP Authors):
 *   https://github.com/Universal-Commerce-Protocol/ucp/blob/f2626c28b8288976eee5bda77f3a9b1ddc0132b1/docs/specification/lodging/booking/index.md
 *   …/docs/specification/lodging/booking/rest.md, …/docs/specification/lodging/extensions/cancellation-policy.md
 *   …/source/schemas/lodging/booking.json, …/source/schemas/lodging/types/*.json,
 *   …/source/schemas/common/payment_terms.json, …/source/schemas/common/types/{totals,total,payment_term,
 *   payment_schedule,policy,message_error,message_warning,message_info}.json
 * Commit f2626c28b8288976eee5bda77f3a9b1ddc0132b1 (main, 20 Oct 2026); lodging itself came in with
 * c9a1395b5db889dd201ddc982b9a020b3cbef9a7 (#780, 24 Sep 2026) and is marked "Draft - Work in Progress".
 *
 * What it maps (the business stays the merchant and the party to the contract, and no card ever
 * passes through here):
 * - property, accommodation_type and rate_plan are the property, its room types and its rate plans;
 *   a stay's `id` is `<room type>__<rate plan>`. Every room of one booking has the same dates here.
 * - Create and Update price the rooms (`quote_stay`). Once a lead guest is named with a way to reach
 *   them, the rooms are held (`hold_stay`) and the session is ready to complete; an Update that changes
 *   anything lets the old hold go and holds again. Complete books the held stay (`book_stay`): it is
 *   completed, or, where a deposit or a card is due, handed to the property's own page (continue_url).
 *   Cancel lets a hold go, withdraws a request, or cancels a stay still waiting for its payment.
 * - totals[]: one subtotal (the rooms, and any extras, as its lines), every fee, tax and discount, and
 *   one total; the addends sum to it. payment.terms[0].schedules[] is the quote's schedule, with the
 *   same three types. policies[] is the quote's dated policy, in words and as its steps.
 * - messages[]: `local_tax` (a disclosure, its path the at_property schedule) for every charge the
 *   property collects itself; `totals_changed`; `inventory_exhausted`; `occupancy_exceeded_capacity`.
 * - Guests' ids are echoed in the answer to the request that sent them and kept nowhere: the property
 *   keeps the lead's name and contact and the other guests' names, as for any stay.
 * Not served: a property that answers each stay itself. UCP needs one authoritative total in every
 * session, and only a room the inbox can confirm at once has one before the property answers.
 */

/** The pinned source, as the header says. */
export const UCP_LODGING_SOURCE = {
  repository: "https://github.com/Universal-Commerce-Protocol/ucp",
  commit: "f2626c28b8288976eee5bda77f3a9b1ddc0132b1",
  introduced: "c9a1395b5db889dd201ddc982b9a020b3cbef9a7",
} as const;

/**
 * The version every answer names. The lodging draft has no dated release of its own: this is the newest
 * dated one (2026-08-25) until lodging ships in one, and the line moves then.
 */
export const UCP_VERSION = "2026-08-25";
const DRAFT = "https://ucp.dev/draft";

export const BOOKING = "dev.ucp.lodging.booking";
export const PAYMENT_TERMS = "dev.ucp.common.payment.terms";
export const CANCELLATION = "dev.ucp.lodging.policy.cancellation";

/** The one payment term a stay has: its schedule. */
export const TERM_ID = "stay";

/** Where the booking sessions are, under the inbox's own REST door. */
export const UCP_LODGING_PATH = "/v1/ucp/lodging";

/** How long a session that never held a room can be used: it keeps no state of its own. */
export const SESSION_LIFE_MS = 24 * 3_600_000;

/** INBOX_UCP_LODGING: on only when it says `on`. */
export function ucpLodgingOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "on";
}

// ---- shapes -------------------------------------------------------------------------

type StayPayload = PayloadOf<"stay">;
export type StayQuote = NonNullable<StayPayload["quote"]>;
type QuoteLine = StayQuote["lines"][number];

export interface UcpLine {
  readonly display_text: string;
  readonly amount: number;
  /** An extra on the booking (late check-out, breakfast…), not a room. */
  readonly kind?: "extra";
  /** Collected by the property itself, not with the booking. */
  readonly collected?: "at_property";
  /** A room's price night by night. */
  readonly nights?: readonly { readonly night: string; readonly amount: number }[];
}

export interface UcpTotal {
  readonly type: string;
  readonly display_text?: string;
  readonly amount: number;
  readonly lines?: readonly UcpLine[];
  readonly collected?: "at_property";
}

export interface UcpSchedule {
  readonly id: string;
  readonly type: string;
  readonly description: { readonly plain: string };
  readonly amount: number;
  readonly due_at?: string;
}

export interface UcpPayment {
  readonly selected_term_id: string;
  readonly terms: readonly {
    readonly id: string;
    readonly title: string;
    readonly schedules: readonly UcpSchedule[];
  }[];
}

export interface UcpPolicy {
  readonly type: string;
  readonly description: { readonly plain: string };
  readonly refundability: "refundable" | "partially_refundable" | "non_refundable";
  /** The policy as data, dated for these nights in the property's zone; amounts in minor units. */
  readonly dated_steps: {
    readonly zone: string;
    readonly steps: readonly { readonly until: string; readonly fee: number }[];
    readonly after: number;
    readonly no_show: number;
  };
}

export type UcpSeverity = "recoverable" | "requires_buyer_input" | "requires_buyer_review" | "unrecoverable";

export interface UcpMessage {
  readonly type: "error" | "warning" | "info";
  readonly code?: string;
  readonly path?: string;
  readonly content: string;
  readonly content_type?: "plain";
  readonly severity?: UcpSeverity;
  readonly presentation?: "notice" | "disclosure";
}

export interface UcpStay {
  readonly id: string;
  readonly accommodation_type: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly capacity: {
      readonly adults: number;
      readonly children: number;
      readonly total: number;
      readonly child_age_ranges: readonly { readonly ages: { min: number; max: number }; readonly limit?: number }[];
    };
  };
  readonly rate_plan: { readonly id: string; readonly title: string; readonly description?: string };
  readonly occupancy: {
    readonly adults: number;
    readonly children: number;
    readonly child_ages?: readonly number[];
    readonly total: number;
  };
  readonly stay_dates: { readonly start_date: string; readonly end_date: string };
  readonly guest_assignments?: readonly { readonly guest_id: string; readonly role?: string }[];
  readonly totals: readonly UcpTotal[];
}

export type UcpStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export interface UcpBooking {
  readonly ucp: Record<string, unknown>;
  readonly id: string;
  readonly status: UcpStatus;
  readonly property: { readonly id: string; readonly name: string; readonly address?: Record<string, string> };
  readonly stays: readonly UcpStay[];
  readonly booker?: Record<string, unknown>;
  readonly guests?: readonly Record<string, unknown>[];
  readonly travel_purpose?: string;
  readonly currency: string;
  readonly totals: readonly UcpTotal[];
  readonly messages?: readonly UcpMessage[];
  readonly links: readonly { readonly type: string; readonly url: string; readonly title?: string }[];
  readonly policies?: readonly UcpPolicy[];
  readonly expires_at?: string;
  readonly continue_url?: string;
  readonly payment?: UcpPayment;
  readonly confirmation?: { readonly id: string; readonly label?: string };
}

/** The `ucp` object of every booking session answered. No payment handler: the property takes its own. */
export function ucpEnvelope(): Record<string, unknown> {
  return {
    version: UCP_VERSION,
    capabilities: {
      [BOOKING]: [{ version: UCP_VERSION }],
      [PAYMENT_TERMS]: [{ version: UCP_VERSION }],
      [CANCELLATION]: [{ version: UCP_VERSION }],
    },
    payment_handlers: {},
  };
}

/** UCP's answer when no session can be made or found: its messages, and where a person can go on. */
export function ucpErrorBody(messages: readonly UcpMessage[], continueUrl?: string): Record<string, unknown> {
  return {
    ucp: { version: UCP_VERSION, status: "error" },
    messages,
    ...(continueUrl ? { continue_url: continueUrl } : {}),
  };
}

const error = (code: string, content: string, severity: UcpSeverity, path?: string): UcpMessage => ({
  type: "error",
  code,
  ...(path ? { path } : {}),
  content,
  severity,
});

// ---- the guest's words ---------------------------------------------------------------

/**
 * What the platform shows the guest beside the property's own words, in the stay's language: when each
 * payment is due, what the property collects itself, and that the price moved. Error messages are for
 * the platform and its agent, in English, short. None of these names anything but the property.
 */
interface Words {
  readonly dueNow: (label: string) => string;
  readonly dueBy: (label: string, when: string, place: string) => string;
  readonly dueLater: (label: string) => string;
  readonly atProperty: (label: string, property: string) => string;
  readonly localTax: (property: string) => string;
  readonly exempt: (name: string, age: number) => string;
  readonly maxNights: (name: string, nights: number) => string;
  readonly totalsChanged: string;
  readonly nonRefundable: string;
  readonly payThere: (property: string, label: string, when: string) => string;
  readonly cardThere: (property: string, when: string) => string;
}

export const UCP_WORDS: Readonly<Record<StayLang, Words>> = {
  en: {
    dueNow: (l) => `${l}: due when you book.`,
    dueBy: (l, w, p) => `${l}: due by ${w}, ${p} time.`,
    dueLater: (l) => `${l}: due before arrival.`,
    atProperty: (l, p) => `${l}: paid to ${p} itself, not with the booking.`,
    localTax: (p) => `Paid to ${p} at the property, not with the booking:`,
    exempt: (n, a) => `${n}: children under ${a} are exempt.`,
    maxNights: (n, k) => `${n}: for at most ${k} nights.`,
    totalsChanged: "The price changed since you last saw it: the totals shown now are the ones that hold.",
    nonRefundable: "This stay cannot be refunded once it is booked.",
    payThere: (p, l, w) =>
      `${p} takes what is due now (${l}) on its own payment page, by ${w}. Continue there to confirm the stay.`,
    cardThere: (p, w) =>
      `${p} asks for a card to hold the stay, saved on its own payment page by ${w}; nothing is charged now.`,
  },
  es: {
    dueNow: (l) => `${l}: se paga al reservar.`,
    dueBy: (l, w, p) => `${l}: se paga antes del ${w}, hora de ${p}.`,
    dueLater: (l) => `${l}: se paga antes de la llegada.`,
    atProperty: (l, p) => `${l}: se paga directamente a ${p}, no con la reserva.`,
    localTax: (p) => `Se paga a ${p} en el alojamiento, no con la reserva:`,
    exempt: (n, a) => `${n}: los menores de ${a} años están exentos.`,
    maxNights: (n, k) => `${n}: como máximo ${k} noches.`,
    totalsChanged: "El precio cambió desde la última vez: los importes que se muestran ahora son los que valen.",
    nonRefundable: "Esta estancia no se reembolsa una vez reservada.",
    payThere: (p, l, w) =>
      `${p} cobra lo que se paga ahora (${l}) en su propia página de pago, antes del ${w}. Continúe allí para confirmar la estancia.`,
    cardThere: (p, w) =>
      `${p} pide una tarjeta para garantizar la estancia, guardada en su propia página de pago antes del ${w}; ahora no se cobra nada.`,
  },
  fr: {
    dueNow: (l) => `${l} : à régler à la réservation.`,
    dueBy: (l, w, p) => `${l} : à régler avant le ${w}, heure de ${p}.`,
    dueLater: (l) => `${l} : à régler avant l'arrivée.`,
    atProperty: (l, p) => `${l} : à régler directement à ${p}, pas avec la réservation.`,
    localTax: (p) => `À régler à ${p} sur place, pas avec la réservation :`,
    exempt: (n, a) => `${n} : les enfants de moins de ${a} ans en sont exonérés.`,
    maxNights: (n, k) => `${n} : pour ${k} nuits au plus.`,
    totalsChanged: "Le prix a changé depuis la dernière fois : les montants affichés maintenant sont ceux qui valent.",
    nonRefundable: "Ce séjour n'est pas remboursable une fois réservé.",
    payThere: (p, l, w) =>
      `${p} encaisse ce qui est dû maintenant (${l}) sur sa propre page de paiement, avant le ${w}. Continuez-y pour confirmer le séjour.`,
    cardThere: (p, w) =>
      `${p} demande une carte pour garantir le séjour, enregistrée sur sa propre page de paiement avant le ${w} ; rien n'est débité maintenant.`,
  },
  de: {
    dueNow: (l) => `${l}: fällig bei der Buchung.`,
    dueBy: (l, w, p) => `${l}: fällig bis ${w}, Ortszeit ${p}.`,
    dueLater: (l) => `${l}: vor der Ankunft fällig.`,
    atProperty: (l, p) => `${l}: direkt an ${p} zu zahlen, nicht mit der Buchung.`,
    localTax: (p) => `Vor Ort an ${p} zu zahlen, nicht mit der Buchung:`,
    exempt: (n, a) => `${n}: Kinder unter ${a} Jahren sind befreit.`,
    maxNights: (n, k) => `${n}: höchstens für ${k} Nächte.`,
    totalsChanged: "Der Preis hat sich seitdem geändert: Es gelten die Beträge, die jetzt angezeigt werden.",
    nonRefundable: "Dieser Aufenthalt wird nach der Buchung nicht erstattet.",
    payThere: (p, l, w) =>
      `${p} nimmt den jetzt fälligen Betrag (${l}) auf seiner eigenen Zahlungsseite entgegen, bis ${w}. Dort geht es weiter, um den Aufenthalt zu bestätigen.`,
    cardThere: (p, w) =>
      `${p} bittet um eine Karte zur Sicherung des Aufenthalts, hinterlegt auf seiner eigenen Zahlungsseite bis ${w}; jetzt wird nichts belastet.`,
  },
  it: {
    dueNow: (l) => `${l}: da pagare alla prenotazione.`,
    dueBy: (l, w, p) => `${l}: da pagare entro il ${w}, ora di ${p}.`,
    dueLater: (l) => `${l}: da pagare prima dell'arrivo.`,
    atProperty: (l, p) => `${l}: da pagare direttamente a ${p}, non con la prenotazione.`,
    localTax: (p) => `Da pagare a ${p} sul posto, non con la prenotazione:`,
    exempt: (n, a) => `${n}: i bambini sotto i ${a} anni sono esenti.`,
    maxNights: (n, k) => `${n}: per al massimo ${k} notti.`,
    totalsChanged: "Il prezzo è cambiato dall'ultima volta: valgono gli importi mostrati ora.",
    nonRefundable: "Questo soggiorno non è rimborsabile una volta prenotato.",
    payThere: (p, l, w) =>
      `${p} incassa quanto dovuto ora (${l}) sulla sua pagina di pagamento, entro il ${w}. Continui lì per confermare il soggiorno.`,
    cardThere: (p, w) =>
      `${p} chiede una carta a garanzia del soggiorno, salvata sulla sua pagina di pagamento entro il ${w}; ora non viene addebitato nulla.`,
  },
  pt: {
    dueNow: (l) => `${l}: a pagar na reserva.`,
    dueBy: (l, w, p) => `${l}: a pagar até ${w}, hora de ${p}.`,
    dueLater: (l) => `${l}: a pagar antes da chegada.`,
    atProperty: (l, p) => `${l}: a pagar diretamente a ${p}, não com a reserva.`,
    localTax: (p) => `A pagar a ${p} no alojamento, não com a reserva:`,
    exempt: (n, a) => `${n}: crianças com menos de ${a} anos estão isentas.`,
    maxNights: (n, k) => `${n}: no máximo ${k} noites.`,
    totalsChanged: "O preço mudou desde a última vez: valem os valores mostrados agora.",
    nonRefundable: "Esta estadia não é reembolsável depois de reservada.",
    payThere: (p, l, w) =>
      `${p} recebe o valor devido agora (${l}) na sua própria página de pagamento, até ${w}. Continue lá para confirmar a estadia.`,
    cardThere: (p, w) =>
      `${p} pede um cartão para garantir a estadia, guardado na sua própria página de pagamento até ${w}; nada é cobrado agora.`,
  },
};

/** A sample of every guest-facing string in a language, for the copy lint. */
export function sampleUcpStrings(lang: StayLang): string[] {
  const w = UCP_WORDS[lang];
  return [
    w.dueNow("Deposit"),
    w.dueBy("Balance", "9 Dec, 10:00", "Kyoto"),
    w.dueLater("Balance"),
    w.atProperty("At the property", "Ryokan Hoshi"),
    w.localTax("Ryokan Hoshi"),
    w.exempt("City tax", 12),
    w.maxNights("City tax", 7),
    w.totalsChanged,
    w.nonRefundable,
    w.payThere("Ryokan Hoshi", "Deposit", "9 Dec, 10:00"),
    w.cardThere("Ryokan Hoshi", "9 Dec, 10:00"),
  ];
}

// ---- the mapping, pure --------------------------------------------------------------------

const sum = (xs: readonly { readonly amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);

function subLine(l: QuoteLine): UcpLine {
  return {
    display_text: l.label,
    amount: l.amount,
    ...(l.type === "extra" ? { kind: "extra" as const } : {}),
    ...(l.collected === "at_property" ? { collected: "at_property" as const } : {}),
    ...(l.nights?.length ? { nights: l.nights } : {}),
  };
}

/**
 * A quote's lines as UCP's totals: one subtotal, the rooms and extras as its lines (UCP allows exactly
 * one subtotal, so an extra is a line of it), each fee, tax and discount as it is, and one total. The
 * addends sum to the total, as the quote's lines sum to its own. A charge the property collects itself
 * says so (`collected`); when it is paid is the schedule's to say.
 */
export function ucpTotalsOf(quote: StayQuote): UcpTotal[] {
  const priced = quote.lines.filter((l) => l.type === "subtotal" || l.type === "extra");
  const subtotal: UcpTotal = {
    type: "subtotal",
    ...(priced.length ? { display_text: priced.map((l) => l.label).join(" · ") } : {}),
    amount: sum(priced),
    ...(priced.length ? { lines: priced.map(subLine) } : {}),
  };
  const others = quote.lines
    .filter((l) => l.type === "fee" || l.type === "tax" || l.type === "discount")
    // A discount of nothing is no discount: UCP's are below zero.
    .filter((l) => !(l.type === "discount" && l.amount === 0))
    .map(
      (l): UcpTotal => ({
        type: l.type,
        display_text: l.label,
        amount: l.amount,
        ...(l.collected === "at_property" ? { collected: "at_property" as const } : {}),
      }),
    );
  return [subtotal, ...others, { type: "total", amount: quote.total.value }];
}

/**
 * Each room's own totals, for its stay: its nights and the extras listed after it, across the whole
 * stay. Taxes and fees are the booking's, in the root totals, which alone are authoritative.
 */
export function ucpStayTotalsOf(quote: StayQuote, rooms: number): UcpTotal[][] {
  const groups: QuoteLine[][] = [];
  for (const l of quote.lines) {
    if (l.type === "subtotal") groups.push([l]);
    else if (l.type === "extra") {
      if (!groups.length) groups.push([]);
      groups[groups.length - 1]?.push(l);
    }
  }
  return Array.from({ length: rooms }, (_, i) => {
    const amount = sum(groups[i] ?? []);
    return [
      { type: "subtotal", amount },
      { type: "total", amount },
    ];
  });
}

/** The town a time is read by: the property's own, else its zone's city. */
export function placeOf(setup: PropertySetup): string {
  const town = setup.property.locality?.trim();
  if (town) return town;
  return (setup.property.timezone.split("/").pop() ?? setup.property.timezone).replace(/_/g, " ");
}

/**
 * The quote's schedule as UCP's one payment term: each entry with its id, type, amount and due date,
 * and a description that says on its own when it is due, as UCP requires. The entries sum to the total.
 */
export function ucpPaymentOf(quote: StayQuote, setup: PropertySetup, lang: StayLang): UcpPayment {
  const w = UCP_WORDS[lang];
  const schedules = quote.schedule.map(
    (s): UcpSchedule => ({
      id: s.id,
      type: s.type,
      description: {
        plain:
          s.type === "immediate"
            ? w.dueNow(s.label)
            : s.type === "deferred"
              ? s.dueAt
                ? w.dueBy(s.label, whenWords(setup, s.dueAt, lang), placeOf(setup))
                : w.dueLater(s.label)
              : w.atProperty(s.label, setup.property.name),
      },
      amount: s.amount.value,
      ...(s.dueAt ? { due_at: s.dueAt } : {}),
    }),
  );
  return {
    selected_term_id: TERM_ID,
    terms: [{ id: TERM_ID, title: quote.schedule.map((s) => s.label).join(" · "), schedules }],
  };
}

/** Whether cancelling is free now, costs something, or costs the whole stay. */
export function refundabilityOf(quote: StayQuote, now: number): UcpPolicy["refundability"] {
  const p = quote.policy;
  const step = p.steps.find((s) => Date.parse(s.until) > now);
  const fee = step ? step.fee.value : p.after.value;
  if (fee <= 0) return "refundable";
  if (fee >= quote.total.value) return "non_refundable";
  return "partially_refundable";
}

/** The quote's policy as UCP's cancellation policy: the sentence its guests read, and its steps as data. */
export function ucpPoliciesOf(quote: StayQuote, setup: PropertySetup, lang: StayLang, now: number): UcpPolicy[] {
  const p = quote.policy;
  const place = setup.property.locality?.trim();
  return [
    {
      type: CANCELLATION,
      description: {
        plain: policySentence(p, { lang, total: quote.total, what: "stay", ...(place ? { place } : {}) }),
      },
      refundability: refundabilityOf(quote, now),
      dated_steps: {
        zone: p.zone,
        steps: p.steps.map((s) => ({ until: s.until, fee: s.fee.value })),
        after: p.after.value,
        no_show: p.noShow.value,
      },
    },
  ];
}

/**
 * The disclosure UCP asks for when the property collects a tax or fee itself: what each is, at what
 * rate (the property's own words), who is exempt, and that it is paid there. Its path is the
 * at_property schedule it is paid in. Null when the property collects nothing itself.
 */
export function ucpLocalTaxOf(
  quote: StayQuote,
  payment: UcpPayment,
  setup: PropertySetup,
  lang: StayLang,
): UcpMessage | null {
  const there = quote.lines.filter((l) => l.collected === "at_property" && l.amount > 0);
  const k = payment.terms[0]?.schedules.findIndex((s) => s.type === "at_property") ?? -1;
  if (!there.length || k < 0) return null;
  const w = UCP_WORDS[lang];
  const notes: string[] = [];
  for (const l of there) {
    const fee = setup.fees.find((f) => f.collected === "at_property" && l.label.startsWith(f.name));
    if (!fee) continue;
    if (fee.childExemptUnder) notes.push(w.exempt(fee.name, fee.childExemptUnder));
    if (fee.maxNights) notes.push(w.maxNights(fee.name, fee.maxNights));
  }
  return {
    type: "warning",
    code: "local_tax",
    path: `$.payment.terms[0].schedules[${k}]`,
    content: [`${w.localTax(setup.property.name)} ${there.map((l) => l.label).join("; ")}.`, ...notes].join(" "),
    content_type: "plain",
    presentation: "disclosure",
  };
}

/** The warning UCP requires when the totals moved during a session. */
export function ucpTotalsChanged(lang: StayLang): UcpMessage {
  return {
    type: "warning",
    code: "totals_changed",
    path: "$.totals",
    content: UCP_WORDS[lang].totalsChanged,
    content_type: "plain",
    presentation: "disclosure",
  };
}

/** Children as UCP counts them: an age bracket per room, closed below the age the property takes children from. */
export function childAgeRanges(setup: PropertySetup): UcpStay["accommodation_type"]["capacity"]["child_age_ranges"] {
  const c = setup.property.children;
  if (!c.welcome) return [{ ages: { min: 0, max: 17 }, limit: 0 }];
  const from = Math.max(0, Math.min(17, c.fromAge ?? 0));
  if (from === 0) return [{ ages: { min: 0, max: 17 } }];
  return [{ ages: { min: 0, max: from - 1 }, limit: 0 }, { ages: { min: from, max: 17 } }];
}

/** One stay of a booking session, as asked for and as priced. */
export interface SubjectRoom {
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly adults: number;
  readonly childrenAges: readonly number[];
}

export interface Subject {
  readonly propertyId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly rooms: readonly SubjectRoom[];
}

export const stayIdOf = (r: Pick<SubjectRoom, "roomTypeId" | "ratePlanId">) => `${r.roomTypeId}__${r.ratePlanId}`;

/** Each room as one of UCP's stays: the room type and its capacity, the rate plan, the guests and the dates. */
export function ucpStaysOf(
  subject: Subject,
  quote: StayQuote,
  setup: PropertySetup,
  lang: StayLang,
  assignments?: readonly (readonly { readonly guest_id: string; readonly role?: string | undefined }[] | undefined)[],
): UcpStay[] {
  const totals = ucpStayTotalsOf(quote, subject.rooms.length);
  const plan = setup.plans.find((p) => p.id === (subject.rooms[0]?.ratePlanId ?? quote.ratePlan.id));
  const place = setup.property.locality?.trim();
  // The rate plan's material terms in its own words, never other than the policy it carries.
  const planWords = [
    ...(quote.includes.length ? quote.includes : [lodgingWord("meals", quote.ratePlan.meal, lang)]),
    policySentence(quote.policy, { lang, total: quote.total, what: "stay", ...(place ? { place } : {}) }),
  ].join(" · ");
  return subject.rooms.map((r, i): UcpStay => {
    const room = setup.rooms.find((x) => x.id === r.roomTypeId);
    const given = assignments?.[i];
    return {
      id: stayIdOf(r),
      accommodation_type: {
        id: r.roomTypeId,
        title: room?.name ?? r.roomTypeId,
        ...(room?.description ? { description: room.description } : {}),
        capacity: {
          adults: room?.capacity.adults ?? 0,
          children: setup.property.children.welcome ? (room?.capacity.children ?? 0) : 0,
          total: room?.capacity.total ?? 0,
          child_age_ranges: childAgeRanges(setup),
        },
      },
      rate_plan: { id: r.ratePlanId, title: plan?.name ?? quote.ratePlan.name, description: planWords },
      occupancy: {
        adults: r.adults,
        children: r.childrenAges.length,
        ...(r.childrenAges.length ? { child_ages: [...r.childrenAges] } : {}),
        total: r.adults + r.childrenAges.length,
      },
      stay_dates: { start_date: subject.checkIn, end_date: subject.checkOut },
      ...(given?.length
        ? { guest_assignments: given.map((a) => ({ guest_id: a.guest_id, ...(a.role ? { role: a.role } : {}) })) }
        : {}),
      totals: totals[i] ?? [],
    };
  });
}

/** Everything a session answer is made of, besides what the request sent. */
export interface BookingParts {
  readonly id: string;
  readonly status: UcpStatus;
  readonly subject: Subject;
  readonly quote: StayQuote;
  readonly setup: PropertySetup;
  readonly lang: StayLang;
  readonly now: number;
  readonly origin: string;
  readonly messages?: readonly UcpMessage[];
  readonly expiresAt?: string | undefined;
  readonly continueUrl?: string | undefined;
  readonly booker?: Record<string, unknown> | undefined;
  readonly guests?: readonly Record<string, unknown>[] | undefined;
  readonly travelPurpose?: string | undefined;
  readonly assignments?: Parameters<typeof ucpStaysOf>[4];
  readonly confirmation?: UcpBooking["confirmation"];
}

/** A booking session as UCP's REST door answers it. */
export function ucpBookingOf(b: BookingParts): UcpBooking {
  const payment = ucpPaymentOf(b.quote, b.setup, b.lang);
  const policies = ucpPoliciesOf(b.quote, b.setup, b.lang, b.now);
  const local = ucpLocalTaxOf(b.quote, payment, b.setup, b.lang);
  const terminal = b.status === "completed" || b.status === "canceled";
  const messages = [
    ...(b.messages ?? []),
    ...(local && !terminal ? [local] : []),
    ...(policies[0]?.refundability === "non_refundable" && !terminal
      ? [
          {
            type: "warning",
            code: CANCELLATION,
            path: "$.policies[0]",
            content: UCP_WORDS[b.lang].nonRefundable,
            content_type: "plain",
            presentation: "disclosure",
          } satisfies UcpMessage,
        ]
      : []),
  ];
  const town = b.setup.property.locality?.trim();
  return {
    ucp: ucpEnvelope(),
    id: b.id,
    status: b.status,
    property: {
      id: b.setup.property.id,
      name: b.setup.property.name,
      ...(town ? { address: { address_locality: town } } : {}),
    },
    stays: ucpStaysOf(b.subject, b.quote, b.setup, b.lang, b.assignments),
    ...(b.booker ? { booker: b.booker } : {}),
    ...(b.guests?.length ? { guests: b.guests } : {}),
    ...(b.travelPurpose ? { travel_purpose: b.travelPurpose } : {}),
    currency: b.quote.currency,
    totals: ucpTotalsOf(b.quote),
    ...(messages.length ? { messages } : {}),
    links: [{ type: "privacy_policy", url: `${b.origin}/c/privacy` }],
    policies,
    ...(b.expiresAt && !terminal ? { expires_at: b.expiresAt } : {}),
    ...(b.continueUrl && !terminal ? { continue_url: b.continueUrl } : {}),
    payment,
    ...(b.confirmation && b.status === "completed" ? { confirmation: b.confirmation } : {}),
  };
}

/** The money facts a UCP booking states, read back as a quote's: what a round trip must give again. */
export interface UcpQuoteFacts {
  readonly currency: string;
  readonly lines: readonly {
    readonly type: QuoteLine["type"];
    readonly label: string;
    readonly amount: number;
    readonly collected: "with_booking" | "at_property";
    readonly nights?: readonly { readonly night: string; readonly amount: number }[];
  }[];
  readonly total: { readonly value: number; readonly currency: string };
  readonly schedule: readonly {
    readonly id: string;
    readonly type: string;
    readonly amount: { readonly value: number; readonly currency: string };
    readonly dueAt?: string;
  }[];
  readonly policy: {
    readonly steps: readonly { readonly until: string; readonly fee: { value: number; currency: string } }[];
    readonly after: { value: number; currency: string };
    readonly noShow: { value: number; currency: string };
    readonly zone: string;
  } | null;
}

/** A UCP booking read back: its subtotal's lines and the other addends as lines, its schedule and its policy. */
export function quoteFromUcp(b: Pick<UcpBooking, "currency" | "totals" | "payment" | "policies">): UcpQuoteFacts {
  const cur = b.currency;
  const lines: UcpQuoteFacts["lines"][number][] = [];
  for (const t of b.totals) {
    if (t.type === "total") continue;
    if (t.type === "subtotal") {
      for (const l of t.lines ?? (t.amount ? [{ display_text: t.display_text ?? "", amount: t.amount }] : [])) {
        const line = l as UcpLine;
        lines.push({
          type: line.kind === "extra" ? "extra" : "subtotal",
          label: line.display_text,
          amount: line.amount,
          collected: line.collected === "at_property" ? "at_property" : "with_booking",
          ...(line.nights?.length ? { nights: line.nights } : {}),
        });
      }
      continue;
    }
    lines.push({
      type: t.type === "tax" ? "tax" : t.type === "discount" ? "discount" : "fee",
      label: t.display_text ?? t.type,
      amount: t.amount,
      collected: t.collected === "at_property" ? "at_property" : "with_booking",
    });
  }
  const total = b.totals.find((t) => t.type === "total")?.amount ?? 0;
  const term = b.payment?.terms.find((x) => x.id === b.payment?.selected_term_id) ?? b.payment?.terms[0];
  const policy = b.policies?.find((p) => p.type === CANCELLATION)?.dated_steps;
  const money = (value: number) => ({ value, currency: cur });
  return {
    currency: cur,
    lines,
    total: money(total),
    schedule: (term?.schedules ?? []).map((s) => ({
      id: s.id,
      type: s.type,
      amount: money(s.amount),
      ...(s.due_at ? { dueAt: s.due_at } : {}),
    })),
    policy: policy
      ? {
          steps: policy.steps.map((s) => ({ until: s.until, fee: money(s.fee) })),
          after: money(policy.after),
          noShow: money(policy.no_show),
          zone: policy.zone,
        }
      : null,
  };
}

/** The node a UCP JSONPath of names and indexes selects (`$.payment.terms[0].schedules[1]`); undefined when none. */
export function nodeAt(root: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  const parts = [...path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)];
  if (parts.map((m) => m[0]).join("") !== path.slice(1)) return undefined;
  let node: unknown = root;
  for (const m of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = m[1] !== undefined ? (node as Record<string, unknown>)[m[1]] : (node as unknown[])[Number(m[2])];
  }
  return node;
}

/**
 * What UCP holds a booking session to, checked as the schema and the specification state it (empty when
 * it holds): the required fields; exactly one subtotal and one total, the addends summing to the total,
 * every entry's lines to the entry, subtotals, taxes and fees never below zero and discounts below it;
 * each stay's totals the same way, and its occupancy adding up; the selected term's schedules summing
 * to the total; every message's path selecting something, and a local tax disclosure's an at_property
 * schedule; continue_url when escalated, a confirmation once completed, and an identified lead once
 * ready, in progress or completed.
 */
export function checkUcpBooking(b: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const f of ["ucp", "id", "status", "property", "stays", "currency", "totals", "links"]) {
    if (!(f in b)) problems.push(`${f} is missing`);
  }
  const checkTotals = (totals: unknown, at: string): void => {
    if (!Array.isArray(totals)) {
      problems.push(`${at} is not a list`);
      return;
    }
    const list = totals as UcpTotal[];
    const subtotals = list.filter((t) => t.type === "subtotal").length;
    const totalsN = list.filter((t) => t.type === "total").length;
    if (subtotals !== 1) problems.push(`${at} has ${subtotals} subtotals, not one`);
    if (totalsN !== 1) problems.push(`${at} has ${totalsN} totals, not one`);
    const total = list.find((t) => t.type === "total")?.amount;
    const addends = list.filter((t) => t.type !== "total").reduce((a, t) => a + t.amount, 0);
    if (total !== undefined && addends !== total) problems.push(`${at} addends sum to ${addends}, not ${total}`);
    list.forEach((t, i) => {
      if (!Number.isInteger(t.amount)) problems.push(`${at}[${i}] is not in minor units`);
      if (["subtotal", "tax", "fee", "fulfillment"].includes(t.type) && t.amount < 0)
        problems.push(`${at}[${i}] (${t.type}) is below zero`);
      if ((t.type === "discount" || t.type === "items_discount") && !(t.amount < 0))
        problems.push(`${at}[${i}] (${t.type}) is not below zero`);
      if (t.lines && sum(t.lines) !== t.amount)
        problems.push(`${at}[${i}] lines sum to ${sum(t.lines)}, not ${t.amount}`);
    });
  };
  checkTotals(b.totals, "totals");
  const stays = Array.isArray(b.stays) ? (b.stays as Record<string, unknown>[]) : [];
  if (!stays.length) problems.push("stays is empty");
  stays.forEach((s, i) => {
    for (const f of ["id", "stay_dates", "accommodation_type", "rate_plan", "totals"])
      if (!(f in s)) problems.push(`stays[${i}].${f} is missing`);
    checkTotals(s.totals, `stays[${i}].totals`);
    const o = s.occupancy as { adults?: number; children?: number; child_ages?: number[]; total: number } | undefined;
    if (o) {
      if ((o.adults !== undefined || o.children !== undefined) && (o.adults ?? 0) + (o.children ?? 0) !== o.total)
        problems.push(`stays[${i}].occupancy does not add up`);
      if (o.child_ages && o.child_ages.length !== (o.children ?? 0))
        problems.push(`stays[${i}].occupancy.child_ages does not match children`);
    }
    const d = s.stay_dates as { start_date?: string; end_date?: string } | undefined;
    if (d && !(String(d.end_date) >= String(d.start_date)))
      problems.push(`stays[${i}].stay_dates end before they start`);
  });
  const payment = b.payment as UcpPayment | undefined;
  const total = (b.totals as UcpTotal[] | undefined)?.find?.((t) => t.type === "total")?.amount;
  if (payment?.terms) {
    const term = payment.terms.find((t) => t.id === payment.selected_term_id);
    if (!term) problems.push("payment.selected_term_id names no term");
    else if (total !== undefined && sum(term.schedules) !== total)
      problems.push(`the selected term's schedules sum to ${sum(term.schedules)}, not ${total}`);
    for (const t of payment.terms)
      for (const s of t.schedules) if (!s.description?.plain) problems.push(`schedule ${s.id} says nothing of when`);
  }
  for (const m of (b.messages as UcpMessage[] | undefined) ?? []) {
    if (m.path && nodeAt(b, m.path) === undefined) problems.push(`message ${m.code} points at nothing (${m.path})`);
    if (m.code === "local_tax") {
      const node = m.path ? (nodeAt(b, m.path) as UcpSchedule | undefined) : undefined;
      if (node?.type !== "at_property")
        problems.push("the local_tax disclosure does not point at an at_property schedule");
      if (m.presentation !== "disclosure") problems.push("the local_tax warning is not a disclosure");
    }
    if (m.type === "error" && !m.severity) problems.push(`error ${m.code} has no severity`);
  }
  if (b.status === "requires_escalation") {
    if (!b.continue_url) problems.push("requires_escalation without continue_url");
    const handoff = ((b.messages as UcpMessage[] | undefined) ?? []).some(
      (m) => m.severity === "requires_buyer_input" || m.severity === "requires_buyer_review",
    );
    if (!handoff) problems.push("requires_escalation without a requires_buyer_* message");
  }
  if (b.status === "completed" && !(b.confirmation as { id?: string } | undefined)?.id)
    problems.push("completed without a confirmation");
  if (b.status === "complete_in_progress" && b.confirmation) problems.push("complete_in_progress with a confirmation");
  if (b.status === "ready_for_complete" || b.status === "complete_in_progress" || b.status === "completed") {
    if (!hasLead(b)) problems.push(`${String(b.status)} without an identified lead`);
  }
  return problems;
}

/** UCP's floor for a session that is ready or done: a booker, or a primary guest, named and reachable. */
function hasLead(b: Record<string, unknown>): boolean {
  const named = (p: Record<string, unknown> | undefined) => !!p && "first_name" in p && "last_name" in p;
  const reach = (p: Record<string, unknown> | undefined) => !!p && ("email" in p || "phone_number" in p);
  const booker = b.booker as Record<string, unknown> | undefined;
  if (named(booker) && reach(booker)) return true;
  const guests = (b.guests as Record<string, unknown>[] | undefined) ?? [];
  const stays = (b.stays as UcpStay[] | undefined) ?? [];
  const primary = new Set(
    stays.flatMap((s) => (s.guest_assignments ?? []).filter((a) => a.role === "primary").map((a) => a.guest_id)),
  );
  const leads = guests.filter((g) => primary.has(String(g.id)) && named(g));
  return leads.some(reach) || (leads.length > 0 && reach(booker));
}

// ---- requests ------------------------------------------------------------------------

const ucpId = z.string().min(1).max(160);
const name = z.string().trim().max(100);

const occupancySchema = z
  .object({
    adults: z.int().min(0).max(20).optional(),
    children: z.int().min(0).max(10).optional(),
    child_ages: z.array(z.int().min(0).max(17)).max(10).optional(),
    total: z.int().min(1).max(30),
  })
  .loose();

const stayRequest = z
  .object({
    id: ucpId.optional(),
    accommodation_type: z.object({ id: ucpId.optional() }).loose().optional(),
    rate_plan: z.object({ id: ucpId.optional() }).loose().optional(),
    occupancy: occupancySchema.optional(),
    stay_dates: z.object({ start_date: z.iso.date(), end_date: z.iso.date() }).loose(),
    guest_assignments: z
      .array(z.object({ guest_id: ucpId, role: z.string().max(40).optional() }).loose())
      .max(40)
      .optional(),
  })
  .loose();

const guestSchema = z
  .object({
    id: ucpId,
    first_name: name.optional(),
    last_name: name.optional(),
    email: z.string().trim().max(254).optional(),
    phone_number: z.string().trim().max(40).optional(),
    age: z.int().min(0).max(130).optional(),
  })
  .loose();

const bookerSchema = z
  .object({
    first_name: name.optional(),
    last_name: name.optional(),
    email: z.string().trim().max(254).optional(),
    phone_number: z.string().trim().max(40).optional(),
    company: z.string().max(200).optional(),
  })
  .loose();

/** Create and Update (a full replacement) send the same: the property, its stays, and who is coming. */
export const ucpSessionRequest = z
  .object({
    property: z.object({ id: ucpId }).loose(),
    stays: z.array(stayRequest).min(1).max(9),
    booker: bookerSchema.optional(),
    guests: z.array(guestSchema).max(40).optional(),
    travel_purpose: z.string().max(40).optional(),
    context: z
      .object({ language: z.string().max(35).optional() })
      .loose()
      .optional(),
  })
  .loose();
export type UcpSessionRequest = z.infer<typeof ucpSessionRequest>;

const path = (i: number, rest = "") => `$.stays[${i}]${rest}`;

/**
 * A session request as the stay it asks for, checked against the property: each stay a room type and a
 * rate plan it offers guests, the same dates and one rate plan for every room, the guests adding up and
 * fitting the room, and every guest assigned one the request names. Messages, with UCP's paths, otherwise.
 */
export function subjectOf(
  req: UcpSessionRequest,
  setup: PropertySetup,
): { subject: Subject } | { messages: UcpMessage[] } {
  const messages: UcpMessage[] = [];
  const rooms: SubjectRoom[] = [];
  const first = req.stays[0];
  const ids = new Set((req.guests ?? []).map((g) => g.id));
  req.stays.forEach((s, i) => {
    const [fromId, planFromId] = s.id?.includes("__") ? s.id.split("__") : [undefined, undefined];
    const roomTypeId = s.accommodation_type?.id ?? fromId;
    const ratePlanId = s.rate_plan?.id ?? planFromId;
    if (!roomTypeId || !ratePlanId) {
      messages.push(
        error("invalid", "Name the accommodation_type and the rate_plan (or the stay id).", "recoverable", path(i)),
      );
      return;
    }
    const room = setup.rooms.find((r) => r.id === roomTypeId && r.active && r.offered);
    if (!room) {
      messages.push(
        error("not_found", "No such accommodation type here.", "recoverable", path(i, ".accommodation_type.id")),
      );
      return;
    }
    const plan = setup.plans.find(
      (p) =>
        p.id === ratePlanId && p.active && p.offered && (p.roomTypeIds === null || p.roomTypeIds.includes(room.id)),
    );
    if (!plan) {
      messages.push(
        error("not_found", "No such rate plan for this accommodation type.", "recoverable", path(i, ".rate_plan.id")),
      );
      return;
    }
    if (
      first &&
      (s.stay_dates.start_date !== first.stay_dates.start_date || s.stay_dates.end_date !== first.stay_dates.end_date)
    ) {
      messages.push(
        error("invalid", "Every stay of one booking has the same dates here.", "recoverable", path(i, ".stay_dates")),
      );
    }
    if (i > 0 && rooms[0] && rooms[0].ratePlanId !== ratePlanId) {
      messages.push(
        error(
          "invalid",
          "Every stay of one booking is on one rate plan here.",
          "recoverable",
          path(i, ".rate_plan.id"),
        ),
      );
    }
    const o = s.occupancy;
    if (!o) {
      messages.push(error("invalid", "Say who stays in each room (occupancy).", "recoverable", path(i, ".occupancy")));
      return;
    }
    const ages = o.child_ages ?? [];
    const children = o.children ?? ages.length;
    const adults = o.adults ?? o.total - children;
    if (adults + children !== o.total || adults < 0) {
      messages.push(error("invalid", "occupancy.total is adults plus children.", "recoverable", path(i, ".occupancy")));
      return;
    }
    if (ages.length !== children) {
      messages.push(
        error(
          "invalid",
          "Give each child's age on arrival (child_ages): it decides the price.",
          "recoverable",
          path(i, ".occupancy.child_ages"),
        ),
      );
      return;
    }
    if (adults < 1) {
      messages.push(
        error("invalid", "At least one adult stays in each room.", "recoverable", path(i, ".occupancy.adults")),
      );
      return;
    }
    const c = setup.property.children;
    const tooYoung = ages.some((a) => a < (c.fromAge ?? 0));
    if (
      adults > room.capacity.adults ||
      children > (c.welcome ? room.capacity.children : 0) ||
      o.total > room.capacity.total ||
      (children > 0 && tooYoung)
    ) {
      messages.push(
        error(
          "occupancy_exceeded_capacity",
          `${room.name} sleeps ${room.capacity.total} (${room.capacity.adults} adults${c.welcome ? `, ${room.capacity.children} children${c.fromAge ? ` from ${c.fromAge}` : ""}` : ", no children"}).`,
          "recoverable",
          path(i),
        ),
      );
      return;
    }
    (s.guest_assignments ?? []).forEach((a, j) => {
      if (!ids.has(a.guest_id))
        messages.push(
          error(
            "invalid",
            "Every guest assigned is one in guests[].",
            "recoverable",
            path(i, `.guest_assignments[${j}].guest_id`),
          ),
        );
    });
    rooms.push({ roomTypeId: room.id, ratePlanId: plan.id, adults, childrenAges: ages });
  });
  if (messages.length || !first) return { messages };
  return {
    subject: {
      propertyId: setup.property.id,
      checkIn: first.stay_dates.start_date,
      checkOut: first.stay_dates.end_date,
      rooms,
    },
  };
}

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

/** Who the property books the stay for: the lead's name and how to reach them, and the others' names. */
export interface Lead {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly others: readonly string[];
}

/**
 * The lead UCP requires before a session is ready: a booker named and reachable, a primary guest named and
 * reachable, or a booker who is reachable with a primary guest who is named. Null when there is none yet;
 * a message when an address cannot be one. Guests' ids are only matched here, never kept.
 */
export function leadOf(req: UcpSessionRequest): Lead | null | { messages: UcpMessage[] } {
  const full = (p?: { first_name?: string | undefined; last_name?: string | undefined }) =>
    p?.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : null;
  for (const [where, email] of [
    ["$.booker.email", req.booker?.email],
    ...(req.guests ?? []).map((g, i) => [`$.guests[${i}].email`, g.email] as const),
  ] as const) {
    if (email && !EMAIL.test(email))
      return { messages: [error("invalid", "Not an email address.", "recoverable", where)] };
  }
  const primaryIds = new Set(
    req.stays.flatMap((s) => (s.guest_assignments ?? []).filter((a) => a.role === "primary").map((a) => a.guest_id)),
  );
  const primary = (req.guests ?? []).find((g) => primaryIds.has(g.id) && full(g));
  const reach = (p?: { email?: string | undefined; phone_number?: string | undefined }) =>
    p?.email || p?.phone_number
      ? { ...(p.email ? { email: p.email } : {}), ...(p.phone_number ? { phone: p.phone_number } : {}) }
      : null;
  const others = (req.guests ?? [])
    .filter((g) => g !== primary)
    .map((g) => full(g))
    .filter((n): n is string => !!n);
  const bookerName = full(req.booker);
  const bookerReach = reach(req.booker);
  if (primary && reach(primary)) {
    return { name: full(primary) as string, ...(reach(primary) as object), others };
  }
  if (bookerName && bookerReach) {
    return { name: primary ? (full(primary) as string) : bookerName, ...bookerReach, others };
  }
  if (primary && bookerReach) return { name: full(primary) as string, ...bookerReach, others };
  return null;
}

// ---- the session id ---------------------------------------------------------------------

/**
 * A booking session's id: sealed by the inbox's own secret, so nobody can make one or read it, and it
 * carries no name, address or age in the clear. It holds the session's nonce (the scope its holds are
 * found by), what its first request asked for, the fingerprint of the totals then, and when.
 */
interface Seal {
  readonly v: 1;
  readonly n: string;
  readonly p: string;
  readonly ci: string;
  readonly co: string;
  readonly r: readonly (readonly [string, string, number, readonly number[]])[];
  readonly t: string;
  readonly iat: number;
  /** The language the session was made in, for its answers until a stay carries its own. */
  readonly l?: string;
}

const SEAL_ROW = "ucp-lodging:session";
const SEAL_PURPOSE = "idempotent-response" as const;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The fingerprint of a quote's money: its lines, its total and its schedule. */
export async function totalsDigest(quote: StayQuote): Promise<string> {
  return (
    await sha256Hex(
      JSON.stringify([
        quote.currency,
        quote.lines.map((l) => [l.type, l.amount, l.collected]),
        quote.total.value,
        quote.schedule.map((s) => [s.type, s.amount.value, s.dueAt ?? null]),
      ]),
    )
  ).slice(0, 24);
}

export async function sealSession(box: SecretBox, s: Seal): Promise<string> {
  return `bks_${await box.seal(SEAL_PURPOSE, SEAL_ROW, JSON.stringify(s))}`;
}

export async function openSession(box: SecretBox, id: string): Promise<Seal | null> {
  if (!id.startsWith("bks_") || id.length > 4096) return null;
  try {
    const s = JSON.parse(await box.open(SEAL_PURPOSE, SEAL_ROW, id.slice(4))) as Seal;
    return s.v === 1 && typeof s.n === "string" && Array.isArray(s.r) ? s : null;
  } catch {
    return null;
  }
}

const subjectOfSeal = (s: Seal): Subject => ({
  propertyId: s.p,
  checkIn: s.ci,
  checkOut: s.co,
  rooms: s.r.map(([roomTypeId, ratePlanId, adults, ages]) => ({ roomTypeId, ratePlanId, adults, childrenAges: ages })),
});

const sealRooms = (subject: Subject): Seal["r"] =>
  subject.rooms.map((r) => [r.roomTypeId, r.ratePlanId, r.adults, [...r.childrenAges]] as const);

// ---- the doors ---------------------------------------------------------------------------

export interface UcpLodgingDeps {
  readonly db: Db;
  readonly caps: Capabilities;
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

const CAPABILITY_DOCS = {
  [BOOKING]: {
    spec: `${DRAFT}/specification/lodging/booking`,
    schema: `${DRAFT}/schemas/lodging/booking.json`,
  },
  [PAYMENT_TERMS]: {
    spec: `${DRAFT}/specification/payment-terms`,
    schema: `${DRAFT}/schemas/common/payment_terms.json`,
  },
  [CANCELLATION]: {
    spec: `${DRAFT}/specification/lodging/extensions/cancellation-policy`,
    schema: `${DRAFT}/schemas/lodging/policy_cancellation.json`,
    extends: [BOOKING],
  },
} as const;

/** The business's UCP profile: the lodging REST service at this inbox, its capabilities, no payment handler. */
export function ucpProfileOf(origin: string): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.lodging": [
          {
            version: UCP_VERSION,
            spec: `${DRAFT}/specification/overview`,
            transport: "rest",
            schema: `${DRAFT}/services/lodging/rest.openapi.json`,
            endpoint: `${origin}${UCP_LODGING_PATH}`,
          },
        ],
      },
      capabilities: Object.fromEntries(
        Object.entries(CAPABILITY_DOCS).map(([k, v]) => [k, [{ version: UCP_VERSION, ...v }]]),
      ),
      payment_handlers: {},
    },
  };
}

/** Item states a session reads as booked: nothing more is held, changed or let go through it. */
const BOOKED = new Set(["booking", "awaiting_payment", "confirmed", "checked_in", "completed", "no_show"]);
const ENDED = new Set(["expired", "declined", "cancelled_by_guest", "cancelled_by_property"]);

/**
 * Mounts UCP Lodging's REST binding: the profile at /.well-known/ucp and the booking sessions below
 * `/v1/ucp/lodging`, behind the `/v1` door's caller, limits and signatures. The caller registers it only
 * when INBOX_UCP_LODGING is on.
 */
export function mountUcpLodging(app: Hono<CallerEnv>, deps: UcpLodgingDeps): void {
  const clock = () => (deps.now ? deps.now() : Date.now());
  const db = deps.db;
  const box = () => deps.caps.secrets;
  const origin = (c: Context) => publicOrigin(c.req.raw, deps.baseUrl);
  const answer = (c: Context, body: unknown, status: 200 | 201 | 400 | 403 | 404 | 503 = 200) =>
    c.json(body, status, { "cache-control": "no-store" });
  const fail = (c: Context, messages: UcpMessage[], continueUrl?: string, status: 200 | 400 | 403 | 404 | 503 = 200) =>
    answer(c, ucpErrorBody(messages, continueUrl), status);

  /** Properties a session can be had at: active, and confirming some rooms at once. */
  const servable = async () =>
    (await listProperties(db, { active: true })).filter(
      (p) => p.mode === "allotment" || (p.mode === "connected" && p.instant),
    );

  app.get("/.well-known/ucp", async (c) => {
    if (!box() || !(await servable()).length) return c.json({ error: "not_found", path: "/.well-known/ucp" }, 404);
    return c.json(ucpProfileOf(origin(c)), 200, { "Cache-Control": "public, max-age=60" });
  });

  const base = `${UCP_LODGING_PATH}/booking-sessions`;

  /** The language a session speaks to the guest: theirs, else the property's first, as the stays doors do. */
  const langFor = async (req?: UcpSessionRequest, header?: string, kept?: string | null) => {
    const settings = await readSettings(db);
    const tag =
      req?.context?.language ??
      (header?.split(",")[0]?.split(";")[0]?.trim() || undefined) ??
      kept ??
      settings.stays.languages[0] ??
      settings.business.languages[0] ??
      "en";
    return stayLang(tag || "en");
  };

  /** What the property keeps of the lead: their name, address, phone and language, as on any stay. */
  const contactOf = async (item: Item): Promise<{ name?: string; email?: string; phone?: string; locale?: string }> => {
    const { rows } = await db.client.query({
      sql: "SELECT contact FROM parties WHERE id = ?",
      params: [item.partyId],
      method: "all",
    });
    try {
      return JSON.parse(String(rows[0]?.[0] ?? "{}"));
    } catch {
      return {};
    }
  };

  /** A session's language when the request names none: its stay's, else the one it was made in. */
  const sessionLang = async (c: Context, seal: Seal, item: Item | null) =>
    langFor(undefined, c.req.header("accept-language"), (item ? (await contactOf(item)).locale : undefined) ?? seal.l);

  /** The caller every call of one session acts as: the platform's, in the session's own scope. */
  const sessionCaller = (caller: Caller, n: string, key: string, lang: StayLang): Caller => ({
    ...caller,
    locale: lang,
    idempotency: { scope: `ucp-lodging:${n}`, key },
  });

  /** The stay as its party, as the stay's own pages do: the session's seal is the proof. */
  const asParty = (caller: Caller, item: Item): Caller => ({
    ...caller,
    actor: { ...caller.actor, partyId: item.partyId },
  });

  /** The newest stay this session made, if any. */
  const itemOf = async (n: string, key?: string): Promise<Item | null> => {
    const { rows } = await db.client.query({
      sql: key
        ? "SELECT item_id FROM idempotency_keys WHERE scope = ? AND key = ? AND item_id IS NOT NULL"
        : "SELECT item_id FROM idempotency_keys WHERE scope = ? AND item_id IS NOT NULL ORDER BY item_id DESC LIMIT 1",
      params: key ? [`ucp-lodging:${n}`, key] : [`ucp-lodging:${n}`],
      method: "all",
    });
    const id = rows[0]?.[0];
    if (id === undefined || id === null) return null;
    const [row] = await db.orm
      .select()
      .from(schema.items)
      .where(eq(schema.items.id, String(id)));
    return row ? rowToItem(row) : null;
  };

  /** The rooms priced for this subject, as an offer when they confirm at once; why not, otherwise. */
  const offerFor = async (
    caller: Caller,
    subject: Subject,
  ): Promise<{ offer: { offer_id: string; valid_through: string; quote: StayQuote } } | { messages: UcpMessage[] }> => {
    try {
      const q = await deps.caps.stays.quote(caller, {
        property_id: subject.propertyId,
        check_in: subject.checkIn,
        check_out: subject.checkOut,
        rooms: subject.rooms.map((r) => ({
          room_type_id: r.roomTypeId,
          rate_plan_id: r.ratePlanId,
          adults: r.adults,
          children_ages: [...r.childrenAges],
        })),
      });
      if (q.status === "instant" && q.offer) return { offer: q.offer };
      if (q.status === "unavailable")
        return { messages: [error("inventory_exhausted", q.reason ?? "Those nights are not free.", "unrecoverable")] };
      return {
        messages: [
          error(
            "on_request",
            `These rooms are confirmed by the property itself, within ${q.answers_within_h} hours: send a request through its own doors (request_stay), or continue on its page.`,
            "unrecoverable",
          ),
        ],
      };
    } catch (e) {
      return { messages: messagesOf(e) };
    }
  };

  /** The doors a property keeps closed or elsewhere, said before anything is priced. */
  const shut = async (c: Context): Promise<{ messages: UcpMessage[]; url: string } | null> => {
    const settings = await readSettings(db);
    const there = settings.doorsElsewhere.find((d) => d.itemType === "stay");
    if (there)
      return {
        messages: [error("not_allowed", "This property takes stays on its own booking page.", "unrecoverable")],
        url: there.url,
      };
    if (settings.doors.stay === false)
      return {
        messages: [error("not_allowed", "This property does not take stays through assistants.", "unrecoverable")],
        url: `${origin(c)}/`,
      };
    return null;
  };

  /** What the session's answer says about a stay the inbox holds or booked: its status and where to go on. */
  const fromItem = async (
    c: Context,
    item: Item,
    id: string,
    lang: StayLang,
    extra: {
      messages?: UcpMessage[];
      req?: UcpSessionRequest | undefined;
    } = {},
  ): Promise<UcpBooking | null> => {
    const p = item.payload as StayPayload;
    const setup = await readSetup(db, p.propertyId);
    const quote = p.quote;
    if (!setup || !quote) return null;
    const now = clock();
    const messages = [...(extra.messages ?? [])];
    let status: UcpStatus;
    let continueUrl: string | undefined;
    let expiresAt: string | undefined;
    if (item.state === "held") {
      status = "ready_for_complete";
      expiresAt = p.hold?.until;
    } else if (item.state === "booking") {
      status = "complete_in_progress";
      messages.push({
        type: "info",
        content: `Being written to ${setup.property.name}'s own system; ask again in a moment.`,
      });
    } else if (item.state === "awaiting_payment") {
      expiresAt = p.payments?.dueBy;
      const handoff = await handoffOf(item, setup, lang, now, origin(c));
      if (handoff) {
        status = "requires_escalation";
        continueUrl = handoff.url;
        messages.push(error("payment_required", handoff.words, "requires_buyer_input", "$.payment.terms[0]"));
      } else {
        status = "complete_in_progress";
        messages.push({
          type: "info",
          content: `${setup.property.name} is making its payment page; ask again in a moment.`,
        });
      }
    } else if (BOOKED.has(item.state)) {
      status = "completed";
    } else {
      status = "canceled";
    }
    if (status === "ready_for_complete" || status === "complete_in_progress") continueUrl = `${origin(c)}/`;
    const subject: Subject = {
      propertyId: p.propertyId,
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      rooms: p.rooms.map((r) => ({
        roomTypeId: r.roomTypeId ?? "",
        ratePlanId: r.ratePlanId ?? quote.ratePlan.id ?? "",
        adults: r.adults,
        childrenAges: r.childrenAges,
      })),
    };
    const req = extra.req;
    return ucpBookingOf({
      id,
      status,
      subject,
      quote,
      setup,
      lang,
      now,
      origin: origin(c),
      messages,
      expiresAt,
      continueUrl,
      booker: req?.booker ?? (await bookerOf(item)),
      guests: req?.guests,
      travelPurpose: req?.travel_purpose,
      assignments: req?.stays.map((s) => s.guest_assignments),
      confirmation: { id: item.id, label: item.id.slice(-6).toUpperCase() },
    });
  };

  /** The lead as the property keeps them: their name, and how it reaches them. */
  const bookerOf = async (item: Item): Promise<Record<string, unknown> | undefined> => {
    const contact = await contactOf(item);
    const lead = (item.payload as StayPayload).guests?.lead.name ?? contact.name ?? "";
    const [first, ...rest] = lead.trim().split(/\s+/);
    if (!first) return undefined;
    return {
      first_name: first,
      last_name: rest.join(" "),
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.phone ? { phone_number: contact.phone } : {}),
    };
  };

  /**
   * Where the guest goes to finish a stay waiting for its payment: the property's own page to save a
   * card, when one is asked for, else the property's own payment page for what is due now. Null while
   * that page is still being made.
   */
  const handoffOf = async (
    item: Item,
    setup: PropertySetup,
    lang: StayLang,
    now: number,
    at: string,
  ): Promise<{ url: string; words: string } | null> => {
    const p = item.payload as StayPayload;
    const s = box();
    const until = p.payments?.dueBy;
    const when = until ? whenWords(setup, until, lang) : "";
    const w = UCP_WORDS[lang];
    if (p.payments?.guarantee.status === "requested" && s && until) {
      const tokens = await mintLinks(
        db,
        s,
        {
          itemId: item.id,
          mailKey: `ucp:${item.id}`,
          lang: lang as never,
          termsSha: `stay-card:${item.id}`,
          expiresAt: Date.parse(until) + LINK_GRACE_MS,
          actions: ["stay_card"],
        },
        now,
      );
      const token = tokens.get("stay_card");
      if (token) return { url: linkUrl(at, token), words: w.cardThere(setup.property.name, when) };
    }
    const terms = await deps.caps.stays.terms(item, lang, now);
    const due = terms?.payments.find((x) => x.type === "immediate" && x.status === "due" && x.pay_url);
    const label = p.quote?.schedule.find((x) => x.id === due?.id)?.label ?? "";
    return due?.pay_url ? { url: due.pay_url, words: w.payThere(setup.property.name, label, when) } : null;
  };

  /** A session that holds nothing yet: the rooms priced now, waiting for its lead. */
  const pending = async (
    c: Context,
    seal: Seal,
    id: string,
    subject: Subject,
    offer: { valid_through: string; quote: StayQuote },
    lang: StayLang,
    extra: { status?: UcpStatus; messages?: UcpMessage[]; req?: UcpSessionRequest | undefined } = {},
  ): Promise<UcpBooking | null> => {
    const setup = await readSetup(db, subject.propertyId);
    if (!setup) return null;
    const now = clock();
    const status = extra.status ?? "incomplete";
    const messages = [
      ...(extra.messages ?? []),
      ...(status === "incomplete"
        ? [
            error(
              "lead_guest_required",
              "Name the lead guest (first_name, last_name) with an email or a phone_number, as the booker or as a guest assigned the role primary; the rooms are held then.",
              "recoverable",
              "$.booker",
            ),
          ]
        : []),
    ];
    const req = extra.req;
    return ucpBookingOf({
      id,
      status,
      subject,
      quote: offer.quote,
      setup,
      lang,
      now,
      origin: origin(c),
      messages,
      expiresAt: new Date(Math.min(Date.parse(offer.valid_through), seal.iat + SESSION_LIFE_MS)).toISOString(),
      continueUrl: `${origin(c)}/`,
      booker: req?.booker,
      guests: req?.guests,
      travelPurpose: req?.travel_purpose,
      assignments: req?.stays.map((s) => s.guest_assignments),
    });
  };

  /**
   * The keys a session's holds for one subject and lead are made under: the first, and the next ones for
   * a hold made again after the one before lapsed or was let go. The same request again is the same hold.
   */
  const holdKeys = async (subject: Subject, lead: Lead) => {
    const base = `hold:${(await sha256Hex(JSON.stringify([subject, lead]))).slice(0, 40)}`;
    return [base, ...[2, 3, 4, 5, 6].map((k) => `${base}:${k}`)];
  };

  /** The hold this session already has for this subject and lead, still held; null when there is none. */
  const sameHold = async (n: string, subject: Subject, lead: Lead): Promise<Item | null> => {
    for (const key of await holdKeys(subject, lead)) {
      const item = await itemOf(n, key);
      if (!item) return null;
      if (item.state === "held") return item;
    }
    return null;
  };

  /** Holds the rooms for the lead at the offer just made. Whatever the session held before is let go first. */
  const hold = async (
    caller: Caller,
    n: string,
    subject: Subject,
    lead: Lead,
    offer: { offer_id: string },
    lang: StayLang,
  ): Promise<{ item: Item } | { messages: UcpMessage[] }> => {
    let key: string | null = null;
    for (const k of await holdKeys(subject, lead)) {
      const made = await itemOf(n, k);
      if (made?.state === "held") return { item: made };
      if (!made) {
        key = k;
        break;
      }
    }
    if (!key)
      return {
        messages: [
          error("too_many_holds", "This session held these rooms too often: create a new one.", "unrecoverable"),
        ],
      };
    try {
      const r = await deps.caps.stays.hold(sessionCaller(caller, n, key, lang), {
        property_id: subject.propertyId,
        check_in: subject.checkIn,
        check_out: subject.checkOut,
        rooms: subject.rooms.map((r) => ({
          room_type_id: r.roomTypeId,
          rate_plan_id: r.ratePlanId,
          adults: r.adults,
          children_ages: [...r.childrenAges],
        })),
        guests: { lead: { name: lead.name }, others: lead.others.map((o) => ({ name: o })) },
        contact: {
          name: lead.name,
          ...(lead.email ? { email: lead.email } : {}),
          ...(lead.phone ? { phone: lead.phone } : {}),
          locale: lang,
        },
        // The platform sent the lead's details in a booking session with this property: that is the
        // guest sending them to it, as UCP's flow has it.
        consent: true,
        offer_id: offer.offer_id,
        idempotency_key: key,
      });
      const item = r.view.item;
      if (item.state === "held") return { item };
      // The nights went between the price and the hold: the stays doors leave a request with the
      // property then, which a booking session never asked for. It is withdrawn at once.
      await letGo(caller, n, item, lang, "replaced");
      return { messages: [error("inventory_exhausted", "Those nights went a moment ago.", "recoverable", "$.stays")] };
    } catch (e) {
      return { messages: messagesOf(e) };
    }
  };

  /** Lets a session's stay go: a hold is released, a request withdrawn, a stay waiting for payment cancelled. */
  const letGo = async (
    caller: Caller,
    n: string,
    item: Item,
    lang: StayLang,
    why: "replaced" | "cancelled",
  ): Promise<void> => {
    const key = `${why}:${item.id}`;
    const as = asParty(sessionCaller(caller, n, key, lang), item);
    const event =
      item.state === "held"
        ? "release"
        : item.state === "requested" || item.state === "needs_info" || item.state === "quoted"
          ? "decline"
          : null;
    if (event) {
      await transitionItem(db, as, { itemId: item.id, event }).catch(() => undefined);
    } else if (item.state === "awaiting_payment") {
      await deps.caps.cancelItem(as, { item_id: item.id, idempotency_key: key }).catch(() => undefined);
    }
  };

  /**
   * Where a session stands: its newest stay, or null while it holds nothing — none made yet, or the last
   * one let go because an Update replaced it. A stay that lapsed, or was cancelled, ends the session.
   */
  const stateOf = async (n: string): Promise<Item | null> => {
    const item = await itemOf(n);
    if (item && ENDED.has(item.state) && (await itemOf(n, `replaced:${item.id}`))) return null;
    return item;
  };

  /** The session's seal and its caller, or the answer that there is none. */
  const sessionOf = async (c: Context<CallerEnv>) => {
    const s = box();
    const caller = c.get("caller");
    if (!isCustomer(caller))
      return {
        refused: fail(
          c,
          [error("not_allowed", "Booking sessions are for guests' platforms.", "unrecoverable")],
          undefined,
          403,
        ),
      };
    if (!s)
      return {
        refused: fail(
          c,
          [error("unavailable", "Booking sessions are off on this inbox.", "unrecoverable")],
          undefined,
          503,
        ),
      };
    const id = c.req.param("id") ?? "";
    const seal = id ? await openSession(s, id) : null;
    if (!seal)
      return { refused: fail(c, [error("not_found", "No such booking session.", "unrecoverable")], undefined, 404) };
    return { caller, seal, id };
  };

  const body = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  const parsed = async (c: Context) => {
    const raw = await body(c);
    const r = ucpSessionRequest.safeParse(raw ?? {});
    if (r.success) return { req: r.data };
    const issue = r.error.issues[0];
    const where = `$${(issue?.path ?? []).map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}`;
    return {
      refused: fail(c, [error("invalid", issue?.message ?? "Invalid request.", "recoverable", where)], undefined, 400),
    };
  };

  // Create Booking Session.
  app.post(base, async (c) => {
    const caller = c.get("caller");
    if (!isCustomer(caller))
      return fail(
        c,
        [error("not_allowed", "Booking sessions are for guests' platforms.", "unrecoverable")],
        undefined,
        403,
      );
    const s = box();
    if (!s)
      return fail(
        c,
        [error("unavailable", "Booking sessions are off on this inbox.", "unrecoverable")],
        undefined,
        503,
      );
    const p = await parsed(c);
    if ("refused" in p) return p.refused;
    const req = p.req;
    const lang = await langFor(req, c.req.header("accept-language"));
    const setup = await readSetup(db, req.property.id);
    if (!setup?.property.active)
      return fail(c, [error("not_found", "No such property here.", "unrecoverable", "$.property.id")], `${origin(c)}/`);
    const closed = await shut(c);
    if (closed) return fail(c, closed.messages, closed.url);
    const asked = subjectOf(req, setup);
    if ("messages" in asked) return fail(c, asked.messages, `${origin(c)}/`);
    const idem = c.req.header("idempotency-key");
    const n = idem
      ? b64url(
          new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              await s.mac("stay-offer"),
              new TextEncoder().encode(`ucp-lodging-session\0${scopeFor(caller)}\0${idem}`) as BufferSource,
            ),
          ).slice(0, 16),
        )
      : b64url(crypto.getRandomValues(new Uint8Array(16)));
    const quoted = await offerFor(sessionCaller(caller, n, "quote", lang), asked.subject);
    if ("messages" in quoted) return fail(c, quoted.messages, `${origin(c)}/`);
    const now = clock();
    const seal: Seal = {
      v: 1,
      n,
      p: setup.property.id,
      ci: asked.subject.checkIn,
      co: asked.subject.checkOut,
      r: sealRooms(asked.subject),
      t: await totalsDigest(quoted.offer.quote),
      iat: now,
      l: lang,
    };
    const id = await sealSession(s, seal);
    const lead = leadOf(req);
    if (lead && "messages" in lead) return fail(c, lead.messages);
    if (lead) {
      const held = await hold(caller, n, asked.subject, lead, quoted.offer, lang);
      if ("messages" in held) return fail(c, held.messages, `${origin(c)}/`);
      const out = await fromItem(c, held.item, id, lang, { req });
      return out ? answer(c, out, 201) : fail(c, [error("not_found", "No such property here.", "unrecoverable")]);
    }
    const out = await pending(c, seal, id, asked.subject, quoted.offer, lang, { req });
    return out ? answer(c, out, 201) : fail(c, [error("not_found", "No such property here.", "unrecoverable")]);
  });

  // Get Booking Session.
  app.get(`${base}/:id`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const item = await stateOf(s.seal.n);
    const lang = await sessionLang(c, s.seal, item);
    if (item) {
      const out = await fromItem(c, item, s.id, lang);
      if (out) return answer(c, out);
    }
    return answer(c, await again(c, s.caller, s.seal, s.id, lang));
  });

  /**
   * A session that holds nothing, read again: priced now from its first request (it keeps no state of
   * its own until it holds), or cancelled once its time is up. The totals say whether they moved.
   */
  const again = async (c: Context, caller: Caller, seal: Seal, id: string, lang: StayLang, status?: UcpStatus) => {
    const subject = subjectOfSeal(seal);
    const quoted = await offerFor(sessionCaller(caller, seal.n, "quote", lang), subject);
    if ("messages" in quoted) return ucpErrorBody(quoted.messages, `${origin(c)}/`);
    const expired = clock() > seal.iat + SESSION_LIFE_MS;
    const moved = (await totalsDigest(quoted.offer.quote)) !== seal.t;
    return (
      (await pending(c, seal, id, subject, quoted.offer, lang, {
        status: status ?? (expired ? "canceled" : "incomplete"),
        messages: moved && !expired ? [ucpTotalsChanged(lang)] : [],
      })) ?? ucpErrorBody([error("not_found", "No such property here.", "unrecoverable")])
    );
  };

  // Update Booking Session: a full replacement.
  app.put(`${base}/:id`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const p = await parsed(c);
    if ("refused" in p) return p.refused;
    const req = p.req;
    const live = await stateOf(s.seal.n);
    const lang = req.context?.language ? await langFor(req) : await sessionLang(c, s.seal, live);
    if (live && (BOOKED.has(live.state) || ENDED.has(live.state))) {
      const out = await fromItem(c, live, s.id, lang, {
        messages: [
          error(
            "not_modifiable",
            "This session is booked or ended; it can no longer change. Create a new one.",
            "unrecoverable",
          ),
        ],
      });
      if (out) return answer(c, out);
    }
    if (!live && clock() > s.seal.iat + SESSION_LIFE_MS)
      return answer(c, await again(c, s.caller, s.seal, s.id, lang, "canceled"));
    if (req.property.id !== s.seal.p)
      return fail(c, [
        error("invalid", "A session stays at the property it was made for.", "recoverable", "$.property.id"),
      ]);
    const setup = await readSetup(db, s.seal.p);
    if (!setup?.property.active)
      return fail(c, [error("not_found", "No such property here.", "unrecoverable", "$.property.id")]);
    const asked = subjectOf(req, setup);
    if ("messages" in asked) return fail(c, asked.messages, `${origin(c)}/`);
    const lead = leadOf(req);
    if (lead && "messages" in lead) return fail(c, lead.messages);
    // The same rooms for the same lead: the hold stands, at the terms it was made on.
    const kept = lead ? await sameHold(s.seal.n, asked.subject, lead) : null;
    if (kept) {
      const out = await fromItem(c, kept, s.id, lang, { req });
      if (out) return answer(c, out);
    }
    // Anything else replaces it: what the session held is let go before the rooms are priced again, so
    // its own hold never stands in the way of the new price.
    const heldQuote = live?.state === "held" ? (live.payload as StayPayload).quote : undefined;
    if (live) await letGo(s.caller, s.seal.n, live, lang, "replaced");
    const quoted = await offerFor(sessionCaller(s.caller, s.seal.n, "quote", lang), asked.subject);
    if ("messages" in quoted) return fail(c, quoted.messages, `${origin(c)}/`);
    const before = heldQuote ? await totalsDigest(heldQuote) : s.seal.t;
    const changed = (await totalsDigest(quoted.offer.quote)) !== before ? [ucpTotalsChanged(lang)] : [];
    if (lead) {
      const held = await hold(s.caller, s.seal.n, asked.subject, lead, quoted.offer, lang);
      if ("messages" in held) return fail(c, held.messages, `${origin(c)}/`);
      const out = await fromItem(c, held.item, s.id, lang, { req, messages: changed });
      if (out) return answer(c, out);
    }
    const out = await pending(c, s.seal, s.id, asked.subject, quoted.offer, lang, { req, messages: changed });
    return out ? answer(c, out) : fail(c, [error("not_found", "No such property here.", "unrecoverable")]);
  });

  // Complete Booking Session. Any payment instrument sent is never read: the property takes its own.
  app.post(`${base}/:id/complete`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const item = await stateOf(s.seal.n);
    const lang = await sessionLang(c, s.seal, item);
    if (!item) return answer(c, await again(c, s.caller, s.seal, s.id, lang));
    if (item.state !== "held") {
      const out = await fromItem(c, item, s.id, lang);
      if (out) return answer(c, out);
      return fail(c, [error("not_found", "No such booking session.", "unrecoverable")], undefined, 404);
    }
    const now = clock();
    const terms = await deps.caps.stays.terms(item, lang, now);
    let messages: UcpMessage[] = [];
    let booked: Item = item;
    try {
      const r = await deps.caps.stays.book(asParty(sessionCaller(s.caller, s.seal.n, `book:${item.id}`, lang), item), {
        item_id: item.id,
        ...(terms?.terms_sha ? { terms_sha: terms.terms_sha } : {}),
        idempotency_key: `book:${item.id}`,
      });
      booked = r.view.item;
    } catch (e) {
      messages = messagesOf(e);
      booked = (await stateOf(s.seal.n)) ?? item;
    }
    const out = await fromItem(c, booked, s.id, lang, { messages });
    return out
      ? answer(c, out)
      : fail(c, messages.length ? messages : [error("not_found", "No such booking session.", "unrecoverable")]);
  });

  // Cancel Booking Session.
  app.post(`${base}/:id/cancel`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const item = await stateOf(s.seal.n);
    const lang = await sessionLang(c, s.seal, item);
    if (!item) return answer(c, await again(c, s.caller, s.seal, s.id, lang, "canceled"));
    if (item.state === "booking" || (BOOKED.has(item.state) && item.state !== "awaiting_payment")) {
      const out = await fromItem(c, item, s.id, lang, {
        messages: [
          error(
            item.state === "booking" ? "complete_in_progress" : "not_cancelable",
            item.state === "booking"
              ? "The booking is being written to the property's own system; ask again in a moment."
              : "This stay is booked: cancelling it costs what its policy says now, through cancel_item with its fee_sha, or on the property's own page.",
            item.state === "booking" ? "recoverable" : "unrecoverable",
          ),
        ],
      });
      if (out) return answer(c, out);
    }
    await letGo(s.caller, s.seal.n, item, lang, "cancelled");
    const after = (await stateOf(s.seal.n)) ?? item;
    const out = await fromItem(c, after, s.id, lang);
    return out
      ? answer(c, out)
      : fail(c, [error("not_found", "No such booking session.", "unrecoverable")], undefined, 404);
  });
}

/** What the stays doors refused, as UCP's messages: the codes it knows where one fits. */
export function messagesOf(e: unknown): UcpMessage[] {
  if (!(e instanceof WriteError)) throw e;
  const d = (e.details ?? {}) as { guard?: string; status?: string; reason?: string };
  if (e.code === "guard_failed" && d.guard === "holds")
    return [
      error(
        "too_many_holds",
        "The lead holds two stays here already: book or let one go first.",
        "recoverable",
        "$.booker",
      ),
    ];
  if (e.code === "guard_failed" && d.status === "unavailable")
    return [error("inventory_exhausted", e.message, "unrecoverable")];
  if (e.code === "guard_failed" || e.code === "slot_taken") {
    return d.status === "on_request" || d.reason === "system_unanswered"
      ? [error("on_request", e.message, "unrecoverable")]
      : [error("inventory_exhausted", e.message, "unrecoverable")];
  }
  if (e.code === "offer_changed")
    return [
      error(
        "totals_changed",
        "The price changed a moment ago: update the session to see it.",
        "recoverable",
        "$.totals",
      ),
    ];
  if (e.code === "not_found") return [error("not_found", e.message, "unrecoverable")];
  if (e.code === "not_allowed") return [error("not_allowed", e.message, "unrecoverable")];
  if (e.code === "invalid_input") {
    const f = e.fields?.[0];
    const where = f
      ? f.path.startsWith("rooms.")
        ? `$.stays[${Number(f.path.split(".")[1] ?? 0)}]`
        : f.path === "check_in" || f.path === "check_out"
          ? "$.stays[0].stay_dates"
          : f.path.startsWith("contact")
            ? "$.booker"
            : "$"
      : "$";
    return [error("invalid", f ? `${f.path}: ${f.message}` : e.message, "recoverable", where)];
  }
  return [error(e.code, e.message, "unrecoverable")];
}
