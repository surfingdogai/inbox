import type { DatedPolicy } from "@surfingdog/spec";
import type { Money } from "../domain/types";
import { countryOfZone, localeFor, onlyZoneOfCountry } from "../util/geo";
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

/** How a time's zone is named: by the business's town, its country (its only zone), or the zone's own name. */
type Place = { readonly kind: "town" | "country" | "zone"; readonly name: string };

interface Words {
  readonly when: (date: string, time: string, place: Place) => string;
  readonly free: (when: string) => string;
  readonly paid: (when: string, fee: string) => string;
  readonly after: (fee: string) => string;
  readonly only: (fee: string) => string;
  readonly noShow: (fee: string) => string;
  readonly whole: { readonly stay: string; readonly price: string };
  readonly nothing: string;
}

const WORDS: Readonly<Record<PolicyLang, Words>> = {
  en: {
    when: (d, t, p) => (p.kind === "zone" ? `${d}, ${t} ${p.name}` : `${d}, ${t} ${p.name} time`),
    free: (w) => `Free cancellation until ${w}.`,
    paid: (w, f) => `Until ${w}, cancelling costs ${f}.`,
    after: (f) => `After that: ${f}.`,
    only: (f) => `Cancelling costs ${f}.`,
    noShow: (f) => `No-show: ${f}.`,
    whole: { stay: "the full stay", price: "the full price" },
    nothing: "nothing",
  },
  es: {
    when: (d, t, p) => (p.kind === "zone" ? `${d}, ${t} (${p.name})` : `${d}, ${t} (hora de ${p.name})`),
    free: (w) => `Cancelación gratuita hasta el ${w}.`,
    paid: (w, f) => `Hasta el ${w}, cancelar cuesta ${f}.`,
    after: (f) => `Después: ${f}.`,
    only: (f) => `Cancelar cuesta ${f}.`,
    noShow: (f) => `Si no se presenta: ${f}.`,
    whole: { stay: "la estancia completa", price: "el precio completo" },
    nothing: "nada",
  },
  fr: {
    when: (d, t, p) =>
      p.kind === "town"
        ? `${d}, ${t} (heure de ${p.name})`
        : p.kind === "country"
          ? `${d}, ${t} (heure locale, ${p.name})`
          : `${d}, ${t} (${p.name})`,
    free: (w) => `Annulation gratuite jusqu'au ${w}.`,
    paid: (w, f) => `Jusqu'au ${w}, l'annulation coûte ${f}.`,
    after: (f) => `Ensuite : ${f}.`,
    only: (f) => `L'annulation coûte ${f}.`,
    noShow: (f) => `Non-présentation : ${f}.`,
    whole: { stay: "le séjour complet", price: "le prix total" },
    nothing: "rien",
  },
  de: {
    when: (d, t, p) => (p.kind === "zone" ? `${d}, ${t} Uhr (${p.name})` : `${d}, ${t} Uhr (Ortszeit ${p.name})`),
    free: (w) => `Kostenlose Stornierung bis ${w}.`,
    paid: (w, f) => `Bis ${w} kostet eine Stornierung ${f}.`,
    after: (f) => `Danach: ${f}.`,
    only: (f) => `Eine Stornierung kostet ${f}.`,
    noShow: (f) => `Bei Nichterscheinen: ${f}.`,
    whole: { stay: "der gesamte Aufenthalt", price: "der volle Preis" },
    nothing: "nichts",
  },
  it: {
    when: (d, t, p) =>
      p.kind === "town"
        ? `${d}, ${t} (ora di ${p.name})`
        : p.kind === "country"
          ? `${d}, ${t} (ora locale, ${p.name})`
          : `${d}, ${t} (${p.name})`,
    free: (w) => `Cancellazione gratuita fino al ${w}.`,
    paid: (w, f) => `Fino al ${w}, la cancellazione costa ${f}.`,
    after: (f) => `Dopo: ${f}.`,
    only: (f) => `La cancellazione costa ${f}.`,
    noShow: (f) => `Mancata presentazione: ${f}.`,
    whole: { stay: "l'intero soggiorno", price: "il prezzo intero" },
    nothing: "niente",
  },
  pt: {
    when: (d, t, p) =>
      p.kind === "town"
        ? `${d}, ${t} (hora de ${p.name})`
        : p.kind === "country"
          ? `${d}, ${t} (hora local, ${p.name})`
          : `${d}, ${t} (${p.name})`,
    free: (w) => `Cancelamento gratuito até ${w}.`,
    paid: (w, f) => `Até ${w}, cancelar custa ${f}.`,
    after: (f) => `Depois disso: ${f}.`,
    only: (f) => `Cancelar custa ${f}.`,
    noShow: (f) => `Se não comparecer: ${f}.`,
    whole: { stay: "a estadia completa", price: "o preço total" },
    nothing: "nada",
  },
};

/**
 * How a time's zone is named when the business gives no town: its country in the reader's language
 * where the zone is the country's only one ("Morocco time", "heure locale, Maroc"), else the zone's own
 * name in that language ("Japan Standard Time", "hora estándar central"). Never the zone's IANA city,
 * which is another town than the business's, in English.
 */
export function placeOf(zone: string, locale: string): Place {
  const z = knownZone(zone);
  if (z === "UTC" || z === "Etc/UTC") return { kind: "zone", name: "UTC" };
  const country = countryOfZone(z);
  if (country && onlyZoneOfCountry(z)) {
    try {
      const name = new Intl.DisplayNames([locale], { type: "region" }).of(country);
      if (name && name !== country) return { kind: "country", name };
    } catch {
      // No names for regions here: the zone's own name below.
    }
  }
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: z, timeZoneName: "longGeneric" })
      .formatToParts(Date.now())
      .find((p) => p.type === "timeZoneName")?.value;
    if (name) return { kind: "zone", name: locale.startsWith("de") || locale.startsWith("en") ? name : lower(name) };
  } catch {
    // The runtime names no zones: its offset says it.
  }
  return { kind: "zone", name: z };
}

/** A zone's name as it reads mid-sentence in a language that does not capitalise it. */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export interface SentenceOptions {
  /** A language tag: the customer's, else the business's. */
  readonly lang: string;
  /** The total the fees are part of: a fee equal to it is said as the whole stay or price. */
  readonly total: Money;
  /** What is booked: `stay` says "the full stay", anything else "the full price". */
  readonly what?: "stay" | "price" | undefined;
  /** The place the business is, for "23:59 Kyoto time": its own town, else its country or its zone's name. */
  readonly place?: string | undefined;
  /** A locale for dates and money when the tag alone does not say it (`pt-BR`, `es-MX`). */
  readonly locale?: string | undefined;
}

/** The policy in one short paragraph, true to the dated steps: every fee, its date and time, and no-show. */
export function policySentence(dated: DatedPolicy, opts: SentenceOptions): string {
  const lang = policyLang(opts.lang);
  const w = WORDS[lang];
  const zone = knownZone(dated.zone);
  // Dates and money as they are written where the business is, in the reader's language.
  const locale = opts.locale ?? (opts.lang.includes("-") ? opts.lang : localeFor(lang, countryOfZone(zone)));
  const town = opts.place?.trim();
  const place: Place = town ? { kind: "town", name: town } : placeOf(zone, locale);
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
  const out: string[] = [];
  for (const s of dated.steps)
    out.push(s.fee.value === 0 ? w.free(when(s.until)) : w.paid(when(s.until), money(s.fee)));
  out.push(dated.steps.length > 0 ? w.after(money(dated.after)) : w.only(money(dated.after)));
  out.push(w.noShow(money(dated.noShow)));
  return out.join(" ");
}
