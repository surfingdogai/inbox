/**
 * The days a legal period does not end on (Regulation 1182/71 art. 3(4)): Saturdays, Sundays and the
 * public holidays of the law the business sells under (ADR-018 §7). Portugal's national holidays and
 * the bank holidays of England and Wales are worked out here, Easter included; anywhere else only
 * weekends are known, which can only ever end a period later than the law would, never earlier.
 * Pure: the dates of a year, as YYYY-MM-DD.
 */
export type Law = "eu" | "pt" | "uk" | "other";

/**
 * The countries where Directive 2011/83/EU gives a consumer 14 days to withdraw from a distance contract
 * (ADR-018 Amendment 7): the member states (Greece also as EL, the EU's own code for it), with Åland and
 * the outermost regions that have codes of their own (French Guiana, Guadeloupe, Martinique, Réunion,
 * Mayotte, Saint-Martin), the EEA states that took the directive into their law (Iceland,
 * Liechtenstein, Norway), and Gibraltar, whose own law took it in too (LN 2013/177). Portugal is among
 * them; its own words and holidays come from `lawOf`.
 */
export const EU_LAW_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "EL",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "AX",
  "GF",
  "GP",
  "MQ",
  "RE",
  "YT",
  "MF",
  "IS",
  "LI",
  "NO",
  "GI",
]);

/**
 * The law a business sells under, from its own country (`commerce.legal.country`), never the buyer's or
 * where the goods go: Portugal's, the UK's, the EU's (a member state, the EEA or Gibraltar), or another
 * country's (`other`), whose consumer law the inbox does not hold, so it claims no right of withdrawal
 * there and tells customers only the return policies the owner wrote. With no country set it stays the
 * EU's, erring toward the customer, as return policies do. What it decides of a contract already asked
 * for is `contractLawOf`'s.
 */
export function lawOf(country: string | null | undefined): Law {
  const c = (country ?? "").trim().toUpperCase();
  if (c === "PT") return "pt";
  if (c === "GB" || c === "UK") return "uk";
  if (c === "" || EU_LAW_COUNTRIES.has(c)) return "eu";
  return "other";
}

/** The laws an order or a booking records as the one it was made under (`payload.law`). */
export const LAWS: readonly Law[] = ["eu", "pt", "uk", "other"];

/**
 * The law a booking or an order becomes a contract under (ADR-018 Amendment 7), as the business takes
 * the customer's request or the customer takes the business's offer: the law the customer was told before
 * they were bound (`told`: the one their confirm step judged their yes by), unless that claimed no right
 * and the business's country now gives one; else, told nothing or told none, the business's country's
 * now. So a contract is never under less than its customer was told, and never under `other` where the
 * business's country gives a right as it is made.
 */
export function concludedLawOf(country: string | null | undefined, told: Law | undefined): Law {
  return told !== undefined && told !== "other" ? told : lawOf(country);
}

/**
 * The law a contract is judged under (ADR-018 Amendment 7): the one its order or booking recorded
 * (`payload.law`: as it was asked for, and settled as it became a contract, `concludedLawOf`), so a later
 * change of the country moves nothing, nor the day an inbox took this release. One made before items
 * recorded it was told the law as it stood then, never `other`: its business's country's as it is now
 * (Portugal's, the UK's), else the EU's. So is one whose record this release cannot read.
 */
export function contractLawOf(
  country: string | null | undefined,
  contract: { readonly payload?: unknown } | null | undefined,
): Law {
  const recorded = (contract?.payload as { law?: unknown } | null | undefined)?.law;
  if (typeof recorded === "string" && (LAWS as readonly string[]).includes(recorded)) return recorded as Law;
  const law = lawOf(country);
  return law === "other" ? "eu" : law;
}

/** Easter Sunday of a year (the anonymous Gregorian algorithm), as YYYY-MM-DD. */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

const cache = new Map<string, ReadonlySet<string>>();

/** The public holidays of a year under a law, as YYYY-MM-DD; none known for the EU at large. */
export function holidays(year: number, law: Law): ReadonlySet<string> {
  const key = `${law}:${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Set<string>();
  if (law === "pt") {
    const e = easter(year);
    for (const md of ["01-01", "04-25", "05-01", "06-10", "08-15", "10-05", "11-01", "12-01", "12-08", "12-25"]) {
      out.add(`${year}-${md}`);
    }
    out.add(addDays(e, -2)); // Sexta-feira Santa
    out.add(e); // Páscoa
    out.add(addDays(e, 60)); // Corpo de Deus
  } else if (law === "uk") {
    const e = easter(year);
    out.add(substitute(ymd(year, 1, 1)));
    out.add(addDays(e, -2)); // Good Friday
    out.add(addDays(e, 1)); // Easter Monday
    out.add(nthMonday(year, 5, 1)); // Early May
    out.add(lastMonday(year, 5)); // Spring
    out.add(lastMonday(year, 8)); // Summer
    // Christmas and Boxing Day, each moved to the next weekday the other has not taken.
    const christmas = ymd(year, 12, 25);
    const boxing = ymd(year, 12, 26);
    const taken = new Set<string>();
    for (const day of [christmas, boxing]) {
      let d = day;
      while (weekend(d) || taken.has(d)) d = addDays(d, 1);
      taken.add(d);
      out.add(d);
    }
  }
  cache.set(key, out);
  return out;
}

/** Whether a YYYY-MM-DD is a Saturday or a Sunday. */
export function weekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Whether a period may end on this day under this law: not a weekend, not a public holiday. */
export function workingDay(date: string, law: Law): boolean {
  return !weekend(date) && !holidays(Number(date.slice(0, 4)), law).has(date);
}

/** A YYYY-MM-DD moved by whole days. */
export function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A holiday on a weekend is kept on the next Monday. */
function substitute(date: string): string {
  let d = date;
  while (weekend(d)) d = addDays(d, 1);
  return d;
}

function nthMonday(year: number, month: number, n: number): string {
  let d = ymd(year, month, 1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return addDays(d, 7 * (n - 1));
}

function lastMonday(year: number, month: number): string {
  let d = addDays(month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1), -1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, -1);
  return d;
}
