import { countryName } from "./countries";
import { countryOfZone, zonesOfCountry } from "./geo";

/**
 * Time zones as the owner picks one: by country and city, typed ahead, each with the time it is there
 * now (`Portugal — Lisbon · 14:05`); the zone this browser is in and the business's own country's
 * first. IANA names are what is stored; nobody is asked to type one.
 */

/** The zones this browser knows, IANA names. */
export function knownZones(): readonly string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/** The zone this browser is in, or null when it cannot say (or says UTC, which tells us nothing). */
export function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "UTC" && zone !== "Etc/UTC" ? zone : null;
  } catch {
    return null;
  }
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires, Argentina"; "Europe/Lisbon" → "Lisbon"; "UTC" → "UTC". */
export function placeOf(zone: string): string {
  const parts = zone.split("/").map((p) => p.replaceAll("_", " "));
  if (parts.length === 1) return parts[0] ?? zone;
  const city = parts[parts.length - 1] ?? zone;
  return parts.length > 2 ? `${city}, ${parts.slice(1, -1).join(", ")}` : city;
}

/** The city alone: "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function cityOf(zone: string): string {
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

/** The time it is in `zone` at `now`, as this browser writes times (`14:05`, `2:05 PM`); "" when unknown. */
export function clockIn(zone: string, now: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(now);
  } catch {
    return "";
  }
}

/** Zones nobody runs a business in: research stations, and the fixed offsets. */
function offered(zone: string): boolean {
  return !/^(Antarctica|Arctic|Etc)\//.test(zone) && zone !== "Factory";
}

export interface ZoneChoice {
  readonly zone: string;
  /** "Portugal — Lisbon", or the place alone when the zone is in no country (UTC). */
  readonly name: string;
  /** The time there now. */
  readonly clock: string;
  /** Words to match what the owner types: the country, the city, the region. */
  readonly words: string;
}

/** A zone as the owner reads it: `Portugal — Lisbon`, `United States — New York`. */
export function zoneName(zone: string, locale?: string): string {
  const country = countryOfZone(zone);
  if (!country) return placeOf(zone);
  const name = countryName(country, locale?.split("-")[0] ?? "en");
  const city = cityOf(zone);
  return name.toLowerCase() === city.toLowerCase() ? name : `${name} — ${city}`;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** One zone, ready to list. */
export function zoneChoice(zone: string, now: number, locale?: string): ZoneChoice {
  const name = zoneName(zone, locale);
  return { zone, name, clock: clockIn(zone, now, locale), words: fold(`${name} ${zone.replaceAll("_", " ")}`) };
}

/**
 * Every zone a business could be in, by country then city (`keep` among them even when it is one
 * this list leaves out, so the stored zone never shows blank), and the ones to suggest first: the
 * zone this browser is in, the one chosen now, then the rest of the business's country's own.
 */
export function zoneChoices(
  now: number,
  opts: {
    readonly keep?: string | undefined;
    readonly browser?: string | null;
    readonly country?: string | null;
    readonly locale?: string;
  } = {},
): { readonly suggested: readonly ZoneChoice[]; readonly all: readonly ZoneChoice[] } {
  const zones = new Set(knownZones().filter(offered));
  if (opts.keep) zones.add(opts.keep);
  zones.add("UTC");
  const all = [...zones]
    .map((z) => zoneChoice(z, now, opts.locale))
    .sort((a, b) => a.name.localeCompare(b.name, opts.locale) || a.zone.localeCompare(b.zone));
  const want = [
    ...(opts.browser ? [opts.browser] : []),
    ...(opts.keep ? [opts.keep] : []),
    ...zonesOfCountry(opts.country ?? countryOfZone(opts.keep) ?? countryOfZone(opts.browser)),
  ];
  const suggested: ZoneChoice[] = [];
  for (const z of want) {
    const found = all.find((c) => c.zone === z);
    if (found && !suggested.includes(found)) suggested.push(found);
  }
  return { suggested: suggested.slice(0, 8), all };
}

/**
 * The zones that match what the owner typed, best first: a country or a city that starts with it,
 * then one with a word that does, then one that holds it. Empty text matches nothing (the suggested
 * ones are shown instead).
 */
export function matchZones(text: string, all: readonly ZoneChoice[], limit = 40): readonly ZoneChoice[] {
  const q = fold(text.trim());
  if (!q) return [];
  const scored: { c: ZoneChoice; score: number; at: number }[] = [];
  all.forEach((c, at) => {
    let score = 0;
    if (c.words.startsWith(q) || fold(cityOf(c.zone)).startsWith(q)) score = 3;
    else if (c.words.split(/[\s—/,-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (q.length > 2 && c.words.includes(q)) score = 1;
    if (score) scored.push({ c, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.c);
}
