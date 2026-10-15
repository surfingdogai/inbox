import { z } from "zod";
import { isOwnerOrSystem } from "../access/outbound";
import { customerLang } from "../customer/lang";
import type { Db } from "../db";
import { type ItemType, itemTypeSchema } from "../domain/types";
import { ulid } from "../ids";
import { PRESETS, type PresetConfirm, presetFor } from "../rules/presets";
import { type RuleDefinition, ruleDefinitionSchema } from "../rules/schema";
import {
  isDoorElsewhereUrl,
  MAX_SETUP_SOURCES,
  MAX_SUGGESTED_SERVICES,
  readSettings,
  type SetupSource,
  setupFieldSchema,
  setupSourceSchema,
} from "../settings/schema";
import { servicePriceText } from "../util/money";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { fromZod, WriteError } from "../write/errors";
import { type Closure, readClosures } from "./closures";
import type { DoorSwitches } from "./directory";
import type { Capabilities } from "./service";
import { hasAmount, PRESET_NAMES, servicePriceKey, validTimezone } from "./setup";
import {
  closureSchema,
  presetConfirmSchema,
  presetKeySchema,
  priceSchema,
  profileInput,
  serviceInput,
  type WeeklyHours,
  weeklySchema,
} from "./setup-types";

/**
 * A setup plan: a business's details as they were read from its own site and checked by its owner,
 * applied to an inbox in one go — who it is, its opening hours and closed days, its services, the
 * rules for its kind of business, and its public profile. A dry run says in sentences what applying
 * would do; applying does exactly that and says the same.
 *
 * Applying is idempotent. Each part is compared with what the inbox holds and written only when it
 * differs, so the same plan applied twice changes nothing the second time, and a plan that stopped
 * part way (a lost connection, a restart) is finished by applying it again. A service is matched by
 * its name; a preset's rules are matched by theirs and replaced as a set, and the owner's other
 * rules are left alone.
 *
 * What a plan never holds: products, feeds, or who the business is in law (`commerce`). Those are the
 * owner's to add, in the app; only the country the site gave fills an empty legal country. A price goes in only when the owner typed or confirmed it
 * (`price_confirmed`); one read from a page is never applied. And a plan never lists the business in
 * a network's directory: it can only keep it out, and joining is the owner's to choose.
 */

/** At most this many services in a plan. */
export const MAX_PLAN_SERVICES = 50;

/** Who the business is, as `PUT /profile` takes it, without the domain: tying one is not the plan's to do. */
const planProfileSchema = profileInput
  .omit({ domain: true })
  .describe("The business's name, time zone, currency and languages.");

/** The public profile a directory would show, kept unpublished: a plan never lists the business. */
const planDirectorySchema = z
  .object({
    listed: z
      .literal(false)
      .optional()
      .describe(
        "false keeps the business out of every network's directory. A plan cannot list it: that is the owner's to choose, in the app.",
      ),
    url: z.literal("").optional().describe('"" clears the website in the public profile. A plan never sets one.'),
    description: z.string().max(500).optional().describe("A sentence or two about the business, in public."),
    categories: z.array(z.string().max(60)).max(10).optional(),
    address: z
      .object({
        streetAddress: z.string().max(200).optional(),
        addressLocality: z.string().max(100).optional(),
        postalCode: z.string().max(20).optional(),
        addressCountry: z
          .string()
          .regex(/^([A-Z]{2})?$/, "a two-letter country code in capitals, like PT, or nothing")
          .optional(),
      })
      .optional(),
    geo: z
      .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
      .nullable()
      .optional(),
  })
  .describe("The public profile, unpublished: what a directory would show once the owner chooses to be listed.");

const planServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  duration_min: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .optional()
    .describe("How long it takes, in minutes. Left out, a new service takes 60 and one that exists keeps its own."),
  price: priceSchema
    .optional()
    .describe("Only a price the owner typed or confirmed. Left out, the service is priced on request."),
  price_confirmed: z
    .boolean()
    .default(false)
    .describe(
      "true only when the owner typed or confirmed this price themselves. A price with an amount and no confirmation is never applied.",
    ),
});

/**
 * Where bookings or orders are taken instead of this inbox: a booking platform, the shop's own
 * checkout. Kept in the settings as `doorsElsewhere`; messages and quotes always stay here.
 */
const planElsewhereSchema = z.object({
  door: z.enum(["booking", "order"]).describe("booking: at a booking platform. order: in the shop's own checkout."),
  url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isDoorElsewhereUrl, "an https address on a public host, with no user or password in it")
    .describe("Where customers go for it."),
  name: z.string().max(120).optional().describe("What the place is called, for the sentences; not kept."),
});

