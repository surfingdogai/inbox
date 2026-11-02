import { describe, expect, it } from "vitest";
import {
  AGE_KINDS,
  AGE_KINDS_OFF,
  ageFor,
  ageKindIsOff,
  ageKindOf,
  ageLabel,
  CARRIERS,
  CATALOGUE_PAGE_MAX,
  CATALOGUE_PAGE_SIZE,
  CATALOGUE_SIGNATURE_TYP,
  CATALOGUE_URL_PATTERN,
  CATALOGUE_V2_PROBLEMS,
  type CatalogueListedItemV2,
  canonicalJson,
  catalogueHeldSchema,
  catalogueIdsParam,
  catalogueItemHash,
  catalogueItemsV2Schema,
  catalogueItemV1Of,
  cataloguePageV2Schema,
  cataloguePoliciesSchema,
  catalogueSignatureSchema,
  catalogueVersionsOf,
  catalogueVersionToRead,
  JSON_SCHEMAS,
  jsonSchemaOf,
  manifestSchema,
  OPTION_KEYS,
  optionKeyOf,
  type PricePoint,
  pingCatalogueAnswerSchema,
  postcodeMatches,
  postcodeOf,
  quoteShipping,
  readCatalogueGroups,
  readCatalogueItemV2,
  readCataloguePolicies,
  sha256Text,
  trackingUrl,
  unitPriceOf,
  wasPriceOf,
} from "../src/index";
import checks from "../vectors/catalogue-checks.json";
import options from "../vectors/catalogue-options.json";
import policies from "../vectors/catalogue-policies.json";
import prices from "../vectors/catalogue-prices.json";
import signature from "../vectors/catalogue-signature.json";
import v1 from "../vectors/catalogue-v1.json";

/**
 * Catalogue version 2 (protocol §4.18, as amended) against its vectors, which the network's Go is held
 * to as well; written by an implementation of their own (scripts/gen-catalogue-vectors.py). Node and
 * workerd.
 */

// biome-ignore lint/suspicious/noExplicitAny: the vectors are JSON, read as they are.
type Json = any;

const policiesOf = (doc: unknown) => {
  const r = readCataloguePolicies(doc);
  if (!r) throw new Error("the vectors' policies document does not read");
  return r;
};

describe("vectors/catalogue-signature.json: canonical JSON and the hash", () => {
  for (const c of signature.canonical as Json[]) {
    it(`canonical: ${c.name}`, async () => {
      // A value given as text is parsed first: numbers are judged by their value, never their digits.
      expect(canonicalJson("text" in c ? JSON.parse(c.text) : c.value)).toBe(c.canonical);
      expect(await sha256Text(c.canonical)).toBe(c.sha256);
    });
  }
  for (const c of signature.hashes as Json[]) {
    it(`hash: ${c.name}`, async () => {
      expect(await catalogueItemHash("text" in c ? JSON.parse(c.text) : c.item)).toBe(c.hash);
    });
  }

  it("refuses what is not JSON a catalogue may carry", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: "\uD83C" })).toThrow();
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}');
  });
});

/* --- Catalogue-Signature ------------------------------------------------------------------------- */

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const ED25519 = { name: "Ed25519" } as const;
const { kty, crv, x } = signature.key.public_jwk;
const publicKey = () => crypto.subtle.importKey("jwk", { kty, crv, x }, ED25519, false, ["verify"]);
const privateKey = () =>
  crypto.subtle.importKey("jwk", { ...signature.key.private_jwk, key_ops: ["sign"] }, ED25519, false, ["sign"]);

async function sign(signingInput: string): Promise<string> {
  return `${signingInput}.${b64u(new Uint8Array(await crypto.subtle.sign(ED25519, await privateKey(), enc.encode(signingInput))))}`;
}

/**
 * A reader's check, in its order: the JWS, then iss (the member's registered domain), url (byte for
 * byte) and body_sha256; then, for a page and the policies document, the signed as_of and rev against the
 * body's own. "ok", or the code.
 */
