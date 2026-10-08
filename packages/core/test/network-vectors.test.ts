import {
  AMENDMENT_LIMITS,
  aiCatalogSchema,
  applicableOf,
  attributesResponseSchema,
  attributeVocabularySchema,
  businessCardSchema,
  businessesResponseSchema,
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityState,
  capabilitiesVocabSchema,
  capabilityWeightOf,
  capsOfName,
  capsOfOperation,
  categoriesResponseSchema,
  categoryVocabularySchema,
  checkBusinessInputSchema,
  checkBusinessOutputSchema,
  checkResultSchema,
  doorTypeSchema,
  doorVocabularySchema,
  fixesOf,
  getBusinessOutputSchema,
  gradeOf,
  isRetriedPublication,
  JSON_SCHEMAS,
  jsonSchemaOf,
  LEAD_CAPABILITIES,
  LEADERBOARD_CAN,
  LEADERBOARD_ORDER_BY,
  leaderboardSchema,
  listCategoriesOutputSchema,
  listingDetailSchema,
  listingSchema,
  MCP_OPTIONAL_TOOL_NAMES,
  MCP_TOOL_NAMES,
  OUTCOMES,
  parseReceiptClaims,
  personIssuanceRequestSchema,
  pingRequestSchema,
  presentationRequestSchema,
  profileSchema,
  rankingDocumentSchema,
  rankingV5Schema,
  rankingV6Schema,
  rankingV7Schema,
  readRankingDocument,
  receiptAckPayloadV2Schema,
  receiptPayloadV2Schema,
  registerBusinessInputSchema,
  registerBusinessOutputSchema,
  reportRequestSchema,
  rulesOf,
  SCORE_FORMULA_V1,
  SCORE_FORMULA_V2,
  scoreOf,
  scoreRulesSchema,
  searchBusinessesInputSchema,
  searchBusinessesOutputSchema,
  sellsGoods,
  updateBusinessInputSchema,
  updateBusinessOutputSchema,
} from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import mcpVectors from "../../spec/vectors/mcp.json";
import ordering from "../../spec/vectors/ordering.json";
import orderingV7 from "../../spec/vectors/ordering-v7.json";
import passes from "../../spec/vectors/passes.json";
import profileVectors from "../../spec/vectors/profile.json";
import receiptsV2 from "../../spec/vectors/receipts-v2.json";
import receiptsV6 from "../../spec/vectors/receipts-v6.json";
import scoreVectors from "../../spec/vectors/score.json";
import scoreVectorsV1 from "../../spec/vectors/score-v1.json";
import signatures from "../../spec/vectors/signatures.json";
import attributeVocabulary from "../../spec/vocab/attributes.json";
import capabilityVocabulary from "../../spec/vocab/capabilities.json";
import vocabulary from "../../spec/vocab/categories.json";
import doorVocabulary from "../../spec/vocab/doors.json";
import scoreRulesV1 from "../../spec/vocab/score-rules-v1.json";
import scoreRulesV2 from "../../spec/vocab/score-rules-v2.json";
import { buildNetworkVectors } from "../scripts/network-vectors";
import { type OfferForm, type OfferTerms, termsSha } from "../src/customer/offer";
import type { ActorKind, ItemType } from "../src/domain/types";
import { outcomeOf } from "../src/machine/outcomes";
import { bookingMachine, orderMachine, refundMachine } from "../src/machine/tables";
import { AMENDMENT_LIMITS as INBOX_AMENDMENT_LIMITS } from "../src/negotiation/changes";
import {
  asciiLower,
  formatKey,
  formatPass,
  formatPassRef,
  normaliseEmail,
  parseCredential,
  parsePassHeader,
  passRefOf,
  punycodeEncode,
  SignatureFailure,
  secretHash,
  signInstanceRequest,
  verifyAgentRequest,
  verifyForwardedSignature,
  verifyInstanceRequest,
} from "../src/protocol/index";
import { receiptSha, verifyAck, verifyReceipt } from "../src/receipts/sign";
import registryRules from "./registry-rules-v1.json";

/**
 * The network protocol's vectors (packages/spec/vectors, MIT) against this code, on Node and in
 * workerd. The network's Go tests read the same files; agreeing with them is what makes two
 * implementations of one protocol.
 */

type Case = (typeof signatures.requests)[number] & {
  expect: { ok: boolean; code?: string; domain?: string; keyid?: string; level?: string; platform?: string };
};
const jwk = (k: { kty: string; crv: string; x: string }) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: k.x });

declare global {
  interface ImportMeta {
    /** Vite's static import of many files; vitest provides it on both runtimes. */
    glob(pattern: string, options: { eager: true; import: "default" }): Record<string, unknown>;
  }
}

const committedSchemas = import.meta.glob("../../spec/schemas/*.json", { eager: true, import: "default" });

describe("the committed vectors and schemas", () => {
  it("are exactly what the builder makes", async () => {
    const v = JSON.parse(JSON.stringify(await buildNetworkVectors()));
    expect(v.signatures).toEqual(signatures);
    expect(v.passes).toEqual(passes);
    expect(v.receiptsV2).toEqual(receiptsV2);
    expect(v.receiptsV6).toEqual(receiptsV6);
  });

  it("include a JSON Schema for every message, as z.toJSONSchema writes it", () => {
    const names = Object.keys(committedSchemas).map((p) => (p.split("/").pop() as string).replace(/\.json$/, ""));
    expect(names.sort()).toEqual(Object.keys(JSON_SCHEMAS).sort());
    for (const name of names) {
      expect(committedSchemas[`../../spec/schemas/${name}.json`], name).toEqual(
        JSON.parse(JSON.stringify(jsonSchemaOf(name))),
      );
    }
  });
});

describe("signatures.json", () => {
  const manifestKeys = signatures.instance.manifest_receipt_keys.keys.map((k) => ({ ...jwk(k), kid: k.kid }));
  const platformKey = async (origin: string, keyid: string) => {
    if (origin !== signatures.directory.origin) return null;
    const k = signatures.directory.keys.find((x) => x.kid === keyid);
    return k ? jwk(k) : null;
  };

  for (const c of signatures.requests as Case[]) {
    it(`${c.profile} (${c.receiver}): ${c.name}`, async () => {
      const req = {
        method: c.request.method,
        url: c.request.url,
        headers: c.request.headers as Record<string, string>,
        body: c.request.body,
        authorities: [c.authority],
        now: c.now * 1000,
      };
      if (c.profile === "sdi-instance/1") {
        const run = verifyInstanceRequest({
          ...req,
          keysFor: async (domain) => (domain === "inbox.example.com" ? manifestKeys : null),
        });
        if (c.expect.ok) {
          const v = await run;
          expect(v.domain).toBe(c.expect.domain);
          expect(v.keyid).toBe(c.expect.keyid);
          expect(v.signatureBase).toBe(c.signature_base);
          expect(v.signatureInput).toBe(c.signature_input);
          expect(v.replayUntil).toBe((v.expires as number) + 60);
        } else {
          await expect(run).rejects.toSatisfy((e) => e instanceof SignatureFailure && e.code === c.expect.code);
        }
        return;
      }
      const v = await verifyAgentRequest({ ...req, platformKey });
      if (c.expect.ok) {
        if (v.status !== "verified") throw new Error(JSON.stringify(v));
        expect(v.level).toBe(c.expect.level);
        expect(v.keyid).toBe(c.expect.keyid);
        expect(v.platform).toBe(c.expect.platform);
        expect(v.signatureBase).toBe(c.signature_base);
        expect(v.signature).toBe(c.signature);
        expect(v.authority).toBe(c.authority);
      } else {
        expect(v).toMatchObject({ status: "invalid", code: c.expect.code });
      }
    });
  }

  for (const f of signatures.forwarded) {
    it(`forwarded agent_key: ${f.name}`, async () => {
      const run = verifyForwardedSignature(f.agent_key, f.x, f.instance, f.now * 1000);
      if (f.expect.ok)
        await expect(run).resolves.toMatchObject({ replayKey: expect.stringMatching(/^sig:[0-9a-f]{64}$/) });
      else await expect(run).rejects.toBeInstanceOf(SignatureFailure);
    });
  }

  it("the bodies are the messages they claim to be", () => {
    const body = (name: string) => {
      const c = signatures.requests.find((r) => r.name.startsWith(name));
      if (!c) throw new Error(name);
      return JSON.parse(c.request.body);
    };
    expect(personIssuanceRequestSchema.safeParse(body("sdi-instance/1: POST /v1/persons")).success).toBe(true);
    expect(presentationRequestSchema.safeParse(body("sdi-instance/1: POST /v1/presentations")).success).toBe(true);
    expect(pingRequestSchema.safeParse(body("sdi-instance/1: the hourly ping")).success).toBe(true);
  });

  it("an unsigned request is none, not invalid", async () => {
    const v = await verifyAgentRequest({
      method: "GET",
      url: "https://inbox.example.com/v1/items/x",
      headers: {},
      authorities: ["inbox.example.com"],
      now: Date.now(),
    });
    expect(v).toEqual({ status: "none" });
  });

  it("two instance signatures made in the same second differ, by their nonce", async () => {
    const key = { kid: signatures.instance.kid, privateJwk: signatures.instance.private_jwk as never };
    const make = () =>
      signInstanceRequest({
        method: "POST",
        url: "https://network.example.com/v1/persons",
        body: "{}",
        instance: "https://inbox.example.com",
        key,
        now: 1790001000_000,
      });
    const [a, b] = await Promise.all([make(), make()]);
    expect(a.signature).not.toBe(b.signature);
    const again = await verifyInstanceRequest({
      method: "POST",
      url: "https://network.example.com/v1/persons",
      headers: a.headers,
      body: "{}",
      authorities: ["network.example.com"],
      now: 1790001000_000,
      keysFor: async () => manifestKeys,
    });
    expect(again.domain).toBe("inbox.example.com");
  });

  it("reads Sdi-Pass as a list of at most 8 strings of at most 200 characters", () => {
    expect(parsePassHeader(`"${signatures.pass}", "${signatures.pass_ref}"`)).toEqual([
      signatures.pass,
      signatures.pass_ref,
    ]);
    expect(parsePassHeader(Array(9).fill('"a"').join(", "))).toBeNull();
    expect(parsePassHeader(`"${"a".repeat(201)}"`)).toBeNull();
    expect(parsePassHeader("token")).toBeNull();
  });
});