/** A field a plan may never carry, with the reason in the refusal. */
const never = (what: string) =>
  z
    .never({ error: `a setup plan never holds ${what}: the owner adds them in the app` })
    .optional()
    .describe(`Never: ${what} are the owner's to add, in the app.`);

export const setupPlanSchema = z
  .strictObject({
    profile: planProfileSchema.optional(),
    directory: planDirectorySchema.optional(),
    hours: weeklySchema.optional(),
    closures: z.array(closureSchema).max(100).optional().describe("Closed days; replaces the list."),
    services: z
      .array(planServiceSchema)
      .max(MAX_PLAN_SERVICES)
      .optional()
      .refine((list) => !list || new Set(list.map((s) => nameKey(s.name))).size === list.length, {
        message: "a service is named twice",
      })
      .describe("Services, matched to the inbox's by name: one that exists is changed, one that does not is added."),
    preset: presetKeySchema.optional().describe("The rules for the kind of business."),
    booking: z
      .object({ confirm: presetConfirmSchema.default("owner") })
      .optional()
      .describe('Who says yes: "owner" (the default) leaves out the preset\'s rules that would on their own.'),
    doors: z
      .array(itemTypeSchema)
      .max(5)
      .optional()
      .describe(
        "The doors the plan expects to be on once applied. Each is switched on (`settings.doors`): asking for a price opens with nothing listed, a door the owner had switched off opens again. A booking still needs a service and hours to book it in; the result says which expected ones stay shut and why. A door left out of the list is left as it is.",
      ),
    doors_elsewhere: z
      .array(planElsewhereSchema)
      .max(2)
      .optional()
      .refine((list) => !list || new Set(list.map((d) => d.door)).size === list.length, {
        message: "one place for each door",
      })
      .describe(
        "Bookings or orders taken somewhere else, and where: replaces the list, so [] brings both back to the inbox.",
      ),
    suggested_services: z
      .array(z.object({ name: z.string().trim().min(1).max(120) }))
      .max(MAX_SUGGESTED_SERVICES)
      .optional()
      .describe(
        "Services read on the site that the plan does not apply (only a language model read them): kept for the owner to add, one press each, never on offer until they do. Replaces the list.",
      ),
    sources: z
      .record(setupFieldSchema, setupSourceSchema)
      .refine((s) => Object.keys(s).length <= MAX_SETUP_SOURCES, { message: `at most ${MAX_SETUP_SOURCES} fields` })
      .optional()
      .describe(
        "Where each detail was read, keyed by field (profile.name, hours, services, directory.address): kept so the owner can be asked to check what was only read from a page's words.",
      ),
    products: never("products"),
    feeds: never("feeds"),
    commerce: never("legal details"),
  })
  .describe("A business's setup, as read from its site and checked by its owner.");

export type SetupPlan = z.infer<typeof setupPlanSchema>;
export type SetupPlanInput = z.input<typeof setupPlanSchema>;

export interface SetupPlanResult {
  readonly dry_run: boolean;
  /** Whether applying changes anything (a dry run) or changed anything. False: the inbox already matched. */
  readonly changed: boolean;
  /** For a person, in order: where the details were read, what applying does, and what agents can do. */
  readonly sentences: readonly string[];
  readonly doors: {
    /** The doors on once the plan is applied: worked out for a dry run, read back after applying. */
    readonly on: readonly ItemType[];
    /** The doors the plan expects, when it names them. */
    readonly expected: readonly ItemType[] | null;
    /**
     * Expected doors that stay shut, each with what opens it; for a booking that waits on the inbox,
     * what it still needs (`needs`), for a host to point the owner at.
     */
    readonly missing: readonly {
      readonly door: ItemType;
      readonly why: string;
      readonly needs?: "service" | "hours" | "service_and_hours";
    }[];
  };
}

/** One part of a plan that differs from the inbox: what it says, and the write that makes it so. */
interface Step {
  readonly sentences: readonly string[];
  readonly run: () => Promise<unknown>;
}

type ServiceRow = Awaited<ReturnType<Capabilities["setup"]["listServices"]>>[number];

/**
 * Applies a setup plan, or with `dryRun` only says what applying would do. A dry run is any
 * owner-side caller's; applying is the owner's in person or the inbox's own (`system`): a plan sets
 * prices, hours and the rules that answer customers, so it is never the owner's AI's, nor a key's.
 */
