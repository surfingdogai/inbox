import { z } from "zod";
import { capabilityIdSchema } from "./capabilities";
import { timestampSchema } from "./common";

/**
 * The census (`docs/protocol/network.md` §4.16, optional for a network): once a month, how many of the businesses a
 * network checked an AI agent can do each thing with, as counts and nothing else. No row names a business. An edition
 * is taken as a draft, read by a person, and published; once published its counts never change (a mistake found later
 * withdraws the edition, with a note, and it stays readable). The dataset is open under the Open Database License 1.0.
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
 * census reads (a slug, `none` for a site where it saw none); `city` a city slug, for the cities the network took a
 * sample of.
 */
export const censusScopeSchema = z.enum(["all", "country", "group", "platform", "city"]);
export type CensusScope = z.infer<typeof censusScopeSchema>;

/**
 * What a row counts: `checked`, the businesses' websites read; `agent_ready`, those an agent can reach through a door
 * (askable or above); `can:<capability>`, those where an agent can do it (its state is yes and rests on more than
 * experimental evidence), counted among the agent-ready; `door:<type>`, those with a live door of that type, counted
 * among the agent-ready; `level:<name>`, those at that readiness level, counted among all checked; and for a city,
 * `places`, how many places its list holds, read or not, so a reader sees how much of the city the counts cover.
 */
export const censusMetricSchema = z
  .string()
  .regex(/^(checked|agent_ready|places|can:[a-z]+|door:[a-z0-9_]+|level:[a-z]+)$/)
  .describe("checked, agent_ready, can:<capability>, door:<door type>, level:<level name>, or for a city places.");

export const censusRowSchema = z.object({
  scope: censusScopeSchema,
  key: z.string().max(64).describe("The scope's key: empty for all."),
  metric: censusMetricSchema,
  value: z.int().min(0),
});
export type CensusRow = z.infer<typeof censusRowSchema>;

export const censusLicenceSchema = z.object({
  name: z.literal("ODbL-1.0"),
  url: z.literal("https://opendatacommons.org/licenses/odbl/1-0/"),
  attribution: z.string().describe('How to credit it: "Surfing Dog (surfingdog.ai)".'),
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
  method: z.object({
    version: z.int().min(1),
    url: z.url().describe("The method in words, with the edition."),
    min_sample: z
      .int()
      .min(1)
      .describe("A country, kind of business, platform or city is published only with at least this many checked."),
  }),
  vocabulary: z.object({ version: z.int().min(1), url: z.url() }).describe("The capability vocabulary counted."),
  score_rules: z.int().min(1).describe("The score rules version the capabilities' states were read under."),
  capabilities: z.array(capabilityIdSchema).describe("The capabilities counted, in vocabulary order."),
  doors: z.array(z.string()).describe("The door types counted."),
  levels: z.array(z.string()).describe("The readiness levels counted, lowest first."),
  left_out: z
    .partialRecord(censusScopeSchema, z.int().min(0))
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
