import { z } from "zod";
import { vocabNameSchema } from "./capabilities";
import { timestampSchema } from "./common";

/**
 * The census (`docs/protocol/network.md` §4.16, optional for a network): once a month, how many of the websites a
 * network checked an AI agent can do each thing with, as counts and nothing else. No row names a website. An edition
 * is taken as a draft, read by a person, and published; once published its counts never change (a mistake found later
 * withdraws the edition, with a note, and it stays readable). The counts are open data under Creative Commons
 * Attribution 4.0 (CC BY 4.0), credited "Surfing Dog census, surfingdog.ai, CC BY 4.0", and "© Overture Maps
 * Foundation" with them where they rest on Overture Maps places data (the cities). A network's directory may be under
 * another licence: ours is the ODbL.
 *
 * Rows are long: one count per scope, key and metric, so a table of any shape can be made from them, and a CSV of
 * the same rows reads the same as the JSON.
 */

/** `YYYY-MM`: the month an edition records. */
export const censusEditionIdSchema = z
  .string()
  .regex(/^20\d\d-(0[1-9]|1[0-2])$/)
  .describe("The month the edition records, YYYY-MM.");

/**
 * Where a row's count is taken. `all` is everything checked (its key is empty); `country` an ISO 3166-1 alpha-2 code;
 * `group` a kind of business (a category group slug of the directory); `platform` the website platform the network's
 * census reads (a slug, `none` for a site where it saw none); `source` where the network found the site (`seed`, the
 * public lists it starts from; `registry`, the MCP Registry; `discovered`, a link it followed; `checked`, a check a
 * person asked for; `member`); `city` a city slug, for the cities the network took a sample of. The schema takes any
 * lower-case scope, so a scope added later does not fail a reader: one it does not know, it skips.
 */
export const CENSUS_SCOPES = ["all", "country", "group", "platform", "source", "city"] as const;
export type CensusScope = (typeof CENSUS_SCOPES)[number];
export const censusScopeSchema = vocabNameSchema.describe(
  "all, country, group, platform, source or city; a reader skips a scope it does not know.",
);

/**
 * What a row counts: `checked`, the websites read; `agent_ready`, those an agent can reach through a door (askable or
 * above, on a site that does not ask AI to stay away); `can:<capability>`, those where an agent can do it (its state
 * is yes and rests on more than experimental evidence), counted among the agent-ready; `door:<type>`, those with a live
 * door of that type, counted among the agent-ready; `level:<name>`, those at that readiness level: a level below
 * askable among all checked, askable and above among the agent-ready; `no_ai`, those whose doors reach askable or above
 * and whose site asks AI systems to stay away (never agent-ready); and for a city, `places`, how many places its list
 * holds, read or not, so a reader sees how much of the city the counts cover. The levels and `no_ai` add up to
 * `checked`. For the whole, each country and each city (an edition that names `payments`): `pay_read`, the sites whose
 * ways to pay were read; `pay:<token>`, those that show the payment token at all, and `pay_declared:<token>`, those of
 * them that declared it themselves; `pay:<token>` minus `pay_declared:<token>` were only seen (a provider's code or
 * file on their site, or their shop platform's standard profile). A share is of `pay_read`. The pattern is any
 * lower-case name with at most one key after a colon, so an edition with a metric added later still validates.
 */
export const censusMetricSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(:[a-z0-9_]+)?$/)
  .describe(
    "A metric's name, or a family's with its key after a colon: checked, agent_ready, can:<capability>, door:<door type>, level:<level name>, no_ai, for a city places, and for the whole, a country and a city pay_read, pay:<payment token>, pay_declared:<payment token> today. Metrics are added, never renamed: a reader skips one it does not know.",
  );

export const censusRowSchema = z.object({
  scope: censusScopeSchema,
  key: z.string().max(64).describe("The scope's key: empty for all."),
  metric: censusMetricSchema,
  value: z.int().min(0),
});
export type CensusRow = z.infer<typeof censusRowSchema>;