export async function applySetupPlan(
  caps: Capabilities,
  db: Db,
  caller: Caller,
  input: SetupPlanInput,
  opts: { readonly dryRun?: boolean | undefined } = {},
): Promise<SetupPlanResult> {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "setup needs an owner or staff principal");
  const dryRun = opts.dryRun === true;
  if (!dryRun && !isOwnerOrSystem(caller)) {
    throw new WriteError(
      "not_allowed",
      "Only the owner applies a setup plan, signed in to the owner app or from the command line: it sets prices, opening hours and the rules that answer customers. Nothing was changed. Show the owner what it would do (a dry run) and let them apply it.",
      { details: { reason: "owner_in_person", ask_owner: true } },
    );
  }
  const parsed = setupPlanSchema.safeParse(input);
  if (!parsed.success) throw fromZod(parsed.error, "plan");
  const plan = parsed.data;
  if (plan.profile?.timezone !== undefined && !validTimezone(plan.profile.timezone)) {
    throw new WriteError("invalid_input", `unknown time zone ${plan.profile.timezone}`, {
      fields: [{ path: "plan.profile.timezone", problem: "invalid", message: "use an IANA name like Europe/Lisbon" }],
    });
  }

  const state = await readState(caps, db, caller);
  const check = pleaseCheck(plan.sources ?? {});
  const steps: Step[] = [];
  const notes: string[] = [];

  // ---- who the business is ----
  const profile = plan.profile;
  if (profile) {
    const patch: { name?: string; timezone?: string; currency?: string; languages?: string[] } = {};
    const said: string[] = [];
    if (profile.name !== undefined && profile.name !== state.profile.name) {
      patch.name = profile.name;
      said.push(check(`Names the business ${profile.name}.`, "profile.name"));
    }
    if (profile.timezone !== undefined && profile.timezone !== state.profile.timezone) {
      patch.timezone = profile.timezone;
      said.push(check(`Sets the time zone to ${profile.timezone}.`, "profile.timezone"));
    }
    if (profile.currency !== undefined && profile.currency.toUpperCase() !== state.profile.currency.toUpperCase()) {
      patch.currency = profile.currency.toUpperCase();
      said.push(check(`Sets the currency to ${patch.currency}.`, "profile.currency"));
    }
    if (profile.languages !== undefined && !same(profile.languages, state.profile.languages)) {
      patch.languages = profile.languages;
      said.push(check(`Sets the languages to ${languageWords(profile.languages)}.`, "profile.languages"));
    }
    if (said.length) steps.push({ sentences: said, run: () => caps.setup.updateProfile(caller, patch) });
  }
  const currency = (profile?.currency ?? state.profile.currency).toUpperCase();
  const languages = profile?.languages ?? state.profile.languages;

  // ---- services, matched by name ----
  const byName = new Map(state.services.map((s) => [nameKey(s.name), s]));
  const servicesAfter: { id: string; active: boolean; price: unknown }[] = state.services.map((s) => ({
    id: s.id,
    active: s.active === 1,
    price: s.price,
  }));
  for (const wanted of plan.services ?? []) {
    const name = wanted.name;
    const held = hasAmount(wanted.price) && !wanted.price_confirmed;
    // A price with an amount goes in only when the owner confirmed it; one that names none (by quote) always.
    const price = wanted.price && !held ? wanted.price : undefined;
    if (held) notes.push(`${name}'s price is left out until you confirm it.`);
    const existing = byName.get(nameKey(name));
    if (!existing) {
      const id = `new:${nameKey(name)}`;
      servicesAfter.push({ id, active: true, price: price ?? null });
      steps.push({
        sentences: [
          check(
            `Adds the service ${name}: ${minutes(wanted.duration_min ?? 60)}, ${priceWords(price ?? null, currency)}.`,
            "services",
          ),
        ],
        run: () =>
          caps.setup.createService(
            caller,
            serviceInput.parse({
              name,
              duration_min: wanted.duration_min ?? 60,
              ...(wanted.description !== undefined ? { description: wanted.description } : {}),
              ...(price ? { price } : {}),
            }),
          ),
      });
      continue;
    }
    const patch: {
      description?: string;
      duration_min?: number;
      price?: NonNullable<typeof price>;
      active?: boolean;
    } = {};
    const what: string[] = [];
    if (wanted.duration_min !== undefined && wanted.duration_min !== existing.durationMin) {
      patch.duration_min = wanted.duration_min;
      what.push(`${minutes(wanted.duration_min)} (was ${minutes(existing.durationMin)})`);
    }
    if (wanted.description !== undefined && wanted.description !== (existing.description ?? "")) {
      patch.description = wanted.description;
      what.push("a new description");
    }
    if (price && servicePriceKey(price, currency) !== servicePriceKey(existing.price ?? null, currency)) {
      patch.price = price;
      what.push(`${priceWords(price, currency)} (was ${priceWords(existing.price ?? null, currency)})`);
    }
    if (existing.active !== 1) {
      patch.active = true;
      what.push("on offer again");
    }
    const after = servicesAfter.find((s) => s.id === existing.id);
    if (after) {
      after.active = true;
      if (patch.price) after.price = patch.price;
    }
    if (what.length) {
      steps.push({
        sentences: [check(`Changes the service ${existing.name}: ${what.join(", ")}.`, "services")],
        run: () => caps.setup.updateService(caller, { service_id: existing.id, ...patch }),
      });
    }
  }

  // ---- opening hours and closed days ----
  let hoursAfter = state.hours;
  if (plan.hours) {
    const wanted = normalWeekly(plan.hours);
    hoursAfter = wanted;
    if (!state.hours || !same(state.hours, wanted)) {
      steps.push({
        sentences: [
          check(
            hasWindows(wanted)
              ? `Sets the opening hours: ${hoursWords(wanted)}.`
              : "Sets no opening hours: closed every day.",
            "hours",
          ),
        ],
        run: () => caps.setup.setWeekly(caller, { weekly: wanted }),
      });
    }
  }
  if (plan.closures) {
    const wanted = normalClosures(plan.closures);
    if (!same(wanted, normalClosures(state.closures))) {
      steps.push({
        sentences: [
          check(
            wanted.length ? `Sets the closed days: ${wanted.map(closureWords).join("; ")}.` : "Clears the closed days.",
            "closures",
          ),
        ],
        run: () => caps.setup.setClosures(caller, { closures: wanted }),
      });
    }
  }

  // ---- the rules for the kind of business ----
  const confirm: PresetConfirm = plan.booking?.confirm ?? "owner";
  let rulesAfter = state.rules;
  if (plan.preset) {
    const key = plan.preset;
    const chosen = presetFor(key, customerLang(null, languages), confirm).map((r) => ({
      name: r.name,
      priority: r.priority,
      definition: ruleDefinitionSchema.parse(r.definition),
    }));
    // Every rule the preset can bring, in either language and either way of saying yes: the set
    // replaced, so applying it again, or with the owner confirming this time, leaves one copy.
    const names = new Set((PRESETS[key] ?? []).map((r) => r.name));
    const mine = state.rules.filter((r) => names.has(r.name));
    const kept =
      mine.length === chosen.length &&
      chosen.every((c) =>
        mine.some(
          (m) => m.name === c.name && m.enabled && m.priority === c.priority && same(m.definition, c.definition),
        ),
      );
    rulesAfter = [...state.rules.filter((r) => !names.has(r.name)), ...chosen.map((c) => ({ ...c, enabled: true }))];
    if (!kept) {
      steps.push({
        sentences: [`Applies the ${PRESET_NAMES[key].toLowerCase()} rules: ${chosen.map((c) => c.name).join("; ")}.`],
        run: () => replaceRules(db, caller, [...names], chosen),
      });
    }
  }

  // ---- the public profile, unpublished, and where each detail came from ----
  const settingsPatch: Record<string, unknown> = {};
  const said: string[] = [];
  let countrySource: SetupSource | undefined;
  const dir = plan.directory;
  if (dir) {
    const current = state.settings.directory;
    const patch: Record<string, unknown> = {};
    if (dir.listed === false && current.listed) {
      patch.listed = false;
      said.push("Keeps the business out of every network's directory until you choose to be listed.");
    }
    if (dir.url === "" && current.url) {
      patch.url = "";
      said.push("Clears the website from the public profile.");
    }
    if (dir.description !== undefined && dir.description !== current.description) {
      patch.description = dir.description;
      said.push(
        check(
          dir.description ? `Sets the public description: “${dir.description}”.` : "Clears the public description.",
          "directory.description",
        ),
      );
    }
    if (dir.categories !== undefined && !same(dir.categories, current.categories)) {
      patch.categories = dir.categories;
      said.push(
        check(
          dir.categories.length ? `Sets the categories: ${dir.categories.join(", ")}.` : "Clears the categories.",
          "directory.categories",
        ),
      );
    }
    if (dir.address !== undefined) {
      const merged = { ...current.address, ...dir.address };
      if (!same(merged, current.address)) {
        patch.address = dir.address;
        const parts = [merged.streetAddress, merged.postalCode, merged.addressLocality, merged.addressCountry]
          .map((p) => (p ?? "").trim())
          .filter(Boolean);
        said.push(
          check(parts.length ? `Sets the address: ${parts.join(", ")}.` : "Clears the address.", "directory.address"),
        );
      }
    }
    if (dir.geo !== undefined && !same(dir.geo, current.geo)) {
      patch.geo = dir.geo;
      said.push(
        check(
          dir.geo
            ? `Places the business on the map at ${dir.geo.latitude}, ${dir.geo.longitude}.`
            : "Takes the business off the map.",
          "directory.geo",
        ),
      );
    }
    if (Object.keys(patch).length) settingsPatch.directory = patch;
    // The country the site gave is the one it sells under, until the owner says otherwise: it fills
    // an empty legal country (its consumer law, its words, its holidays), and never replaces one.
    const country = dir.address?.addressCountry;
    if (country && !state.settings.commerce.legal.country) {
      settingsPatch.commerce = { legal: { country } };
      said.push(check(`Sets the country you sell under to ${country}.`, "directory.address"));
      const read = plan.sources?.["directory.address"];
      if (read) countrySource = read;
    }
  }
  // ---- services read but not applied: suggested to the owner ----
  if (plan.suggested_services) {
    const known = new Set([
      ...state.services.map((svc) => nameKey(svc.name)),
      ...(plan.services ?? []).map((svc) => nameKey(svc.name)),
    ]);
    const wanted = plan.suggested_services.filter((svc) => !known.has(nameKey(svc.name)));
    if (!same(wanted, state.settings.setup.suggestions.services)) {
      settingsPatch.setup = { suggestions: { services: wanted } };
      if (wanted.length)
        said.push(
          `Suggests services to add: ${wanted.map((svc) => svc.name).join(", ")}. None is on offer until you add it.`,
        );
    }
  }
  // ---- bookings or orders taken somewhere else ----
  const elsewhereNow = state.settings.doorsElsewhere.map((d) => ({ itemType: d.itemType, url: d.url }));
  const elsewhere = plan.doors_elsewhere
    ? plan.doors_elsewhere.map((d) => ({ itemType: d.door, url: d.url, name: d.name }))
    : elsewhereNow;
  if (plan.doors_elsewhere) {
    const wanted = elsewhere.map((d) => ({ itemType: d.itemType, url: d.url }));
    if (!same(byDoor(wanted), byDoor(elsewhereNow))) {
      settingsPatch.doorsElsewhere = wanted;
      for (const d of byDoor(elsewhere)) said.push(elsewhereWords(d));
      for (const d of elsewhereNow) {
        if (!wanted.some((w) => w.itemType === d.itemType)) {
          said.push(
            d.itemType === "booking" ? "Bookings come to this inbox again." : "Orders come to this inbox again.",
          );
        }
      }
    }
  }
  // ---- what agents can do: the doors the plan expects, switched on where they would stay shut ----
  const doorsAfter: DoorSwitches = { ...state.settings.doors };
  if (plan.doors) {
    const patch: Record<string, boolean> = {};
    const listed = servicesAfter.some((svc) => svc.active) || state.products;
    if (plan.doors.includes("quote_request") && state.settings.doors.quoteRequest === false) {
      patch.quoteRequest = true;
      said.push("Lets agents ask you for a price again.");
    } else if (plan.doors.includes("quote_request") && !listed && state.settings.doors.quoteRequest !== true) {
      // Nothing listed yet: the request for a price opens anyway, the job in the request's own words.
      patch.quoteRequest = true;
      said.push("Lets agents ask you for a price, in their own words, before you list a service.");
    }
    if (plan.doors.includes("booking") && state.settings.doors.booking === false) {
      patch.booking = true;
      said.push("Lets agents book again.");
    }
    if (plan.doors.includes("message") && state.settings.doors.message === false) {
      patch.message = true;
      said.push("Lets agents send you messages again.");
    }
    if (Object.keys(patch).length) {
      settingsPatch.doors = patch;
      Object.assign(doorsAfter, patch);
    }
  }
  const sources = plan.sources
    ? { ...plan.sources, ...(countrySource ? { "commerce.legal.country": countrySource } : {}) }
    : undefined;
  if (sources && !same(sorted(sources), sorted(state.settings.setup.sources))) {
    // A merge keeps keys it is not sent, so a field the plan no longer names is sent as null.
    const gone = Object.keys(state.settings.setup.sources).filter((k) => !(k in sources));
    settingsPatch.setup = {
      ...(settingsPatch.setup as Record<string, unknown> | undefined),
      sources: { ...sources, ...Object.fromEntries(gone.map((k) => [k, null])) },
    };
    said.push("Keeps a note of where each detail was read.");
  }
  if (Object.keys(settingsPatch).length) {
    steps.push({ sentences: said, run: () => caps.updateSettings(caller, { doc: settingsPatch }) });
  }

  if (!dryRun) for (const step of steps) await step.run();

  // ---- what agents can do once it is applied ----
  const away = new Map(elsewhere.map((d) => [d.itemType as ItemType, elsewhereWords(d)]));
  const on = dryRun
    ? predictDoors({
        services: servicesAfter,
        own: state.ownHours,
        hours: hoursAfter,
        products: state.products,
        elsewhere: away,
        doors: doorsAfter,
      })
    : await caps.getBusinessProfile().then((p) => ITEM_ORDER.filter((t) => p.item_types.includes(t)));
  const rules = dryRun ? rulesAfter : (await readState(caps, db, caller)).rules;
  const expected = plan.doors ? ITEM_ORDER.filter((t) => plan.doors?.includes(t)) : null;
  const shut = expected ? expected.filter((d) => !on.includes(d)) : [];
  const after: DoorState = {
    services: servicesAfter,
    own: state.ownHours,
    hours: hoursAfter,
    elsewhere: away,
    doors: doorsAfter,
  };
  const missing = shut.map((door) => {
    const needs = door === "booking" ? bookingNeeds(after) : null;
    return { door, why: whyShut(door, after), ...(needs ? { needs } : {}) };
  });

  const sentences = [
    ...readFrom(plan.sources ?? {}),
    ...(steps.length ? steps.flatMap((s) => s.sentences) : ["Nothing to change: the inbox already matches this plan."]),
    ...notes,
    ...agentSentences(on, rules),
    ...missing.map((m) => m.why),
  ];
  return { dry_run: dryRun, changed: steps.length > 0, sentences, doors: { on, expected, missing } };
}

