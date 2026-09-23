import type { Money } from "../domain/types";
import type { CustomerLang } from "./lang";

/**
 * Times, amounts and references as the business writes them to a customer: in its own time zone,
 * with the zone named; money in the customer's language; a six-character reference instead of an id.
 */
const LOCALE: Record<CustomerLang, string> = { en: "en-GB", pt: "pt-PT" };

/**
 * `Thursday, 1 October 2026 at 10:00 (Western European Time)` · `quinta-feira, 1 de outubro de 2026
 * às 10:00 (hora da Europa Ocidental)`. UTC is named "UTC"; a runtime without the long generic zone
 * names gives the offset ("GMT+1").
 */
export function whenText(iso: string, timezone: string, lang: CustomerLang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const zone = validZone(timezone);
  let date: string;
  try {
    date = new Intl.DateTimeFormat(LOCALE[lang], {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    date = `${d.toISOString().replace("T", " ").slice(0, 16)}`;
    return `${date} (UTC)`;
  }
  return `${date} (${zoneName(zone, lang, d)})`;
}

/** The day alone, for a list of times grouped by day: `Thursday, 1 October` · `quinta-feira, 1 de outubro`. */
export function dayText(iso: string, timezone: string, lang: CustomerLang): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], {
      timeZone: validZone(timezone),
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** A date alone, with its year: `23 September 2026` · `23 de setembro de 2026`. */
export function dateText(iso: string, timezone: string, lang: CustomerLang): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], {
      timeZone: validZone(timezone),
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The time of day alone: `10:00`. */
export function timeText(iso: string, timezone: string, lang: CustomerLang): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], {
      timeZone: validZone(timezone),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** The calendar date (YYYY-MM-DD) an instant falls on in the business's zone. */
export function localDate(ms: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: validZone(timezone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** The zone as the customer's language names it: `Western European Time`, `hora da Europa Ocidental`. */
export function zoneName(timezone: string, lang: CustomerLang, at: Date = new Date()): string {
  const zone = validZone(timezone);
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  for (const style of ["longGeneric", "shortOffset"] as const) {
    try {
      const part = new Intl.DateTimeFormat(LOCALE[lang], { timeZone: zone, timeZoneName: style })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value;
      if (part) return lang === "pt" ? part.charAt(0).toLowerCase() + part.slice(1) : part;
    } catch {
      // This runtime does not know the style; try the next one.
    }
  }
  return zone;
}

/** `€45.00` · `45,00 €`. */
export function moneyIn(m: Money | { readonly value: number; readonly currency: string }, lang: CustomerLang): string {
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: m.currency }).format(m.value / 100);
  } catch {
    return `${(m.value / 100).toFixed(2)} ${m.currency}`;
  }
}

/**
 * What a customer typed, on one line: a name in a greeting, a subject in a subject line. A name with
 * line breaks in it cannot add lines of its own to an email the business sends.
 */
export function oneLine(text: string | null | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  return (text ?? "").replace(/[\s\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

/** The six characters a customer quotes back: the item id's last six, upper case (`7K3QXA`). */
export function shortRef(itemId: string): string {
  return itemId.slice(-6).toUpperCase();
}

function validZone(timezone: string): string {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}
