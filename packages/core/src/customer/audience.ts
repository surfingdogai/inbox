import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { business, parties } from "../schema/tables";
import { readSettings, type Settings } from "../settings/schema";
import type { Audience } from "./describe";
import { customerLang } from "./lang";

/** The business as its customers meet it: its name, time zone and languages, as its profile gives them. */
export interface BusinessFacts {
  readonly name: string;
  readonly domain: string | null;
  readonly timezone: string;
  readonly languages: readonly string[];
}

export async function businessFacts(db: Db, settings?: Settings): Promise<BusinessFacts> {
  const [row] = await db.orm.select().from(business).limit(1);
  const s = settings ?? (await readSettings(db));
  return {
    name: (row?.name || s.business.name).trim(),
    domain: row?.domain ?? null,
    timezone: row?.timezone ?? s.business.timezone,
    languages: row?.languages?.length ? row.languages : s.business.languages,
  };
}

/** The locale a party gave, if any (an assistant may send `contact.locale`). */
export async function partyLocale(db: Db, partyId: string): Promise<string | null> {
  const [row] = await db.orm.select({ contact: parties.contact }).from(parties).where(eq(parties.id, partyId));
  const locale = (row?.contact as { locale?: unknown } | null)?.locale;
  return typeof locale === "string" && locale ? locale : null;
}

/**
 * Who the business is speaking to, and how: the customer's language (their locale, else the
 * business's first language), the business's time zone, and the notice before a proposed time.
 */
export async function audienceFor(
  db: Db,
  opts: {
    readonly locale?: string | null | undefined;
    readonly partyId?: string | undefined;
    readonly closedByCustomer?: boolean | undefined;
    readonly question?: string | undefined;
    readonly facts?: BusinessFacts | undefined;
    readonly settings?: Settings | undefined;
  } = {},
): Promise<Audience> {
  const settings = opts.settings ?? (await readSettings(db));
  const facts = opts.facts ?? (await businessFacts(db, settings));
  const locale = opts.locale ?? (opts.partyId ? await partyLocale(db, opts.partyId) : null);
  return {
    lang: customerLang(locale, facts.languages),
    timezone: facts.timezone,
    minNoticeMin: settings.booking.minNoticeMin,
    ...(opts.closedByCustomer ? { closedByCustomer: true } : {}),
    ...(opts.question ? { question: opts.question } : {}),
  };
}