// ---- reading the inbox -------------------------------------------------------------------------

interface PlanRule {
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly definition: RuleDefinition;
}

interface State {
  readonly profile: { name: string; timezone: string; currency: string; languages: readonly string[] };
  readonly services: readonly ServiceRow[];
  /** The business's own weekly hours, when it has set any: not the fallback a booking uses without. */
  readonly hours: WeeklyHours | null;
  /** Services with hours of their own. */
  readonly ownHours: ReadonlyMap<string, WeeklyHours>;
  readonly closures: readonly Closure[];
  readonly rules: readonly PlanRule[];
  readonly products: boolean;
  readonly settings: Awaited<ReturnType<typeof readSettings>>;
}

async function readState(caps: Capabilities, db: Db, caller: Caller): Promise<State> {
  const [profile, services, open, closures, rules, products, settings] = await Promise.all([
    caps.setup.getProfile(caller),
    caps.setup.listServices(caller),
    db.client.query({ sql: "SELECT service_id, weekly FROM availability_rules WHERE kind = 'open'", method: "all" }),
    readClosures(db),
    caps.setup.listRules(caller),
    db.client.query({ sql: "SELECT 1 FROM products WHERE active = 1 LIMIT 1", method: "all" }),
    readSettings(db),
  ]);
  const base = open.rows.find((r) => r[0] === null || r[0] === undefined);
  const own = new Map(
    open.rows
      .filter((r) => r[0] !== null && r[0] !== undefined)
      .map((r) => [String(r[0]), normalWeekly(json(r[1]) as WeeklyHours)] as const),
  );
  return {
    profile: { ...profile, languages: [...profile.languages] },
    services,
    hours: base ? normalWeekly(json(base[1]) as WeeklyHours) : null,
    ownHours: own,
    closures,
    rules: rules.map((r) => ({ name: r.name, priority: r.priority, enabled: r.enabled, definition: r.definition })),
    products: products.rows.length > 0,
    settings,
  };
}

