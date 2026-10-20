import { describe, expect, it } from "vitest";
import {
  type ConformanceReport,
  checkAcknowledgement,
  checkDocument,
  checkManifest,
  checkReceipt,
  ed25519Thumbprint,
  readDoorsElsewhere,
} from "../src/index";
import doorsElsewhere from "../vectors/doors-elsewhere.json";
import v1 from "../vectors/receipts.json";
import v2 from "../vectors/receipts-v2.json";
import v6 from "../vectors/receipts-v6.json";
import manifest from "./fixtures/manifest.json";

/**
 * The conformance check (https://surfingdog.ai/spec/check/) against the published vectors: every receipt and
 * acknowledgement they hold as valid passes, and every one they refuse fails with the code they give, the code a
 * network answers. Then the manifest: a live one passes, and each way to get it wrong fails with its reason.
 * Node and workerd.
 */

const codes = (r: ConformanceReport) => r.errors.map((e) => e.code);
const issuerKeys = { keys: [v1.issuer.public_jwk] };
const at = (seconds: number) => seconds * 1000;

describe("receipts, as the vectors decide them", () => {
  it("passes every receipt of claims v1, v2 and rules version 6, signature included", async () => {
    for (const r of v1.receipts) {
      const report = await checkReceipt(r.jws, { keys: issuerKeys, now: at(r.payload.iat) });
      expect(report.errors, r.name).toEqual([]);
      expect(report.version).toBe("claims v1");
    }
    for (const r of [...v2.receipts, ...v6.receipts]) {
      const report = await checkReceipt(r.jws, { keys: { keys: [v2.issuer.public_jwk] }, now: at(v6.now) });
      expect(report.errors, r.name).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.version).toBe("claims v2");
      expect(report.passed.at(-1)).toBe(`Its hash, which an acknowledgement names, is ${r.sha}.`);
    }
  });

  it("refuses every refused receipt with the vectors' code", async () => {
    for (const r of v1.refused_receipts) {
      const report = await checkReceipt(r.jws, { keys: issuerKeys, now: at(1790000461) });
      expect(codes(report)[0], r.name).toBe(r.error);
      expect(report.ok).toBe(false);
    }
    for (const [vectors, refused] of [
      [v2, v2.refused_receipts],
      [v6, v6.refused_receipts],
    ] as const) {
      for (const r of refused) {
        const report = await checkReceipt(r.jws, { keys: { keys: [vectors.issuer.public_jwk] }, now: at(vectors.now) });
        expect(codes(report)[0], r.name).toBe(r.code);
      }
    }
  });

  it("names the claim that is wrong, by its path", async () => {
    const r = v6.refused_receipts.find((x) => x.name === "an amendment without trm");
    const report = await checkReceipt(r?.jws ?? "", { keys: { keys: [v6.issuer.public_jwk] }, now: at(v6.now) });
    expect(report.errors).toContainEqual(expect.objectContaining({ path: "$.payload.trm", code: "bad_payload" }));
  });

  it("reads claims as an older network does when told to: rules 5 refuses what version 6 added", async () => {
    for (const r of v6.receipts) {
      const report = await checkReceipt(r.jws, { keys: { keys: [v6.issuer.public_jwk] }, now: at(v6.now), rules: 5 });
      expect(report.ok, r.name).toBe(r.rules_5 !== null);
      // Said by date, never by the network's internal rule numbers.
      const said = [...report.passed, ...report.errors.map((e) => e.message)].join(" ");
      expect(said, r.name).not.toMatch(/rules \d/);
      if (!report.ok) expect(said, r.name).toContain("A reader from before 27 September 2026 refuses these claims.");
    }
    const latest = await checkReceipt(v6.receipts[0]?.jws ?? "", {
      keys: { keys: [v6.issuer.public_jwk] },
      now: at(v6.now),
    });
    expect(latest.passed).toContain("The claims are well formed (claims v2, as read since 27 September 2026).");
  });

  it("checks the claims alone when no key is given, and says the signature was not checked", async () => {
    const r = v1.receipts[0];
    const report = await checkReceipt(r?.jws ?? "", { now: at(1790000461) });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(["signature_not_checked"]);
    const tampered = v1.refused_receipts.find((x) => x.error === "bad_signature");
    expect((await checkReceipt(tampered?.jws ?? "")).ok).toBe(true);
  });

  it("finds the key by its thumbprint when the published key has no kid, and refuses a wrong issuer", async () => {
    const { kid: _kid, ...bare } = v1.issuer.public_jwk;
    expect(await ed25519Thumbprint(bare.x)).toBe(v1.issuer.kid);
    const r = v1.receipts[0];
    expect((await checkReceipt(r?.jws ?? "", { keys: [bare], now: at(1790000461) })).ok).toBe(true);
    const wrong = await checkReceipt(r?.jws ?? "", {
      keys: [bare],
      issuer: "https://other.example",
      now: at(1790000461),
    });
    expect(codes(wrong)).toEqual(["wrong_issuer"]);
  });
});

