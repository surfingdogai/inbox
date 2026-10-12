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
import { readSettings } from "../src/settings/schema";
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