/** A preset's rules in place of the ones it brought before, in one batch: all of them or none. */
async function replaceRules(
  db: Db,
  caller: Caller,
  names: readonly string[],
  rules: readonly { name: string; priority: number; definition: RuleDefinition }[],
): Promise<void> {
  const now = nowOf(caller);
  await db.batch([
    {
      sql: `DELETE FROM rules WHERE name IN (${names.map(() => "?").join(", ")})`,
      params: [...names],
      method: "run",
    },
    ...rules.map((r) => ({
      sql: "INSERT INTO rules (id, name, priority, enabled, definition, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)",
      params: [ulid(), r.name, r.priority, JSON.stringify(r.definition), now, now],
      method: "run" as const,
    })),
  ]);
}

// ---- doors ---------------------------------------------------------------------------------

const ITEM_ORDER: readonly ItemType[] = ["message", "quote_request", "booking", "order", "refund"];

interface DoorState {
  readonly services: readonly { id: string; active: boolean; price: unknown }[];
  readonly own: ReadonlyMap<string, WeeklyHours>;
  readonly hours: WeeklyHours | null;
  /** The doors taken somewhere else, each with the sentence that says where. */
  readonly elsewhere: ReadonlyMap<ItemType, string>;
  /** The owner's switches (`settings.doors`), as the plan leaves them. */
  readonly doors: DoorSwitches;
}