async function checkSignature(c: {
  kind: "page" | "items" | "policies";
  jws: string;
  domain: string;
  url: string;
  body: string;
}): Promise<string> {
  const [h, p, s] = c.jws.split(".") as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(unb64u(h)));
  if (header.alg !== "EdDSA") return "bad_alg";
  if (header.typ !== CATALOGUE_SIGNATURE_TYP) return "bad_typ";
  if (header.kid !== signature.key.kid) return "unknown_key";
  if (!(await crypto.subtle.verify(ED25519, await publicKey(), unb64u(s), enc.encode(`${h}.${p}`))))
    return "bad_signature";
  const payload = catalogueSignatureSchema.parse(JSON.parse(new TextDecoder().decode(unb64u(p))));
  if (payload.iss !== c.domain) return "iss_mismatch";
  if (payload.url !== c.url) return "url_mismatch";
  if (payload.body_sha256 !== (await sha256Text(c.body))) return "body_mismatch";
  if (c.kind !== "items") {
    const body = JSON.parse(c.body);
    if (payload.as_of !== body.as_of) return "as_of_mismatch";
    if (payload.rev !== (c.kind === "page" ? body.catalogue.rev : body.rev)) return "rev_mismatch";
  }
  return "ok";
}

describe("vectors/catalogue-signature.json: Catalogue-Signature", () => {
  it("RFC 8037 A.4 first: this Ed25519 is everyone's", async () => {
    const [h, p] = signature.rfc8037.jws.split(".") as [string, string];
    expect(new TextDecoder().decode(unb64u(h))).toBe(signature.rfc8037.header_json);
    expect(new TextDecoder().decode(unb64u(p))).toBe(signature.rfc8037.payload);
    expect(await sign(`${h}.${p}`)).toBe(signature.rfc8037.jws);
  });

  for (const c of signature.signatures as Json[]) {
    it(`signs ${c.name} byte for byte, and it verifies`, async () => {
      expect(JSON.stringify(c.header)).toBe(c.header_json);
      expect(JSON.stringify(c.payload)).toBe(c.payload_json);
      expect(await sha256Text(c.body)).toBe(c.body_sha256);
      expect(c.payload.body_sha256).toBe(c.body_sha256);
      const input = `${b64u(enc.encode(c.header_json))}.${b64u(enc.encode(c.payload_json))}`;
      expect(await sign(input)).toBe(c.jws);
      expect(await checkSignature(c)).toBe("ok");
      // iss, and a page's or document's domain, are the member's registered domain, never the feed's host.
      expect(c.payload.iss).toBe(c.domain);
      if (c.kind !== "items") expect(JSON.parse(c.body).domain).toBe(c.domain);
      if (c.ids) expect(new URL(c.url).search).toBe(`?version=2&ids=${catalogueIdsParam(c.ids)}`);
    });
  }

  it("each signed body is the message its schema describes", () => {
    const [page, items, docs, api] = signature.signatures as Json[];
    expect(cataloguePageV2Schema.safeParse(JSON.parse(page.body)).success).toBe(true);
    expect(catalogueItemsV2Schema.safeParse(JSON.parse(items.body)).success).toBe(true);
    expect(cataloguePoliciesSchema.safeParse(JSON.parse(docs.body)).success).toBe(true);
    expect(cataloguePageV2Schema.safeParse(JSON.parse(api.body)).success).toBe(true);
    expect(JSON.parse(page.body).catalogue.policies_rev).toBe(JSON.parse(docs.body).rev);
    expect(new URL(api.url).hostname).not.toBe(api.domain);
  });

  it("ids percent-encoded but for RFC 3986's unreserved characters, upper-case hex, joined by a comma", () => {
    expect(catalogueIdsParam(["gid://shop/ProductVariant/4471", "O'NEILL-6", "A!(B)*", "a-b._~"])).toBe(
      "gid%3A%2F%2Fshop%2FProductVariant%2F4471,O%27NEILL-6,A%21%28B%29%2A,a-b._~",
    );
    // WHATWG URL parsing leaves an id written this way as it is, so a producer that signs the
    // request target as received signs the reader's bytes.
    const asked = `https://inbox.loja.example/v1/catalogue/items?version=2&ids=${catalogueIdsParam(["O'NEILL-6"])}`;
    expect(new URL(asked).href).toBe(asked);
  });

  for (const c of signature.refused as Json[]) {
    it(`refuses ${c.name}: ${c.code}`, async () => {
      expect(await checkSignature(c)).toBe(c.code);
    });
  }
});

