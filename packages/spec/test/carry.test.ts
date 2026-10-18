import { describe, expect, it } from "vitest";
import {
  askBusinessInputSchema,
  carryOutputSchema,
  manifestSchema,
  pingCarriedSchema,
  requestBookingInputSchema,
  requestQuoteInputSchema,
  signedPingResponseSchema,
} from "../src/index";

/**
 * Carried requests (ADR-020, network.md §4.16): what the three tools take and answer, the manifest's
 * switch, and the counts a signed ping's answer gives the business alone.
 */
const contact = { email: "ana@example.com", name: "Ana" };

describe("ask_business, request_quote, request_booking", () => {
  it("take the person's email, with consent, and never a phone number", () => {
    const ok = { domain: "bikes.example", message: "Open on Saturday?", contact, consent: true };
    expect(askBusinessInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, consent: false },
      { ...ok, consent: undefined },
      { ...ok, contact: { ...contact, phone: "+351 912 345 678" } },
      { ...ok, contact: { email: "not an address" } },
      { ...ok, contact: { email: "Ana <ana@example.com>" } },
      { ...ok, message: "" },
      { ...ok, message: "x".repeat(4001) },
    ]) {
      expect(askBusinessInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      requestQuoteInputSchema.safeParse({
        domain: "bikes.example",
        what: "Wheel rebuild",
        details: "29 inch, 32 spokes.",
        needed_by: "2026-11-20",
        contact,
        consent: true,
      }).success,
    ).toBe(true);
    // Free times need nothing about the person; a time asked for is sent with their contact.
    expect(requestBookingInputSchema.safeParse({ domain: "bikes.example", service: "Puncture repair" }).success).toBe(
      true,
    );
    expect(
      requestBookingInputSchema.safeParse({
        domain: "bikes.example",
        service: "Puncture repair",
        start: "2026-10-19T09:00:00Z",
        terms_sha: "r1obXx7TLmoIfaNhWirkVPmbqjUEV37oQcgR2SJj5OQ",
        contact,
        consent: true,
      }).success,
    ).toBe(true);
    expect(
      requestBookingInputSchema.safeParse({ domain: "bikes.example", service: "x", terms_sha: "short" }).success,
    ).toBe(false);
  });

  it("answer with the inbox's own item and words, and what the network keeps", () => {
    const delivered = {
      outcome: "delivered",
      delivered: true,
      business: "bikes.example",
      inbox: "https://inbox.bikes.example",
      item: { id: "01M575GSMKERAZPMK2WS5P66TP", type: "message", state: "open" },
      status_url: "https://inbox.bikes.example/v1/items/01M575GSMKERAZPMK2WS5P66TP",
      access_token: "nUMhGtbg1BUN3oOB4JA2AK4akp4EnWYw",
      replayed: false,
      answer: "Your message is with us; we will reply soon.",
      kept: "Only a record that it was delivered.",
    };
    expect(carryOutputSchema.safeParse(delivered).success).toBe(true);
    expect(carryOutputSchema.safeParse({ ...delivered, outcome: "stored" }).success).toBe(false);
    expect(
      carryOutputSchema.safeParse({ outcome: "switched_off", delivered: false, business: "b.example" }).success,
    ).toBe(false);
  });
});

describe("the manifest's switch, and the business's counts", () => {
  it("says carried_requests only to refuse them; saying nothing is yes", () => {
    const base = {
      spec: "surfingdog-inbox/0",
      instance: "https://inbox.example.com",
      item_types: ["message"],
      protocols: { rest: "https://inbox.example.com/v1" },
      agent_policy: { tiers: ["anonymous"] },
      receipt_keys: { keys: [] },
      review_services: [],
    };
    expect(manifestSchema.parse(base).carried_requests).toBeUndefined();
    expect(manifestSchema.parse({ ...base, carried_requests: { accepted: false } }).carried_requests).toEqual({
      accepted: false,
    });
  });

  it("are counts only, in a signed ping's answer", () => {
    const carried = { since: "2026-09-18T10:00:00Z", delivered: 3, confirm: 1, not_delivered: { switched_off: 2 } };
    expect(pingCarriedSchema.parse(carried)).toEqual(carried);
    const answer = signedPingResponseSchema.parse({
      ok: true,
      rules: { version: 9, effective_at: "2026-10-13T21:14:00Z" },
      next_rules: null,
      reports: [],
      contests: [],
      carried,
    });
    expect(answer.carried?.delivered).toBe(3);
  });
});