describe("acknowledgements, as the vectors decide them", () => {
  it("passes every valid acknowledgement, bound to its receipt", async () => {
    for (const a of [...v1.acknowledgements, ...v2.acknowledgements, ...v6.acknowledgements]) {
      const report = await checkAcknowledgement(a.jws, {
        receipt: a.receipt_jws,
        receiptId: a.payload.rcp,
        now: at(a.verify_at),
      });
      expect(report.errors, a.name).toEqual([]);
    }
  });

  it("refuses every refused acknowledgement with the vectors' code", async () => {
    for (const a of v1.refused_acknowledgements) {
      const report = await checkAcknowledgement(a.jws, {
        receipt: a.receipt_jws,
        receiptId: a.receipt_id,
        now: at(a.verify_at),
      });
      expect(codes(report)[0], a.name).toBe(a.error);
    }
  });
});

describe("the manifest", () => {
  it("passes a live inbox's manifest", async () => {
    const report = await checkManifest(manifest);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.version).toBe("surfingdog-inbox/0");
  });

  const broken = async (change: (m: Record<string, unknown>) => void) => {
    const m = structuredClone(manifest) as Record<string, unknown>;
    change(m);
    return checkManifest(m);
  };
  const keys = (m: Record<string, unknown>) => (m.receipt_keys as { keys: Record<string, unknown>[] }).keys;

  it("fails each way of getting it wrong, with its reason", async () => {
    expect(codes(await broken((m) => delete m.spec))).toEqual(["schema"]);
    expect(codes(await broken((m) => (m.instance = "https://inbox.example.com/")))).toEqual(["not_origin"]);
    expect(codes(await broken((m) => (m.instance = "http://inbox.example.com")))).toEqual(["not_origin"]);
    expect(codes(await broken((m) => (m.item_types = ["message", "booking", "message"])))).toEqual(["duplicate"]);
    expect(codes(await broken((m) => (m.review_services = ["https://network.example.com/v1"])))).toEqual([
      "not_origin",
    ]);
    expect(codes(await broken((m) => (keys(m)[0] = { ...keys(m)[0], d: "secret" })))).toEqual(["private_key"]);
    expect(codes(await broken((m) => (keys(m)[0] = { ...keys(m)[0], kid: "not-the-thumbprint" })))).toEqual([
      "kid_mismatch",
    ]);
    expect(codes(await broken((m) => (keys(m)[0] = { kty: "RSA", n: "x", e: "AQAB" })))).toEqual(["bad_key"]);
    expect(codes(await checkManifest([]))).toEqual(["not_an_object"]);
  });

  it("warns, and still passes, where an agent would be stuck or exposed", async () => {
    const insecure = await broken(
      (m) => ((m.protocols as Record<string, string>).mcp = "http://inbox.example.com/mcp"),
    );
    expect(insecure.ok).toBe(true);
    expect(insecure.warnings.map((w) => w.code)).toEqual(["insecure_url"]);
    const bare = await broken((m) => {
      m.item_types = ["booking"];
      m.receipt_keys = { keys: [] };
    });
    expect(bare.warnings.map((w) => w.code)).toEqual(["no_message", "no_keys"]);
  });

  it("drops a doors_elsewhere entry exactly where a reader does (vectors/doors-elsewhere.json)", async () => {
    for (const c of doorsElsewhere.cases) {
      const entries = (c.manifest as { doors_elsewhere?: unknown }).doors_elsewhere;
      if (!Array.isArray(entries)) continue;
      const m = { ...structuredClone(manifest), ...c.manifest };
      const report = await checkManifest(m);
      const dropped = report.errors.filter((e) => e.code === "dropped").length;
      // Every entry the reader does not keep is named, and none it keeps.
      expect(dropped, c.name).toBe(entries.length - readDoorsElsewhere(m).length);
      expect(readDoorsElsewhere(m), c.name).toEqual(c.kept);
    }
  });

  it("warns of a platform a reader drops, and of a door that carries tracking (0.9.0)", async () => {
    const fresha = "https://www.fresha.com/a/studio-lumiere-toronto-k3f8q2";
    const named = await broken((m) => {
      m.item_types = ["message", "quote_request"];
      m.doors_elsewhere = [{ item_type: "booking", url: fresha, platform: "fresha" }];
    });
    expect(named.ok).toBe(true);
    expect(named.warnings).toEqual([]);
    const off = await broken((m) => {
      m.item_types = ["message", "quote_request"];
      m.doors_elsewhere = [
        { item_type: "booking", url: "https://studiolumiere.ca/book", platform: "fresha" },
        { item_type: "order", url: "https://shop.studiolumiere.ca/?utm_source=bio&ref=7", platform: "shopify" },
      ];
    });
    expect(off.ok).toBe(true);
    expect(off.warnings.map((w) => [w.path, w.code])).toEqual([
      ["$.doors_elsewhere[0].platform", "platform_dropped"],
      ["$.doors_elsewhere[1].url", "tracking"],
    ]);
  });
});

