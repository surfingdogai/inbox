import type { DatedPolicy } from "@surfingdog/spec";
import type { Money } from "../domain/types";
import { formatMinor } from "../util/money";
import { knownZone } from "../util/zoned";

/**
 * A dated policy read back in a sentence, in the business's voice and the customer's language (ADR-032):
 * "Free cancellation until 9 Dec 2026, 23:59 Kyoto time. After that: ¥25,800. No-show: the full stay."
 * Six languages, the ones the templates ship in; any other reads in English. The words never name
 * the inbox, a network or anything but the business's own terms.
 */
export type PolicyLang = "en" | "es" | "fr" | "de" | "it" | "pt";

const LANGS: readonly PolicyLang[] = ["en", "es", "fr", "de", "it", "pt"];

/** The template language for a language tag: its primary subtag when it is one of the six, else English. */
export function policyLang(tag: string | null | undefined): PolicyLang {
  const primary = (tag ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return (LANGS as readonly string[]).includes(primary) ? (primary as PolicyLang) : "en";
}

/** The locale dates and money are written in, for a language with no region given. */
const LOCALE: Readonly<Record<PolicyLang, string>> = {
  en: "en-GB",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
};

interface Words {
  readonly when: (date: string, time: string, place: string) => string;
  readonly free: (when: string) => string;
  readonly paid: (when: string, fee: string) => string;
  readonly after: (fee: string) => string;
  /** After the free steps, with nothing more to pay: the deposit is what is kept. */
  readonly afterKept: string;
  /** Booked once the free steps had passed: cancelling keeps the deposit. */
  readonly onlyKept: string;
  /** After a fee, where the deposit the policy keeps may be more: ", or the deposit paid if that is more". */
  readonly orKept: string;
  readonly only: (fee: string) => string;
  readonly noShow: (fee: string) => string;
  readonly whole: { readonly stay: string; readonly price: string };
  readonly nothing: string;
}

const WORDS: Readonly<Record<PolicyLang, Words>> = {
  en: {
    when: (d, t, p) => `${d}, ${t} ${p} time`,
    free: (w) => `Free cancellation until ${w}.`,
    paid: (w, f) => `Until ${w}, cancelling costs ${f}.`,
    after: (f) => `After that: ${f}.`,
    afterKept: "After that, the deposit is not refunded.",
    onlyKept: "If you cancel, the deposit is not refunded.",
    orKept: ", or the deposit paid if that is more",
    only: (f) => `Cancelling costs ${f}.`,
    noShow: (f) => `No-show: ${f}.`,
    whole: { stay: "the full stay", price: "the full price" },
    nothing: "nothing",
  },
  es: {
    when: (d, t, p) => `${d}, ${t} (hora de ${p})`,
    free: (w) => `Cancelación gratuita hasta el ${w}.`,
    paid: (w, f) => `Hasta el ${w}, cancelar cuesta ${f}.`,
    after: (f) => `Después: ${f}.`,
    afterKept: "Después, el depósito no se devuelve.",
    onlyKept: "Si cancelas, el depósito no se devuelve.",
    orKept: ", o el depósito pagado si es mayor",
    only: (f) => `Cancelar cuesta ${f}.`,
    noShow: (f) => `Si no se presenta: ${f}.`,
    whole: { stay: "la estancia completa", price: "el precio completo" },
    nothing: "nada",
  },
  fr: {
    when: (d, t, p) => `${d}, ${t} (heure de ${p})`,
    free: (w) => `Annulation gratuite jusqu'au ${w}.`,
    paid: (w, f) => `Jusqu'au ${w}, l'annulation coûte ${f}.`,
    after: (f) => `Ensuite : ${f}.`,
    afterKept: "Ensuite, l'acompte n'est pas remboursé.",
    onlyKept: "En cas d'annulation, l'acompte n'est pas remboursé.",
    orKept: ", ou l'acompte versé s'il est plus élevé",
    only: (f) => `L'annulation coûte ${f}.`,
    noShow: (f) => `Non-présentation : ${f}.`,
    whole: { stay: "le séjour complet", price: "le prix total" },
    nothing: "rien",
  },
  de: {
    when: (d, t, p) => `${d}, ${t} Uhr (Ortszeit ${p})`,
    free: (w) => `Kostenlose Stornierung bis ${w}.`,
    paid: (w, f) => `Bis ${w} kostet eine Stornierung ${f}.`,
    after: (f) => `Danach: ${f}.`,
    afterKept: "Danach wird die Anzahlung nicht erstattet.",
    onlyKept: "Bei einer Stornierung wird die Anzahlung nicht erstattet.",
    orKept: " oder die geleistete Anzahlung, falls diese höher ist",
    only: (f) => `Eine Stornierung kostet ${f}.`,
    noShow: (f) => `Bei Nichterscheinen: ${f}.`,
    whole: { stay: "der gesamte Aufenthalt", price: "der volle Preis" },
    nothing: "nichts",
  },
  it: {
    when: (d, t, p) => `${d}, ${t} (ora di ${p})`,
    free: (w) => `Cancellazione gratuita fino al ${w}.`,
    paid: (w, f) => `Fino al ${w}, la cancellazione costa ${f}.`,
    after: (f) => `Dopo: ${f}.`,
    afterKept: "Dopo, l'acconto non viene restituito.",
    onlyKept: "Se annulli, l'acconto non viene restituito.",
    orKept: ", o l'acconto versato se è maggiore",
    only: (f) => `La cancellazione costa ${f}.`,
    noShow: (f) => `Mancata presentazione: ${f}.`,
    whole: { stay: "l'intero soggiorno", price: "il prezzo intero" },
    nothing: "niente",
  },
  pt: {
    when: (d, t, p) => `${d}, ${t} (hora de ${p})`,
    free: (w) => `Cancelamento gratuito até ${w}.`,
    paid: (w, f) => `Até ${w}, cancelar custa ${f}.`,
    after: (f) => `Depois disso: ${f}.`,
    afterKept: "Depois disso, o sinal não é devolvido.",
    onlyKept: "Se cancelar, o sinal não é devolvido.",
    orKept: ", ou o sinal pago, se for maior",
    only: (f) => `Cancelar custa ${f}.`,
    noShow: (f) => `Se não comparecer: ${f}.`,
    whole: { stay: "a estadia completa", price: "o preço total" },
    nothing: "nada",
  },
};

/** The place a zone is named by when the business gives none: its city, as the IANA name spells it. */
function placeOf(zone: string): string {
  const z = knownZone(zone);
  if (z === "UTC" || z === "Etc/UTC") return "UTC";
  return (z.split("/").pop() ?? z).replaceAll("_", " ");
}

export interface SentenceOptions {
  /** A language tag: the customer's, else the business's. */
  readonly lang: string;
  /** The total the fees are part of: a fee equal to it is said as the whole stay or price. */
  readonly total: Money;
  /** What is booked: `stay` says "the full stay", anything else "the full price". */
  readonly what?: "stay" | "price" | undefined;
  /** The place the business is, for "23:59 Kyoto time": its own town, else the zone's city. */
  readonly place?: string | undefined;
  /** A locale for dates and money when the tag alone does not say it (`pt-BR`, `es-MX`). */
  readonly locale?: string | undefined;
  /** A deposit the policy keeps (ADR-035): once cancelling is no longer free, it is what is kept. */
  readonly depositKept?: boolean | undefined;
  /** That deposit: a fee at least as much is said alone; a smaller one, with the deposit if that is more. */
  readonly deposit?: Money | undefined;
}

/** The policy in one short paragraph, true to the dated steps: every fee, its date and time, and no-show. */
export function policySentence(dated: DatedPolicy, opts: SentenceOptions): string {
  const lang = policyLang(opts.lang);
  const w = WORDS[lang];
  const locale = opts.locale ?? (opts.lang.includes("-") ? opts.lang : LOCALE[lang]);
  const zone = knownZone(dated.zone);
  const place = opts.place?.trim() || placeOf(zone);
  const money = (m: Money) =>
    m.value === 0
      ? w.nothing
      : m.value === opts.total.value && m.currency === opts.total.currency
        ? w.whole[opts.what === "stay" ? "stay" : "price"]
        : formatMinor(m, locale);
  const when = (iso: string) => {
    const at = new Date(iso);
    let date: string;
    let time: string;
    try {
      date = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: zone,
      }).format(at);
      time = new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      }).format(at);
    } catch {
      date = iso.slice(0, 10);
      time = iso.slice(11, 16);
    }
    return w.when(date, time, place);
  };
  // A deposit the policy keeps is kept once no free step is ahead, as far as it was paid: a fee from then
  // on is that fee or the deposit, whichever is more (`bookingFeeAt`), and is said so.
  const lastFree = dated.steps.reduce((at, s, i) => (s.fee.value === 0 ? i : at), -1);
  const fee = (m: Money, i: number) =>
    opts.depositKept === true &&
    i > lastFree &&
    !(opts.deposit && opts.deposit.currency === m.currency && m.value >= opts.deposit.value) &&
    !(m.value >= opts.total.value && m.currency === opts.total.currency)
      ? `${money(m)}${w.orKept}`
      : money(m);
  const out: string[] = [];
  dated.steps.forEach((s, i) => {
    out.push(s.fee.value === 0 ? w.free(when(s.until)) : w.paid(when(s.until), fee(s.fee, i)));
  });
  const kept = opts.depositKept === true && dated.after.value === 0;
  const after = fee(dated.after, dated.steps.length);
  const last = dated.steps.length > 0 ? (kept ? w.afterKept : w.after(after)) : kept ? w.onlyKept : w.only(after);
  out.push(last);
  out.push(w.noShow(money(dated.noShow)));
  return out.join(" ");
}