/** The counts' licence: CC BY 4.0, and how to credit them. */
export const censusLicenceSchema = z.object({
  name: z.literal("CC-BY-4.0"),
  url: z.literal("https://creativecommons.org/licenses/by/4.0/"),
  attribution: z.string().describe('How to credit it: "Surfing Dog census, surfingdog.ai, CC BY 4.0".'),
  credits: z
    .array(z.string())
    .optional()
    .describe(
      'Credit for others\' data the counts rest on, given with the attribution: "© Overture Maps Foundation" when ' +
        "the cities are counted from Overture Maps places data.",
    ),
});

/** `GET /v1/census/{edition}`, and the same rows as CSV at `/census/{edition}.csv` (edition,scope,key,metric,value). */
export const censusEditionSchema = z.object({
  edition: censusEditionIdSchema,
  title: z.string(),
  status: z
    .enum(["draft", "published", "withdrawn"])
    .describe("A draft is served to the network's operators only; a published or withdrawn one to everyone."),
  as_of: timestampSchema.describe("When the counts were taken."),
  published_at: timestampSchema.nullable(),
  note: z
    .string()
    .max(2000)
    .nullable()
    .describe("Why a withdrawn edition was withdrawn, or anything a reader must know; null when there is nothing."),
  publish_note: z
    .string()
    .max(2000)
    .optional()
    .describe("For an edition published from a draft taken before its month ended: why it went out as it was."),
  method: z.object({
    version: z.int().min(1),
    url: z.url().describe("The method in words, with the edition."),
    min_sample: z
      .int()
      .min(1)
      .describe(
        "A country, kind of business, platform, source or city is published only with at least this many checked.",
      ),
    city_read: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("A city is partial until this share of its list (places) is checked."),
    rules_hash: z
      .string()
      .optional()
      .describe("The score rules' content the capabilities were read under: 16 hex of the SHA-256 of the document."),
    rules_share: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("The share of the checked scored under those rules when the counts were taken."),
    door_registry: z.int().min(0).optional().describe("The version of the door registry the doors were read by."),
    places_sources: z.array(z.string()).optional().describe("The city lists the cities were counted from."),
  }),
  vocabulary: z.object({ version: z.int().min(1), url: z.url() }).describe("The capability vocabulary counted."),
  score_rules: z
    .object({
      version: z.int().min(1),
      revised: z.iso
        .date()
        .nullable()
        .describe("The day those rules were last published or amended: a version amended in place counts differently."),
      url: z.url(),
    })
    .describe("The score rules the capabilities' states were read under."),
  capabilities: z.array(vocabNameSchema).describe("The capabilities counted, in vocabulary order."),
  doors: z.array(vocabNameSchema).describe("The door types counted."),
  levels: z.array(vocabNameSchema).describe("The readiness levels counted, lowest first."),
  payments: z
    .array(vocabNameSchema)
    .optional()
    .describe(
      "The payment tokens counted (vocab/payments.json), for the whole, each country and each city; absent from an edition that counts none.",
    ),
  left_out: z
    .record(censusScopeSchema, z.int().min(0))
    .describe("How many keys of each scope had fewer checked than min_sample, and are not in rows."),
  licence: censusLicenceSchema,
  rows: z.array(censusRowSchema),
});
export type CensusEdition = z.infer<typeof censusEditionSchema>;

/** `GET /v1/census`: the published editions, and the withdrawn ones with why, newest first. Drafts are never listed. */
export const censusEditionsSchema = z.object({
  title: z.string(),
  licence: censusLicenceSchema,
  editions: z.array(
    z.object({
      edition: censusEditionIdSchema,
      title: z.string(),
      status: z.enum(["published", "withdrawn"]),
      as_of: timestampSchema,
      published_at: timestampSchema,
      url: z.url().describe("The edition's page."),
      json: z.url(),
      csv: z.url(),
    }),
  ),
});
export type CensusEditions = z.infer<typeof censusEditionsSchema>;

/** The CSV's header: one line, then one line per row of `rows`, in the same order. */
export const CENSUS_CSV_HEADER = "edition,scope,key,metric,value";

/** One count from an edition's rows: every published key has a row for every metric, zero included; 0 for a key left out. */
export function censusValue(rows: readonly CensusRow[], scope: CensusScope, key: string, metric: string): number {
  return rows.find((r) => r.scope === scope && r.key === key && r.metric === metric)?.value ?? 0;
}
