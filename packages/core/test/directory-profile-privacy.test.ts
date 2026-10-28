import { runMigrations } from "@surfingdog/platform";
import { ATTRIBUTES_VOCABULARY, profileSchema } from "@surfingdog/spec";
import { describe, expect, it, vi } from "vitest";
import { directoryProfile } from "../src/capabilities/directory";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { menuFieldsSchema } from "../src/menu/schema";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox } from "../src/secrets/box";
import { readSettings } from "../src/settings/schema";
import type { Caller } from "../src/write/index";
import { confirming, makeClient, resetTables } from "./harness";

/**
 * The profile a manifest publishes to every network (spec 0.13) is built from an allow-list: the business's own data
 * and nothing else. An inbox full of customers, their messages, the people who work there, what is in stock and the
 * owner's own notes gives a profile with only the allowed keys, and none of those words in it. Node and workerd.
 */
vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-28T10:00:00Z");
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
  principal: { via: "session", id: "s1", name: "owner", scopes: ["*"], userId: "u1" },
};

/** Every path a profile may hold: `*` is any key of a record, `[]` any entry of a list. */
const ALLOWED = new Set([
  "name",
  "description",
  "categories[]",
  "languages[]",
  "address.streetAddress",
  "address.addressLocality",
  "address.postalCode",
  "address.addressCountry",
  "geo.latitude",
  "geo.longitude",
  "url",
  "hours.timezone",
  "hours.weekly.*[][]",
  "hours.closures[].from",
  "hours.closures[].to",
  "services[].name",
  "services[].type",
  "place_category.primary",
  "place_category.alternates[]",
  "attributes.*",
  "price_band",
  "currencies[]",
  "payments[]",
  "lodging.kind",
  "lodging.rooms",
  "lodging.check_in_from",
  "lodging.check_out_until",
  "lodging.confirmation",
  "lodging.answer_hours",
  "lodging.registration",
  "cuisines[]",
  "reservations",
  "sources.*.via",
  "sources.*.url",
  "sources.*.at",
]);
/** Objects whose keys are data (a weekday, an attribute, a field), not part of the shape. */
const RECORDS = new Set(["attributes", "sources", "hours.weekly"]);

