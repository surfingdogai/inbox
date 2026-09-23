import { PRESETS, type RuleDefinition, summarizeRule as serverSummary } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { summarizeRule } from "../client/src/lib/describe";
import {
  checkClosures,
  checkDraft,
  describeWeekly,
  nextWindow,
  plusMinutes,
  toDraft,
  toWeekly,
} from "../client/src/lib/hours";
import { EMPTY_RULE, parseValue, showValue, toDefinition, toForm } from "../client/src/lib/rules";
import { offerBodies, ownerEmailDoc } from "../client/src/lib/setup";

// The rule editor reads rules back as the server words them, and turns its forms into the JSON the engine runs.
describe("client rule summaries", () => {
  it("word rules exactly like the server", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const rule of preset) expect(summarizeRule(rule.definition)).toBe(serverSummary(rule.definition));
    }
    const custom: RuleDefinition = {
      on: ["item.transitioned:confirm"],
      if: { fn: "party_verified" },
      actions: [{ action: "reply", template: "See you then!", internal: false }],
      stop: false,
      maxRunsPerItem: 1,
    };
    expect(summarizeRule(custom)).toBe(serverSummary(custom));
    expect(summarizeRule(custom)).toBe('When an item is confirmed and the sender is verified: reply "See you then!".');
  });
});

describe("client rule forms", () => {
  it("round-trips a one-level rule through the forms", () => {
    const def = (PRESETS.appointments ?? [])[1]?.definition as RuleDefinition;
    const { form, simple } = toForm(def, { name: "x", priority: 10, enabled: true });
    expect(simple).toBe(true);
    expect(form.conditions).toHaveLength(1);
    expect(form.conditions[0]).toMatchObject({
      kind: "field",
      path: "item.state",
      op: "in",
      value: "requested, received, open",
    });
    const built = toDefinition(form);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.definition).toEqual(def);
  });

  it("declines nested groups for the forms, keeping them for JSON", () => {
    const def = (PRESETS.appointments ?? [])[0]?.definition as RuleDefinition;
    expect(toForm(def, { name: "x", priority: 100, enabled: true }).simple).toBe(false);
  });

  it("builds a definition from forms and says what is missing", () => {
    const empty = toDefinition({ ...EMPTY_RULE, onCreated: false });
    expect(empty).toMatchObject({ ok: false, problem: "Pick at least one moment for the rule to run." });
    const built = toDefinition({
      ...EMPTY_RULE,
      onEvents: ["confirm"],
      conditions: [
        {
          kind: "field",
          not: false,
          fn: "slot_is_free",
          keywords: "",
          path: "item.payload.totalPrice.value",
          op: "gt",
          value: "50",
        },
        { kind: "fact", not: true, fn: "text_has_keywords", keywords: "urgent, asap", path: "", op: "eq", value: "" },
      ],
      actions: [
        { ...EMPTY_RULE.actions[0], kind: "reply", template: "Thanks!", internal: false },
        { ...EMPTY_RULE.actions[0], kind: "set_flags", needsHuman: "flag", priority: "2" },
      ] as typeof EMPTY_RULE.actions,
      stop: true,
      maxRuns: "1",
    });
    expect(built).toEqual({
      ok: true,
      definition: {
        on: ["item.created", "item.transitioned:confirm"],
        if: {
          all: [
            { path: "item.payload.totalPrice.value", op: "gt", value: 5000 },
            { not: { fn: "text_has_keywords", args: { keywords: ["urgent", "asap"] } } },
          ],
        },
        actions: [
          { action: "reply", template: "Thanks!", internal: false },
          { action: "set_flags", needsHuman: true, priority: 2 },
        ],
        stop: true,
        maxRunsPerItem: 1,
      },
    });
  });

  it("parses and shows values by path", () => {
    expect(parseValue("50", "gt", "item.payload.totalPrice.value")).toBe(5000);
    expect(parseValue("45,90", "lt", "item.payload.amount.value")).toBe(4590);
    expect(parseValue("booking", "eq", "item.type")).toBe("booking");
    expect(parseValue("true", "eq", "item.flags.sandbox")).toBe(true);
    expect(parseValue("a, b", "in", "item.state")).toEqual(["a", "b"]);
    expect(parseValue("20, 50", "between", "item.payload.totalPrice.value")).toEqual([2000, 5000]);
    expect(parseValue("whatever", "exists", "item.payload.notes")).toBeUndefined();
    expect(showValue(5000, "item.payload.totalPrice.value")).toBe("50.00");
    expect(showValue(["requested", "open"], "item.state")).toBe("requested, open");
  });
});

