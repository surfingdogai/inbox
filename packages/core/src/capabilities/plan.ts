import { z } from "zod";
import { isOwnerOrSystem } from "../access/outbound";
import { customerLang } from "../customer/lang";
import type { Db } from "../db";
import { type ItemType, itemTypeSchema } from "../domain/types";
import { ulid } from "../ids";
import { PRESETS, type PresetConfirm, presetFor } from "../rules/presets";
import { type RuleDefinition, ruleDefinitionSchema } from "../rules/schema";
import {
  MAX_SETUP_SOURCES,
  readSettings,
  type SetupSource,
  setupFieldSchema,
  setupSourceSchema,
} from "../settings/schema";
import { servicePriceText } from "../util/money";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { fromZod, WriteError } from "../write/errors";
import { type Closure, readClosures } from "./closures";
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
 * owner's to add, in the app. A price goes in only when the owner typed or confirmed it
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
  duration_min: z.number().int().min(5).max(1440).default(60),
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

/** Where a door is handled instead of this inbox: a booking platform, the shop's own checkout. */
const planElsewhereSchema = z.object({
  door: z.enum(["booking", "order", "quote_request"]),
  url: z.url({ protocol: /^https$/ }).max(2048),
  name: z.string().max(120).optional(),
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
        "The doors the plan expects to be on once applied. The inbox opens a door from what it holds (booking with hours and a service), and says which expected ones stay shut and why.",
      ),
    doors_elsewhere: z
      .array(planElsewhereSchema)
      .max(5)
      .optional()
      .describe("Doors handled somewhere else, such as bookings on a booking platform."),
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
    /** Expected doors that stay shut, each with what opens it. */
    readonly missing: readonly { readonly door: ItemType; readonly why: string }[];
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
  if (plan.doors_elsewhere?.length) {
    throw new WriteError(
      "invalid_input",
      "This version of the inbox does not record doors handled elsewhere: leave doors_elsewhere out of the plan.",
      { fields: [{ path: "plan.doors_elsewhere", problem: "invalid", message: "not recorded by this version" }] },
    );
  }
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
            `Adds the service ${name}: ${minutes(wanted.duration_min)}, ${priceWords(price ?? null, currency)}.`,
            "services",
          ),
        ],
        run: () =>
          caps.setup.createService(
            caller,
            serviceInput.parse({
              name,
              duration_min: wanted.duration_min,
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
    if (wanted.duration_min !== existing.durationMin) {
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
  }
  if (plan.sources && !same(sorted(plan.sources), sorted(state.settings.setup.sources))) {
    // A merge keeps keys it is not sent, so a field the plan no longer names is sent as null.
    const gone = Object.keys(state.settings.setup.sources).filter((k) => !(k in (plan.sources ?? {})));
    settingsPatch.setup = { sources: { ...plan.sources, ...Object.fromEntries(gone.map((k) => [k, null])) } };
    said.push("Keeps a note of where each detail was read.");
  }
  if (Object.keys(settingsPatch).length) {
    steps.push({ sentences: said, run: () => caps.updateSettings(caller, { doc: settingsPatch }) });
  }

  if (!dryRun) for (const step of steps) await step.run();

  // ---- what agents can do once it is applied ----
  const on = dryRun
    ? predictDoors({ services: servicesAfter, own: state.ownHours, hours: hoursAfter, products: state.products })
    : await caps.getBusinessProfile().then((p) => ITEM_ORDER.filter((t) => p.item_types.includes(t)));
  const rules = dryRun ? rulesAfter : (await readState(caps, db, caller)).rules;
  const expected = plan.doors ? ITEM_ORDER.filter((t) => plan.doors?.includes(t)) : null;
  const shut = expected ? expected.filter((d) => !on.includes(d)) : [];
  const missing = shut.map((door) => ({
    door,
    why: whyShut(door, { services: servicesAfter, own: state.ownHours, hours: hoursAfter }),
  }));

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
}

/** A service that can be booked: on offer, with weekly hours that have a window (its own, else the business's). */
function bookable(s: DoorState): boolean {
  return s.services.some((svc) => svc.active && hasWindows(s.own.get(svc.id) ?? s.hours));
}

/**
 * The doors on once a plan is applied, read as `offeredItemTypes` reads the inbox: a message always,
 * a booking with a service that has hours, a quote with a service or a product, an order with a
 * product, a refund with something paid. The tests hold the two to the same answer.
 */
function predictDoors(s: DoorState & { readonly products: boolean }): ItemType[] {
  const active = s.services.filter((svc) => svc.active);
  const priced = active.some((svc) => {
    const model = (svc.price as { model?: unknown } | null)?.model;
    return model === "fixed" || model === "from";
  });
  const on = new Set<ItemType>(["message"]);
  if (bookable(s)) on.add("booking");
  if (s.products) on.add("order");
  if (active.length > 0 || s.products) on.add("quote_request");
  if (s.products || (bookable(s) && priced)) on.add("refund");
  return ITEM_ORDER.filter((t) => on.has(t));
}

/** What opens a door the plan expects and the inbox will not have on. */
function whyShut(door: ItemType, s: DoorState): string {
  if (door === "booking") {
    const service = s.services.some((svc) => svc.active);
    const hours = hasWindows(s.hours) || [...s.own.values()].some(hasWindows);
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

/** `Mon–Fri 09:00–18:00, Sat 09:00–14:00`: days in a row with the same windows go together. */
function hoursWords(weekly: WeeklyHours): string {
  const runs: { from: keyof WeeklyHours; to: keyof WeeklyHours; windows: string }[] = [];
  for (const day of DAYS) {
    const windows = weekly[day];
    if (!windows?.length) continue;
    const words = windows.map(([a, b]) => `${a}–${b}`).join(" and ");
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