function paths(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => paths(v, `${at}[]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => paths(v, `${at}${at ? "." : ""}${RECORDS.has(at) ? "*" : k}`));
  }
  return [at];
}

/** What must never leave: customers, their words, the people who work there, stock, the owner's notes. */
const PRIVATE = [
  "Rita Customer",
  "rita@customer.example",
  "351912345678",
  "allergic to walnuts",
  "Please ring me back",
  "Rita's private reply",
  "Joana Staff",
  "staff@tasca.example",
  "Chef Rui",
  "owner@tasca.example",
  "Tasca Lda",
  "PT509999990",
  "the owner's surgery",
  "Where I was on 21 Oct",
  "38.7216",
  "Omakase we never serve",
  "Secret broth recipe",
  "Shoyu ramen",
];

describe("the directory profile is business data only", () => {
  it("holds only the allowed keys, and none of what is said about or by a customer, a person or the stock", async () => {
    const db = createDb(await makeClient());
    await runMigrations(db.client, MIGRATIONS);
    await resetTables(db.client);
    const caps = confirming(new Capabilities(db, createSecretBox(["privacy-test-key-0123456789abcdef0123"])));
    const read = { source_url: "https://tasca.example/sobre", checked_at: "2026-10-27T09:00:00Z", confidence: "read" };
    await caps.updateSettings(owner, {
      doc: {
        business: { name: "Tasca do Ramen", currency: "EUR", timezone: "Europe/Lisbon", languages: ["pt", "en"] },
        notifications: { ownerEmail: "owner@tasca.example" },
        commerce: {
          legal: {
            legalName: "Tasca Lda",
            email: "owner@tasca.example",
            phone: "+351 912 345 678",
            vatId: "PT509999990",
          },
        },
        kitchen: {
          enabled: true,
          methods: { pickup: true, delivery: true, dineIn: true },
          pause: { until: "2026-10-28T09:00:00Z", by: "Joana Staff" },
        },
        area: {
          base: { from: "device", point: { lat: 38.7216, lng: -9.1355 }, label: "Where I was on 21 Oct" },
          zones: [{ name: "Arroios", mode: "radius", radiusKm: 3 }],
        },
        payments: { accepted: ["card", "mb_way"] },
        directory: {
          description: "Hand-pulled ramen in Arroios.",
          categories: ["restaurant"],
          address: {
            streetAddress: "Rua X 1",
            addressLocality: "Lisboa",
            postalCode: "1000-001",
            addressCountry: "PT",
          },
          geo: { latitude: 38.72, longitude: -9.13 },
          url: "https://tasca.example",
          placeCategory: { primary: "noodles_restaurant", alternates: ["japanese_restaurant"] },
          cuisines: ["ramen", "japanese"],
          reservations: "recommended",
          priceBand: 2,
          features: ["wifi", "outdoor_seating"],
        },
        setup: {
          sources: { hours: read, "directory.cuisines": { ...read, confidence: "declared" } },
          suggestions: { services: [{ name: "Omakase we never serve" }] },
        },
      },
    });
    await caps.setup.setWeekly(owner, { weekly: { tue: [["12:00", "15:00"]], sat: [["12:00", "23:00"]] } });
    await caps.setup.setClosures(owner, {
      closures: [{ from: "2026-12-24", to: "2026-12-26", reason: "the owner's surgery" }],
    });
    const dish = await caps.setup.createProduct(owner, {
      name: "Shoyu ramen",
      description: "Secret broth recipe",
      price: { value: 1450, currency: "EUR" },
      stock: 3,
      active: true,
    });
    await caps.food.setMenuItem(owner, {
      product_id: dish.id,
      menu: menuFieldsSchema.parse({ section: "ramen", dietary: ["vegan"], dailyCap: 7, blackout: ["2026-12-31"] }),
    });
    await db.batch([
      {
        sql: "INSERT INTO users (id, email, name, role, created_at) VALUES ('u2', 'staff@tasca.example', 'Joana Staff', 'staff', ?)",
        params: [T0],
        method: "run",
      },
      {
        sql: "INSERT INTO resources (id, name, capacity, active, created_at) VALUES ('r1', 'Chef Rui', 1, 1, ?)",
        params: [T0],
        method: "run",
      },
      {
        sql: "INSERT INTO parties (id, kind, display_name, contact, notes, created_at, updated_at) VALUES ('p1', 'human', 'Rita Customer', ?, 'allergic to walnuts', ?, ?)",
        params: [JSON.stringify({ email: "rita@customer.example", phone: "+351912345678" }), T0, T0],
        method: "run",
      },
      {
        sql: `INSERT INTO items (id, type, state, version, party_id, channel, payload, flags, created_at, updated_at)
              VALUES ('i1', 'message', 'open', 1, 'p1', 'email', ?, '{}', ?, ?)`,
        params: [JSON.stringify({ text: "Please ring me back on +351912345678" }), T0, T0],
        method: "run",
      },
      {
        sql: `INSERT INTO thread_entries (id, item_id, direction, channel, actor_kind, body_text, created_at)
              VALUES ('e1', 'i1', 'in', 'email', 'customer', 'Rita''s private reply', ?)`,
        params: [T0],
        method: "run",
      },
    ]);

    const settings = await readSettings(db);
    const profile = await directoryProfile(db, {
      name: settings.business.name,
      languages: settings.business.languages,
      timezone: settings.business.timezone,
      currency: settings.business.currency,
      directory: settings.directory,
      payments: settings.payments.accepted,
      settings,
      now: T0,
    });
    expect(profileSchema.safeParse(profile).success).toBe(true);
    // Everything the listing holds is there, so the allow-list below is tested against a full profile.
    expect(Object.keys(profile ?? {}).sort()).toEqual(
      [
        "address",
        "attributes",
        "categories",
        "cuisines",
        "currencies",
        "description",
        "geo",
        "hours",
        "languages",
        "name",
        "payments",
        "place_category",
        "price_band",
        "reservations",
        "sources",
        "url",
      ].sort(),
    );
    const outside = [...new Set(paths(profile))].filter((p) => !ALLOWED.has(p));
    expect(outside).toEqual([]);
    const known = new Set(ATTRIBUTES_VOCABULARY.keys.map((k) => k.key));
    for (const k of Object.keys(profile?.attributes ?? {})) expect(known.has(k), k).toBe(true);
    for (const f of Object.keys(profile?.sources ?? {})) expect(Object.hasOwn(profile ?? {}, f), f).toBe(true);
    expect(profile?.sources).toMatchObject({
      hours: { via: "website", url: "https://tasca.example/sobre" },
      cuisines: { via: "website" },
      description: { via: "business" },
    });
    const text = JSON.stringify(profile);
    for (const word of PRIVATE) expect(text, word).not.toContain(word);
    expect(text).not.toContain("contact_email");
  });
});
