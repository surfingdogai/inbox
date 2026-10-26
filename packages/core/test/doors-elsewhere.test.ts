import { runMigrations } from "@surfingdog/platform";
import { manifestSchema, readDoorsElsewhere } from "@surfingdog/spec";
import { beforeAll, describe, expect, it } from "vitest";
import vectors from "../../spec/vectors/doors-elsewhere.json";
import { frontHome } from "../src/capabilities/front";
import { Capabilities } from "../src/capabilities/service";
import { productInput, serviceInput } from "../src/capabilities/setup-types";
import { createDb } from "../src/db";
import { buildManifest } from "../src/manifest";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { parseStoredSettings, readSettings } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { WriteError } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

/**
 * Doors elsewhere: the kinds of request a business takes somewhere else (a booking platform, its own
 * checkout), and where. What a reader keeps of them (`vectors/doors-elsewhere.json`), what the inbox
 * writes into its manifest and its own page, and who may set them. Node and workerd.
 */
const T0 = Date.parse("2026-10-06T10:00:00Z");
const BOOKING = "https://booking.example.com/ana-salon";
const CHECKOUT = "https://shop.example.com/";

const principal = (p: Partial<Principal> & Pick<Principal, "via" | "id">): Principal => ({
  name: "p",
  scopes: ["*"],
  userId: null,
  ...p,
});
const owner: Caller = {
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: principal({ via: "session", id: "sess_1", name: "owner@example.com", userId: "user_1" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** The owner's AI over OAuth, holding every settings scope. */
const claude: Caller = {
  actor: { kind: "owner_ai", id: "client_claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({
    via: "oauth",
    id: "client_claude",
    name: "Claude",
    scopes: ["inbox:read", "inbox:write", "settings:read", "settings:write", "offline_access"],
    userId: "user_1",
  }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
/** The inbox itself: what a setup plan is applied as. */
const system: Caller = {
  actor: { kind: "system", id: "setup", channel: "system" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

// A database's first migration takes seconds in workerd: done once here, before any test is timed.
beforeAll(async () => {
  await setup();
}, 60_000);

const weekly = { mon: [["09:00", "18:00"] as [string, string]], tue: [["09:00", "18:00"] as [string, string]] };

async function refusal(write: Promise<unknown>): Promise<WriteError> {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteError);
  return error as WriteError;
}

describe("doors-elsewhere.json", () => {
  for (const c of vectors.cases) {
    it(c.name, () => expect(readDoorsElsewhere(c.manifest)).toEqual(c.kept));
  }
});

describe("the manifest", () => {
  it("names each door elsewhere, leaves its kind out of item_types, and is kept whole by any reader", () => {
    const manifest = buildManifest({
      instanceUrl: "https://inbox.example.com/",
      itemTypes: ["message", "quote_request", "booking", "refund"],
      doorsElsewhere: [{ item_type: "booking", url: BOOKING }],
    });
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.item_types).toEqual(["message", "quote_request", "refund"]);
    expect(manifest.doors_elsewhere).toEqual([{ item_type: "booking", url: BOOKING }]);
    expect(readDoorsElsewhere(manifest)).toEqual(manifest.doors_elsewhere);
  });

  it("says nothing of doors elsewhere when there are none", () => {
    const manifest = buildManifest({ instanceUrl: "https://inbox.example.com", itemTypes: ["message"] });
    expect(manifest).not.toHaveProperty("doors_elsewhere");
  });
});

describe("the settings", () => {
  it("take a booking platform and an own checkout from the owner, and from the inbox itself", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "booking", url: BOOKING }] } });
    expect((await readSettings(db)).doorsElsewhere).toEqual([{ itemType: "booking", url: BOOKING }]);
    await caps.updateSettings(system, {
      doc: {
        doorsElsewhere: [
          { itemType: "booking", url: BOOKING },
          { itemType: "order", url: CHECKOUT },
        ],
      },
    });
    expect((await readSettings(db)).doorsElsewhere).toHaveLength(2);
    // A write is a change, never a reset: the list goes with null.
    await caps.updateSettings(owner, { doc: { doorsElsewhere: null } });
    expect((await readSettings(db)).doorsElsewhere).toEqual([]);
  });

  it("refuse a place that is not an https address on a public host, and two places for one kind", async () => {
    const { caps } = await setup();
    for (const url of [
      "http://booking.example.com/ana",
      "https://ana:secret@booking.example.com/",
      "https://203.0.114.7/book",
      "https://[2001:db8::1]/book",
      "https://localhost/book",
      "https://salon.internal/book",
      "javascript:alert(1)",
    ]) {
      const error = await refusal(
        caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "booking", url }] } }),
      );
      expect(error.code, url).toBe("invalid_input");
    }
    const twice = await refusal(
      caps.updateSettings(owner, {
        doc: {
          doorsElsewhere: [
            { itemType: "booking", url: BOOKING },
            { itemType: "booking", url: "https://other.example.com/" },
          ],
        },
      }),
    );
    expect(twice.code).toBe("invalid_input");
    const kind = await refusal(
      caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "message", url: BOOKING }] } }),
    );
    expect(kind.code).toBe("invalid_input");
  });

  it("are never the owner's AI's to change: a customer's message could ask it to send people elsewhere", async () => {
    const { db, caps } = await setup();
    const error = await refusal(
      caps.updateSettings(claude, {
        doc: { doorsElsewhere: [{ itemType: "booking", url: "https://evil.example.com/" }] },
      }),
    );
    expect(error.code).toBe("not_allowed");
    expect(error.details).toMatchObject({ reason: "owner_in_person", ask_owner: true });
    expect((await readSettings(db)).doorsElsewhere).toEqual([]);
  });
});

