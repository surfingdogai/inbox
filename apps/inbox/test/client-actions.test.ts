import { describe, expect, it } from "vitest";
import {
  inputKindFor,
  isoToLocal,
  localToIso,
  networkNote,
  orderActions,
  parseMoney,
  sumLines,
  tonesFor,
} from "../client/src/lib/actions";
import { countsFrom, paramsFor, parseFilter, visibleIn, withQuery } from "../client/src/lib/filters";
import type { Item, ItemView } from "../client/src/lib/types";

// How transitions become buttons and forms, and how the rail filters map to the API.
describe("client actions", () => {
  it("makes the first non-destructive transition primary and destructive ones danger", () => {
    expect(tonesFor([{ event: "confirm" }, { event: "propose" }, { event: "decline" }])).toEqual([
      "primary",
      "secondary",
      "danger",
    ]);
    expect(tonesFor([{ event: "decline" }])).toEqual(["danger"]);
    expect(tonesFor([{ event: "cancel_by_business" }, { event: "complete" }])).toEqual(["danger", "primary"]);
    expect(tonesFor([{ event: "answer" }, { event: "close" }, { event: "mark_spam" }])).toEqual([
      "primary",
      "secondary",
      "danger",
    ]);
  });

  it("knows what each event asks for", () => {
    expect(inputKindFor("propose")).toBe("propose");
    expect(inputKindFor("quote")).toBe("quote");
    expect(inputKindFor("record_payment")).toBe("payment");
    expect(inputKindFor("request_payment")).toBe("payment_request");
    expect(inputKindFor("decline")).toBe("note");
    expect(inputKindFor("confirm")).toBe("none");
  });

  it("treats the outcomes an owner records about a customer as destructive, and asks for a word only where it is sent", () => {
    expect(tonesFor([{ event: "record_payment" }, { event: "payment_failed" }, { event: "cancel" }])).toEqual([
      "primary",
      "danger",
      "danger",
    ]);
    expect(tonesFor([{ event: "complete" }, { event: "no_show" }])).toEqual(["primary", "danger"]);
    expect(tonesFor([{ event: "record_charge_back" }])).toEqual(["danger"]);
    expect(inputKindFor("payment_failed")).toBe("note");
    // A charge-back tells the customer nothing, so it asks for nothing.
    expect(inputKindFor("charge_back")).toBe("none");
  });

  it("says beforehand how the networks read what the owner records", () => {
    const now = Date.parse("2026-09-23T09:00:00Z");
    const booking = (state: string, startTime: string) =>
      ({
        type: "booking",
        state,
        payload: { reservationFor: { serviceId: "s", name: "x" }, startTime, endTime: startTime },
      }) as unknown as Item;
    expect(networkNote("cancel_by_business", booking("confirmed", "2026-09-24T10:00:00Z"), now)).toMatch(/at half/);
    expect(networkNote("cancel_by_business", booking("confirmed", "2026-09-23T20:00:00Z"), now)).toMatch(/fully/);
    // Before it is confirmed nothing was promised, and there is nothing to say.
    expect(networkNote("cancel_by_business", booking("requested", "2026-09-23T20:00:00Z"), now)).toBeNull();
    expect(networkNote("no_show", booking("confirmed", "2026-09-23T08:00:00Z"), now)).toMatch(/correct it once/);
    expect(networkNote("complete", booking("no_show", "2026-09-23T08:00:00Z"), now)).toMatch(/once/);
    const order = (state: string) => ({ type: "order", state, payload: {} }) as unknown as Item;
    expect(networkNote("cancel", order("accepted"), now)).toMatch(/not fulfilled/);
    expect(networkNote("cancel", order("received"), now)).toBeNull();
    expect(networkNote("payment_failed", order("awaiting_payment"), now)).toMatch(/at half against the customer/);
    expect(networkNote("record_charge_back", order("completed"), now)).toMatch(/charge-back/);
    expect(networkNote("confirm", booking("requested", "2026-09-24T10:00:00Z"), now)).toBeNull();
  });

  it("parses money in major units and sums lines", () => {
    expect(parseMoney("45", "EUR")).toEqual({ value: 4500, currency: "EUR" });
    expect(parseMoney("45,90", "EUR")).toEqual({ value: 4590, currency: "EUR" });
    expect(parseMoney("", "EUR")).toBeUndefined();
    expect(parseMoney("abc", "EUR")).toBeUndefined();
    expect(parseMoney("-1", "EUR")).toBeUndefined();
    expect(
      sumLines(
        [
          { name: "a", quantity: 2, price: { value: 1290, currency: "EUR" } },
          { name: "b", quantity: 1, price: { value: 1850, currency: "EUR" } },
        ],
        "EUR",
      ),
    ).toEqual({ value: 4430, currency: "EUR" });
  });

  it("round-trips datetime-local values through ISO", () => {
    const local = isoToLocal("2026-09-23T13:00:00Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Date.parse(localToIso(local) ?? "")).toBe(Date.parse("2026-09-23T13:00:00Z"));
    expect(localToIso("")).toBeUndefined();
    expect(isoToLocal(undefined)).toBe("");
  });
});

describe("client filters", () => {
  const view = (over: Partial<ItemView["item"]>): ItemView => ({
    item: {
      id: "x",
      type: "message",
      state: "open",
      version: 1,
      partyId: "p",
      locationId: null,
      channel: "rest",
      subject: "hi",
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: "2026-09-21T10:00:00Z",
      updatedAt: "2026-09-21T10:00:00Z",
      closedAt: null,
      payload: { text: "hi" },
      ...over,
    } as ItemView["item"],
    transitions: [],
    human: "",
  });

  it("maps the rail to API parameters", () => {
    expect(parseFilter("booking")).toBe("booking");
    expect(parseFilter("nope")).toBeUndefined();
    expect(paramsFor("needs", undefined, false)).toMatchObject({ needs_human: true, open_only: true, sandbox: false });
    expect(paramsFor("booking", "rita", true)).toMatchObject({ type: "booking", q: "rita", sandbox: true });
    expect(paramsFor("done", undefined, false)).toMatchObject({ open_only: false });
    expect(visibleIn("done", view({}))).toBe(false);
    expect(visibleIn("done", view({ closedAt: "2026-09-21T11:00:00Z" }))).toBe(true);
    expect(visibleIn("all", view({}))).toBe(true);
    expect(withQuery({ f: "order", q: "old" }, "new")).toEqual({ f: "order", q: "new" });
    expect(withQuery({ f: "order", q: "old" }, undefined)).toEqual({ f: "order" });
  });

  it("counts the rail from the first pages", () => {
    const open = {
      items: [
        view({ type: "booking", flags: { needsHuman: true, sandbox: false, priority: 0 } }),
        view({ type: "booking" }),
        view({ type: "order" }),
      ],
      next_cursor: "more",
    };
    const everything = { items: [...open.items, view({ closedAt: "2026-09-21T11:00:00Z" })], next_cursor: null };
    const counts = countsFrom(open, everything);
    expect(counts).toMatchObject({ needs: 1, all: 3, done: 1, openMore: true, doneMore: false });
    expect(counts.byType).toEqual({ message: 0, quote_request: 0, booking: 2, order: 1, refund: 0 });
  });
});

describe("client action order", () => {
  it("keeps the API's ranking but moves destructive actions last", () => {
    expect(
      orderActions([{ event: "decline" }, { event: "confirm" }, { event: "propose" }]).map((t) => t.event),
    ).toEqual(["confirm", "propose", "decline"]);
    expect(tonesFor([{ event: "complete" }, { event: "no_show" }, { event: "cancel_by_business" }])).toEqual([
      "primary",
      "danger",
      "danger",
    ]);
  });
});