describe("client opening hours", () => {
  it("validates the grid and drops closed days on the way out", () => {
    const draft = toDraft({ mon: [["09:00", "18:00"]], sat: [["09:00", "13:00"]] });
    expect(draft.sun).toEqual([]);
    expect(checkDraft(draft)).toBeNull();
    expect(toWeekly(draft)).toEqual({ mon: [["09:00", "18:00"]], sat: [["09:00", "13:00"]] });
    expect(checkDraft({ ...draft, tue: [["18:00", "09:00"]] })).toBe(
      "Tuesday closes at 09:00, before it opens at 18:00.",
    );
    expect(
      checkDraft({
        ...draft,
        wed: [
          ["09:00", "13:00"],
          ["12:00", "18:00"],
        ],
      }),
    ).toContain("overlapping");
    expect(
      describeWeekly({
        mon: [["09:00", "18:00"]],
        tue: [["09:00", "18:00"]],
        wed: [["09:00", "18:00"]],
        sat: [["09:00", "13:00"]],
      }),
    ).toBe("Mon–Wed 09:00–18:00 · Sat 09:00–13:00");
    expect(describeWeekly({})).toBe("Closed all week");
    expect(checkClosures([{ from: "2026-10-05", to: "2026-10-04" }])).toContain("ends");
    expect(checkClosures([{ from: "2026-10-05", to: "2026-10-05", reason: "Holiday" }])).toBeNull();
    expect(plusMinutes("18:00", 60)).toBe("19:00");
    expect(plusMinutes("23:30", 60)).toBe("23:59");
    expect(nextWindow([["09:00", "18:00"]])).toEqual(["18:00", "19:00"]);
    expect(nextWindow([])).toEqual(["09:00", "18:00"]);
  });
});

describe("the setup wizard's offers", () => {
  it("never saves a price typed with a comma as free", () => {
    const services = offerBodies([{ name: "Consultation", minutes: "45", price: "45,50" }], "services", "EUR");
    expect(services).toEqual({
      kind: "services",
      bodies: [
        {
          name: "Consultation",
          duration_min: 45,
          active: true,
          price: { model: "fixed", value: 4550, currency: "EUR" },
        },
      ],
    });
    const products = offerBodies([{ name: "Coffee, 1kg", minutes: "", price: "1.234,50" }], "products", "EUR");
    expect(products).toEqual({
      kind: "products",
      bodies: [{ name: "Coffee, 1kg", price: { value: 123450, currency: "EUR" }, active: true }],
    });
    for (const typed of ["45,50", "45.50", "45,5", "45"]) {
      const r = offerBodies([{ name: "X", minutes: "60", price: typed }], "services", "EUR");
      expect("bodies" in r && r.bodies[0]?.price?.value, typed).toBeGreaterThan(0);
    }
  });

  it("stops at a price it cannot read, and at a product without one, instead of saving 0", () => {
    expect(offerBodies([{ name: "Massage", minutes: "60", price: "45 euros" }], "services", "EUR")).toEqual({
      problem: "Massage: Write a price like 45,50 or 45.50.",
    });
    expect(offerBodies([{ name: "Beans", minutes: "", price: "" }], "products", "EUR")).toEqual({
      problem: "Beans needs a price. Write a price like 45,50 or 45.50.",
    });
    // A service may have no price; an unnamed row is not an offer.
    expect(
      offerBodies(
        [
          { name: "Chat", minutes: "15", price: "" },
          { name: " ", minutes: "60", price: "abc" },
        ],
        "services",
        "EUR",
      ),
    ).toEqual({ kind: "services", bodies: [{ name: "Chat", duration_min: 15, active: true }] });
  });

  it("saves where the owner hears of new requests as one merged key, empty meaning their sign-in address", () => {
    expect(ownerEmailDoc(" ana@oficinamare.pt ")).toEqual({ notifications: { ownerEmail: "ana@oficinamare.pt" } });
    expect(ownerEmailDoc("")).toEqual({ notifications: { ownerEmail: null } });
  });
});
