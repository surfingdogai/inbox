import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import {
  cleanDoorUrl,
  DOOR_PLATFORM_GROUPS,
  DOOR_PLATFORM_ID,
  DOOR_PLATFORMS,
  DOOR_PLATFORMS_VOCABULARY,
  doorPlace,
  doorPlatform,
  doorPlatformFit,
  doorPlatformOf,
  doorPlatformsVocabSchema,
  doorTrackingParams,
  jsonSchemaOf,
  manifestSchema,
  readDoorsElsewhere,
} from "../src/index";
import vectors from "../vectors/doors-elsewhere.json";

/**
 * vocab/door-platforms.json (0.9.0, ADR-031): the platforms a door elsewhere may name. Every platform once, in a
 * group, taking bookings or orders; hosts are registrable names; no marketplace that takes a share of each sale; and
 * the vectors read as `readDoorsElsewhere`, `doorPlatformOf`, `doorPlace`, `doorTrackingParams` and `cleanDoorUrl` say.
 */
describe("the door platforms vocabulary", () => {
  it("is what its schema says, and the spec is 0.9.0", () => {
    expect(doorPlatformsVocabSchema.parse(DOOR_PLATFORMS_VOCABULARY)).toEqual(DOOR_PLATFORMS_VOCABULARY);
    expect(DOOR_PLATFORMS_VOCABULARY.version).toBe(1);
    expect(pkg.version).toBe("0.9.0");
    const schema = jsonSchemaOf("door-platforms") as { $id: string };
    expect(schema.$id).toBe("https://surfingdog.ai/spec/schemas/door-platforms.json");
  });

  it("names each platform once, each in a group it lists, with hosts no other platform shares", () => {
    const ids = DOOR_PLATFORMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(DOOR_PLATFORM_GROUPS.map((g) => g.id));
    for (const p of DOOR_PLATFORMS) {
      expect(p.id, p.id).toMatch(DOOR_PLATFORM_ID);
      expect(groups.has(p.group), `${p.id}'s group`).toBe(true);
      // A platform with no host of its own lives on the business's own website, and says so.
      if (p.hosts.length === 0) expect(p.own_site, `${p.id} has no host`).toBe(true);
      for (const h of p.hosts) expect(h, `${p.id}: ${h}`).toBe(h.toLowerCase());
      expect(p.source, `${p.id}'s source`).toMatch(/^https:\/\//);
      expect(doorPlatform(p.id)).toBe(p);
    }
    // Square's two products share square.site and are told apart by the kind of request alone.
    const hosts = DOOR_PLATFORMS.flatMap((p) => p.hosts.map((h) => ({ h, p })));
    for (const { h, p } of hosts) {
      const others = hosts.filter((x) => x.h === h && x.p !== p).map((x) => x.p);
      for (const o of others)
        expect(
          o.item_types.some((t) => p.item_types.includes(t)),
          `${h}: ${p.id} and ${o.id}`,
        ).toBe(false);
    }
    expect(doorPlatform("nothing-of-ours")).toBeUndefined();
    expect(doorPlatform(42)).toBeUndefined();
  });

  it("lists no marketplace that takes a share of each sale", () => {
    const marketplaces = [
      "ubereats.com",
      "doordash.com",
      "deliveroo.co.uk",
      "just-eat.co.uk",
      "ifood.com.br",
      "rappi.com",
      "swiggy.com",
      "zomato.com",
      "glovoapp.com",
      "grab.com",
      "talabat.com",
      "booking.com",
      "airbnb.com",
      "expedia.com",
    ];
    const all = DOOR_PLATFORMS.flatMap((p) => p.hosts);
    for (const m of marketplaces)
      expect(
        all.some((h) => h === m || h.endsWith(`.${m}`) || m.endsWith(`.${h}`)),
        m,
      ).toBe(false);
  });

  it("covers bookings and orders the founder's list names, worldwide", () => {
    for (const id of [
      "fresha",
      "booksy",
      "planity",
      "treatwell",
      "timely",
      "phorest",
      "opentable",
      "resy",
      "sevenrooms",
      "thefork",
      "covermanager",
      "tock",
      "tradify",
      "flipdish",
      "gloriafood",
      "chownow",
      "slice",
      "toast",
      "calendly",
      "simplybook",
      "setmore",
      "acuity",
      "square-online",
      "shopify",
      "wix",
    ])
      expect(doorPlatform(id), id).toBeDefined();
    expect(DOOR_PLATFORMS.filter((p) => p.group === "stays").length).toBeGreaterThanOrEqual(4);
  });
});

describe("where a URL stands against a platform", () => {
  const fresha = doorPlatform("fresha");
  const shopify = doorPlatform("shopify");
  const simplybook = doorPlatform("simplybook");
  if (!fresha || !shopify || !simplybook) throw new Error("vocabulary");

  it("is the business's own page there only on the platform's hosts, past its own pages", () => {
    expect(doorPlatformFit("https://www.fresha.com/a/kinyozi-bora-nairobi-x9", fresha, "booking")).toBe("on_platform");
    expect(doorPlatformFit("https://fresha.com/book-now/kinyozi-bora", fresha)).toBe("on_platform");
    expect(doorPlatformFit("https://www.fresha.com/", fresha)).toBe("platform_page");
    expect(doorPlatformFit("https://www.fresha.com", fresha)).toBe("platform_page");
    expect(doorPlatformFit("https://fresha.com.evil.example/a/x", fresha)).toBe("not_on_platform");
    expect(doorPlatformFit("https://www.fresha.com/a/x", fresha, "order")).toBe("kind");
    expect(doorPlatformFit("not a url", fresha)).toBe("invalid");
    expect(doorPlatformFit("https://WWW.FRESHA.COM./a/x", fresha)).toBe("on_platform");
  });

  it("asks for a name of the business's own under a platform whose pages are one per name", () => {
    expect(doorPlatformFit("https://lotus-spa.simplybook.me/v2/", simplybook)).toBe("on_platform");
    expect(doorPlatformFit("https://www.simplybook.me/v2/", simplybook)).toBe("platform_page");
    expect(doorPlatformFit("https://simplybook.me/en/", simplybook)).toBe("platform_page");
    // SimplyBook.me also serves a booking site on the business's own name.
    expect(doorPlatformFit("https://book.lotusspa.in/v2/", simplybook)).toBe("own_site");
  });

  it("leaves a page on the business's own domain to whoever knows that domain", () => {
    expect(doorPlatformFit("https://mkate-matamu.myshopify.com/", shopify, "order")).toBe("on_platform");
    expect(doorPlatformFit("https://www.myshopify.com/", shopify, "order")).toBe("platform_page");
    expect(doorPlatformFit("https://shop.mkatematamu.co.ke/", shopify, "order")).toBe("own_site");
  });
});

describe("doors-elsewhere.json", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(readDoorsElsewhere(c.manifest)).toEqual(c.kept);
      // What a reader keeps is always a manifest's to carry as it is.
      for (const d of readDoorsElsewhere(c.manifest))
        expect(manifestSchema.shape.doors_elsewhere.parse([d])).toEqual([d]);
    });
  }
  for (const v of vectors.detect) {
    it(`finds ${v.platform ?? "no platform"} for ${v.item_type}s at ${v.url}`, () => {
      const found = doorPlatformOf(v.url, v.item_type);
      expect(found?.id ?? null).toBe(v.platform);
      expect(doorPlace({ url: v.url, platform: found?.id })).toBe(v.place);
    });
  }
  for (const v of vectors.clean) {
    it(`cleans ${v.url}`, () => {
      expect(doorTrackingParams(v.url)).toEqual(v.tracking);
      expect(cleanDoorUrl(v.url)).toBe(v.clean);
      expect(doorTrackingParams(cleanDoorUrl(v.url))).toEqual([]);
    });
  }
});

describe("the manifest's doors elsewhere", () => {
  it("carry a platform token, and only a token", () => {
    const url = "https://resy.com/cities/ny/venues/kitchen-of-nkem";
    const entry = { item_type: "booking", url, platform: "resy" };
    expect(manifestSchema.shape.doors_elsewhere.parse([entry])).toEqual([entry]);
    expect(manifestSchema.shape.doors_elsewhere.safeParse([{ ...entry, platform: "Resy" }]).success).toBe(false);
    expect(manifestSchema.shape.doors_elsewhere.safeParse([{ ...entry, platform: "x".repeat(41) }]).success).toBe(
      false,
    );
    // A 0.8 entry, with none, reads as it always did.
    expect(manifestSchema.shape.doors_elsewhere.parse([{ item_type: "booking", url }])).toEqual([
      { item_type: "booking", url },
    ]);
  });
});