describe("what the inbox says it takes", () => {
  it("leaves out bookings, and their refunds, when bookings are taken at a platform; quotes stay", async () => {
    const { caps } = await setup();
    await caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Haircut", price: { model: "fixed", value: 2500, currency: "EUR" } }),
    );
    await caps.setup.setWeekly(owner, { weekly });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request", "booking", "refund"]);
    await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "booking", url: BOOKING }] } });
    const profile = await caps.getBusinessProfile();
    expect(profile.item_types).toEqual(["message", "quote_request"]);
    expect(profile.doors_elsewhere).toEqual([{ item_type: "booking", url: BOOKING }]);
  });

  it("leaves out orders when they stay in the shop's own checkout; quotes stay", async () => {
    const { caps } = await setup();
    await caps.setup.createProduct(owner, productInput.parse({ name: "Wax", price: { value: 500, currency: "EUR" } }));
    await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "order", url: CHECKOUT }] } });
    expect((await caps.getBusinessProfile()).item_types).toEqual(["message", "quote_request"]);
  });
});

describe("the business's own page", () => {
  it("links to the booking platform instead of listing times, and keeps quotes and messages", async () => {
    const { caps } = await setup();
    await caps.setup.createService(owner, serviceInput.parse({ name: "Haircut" }));
    await caps.setup.setWeekly(owner, { weekly });
    await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "booking", url: BOOKING }] } });
    const page = await frontHome(caps, "en");
    expect(page.sections).toEqual([
      { heading: "Book a time", paragraphs: [], links: [{ label: "Book at booking.example.com", href: BOOKING }] },
    ]);
    expect(page.links?.items.map((l) => l.href)).toEqual(["/p/quote", "/p/message"]);
    expect((await frontHome(caps, "pt")).sections?.[0]?.links?.[0]?.label).toBe("Marcar em booking.example.com");
  });

  it("links to the shop's own checkout for orders", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "order", url: CHECKOUT }] } });
    const page = await frontHome(caps, "en");
    expect(page.sections).toEqual([
      { heading: "Order", paragraphs: [], links: [{ label: "Order at shop.example.com", href: CHECKOUT }] },
    ]);
    expect(page.links?.lead).toBe("Or:");
  });
});

/**
 * 0.9.0 (ADR-031): a door elsewhere names its platform, from `vocab/door-platforms.json`. A salon in Toronto books at
 * Fresha, a restaurant in Osaka at TableCheck, a bakery in Nairobi sells in its own Shopify checkout. Fixtures are
 * hand-written in each platform's public page format; nothing is fetched.
 */
const FRESHA = "https://www.fresha.com/a/studio-lumiere-toronto-queen-street-west-k3f8q2";
const TABLECHECK = "https://www.tablecheck.com/en/shops/kushikatsu-daruma-namba/reserve";

