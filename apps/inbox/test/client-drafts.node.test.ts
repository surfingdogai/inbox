import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orderLinesText } from "../../../packages/core/src/customer/describe";
import { type DraftView, draftDetails, notSentWords, termsLine } from "../client/src/lib/drafts";
import { formatDateTime } from "../client/src/lib/format";

/**
 * A draft's card (the owner app's and the phone's, ADR-018 §4): "Send as it is" sends it in one tap, so
 * the card says every term the customer would read. A stay's draft from the rates and an order change
 * the owner's AI drafted, as the inbox keeps them.
 */
const TZ = "Europe/Lisbon";

/**
 * A stay's draft as one kept before it carried its rate plan, policy, guarantee and inclusions: the
 * quote's own lines and schedule (what a draft made now holds: client-drafts-real.node.test.ts).
 */
const stay = {
  totalPrice: { value: 40000, currency: "EUR" },
  lines: [
    { type: "subtotal", label: "Double room, 3 nights", amount: 36000, collected: "with_booking" },
    { type: "tax", label: "City tax, €2.00 per person per night", amount: 4000, collected: "at_property" },
  ],
  schedule: [
    { id: "deposit", type: "immediate", amount: { value: 12000, currency: "EUR" }, label: "Deposit" },
    { id: "at_property", type: "at_property", amount: { value: 28000, currency: "EUR" }, label: "At the property" },
  ],
  validThrough: "2026-11-20T18:00:00Z",
} as unknown as DraftView["terms"];

/** An order change: lines with their prices each, one with a menu choice. */
const orderLines = [
  { name: "Bread", quantity: 2, price: { value: 200, currency: "EUR" } },
  {
    name: "Cake",
    quantity: 1,
    price: { value: 1000, currency: "EUR" },
    options: [{ groupId: "g", choiceId: "c", name: "Chocolate" }],
  },
];
const order = { totalPrice: { value: 1400, currency: "EUR" }, lines: orderLines } as unknown as DraftView["terms"];

describe("a draft's card", () => {
  it("words a stay's lines by their own words and amounts, and says who collects what, and when", () => {
    expect(termsLine(stay, TZ)).toBe(
      "Double room, 3 nights — €360.00; City tax, €2.00 per person per night — €40.00, paid at the property · €400.00 in all",
    );
    const details = draftDetails(stay, TZ);
    expect(details).toContain("Paid €120.00 now, €280.00 at the property");
    expect(details.some((d) => d.startsWith("They can accept it until"))).toBe(true);
    expect(termsLine(stay, TZ)).not.toContain("1 ×");
  });

  it("says how long a stay's quote holds from when it is sent, as it is worked out again then", () => {
    // Made a day before it lapses (the quote keeps whole seconds): a day from when it goes.
    const made = "2026-11-19T18:00:00.400Z";
    expect(draftDetails(stay, TZ, made)).toContain("They can accept it for a day once it is sent");
    const two = { ...stay, validThrough: "2026-11-19T20:00:00Z" } as DraftView["terms"];
    expect(draftDetails(two, TZ, "2026-11-19T18:00:00Z")).toContain("They can accept it for 2 hours once it is sent");
    // Cut short by the stay's arrival: until that same time, whenever it goes.
    const cut = { ...stay, validThrough: "2026-11-20T13:59:00Z" } as DraftView["terms"];
    expect(draftDetails(cut, TZ, made)).toContain(
      `They can accept it until ${formatDateTime("2026-11-20T13:59:00Z", TZ)}`,
    );
    // Any other offer goes with the date it was drafted with.
    const other = { totalPrice: { value: 4000, currency: "EUR" }, validThrough: "2026-11-20T18:00:00Z" };
    expect(draftDetails(other as DraftView["terms"], TZ, "2026-11-19T18:00:00Z")).toContain(
      `They can accept it until ${formatDateTime("2026-11-20T18:00:00Z", TZ)}`,
    );
  });

  it("words an order change's lines as the customer reads them: each amount, each choice", () => {
    const line = termsLine(order, TZ);
    expect(line).toBe("2 × Bread — €4.00; 1 × Cake (Chocolate) — €10.00 · €14.00 in all");
    // The customer's own summary says the same lines.
    expect(line.split(" · ")[0]).toBe(orderLinesText(orderLines, "en"));
  });

  it("keeps a time's offer as it was: the time and the total", () => {
    const time = { startTime: "2026-11-20T10:00:00Z", totalPrice: { value: 4000, currency: "EUR" } };
    expect(termsLine(time as DraftView["terms"], TZ)).toMatch(/ · €40\.00$/);
  });

  it("says a draft is not sent yet when no limit kept it, never 'it is .'", () => {
    expect(notSentWords([])).toBe("Not sent yet.");
    expect(notSentWords(["below_floor"])).toBe("Not sent: it is under your lowest price, or more off than you allow.");
    const card = readFileSync(path.resolve(import.meta.dirname, "../client/src/components/Draft.tsx"), "utf8");
    expect(card).toContain("notSentWords(draft.breaches)");
    expect(card).not.toContain("Not sent: it");
    const phone = readFileSync(path.resolve(import.meta.dirname, "../../mobile/src/screens/Item.tsx"), "utf8");
    expect(phone).toContain("notSentWords(d.breaches)");
  });
});