/** Whether a service is asked about for a price (`quote`) rather than booked at a time. */
function quoted(price: unknown): boolean {
  return (price as { model?: unknown } | null)?.model === "quote";
}

/**
 * A service that can be booked: on offer, booked at a time (not asked about for a price), with weekly
 * hours that have a window (its own, else the business's).
 */
function bookable(s: DoorState): boolean {
  return (
    s.doors.booking !== false &&
    s.services.some((svc) => svc.active && !quoted(svc.price) && hasWindows(s.own.get(svc.id) ?? s.hours))
  );
}

/**
 * The doors on once a plan is applied, read as `offeredItemTypes` reads the inbox: a message always,
 * a booking with a service booked at a time that has hours, a quote with a service or a product, an order with a
 * product, a refund with something paid; a booking or an order taken somewhere else, never. The
 * tests hold the two to the same answer.
 */
function predictDoors(s: DoorState & { readonly products: boolean }): ItemType[] {
  const active = s.services.filter((svc) => svc.active);
  const priced = active.some((svc) => {
    const model = (svc.price as { model?: unknown } | null)?.model;
    return model === "fixed" || model === "from";
  });
  const booking = !s.elsewhere.has("booking") && bookable(s);
  const order = !s.elsewhere.has("order") && s.products;
  const on = new Set<ItemType>();
  if (s.doors.message !== false) on.add("message");
  if (booking) on.add("booking");
  if (order) on.add("order");
  if ((s.doors.quoteRequest === true || active.length > 0 || s.products) && s.doors.quoteRequest !== false)
    on.add("quote_request");
  if (order || (booking && priced)) on.add("refund");
  return ITEM_ORDER.filter((t) => on.has(t));
}

