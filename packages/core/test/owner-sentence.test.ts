import { describe, expect, it } from "vitest";
import type { Item } from "../src/domain/types";
import { describe as ownerSentence } from "../src/write/views";

/**
 * The business's own sentence for an item, as its owner reads it (the owner's MCP, its emails). Run
 * through Gemini on 1 November 2026, the owner's list_items said a booking the customer cancelled was
 * "cancelled by you" and one waiting on the customer's answer told the owner to "accept or decline it":
 * the customer's words, said to the owner. Here the customer is the customer.
 */
const booking = (state: string): Item =>
  ({
    id: "01M6CEC6QDNQEP59Q3Y76PKNPV",
    type: "booking",
    state,
    subject: "Full service",
    channel: "mcp_public",
    payload: { startTime: "2026-11-07T09:00:00Z" },
  }) as unknown as Item;

describe("the owner's sentence for an item", () => {
  it("says of the customer what the customer did or is to do, never to the owner as 'you'", () => {
    expect(ownerSentence(booking("cancelled_by_customer"))).toContain("is cancelled by the customer.");
    expect(ownerSentence(booking("proposed"))).toContain(
      "is waiting for the customer's answer to the other time the business proposed.",
    );
    expect(ownerSentence(booking("needs_info"))).toContain("is waiting for more details from the customer.");
    expect(ownerSentence({ ...booking("quoted"), type: "quote_request" } as Item)).toContain(
      "is quoted, waiting for the customer's answer.",
    );
    for (const state of ["cancelled_by_customer", "proposed", "needs_info", "quoted"]) {
      expect(ownerSentence(booking(state)), state).not.toMatch(/\byou\b|accept or decline/);
    }
  });
});
