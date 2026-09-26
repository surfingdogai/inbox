import {
  AMENDMENT_LIMITS,
  businessCardSchema,
  businessesResponseSchema,
  categoriesResponseSchema,
  categoryVocabularySchema,
  getBusinessOutputSchema,
  isRetriedPublication,
  JSON_SCHEMAS,
  jsonSchemaOf,
  listCategoriesOutputSchema,
  listingSchema,
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
  receiptAckPayloadV2Schema,
  receiptPayloadV2Schema,
  reportRequestSchema,
  rulesOf,
  searchBusinessesInputSchema,
  searchBusinessesOutputSchema,
} from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import mcpVectors from "../../spec/vectors/mcp.json";
import ordering from "../../spec/vectors/ordering.json";
import passes from "../../spec/vectors/passes.json";
import profileVectors from "../../spec/vectors/profile.json";
import receiptsV2 from "../../spec/vectors/receipts-v2.json";
import receiptsV6 from "../../spec/vectors/receipts-v6.json";
import signatures from "../../spec/vectors/signatures.json";
import vocabulary from "../../spec/vocab/categories.json";
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