describe("doors elsewhere on a platform", () => {
  it("keep the platform the owner picks, publish it, and name it on the business's own page", async () => {
    const { db, caps } = await setup();
    await caps.updateSettings(owner, {
      doc: { doorsElsewhere: [{ itemType: "booking", url: FRESHA, platform: "fresha" }] },
    });
    expect((await readSettings(db)).doorsElsewhere).toEqual([{ itemType: "booking", url: FRESHA, platform: "fresha" }]);
    const profile = await caps.getBusinessProfile();
    expect(profile.doors_elsewhere).toEqual([{ item_type: "booking", url: FRESHA, platform: "fresha" }]);
    const manifest = buildManifest({
      instanceUrl: "https://inbox.studiolumiere.ca",
      itemTypes: profile.item_types,
      doorsElsewhere: profile.doors_elsewhere,
    });
    expect(manifest.doors_elsewhere).toEqual([{ item_type: "booking", url: FRESHA, platform: "fresha" }]);
    // Any reader keeps it whole, platform and all.
    expect(readDoorsElsewhere(manifest)).toEqual(manifest.doors_elsewhere);
    const page = await frontHome(caps, "en");
    expect(page.sections?.[0]?.links).toEqual([{ label: "Book at Fresha", href: FRESHA }]);
  });

  it("name the platform a page is plainly on, picked or not, and never one for the business's own website", async () => {
    const { caps } = await setup();
    await caps.updateSettings(owner, {
      doc: {
        doorsElsewhere: [
          { itemType: "booking", url: TABLECHECK },
          { itemType: "order", url: "https://shop.kushikatsu-daruma.jp/" },
        ],
      },
    });
    expect((await caps.getBusinessProfile()).doors_elsewhere).toEqual([
      { item_type: "booking", url: TABLECHECK, platform: "tablecheck" },
      { item_type: "order", url: "https://shop.kushikatsu-daruma.jp/" },
    ]);
    const page = await frontHome(caps, "en");
    expect(page.sections?.map((s) => s.links?.[0]?.label)).toEqual([
      "Book at TableCheck",
      "Order at shop.kushikatsu-daruma.jp",
    ]);
  });

  it("refuse a page not on the platform picked, the platform's own page, a kind it does not take, an unknown platform, and tracking", async () => {
    const { db, caps } = await setup();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ itemType: "booking", url: "https://studiolumiere.ca/book", platform: "fresha" }, "url", "not on Fresha"],
      [{ itemType: "booking", url: "https://www.fresha.com/", platform: "fresha" }, "url", "Fresha's own page"],
      [{ itemType: "order", url: FRESHA, platform: "fresha" }, "platform", "Fresha takes bookings only"],
      [{ itemType: "booking", url: FRESHA, platform: "bookingtool" }, "platform", "vocab/door-platforms.json"],
      [{ itemType: "booking", url: FRESHA, platform: "Fresha" }, "platform", ""],
      [{ itemType: "booking", url: `${FRESHA}?utm_source=instagram`, platform: "fresha" }, "url", "tracking"],
      [{ itemType: "order", url: "https://order.toasttab.com/online/casa-di-nonna?gclid=Cj0KCQ" }, "url", "tracking"],
      [
        { itemType: "booking", url: "https://www.fresha.com/for-business", platform: "fresha" },
        "url",
        "Fresha's own page",
      ],
    ];
    for (const [entry, field, words] of cases) {
      const error = await refusal(caps.updateSettings(owner, { doc: { doorsElsewhere: [entry] } }));
      expect(error.code, JSON.stringify(entry)).toBe("invalid_input");
      const problem = error.fields?.find((f) => f.path === `doc.doorsElsewhere.0.${field}`);
      expect(problem, JSON.stringify(error.fields)).toBeDefined();
      expect(problem?.message).toContain(words);
    }
    expect((await readSettings(db)).doorsElsewhere).toEqual([]);
  });

  it("take a shop's own checkout, on a platform that serves the business's own domain, only on that domain", async () => {
    const { db, caps } = await setup();
    // No domain yet: a page off Shopify's own hosts can't be told from a stranger's shop, so it waits for one.
    const early = await refusal(
      caps.updateSettings(owner, {
        doc: { doorsElsewhere: [{ itemType: "order", url: "https://shop.mkatematamu.co.ke/", platform: "shopify" }] },
      }),
    );
    expect(early.fields).toEqual([
      {
        path: "doc.doorsElsewhere.0.url",
        problem: "invalid",
        message: "add your website in General first, so agents know this shop is yours",
      },
    ]);
    // Its own name on Shopify needs no website to check against.
    await caps.updateSettings(owner, {
      doc: { doorsElsewhere: [{ itemType: "order", url: "https://mkate-matamu.myshopify.com/", platform: "shopify" }] },
    });
    await caps.setup.updateProfile(owner, { domain: "Mkatematamu.co.ke." });
    for (const url of [
      "https://shop.mkatematamu.co.ke/",
      "https://mkatematamu.co.ke/",
      "https://mkate-matamu.myshopify.com/",
    ]) {
      await caps.updateSettings(owner, { doc: { doorsElsewhere: [{ itemType: "order", url, platform: "shopify" }] } });
      expect((await readSettings(db)).doorsElsewhere[0]?.url).toBe(url);
    }
    const stranger = await refusal(
      caps.updateSettings(owner, {
        doc: {
          doorsElsewhere: [{ itemType: "order", url: "https://another-bakery.example.com/", platform: "shopify" }],
        },
      }),
    );
    expect(stranger.code).toBe("invalid_input");
    expect(stranger.fields).toEqual([
      {
        path: "doc.doorsElsewhere.0.url",
        problem: "invalid",
        message: "that link is not on your website (mkatematamu.co.ke) or on Shopify: paste your own page's link",
      },
    ]);
    // A platform with no host of its own lives on the business's website alone.
    const tradify = await refusal(
      caps.updateSettings(owner, {
        doc: {
          doorsElsewhere: [{ itemType: "booking", url: "https://forms.example.org/plumber", platform: "tradify" }],
        },
      }),
    );
    expect(tradify.fields?.[0]?.message).toBe(
      "that link is not on your website (mkatematamu.co.ke): paste your own page's link",
    );
    // Any other page, with no platform, is the owner's to choose.
    await caps.updateSettings(owner, {
      doc: { doorsElsewhere: [{ itemType: "order", url: "https://another-bakery.example.com/" }] },
    });
  });

  it("name a shop on the business's own website only while the website is the business's", async () => {
    const { caps } = await setup();
    await caps.setup.updateProfile(owner, { domain: "mkatematamu.co.ke" });
    const shop = "https://shop.mkatematamu.co.ke/";
    await caps.updateSettings(owner, {
      doc: { doorsElsewhere: [{ itemType: "order", url: shop, platform: "shopify" }] },
    });
    expect((await caps.getBusinessProfile()).doors_elsewhere).toEqual([
      { item_type: "order", url: shop, platform: "shopify" },
    ]);
    // The business moves its website: the door keeps its link, and loses a name nobody can check any more.
    await caps.setup.updateProfile(owner, { domain: "mkate-matamu.africa" });
    expect((await caps.getBusinessProfile()).doors_elsewhere).toEqual([{ item_type: "order", url: shop }]);
    // The manifest names it only beside the website its profile names, as every reader checks it.
    const door = { item_type: "order" as const, url: shop, platform: "shopify" };
    const bare = buildManifest({ instanceUrl: "https://inbox.mkatematamu.co.ke", doorsElsewhere: [door] });
    expect(bare.doors_elsewhere).toEqual([{ item_type: "order", url: shop }]);
    const named = buildManifest({
      instanceUrl: "https://inbox.mkatematamu.co.ke",
      profile: { name: "Mkate Matamu", url: "https://mkatematamu.co.ke/", categories: [], languages: [] },
      doorsElsewhere: [door],
    });
    expect(named.doors_elsewhere).toEqual([door]);
    expect(readDoorsElsewhere(named)).toEqual([door]);
  });

  it("send a customer's agent to the platform by name, with nothing written", async () => {
    const { caps } = await setup();
    const service = await caps.setup.createService(owner, serviceInput.parse({ name: "Silk press" }));
    await caps.setup.setWeekly(owner, { weekly });
    await caps.updateSettings(owner, {
      doc: { doorsElsewhere: [{ itemType: "booking", url: FRESHA, platform: "fresha" }] },
    });
    const error = await refusal(
      caps.checkAvailability({ service_id: service.id, from: "2026-10-13T09:00:00Z", to: "2026-10-14T09:00:00Z" }),
    );
    expect(error.code).toBe("not_allowed");
    expect(error.message).toContain(`This business takes bookings at Fresha (${FRESHA}), not here`);
    // What still comes here is said only while it does: never a door that would refuse the agent too.
    expect(error.message).toMatch(/Nothing was written\. Messages and quote requests still come here\.$/);
    const ask = () =>
      refusal(
        caps.checkAvailability({ service_id: service.id, from: "2026-10-13T09:00:00Z", to: "2026-10-14T09:00:00Z" }),
      );
    await caps.updateSettings(owner, { doc: { doors: { quoteRequest: false } } });
    expect((await ask()).message).toMatch(/Nothing was written\. Messages still come here\.$/);
    await caps.updateSettings(owner, { doc: { doors: { message: false } } });
    expect((await ask()).message).toMatch(/Nothing was written\.$/);
    expect(error.details).toEqual({
      reason: "taken_elsewhere",
      item_type: "booking",
      url: FRESHA,
      platform: "fresha",
      place: "Fresha",
    });
  });

  it("take a setup plan's door without its tracking, and its platform only where the page is on it", async () => {
    const { db, caps } = await setup();
    const applied = await caps.applySetupPlan(system, {
      doors_elsewhere: [
        { door: "booking", url: `${FRESHA}?utm_source=website&pId=88213`, platform: "booksy" },
        { door: "order", url: "https://order.toasttab.com/online/casa-di-nonna-sp", platform: "toast" },
      ],
    });
    expect(applied.changed).toBe(true);
    expect(applied.sentences.join(" ")).toContain("Bookings stay at Fresha.");
    expect((await readSettings(db)).doorsElsewhere).toEqual([
      { itemType: "booking", url: `${FRESHA}?pId=88213`, platform: "fresha" },
      { itemType: "order", url: "https://order.toasttab.com/online/casa-di-nonna-sp", platform: "toast" },
    ]);
  });
});

