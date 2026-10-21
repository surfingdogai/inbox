import { eq } from "drizzle-orm";
import { businessFacts } from "../customer/audience";
import type { Db } from "../db";
import { business, parties } from "../schema/tables";
import { readSettings, type Settings } from "../settings/schema";
import { type StayLang, stayLang } from "./copy";

/**
 * The language a stay speaks to its guest, everywhere it does (the quote's lines, its pages, its
 * emails, its pay links): the guest's own when they gave one, else the first of the languages the
 * owner chose for stays, else the business's first, as its profile gives it.
 */
export async function guestLang(
  db: Db,
  opts: {
    readonly locale?: string | null | undefined;
    readonly partyId?: string | null | undefined;
    readonly settings?: Settings;
  },
): Promise<StayLang> {
  const settings = opts.settings ?? (await readSettings(db));
  const locale = opts.locale ?? (opts.partyId ? await partyLocale(db, opts.partyId) : null);
  if (locale) return stayLang(locale);
  if (settings.stays.languages[0]) return stayLang(settings.stays.languages[0]);
  return stayLang((await businessFacts(db, settings)).languages[0] ?? "en");
}

/** The locale a guest gave, on their contact or their party. */
export async function partyLocale(db: Db, partyId: string): Promise<string | null> {
  const [party] = await db.orm
    .select({ contact: parties.contact, locale: parties.locale })
    .from(parties)
    .where(eq(parties.id, partyId));
  const c = (party?.contact ?? {}) as { locale?: string };
  return c.locale ?? party?.locale ?? null;
}

/** The business's time zone and currency, as its profile gives them (the settings' copy only when it has none). */
export async function businessZoneAndCurrency(
  db: Db,
  settings: Settings,
): Promise<{ readonly timezone: string; readonly currency: string }> {
  const [row] = await db.orm
    .select({ timezone: business.timezone, currency: business.currency })
    .from(business)
    .limit(1);
  return {
    timezone: row?.timezone || settings.business.timezone,
    currency: row?.currency || settings.business.currency,
  };
}