/** What a booking that stays shut still needs from the inbox: a service booked at a time, opening hours, or both. */
function bookingNeeds(s: DoorState): "service" | "hours" | "service_and_hours" | null {
  if (s.elsewhere.has("booking") || s.doors.booking === false) return null;
  const service = s.services.some((svc) => svc.active && !quoted(svc.price));
  const hours = hasWindows(s.hours) || [...s.own.values()].some(hasWindows);
  if (!service && !hours) return "service_and_hours";
  if (!service) return "service";
  if (!hours) return "hours";
  return null;
}

/** What opens a door the plan expects and the inbox will not have on. */
function whyShut(door: ItemType, s: DoorState): string {
  const away = s.elsewhere.get(door);
  if (away) return `${away.replace(/\.$/, "")}, so agents are sent there.`;
  if (door === "booking") {
    const listed = s.services.some((svc) => svc.active);
    const service = s.services.some((svc) => svc.active && !quoted(svc.price));
    const hours = hasWindows(s.hours) || [...s.own.values()].some(hasWindows);
    if (listed && !service) return "Booking turns on once a service is booked at a time, not asked for a price.";
    if (!service && !hours) return "Booking turns on when there are opening hours and at least one service.";
    if (!service) return "Booking turns on once there is a service to book.";
    if (!hours) return "Booking turns on once there are opening hours.";
    return "Booking turns on once a service on offer has opening hours.";
  }
  if (door === "quote_request") return "Asking for a price turns on once there is a service or a product.";
  if (door === "order") return "Orders turn on once there is a product on offer, which you add in the app.";
  if (door === "refund") return "Refunds turn on once something is sold with a price.";
  return "Messages are always on.";
}

/**
 * What agents can do, in a sentence or two built from the doors (`Agents can see your free times
 * and ask to book. You confirm each booking.`), and who says yes, from the rules that will run.
 */
function agentSentences(on: readonly ItemType[], rules: readonly PlanRule[]): string[] {
  const can: string[] = [];
  if (on.includes("booking")) can.push("see your free times and ask to book");
  if (on.includes("order")) can.push("order what you sell");
  if (on.includes("quote_request")) can.push("ask you for a price");
  if (on.includes("message")) can.push("send you a message");
  const out = can.length ? [`Agents can ${list(can, "or")}.`] : [];
  const yes = (event: string) =>
    rules.some((r) => r.enabled && r.definition.actions.some((a) => a.action === "transition" && a.event === event));
  if (on.includes("booking")) {
    out.push(yes("confirm") ? "Your rules confirm some bookings; you confirm the rest." : "You confirm each booking.");
  }
  if (on.includes("order")) {
    out.push(yes("accept") ? "Your rules accept some orders; you accept the rest." : "You accept each order.");
  }
  return out;
}

// ---- words -----------------------------------------------------------------------------------

/**
 * Where the details were read, once, at the top: the site most of them came from and the day of the
 * latest reading. A sentence about a detail only read from a page's words says "please check".
 */