describe("doors elsewhere stored before this version", () => {
  it("are read, never dropped: tracking taken off, a platform that no longer fits left out, the list whole", () => {
    const stored = {
      doorsElsewhere: [
        { itemType: "booking", url: "https://www.fresha.com/a/kinyozi-bora-nairobi-x9?utm_source=instagram&pId=4" },
        { itemType: "order", url: "https://order.toasttab.com/online/maple-and-rye", platform: "toast" },
      ],
    };
    const read = parseStoredSettings(stored);
    expect(read.ignored).toEqual([]);
    expect(read.settings.doorsElsewhere).toEqual([
      { itemType: "booking", url: "https://www.fresha.com/a/kinyozi-bora-nairobi-x9?pId=4" },
      { itemType: "order", url: "https://order.toasttab.com/online/maple-and-rye", platform: "toast" },
    ]);
    // A platform whose hosts no longer take the page, or one this version does not know: the door stays.
    const narrowed = parseStoredSettings({
      doorsElsewhere: [
        { itemType: "booking", url: "https://www.treatwell.co.za/place/x/", platform: "treatwell" },
        { itemType: "order", url: "https://shop.example.com/", platform: "a-platform-from-later" },
      ],
    });
    expect(narrowed.ignored).toEqual([]);
    expect(narrowed.settings.doorsElsewhere).toEqual([
      { itemType: "booking", url: "https://www.treatwell.co.za/place/x/" },
      { itemType: "order", url: "https://shop.example.com/" },
    ]);
  });

  it("keep publishing every door after an upgrade, and the kinds stay out of what the inbox takes", async () => {
    const { db, caps } = await setup();
    await db.client.query({
      sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 1, 0)",
      params: [
        JSON.stringify({
          doorsElsewhere: [
            { itemType: "booking", url: "https://www.tablecheck.com/ja/shops/kissa-hoshi-osaka/reserve?utm_source=x" },
            { itemType: "order", url: "https://shop.kissahoshi.jp/?ref=ig" },
          ],
        }),
      ],
      method: "run",
    });
    const profile = await caps.getBusinessProfile();
    expect(profile.doors_elsewhere).toEqual([
      {
        item_type: "booking",
        url: "https://www.tablecheck.com/ja/shops/kissa-hoshi-osaka/reserve",
        platform: "tablecheck",
      },
      { item_type: "order", url: "https://shop.kissahoshi.jp/?ref=ig" },
    ]);
    expect(profile.item_types).not.toContain("booking");
    expect(profile.item_types).not.toContain("order");
    // A write that leaves them alone is not refused for what an older version let in.
    await caps.updateSettings(owner, { doc: { doors: { message: true } } });
    expect((await readSettings(db)).doorsElsewhere).toHaveLength(2);
  });
});