/* --- one item ------------------------------------------------------------------------------------ */

function expected(c: Json): Json {
  return c.expect.state === "listed"
    ? { state: "listed", item: c.expect.item ?? c.item, dropped: c.expect.dropped }
    : c.expect;
}

describe("vectors/catalogue-checks.json", () => {
  const withPolicies = policiesOf(checks.policies);
  for (const c of checks.cases as Json[]) {
    it(c.name, () => {
      expect(
        readCatalogueItemV2(c.item, {
          as_of: checks.as_of,
          policies: c.with_policies ? withPolicies : null,
          site: c.site,
        }),
      ).toEqual(expected(c));
    });
  }

  it("names only codes CATALOGUE_V2_PROBLEMS defines, each with its effect, in its order", () => {
    const order = Object.keys(CATALOGUE_V2_PROBLEMS);
    const was = (prices.was_price as Json[]).flatMap((c) => (c.expect.shown ? [] : [c.expect.why]));
    for (const code of was)
      expect(CATALOGUE_V2_PROBLEMS[code as keyof typeof CATALOGUE_V2_PROBLEMS].effect).toBe("drop");
    for (const c of [...(checks.cases as Json[]), ...(prices.models as Json[])]) {
      const problems: string[] = c.expect.problems ?? [];
      const dropped: string[] = c.expect.dropped ?? [];
      for (const code of [...problems, ...dropped]) expect(CATALOGUE_V2_PROBLEMS, code).toHaveProperty(code);
      for (const code of problems)
        expect(CATALOGUE_V2_PROBLEMS[code as keyof typeof CATALOGUE_V2_PROBLEMS].effect).toBe("hold");
      for (const code of dropped)
        expect(CATALOGUE_V2_PROBLEMS[code as keyof typeof CATALOGUE_V2_PROBLEMS].effect).toBe("drop");
      for (const list of [problems, dropped])
        expect(list, c.name).toEqual([...list].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  });

  it("every listed item's hash is its own", async () => {
    for (const c of checks.cases as Json[]) {
      if (c.item?.state !== "listed" || typeof c.item.hash !== "string") continue;
      expect(await catalogueItemHash(c.item), c.name).toBe(c.item.hash);
    }
  });
});

describe("vectors/catalogue-prices.json", () => {
  for (const c of prices.models as Json[]) {
    it(`price model: ${c.name}`, () => {
      expect(readCatalogueItemV2(c.item, { as_of: prices.as_of })).toEqual(expected(c));
    });
  }
  for (const c of prices.unit_price as Json[]) {
    it(`unit price: ${c.name}`, () => {
      expect(unitPriceOf(c.price, c.unit_price)).toEqual(c.expect);
    });
  }
  for (const c of prices.was_price as Json[]) {
    it(`was price: ${c.name}`, () => {
      expect(wasPriceOf({ list_price: c.list_price, history: c.history as PricePoint[] })).toEqual(c.expect);
    });
  }
});

/* --- groups -------------------------------------------------------------------------------------- */

function repeat(template: Json, count: number): Json[] {
  return Array.from({ length: count }, (_, i) => {
    const it = structuredClone(template);
    const n = String(i).padStart(3, "0");
    it.id = `${template.id}-${n}`;
    it.group.position = i + 1;
    it.options[0].value = `${template.options[0].value}${n}`;
    return it;
  });
}

describe("vectors/catalogue-options.json", () => {
  for (const c of options.cases as Json[]) {
    it(c.name, () => {
      const items: Json[] = c.items ?? repeat(c.repeat.item, c.repeat.count);
      const read = items.map((raw) => readCatalogueItemV2(raw, { as_of: "2026-11-02T10:00:00.000Z" }));
      const listed = read.flatMap((r) => (r.state === "listed" ? [r.item] : []));
      expect(listed).toHaveLength(items.length);
      expect(readCatalogueGroups(listed as CatalogueListedItemV2[])).toEqual(c.expect);
    });
  }
});

/* --- version 1 ----------------------------------------------------------------------------------- */

describe("vectors/catalogue-v1.json", () => {
  for (const c of v1.cases as Json[]) {
    it(c.name, async () => {
      expect(await catalogueItemV1Of(c.v2, { as_of: v1.as_of })).toEqual(c.v1);
    });
  }
});

/* --- policies ------------------------------------------------------------------------------------ */

/** RFC 6902 JSON Patch: add, replace and remove, which is all the vectors use. */
function patch(doc: Json, ops: Json[]): Json {
  const out = structuredClone(doc);
  for (const op of ops) {
    const path = (op.path as string)
      .split("/")
      .slice(1)
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = path.pop() as string;
    let at = out;
    for (const seg of path) at = at[Array.isArray(at) ? Number(seg) : seg];
    const key = Array.isArray(at) ? Number(last) : last;
    if (op.op === "remove") Array.isArray(at) ? at.splice(key as number, 1) : delete at[key];
    else if (op.op === "add" && Array.isArray(at)) at.splice(key as number, 0, op.value);
    else at[key] = op.value;
  }
  return out;
}

describe("vectors/catalogue-policies.json", () => {
  const docs = policies.documents as Json;
  for (const c of policies.reads as Json[]) {
    it(`reads ${c.name}`, () => {
      const r = readCataloguePolicies(patch(docs[c.doc.base], c.doc.patch));
      if (c.expect === null) return void expect(r).toBeNull();
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.problems).toEqual(c.expect.problems);
      expect(r.doc.shipping_profiles.map((p) => p.id)).toEqual(c.expect.shipping_profiles);
      expect(r.doc.return_policies.map((p) => p.id)).toEqual(c.expect.return_policies);
      expect(r.default_shipping_profile).toBe(c.expect.default_shipping_profile);
      expect(r.default_return_policy).toBe(c.expect.default_return_policy);
    });
  }
  for (const c of policies.quotes as Json[]) {
    it(`quotes ${c.name}`, () => {
      expect(quoteShipping(policiesOf(docs[c.doc]), c.input)).toEqual(c.expect);
    });
  }

  it("a carrier's own link, its template, and nothing else", () => {
    expect(trackingUrl("royal_mail", "AB123456789GB")).toBe(
      "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB",
    );
    expect(trackingUrl("evri", "H01ABC", "https://www.evri.com/track/parcel/H01ABC")).toBe(
      "https://www.evri.com/track/parcel/H01ABC",
    );
    expect(trackingUrl("evri", "H01ABC")).toBeNull();
    expect(trackingUrl("ups", "1Z999AA10123456784", "https://ups.example.com/1Z")).toBe(
      "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    );
    expect(trackingUrl("ups", "x/../y")).toBeNull();
    expect(trackingUrl("pigeon_post", "123456")).toBeNull();
    // A carrier's own number pattern, where the vocabulary knows it, is one shape for every later version.
    for (const c of CARRIERS.carriers) expect(c, c.id).toHaveProperty("number_pattern");
  });

  it("postcodes: by outward code in the United Kingdom, by their start elsewhere", () => {
    expect(postcodeOf("GB", "ph20ab")).toBe("PH2 0AB");
    expect(postcodeOf("GB", "PH20 1AA")).toBe("PH20 1AA");
    expect(postcodeOf("PT", "1100-148")).toBe("1100148");
    expect(postcodeMatches("GB", "PH2 0AB", "PH20")).toBe(false);
    expect(postcodeMatches("GB", "PH20 1AA", "PH2")).toBe(false);
    expect(postcodeMatches("GB", "PH20 1AA", "PH20")).toBe(true);
    expect(postcodeMatches("GB", "PH20 1AA", "PH")).toBe(true);
    expect(postcodeMatches("GB", "BA1 1AA", "B")).toBe(false);
    expect(postcodeMatches("GB", "B1 1AA", "B")).toBe(true);
    expect(postcodeMatches("GB", "EC1A 1BB", "EC1")).toBe(true);
    expect(postcodeMatches("GB", "SW1A 1AA", "SW1A 1")).toBe(true);
    expect(postcodeMatches("GB", "SW1A 2AA", "SW1A 1")).toBe(false);
    expect(postcodeMatches("PT", "1100148", "11")).toBe(true);
  });
});

/* --- the shape around them ----------------------------------------------------------------------- */

describe("catalogue version 2: versions, schemas and vocabularies", () => {
  const manifest = {
    spec: "surfingdog-inbox/0",
    instance: "https://agent.shop.example",
    item_types: [],
    protocols: { ucp: "https://shop.example/.well-known/ucp" },
    agent_policy: { tiers: ["anonymous"] },
    receipt_keys: { keys: [] },
    review_services: [],
    catalogue: {
      feed: "https://agent.shop.example/v1/catalogue/changes",
      items: "https://agent.shop.example/v1/catalogue/items",
      versions: [2],
      policies: "https://agent.shop.example/v1/catalogue/policies",
    },
  };

  it("a catalogue-only member: item_types [] and versions [2]", () => {
    const m = manifestSchema.parse(manifest);
    expect(m.item_types).toEqual([]);
    expect(catalogueVersionsOf(m.catalogue)).toEqual([2]);
    expect(catalogueVersionToRead(m.catalogue)).toBe(2);
    expect(catalogueVersionToRead(m.catalogue, [1])).toBeNull();
    expect(
      manifestSchema.safeParse({ ...manifest, catalogue: { ...manifest.catalogue, policies: "http://x.example/p" } })
        .success,
    ).toBe(false);
  });

  it("each version once, in zod and in the JSON Schema", () => {
    expect(
      manifestSchema.safeParse({ ...manifest, catalogue: { ...manifest.catalogue, versions: [2, 2] } }).success,
    ).toBe(false);
    const catalogue = (jsonSchemaOf("manifest") as Json).properties.catalogue.properties;
    expect(catalogue.versions.uniqueItems).toBe(true);
    for (const f of ["feed", "items", "policies"]) {
      expect(catalogue[f].format, f).toBe("uri");
      expect(new RegExp(catalogue[f].pattern, "u").test("http://agent.shop.example/v1/catalogue/changes"), f).toBe(
        false,
      );
      expect(new RegExp(catalogue[f].pattern, "u").test(manifest.catalogue.feed), f).toBe(true);
    }
  });

  it("the JSON Schemas refuse what the reader drops: an http page or picture, by the same pattern", () => {
    for (const name of ["catalogue-page-v2", "catalogue-items-v2"]) {
      const item = (jsonSchemaOf(name) as Json).properties.items.items.oneOf[0];
      for (const at of [item.properties.url.anyOf[0], item.properties.media.items.properties.url]) {
        expect(at.format, name).toBe("uri");
        expect(at.pattern, name).toBe(new RegExp(CATALOGUE_URL_PATTERN).source);
        const re = new RegExp(at.pattern, "u");
        for (const c of checks.cases as Json[]) {
          if (c.expect.dropped?.includes("url_dropped")) expect(re.test(c.item.url), c.name).toBe(false);
          if (c.expect.state === "listed" && typeof c.item.url === "string" && !c.expect.dropped.length)
            expect(re.test(c.item.url), c.name).toBe(true);
        }
      }
    }
  });

  it("the ping's held block carries a code and a version 2 id", () => {
    const held = {
      code: "age_kind_off",
      why: "Kept off the network.",
      count: 1,
      sample: [{ id: "x".repeat(256), name: "Vape" }],
    };
    expect(catalogueHeldSchema.parse(held)).toEqual(held);
    expect(
      pingCatalogueAnswerSchema.safeParse({ listed: true, offers_live: 0, held: [held], checked_at: null }).success,
    ).toBe(true);
    expect(CATALOGUE_V2_PROBLEMS).toHaveProperty(held.code);
  });

  it("no versions is version 1; both, the highest the reader reads", () => {
    const { versions: _v, policies: _p, ...old } = manifest.catalogue;
    expect(catalogueVersionsOf(old)).toEqual([1]);
    expect(catalogueVersionToRead(old)).toBe(1);
    expect(catalogueVersionToRead({ versions: [2, 1, 2] })).toBe(2);
    expect(catalogueVersionToRead({ versions: [1, 2] }, [1])).toBe(1);
    expect(catalogueVersionsOf(undefined)).toEqual([]);
  });

  it("one page size, 500, in the prose's constant and every schema", () => {
    expect(CATALOGUE_PAGE_SIZE).toBe(500);
    for (const name of ["catalogue-page", "catalogue-page-v2"]) {
      const s = jsonSchemaOf(name) as { properties: { items: { maxItems: number } } };
      expect(s.properties.items.maxItems, name).toBe(CATALOGUE_PAGE_MAX);
    }
  });

  it("has a JSON Schema for each new message, with the 256-character id", () => {
    expect(OPTION_KEYS.keys.length).toBeGreaterThan(0);
    for (const name of ["catalogue-page-v2", "catalogue-items-v2", "catalogue-policies"])
      expect(JSON_SCHEMAS[name], name).toBeDefined();
    const item = (jsonSchemaOf("catalogue-page-v2") as Json).properties.items.items.oneOf[0];
    expect(item.properties.id.pattern).toContain("{1,256}");
    for (const f of ["price_model", "price", "availability", "media", "no_gtin"]) expect(item.required, f).toContain(f);
    for (const f of [
      "group",
      "options",
      "list_price",
      "unit_price",
      "age_restricted",
      "shipping_profile",
      "return_policy",
    ])
      expect(item.required, f).not.toContain(f);
  });

  it("option keys: each once, with every spelling it is read by", () => {
    const words = OPTION_KEYS.keys.flatMap((k) => [k.key, ...k.also]);
    expect(new Set(words).size).toBe(words.length);
    expect(optionKeyOf("Colour")).toBe("color");
    expect(optionKeyOf("flavor")).toBe("flavour");
    expect(optionKeyOf("blend")).toBeNull();
    for (const k of ["color", "size", "material", "pattern", "gender", "age_group", "size_system"])
      expect(OPTION_KEYS.keys.find((o) => o.key === k)?.gmc, k).toBe(k);
  });

  it("age kinds: tobacco and nicotine, cannabis and weapons are off, and nothing else", () => {
    expect([...AGE_KINDS_OFF].sort()).toEqual(["cannabis", "tobacco_nicotine", "weapons"]);
    const words = AGE_KINDS.kinds.flatMap((k) => [k.kind, ...k.also]);
    expect(new Set(words).size).toBe(words.length);
    expect(ageKindOf("Vape")).toBe("tobacco_nicotine");
    expect(ageKindOf("firearms")).toBe("weapons");
    expect(ageKindOf("knives")).toBeNull();
    for (const w of ["tobacco", "nicotine", "vape", "e_cigarette", "thc", "gun", "party_balloons"])
      expect(ageKindIsOff(w), w).toBe(true);
    for (const w of ["alcohol", "wine", "blades"]) expect(ageKindIsOff(w), w).toBe(false);
    expect(ageLabel(18)).toBe("ID checked at handover: 18+");
    const age = { min_age: 18, kind: "alcohol", by_country: { US: 21 }, check: "id_at_handover" as const };
    expect(ageFor(age, "us")).toBe(21);
    expect(ageFor(age, "PT")).toBe(18);
    expect(ageFor(age)).toBe(18);
  });

  it("carriers: each id once, templates on their own domains", () => {
    expect(new Set(CARRIERS.carriers.map((c) => c.id)).size).toBe(CARRIERS.carriers.length);
    for (const c of CARRIERS.carriers) {
      if (!c.tracking_url_template) continue;
      const host = new URL(c.tracking_url_template.replace("{number}", "X")).hostname;
      expect(
        c.domains.some((d) => host === d || host.endsWith(`.${d}`)),
        c.id,
      ).toBe(true);
    }
  });
});