function readFrom(sources: Record<string, SetupSource>): string[] {
  const all = Object.values(sources);
  if (!all.length) return [];
  const hosts = new Map<string, number>();
  for (const s of all) {
    const host = new URL(s.source_url).hostname.replace(/^www\./, "");
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const host = [...hosts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const latest = all.map((s) => Date.parse(s.checked_at)).reduce((a, b) => Math.max(a, b));
  return [`Read from ${host} on ${dayWords(latest)}.`];
}

function pleaseCheck(sources: Record<string, SetupSource>): (sentence: string, field: string) => string {
  return (sentence, field) => {
    const source = sources[field] ?? sources[field.split(".")[0] ?? field];
    if (source?.confidence !== "read") return sentence;
    return `${sentence.replace(/\.$/, "")} (please check).`;
  };
}

const DAY_NAMES: Record<keyof WeeklyHours, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const DAYS = Object.keys(DAY_NAMES) as (keyof WeeklyHours)[];

/** Weekly hours with only the days that have windows, in weekday order: one spelling per week. */
function normalWeekly(weekly: WeeklyHours | null | undefined): WeeklyHours {
  const out: WeeklyHours = {};
  for (const day of DAYS) {
    const windows = weekly?.[day];
    if (windows?.length) out[day] = windows.map(([a, b]): [string, string] => [a, b]);
  }
  return out;
}

function hasWindows(weekly: WeeklyHours | null | undefined): boolean {
  return Boolean(weekly && DAYS.some((d) => (weekly[d]?.length ?? 0) > 0));
}

/**
 * `Mon–Fri 09:00–18:00, Sat 09:00–14:00`: days in a row with the same windows go together. A day
 * open from 00:00 to 24:00 is `open 24 hours`; every day so is `open all the time`.
 */
function hoursWords(weekly: WeeklyHours): string {
  const allDay = (w: readonly (readonly [string, string])[] | undefined) =>
    w?.length === 1 && w[0]?.[0] === "00:00" && w[0]?.[1] === "24:00";
  if (DAYS.every((d) => allDay(weekly[d]))) return "open all the time";
  const runs: { from: keyof WeeklyHours; to: keyof WeeklyHours; windows: string }[] = [];
  for (const day of DAYS) {
    const windows = weekly[day];
    if (!windows?.length) continue;
    const words = allDay(windows) ? "open 24 hours" : windows.map(([a, b]) => `${a}–${b}`).join(" and ");
    const last = runs.at(-1);
    if (last && last.windows === words && DAYS.indexOf(last.to) === DAYS.indexOf(day) - 1) last.to = day;
    else runs.push({ from: day, to: day, windows: words });
  }
  return runs.map((r) => `${DAY_NAMES[r.from]}${r.from === r.to ? "" : `–${DAY_NAMES[r.to]}`} ${r.windows}`).join(", ");
}

function normalClosures(closures: readonly Closure[]): Closure[] {
  return closures
    .map((c) => ({ from: c.from, to: c.to, ...(c.reason?.trim() ? { reason: c.reason.trim() } : {}) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

function closureWords(c: Closure): string {
  const day = (d: string) => dayWords(Date.parse(`${d}T12:00:00Z`));
  const when = c.from === c.to ? day(c.from) : `${day(c.from)} to ${day(c.to)}`;
  return c.reason ? `${when} (${c.reason})` : when;
}

function dayWords(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    ms,
  );
}

function minutes(n: number): string {
  return `${n} minutes`;
}

function priceWords(price: Parameters<typeof servicePriceText>[0], currency: string): string {
  return servicePriceText(price, currency) ?? "price on request";
}

function languageWords(codes: readonly string[]): string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    names = null;
  }
  return list(
    codes.map((c) => {
      try {
        return names?.of(c) ?? c;
      } catch {
        return c;
      }
    }),
    "and",
  );
}

/** `a, b or c`. */
function list(words: readonly string[], last: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

/** A service's name as two plans or an owner might spell it: trimmed, any case. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A door taken somewhere else, said: "Bookings stay at Fresha." or "Orders stay in your own checkout." */
function elsewhereWords(d: { readonly itemType: string; readonly url: string; readonly name?: string | undefined }) {
  if (d.itemType === "order") return "Orders stay in your own checkout.";
  return `Bookings stay at ${d.name?.trim() || new URL(d.url).hostname}.`;
}

/** Doors elsewhere in one order, booking first, so the same list compares the same. */
function byDoor<T extends { readonly itemType: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.itemType < b.itemType ? -1 : a.itemType > b.itemType ? 1 : 0));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sorted<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A JSON column as it comes back: text on SQLite and D1, parsed leniently. */
function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
