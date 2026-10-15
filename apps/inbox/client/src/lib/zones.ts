/**
 * Time zones as the owner picks one: by place, grouped by region, each with the time it is there now.
 * IANA names are what is stored; nobody is asked to type one.
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

const REGION_NAMES: Readonly<Record<string, string>> = {
  Africa: "Africa",
  America: "Americas",
  Antarctica: "Antarctica",
  Arctic: "Arctic",
  Asia: "Asia",
  Atlantic: "Atlantic",
  Australia: "Australia",
  Europe: "Europe",
  Indian: "Indian Ocean",
  Pacific: "Pacific",
};

/** The region a zone is listed under; anything without one (UTC, Etc/…) is "Other". */
export function regionOf(zone: string): string {
  const head = zone.split("/")[0] ?? "";
  return zone.includes("/") && REGION_NAMES[head] ? (REGION_NAMES[head] as string) : "Other";
}

/** The time it is in `zone` at `now`, as this browser writes times (`14:05`, `2:05 PM`); "" when unknown. */
export function clockIn(zone: string, now: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(now);
  } catch {
    return "";
  }
}

export interface ZoneOption {
  readonly zone: string;
  readonly label: string;
}
export interface ZoneGroup {
  readonly region: string;
  readonly zones: readonly ZoneOption[];
}

/**
 * Every zone, grouped by region in alphabetical order (Other last), places alphabetical within each,
 * each labelled `Lisbon · 14:05`. `keep` is always among them, so the stored zone never shows blank
 * (UTC, or an older name like Asia/Calcutta that this browser lists under another).
 */
export function zoneGroups(now: number, keep: readonly string[] = [], locale?: string): readonly ZoneGroup[] {
  const all = new Set(knownZones());
  for (const z of keep) if (z) all.add(z);
  all.add("UTC");
  const byRegion = new Map<string, ZoneOption[]>();
  for (const zone of all) {
    const region = regionOf(zone);
    const clock = clockIn(zone, now, locale);
    const label = clock ? `${placeOf(zone)} · ${clock}` : placeOf(zone);
    const list = byRegion.get(region) ?? [];
    list.push({ zone, label });
    byRegion.set(region, list);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([region, zones]) => ({
      region,
      zones: zones.sort((a, b) => placeOf(a.zone).localeCompare(placeOf(b.zone)) || a.zone.localeCompare(b.zone)),
    }));
}