describe("passes.json", () => {
  it("formats keys, passes and references", () => {
    const f = passes.formats;
    expect(formatKey(f.key.host, f.key.id, f.key.secret)).toBe(f.key.string);
    expect(formatPass(f.pass.host, f.pass.id, f.pass.secret)).toBe(f.pass.string);
    expect(formatPassRef(f.pass_ref.host, f.pass_ref.id)).toBe(f.pass_ref.string);
    expect(passRefOf(f.pass.string)).toBe(f.pass_ref.string);
  });

  for (const p of passes.parse) {
    it(`parses ${JSON.stringify(p.input.slice(0, 60))} as ${p.kind ?? "nothing"}`, () => {
      const c = parseCredential(p.input);
      if (p.kind === null) expect(c).toBeNull();
      else expect(c).toEqual({ kind: p.kind, host: p.host, id: p.id, ...("secret" in p ? { secret: p.secret } : {}) });
    });
  }

  it("keeps SHA-256 of a secret", async () => {
    for (const s of passes.secret_hash) expect(await secretHash(s.secret)).toBe(s.sha256);
  });

  it("derives ppid and email_mac as the ADR writes them", async () => {
    const hmac = async (keyHex: string, msg: string) => {
      const k = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(keyHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
    };
    const b64url = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    for (const p of passes.ppid) {
      expect(b64url(await hmac(p.pairwise_secret_hex, `${p.pid}|https://${p.business_domain}`)).slice(0, 22)).toBe(
        p.ppid,
      );
    }
    for (const m of passes.email_mac) {
      expect(normaliseEmail(m.email)).toBe(m.email);
      const mac = [...(await hmac(m.email_secret_hex, m.email))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(mac).toBe(m.email_mac);
    }
  });

  for (const e of passes.emails) {
    it(`email: ${e.name}`, () => {
      expect(normaliseEmail(e.input)).toBe(e.normalised);
    });
  }

  it("a lone surrogate is normalised as U+FFFD, as it reaches a network through JSON", () => {
    expect(normaliseEmail("ri\ud800ta@example.com")).toBe("ri\ufffdta@example.com");
    expect(normaliseEmail("rita@ex\udc00ample.com")).toBe(`rita@xn--${punycodeEncode("ex\ufffdample")}.com`);
  });

  it("punycode matches RFC 3492's own samples", () => {
    // RFC 3492 §7.1 (A) Arabic (Egyptian) and (L) 3<nen>B<gumi><kinpachi><sensei>.
    expect(punycodeEncode("ليهمابتكلموشعربي؟")).toBe("egbpdaj6bu4bxfgehfvwxn");
    expect(punycodeEncode("3年B組金八先生")).toBe("3B-ww4c5e180e575a65lsy2b");
    expect(asciiLower("ÀBC")).toBe("Àbc");
  });
});

describe("receipts-v2.json", () => {
  const keys = [jwk(receiptsV2.issuer.public_jwk)];

  for (const r of receiptsV2.receipts) {
    it(`receipt: ${r.name}`, async () => {
      expect(await verifyReceipt(r.jws, keys)).toEqual(r.payload);
      expect(await receiptSha(r.jws)).toBe(r.sha);
      expect(receiptPayloadV2Schema.safeParse(r.payload).success).toBe(true);
      expect(parseReceiptClaims(r.payload)?.version).toBe(2);
      expect(r.payload.iat).toBeLessThanOrEqual(receiptsV2.now + 300);
    });
  }

  it("each outcome's ref is the nonce of its item's promise, and due is copied", () => {
    const byItem = new Map<string, (typeof receiptsV2.receipts)[number][]>();
    for (const r of receiptsV2.receipts) byItem.set(r.payload.itm, [...(byItem.get(r.payload.itm) ?? []), r]);
    const outcomes = new Set<string>();
    for (const [, rs] of byItem) {
      const [promise, outcome] = rs as [(typeof rs)[number], (typeof rs)[number]];
      expect(outcome.payload.knd).toBe("outcome");
      expect((outcome.payload as { ref?: string }).ref).toBe(promise.payload.nonce);
      expect(outcome.payload.due).toBe(promise.payload.due);
      outcomes.add((outcome.payload as { out: string }).out);
    }
    const inbox = receiptsV2.outcomes.filter((o) => o.by === "inbox").map((o) => o.code);
    expect([...outcomes].sort()).toEqual([...inbox].sort());
  });

  for (const r of receiptsV2.refused_receipts) {
    it(`refused (${r.code}): ${r.name}`, async () => {
      expect(await verifyReceipt(r.jws, keys)).toEqual(r.payload); // the signature is good…
      if (r.code === "not_yet") {
        expect(parseReceiptClaims(r.payload)).not.toBeNull();
        expect(r.payload.iat).toBeGreaterThan(receiptsV2.now + 300); // …the clock refuses it
      } else {
        expect(parseReceiptClaims(r.payload)).toBeNull(); // …the claims do not
      }
    });
  }

  it("every transition path records the outcome the vector names, and only those queue one", () => {
    const machinesByType = { booking: bookingMachine, order: orderMachine } as const;
    expect(receiptsV2.transitions.length).toBeGreaterThan(100);
    for (const p of receiptsV2.transitions) {
      const actor = p.actor as ActorKind;
      const got = outcomeOf(p.typ as ItemType, p.event, p.from, actor);
      const want = p.out === null ? null : p.aut ? { code: p.out, aut: 1 } : { code: p.out };
      expect(got, `${p.typ} ${p.event} from ${p.from} by ${p.actor}`).toEqual(want);
      const machine = machinesByType[p.typ as "booking" | "order"];
      const entry = machine.transitions.find(
        (t) => t.event === p.event && t.from.includes(p.from as never) && t.by.includes(actor),
      );
      expect(entry?.to, `${p.typ} ${p.event} from ${p.from}`).toBe(p.to);
      expect(entry?.effects?.includes("issue_receipt:outcome") ?? false, `${p.typ} ${p.event} from ${p.from}`).toBe(
        p.out !== null,
      );
    }
    // And the vector names every path the machines have: none is left out.
    let paths = 0;
    for (const m of [bookingMachine, orderMachine]) {
      for (const t of m.transitions) paths += t.from.length * t.by.length;
    }
    expect(receiptsV2.transitions).toHaveLength(paths);
  });

  for (const a of receiptsV2.acknowledgements) {
    it(`acknowledgement: ${a.name}`, async () => {
      const v = await verifyAck(a.jws, {
        receiptId: a.payload.rcp,
        receiptJws: a.receipt_jws,
        now: a.verify_at * 1000,
      });
      expect(v.payload).toEqual(a.payload);
      expect(receiptAckPayloadV2Schema.safeParse(a.payload).success).toBe(true);
    });
  }
});

describe("receipts-v6.json", () => {
  const keys = [jwk(receiptsV6.issuer.public_jwk)];
  type V6Receipt = (typeof receiptsV6.receipts)[number] & {
    payload: Record<string, unknown>;
    rules_5: Record<string, unknown> | null;
    agreed?: { form: OfferForm; terms: OfferTerms; terms_sha: string; trm_key: string };
  };
  /** HMAC-SHA-256 by hand, as any verifier would: `trm` from the disclosed key and the terms' fingerprint. */
  const hmac = async (keyB64u: string, message: string) => {
    const raw = Uint8Array.from(atob(keyB64u.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
    return btoa(String.fromCharCode(...mac))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };
  const all = receiptsV6.receipts as V6Receipt[];

  for (const r of all) {
    it(`receipt: ${r.name}`, async () => {
      expect(await verifyReceipt(r.jws, keys)).toEqual(r.payload);
      expect(await receiptSha(r.jws)).toBe(r.sha);
      expect(receiptPayloadV2Schema.safeParse(r.payload).success).toBe(true);
      expect(parseReceiptClaims(r.payload)).toEqual({ version: 2, claims: r.payload });
      // A reader on rules 5 refuses what version 6 added, and ignores the claims it does not know.
      const five = parseReceiptClaims(r.payload, { rules: 5 });
      expect(five === null ? null : five.claims).toEqual(r.rules_5);
      expect(r.payload.iat as number).toBeLessThanOrEqual(receiptsV6.now + 300);
      if (r.agreed) {
        expect(await termsSha(r.agreed.form, r.agreed.terms)).toBe(r.agreed.terms_sha);
        expect(await hmac(r.agreed.trm_key, r.agreed.terms_sha)).toBe(r.payload.trm);
        // Never the bare fingerprint: nobody without the key can test guessed terms against it.
        expect(r.payload.trm).not.toBe(r.agreed.terms_sha);
      }
      // What version 6 adds says nothing more about the person: no presentation on an amendment or a refund's.
      if (r.payload.knd === "amended" || r.payload.typ === "refund") expect(r.payload.per).toBeUndefined();
    });
  }

  it("an amendment and an outcome name the earliest promise, and an outcome reads the latest amendment's dates", () => {
    const byItem = new Map<string, V6Receipt[]>();
    for (const r of all) byItem.set(String(r.payload.itm), [...(byItem.get(String(r.payload.itm)) ?? []), r]);
    const seen = new Set<string>();
    for (const [, rs] of byItem) {
      const [promise] = rs as [V6Receipt];
      expect(["confirmed", "paid", "accepted"]).toContain(promise.payload.knd);
      const amendments = rs
        .filter((r) => r.payload.knd === "amended")
        .sort((a, b) => Number(a.payload.iat) - Number(b.payload.iat));
      const outcome = rs.find((r) => r.payload.knd === "outcome") as V6Receipt;
      for (const a of amendments) expect(a.payload.ref).toBe(promise.payload.nonce);
      expect(outcome.payload.ref).toBe(promise.payload.nonce);
      const latest = amendments.at(-1) ?? promise;
      expect(outcome.payload.due).toBe(latest.payload.due);
      expect(outcome.payload.end).toBe(latest.payload.end);
      seen.add(String(outcome.payload.out));
    }
    // Every refund outcome an inbox records has its receipt.
    const refunds = receiptsV6.outcomes.filter((o) => o.by === "inbox").map((o) => o.code);
    for (const code of refunds) expect(seen.has(code), code).toBe(true);
  });

  it("adds rows to the outcome table, none of them on a customer's side", () => {
    expect(receiptsV6.outcomes).toEqual(JSON.parse(JSON.stringify(OUTCOMES.filter((o) => "since" in o))));
    for (const o of receiptsV6.outcomes) {
      expect(o.since).toBe(6);
      expect(o.customer, o.code).toBeNull();
    }
    expect(receiptsV2.outcomes.some((o) => (o.code as string).startsWith("refund."))).toBe(false);
    expect(receiptsV6.amendment_limits).toEqual(AMENDMENT_LIMITS);
    // The inbox never records more than a network honours.
    expect(INBOX_AMENDMENT_LIMITS.maxPerItem).toBeLessThanOrEqual(AMENDMENT_LIMITS.unverified);
    expect(INBOX_AMENDMENT_LIMITS.dueShiftDays).toBeLessThanOrEqual(AMENDMENT_LIMITS.dueShiftDays);
  });

  for (const r of receiptsV6.refused_receipts) {
    it(`refused (${r.code}): ${r.name}`, async () => {
      expect(await verifyReceipt(r.jws, keys)).toEqual(r.payload);
      expect(parseReceiptClaims(r.payload)).toBeNull();
      // A reader on rules 5 ignores trm and acc however they look (A3.6): refused only for what else it refuses.
      const five = parseReceiptClaims(r.payload, { rules: 5 });
      expect(five === null ? null : five.claims).toEqual(r.rules_5);
    });
  }

  for (const a of receiptsV6.acknowledgements) {
    it(`acknowledgement: ${a.name}`, async () => {
      const v = await verifyAck(a.jws, {
        receiptId: a.payload.rcp,
        receiptJws: a.receipt_jws,
        now: a.verify_at * 1000,
      });
      expect(v.payload).toEqual(a.payload);
      expect(receiptAckPayloadV2Schema.safeParse(a.payload).success).toBe(true);
      expect(all.find((r) => r.jws === a.receipt_jws)?.payload.knd).toBe("amended");
    });
  }

  for (const r of receiptsV6.reports) {
    it(`report: ${r.name}`, () => {
      expect(reportRequestSchema.safeParse(r.request).success).toBe(r.ok);
    });
  }

  it("every refund path records the outcome the vector names, by how its date stood, and only those queue one", () => {
    const ms = (s: number) => s * 1000;
    const due = ms(1_790_000_000);
    const ctxOf = (when: string | null) =>
      when === "by_due"
        ? { due, now: due }
        : when === "after_due"
          ? { due, now: due + 1000 }
          : when === "no_due"
            ? { due: null, now: due }
            : when === "due_fixed"
              ? { due, now: due - 1 }
              : {};
    const refundPaths = receiptsV6.transitions.filter((p) => p.typ === "refund");
    for (const p of refundPaths) {
      const actor = p.actor as ActorKind;
      const got = outcomeOf("refund", p.event, p.from, actor, ctxOf(p.when));
      const want = p.out === null ? null : p.aut ? { code: p.out, aut: 1 } : { code: p.out };
      expect(got, `refund ${p.event} from ${p.from} by ${p.actor} (${p.when})`).toEqual(want);
      const entry = refundMachine.transitions.find(
        (t) => t.event === p.event && t.from.includes(p.from as never) && t.by.includes(actor),
      );
      expect(entry?.to, `refund ${p.event} from ${p.from}`).toBe(p.to);
      // A transition that can close a promise queues its outcome; approving or taking the goods back
      // queues the promise, which is issued once the date is fixed.
      const closes = refundPaths.some(
        (q) => q.event === p.event && q.from === p.from && q.actor === p.actor && q.out !== null,
      );
      expect(entry?.effects?.includes("issue_receipt:outcome") ?? false, `refund ${p.event} from ${p.from}`).toBe(
        closes,
      );
      expect(entry?.effects?.includes("issue_receipt:accepted") ?? false).toBe(p.receipt === "accepted");
    }
    // The vector names every refund path the machine has, each date variant once.
    const variants = new Set(refundPaths.map((p) => `${p.event}|${p.from}|${p.actor}`));
    let paths = 0;
    for (const t of refundMachine.transitions) paths += t.from.length * t.by.length;
    expect(variants.size).toBe(paths);
  });

  it("a change records no outcome, and accepting one issues its amended receipt", () => {
    const changes = receiptsV6.transitions.filter((p) => p.typ !== "refund");
    const machinesByType = { booking: bookingMachine, order: orderMachine } as const;
    let paths = 0;
    for (const m of [bookingMachine, orderMachine]) {
      for (const t of m.transitions) if (t.event.endsWith("_change")) paths += t.from.length * t.by.length;
    }
    expect(changes).toHaveLength(paths);
    for (const p of changes) {
      const actor = p.actor as ActorKind;
      expect(outcomeOf(p.typ as ItemType, p.event, p.from, actor)).toBeNull();
      const entry = machinesByType[p.typ as "booking" | "order"].transitions.find(
        (t) => t.event === p.event && t.from.includes(p.from as never) && t.by.includes(actor),
      );
      expect(entry?.to).toBe(p.from);
      expect(entry?.effects?.includes("issue_receipt:amended") ?? false, `${p.typ} ${p.event}`).toBe(
        p.receipt === "amended",
      );
    }
  });
});

describe("ordering-v7.json (the network's, read here as any consumer would)", () => {
  // Every domain in the file ends in .example, whose registrable domain is its last two labels.
  const registrable = (d: string) => d.split(".").slice(-2).join(".");
  for (const c of orderingV7.cases) {
    it(`${c.name}: the order, its newcomers' places, and pages of it narrowed`, async () => {
      for (const e of c.entries) {
        const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${c.at.slice(0, 10)}:${e.ref}`));
        const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect(hex.slice(0, 16), e.ref).toBe(e.shuffle);
      }
      const placed = placeNewcomers(
        orderV7(c.entries.map((e) => ({ ...e, domain: registrable(e.domain) }) as unknown as OrderEntry)),
      );
      const positions = c.positions as Record<string, number>;
      expect(placed.map((p) => p.entry.ref)).toEqual(c.order);
      expect(placed.filter((p) => p.slot).map((p) => p.entry.ref)).toEqual(c.slots);
      placed.forEach((p, i) => {
        expect(positions[p.entry.ref], p.entry.ref).toBe(i + 1);
      });
      for (const pg of c.pages) {
        const kept = placed.filter((p) => pg.keep.includes(p.entry.ref));
        expect(kept.map((p) => p.entry.ref)).toEqual(pg.keep);
        expect(kept.slice(pg.o, pg.o + pg.limit).map((p) => `${p.entry.ref}${p.slot ? "*" : ""}`)).toEqual(pg.page);
        expect(kept.length > pg.o + pg.limit).toBe(pg.more);
      }
    });
  }
});

describe("ordering.json (the network's, read here as any consumer would)", () => {
  it("reproduces every rank_shuffle: the first 16 hex digits of SHA-256(date:uuid), a string", async () => {
    for (const s of ordering.shuffles) {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${s.date}:${s.id}`));
      const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(hex.slice(0, 16)).toBe(s.rank_shuffle);
      expect(BigInt(`0x${s.rank_shuffle}`).toString()).toBe(s.decimal);
    }
  });

  it("decodes every cursor as base64url JSON", () => {
    for (const c of ordering.cursors) {
      const text = atob(c.cursor.replace(/-/g, "+").replace(/_/g, "/"));
      expect(text).toBe(c.decoded);
    }
  });

  it("a directory page parses", () => {
    expect(businessesResponseSchema.safeParse({ businesses: [], next_cursor: null }).success).toBe(true);
  });
});

/**
 * How the categories list compares terms: lower case, accents off, every run of anything but letters and digits one
 * space, and the words "and" and "e" (Portuguese "and") left out.
 */
const foldTerm = (s: string) =>
  s
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "" && w !== "and" && w !== "e")
    .join(" ");

describe("profile.json and vocab/categories.json (the network's, read here as any consumer would)", () => {
  it("the categories list is well formed, and no term names two slugs", () => {
    const v = categoryVocabularySchema.parse(vocabulary);
    const named = new Map<string, string>();
    for (const c of v.categories) {
      const terms = [c.slug];
      for (const lang of v.languages) {
        expect(c.labels[lang], `${c.slug}: ${lang} label`).toBeTruthy();
        terms.push(c.labels[lang] ?? "", ...(c.synonyms[lang] ?? []));
      }
      for (const t of terms) {
        const f = foldTerm(t);
        expect(f, `${c.slug}: ${t}`).not.toBe("");
        expect(named.get(f) ?? c.slug, `${t} names ${named.get(f)} and ${c.slug}`).toBe(c.slug);
        named.set(f, c.slug);
      }
    }
    expect(foldTerm("Cabeleireiro e Estética")).toBe(foldTerm("cabeleireiro & estetica"));
    const answer = { version: v.version, categories: v.categories.map(({ slug, labels }) => ({ slug, labels })) };
    expect(categoriesResponseSchema.safeParse(answer).success).toBe(true);
  });

  it("what a network keeps from each profile is a listing's shape, naming only the list's slugs", () => {
    expect(profileVectors.vocabulary_version).toBe(vocabulary.version);
    const slugs = new Set(vocabulary.categories.map((c) => c.slug));
    for (const c of profileVectors.cases) {
      const kept: Record<string, unknown> = c.kept;
      for (const s of kept.categories as string[]) expect(slugs.has(s), `${c.name}: ${s}`).toBe(true);
      const listing = {
        ...kept,
        name: kept.name || "A business",
        domain: "ana.example",
        geo: kept.geo ?? undefined,
        hours: kept.hours ?? undefined,
        open_now: kept.hours ? false : null,
        item_types: [],
        protocols: {},
        manifest_url: "https://ana.example/.well-known/agent-inbox.json",
        verified_at: "2026-12-01T10:00:00Z",
        receipts: { issued: 0, acknowledged: 0 },
        answering: true,
        online: true,
        not_answering_since: null,
      };
      const r = listingSchema.safeParse(listing);
      expect(r.success, `${c.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it("the contract's own example is a valid profile, and so is the inbox's hours shape", () => {
    expect(profileSchema.safeParse(profileVectors.cases[0]?.profile).success).toBe(true);
    const bad = { name: "x", hours: { timezone: "Europe/Lisbon", weekly: { mon: [["18:00", "09:00"]] } } };
    expect(profileSchema.safeParse(bad).success).toBe(false);
  });
});

/** A space, a control character, a Bidi_Control character or a tag character: text that reads otherwise than it is. */
const readsOtherwise = /[\s\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u{E0000}-\u{E007F}]/u;

/**
 * An https door as a card may hand it on: on a host name, with no user, and written as RFC 3986 writes a URI (ASCII only,
 * a `%` only before two hex digits, at most one `#`), so that it holds to the schemas' `format: uri`.
 */
function cardDoor(url: string): boolean {
  const host = /^https:\/\/([^/?#]*)/.exec(url)?.[1] ?? "";
  return (
    /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]*$/.test(url) &&
    !/%(?![0-9A-Fa-f]{2})/.test(url) &&
    url.split("#").length <= 2 &&
    /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]+)?$/.test(host)
  );
}

/** Today's hours in the business's own zone at `now`, as mcp.json's description says a network derives them. */
function hoursToday(
  hours:
    | { timezone: string; weekly: Partial<Record<string, string[][]>>; closures: { from: string; to: string }[] }
    | undefined,
  now: string,
): string | null {
  if (!hours) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: hours.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (hours.closures.some((c) => c.from <= date && date <= c.to)) return "closed today";
  const windows = hours.weekly[part("weekday").toLowerCase().slice(0, 3)] ?? [];
  return windows.length === 0 ? "closed today" : windows.map(([opens, closes]) => `${opens}–${closes}`).join(", ");
}

describe("mcp.json (the network's, read here as any consumer would)", () => {
  it("every card, and every whole answer, holds to the tools' schemas", () => {
    for (const c of mcpVectors.cards) {
      const r = businessCardSchema.safeParse(c.card);
      expect(r.success, `${c.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
      expect(listingSchema.safeParse(c.listing).success, `${c.name}: the listing`).toBe(true);
    }
    for (const [name, schema, answer] of [
      ["search_businesses", searchBusinessesOutputSchema, mcpVectors.search_businesses],
      ["get_business", getBusinessOutputSchema, mcpVectors.get_business],
      ["list_categories", listCategoriesOutputSchema, mcpVectors.list_categories],
    ] as const) {
      const r = schema.safeParse(answer);
      expect(r.success, `${name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
    expect([...MCP_TOOL_NAMES]).toEqual(["search_businesses", "get_business", "list_categories"]);
    expect(searchBusinessesInputSchema.safeParse({ query: "haircut alfama", limit: 21 }).success).toBe(false);
    expect(searchBusinessesInputSchema.safeParse({ near: { lat: 38.7, lng: -9.1 }, open_now: true }).success).toBe(
      true,
    );
  });

  it("a card is derived from its listing as the file says", () => {
    for (const { name, now, listing, card } of mcpVectors.cards) {
      const l = listingSchema.parse(listing);
      const doors = Object.fromEntries(
        (["mcp", "rest", "openapi"] as const).flatMap((d) => {
          const url = l.protocols[d];
          return url?.startsWith("https://") && !readsOtherwise.test(url) && cardDoor(url) ? [[d, url]] : [];
        }),
      );
      expect(card.inbox, name).toEqual({ url: `https://${l.domain}`, ...doors });
      expect(card.takes, name).toEqual(l.item_types);
      expect(card.open_now ?? null, name).toBe(l.open_now ?? null);
      expect(card.hours_today, name).toBe(hoursToday(l.hours, now));
      expect(card.listing_url, name).toBe(`${mcpVectors.network}/v1/businesses/${l.domain}`);
      const distance = l.distance_km === undefined ? undefined : Math.round(l.distance_km * 100) / 100;
      expect((card as { distance_km?: number }).distance_km, name).toBe(distance);
      const standing = (card as { standing?: { tier: string; ranked: boolean; in_words: string } }).standing;
      if (l.reputation) {
        expect(standing, name).toEqual({
          tier: l.reputation.tier,
          ranked: l.reputation.ranked,
          in_words: mcpVectors.standing[l.reputation.tier],
        });
      } else {
        expect(standing, name).toBeUndefined();
      }
    }
  });

  it("no standing is a mark against a business", () => {
    for (const words of Object.values(mcpVectors.standing)) {
      expect(words.toLowerCase()).not.toMatch(/bad|poor|low|warn|avoid|untrust|risk|caution|broken|fail/);
    }
  });
});

describe("what an inbox reads from a network's answers", () => {
  it("retries 404, 429, 5xx and 422 unknown_key/unknown_ref; every other refusal is final", () => {
    for (const [status, code] of [
      [404, "unknown_issuer"],
      [429, "too_many_receipts"],
      [503, undefined],
      [422, "unknown_key"],
      [422, "unknown_ref"],
    ] as const) {
      expect(isRetriedPublication(status, code), `${status} ${code}`).toBe(true);
    }
    for (const [status, code] of [
      [422, "bad_payload"],
      [422, "not_yet"],
      [409, "nonce_reused"],
      [400, undefined],
      [422, "ack_bad_signature"],
    ] as const) {
      expect(isRetriedPublication(status, code), `${status} ${code}`).toBe(false);
    }
  });

  it("reads the rules in force and the ones announced", () => {
    const v2 = rankingDocumentSchema.parse({
      version: 2,
      status: "in_force",
      effective_at: "2026-09-22T00:00:00Z",
      summary: "The neutral order.",
      order: { default: "verified_at desc, id desc", near: "distance asc, id asc" },
      never_used: [],
      next: {
        version: 3,
        effective_at: "2026-10-09T00:00:00Z",
        url: "https://network.example.com/v1/ranking?version=3",
      },
    });
    expect(rulesOf(v2)).toEqual({
      inForce: 2,
      next: {
        version: 3,
        effective_at: "2026-10-09T00:00:00Z",
        url: "https://network.example.com/v1/ranking?version=3",
      },
    });
    expect(rulesOf(rankingDocumentSchema.parse({ version: 1, status: "withdrawn", summary: "…" }))).toEqual({
      inForce: 1,
      next: null,
    });
  });

  it("reads version 6's limits on amendments and refunds, and refuses a version 6 without them", () => {
    const v4 = {
      version: 4,
      rules: "0.1.1",
      status: "in_force",
      published_at: "2026-09-23T00:00:00Z",
      effective_at: "2026-09-23T00:00:00Z",
      summary: "…",
    };
    expect(Object.keys(rankingV6Schema.shape.amendments.shape).sort()).toEqual([
      "dates_from",
      "due_shift_days_max",
      "unverified_max",
    ]);
    expect(Object.keys(rankingV6Schema.shape.refunds.shape).sort()).toEqual([
      "honoured_o",
      "late_o",
      "promise",
      "report_window_days",
    ]);
    // Version 6 is version 5 (Amendment 2) with what Amendment 3 adds: nothing version 5 publishes is dropped.
    for (const k of Object.keys(rankingV5Schema.shape)) expect(Object.keys(rankingV6Schema.shape), k).toContain(k);
    expect(Object.keys(rankingV6Schema.shape.order.shape)).toContain("member");
    expect(Object.keys(rankingV6Schema.shape.timing.shape)).toContain("contest_days");
    expect(Object.keys(rankingV5Schema.shape)).not.toContain("amendments");
    // A version 6 document missing what version 6 adds is not version 6.
    expect(rankingDocumentSchema.safeParse({ ...v4, version: 6, rules: "0.1.3" }).success).toBe(false);
  });
});

/* --- protocol 0.2 ------------------------------------------------------------------------------------------------- */

type Door = { type: string; url: string; level: string; status: string; kinds: readonly string[]; protocol?: string };
type Kind = "b" | "l";

const LEVELS = ["listed", "readable", "askable", "bookable", "payable"];
const DOOR_LABELS: Record<string, string> = {
  inbox: "inbox",
  mcp: "MCP",
  a2a: "A2A",
  openapi: "OpenAPI",
  api: "API",
  ucp: "UCP",
  acp: "ACP",
  nlweb: "NLWeb",
};

/**
 * A card's `why` line as network.md §4.10 says a network writes it, re-derived here as any consumer would: the parts
 * that apply, in this order, joined with " · ".
 */
function whyOf(
  card: {
    source?: "member" | "registered" | "found";
    answering?: boolean;
    doors?: Door[];
    proof?: string;
    found?: { checked_at: string };
  },
  ctx: { category?: string; band?: 1 | 2; openNow?: boolean; kept?: number; slot?: boolean } = {},
): string {
  const parts: string[] = [];
  if (ctx.category) parts.push(`category ${ctx.category}`);
  else if (ctx.band === 1) parts.push("matches its name, categories or services");
  else if (ctx.band === 2) parts.push("matches its description");
  if (ctx.openNow) parts.push("open now");
  if (card.source === "member") {
    parts.push(card.answering ? "answers its inbox" : "its inbox has not answered in the last day");
  } else {
    const best = (card.doors ?? [])
      .filter((d) => d.status === "live" && LEVELS.indexOf(d.level) >= 2)
      .reduce<Door | undefined>((b, d) => (!b || LEVELS.indexOf(d.level) > LEVELS.indexOf(b.level) ? d : b), undefined);
    if (best) {
      const label = best.type.startsWith("platform:")
        ? `${best.type.slice("platform:".length)} (platform)`
        : best.type === "other"
          ? (best.protocol ?? "other")
          : (DOOR_LABELS[best.type] ?? best.type);
      const level = best.kinds.includes("order") && !best.kinds.includes("book") ? "orderable" : best.level;
      parts.push(`${label} door, ${level}`);
    }
  }
  if (ctx.kept !== undefined) parts.push(`${ctx.kept} promises kept`);
  if (ctx.slot) parts.push("newcomer's turn");
  if (card.source === "found" && card.found)
    parts.push(`found on its own website · not a member · checked ${card.found.checked_at.slice(0, 10)}`);
  if (card.source === "registered") parts.push(`registered by the business · proof: ${card.proof}`);
  return parts.length ? parts.join(" · ") : "in the directory's published order";
}

/** An entry of the hour's order (rules version 7, §4.4) as the network's snapshot holds it. */
interface OrderEntry {
  kind: Kind;
  ref: string;
  domain: string;
  reach: 1 | 2 | 3;
  level: number;
  ranked: boolean;
  score_int: number;
  shuffle: string;
  newcomer?: boolean;
}

/** Reach 1; then reach 2 by its best door's level, payable, bookable or orderable, askable; then the rest. */
const tierOf = (e: OrderEntry) =>
  e.reach === 1 ? 0 : e.reach === 2 && e.level >= 3 ? 1 + (5 - Math.min(e.level, 5)) : 4;

/**
 * The hour's order: tier, the ranked by their record, the daily shuffle, a member before an entry that is not, the id;
 * then one place per domain (a member's, else the better one). Domains here are already registrable.
 */
function orderV7(entries: OrderEntry[]): OrderEntry[] {
  const sorted = [...entries].sort(
    (a, b) =>
      tierOf(a) - tierOf(b) ||
      Number(b.ranked) - Number(a.ranked) ||
      (a.ranked && b.ranked ? b.score_int - a.score_int : 0) ||
      (a.shuffle < b.shuffle ? -1 : a.shuffle > b.shuffle ? 1 : 0) ||
      (a.kind === b.kind ? 0 : a.kind === "b" ? -1 : 1) ||
      (a.ref.toLowerCase() < b.ref.toLowerCase() ? -1 : a.ref.toLowerCase() > b.ref.toLowerCase() ? 1 : 0),
  );
  const keep = new Map<string, OrderEntry>();
  for (const e of sorted) {
    const held = keep.get(e.domain);
    if (!held || (held.kind === "l" && e.kind === "b")) keep.set(e.domain, e);
  }
  const kept = new Set(keep.values());
  return sorted.filter((e) => kept.has(e));
}

/**
 * The hour's places (rules version 7, §4.4), given once to the whole order: walking places 1, 2, …, every 5th goes to
 * the next newcomer not yet placed (a slot), every other to the next entry not yet placed. A search narrows the result
 * and never places anyone again, so a filter moves nobody and a page is a cut of what the filter keeps.
 */
function placeNewcomers<T extends { ref: string; newcomer?: boolean }>(
  order: readonly T[],
): { entry: T; slot: boolean }[] {
  const newcomers = order.filter((e) => e.newcomer);
  const placed = new Set<string>();
  const out: { entry: T; slot: boolean }[] = [];
  let li = 0;
  let ni = 0;
  while (out.length < order.length) {
    let entry: T | undefined;
    let slot = false;
    if ((out.length + 1) % 5 === 0) {
      while (ni < newcomers.length && placed.has((newcomers[ni] as T).ref)) ni++;
      if (ni < newcomers.length) {
        entry = newcomers[ni++];
        slot = true;
      }
    }
    if (!entry) {
      while (placed.has((order[li] as T).ref)) li++;
      entry = order[li++] as T;
    }
    placed.add(entry.ref);
    out.push({ entry, slot });
  }
  return out;
}

describe("protocol 0.2: vocab/doors.json and vocab/attributes.json", () => {
  it("the door vocabulary is well formed, and no refused kind is a door type", () => {
    const v = doorVocabularySchema.parse(doorVocabulary);
    for (const t of v.types) expect(doorTypeSchema.safeParse(t).success, t).toBe(true);
    for (const t of v.refused) expect(doorTypeSchema.safeParse(t).success, t).toBe(false);
    expect(doorTypeSchema.safeParse("platform:shopify").success).toBe(true);
    expect(doorTypeSchema.safeParse("platform:").success).toBe(false);
    expect(v.refused).toEqual(expect.arrayContaining(["mailto", "tel", "sms", "whatsapp", "form", "page"]));
    for (const k of v.delivery_kinds) expect(v.kinds).toContain(k);
    expect(v.delivery_kinds).toEqual(["ask", "quote"]);
    // Version 2: webmcp is read and may count toward the agentic score, but it is no declarable door type.
    expect(v.version).toBe(2);
    expect(v.experimental).toEqual(["webmcp"]);
    for (const t of v.experimental ?? []) {
      expect(v.types).not.toContain(t);
      expect(doorTypeSchema.safeParse(t).success, t).toBe(false);
    }
  });

  it("every attribute applies to known groups, has five labels, and needs a proof where a register would give one", () => {
    const v = attributeVocabularySchema.parse(attributeVocabulary);
    const slugs = new Set(vocabulary.categories.map((c) => c.slug));
    const keys = v.keys.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of v.keys) {
      for (const g of k.applies_to) expect(g === "*" || slugs.has(g), `${k.key}: ${g}`).toBe(true);
      expect(Object.keys(k.labels).sort(), k.key).toEqual(["de", "en", "es", "fr", "pt"]);
      expect(k.type === "enum", k.key).toBe(Boolean(k.values?.length));
    }
    expect(v.keys.filter((k) => k.needs_proof).map((k) => k.key)).toEqual(["halal", "kosher", "cert"]);
    expect(v.keys.filter((k) => k.group === "identity").every((k) => k.crawlable === "declared")).toBe(true);
    // What GET /v1/attributes answers from it.
    const answer = {
      version: v.version,
      keys: v.keys.map(({ key, group, type, values, labels, needs_proof }) => ({
        key,
        group,
        type,
        ...(values ? { values } : {}),
        labels,
        ...(needs_proof ? { filterable: false } : {}),
      })),
      payments: { methods: ["card", "pix"], wallets: ["apple_pay"], agent: ["x402"] },
    };
    expect(attributesResponseSchema.safeParse(answer).success).toBe(true);
  });
});

/** A business the network found on its own website, as a card shows it: fictional, and no street, phone or email. */
const foundCard = {
  domain: "taller-norte.example",
  name: "Taller Norte",
  description: "Bicycle repairs and parts.",
  website: "https://taller-norte.example/",
  city: "Valparaíso",
  country: "CL",
  distance_km: 3,
  categories: ["repair"],
  tags: [],
  languages: ["es"],
  takes: [],
  services: [],
  open_now: null,
  hours_today: null,
  answering: false,
  listing_url: "https://network.example.org/v1/businesses/taller-norte.example",
  source: "found",
  claimed: false,
  level: "bookable",
  has_inbox: false,
  doors: [
    {
      type: "mcp",
      url: "https://taller-norte.example/mcp",
      level: "bookable",
      status: "live",
      kinds: ["ask", "order"],
      src: "seen",
      checked_at: "2026-10-06T08:00:00Z",
    },
    {
      type: "acp",
      url: "https://taller-norte.example/acp",
      level: "payable",
      status: "failing",
      kinds: ["order", "pay"],
      src: "declared",
    },
  ],
  accepts: { kinds: ["ask", "order"], pay: ["card"] },
  category: {
    primary: { id: "bicycle_shop", label: "Bicycle shop", src: "declared" },
    alternates: [],
    path: ["retail", "bicycle_shop"],
    group: "repair",
  },
  attributes: { walk_ins: { v: true, src: "seen" } },
  place: { locality: "Valparaíso", region: "Valparaíso", country: "CL", kind: ["storefront"] },
  why: "MCP door, orderable · found on its own website · not a member · checked 2026-10-06",
  found: {
    note: "found on its own website · not a member · checked 2026-10-06",
    checked_at: "2026-10-06T08:00:00Z",
    about_url: "https://network.example.org/bot",
  },
} as const;

describe("protocol 0.2: cards, listings and the why line", () => {
  it("a found card holds to the card's schema without an inbox, and never offers a human channel as a door", () => {
    expect(businessCardSchema.safeParse(foundCard).success).toBe(true);
    const withTel = { ...foundCard, doors: [{ ...foundCard.doors[0], type: "tel", url: "tel:+56912345678" }] };
    expect(businessCardSchema.safeParse(withTel).success).toBe(false);
    const listing = {
      domain: foundCard.domain,
      name: foundCard.name,
      city: foundCard.city,
      country: foundCard.country,
      categories: ["repair"],
      languages: ["es"],
      item_types: [],
      protocols: {},
      receipts: { issued: 0, acknowledged: 0 },
      answering: false,
      online: false,
      not_answering_since: null,
      source: "found",
      doors: foundCard.doors,
      found: foundCard.found,
      outcomes: {},
      facts: [
        {
          field: "name",
          v: "Taller Norte",
          src: "declared",
          url: "https://taller-norte.example/",
          at: "2026-10-06T08:00:00Z",
        },
      ],
    };
    expect(listingDetailSchema.safeParse(listing).success).toBe(true);
    expect(getBusinessOutputSchema.safeParse({ ...foundCard, outcomes: {}, facts: listing.facts }).success).toBe(true);
  });

  it("derives why in the order the protocol gives", () => {
    const member = { source: "member" as const, answering: true };
    expect(whyOf(member)).toBe("answers its inbox");
    expect(whyOf(member, { category: "Hair & beauty", openNow: true, kept: 12 })).toBe(
      "category Hair & beauty · open now · answers its inbox · 12 promises kept",
    );
    expect(whyOf({ source: "member", answering: false }, { band: 2 })).toBe(
      "matches its description · its inbox has not answered in the last day",
    );
    expect(whyOf(member, { band: 1, slot: true })).toBe(
      "matches its name, categories or services · answers its inbox · newcomer's turn",
    );
    // The best live door counts; a failing one, however high, does not. Orders and no booking: orderable.
    expect(whyOf({ ...foundCard, doors: [...foundCard.doors] })).toBe(foundCard.why);
    expect(
      whyOf({
        source: "registered",
        proof: "domain",
        doors: [
          {
            type: "platform:shopify",
            url: "https://s.example/mcp",
            level: "bookable",
            status: "live",
            kinds: ["order"],
          },
          { type: "a2a", url: "https://s.example/a2a", level: "askable", status: "live", kinds: ["ask"] },
        ],
      }),
    ).toBe("shopify (platform) door, orderable · registered by the business · proof: domain");
    expect(
      whyOf({
        source: "registered",
        proof: "code",
        doors: [
          { type: "mcp", url: "https://s.example/mcp", level: "bookable", status: "live", kinds: ["ask", "book"] },
        ],
      }),
    ).toBe("MCP door, bookable · registered by the business · proof: code");
    expect(whyOf({})).toBe("in the directory's published order");
  });

  it("the tools: three, as before, and four more a network may offer", () => {
    expect([...MCP_TOOL_NAMES]).toEqual(["search_businesses", "get_business", "list_categories"]);
    expect([...MCP_OPTIONAL_TOOL_NAMES]).toEqual([
      "list_attributes",
      "register_business",
      "update_business",
      "check_business",
    ]);
    const input = searchBusinessesInputSchema.parse({
      category: "hair_salon",
      attributes: ["walk_ins", "cert=b_corp"],
      country: "BR",
      price_band: "1-2",
      accepts: ["book", "pix"],
      requestable: "quote",
      door_type: ["mcp", "platform", "platform:shopify"],
      level: "orderable",
      has_inbox: false,
      source: ["found", "registered"],
      order: "nearest",
      near: { lat: -22.9, lng: -43.2 },
    });
    expect(input.door_type).toEqual(["mcp", "platform", "platform:shopify"]);
    for (const bad of [{ door_type: ["tel"] }, { price_band: "5" }, { country: "BRA" }, { requestable: "book" }]) {
      expect(searchBusinessesInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("protocol 0.2: register_business and update_business", () => {
  const register = {
    domain: "salon.example",
    name: "Salon Exemple",
    category: { primary: "hair_salon", alternates: ["beauty_salon"] },
    description: "Cuts, colour and styling.",
    where: {
      kind: ["storefront"],
      address: { locality: "Marseille", country: "FR" },
      geo: { lat: 43.29, lng: 5.37 },
      service_area: { radius_km: 20 },
    },
    languages: ["fr", "en"],
    doors: [
      { type: "mcp", url: "https://salon.example/mcp", kinds: ["ask", "book"], rate_limit: 10 },
      { type: "tel", url: "tel:+33491000000" },
    ],
    hours: { timezone: "Europe/Paris", weekly: { tue: [["09:00", "19:00"]] }, closures: [] },
    currencies: ["EUR"],
    price_band: 2,
    attributes: { walk_ins: true },
    pay: ["card", "apple_pay"],
    agree: true,
    locale: "fr",
    proof: { method: "dns", challenge_id: "0192c6a4-7b1e-7d3a-9f00-000000000001" },
  };

  it("takes a registration whole, refusals included, so a network answers each part it dropped", () => {
    expect(registerBusinessInputSchema.safeParse(register).success).toBe(true);
    expect(registerBusinessInputSchema.safeParse({ ...register, agree: false }).success).toBe(false);
    const { languages: _l, ...noLanguages } = register;
    expect(registerBusinessInputSchema.safeParse(noLanguages).success).toBe(false);
    expect(registerBusinessInputSchema.safeParse({ ...register, claim_token: "sdc_short" }).success).toBe(false);
    expect(registerBusinessInputSchema.safeParse({ ...register, claim_token: `sdc_${"A".repeat(43)}` }).success).toBe(
      true,
    );
  });

  it("answers with the challenge, its ways and what it dropped", () => {
    const answer = {
      status: "proof_needed",
      domain: "salon.example",
      claimed: false,
      dropped: [{ field: "doors[1]", reason: "refused_kind", detail: "tel is a human channel, never a door" }],
      challenge: {
        id: "0192c6a4-7b1e-7d3a-9f00-000000000001",
        token: "c2FsdC1hbmQtcGVwcGVy",
        expires_at: "2026-10-09T10:00:00Z",
        ways: [
          {
            method: "well_known",
            url: "https://salon.example/.well-known/surfingdog-claim",
            content: "surfingdog-claim=c2FsdC1hbmQtcGVwcGVy",
          },
          { method: "manifest", member: "claims", value: { "network.example.org": "c2FsdC1hbmQtcGVwcGVy" } },
          {
            method: "dns",
            name: "_surfingdog-claim.salon.example",
            type: "TXT",
            value: "surfingdog-claim=c2FsdC1hbmQtcGVwcGVy",
          },
          {
            method: "key",
            sign: "surfingdog-claim:v1:network.example.org:salon.example:0192c6a4-7b1e-7d3a-9f00-000000000001",
            algs: ["EdDSA", "ES256"],
          },
          { method: "code", note: "a code sent to an address at salon.example that you type" },
        ],
      },
    };
    expect(registerBusinessOutputSchema.safeParse(answer).success).toBe(true);
    const listed = {
      status: "listed",
      domain: "salon.example",
      claimed: true,
      proof: "domain",
      level: "bookable",
      listed: true,
      next_level: { level: "payable", how: "declare a door where an agent can also pay" },
      card: { ...foundCard, domain: "salon.example", source: "registered", claimed: true, proof: "domain" },
      claim_token: `sdc_${"b".repeat(43)}`,
      claim_token_expires_at: "2027-01-04T10:00:00Z",
    };
    expect(registerBusinessOutputSchema.safeParse(listed).success).toBe(true);
    expect(registerBusinessOutputSchema.safeParse({ ...listed, proof: "verified" }).success).toBe(false);
  });

  it("takes an update, a listing switched off, and an opt-out (without a proof it only stops the crawling)", () => {
    expect(
      updateBusinessInputSchema.safeParse({
        domain: "salon.example",
        claim_token: `sdc_${"A".repeat(43)}`,
        set: { description: "Cuts and colour.", price_band: 3 },
        doors: { add: [{ type: "a2a", url: "https://salon.example/a2a" }], remove: ["https://salon.example/mcp"] },
      }).success,
    ).toBe(true);
    expect(updateBusinessInputSchema.safeParse({ domain: "salon.example", listing: "off" }).success).toBe(true);
    expect(updateBusinessInputSchema.safeParse({ domain: "salon.example", opt_out: { scopes: ["all"] } }).success).toBe(
      true,
    );
    expect(updateBusinessInputSchema.safeParse({ domain: "salon.example", opt_out: { scopes: [] } }).success).toBe(
      false,
    );
    expect(updateBusinessOutputSchema.safeParse({ status: "removed", domain: "salon.example" }).success).toBe(true);
  });
});

describe("protocol 0.2: rules version 7 and the order", () => {
  it("version 7 keeps every member of version 6 and adds the order's rule, bands, reach and the rest", () => {
    for (const k of Object.keys(rankingV6Schema.shape)) expect(Object.keys(rankingV7Schema.shape), k).toContain(k);
    for (const k of Object.keys(rankingV6Schema.shape.order.shape))
      expect(Object.keys(rankingV7Schema.shape.order.shape), k).toContain(k);
    expect(Object.keys(rankingV7Schema.shape.order.shape)).toEqual(
      expect.arrayContaining([
        "rule",
        "bands",
        "reach",
        "within_reach",
        "newcomers",
        "one_place",
        "nearest",
        "found_tier",
        "filters",
        "sources",
      ]),
    );
  });

  it("reads a version newer than it knows by what every version has, and a known version only whole", () => {
    const v9 = {
      version: 9,
      status: "announced",
      effective_at: "2027-04-01T00:00:00Z",
      summary: "…",
      next: null,
      anything: { new: true },
    };
    const read = readRankingDocument(v9);
    expect(read.ok && !read.known).toBe(true);
    if (read.ok) expect(rulesOf(read.document)).toEqual({ inForce: 9, next: null });
    expect(readRankingDocument({ ...v9, version: 7 }).ok).toBe(false);
    expect(readRankingDocument({ ...v9, summary: undefined }).ok).toBe(false);
    expect(readRankingDocument({ version: 2, status: "retired", effective_at: "2026-09-22T00:00:00Z" }).ok).toBe(false);
  });

  it("orders by reach and level, then record, shuffle, members first; one place per domain", () => {
    const e = (ref: string, over: Partial<OrderEntry>): OrderEntry => ({
      kind: "b",
      ref,
      domain: `${ref}.example`,
      reach: 2,
      level: 3,
      ranked: false,
      score_int: 0,
      shuffle: "8000000000000000",
      ...over,
    });
    const order = orderV7([
      e("askable", { kind: "l", level: 3, shuffle: "0000000000000001" }),
      e("payable", { kind: "l", level: 5 }),
      e("bookable", { kind: "l", level: 4 }),
      e("readable", { reach: 3, level: 2 }),
      e("answers", { reach: 1, level: 3, shuffle: "ffffffffffffffff" }),
      e("ranked-low", { reach: 1, ranked: true, score_int: 4100 }),
      e("ranked-high", { reach: 1, ranked: true, score_int: 9000 }),
      e("tie-l", { kind: "l", reach: 1, shuffle: "0000000000000000" }),
      e("tie-b", { kind: "b", reach: 1, shuffle: "0000000000000000" }),
      e("found-on-member", { kind: "l", reach: 2, level: 5, domain: "member.example" }),
      e("member", { reach: 3, level: 2, domain: "member.example" }),
    ]).map((x) => x.ref);
    expect(order).toEqual([
      "ranked-high",
      "ranked-low",
      "tie-b",
      "tie-l",
      "answers",
      "payable",
      "bookable",
      "askable",
      "member",
      "readable",
    ]);
  });

  it("gives every 5th place of the whole order to the next newcomer, never twice; a filter moves nobody", () => {
    const order = "abcdefghijkl".split("").map((ref) => ({ ref, newcomer: ["c", "j", "k"].includes(ref) }));
    const placed = placeNewcomers(order);
    // c took its own place early (3), so place 5 goes to the next newcomer, j.
    expect(placed.map((p) => `${p.entry.ref}${p.slot ? "*" : ""}`).join(" ")).toBe("a b c d j* e f g h k* i l");
    // Leaving b out keeps everyone else in that order: j stays before e (merged after filtering, it would not).
    expect(
      placed
        .filter((p) => p.entry.ref !== "b")
        .map((p) => p.entry.ref)
        .join(" "),
    ).toBe("a c d j e f g h k i l");
    // No newcomer left: the order goes on.
    const one = placeNewcomers(order.map((e) => ({ ...e, newcomer: e.ref === "c" })));
    expect(one.map((p) => p.entry.ref).join("")).toBe("abcdefghijkl");
  });
});

describe("capabilities and the agentic score: vocab/capabilities.json, score-rules-v2.json, score.json", () => {
  const rules = scoreRulesSchema.parse(scoreRulesV2);
  const rulesV1 = scoreRulesSchema.parse(scoreRulesV1);

  it("the vocabulary: 19 capabilities in order, the five lead ones among them", () => {
    const v = capabilitiesVocabSchema.parse(capabilityVocabulary);
    expect(v.capabilities.map((c) => c.id)).toEqual([...CAPABILITY_IDS]);
    expect(v.lead).toEqual([...LEAD_CAPABILITIES]);
    expect(v.produced).toEqual(["declared"]);
    // The rules carry the same vocabulary, each capability with its group.
    expect(rules.capabilities.map(({ group: _, ...c }) => c)).toEqual(v.capabilities);
  });

  it("the rules: weights sum to 100, every capability in one group, the formula word for word", () => {
    expect(rules.version).toBe(2);
    expect(rulesV1.version).toBe(1);
    expect(rulesV1.formula).toBe(SCORE_FORMULA_V1);
    // Version 2 keeps version 1's groups and weights, and adds sign up to the core group (it adds no weight).
    expect(rules.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== "signup") }))).toEqual(
      rulesV1.groups,
    );
    expect(rules.groups.find((g) => g.id === "core")?.members).toEqual(["message", "book", "order", "signup", "pay"]);
    expect(rules.capabilities.filter((c) => c.id !== "signup")).toEqual(rulesV1.capabilities);
    expect(rules.capabilities.map((c) => c.id)).toEqual([...CAPABILITY_IDS]);
    expect(rules.name).toBe("Agentic score");
    expect(rules.groups.reduce((n, g) => n + g.weight, 0)).toBe(100);
    const members = rules.groups.flatMap((g) => g.members);
    expect([...members].sort()).toEqual([...CAPABILITY_IDS].sort());
    for (const c of rules.capabilities) {
      expect(rules.groups.find((g) => g.members.includes(c.id))?.id, c.id).toBe(c.group);
    }
    expect(rules.formula).toBe(SCORE_FORMULA_V2);
    expect(rules.profiles.map((p) => p.id)).toEqual([
      "appointments",
      "classes",
      "food",
      "trades",
      "shop",
      "stay",
      "memberships",
      "venues",
      "general",
    ]);
    // A business of a kind not known: book, order or sign up is one capability of the core group, never not applicable.
    const general = rules.profiles.find((p) => p.id === "general");
    expect(general?.either).toEqual([["book", "order", "signup"]]);
    expect(general?.applicable).toEqual(expect.arrayContaining(["message", "book", "order", "signup", "pay"]));
    // Sign up where it is natural: with order for a gym, with book for a school; never for a salon.
    expect(rules.profiles.find((p) => p.id === "memberships")?.either).toEqual([["order", "signup"]]);
    expect(rules.profiles.find((p) => p.id === "classes")?.either).toEqual([["book", "signup"]]);
    expect(rules.profiles.find((p) => p.id === "classes")?.groups).toEqual(["education", "childcare"]);
    expect(rules.profiles.find((p) => p.id === "appointments")?.applicable).not.toContain("signup");
    // A venue books (tickets, tables, entries).
    expect(rules.profiles.find((p) => p.id === "venues")?.applicable).toContain("book");
    // The changelog says what changed in version 2, on what day, and why; and its amendment of 8 October 2026, last.
    const v2 = rules.changelog.find((c) => c.version === 2 && c.published !== undefined);
    expect(v2).toMatchObject({ version: 2, published: "2026-10-07" });
    expect(v2?.summary).toMatch(/book and order count together as one capability/);
    expect(v2?.summary).toMatch(/Sign up is a capability of its own/);
    const last = rules.changelog.at(-1);
    expect(last).toMatchObject({ version: 2, amended: "2026-10-08" });
    expect(last?.published).toBeUndefined();
    expect(last?.summary).toMatch(/what counts now follows what a business lets an agent do/);
    expect(last?.summary).toMatch(/Why: /);
    expect(last?.summary).toMatch(/no group's weight and no grade changed/);
    for (const c of [v2, last]) expect(c?.summary).not.toMatch(/\b(first|only)\b/i);
    // What follows: an order brings change, cancel, track and receipt, and a return when the business sells goods; a
    // booking change, cancel and availability; a sign-up change, cancel and the membership. A shop sells goods by its
    // kind, a restaurant never does. Version 1 has none of it.
    expect(rules.follows).toEqual([
      { if: "order", adds: ["change", "cancel", "track", "receipt"] },
      { if: "order", adds: ["return"], goods: true },
      { if: "book", adds: ["change", "cancel", "availability"] },
      { if: "signup", adds: ["change", "cancel", "subscription"] },
    ]);
    expect(rules.goods).toMatchObject({ profiles: ["shop"], never: ["food"] });
    expect(rulesV1.follows).toBeUndefined();
    expect(rulesV1.goods).toBeUndefined();
    // A category group belongs to one profile at most.
    const groups = rules.profiles.flatMap((p) => p.groups);
    expect(new Set(groups).size).toBe(groups.length);
    for (const g of groups) expect(vocabulary.categories.map((c) => c.slug)).toContain(g);
    // Every kind of business is scored where its own actions apply, never left to the general
    // profile by default: clinics, dentists, therapists, lawyers, finance, property, recruitment and
    // accountants book; bars are food; childcare is classes; transport books with places to stay.
    const profileOf = (g: string) => rules.profiles.find((p) => p.groups.includes(g))?.id;
    for (const c of vocabulary.categories) {
      expect(profileOf(c.slug), c.slug).toBeDefined();
      expect(profileOf(c.slug) === "general", c.slug).toBe(c.slug === "software-ai");
    }
    for (const g of ["health", "dental", "therapy", "legal", "finance", "property", "recruitment", "accounting"]) {
      expect(profileOf(g), g).toBe("appointments");
    }
    expect([profileOf("bar"), profileOf("childcare"), profileOf("transport")]).toEqual(["food", "classes", "stay"]);
    // Every weighted capability has a fix; nothing unscored does.
    for (const g of rules.groups) {
      for (const c of g.members) expect(rules.fixes[c] !== undefined, c).toBe(g.weight > 0);
    }
  });

  it("the rules' words: the name, never a certification, no claims of being first or only", () => {
    const text = JSON.stringify(scoreRulesV2);
    expect(text).not.toMatch(/Agent ?Readiness|AgentReady/i);
    const copy = [
      rules.summary,
      rules.not_certification,
      rules.named,
      rules.directory,
      rules.goods?.summary ?? "",
      ...Object.values(rules.fixes).flatMap((f) => [
        f?.title ?? "",
        f?.how ?? "",
        ...Object.values(f?.by_profile ?? {}).flatMap((b) => [b?.title ?? "", b?.how ?? ""]),
      ]),
    ].join("\n");
    expect(copy).not.toMatch(/\b(first|only|verified|certified|people free)\b/i);
    expect(rules.not_certification).toMatch(/not a certification/);
    expect(rules.directory).toMatch(/never changes/);
    // Who is named: agent-ready, and never a site that tells AI systems no; a claim or a badge alone names nobody.
    expect(rules.named).toBe(
      "A business is named on leaderboards, and its result page may be indexed, when it is agent-ready (askable or above); " +
        "others are counted, not named. If your site tells AI systems not to use or train on its content, we don't name you " +
        "or list you publicly.",
    );
  });

  it("re-derives every case of score.json (version 2) and score-v1.json (version 1): score, grade, numerator, possible weight and fixes in order", () => {
    for (const [vectors, r] of [
      [scoreVectors, rules],
      [scoreVectorsV1, rulesV1],
    ] as const) {
      expect(vectors.rules_version).toBe(r.version);
      expect(vectors.cases.length).toBeGreaterThanOrEqual(25);
      for (const c of vectors.cases) {
        const states = c.states as Record<CapabilityId, CapabilityState>;
        const goods = (c as { goods?: boolean }).goods ?? false;
        const profile = r.profiles.find((p) => p.id === c.profile);
        expect(profile, c.name).toBeDefined();
        // A state is given for every capability of that version, and "na" exactly where it does not apply: not its
        // profile's, and not brought by what an agent can do there (the rules' follows, version 2 as amended).
        const applies = applicableOf(c.profile as "appointments", states, r, goods);
        for (const { id } of r.capabilities) {
          expect(states[id] === "na", `${c.name} ${id}`).toBe(!applies.has(id));
        }
        const got = scoreOf(c.profile as "appointments", states, r, goods);
        expect({ score: got.score, grade: got.grade, n: got.n, possible: got.possible }, c.name).toEqual({
          score: c.expect.score,
          grade: c.expect.grade,
          n: c.expect.n,
          possible: c.expect.possible,
        });
        expect(fixesOf(c.profile as "appointments", states, r, goods), c.name).toEqual(c.expect.fixes);
      }
    }
  });

  it("version 2: a general business that takes messages and nothing else falls to the low 40s; book, order and sign up are one", () => {
    const by = new Map(scoreVectors.cases.map((c) => [c.name, c]));
    const states = (name: string) => by.get(name)?.states as Record<CapabilityId, CapabilityState>;
    expect(by.get("general-message-only")?.expect).toMatchObject({ score: 42, grade: "C" });
    // Booking and paying with nothing after it: changing, cancelling and availability count since 8 October 2026.
    expect(by.get("general-book-and-pay")?.expect).toMatchObject({ score: 39, grade: "D" });
    expect(by.get("general-message-book-pay")?.expect).toMatchObject({ score: 53, grade: "C" });
    expect(by.get("venue-jazz-club")?.expect).toMatchObject({ score: 34, grade: "D" });
    // Under version 1 (book and order not applicable) the first two scored 55 alike.
    const v1 = (name: string) => {
      const s = { ...states(name), book: "na", order: "na", signup: "na" } as Record<CapabilityId, CapabilityState>;
      return scoreOf("general", s, rulesV1).score;
    };
    expect([v1("general-message-only"), v1("general-book-and-pay"), v1("general-message-book-pay")]).toEqual([
      55, 55, 91,
    ]);
    // Book or order: either one meets the set, and both count no more than one. What follows each differs since 8
    // October 2026, so the slot is compared over the profile's own capabilities (a set given as such: no follows).
    const own = (p: "general" | "memberships" | "classes") => {
      const x = rules.profiles.find((q) => q.id === p);
      return { applicable: x?.applicable ?? [], either: x?.either ?? [] };
    };
    const slot = (p: "general" | "memberships" | "classes", x: Partial<Record<CapabilityId, CapabilityState>>) =>
      scoreOf(own(p), x, rules);
    const g = (x: Partial<Record<CapabilityId, CapabilityState>>) => slot("general", x).score;
    expect(g({ book: "yes" })).toBe(g({ order: "yes" }));
    expect(g({ book: "yes", order: "yes" })).toBe(g({ book: "yes" }));
    expect(g({ book: "partial", order: "yes" })).toBe(g({ order: "yes" }));
    expect(capabilityWeightOf("general", "book", rules)).toBe(13.3);
    expect(capabilityWeightOf("general", "order", rules)).toBe(13.3);
    // Book or order is one fix, under book, and none once either is met; a venue counts a ticket order the same way.
    const fixed = (p: "general" | "venues", x: Partial<Record<CapabilityId, CapabilityState>>) =>
      fixesOf(p, x, rules).map((f) => f.capability);
    expect(fixed("general", { message: "yes" })).toContain("book");
    expect(fixed("general", { message: "yes" })).not.toContain("order");
    expect(fixed("general", { order: "partial" })).toContain("book");
    expect(fixed("general", { order: "yes" })).not.toContain("book");
    expect(fixed("venues", { order: "yes" })).not.toContain("book");
    expect(rules.profiles.find((p) => p.id === "venues")?.either).toEqual([["book", "order", "signup"]]);
    // Sign up counts with book and order: alone it meets the set, beside a yes it adds nothing; a gym's
    // sign-up meets its order slot and a school's its book slot.
    expect(g({ signup: "yes" })).toBe(g({ book: "yes" }));
    expect(g({ signup: "yes", order: "yes" })).toBe(g({ order: "yes" }));
    expect(fixed("general", { signup: "yes" })).not.toContain("book");
    expect(slot("memberships", { signup: "yes" })).toEqual(slot("memberships", { order: "yes" }));
    expect(slot("classes", { signup: "yes" })).toEqual(slot("classes", { book: "yes" }));
    expect(by.get("general-message-signup")?.expect).toMatchObject({ score: 43, grade: "C" });
    expect(by.get("gym-signup-book")?.expect).toMatchObject({ score: 51, grade: "C" });
    expect(by.get("school-enrol")?.expect).toMatchObject({ score: 49, grade: "C" });
  });

  it("version 2 as amended on 8 October 2026: what counts follows what an agent can do, so a full score needs a full interaction", () => {
    const by = new Map(scoreVectors.cases.map((c) => [c.name, c]));
    // Ordering and paying with nothing after it is no longer 100; with changing, cancelling, tracking and a receipt it
    // is; selling goods, a return counts too.
    expect(by.get("general-order-no-after")?.expect).toMatchObject({ score: 58, grade: "C", possible: 95 });
    expect(by.get("general-order-full")?.expect).toMatchObject({ score: 100, grade: "A", fixes: [] });
    expect(by.get("general-order-full-goods")).toMatchObject({
      goods: true,
      expect: { score: 92, grade: "A", fixes: [{ capability: "return", points: 8 }] },
    });
    // A salon that books and cannot change or cancel is clearly below one that can.
    expect(by.get("salon-books-no-change")?.expect).toMatchObject({ score: 68, grade: "B" });
    expect(by.get("salon-books-changes")?.expect).toMatchObject({ score: 100, grade: "A" });
    // What an order, a booking or a sign-up brings, yes or partly; no brings nothing, nor does a doing capability the
    // profile does not count (a salon's order).
    const brings = (
      p: "general" | "food" | "appointments" | "trades",
      x: Partial<Record<CapabilityId, CapabilityState>>,
      goods = false,
    ) => {
      const own = rules.profiles.find((q) => q.id === p)?.applicable ?? [];
      return [...applicableOf(p, x, rules, goods)].filter((c) => !own.includes(c)).sort();
    };
    expect(brings("general", { order: "no" }, true)).toEqual([]);
    expect(brings("general", { order: "yes" })).toEqual(["cancel", "change", "receipt", "track"]);
    expect(brings("general", { order: "partial" }, true)).toEqual(["cancel", "change", "receipt", "return", "track"]);
    expect(brings("general", { book: "yes" })).toEqual(["availability", "cancel", "change"]);
    expect(brings("general", { signup: "partial" })).toEqual(["cancel", "change", "subscription"]);
    expect(brings("food", { order: "yes" }, true)).toEqual(["receipt", "track"]);
    expect(brings("appointments", { order: "yes" }, true)).toEqual([]);
    expect(brings("trades", { book: "yes" })).toEqual(["availability"]);
    expect([
      sellsGoods("shop", false, rules),
      sellsGoods("food", true, rules),
      sellsGoods("venues", true, rules),
    ]).toEqual([true, false, true]);
    // A business where an agent can do none of book, order and sign up scores as before: what follows needs one.
    const general = rules.profiles.find((q) => q.id === "general");
    const plain = { message: "yes", find: "yes", catalogue: "yes" } as const;
    expect(scoreOf("general", plain, rules, true)).toEqual(
      scoreOf({ applicable: general?.applicable ?? [], either: general?.either ?? [] }, plain, rules),
    );
    // The fix that lets an agent book brings changing, cancelling and availability with it, counted in its points.
    expect(by.get("general-message-only")?.expect.fixes[0]).toEqual({
      capability: "book",
      points: 39,
      with: ["availability", "change", "cancel"],
    });
    // Displayed weights follow what applies: a cancel brought by an order shares the after group's 30 by three.
    expect(capabilityWeightOf("general", "cancel", rules)).toBe(0);
    expect(capabilityWeightOf("general", "cancel", rules, { order: "yes" })).toBe(10);
    expect(capabilityWeightOf("general", "return", rules, { order: "yes" }, true)).toBe(7.5);
  });

  it("the worked examples: a salon 51 C, a restaurant 63 B, a plumber 33 D, a shop 53 C, the homepage's 72 B", () => {
    const by = new Map(scoreVectors.cases.map((c) => [c.name, c.expect]));
    expect(by.get("hair-salon")).toMatchObject({ score: 51, grade: "C", n: 5800, possible: 95 });
    // A restaurant that takes orders is scored on tracking them and a receipt too (74 before 8 October 2026).
    expect(by.get("restaurant")).toMatchObject({ score: 63, grade: "B", n: 7200, possible: 95 });
    expect(by.get("trades-plumber")).toMatchObject({ score: 33, grade: "D", n: 3000, possible: 75 });
    expect(by.get("shop")).toMatchObject({ score: 53, grade: "C", n: 6000, possible: 95 });
    expect(by.get("homepage-example")).toEqual({
      score: 72,
      grade: "B",
      n: 8200,
      possible: 95,
      fixes: [
        { capability: "change", points: 16 },
        { capability: "pay", points: 7 },
        { capability: "policies", points: 5 },
      ],
    });
    expect(by.get("trades-plumber")?.fixes.map((f) => `${f.capability}+${f.points}`)).toEqual([
      "book+24",
      "change+14",
      "cancel+14",
      "receipt+14",
      "pay+9",
    ]);
  });

  it("leaves what does not apply out of the denominator, down to a single group", () => {
    // Only find applies: possible is find's 5, and find alone decides.
    const only = { applicable: ["find", "feedback"] as CapabilityId[] };
    expect(scoreOf(only, { find: "yes" }, rules)).toEqual({ score: 100, grade: "A", n: 600, possible: 5 });
    expect(scoreOf(only, { find: "partial" }, rules)).toEqual({ score: 50, grade: "C", n: 300, possible: 5 });
    expect(scoreOf(only, { feedback: "yes" }, rules).score).toBe(0);
    expect(fixesOf(only, {}, rules)).toEqual([{ capability: "find", points: 100 }]);
    // Nothing scored applies: 0, and no fix.
    expect(scoreOf({ applicable: ["feedback"] }, { feedback: "yes" }, rules)).toEqual({
      score: 0,
      grade: "E",
      n: 0,
      possible: 0,
    });
    // A state for a capability that does not apply changes nothing.
    expect(scoreOf("trades", { find: "yes", catalogue: "yes" }, rules).score).toBe(0);
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map((n) => gradeOf(n, rules)).join("")).toBe("EEDDCCBBAA");
    expect(capabilityWeightOf("appointments", "book", rules)).toBe(13.3);
    expect(capabilityWeightOf("shop", "change", rules)).toBe(7.5);
    expect(capabilityWeightOf("appointments", "feedback", rules)).toBe(0);
    expect(capabilityWeightOf("trades", "find", rules)).toBe(0);
  });

  it("maps names to capabilities by the registry's rules, as the network does", () => {
    const table: [string, string[]][] = [
      ["create_booking", ["book"]],
      ["get_booking", []],
      ["cancel_booking", ["cancel"]],
      ["get_cancellation_policy", ["policies"]],
      ["reschedule", ["change"]],
      ["get_order_status", ["track"]],
      ["update_cart", ["order"]],
      ["search_shop_catalog", ["catalogue"]],
      ["request_return", ["return"]],
      ["pay_invoice", ["pay", "receipt"]],
      ["sendMessage", ["message"]],
      ["check_availability", ["availability"]],
      ["request_quote", ["negotiate"]],
      // A name that only reads acts on nothing; a word meets one list of a rule.
      ["get_class_schedule", []],
      ["get_offers", []],
      ["get_purchase_history", []],
      ["get_refund_status", []],
      ["get_exchange_rate", []],
      ["get_delivery_fee", []],
      ["get_invoice", ["receipt"]],
      ["book", ["book"]],
      ["Book a table", ["book"]],
    ];
    for (const [name, caps] of table) expect(capsOfName(registryRules, name), name).toEqual(caps);
    // Sign up: a name that signs a person up, never one that logs in.
    for (const [name, caps] of [
      ["sign_up", ["signup"]],
      ["signUp", ["signup"]],
      ["register", ["signup"]],
      ["create_account", ["signup"]],
      ["enrol_in_course", ["signup"]],
      ["membership_signup", ["signup"]],
      ["subscribe_newsletter", ["signup", "subscription"]],
      ["JoinAction", ["signup"]],
      ["login", []],
      ["sign_in", []],
      ["register_or_login", []],
      ["get_signup_form", []],
      ["register_webhook", []],
      ["join_waitlist", ["waitlist"]],
    ] as const) {
      expect(capsOfName(registryRules, name), name).toEqual(caps);
    }
    expect(capsOfOperation(registryRules, "POST /accounts createAccount")).toEqual(["signup"]);
    expect(capsOfName(registryRules, "create_booking", undefined, true)).toEqual([]);
    expect(capsOfOperation(registryRules, "POST /orders/search")).toEqual([]);
    expect(capsOfOperation(registryRules, "DELETE /cart/items/{id}")).toEqual([]);
    expect(capsOfOperation(registryRules, "GET /bookings/{id}")).toEqual([]);
    expect(capsOfOperation(registryRules, "DELETE /bookings/{id}")).toEqual(["cancel"]);
    expect(capsOfOperation(registryRules, "POST /orders createOrder")).toEqual(["order"]);
    expect(capsOfOperation(registryRules, "PATCH /bookings/{id}")).toEqual(["change"]);
    expect(capsOfName(registryRules, "bookings", "POST")).toEqual(["book"]);
  });

  it("a check's result, a leaderboard and an AI catalog hold to their schemas", () => {
    const at = "2026-10-07T09:00:00Z";
    const site = "https://surfingdog.ai";
    const done = {
      domain: "salon.example",
      site: "https://salon.example/",
      url: `${site}/b/salon.example`,
      state: "done",
      checked_at: at,
      scored_at: at,
      rules: { version: 1, url: `${site}/v1/score-rules?version=1` },
      agentic_score: 72,
      grade: "B",
      profile: {
        id: "appointments",
        label: "Appointments (salons, wellness, classes, tours)",
        from: "category",
        category: { group: "hair-beauty", id: "hair_salon", label: "Hair salon" },
      },
      level: "askable",
      answers: [
        {
          capability: "message",
          answer: "yes",
          door: { type: "a2a", url: "https://salon.example/.well-known/agent-card.json" },
          how: "A2A skill send_message",
          checked_at: at,
        },
        { capability: "order", answer: "not_applicable" },
      ],
      capabilities: [
        {
          id: "book",
          group: "core",
          state: "yes",
          evidence: "declared",
          basis: "tool_name",
          via: "create_booking",
          door: { type: "mcp", url: "https://salon.example/mcp" },
          source_url: "https://salon.example/.well-known/mcp/server-card.json",
          checked_at: at,
          weight: 13.3,
          points: 13.3,
          experimental: false,
        },
        { id: "order", group: "core", state: "na", evidence: null, weight: 0, points: 0 },
      ],
      fixes: [{ capability: "change", points: 16, title: "Let agents change a booking or an order", how: "…" }],
      web_person_message: "Hello,",
      rank: {
        text: "#4 of 61 checked in Hair & beauty · Porto, PT",
        scope: { group: "hair-beauty", country: "PT", place: "Porto" },
        position: 4,
        of: 61,
        overall: { position: 120, of: 5412 },
      },
      indexable: true,
      not_certification: "This is not a certification.",
      badge: { svg: `${site}/badge/salon.example.svg`, snippet: "<a></a>" },
      owner: { claim: `${site}/bot#claim`, hide: "update_business", opt_out: `${site}/bot#stop` },
    };
    expect(checkResultSchema.parse(done).agentic_score).toBe(72);
    expect(checkBusinessOutputSchema.parse(done).state).toBe("done");
    const queued = {
      domain: "salon.example",
      url: `${site}/b/salon.example`,
      state: "queued",
      queue: { position: 3, budget: "open", retry_after_s: 15 },
      indexable: false,
    };
    expect(checkResultSchema.safeParse(queued).success).toBe(true);
    expect(checkResultSchema.safeParse({ ...queued, state: "pending" }).success).toBe(false);
    expect(checkResultSchema.safeParse({ ...done, agentic_score: 101 }).success).toBe(false);
    expect(checkBusinessInputSchema.safeParse({ url: "salon.example" }).success).toBe(true);
    expect(checkBusinessInputSchema.safeParse({ url: "" }).success).toBe(false);
    expect(checkBusinessInputSchema.safeParse({ url: "x".repeat(2049) }).success).toBe(false);
    expect(updateBusinessInputSchema.safeParse({ domain: "salon.example", score_page: "hidden" }).success).toBe(true);
    expect(updateBusinessInputSchema.safeParse({ domain: "salon.example", score_page: "gone" }).success).toBe(false);
    expect(
      updateBusinessOutputSchema.parse({ status: "listed", domain: "salon.example", score_page: "shown" }),
    ).toMatchObject({
      score_page: "shown",
    });
    expect(
      leaderboardSchema.safeParse({
        scope: { category: "hair-beauty", country: "PT" },
        rules: { version: 2, url: `${site}/v1/score-rules?version=2` },
        order:
          "whether an agent can book, order or sign up here (yes, then partly, then no or not applicable), then agentic score, then the most recent check, then domain",
        order_by: [...LEADERBOARD_ORDER_BY],
        not_search_order:
          "This list puts the businesses where an agent can book, order or sign up above the rest, then orders them by agentic score. It is not the directory's search order.",
        total: 61,
        named_total: 21,
        unnamed: 40,
        page: 1,
        next_page: null,
        named: [
          {
            position: 1,
            domain: "salon.example",
            name: "A salon",
            can_book_order_or_sign_up: "yes",
            score: 72,
            grade: "B",
            answers: { message: "yes", order: "not_applicable", signup: "not_applicable" },
            checked_at: at,
            result_url: `${site}/b/salon.example`,
          },
        ],
      }).success,
    ).toBe(true);
    // A home-page list: the agent-ready businesses that can sign people up, software companies too.
    const list = {
      scope: { can: "signup" },
      rules: { version: 2, url: `${site}/v1/score-rules?version=2` },
      order: "…",
      order_by: [...LEADERBOARD_ORDER_BY],
      not_search_order: "…",
      total: 3,
      named_total: 2,
      unnamed: 1,
      page: 1,
      next_page: null,
      named: [],
    };
    expect(leaderboardSchema.safeParse(list).success).toBe(true);
    expect(leaderboardSchema.safeParse({ ...list, scope: { can: "fly" } }).success).toBe(false);
    expect(leaderboardSchema.safeParse({ ...list, order_by: undefined }).success).toBe(false);
    expect(leaderboardSchema.safeParse({ ...list, named_total: undefined }).success).toBe(false);
    expect(LEADERBOARD_CAN).toContain("signup");
    const catalog = {
      specVersion: "1.0",
      host: { displayName: "A network", identifier: "did:web:network.example" },
      entries: [
        {
          identifier: "urn:air:network.example:mcp:directory",
          displayName: "Directory (MCP)",
          type: "application/mcp-server-card+json",
          url: "https://network.example/.well-known/mcp/server-card.json",
          tags: ["directory"],
        },
      ],
    };
    expect(aiCatalogSchema.parse(catalog).entries[0]).toMatchObject({ tags: ["directory"] });
    expect(aiCatalogSchema.safeParse({ ...catalog, entries: [{ identifier: "x" }] }).success).toBe(false);
  });
});
