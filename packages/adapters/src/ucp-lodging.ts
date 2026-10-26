import {
  type Caller,
  type Capabilities,
  type Db,
  fillStayTemplate,
  formatMinor,
  type Item,
  isCustomer,
  LINK_GRACE_MS,
  linkUrl,
  listProperties,
  localeOf,
  lodgingWord,
  mintLinks,
  type PayloadOf,
  type PropertySetup,
  policySentence,
  randomToken,
  readSettings,
  readSetup,
  rowToItem,
  type SecretBox,
  STAY_COPY,
  STAY_LANGS,
  type StayLang,
  schema,
  stayLang,
  transitionItem,
  ulid,
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
 * UCP Lodging (ADR-038): a place to stay's instant rooms as the Universal Commerce Protocol's draft
 * booking capability shows them, mapped onto the stays doors. Switched off: nothing here is mounted
 * unless whoever runs the inbox sets INBOX_UCP_LODGING, and the profile says so only while the property
 * has a room it can confirm at once.
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
 *   a stay's `id` is `<room type>__<rate plan>`, with `__2`, `__3` for a second and third room alike.
 *   Every room of one booking has the same dates and the same rate plan here.
 * - Create and Update price the rooms (`quote_stay`). Once a lead guest is named with a way to reach
 *   them, the rooms are held (`hold_stay`) and the session is ready to complete. The hold stands while
 *   the rooms and dates do and the lead is reached the same way (names added later are written on it);
 *   new rooms or dates are priced before the old hold is let go, and a failed change keeps it. Complete
 *   books the held stay (`book_stay`): it is completed, or, where a deposit or a card is due, handed to
 *   the property's own page (continue_url). Cancel lets a hold go, or cancels a stay still waiting for
 *   its payment.
 * - totals[]: one subtotal (the rooms, and any extras, as its lines), every fee, tax and discount, and
 *   one total; the addends sum to it. payment.terms[0].schedules[] is the quote's schedule, with the
 *   same three types. policies[] is the quote's dated policy, in words and as its steps.
 * - messages[]: `local_tax` (a disclosure, its path the at_property schedule) for every charge the
 *   property collects itself; the cancellation policy as a disclosure whenever cancelling can cost
 *   anything; `totals_changed`; `inventory_exhausted`; `occupancy_exceeded_capacity`.
 * - A session is a row of its own (`ucp_sessions`): the hash of its id, the stay it holds, and its last
 *   request sealed, so the guests' ids the platform sent come back in every answer and are kept nowhere
 *   else. It lives as long as its stay, and goes with it when the guest is erased.
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
 * The version every answer names. The lodging draft has no dated release of its own, and 2026-08-25 (the
 * newest dated one) does not define it: until lodging ships in a dated release the schema links point at
 * the draft, and this line moves then (ADR-038 §7).
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

/** How long a session that never held a room can be used. Its row goes a day after that. */
export const SESSION_LIFE_MS = 24 * 3_600_000;

/** How many holds one session may make: the first, and a few more for changes of rooms, dates or lead. */
export const MAX_SESSION_HOLDS = 6;

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
 * payment is due, what the property collects itself, that the price moved, and where to go on. Every
 * deadline says whose time it is in. Error messages are for the platform and its agent, in English,
 * short. None of these names anything but the property.
 */
interface Words {
  readonly dueNow: (label: string) => string;
  readonly dueBy: (label: string, when: string, place: string) => string;
  readonly dueLater: (label: string) => string;
  readonly atProperty: (label: string, property: string) => string;
  readonly localTax: (property: string) => string;
  readonly exempt: (age: number) => string;
  readonly maxNights: (nights: number) => string;
  readonly totalsChanged: string;
  readonly nonRefundable: string;
  readonly payThere: (property: string, label: string, when: string, place: string) => string;
  readonly cardThere: (property: string, when: string, place: string) => string;
  readonly confirming: (property: string) => string;
  readonly preparingPayment: (property: string) => string;
}

export const UCP_WORDS: Readonly<Record<StayLang, Words>> = {
  en: {
    dueNow: (l) => `${l}: due when you book.`,
    dueBy: (l, w, p) => `${l}: due by ${w}, ${p} time.`,
    dueLater: (l) => `${l}: due before arrival.`,
    atProperty: (l, p) => `${l}: paid to ${p} directly, not with the booking.`,
    localTax: (p) => `Paid to ${p} at the property, not with the booking:`,
    exempt: (a) => `children under ${a} exempt`,
    maxNights: (k) => `at most ${k} nights`,
    totalsChanged: "The price has changed since you last saw it. The total shown now is the one that applies.",
    nonRefundable: "This stay cannot be refunded once it is booked.",
    payThere: (p, l, w, place) =>
      `${l}: paid on ${p}'s own payment page by ${w}, ${place} time. Continue there to confirm the stay.`,
    cardThere: (p, w, place) =>
      `${p} asks for a card to guarantee the stay, saved on its own payment page by ${w}, ${place} time. Nothing is charged now.`,
    confirming: (p) => `${p} is confirming the stay in its own system; ask again in a moment.`,
    preparingPayment: (p) => `${p} is preparing its payment page; ask again in a moment.`,
  },
  es: {
    dueNow: (l) => `${l}: se paga al reservar.`,
    dueBy: (l, w, p) => `${l}: se paga antes del ${w}, hora de ${p}.`,
    dueLater: (l) => `${l}: se paga antes de la llegada.`,
    atProperty: (l, p) => `${l}: se paga directamente a ${p}, no con la reserva.`,
    localTax: (p) => `Se paga a ${p} en el alojamiento, no con la reserva:`,
    exempt: (a) => `exentos los menores de ${a} años`,
    maxNights: (k) => `como máximo ${k} noches`,
    totalsChanged: "El precio cambió desde la última vez: los importes que se muestran ahora son los que valen.",
    nonRefundable: "Esta estancia no se reembolsa una vez reservada.",
    payThere: (p, l, w, place) =>
      `${l}: se paga en la página de pago de ${p} antes del ${w}, hora de ${place}. Continúe allí para confirmar la estancia.`,
    cardThere: (p, w, place) =>
      `${p} pide una tarjeta para garantizar la estancia, guardada en su propia página de pago antes del ${w}, hora de ${place}. Ahora no se cobra nada.`,
    confirming: (p) => `${p} está confirmando la estancia en su propio sistema; vuelva a consultar en un momento.`,
    preparingPayment: (p) => `${p} está preparando su página de pago; vuelva a consultar en un momento.`,
  },
  fr: {
    dueNow: (l) => `${l} : à régler à la réservation.`,
    dueBy: (l, w, p) => `${l} : à régler avant le ${w}, heure de ${p}.`,
    dueLater: (l) => `${l} : à régler avant l'arrivée.`,
    atProperty: (l, p) => `${l} : à régler directement à ${p}, pas avec la réservation.`,
    localTax: (p) => `À régler à ${p} sur place, pas avec la réservation :`,
    exempt: (a) => `enfants de moins de ${a} ans exonérés`,
    maxNights: (k) => `${k} nuits au plus`,
    totalsChanged: "Le prix a changé depuis la dernière fois : les montants affichés maintenant sont ceux qui valent.",
    nonRefundable: "Ce séjour n'est pas remboursable une fois réservé.",
    payThere: (p, l, w, place) =>
      `${l} : à régler sur la page de paiement de ${p} avant le ${w}, heure de ${place}. Continuez-y pour confirmer le séjour.`,
    cardThere: (p, w, place) =>
      `${p} demande une carte pour garantir le séjour, enregistrée sur sa propre page de paiement avant le ${w}, heure de ${place}. Rien n'est débité maintenant.`,
    confirming: (p) => `${p} confirme le séjour dans son propre système ; redemandez dans un instant.`,
    preparingPayment: (p) => `${p} prépare sa page de paiement ; redemandez dans un instant.`,
  },
  de: {
    dueNow: (l) => `${l}: fällig bei der Buchung.`,
    dueBy: (l, w, p) => `${l}: fällig bis ${w}, Ortszeit ${p}.`,
    dueLater: (l) => `${l}: vor der Ankunft fällig.`,
    atProperty: (l, p) => `${l}: direkt an ${p} zu zahlen, nicht mit der Buchung.`,
    localTax: (p) => `Vor Ort an ${p} zu zahlen, nicht mit der Buchung:`,
    exempt: (a) => `Kinder unter ${a} Jahren befreit`,
    maxNights: (k) => `höchstens ${k} Nächte`,
    totalsChanged: "Der Preis hat sich seitdem geändert: Es gelten die Beträge, die jetzt angezeigt werden.",
    nonRefundable: "Dieser Aufenthalt wird nach der Buchung nicht erstattet.",
    payThere: (_p, l, w, place) =>
      `${l}: bis ${w}, Ortszeit ${place}, auf der Zahlungsseite der Unterkunft zu zahlen. Dort wird der Aufenthalt bestätigt.`,
    cardThere: (p, w, place) =>
      `${p} bittet um eine Karte zur Sicherung des Aufenthalts, hinterlegt bis ${w}, Ortszeit ${place}, auf der Zahlungsseite der Unterkunft; jetzt wird nichts belastet.`,
    confirming: (p) => `${p} bestätigt den Aufenthalt im eigenen System; fragen Sie gleich noch einmal.`,
    preparingPayment: (p) => `${p} bereitet die Zahlungsseite vor; fragen Sie gleich noch einmal.`,
  },
  it: {
    dueNow: (l) => `${l}: da pagare alla prenotazione.`,
    dueBy: (l, w, p) => `${l}: da pagare entro il ${w}, ora di ${p}.`,
    dueLater: (l) => `${l}: da pagare prima dell'arrivo.`,
    atProperty: (l, p) => `${l}: da pagare direttamente a ${p}, non con la prenotazione.`,
    localTax: (p) => `Da pagare a ${p} sul posto, non con la prenotazione:`,
    exempt: (a) => `esenti i bambini sotto i ${a} anni`,
    maxNights: (k) => `al massimo ${k} notti`,
    totalsChanged: "Il prezzo è cambiato dall'ultima volta: valgono gli importi mostrati ora.",
    nonRefundable: "Questo soggiorno non è rimborsabile una volta prenotato.",
    payThere: (p, l, w, place) =>
      `${l}: da pagare sulla pagina di pagamento di ${p} entro il ${w}, ora di ${place}. Continui lì per confermare il soggiorno.`,
    cardThere: (p, w, place) =>
      `${p} chiede una carta a garanzia del soggiorno, salvata sulla sua pagina di pagamento entro il ${w}, ora di ${place}. Ora non viene addebitato nulla.`,
    confirming: (p) => `${p} sta confermando il soggiorno nel proprio sistema; chieda di nuovo tra un momento.`,
    preparingPayment: (p) => `${p} sta preparando la pagina di pagamento; chieda di nuovo tra un momento.`,
  },
  pt: {
    dueNow: (l) => `${l}: a pagar na reserva.`,
    dueBy: (l, w, p) => `${l}: a pagar até ${w}, hora de ${p}.`,
    dueLater: (l) => `${l}: a pagar antes da chegada.`,
    atProperty: (l, p) => `${l}: a pagar diretamente a ${p}, não com a reserva.`,
    localTax: (p) => `A pagar a ${p} no alojamento, não com a reserva:`,
    exempt: (a) => `isentas as crianças com menos de ${a} anos`,
    maxNights: (k) => `no máximo ${k} noites`,
    totalsChanged: "O preço mudou desde a última vez: valem os valores mostrados agora.",
    nonRefundable: "Esta estadia não é reembolsável depois de reservada.",
    payThere: (p, l, w, place) =>
      `${l}: a pagar na página de pagamento de ${p} até ${w}, hora de ${place}. Continue lá para confirmar a estadia.`,
    cardThere: (p, w, place) =>
      `${p} pede um cartão para garantir a estadia, guardado na sua própria página de pagamento até ${w}, hora de ${place}. Nada é cobrado agora.`,
    confirming: (p) => `${p} está a confirmar a estadia no seu próprio sistema; pergunte novamente daqui a pouco.`,
    preparingPayment: (p) => `${p} está a preparar a página de pagamento; pergunte novamente daqui a pouco.`,
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
    w.exempt(12),
    w.maxNights(7),
    w.totalsChanged,
    w.nonRefundable,
    w.payThere("Ryokan Hoshi", "Deposit", "9 Dec, 10:00", "Kyoto"),
    w.cardThere("Ryokan Hoshi", "9 Dec, 10:00", "Kyoto"),
    w.confirming("Ryokan Hoshi"),
    w.preparingPayment("Ryokan Hoshi"),
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

/** A quote line's label without the "(paid at the property)" its quote added, in whichever language. */
function withoutAtProperty(label: string): string {
  for (const lang of STAY_LANGS) {
    const tag = ` ${STAY_COPY[lang].paidAtProperty}`;
    if (label.endsWith(tag)) return label.slice(0, -tag.length);
  }
  return label;
}

/**
 * The fee of the property's own that a quote line is: its name exactly, or its name and then the rate
 * the quote wrote after it (", ¥400 per guest per night", " 2%"). The longest name wins, so "City tax
 * surcharge" is never read as "City tax".
 */
function feeOfLine(setup: PropertySetup, label: string): PropertySetup["fees"][number] | undefined {
  return setup.fees
    .filter((f) => f.collected === "at_property")
    .filter(
      (f) =>
        label === f.name ||
        label.startsWith(`${f.name}, `) ||
        (label.startsWith(`${f.name} `) && /^[\d.]+%$/.test(label.slice(f.name.length + 1))),
    )
    .sort((x, y) => y.name.length - x.name.length)[0];
}

/**
 * The disclosure UCP asks for when the property collects a tax or fee itself: what each is, at what
 * rate (the property's own words, and a fee per stay's amount), who is exempt and for how many nights,
 * and that it is paid there, said once. Its path is the at_property schedule it is paid in. Null when
 * the property collects nothing itself.
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
  const each = there.map((l) => {
    const label = withoutAtProperty(l.label);
    const fee = feeOfLine(setup, label);
    if (!fee) return label;
    const rate =
      label === fee.name && fee.basis === "per_stay" && fee.amount !== null
        ? `, ${formatMinor({ value: fee.amount, currency: quote.currency }, localeOf(lang))} ${lodgingWord("fee_bases", "per_stay", lang).toLowerCase()}`
        : "";
    const notes = [
      ...(fee.childExemptUnder ? [w.exempt(fee.childExemptUnder)] : []),
      ...(fee.maxNights ? [w.maxNights(fee.maxNights)] : []),
    ];
    return `${label}${rate}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  return {
    type: "warning",
    code: "local_tax",
    path: `$.payment.terms[0].schedules[${k}]`,
    content: `${w.localTax(setup.property.name)} ${each.join("; ")}.`,
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

/**
 * A stay's id: its room type and rate plan, and for a second or third room alike `__2`, `__3`, so two
 * doubles of one family are two stays, never one.
 */
export function stayIdsOf(rooms: readonly Pick<SubjectRoom, "roomTypeId" | "ratePlanId">[]): string[] {
  const seen = new Map<string, number>();
  return rooms.map((r) => {
    const base = `${r.roomTypeId}__${r.ratePlanId}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}__${n}`;
  });
}

/** Each room as one of UCP's stays: the room type and its capacity, the rate plan, the guests and the dates. */
export function ucpStaysOf(
  subject: Subject,
  quote: StayQuote,
  setup: PropertySetup,
  lang: StayLang,
  assignments?: readonly (readonly { readonly guest_id: string; readonly role?: string | undefined }[] | undefined)[],
): UcpStay[] {
  const totals = ucpStayTotalsOf(quote, subject.rooms.length);
  const ids = stayIdsOf(subject.rooms);
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
      id: ids[i] ?? `${r.roomTypeId}__${r.ratePlanId}`,
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

/**
 * The cancellation policy as a disclosure, whenever cancelling can cost anything (a step with a fee,
 * a fee after the last, or one for not arriving): UCP obliges a platform to show a policy only when a
 * disclosure names it, and the guest's yes is to these terms (ADR-038 §4). Its path is the booking.
 */
export function cancellationDisclosure(
  quote: StayQuote,
  policy: UcpPolicy | undefined,
  lang: StayLang,
): UcpMessage | null {
  const p = quote.policy;
  const costs = p.steps.some((s) => s.fee.value > 0) || p.after.value > 0 || p.noShow.value > 0;
  if (!costs || !policy) return null;
  return {
    type: "warning",
    code: CANCELLATION,
    path: "$",
    content:
      policy.refundability === "non_refundable"
        ? `${UCP_WORDS[lang].nonRefundable} ${policy.description.plain}`
        : policy.description.plain,
    content_type: "plain",
    presentation: "disclosure",
  };
}

/** A booking session as UCP's REST door answers it. */
export function ucpBookingOf(b: BookingParts): UcpBooking {
  const payment = ucpPaymentOf(b.quote, b.setup, b.lang);
  const policies = ucpPoliciesOf(b.quote, b.setup, b.lang, b.now);
  const local = ucpLocalTaxOf(b.quote, payment, b.setup, b.lang);
  const terminal = b.status === "completed" || b.status === "canceled";
  const cancellation = cancellationDisclosure(b.quote, policies[0], b.lang);
  const messages = [
    ...(b.messages ?? []),
    ...(local && !terminal ? [local] : []),
    ...(cancellation && !terminal ? [cancellation] : []),
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
 * to the total; every message's path selecting something (an error's may name a member still to be
 * given, in an object that is there), and a local tax disclosure's an at_property schedule; continue_url when escalated, a confirmation once completed, and an identified lead once
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
    // An error may name a member still to be given (`$.booker` while there is none): its parent is there.
    // Anything else points at what is there.
    const parent = m.path?.replace(/\.[A-Za-z_][A-Za-z0-9_]*$/, "");
    const named =
      m.path &&
      (nodeAt(b, m.path) !== undefined ||
        (m.type === "error" && parent !== m.path && typeof nodeAt(b, parent ?? "") === "object"));
    if (m.path && !named) problems.push(`message ${m.code} points at nothing (${m.path})`);
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
    // `<room type>__<rate plan>`, and `__2`, `__3` for a second or third room alike.
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

// ---- the session ----------------------------------------------------------------------------

/** A booking session's id: `bks_` and 32 random bytes. The platform holds it; the inbox keeps its hash. */
const SESSION_ID = /^bks_[A-Za-z0-9_-]{43}$/;

export function newSessionId(): string {
  return `bks_${randomToken(32)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the inbox keeps of a session's id: its hash, apart from every other hash it keeps. */
export async function sessionIdHash(id: string): Promise<string> {
  return sha256Hex(`ucp-lodging-session\0${id}`);
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

/** JSON with its keys in order, so the same body is the same text whichever order it came in. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value)) ?? "null";
}

/** Whether two subjects are the same rooms, guests and dates at the same property. */
export function sameSubject(a: Subject, b: Subject): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Whether a lead is reached the way the stay was held for: the same email when both give one, else the
 * same phone number. A name refined, a phone added or a companion named is the same lead; another
 * address is another person to book for.
 */
export function sameReach(
  a: { readonly email?: string | undefined; readonly phone?: string | undefined },
  b: { readonly email?: string | undefined; readonly phone?: string | undefined },
): boolean {
  const mail = (x?: string) => x?.trim().toLowerCase() || undefined;
  const tel = (x?: string) => x?.replace(/[^\d+]/g, "") || undefined;
  if (mail(a.email) && mail(b.email)) return mail(a.email) === mail(b.email);
  if (tel(a.phone) && tel(b.phone)) return tel(a.phone) === tel(b.phone);
  return false;
}

/** What a session keeps, sealed: the last request it accepted, the stay it asked for, and its price then. */
interface SessionState {
  readonly v: 1;
  readonly req: UcpSessionRequest;
  readonly subject: Subject;
  readonly quote: StayQuote;
  readonly validThrough: string;
}

interface SessionRow {
  readonly id: string;
  readonly propertyId: string;
  readonly itemId: string | null;
  readonly state: SessionState;
  readonly totals: string;
  readonly lang: StayLang;
  readonly holds: number;
  readonly canceledAt: number | null;
  readonly createdAt: number;
}

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
    extends: [BOOKING],
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

/** A property a session can be had at: one that confirms some rooms at once. */
const servable = (p: { readonly mode: string; readonly instant: boolean }) =>
  p.mode === "allotment" || (p.mode === "connected" && p.instant);

/** How long a stored answer's reservation stands before a crashed request's key is taken over. */
const STALE_RESERVATION_MS = 5 * 60_000;
const RESERVED = 0;

type Status = 200 | 201 | 400 | 403 | 404 | 503;

/** What a door answers: its status and body, and the stay it concerns (so an erasure finds the stored copy). */
interface Outcome {
  readonly status: Status;
  readonly body: unknown;
  readonly itemId?: string | null | undefined;
}

/** Who signed a request, as the one a stored Create's session id goes back to: a verified key, or an agent's own API key. */
export function signerOf(caller: Caller): string | null {
  const a = caller.agent;
  if (a && a.level !== "none" && a.thumbprint) return `sig:${a.thumbprint}`;
  if (caller.tier === "verified_principal" && caller.actor.kind === "customer_agent") return `key:${caller.actor.id}`;
  return null;
}

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
  const answer = (c: Context, body: unknown, status: Status | 409 = 200, headers: Record<string, string> = {}) =>
    c.json(body, status, { "cache-control": "no-store", ...headers });
  const refusal = (messages: UcpMessage[], status: Status = 200, continueUrl?: string): Outcome => ({
    status,
    body: ucpErrorBody(messages, continueUrl),
  });
  /** A protocol error (rest.md): its HTTP status, with `code` and `content`. */
  const conflict = (c: Context, code: string, content: string) => answer(c, { code, content }, 409);

  const NOT_FOR_OWNER = error("not_allowed", "Booking sessions are for platforms acting for guests.", "unrecoverable");
  const OFF = error("unavailable", "This property is not taking bookings this way right now.", "unrecoverable");
  const NO_SESSION = error("not_found", "No such booking session.", "unrecoverable");
  const NO_PROPERTY = error("not_found", "No such property here.", "unrecoverable", "$.property.id");

  app.get("/.well-known/ucp", async (c) => {
    const any = (await listProperties(db, { active: true })).filter(servable);
    if (!box() || !any.length) return c.json({ error: "not_found", path: "/.well-known/ucp" }, 404);
    return c.json(ucpProfileOf(origin(c)), 200, { "Cache-Control": "public, max-age=60" });
  });

  const base = `${UCP_LODGING_PATH}/booking-sessions`;

  /** The language a new session speaks to the guest: theirs, else the property's first, as the stays doors do. */
  const langFor = async (req: UcpSessionRequest, header?: string) => {
    const settings = await readSettings(db);
    const tag =
      req.context?.language ??
      (header?.split(",")[0]?.split(";")[0]?.trim() || undefined) ??
      settings.stays.languages[0] ??
      settings.business.languages[0] ??
      "en";
    return stayLang(tag || "en");
  };

  /** What the property keeps of the lead: their name, address and phone, as on any stay. */
  const contactOf = async (item: Item): Promise<{ name?: string; email?: string; phone?: string }> => {
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

  /** The caller every call of one session acts as: the platform's, in the session's own scope. */
  const sessionCaller = (caller: Caller, row: string, key: string, lang: StayLang): Caller => ({
    ...caller,
    locale: lang,
    idempotency: { scope: `ucp-lodging:${row}`, key },
  });

  /** The stay as its party, as the stay's own pages do: the session's row is the proof. */
  const asParty = (caller: Caller, item: Item): Caller => ({
    ...caller,
    actor: { ...caller.actor, partyId: item.partyId },
  });

  const itemById = async (id: string | null): Promise<Item | null> => {
    if (!id) return null;
    const [row] = await db.orm.select().from(schema.items).where(eq(schema.items.id, id));
    return row ? rowToItem(row) : null;
  };

  // ---- the session's row ----

  const readSession = async (id: string): Promise<SessionRow | null> => {
    const s = box();
    if (!s || !SESSION_ID.test(id)) return null;
    const { rows } = await db.client.query({
      sql: `SELECT id, property_id, item_id, state_enc, totals, lang, holds, canceled_at, created_at
              FROM ucp_sessions WHERE token_hash = ?`,
      params: [await sessionIdHash(id)],
      method: "all",
    });
    const r = rows[0];
    if (!r) return null;
    try {
      const state = JSON.parse(await s.open("ucp-session", String(r[0]), String(r[3]))) as SessionState;
      if (state.v !== 1) return null;
      return {
        id: String(r[0]),
        propertyId: String(r[1]),
        itemId: r[2] === null || r[2] === undefined ? null : String(r[2]),
        state,
        totals: String(r[4]),
        lang: stayLang(String(r[5])),
        holds: Number(r[6]),
        canceledAt: r[7] === null || r[7] === undefined ? null : Number(r[7]),
        createdAt: Number(r[8]),
      };
    } catch {
      return null;
    }
  };

  /** Writes what changed of a session; the row it returns is the one the answer is made from. */
  const saveSession = async (
    row: SessionRow,
    change: Partial<Pick<SessionRow, "itemId" | "state" | "totals" | "lang" | "canceledAt">>,
  ): Promise<SessionRow> => {
    const s = box();
    if (!s) return row;
    const next: SessionRow = { ...row, ...change };
    await db.client.query({
      sql: `UPDATE ucp_sessions SET item_id = ?, state_enc = ?, totals = ?, lang = ?, canceled_at = ?, updated_at = ?
             WHERE id = ?`,
      params: [
        next.itemId,
        await s.seal("ucp-session", row.id, JSON.stringify(next.state)),
        next.totals,
        next.lang,
        next.canceledAt,
        clock(),
        row.id,
      ],
      method: "run",
    });
    return next;
  };

  /**
   * UCP's Idempotency-Key (rest.md): the first answer is kept, sealed, under the key; the same body
   * again gets it again, another body a 409. A Create's answer carries its session's id, so it goes
   * back only to the key that signed it (ADR-038 §3); anything else is answered to whoever holds the
   * session's id already. Refusals are not kept, so a corrected retry with the same key runs.
   */
  const idempotent = async (
    c: Context,
    scope: string,
    op: string,
    raw: unknown,
    signer: string | null,
    onlyTheSigner: boolean,
    run: () => Promise<Outcome>,
  ): Promise<Response> => {
    const key = c.req.header("idempotency-key")?.trim();
    const s = box();
    const send = (o: Outcome, headers: Record<string, string> = {}) => answer(c, o.body, o.status, headers);
    if (!key || !s) return send(await run());
    const hash = await sha256Hex(canonical({ op, body: raw ?? null }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = clock();
      const { rows } = await db.client.query({
        sql: "SELECT request_hash, status, response, created_at FROM idempotency_keys WHERE scope = ? AND key = ?",
        params: [scope, key],
        method: "all",
      });
      const hit = rows[0];
      if (hit) {
        if (String(hit[0]) !== hash)
          return conflict(
            c,
            "idempotency_conflict",
            "This Idempotency-Key was used with a different request: use a new key for a new request.",
          );
        if (Number(hit[1]) === RESERVED) {
          if (now - Number(hit[3]) < STALE_RESERVATION_MS)
            return conflict(
              c,
              "idempotency_in_progress",
              "A request with this Idempotency-Key is still running: retry it in a moment with the same key.",
            );
          await db.client.query({
            sql: "DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = ?",
            params: [scope, key, RESERVED],
            method: "run",
          });
          continue;
        }
        let stored: { by: string | null; status: Status; body: unknown } | null = null;
        try {
          const kept = JSON.parse(String(hit[2])) as { sealed?: string };
          if (kept.sealed) stored = JSON.parse(await s.open("idempotent-response", `${scope}:${key}`, kept.sealed));
        } catch {
          stored = null;
        }
        if (!stored || (onlyTheSigner && (!signer || stored.by !== signer)))
          return conflict(
            c,
            "idempotency_conflict",
            "A session was made with this Idempotency-Key already, and its id goes back only to the key that signed that request. Use a new key.",
          );
        return send({ status: stored.status, body: stored.body }, { "idempotent-replayed": "true" });
      }
      const reserved = await db.client.query({
        sql: "INSERT OR IGNORE INTO idempotency_keys (scope, key, request_hash, status, response, item_id, created_at) VALUES (?, ?, ?, ?, 'null', NULL, ?)",
        params: [scope, key, hash, RESERVED, now],
        method: "run",
      });
      if (reserved.changes !== 1) continue;
      let out: Outcome;
      try {
        out = await run();
      } catch (e) {
        await db.client.query({
          sql: "DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = ?",
          params: [scope, key, RESERVED],
          method: "run",
        });
        throw e;
      }
      const refused = out.status >= 300 || (out.body as { ucp?: { status?: string } })?.ucp?.status === "error";
      if (refused) {
        await db.client.query({
          sql: "DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = ?",
          params: [scope, key, RESERVED],
          method: "run",
        });
      } else {
        const sealed = await s.seal(
          "idempotent-response",
          `${scope}:${key}`,
          JSON.stringify({ by: signer, status: out.status, body: out.body }),
        );
        await db.client.query({
          sql: "UPDATE idempotency_keys SET status = ?, response = ?, item_id = ? WHERE scope = ? AND key = ?",
          params: [out.status, JSON.stringify({ sealed }), out.itemId ?? null, scope, key],
          method: "run",
        });
      }
      return send(out);
    }
    return conflict(
      c,
      "idempotency_in_progress",
      "A request with this Idempotency-Key is still running: retry it in a moment with the same key.",
    );
  };

  // ---- pricing and holding ----

  /** The rooms priced for this subject, as an offer when they confirm at once; why not, otherwise. */
  const offerFor = async (
    caller: Caller,
    row: string,
    subject: Subject,
    setup: PropertySetup,
    lang: StayLang,
  ): Promise<{ offer: { offer_id: string; valid_through: string; quote: StayQuote } } | { messages: UcpMessage[] }> => {
    try {
      const q = await deps.caps.stays.quote(sessionCaller(caller, row, "quote", lang), {
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
        return {
          messages: [
            error("inventory_exhausted", q.reason ?? "Those nights are not available.", "unrecoverable", "$.stays"),
          ],
        };
      // A place that books at once whose kept rooms are gone has none left to book here; only a place
      // that answers each stay itself is on request.
      if (servable(setup.property))
        return {
          messages: [
            error(
              "inventory_exhausted",
              "No room of this kind can be booked at once for these nights.",
              "unrecoverable",
              "$.stays",
            ),
          ],
        };
      return {
        messages: [
          error(
            "on_request",
            `${setup.property.name} confirms each stay itself, within ${q.answers_within_h} hours, so these rooms cannot be booked here at once.`,
            "unrecoverable",
          ),
        ],
      };
    } catch (e) {
      return { messages: messagesOf(e, servable(setup.property)) };
    }
  };

  /** The doors a property keeps closed or elsewhere, said before anything is priced; a deep link when it has one. */
  const shut = async (subject: Subject | null): Promise<{ messages: UcpMessage[]; url?: string } | null> => {
    const settings = await readSettings(db);
    const there = settings.doorsElsewhere.find((d) => d.itemType === "stay");
    if (there) {
      const filled =
        there.urlTemplate && subject
          ? fillStayTemplate(there.urlTemplate, {
              check_in: subject.checkIn,
              check_out: subject.checkOut,
              adults: subject.rooms.reduce((a, r) => a + r.adults, 0),
              children: subject.rooms.reduce((a, r) => a + r.childrenAges.length, 0),
              rooms: subject.rooms.length,
            })
          : null;
      return {
        messages: [
          error("not_allowed", "This property takes bookings on its own website: continue there.", "unrecoverable"),
        ],
        url: filled ?? there.url,
      };
    }
    if (settings.doors.stay === false)
      return {
        messages: [error("not_allowed", "This property does not take stays through assistants.", "unrecoverable")],
      };
    return null;
  };

  /** Why a hold over a limit was refused, said of whoever holds them: the lead, the assistant, or its platform. */
  const holdsRefused = async (e: unknown, lead: Lead): Promise<UcpMessage[] | null> => {
    if (!(e instanceof WriteError) || e.code !== "guard_failed") return null;
    const d = (e.details ?? {}) as { guard?: string; reason?: string };
    if (d.guard !== "holds") return null;
    if (d.reason === "platform_holds")
      return [error("too_many_holds", `${e.message.replace(/^Your platform/, "This platform")}`, "recoverable")];
    const mail = lead.email?.trim().toLowerCase();
    const theirs = mail
      ? Number(
          (
            await db.client.query({
              sql: `SELECT COUNT(*) FROM items WHERE type = 'stay' AND state = 'held'
                       AND party_id IN (SELECT id FROM parties WHERE lower(trim(json_extract(contact, '$.email'))) = ?)`,
              params: [mail],
              method: "all",
            })
          ).rows[0]?.[0] ?? 0,
        )
      : 0;
    return theirs >= 2
      ? [
          error(
            "too_many_holds",
            "The lead holds two stays here already: book or let one go first.",
            "recoverable",
            "$.booker",
          ),
        ]
      : [
          error(
            "too_many_holds",
            "This assistant holds two stays here already: book or let one go first.",
            "recoverable",
          ),
        ];
  };

  /**
   * Holds the rooms for the lead, at the offer just made when there is one. Each hold of a session is
   * made under a number of its own, so a session holds again after a change, a few times at most.
   */
  const holdFor = async (
    caller: Caller,
    row: SessionRow,
    subject: Subject,
    lead: Lead,
    offer: { offer_id: string } | null,
    setup: PropertySetup,
    lang: StayLang,
  ): Promise<{ item: Item } | { messages: UcpMessage[] }> => {
    let k = row.holds;
    for (let tries = 0; ; tries++) {
      if (k >= MAX_SESSION_HOLDS || tries > 3)
        return {
          messages: [
            error(
              "too_many_holds",
              "These rooms were held and let go too many times in this session: start a new one.",
              "unrecoverable",
            ),
          ],
        };
      const taken = await db.client.query({
        sql: "UPDATE ucp_sessions SET holds = holds + 1, updated_at = ? WHERE id = ? AND holds = ?",
        params: [clock(), row.id, k],
        method: "run",
      });
      if (taken.changes === 1) break;
      const { rows } = await db.client.query({
        sql: "SELECT holds FROM ucp_sessions WHERE id = ?",
        params: [row.id],
        method: "all",
      });
      k = Number(rows[0]?.[0] ?? MAX_SESSION_HOLDS);
    }
    const key = `hold:${k + 1}`;
    try {
      const r = await deps.caps.stays.hold(sessionCaller(caller, row.id, key, lang), {
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
        // guest sending them to it, as UCP's flow has it (ADR-038 §4).
        consent: true,
        ...(offer ? { offer_id: offer.offer_id } : {}),
        idempotency_key: key,
      });
      const item = r.view.item;
      if (item.state === "held") return { item };
      // The nights went between the price and the hold: the stays doors leave a request with the
      // property then, which a booking session never asked for. It is withdrawn at once.
      await letGo(caller, row.id, item, lang, "replaced");
      return {
        messages: [error("inventory_exhausted", "Those nights were taken a moment ago.", "recoverable", "$.stays")],
      };
    } catch (e) {
      return { messages: (await holdsRefused(e, lead)) ?? messagesOf(e, servable(setup.property)) };
    }
  };

  /** Lets a session's stay go: a hold is released, a request withdrawn, a stay waiting for payment cancelled. */
  const letGo = async (
    caller: Caller,
    row: string,
    item: Item,
    lang: StayLang,
    why: "replaced" | "cancelled",
  ): Promise<void> => {
    const key = `${why}:${item.id}`;
    const as = asParty(sessionCaller(caller, row, key, lang), item);
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
   * The names on a held stay, as the platform has them now: the lead (the primary guest, when one is
   * named) and the others. The hold stands; only a stay still held is written, and only its names.
   */
  const renameGuests = async (item: Item, lead: Lead): Promise<void> => {
    await db.client.query({
      sql: `UPDATE items SET payload = json_set(payload, '$.guests', json(?)), updated_at = ?
             WHERE id = ? AND type = 'stay' AND state = 'held'`,
      params: [
        JSON.stringify({ lead: { name: lead.name }, others: lead.others.map((n) => ({ name: n })) }),
        clock(),
        item.id,
      ],
      method: "run",
    });
  };

  /** The lead a held stay was made for, as a lead the session could hold for again. */
  const leadOfItem = async (item: Item): Promise<Lead | null> => {
    const contact = await contactOf(item);
    const g = (item.payload as StayPayload).guests;
    const name = g?.lead.name ?? contact.name;
    if (!name || !(contact.email || contact.phone)) return null;
    return {
      name,
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.phone ? { phone: contact.phone } : {}),
      others: (g?.others ?? []).map((o) => o.name),
    };
  };

  // ---- answers ----

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
    const place = placeOf(setup);
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
      if (token) return { url: linkUrl(at, token), words: w.cardThere(setup.property.name, when, place) };
    }
    const terms = await deps.caps.stays.terms(item, lang, now);
    const due = terms?.payments.find((x) => x.type === "immediate" && x.status === "due" && x.pay_url);
    const label = p.quote?.schedule.find((x) => x.id === due?.id)?.label ?? "";
    return due?.pay_url ? { url: due.pay_url, words: w.payThere(setup.property.name, label, when, place) } : null;
  };

  /** What the session's answer says about the stay it holds or booked: its status, and where to go on. */
  const fromItem = async (
    c: Context,
    row: SessionRow,
    item: Item,
    lang: StayLang,
    extra: readonly UcpMessage[] = [],
  ): Promise<UcpBooking | null> => {
    const p = item.payload as StayPayload;
    const setup = await readSetup(db, p.propertyId);
    const quote = p.quote;
    if (!setup || !quote) return null;
    const now = clock();
    const messages = [...extra];
    let status: UcpStatus;
    let continueUrl: string | undefined;
    let expiresAt: string | undefined;
    if (item.state === "held") {
      // A hold whose time ran out is over, swept or not.
      const until = p.hold?.until;
      status = until && Date.parse(until) <= now ? "canceled" : "ready_for_complete";
      expiresAt = until;
    } else if (item.state === "booking") {
      status = "complete_in_progress";
      messages.push({ type: "info", content: UCP_WORDS[lang].confirming(setup.property.name) });
    } else if (item.state === "awaiting_payment") {
      expiresAt = p.payments?.dueBy;
      const handoff = await handoffOf(item, setup, lang, now, origin(c));
      if (handoff) {
        status = "requires_escalation";
        continueUrl = handoff.url;
        messages.push(error("payment_required", handoff.words, "requires_buyer_input", "$.payment.terms[0]"));
      } else {
        status = "complete_in_progress";
        messages.push({ type: "info", content: UCP_WORDS[lang].preparingPayment(setup.property.name) });
      }
    } else if (BOOKED.has(item.state)) {
      status = "completed";
    } else {
      status = "canceled";
    }
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
    const req = row.state.req;
    return ucpBookingOf({
      id: "",
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
      booker: req.booker,
      guests: req.guests,
      travelPurpose: req.travel_purpose,
      assignments: req.stays.map((s) => s.guest_assignments),
      confirmation: { id: item.id, label: item.id.slice(-6).toUpperCase() },
    });
  };

  /** A session that holds nothing: its rooms at the price given, waiting for its lead, or over. */
  const pending = async (
    c: Context,
    row: SessionRow,
    lang: StayLang,
    extra: { status?: UcpStatus; messages?: readonly UcpMessage[] } = {},
  ): Promise<UcpBooking | null> => {
    const setup = await readSetup(db, row.propertyId);
    if (!setup) return null;
    const now = clock();
    const status = extra.status ?? "incomplete";
    const req = row.state.req;
    const lead = leadOf(req);
    const messages = [
      ...(extra.messages ?? []),
      ...(status === "incomplete" && lead === null
        ? [
            error(
              "lead_guest_required",
              "Name the lead guest (first_name, last_name, and an email or phone_number), as the booker or a guest with role primary, to hold the rooms.",
              "recoverable",
              "$.booker",
            ),
          ]
        : []),
    ];
    return ucpBookingOf({
      id: "",
      status,
      subject: row.state.subject,
      quote: row.state.quote,
      setup,
      lang,
      now,
      origin: origin(c),
      messages,
      expiresAt: new Date(Math.min(Date.parse(row.state.validThrough), row.createdAt + SESSION_LIFE_MS)).toISOString(),
      booker: req.booker,
      guests: req.guests,
      travelPurpose: req.travel_purpose,
      assignments: req.stays.map((s) => s.guest_assignments),
    });
  };

  /** The session as it stands, with what this call has to say about it. */
  const current = async (
    c: Context,
    caller: Caller,
    row: SessionRow,
    lang: StayLang,
    messages: readonly UcpMessage[] = [],
  ): Promise<UcpBooking | null> => {
    const item = await itemById(row.itemId);
    if (item) return fromItem(c, row, item, lang, messages);
    const over = row.canceledAt !== null || clock() > row.createdAt + SESSION_LIFE_MS;
    if (over) return pending(c, row, lang, { status: "canceled", messages });
    if (messages.length) return pending(c, row, lang, { messages });
    // Read again while it holds nothing: priced now, and said when the price moved since it was shown.
    const setup = await readSetup(db, row.propertyId);
    if (!setup) return null;
    const quoted = await offerFor(caller, row.id, row.state.subject, setup, lang);
    if ("messages" in quoted) return pending(c, row, lang, { messages: quoted.messages });
    const totals = await totalsDigest(quoted.offer.quote);
    const moved = totals !== row.totals;
    const next = moved
      ? await saveSession(row, {
          totals,
          state: { ...row.state, quote: quoted.offer.quote, validThrough: quoted.offer.valid_through },
        })
      : row;
    return pending(c, next, lang, { messages: moved ? [ucpTotalsChanged(lang)] : [] });
  };

  /** An answer with the session's id on it, or not_found when its property is gone. */
  const reply = (id: string, booking: UcpBooking | null, row: SessionRow, status: 200 | 201 = 200): Outcome =>
    booking ? { status, body: { ...booking, id }, itemId: row.itemId } : refusal([NO_SESSION], 404);

  /** The session a call names, and its caller; or the answer that there is none. */
  const sessionOf = async (c: Context<CallerEnv>) => {
    const caller = c.get("caller");
    if (!isCustomer(caller)) return { refused: answer(c, ucpErrorBody([NOT_FOR_OWNER]), 403) };
    if (!box()) return { refused: answer(c, ucpErrorBody([OFF]), 503) };
    const id = c.req.param("id") ?? "";
    const row = await readSession(id);
    if (!row) return { refused: answer(c, ucpErrorBody([NO_SESSION]), 404) };
    return { caller, row, id };
  };

  const body = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  const parsed = (raw: unknown): { req: UcpSessionRequest } | { refused: Outcome } => {
    const r = ucpSessionRequest.safeParse(raw ?? {});
    if (r.success) return { req: r.data };
    const issue = r.error.issues[0];
    const where = `$${(issue?.path ?? []).map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}`;
    return { refused: refusal([error("invalid", issue?.message ?? "Invalid request.", "recoverable", where)], 400) };
  };

  // Create Booking Session.
  app.post(base, async (c) => {
    const caller = c.get("caller");
    if (!isCustomer(caller)) return answer(c, ucpErrorBody([NOT_FOR_OWNER]), 403);
    const s = box();
    if (!s) return answer(c, ucpErrorBody([OFF]), 503);
    const raw = await body(c);
    const signer = signerOf(caller);
    return idempotent(c, `ucp-lodging:create:${signer ?? scopeFor(caller)}`, "create", raw, signer, true, () =>
      create(c, caller, s, raw),
    );
  });

  const create = async (c: Context, caller: Caller, s: SecretBox, raw: unknown): Promise<Outcome> => {
    const p = parsed(raw);
    if ("refused" in p) return p.refused;
    const req = p.req;
    const lang = await langFor(req, c.req.header("accept-language"));
    const setup = await readSetup(db, req.property.id);
    if (!setup?.property.active) return refusal([NO_PROPERTY]);
    const asked = subjectOf(req, setup);
    const closed = await shut("subject" in asked ? asked.subject : null);
    if (closed) return refusal(closed.messages, 200, closed.url);
    if ("messages" in asked) return refusal(asked.messages);
    const lead = leadOf(req);
    if (lead && "messages" in lead) return refusal(lead.messages);
    const now = clock();
    // Sessions that never held a room go a day after they lapse.
    await db.client.query({
      sql: "DELETE FROM ucp_sessions WHERE item_id IS NULL AND created_at < ?",
      params: [now - 2 * SESSION_LIFE_MS],
      method: "run",
    });
    const rowId = ulid();
    const quoted = await offerFor(caller, rowId, asked.subject, setup, lang);
    if ("messages" in quoted) return refusal(quoted.messages);
    const id = newSessionId();
    const state: SessionState = {
      v: 1,
      req,
      subject: asked.subject,
      quote: quoted.offer.quote,
      validThrough: quoted.offer.valid_through,
    };
    const totals = await totalsDigest(quoted.offer.quote);
    await db.client.query({
      sql: `INSERT INTO ucp_sessions (id, token_hash, property_id, item_id, state_enc, totals, lang, holds, canceled_at, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?, ?)`,
      params: [
        rowId,
        await sessionIdHash(id),
        setup.property.id,
        await s.seal("ucp-session", rowId, JSON.stringify(state)),
        totals,
        lang,
        now,
        now,
      ],
      method: "run",
    });
    let row: SessionRow = {
      id: rowId,
      propertyId: setup.property.id,
      itemId: null,
      state,
      totals,
      lang,
      holds: 0,
      canceledAt: null,
      createdAt: now,
    };
    if (!lead) return reply(id, await pending(c, row, lang), row, 201);
    const held = await holdFor(caller, row, asked.subject, lead, quoted.offer, setup, lang);
    if ("messages" in held) return reply(id, await pending(c, row, lang, { messages: held.messages }), row, 201);
    row = await saveSession(row, { itemId: held.item.id });
    return reply(id, await fromItem(c, row, held.item, lang), row, 201);
  };

  // Get Booking Session.
  app.get(`${base}/:id`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const out = reply(s.id, await current(c, s.caller, s.row, s.row.lang), s.row);
    return answer(c, out.body, out.status);
  });

  // Update Booking Session: a full replacement.
  app.put(`${base}/:id`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const raw = await body(c);
    return idempotent(c, `ucp-lodging:session:${s.row.id}`, "update", raw, null, false, () =>
      update(c, s.caller, s.row, s.id, raw),
    );
  });

  const update = async (c: Context, caller: Caller, row0: SessionRow, id: string, raw: unknown): Promise<Outcome> => {
    const p = parsed(raw);
    if ("refused" in p) return p.refused;
    const req = p.req;
    let row = row0;
    const lang = req.context?.language ? stayLang(req.context.language) : row.lang;
    const now = clock();
    const item = await itemById(row.itemId);
    const asIs = async (messages: UcpMessage[]) => reply(id, await current(c, caller, row, lang, messages), row);
    const over =
      row.canceledAt !== null ||
      (item ? BOOKED.has(item.state) || ENDED.has(item.state) : now > row.createdAt + SESSION_LIFE_MS);
    if (over)
      return asIs([
        error(
          "not_modifiable",
          "This session is booked or over; it can no longer change. Create a new one.",
          "unrecoverable",
        ),
      ]);
    if (req.property.id !== row.propertyId)
      return asIs([
        error("invalid", "A session stays at the property it was made for.", "recoverable", "$.property.id"),
      ]);
    const setup = await readSetup(db, row.propertyId);
    if (!setup?.property.active) return asIs([NO_PROPERTY]);
    // Everything the request says is checked before anything held is let go.
    const asked = subjectOf(req, setup);
    if ("messages" in asked) return asIs(asked.messages);
    const lead = leadOf(req);
    if (lead && "messages" in lead) return asIs(lead.messages);
    const held = item?.state === "held" ? item : null;
    const accepted = (subject: Subject, quote: StayQuote, validThrough: string): SessionState => ({
      v: 1,
      req,
      subject,
      quote,
      validThrough,
    });

    // The same rooms and dates for the lead the stay is held for: the hold stands, names written on it.
    if (held && lead && sameSubject(asked.subject, row.state.subject) && sameReach(lead, await contactOf(held))) {
      await renameGuests(held, lead);
      row = await saveSession(row, { state: { ...row.state, req }, lang });
      return reply(id, await fromItem(c, row, (await itemById(held.id)) ?? held, lang), row);
    }

    // Anything else is priced first, the old hold kept while it can be: only when its own hold is what
    // stands in the way is it let go, and a change that still cannot be had holds the old rooms again.
    const heldQuote = held ? (held.payload as StayPayload).quote : undefined;
    const before = heldQuote ? await totalsDigest(heldQuote) : row.totals;
    const oldLead = held ? await leadOfItem(held) : null;
    let released = false;
    const release = async () => {
      if (held && !released) {
        await letGo(caller, row.id, held, lang, "replaced");
        released = true;
      }
    };
    const restore = async (messages: UcpMessage[]): Promise<Outcome> => {
      if (released && held && oldLead) {
        const again = await holdFor(caller, row, row.state.subject, oldLead, null, setup, lang);
        row = await saveSession(row, { itemId: "item" in again ? again.item.id : null, lang });
        return asIs("messages" in again ? [...messages, ...again.messages] : messages);
      }
      if (released) row = await saveSession(row, { itemId: null, lang });
      return asIs(messages);
    };
    // Its own hold stands in the way only of rooms: a change refused for anything else lets nothing go.
    const inTheWay = (messages: readonly UcpMessage[]) =>
      messages.some((m) => m.code === "inventory_exhausted" || m.code === "too_many_holds");
    let quoted = await offerFor(caller, row.id, asked.subject, setup, lang);
    if ("messages" in quoted && held && inTheWay(quoted.messages)) {
      await release();
      quoted = await offerFor(caller, row.id, asked.subject, setup, lang);
    }
    if ("messages" in quoted) return restore(quoted.messages);
    const offer = quoted.offer;
    const totals = await totalsDigest(offer.quote);
    const changed = totals !== before ? [ucpTotalsChanged(lang)] : [];
    if (!lead) {
      await release();
      row = await saveSession(row, {
        itemId: null,
        state: accepted(asked.subject, offer.quote, offer.valid_through),
        totals,
        lang,
      });
      return reply(id, await pending(c, row, lang, { messages: changed }), row);
    }
    let made = await holdFor(caller, row, asked.subject, lead, offer, setup, lang);
    // The old hold counted against the lead's two, or kept the last room: let go, and held again.
    if ("messages" in made && held && !released && inTheWay(made.messages)) {
      await release();
      row = { ...row, holds: row.holds + 1 };
      made = await holdFor(caller, row, asked.subject, lead, null, setup, lang);
    }
    if ("messages" in made) return restore(made.messages);
    await release();
    row = await saveSession(row, {
      itemId: made.item.id,
      state: accepted(asked.subject, (made.item.payload as StayPayload).quote ?? offer.quote, offer.valid_through),
      totals: await totalsDigest((made.item.payload as StayPayload).quote ?? offer.quote),
      lang,
    });
    return reply(id, await fromItem(c, row, made.item, lang, changed), row);
  };

  // Complete Booking Session. Any payment instrument sent is never read: the property takes its own.
  app.post(`${base}/:id/complete`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const raw = await body(c);
    return idempotent(c, `ucp-lodging:session:${s.row.id}`, "complete", raw, null, false, () =>
      complete(c, s.caller, s.row, s.id),
    );
  });

  const complete = async (c: Context, caller: Caller, row: SessionRow, id: string): Promise<Outcome> => {
    const lang = row.lang;
    const item = await itemById(row.itemId);
    if (item?.state !== "held") return reply(id, await current(c, caller, row, lang), row);
    const now = clock();
    const until = (item.payload as StayPayload).hold?.until;
    if (until && Date.parse(until) <= now) return reply(id, await fromItem(c, row, item, lang), row);
    // The platform showed the guest these terms and the policy disclosed with them, and the guest's yes
    // comes with Complete: its trusted interface stands in for the fingerprint (ADR-038 §4).
    const terms = await deps.caps.stays.terms(item, lang, now);
    let messages: UcpMessage[] = [];
    try {
      await deps.caps.stays.book(asParty(sessionCaller(caller, row.id, `book:${item.id}`, lang), item), {
        item_id: item.id,
        ...(terms?.terms_sha ? { terms_sha: terms.terms_sha } : {}),
        idempotency_key: `book:${item.id}`,
      });
    } catch (e) {
      messages = messagesOf(e, true);
    }
    // Whatever the attempt said, the stay says where it stands now; booked is booked, and what went
    // wrong on the way (another Complete at the same moment) is not said beside it.
    const after = (await itemById(item.id)) ?? item;
    return reply(id, await fromItem(c, row, after, lang, BOOKED.has(after.state) ? [] : messages), row);
  };

  // Cancel Booking Session.
  app.post(`${base}/:id/cancel`, async (c) => {
    const s = await sessionOf(c);
    if ("refused" in s) return s.refused;
    const raw = await body(c);
    return idempotent(c, `ucp-lodging:session:${s.row.id}`, "cancel", raw, null, false, () =>
      cancel(c, s.caller, s.row, s.id),
    );
  });

  const cancel = async (c: Context, caller: Caller, row0: SessionRow, id: string): Promise<Outcome> => {
    let row = row0;
    const lang = row.lang;
    const item = await itemById(row.itemId);
    if (item && (item.state === "booking" || (BOOKED.has(item.state) && item.state !== "awaiting_payment"))) {
      return reply(
        id,
        await fromItem(c, row, item, lang, [
          item.state === "booking"
            ? error(
                "complete_in_progress",
                "The booking is being confirmed in the property's own system; ask again in a moment.",
                "recoverable",
              )
            : error(
                "not_cancelable",
                "This stay is booked: cancelling it costs what its policy says now, through cancel_item with its fee_sha, or on the property's own page.",
                "unrecoverable",
              ),
        ]),
        row,
      );
    }
    if (item) await letGo(caller, row.id, item, lang, "cancelled");
    // Cancelled is kept, whether the session held anything or not.
    if (row.canceledAt === null) row = await saveSession(row, { canceledAt: clock() });
    return reply(id, await current(c, caller, row, lang), row);
  };
}

/**
 * What the stays doors refused, as UCP's messages: the codes it knows where one fits. `servable` is
 * whether the property books at once: there, "on request" means its kept rooms are gone.
 */
export function messagesOf(e: unknown, servable = true): UcpMessage[] {
  if (!(e instanceof WriteError)) throw e;
  const d = (e.details ?? {}) as { guard?: string; status?: string; reason?: string };
  if (e.code === "guard_failed" && d.guard === "holds")
    return [
      error(
        "too_many_holds",
        d.reason === "platform_holds"
          ? e.message.replace(/^Your platform/, "This platform")
          : "Two stays are held for this guest here already: book or let one go first.",
        "recoverable",
      ),
    ];
  if (e.code === "guard_failed" && d.status === "unavailable")
    return [error("inventory_exhausted", e.message, "unrecoverable", "$.stays")];
  if (e.code === "guard_failed" && d.reason === "system_unanswered")
    return [
      error("unavailable", "The property's own system did not answer just now: try again in a moment.", "recoverable"),
    ];
  if (e.code === "guard_failed" || e.code === "slot_taken") {
    return d.status === "on_request" && !servable
      ? [error("on_request", e.message, "unrecoverable")]
      : [
          error(
            "inventory_exhausted",
            "No room of this kind can be booked at once for these nights.",
            "unrecoverable",
            "$.stays",
          ),
        ];
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