describe("checkDocument: what was pasted, read as what it is", () => {
  it("reads JSON as a manifest, a receipt's JWS as a receipt and an acknowledgement's as one", async () => {
    expect((await checkDocument(JSON.stringify(manifest))).kind).toBe("manifest");
    const r = v1.receipts[0];
    const receipt = await checkDocument(`  ${r?.jws}\n`, { keys: JSON.stringify(issuerKeys), now: at(1790000461) });
    expect(receipt.kind).toBe("receipt");
    expect(receipt.ok).toBe(true);
    expect(receipt.warnings).toEqual([]);
    const a = v1.acknowledgements[0];
    const ack = await checkDocument(a?.jws ?? "", { receipt: a?.receipt_jws, now: at(a?.verify_at ?? 0) });
    expect(ack.kind).toBe("acknowledgement");
    expect(ack.ok).toBe(true);
  });

  it("says what it could not read: keys that are not JSON are said to be so, not taken for no keys", async () => {
    expect(codes(await checkDocument("{ not json"))).toEqual(["not_json"]);
    expect(codes(await checkDocument("hello"))).toEqual(["unknown"]);
    const keysWrong = await checkDocument(v1.receipts[0]?.jws ?? "", { keys: "[not json" });
    expect(keysWrong.errors).toEqual([
      { path: "$keys", code: "malformed", message: "The keys are not JSON: paste a JWKS or a manifest." },
    ]);
    expect(keysWrong.kind).toBe("receipt");
  });

  it("reads a receipt pasted across lines, as from an email or a terminal", async () => {
    const r = v1.receipts[0];
    const jws = r?.jws ?? "";
    const broken = `${jws.slice(0, 40)}\n${jws.slice(40, 90)}\r\n  ${jws.slice(90)}\n`;
    const report = await checkDocument(broken, { keys: JSON.stringify(issuerKeys), now: at(1790000461) });
    expect(report.kind).toBe("receipt");
    expect(report.errors).toEqual([]);
  });
});

describe("what the check could not check, it says", () => {
  it("an acknowledgement checked without its receipt or the time it arrived warns of both", async () => {
    const a = v1.acknowledgements[0];
    const alone = await checkAcknowledgement(a?.jws ?? "");
    expect(alone.ok).toBe(true);
    expect(alone.warnings.map((w) => w.code)).toEqual(["receipt_not_given", "age_not_checked"]);
    const whole = await checkAcknowledgement(a?.jws ?? "", { receipt: a?.receipt_jws, now: at(a?.verify_at ?? 0) });
    expect(whole.warnings).toEqual([]);
  });
});
