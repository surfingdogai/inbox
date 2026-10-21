import { createSecretBox, customerCopyProblems, STAY_LANGS, WriteError } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import {
  CANCELLATION,
  checkUcpBooking,
  childAgeRanges,
  leadOf,
  messagesOf,
  nodeAt,
  openSession,
  quoteFromUcp,
  refundabilityOf,
  sampleUcpStrings,
  sealSession,
  subjectOf,
  totalsDigest,
  type UcpBooking,
  type UcpSchedule,
  type UcpSessionRequest,
  ucpBookingOf,
  ucpLodgingOn,
  ucpSessionRequest,
  ucpTotalsOf,
} from "../src/ucp-lodging";
import docs from "./fixtures/ucp-lodging/ucp-docs-examples.json" with { type: "json" };
import { partsOf, setupOf, VECTORS, type Vector } from "./fixtures/ucp-lodging/vectors";

/**
 * UCP Lodging's mapping (ADR-033 §6.5) against its vectors and the draft's own examples, pinned at commit
 * f2626c28b8288976eee5bda77f3a9b1ddc0132b1: a quote becomes a booking session and reads back as the same
 * money; the addends sum to the one total and the selected term's schedules to it too; the local tax
 * disclosure points at the at_property schedule; and the checks catch what UCP forbids.
 */

const examples = docs.examples as unknown as { name: string; booking: Record<string, unknown> }[];

/**
 * Text as both runtimes write it: their ICU data differ in spaces and in how a currency is named
 * ("¥" or "JP¥", "Ksh" or "KES"). Everything else is compared exactly.
 */
function plain(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .normalize("NFKC")
      .replace(/[   ]/g, " ")
      .replace(/\b(JP¥|CA\$|Ksh|KES|CAD|JPY|US\$)\s?/g, "¤")
      .replace(/[¥$]/g, "¤")
      .replace(/\s+/g, " ")
      .trim();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]));
  return value;
}

const sum = (xs: readonly { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);

describe("the vectors", () => {
  for (const v of VECTORS) {
    it(`${v.name}: the quote becomes the session the vector holds`, () => {
      const built = ucpBookingOf(partsOf(v));
      expect(plain(JSON.parse(JSON.stringify(built)))).toEqual(plain(v.booking));
    });

    it(`${v.name}: the session reads back as the same money`, () => {
      const facts = quoteFromUcp(v.booking as UcpBooking);
      expect(facts.currency).toBe(v.quote.currency);
      expect(facts.total).toEqual(v.quote.total);
      expect(facts.lines).toEqual(
        v.quote.lines.map((l) => ({
          type: l.type,
          label: l.label,
          amount: l.amount,
          collected: l.collected,
          ...(l.nights ? { nights: l.nights } : {}),
        })),
      );
      expect(facts.schedule).toEqual(
        v.quote.schedule.map((s) => ({
          id: s.id,
          type: s.type,
          amount: s.amount,
          ...(s.dueAt ? { dueAt: s.dueAt } : {}),
        })),
      );
      expect(facts.policy).toEqual(v.quote.policy);
    });

    it(`${v.name}: holds every rule UCP sets`, () => {
      expect(checkUcpBooking(v.booking as unknown as Record<string, unknown>)).toEqual([]);
    });
  }
});

describe("totals and schedules", () => {
  const all = [
    ...VECTORS.map((v) => ({ name: v.name, booking: v.booking as unknown as Record<string, unknown> })),
    ...examples,
  ];
  for (const { name, booking } of all) {
    it(`${name}: one subtotal, one total, the addends summing to it, and the selected term's schedules too`, () => {
      const b = booking as unknown as UcpBooking;
      const totals = b.totals;
      expect(totals.filter((t) => t.type === "subtotal")).toHaveLength(1);
      expect(totals.filter((t) => t.type === "total")).toHaveLength(1);
      const total = totals.find((t) => t.type === "total")?.amount;
      expect(sum(totals.filter((t) => t.type !== "total"))).toBe(total);
      for (const t of totals) if (t.lines) expect(sum(t.lines)).toBe(t.amount);
      const term = b.payment?.terms.find((x) => x.id === b.payment?.selected_term_id);
      if (term) expect(sum(term.schedules)).toBe(total);
      for (const s of b.stays)
        expect(sum(s.totals.filter((t) => t.type !== "total"))).toBe(s.totals.find((t) => t.type === "total")?.amount);
    });
  }

  it("the draft's own examples hold the rules the inbox checks", () => {
    for (const e of examples) expect(checkUcpBooking(e.booking), e.name).toEqual([]);
  });

  it("an extra is a line of the one subtotal, never a second subtotal", () => {
    const hoshi = VECTORS[0] as Vector;
    const totals = ucpTotalsOf(hoshi.quote);
    expect(totals.map((t) => t.type)).toEqual(["subtotal", "fee", "tax", "total"]);
    expect(totals[0]?.lines?.map((l) => [l.display_text, l.amount, l.kind ?? null])).toEqual([
      ["Japanese room, 3 nights (includes 10% consumption tax)", 77_400, null],
      ["Late check-out", 3_000, "extra"],
    ]);
    expect(totals[0]?.amount).toBe(80_400);
  });

  it("a discount is below zero, and one of nothing is left out", () => {
    const base = (VECTORS[2] as Vector).quote;
    const off = {
      ...base,
      lines: [
        ...base.lines,
        { type: "discount" as const, label: "Returning guest", amount: -2_000, collected: "with_booking" as const },
        { type: "discount" as const, label: "Nothing off", amount: 0, collected: "with_booking" as const },
      ],
      total: { ...base.total, value: base.total.value - 2_000 },
    };
    const totals = ucpTotalsOf(off);
    expect(totals.filter((t) => t.type === "discount").map((t) => t.amount)).toEqual([-2_000]);
    expect(sum(totals.filter((t) => t.type !== "total"))).toBe(totals.at(-1)?.amount);
  });
});

describe("the local tax disclosure", () => {
  it("points at the schedule the property collects it in, says what and at what rate, and who is exempt", () => {
    const [hoshi, kijani, maple] = VECTORS as [Vector, Vector, Vector];
    const at = (v: Vector) => (v.booking?.messages ?? []).find((m) => m.code === "local_tax");
    const h = at(hoshi);
    expect(h).toMatchObject({ type: "warning", presentation: "disclosure", path: "$.payment.terms[0].schedules[1]" });
    const node = nodeAt(hoshi.booking, h?.path ?? "") as UcpSchedule;
    expect(node).toMatchObject({ id: "at_property", type: "at_property", amount: 64_740 });
    // Everything the property collects itself is inside what is paid there.
    const there = hoshi.quote.lines.filter((l) => l.collected === "at_property");
    expect(node.amount).toBeGreaterThanOrEqual(sum(there));
    expect(h?.content).toContain("Accommodation tax, ¥400 per guest per night");
    expect(h?.content).toContain("children under 12 are exempt");
    const k = at(kijani);
    expect(k?.path).toBe("$.payment.terms[0].schedules[0]");
    expect((nodeAt(kijani.booking, k?.path ?? "") as UcpSchedule).type).toBe("at_property");
    expect(k?.content).toContain("for at most 7 nights");
    // Nothing collected at the property, no disclosure.
    expect(at(maple)).toBeUndefined();
  });

  it("is the one the draft's own example makes, to its own schedule", () => {
    const tokyo = examples[0]?.booking as unknown as UcpBooking;
    const m = tokyo.messages?.find((x) => x.code === "local_tax");
    expect((nodeAt(tokyo, m?.path ?? "") as UcpSchedule).type).toBe("at_property");
  });

  it("is caught pointing anywhere else", () => {
    const b = structuredClone((VECTORS[0] as Vector).booking) as unknown as Record<string, unknown>;
    const messages = b.messages as { code: string; path: string }[];
    const local = messages.find((m) => m.code === "local_tax");
    if (local) local.path = "$.payment.terms[0].schedules[0]";
    expect(checkUcpBooking(b)).toContain("the local_tax disclosure does not point at an at_property schedule");
    if (local) local.path = "$.payment.terms[0].schedules[7]";
    expect(checkUcpBooking(b).join(" ")).toContain("points at nothing");
  });
});

describe("what the checks catch", () => {
  const broken = (change: (b: Record<string, unknown>) => void) => {
    const b = structuredClone((VECTORS[0] as Vector).booking) as unknown as Record<string, unknown>;
    change(b);
    return checkUcpBooking(b);
  };

  it("a second subtotal, addends that do not sum, a schedule that does not, a line off its entry", () => {
    expect(
      broken((b) => (b.totals as unknown[]).splice(1, 0, { type: "subtotal", display_text: "Extra", amount: 0 })),
    ).toContain("totals has 2 subtotals, not one");
    expect(broken((b) => ((b.totals as { amount: number }[])[1] as { amount: number }).amount++).join(" ")).toContain(
      "addends sum to",
    );
    expect(
      broken((b) => {
        const term = (b.payment as { terms: { schedules: { amount: number }[] }[] }).terms[0];
        if (term?.schedules[0]) term.schedules[0].amount -= 1;
      }).join(" "),
    ).toContain("the selected term's schedules sum to");
    expect(
      broken((b) => {
        const sub = (b.totals as { lines: { amount: number }[] }[])[0];
        if (sub?.lines[0]) sub.lines[0].amount += 1;
      }).join(" "),
    ).toContain("lines sum to");
  });

  it("an escalation with nowhere to go, a booking with no confirmation, a ready session with no lead", () => {
    expect(
      broken((b) => {
        b.status = "requires_escalation";
        delete b.continue_url;
      }),
    ).toEqual(
      expect.arrayContaining([
        "requires_escalation without continue_url",
        "requires_escalation without a requires_buyer_* message",
      ]),
    );
    expect(broken((b) => (b.status = "completed"))).toContain("completed without a confirmation");
    expect(
      broken((b) => {
        delete b.booker;
        delete b.guests;
      }),
    ).toContain("ready_for_complete without an identified lead");
  });
});

describe("the policy", () => {
  const q = (VECTORS[0] as Vector).quote;
  it("is refundable while the free step runs, partly after it, and not at all once the fee is the stay", () => {
    expect(refundabilityOf(q, Date.parse("2026-12-01T12:00:00+09:00"))).toBe("refundable");
    expect(refundabilityOf(q, Date.parse("2026-12-10T12:00:00+09:00"))).toBe("partially_refundable");
    const strict = { ...q, policy: { ...q.policy, steps: [], after: q.total } };
    expect(refundabilityOf(strict, Date.parse("2026-12-01T12:00:00+09:00"))).toBe("non_refundable");
  });

  it("asks the platform to show a stay that cannot be refunded before it is booked", () => {
    const v = VECTORS[0] as Vector;
    const strict = { ...v.quote, policy: { ...v.quote.policy, steps: [], after: v.quote.total } };
    const b = ucpBookingOf({ ...partsOf(v), quote: strict });
    expect(b.policies?.[0]?.refundability).toBe("non_refundable");
    expect(b.messages?.find((m) => m.code === CANCELLATION)).toMatchObject({
      presentation: "disclosure",
      path: "$.policies[0]",
    });
    expect(checkUcpBooking(b as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("is kept as its dated steps, with the zone they were dated in", () => {
    const b = (VECTORS[2] as Vector).booking as UcpBooking;
    expect(b.policies?.[0]?.dated_steps).toEqual({
      zone: "America/Halifax",
      steps: [{ until: "2026-07-03T23:59:59-03:00", fee: 0 }],
      after: 18_900,
      no_show: 43_470,
    });
  });
});

describe("requests", () => {
  const kijani = VECTORS[1] as Vector;
  const setup = setupOf(kijani);
  const ask = (over: Partial<UcpSessionRequest["stays"][number]> = {}, rest: Partial<UcpSessionRequest> = {}) =>
    ucpSessionRequest.parse({
      property: { id: "prop_kijani" },
      stays: [
        {
          accommodation_type: { id: "rt_garden" },
          rate_plan: { id: "rp_bb" },
          occupancy: { adults: 2, children: 1, child_ages: [7], total: 3 },
          stay_dates: { start_date: "2027-02-03", end_date: "2027-02-06" },
          ...over,
        },
      ],
      ...rest,
    });

  it("become the stay they ask for, by ids or by the stay's own id", () => {
    expect(subjectOf(ask(), setup)).toEqual({ subject: kijani.subject });
    const byId = ask({ id: "rt_garden__rp_bb", accommodation_type: undefined, rate_plan: undefined } as never);
    expect(subjectOf(byId, setup)).toEqual({ subject: kijani.subject });
  });

  it("say, with UCP's paths, what does not fit the property", () => {
    const first = (r: ReturnType<typeof subjectOf>) => ("messages" in r ? r.messages[0] : undefined);
    expect(first(subjectOf(ask({ accommodation_type: { id: "rt_none" } }), setup))).toMatchObject({
      code: "not_found",
      path: "$.stays[0].accommodation_type.id",
    });
    expect(first(subjectOf(ask({ rate_plan: { id: "rp_none" } }), setup))).toMatchObject({
      path: "$.stays[0].rate_plan.id",
    });
    expect(
      first(subjectOf(ask({ occupancy: { adults: 2, children: 2, child_ages: [7, 9], total: 4 } }), setup)),
    ).toMatchObject({ code: "occupancy_exceeded_capacity", path: "$.stays[0]", severity: "recoverable" });
    // Children are welcome here from 5.
    expect(
      first(subjectOf(ask({ occupancy: { adults: 2, children: 1, child_ages: [3], total: 3 } }), setup)),
    ).toMatchObject({
      code: "occupancy_exceeded_capacity",
    });
    expect(first(subjectOf(ask({ occupancy: { adults: 2, children: 1, total: 3 } }), setup))).toMatchObject({
      code: "invalid",
      path: "$.stays[0].occupancy.child_ages",
    });
    expect(
      first(subjectOf(ask({ occupancy: { adults: 2, children: 1, child_ages: [7], total: 4 } }), setup)),
    ).toMatchObject({
      path: "$.stays[0].occupancy",
    });
    const twoDates = ask();
    const other = { ...twoDates.stays[0], stay_dates: { start_date: "2027-02-04", end_date: "2027-02-06" } };
    expect(first(subjectOf({ ...twoDates, stays: [...twoDates.stays, other] } as never, setup))).toMatchObject({
      path: "$.stays[1].stay_dates",
    });
    expect(
      first(subjectOf(ask({ guest_assignments: [{ guest_id: "gst_09", role: "primary" }] }), setup)),
    ).toMatchObject({ path: "$.stays[0].guest_assignments[0].guest_id" });
  });

  it("say UCP counts children as the property takes them: none below the age it takes them from", () => {
    expect(childAgeRanges(setup)).toEqual([{ ages: { min: 0, max: 4 }, limit: 0 }, { ages: { min: 5, max: 17 } }]);
    expect(childAgeRanges(setupOf(VECTORS[2] as Vector))).toEqual([{ ages: { min: 0, max: 17 }, limit: 0 }]);
    expect(childAgeRanges(setupOf(VECTORS[0] as Vector))).toEqual([{ ages: { min: 0, max: 17 } }]);
  });

  it("name the lead as the booker or a primary guest, named and reachable, and nothing before that", () => {
    const assigned = { guest_assignments: [{ guest_id: "g1", role: "primary" }] };
    expect(leadOf(ask())).toBeNull();
    expect(leadOf(ask({}, { booker: { first_name: "Wanjiru" } }))).toBeNull();
    expect(
      leadOf(ask({}, { booker: { first_name: "Wanjiru", last_name: "Kamau", phone_number: "+254700000123" } })),
    ).toEqual({
      name: "Wanjiru Kamau",
      phone: "+254700000123",
      others: [],
    });
    expect(
      leadOf(
        ask(assigned, {
          guests: [
            { id: "g1", first_name: "Amani", last_name: "Otieno", email: "amani@example.org" },
            { id: "g2", first_name: "Zawadi", last_name: "Otieno" },
          ],
        }),
      ),
    ).toEqual({ name: "Amani Otieno", email: "amani@example.org", others: ["Zawadi Otieno"] });
    // A booker who is reachable, for a primary guest who is named.
    expect(
      leadOf(
        ask(assigned, {
          booker: { email: "office@example.org" },
          guests: [{ id: "g1", first_name: "Amani", last_name: "Otieno" }],
        }),
      ),
    ).toEqual({ name: "Amani Otieno", email: "office@example.org", others: [] });
    expect(leadOf(ask({}, { booker: { first_name: "A", last_name: "B", email: "not an address" } }))).toEqual({
      messages: [expect.objectContaining({ code: "invalid", path: "$.booker.email" })],
    });
  });
});

describe("session ids", () => {
  const box = createSecretBox(["ucp-lodging-test-secret-0123456789abcdef"]);
  if (!box) throw new Error("no box");

  it("open only as they were sealed, and carry nothing in the clear", async () => {
    const seal = {
      v: 1 as const,
      n: "nonce-0123456789abcd",
      p: "prop_kijani",
      ci: "2027-02-03",
      co: "2027-02-06",
      r: [["rt_garden", "rp_bb", 2, [7]] as const],
      t: await totalsDigest((VECTORS[1] as Vector).quote),
      iat: Date.parse("2027-01-20T09:00:00+03:00"),
    };
    const id = await sealSession(box, seal);
    expect(id.startsWith("bks_")).toBe(true);
    expect(id).not.toContain("prop_kijani");
    expect(id).not.toContain("rt_garden");
    expect(await openSession(box, id)).toEqual(seal);
    const at = id.length - 5;
    const tampered = `${id.slice(0, at)}${id[at] === "A" ? "B" : "A"}${id.slice(at + 1)}`;
    expect(await openSession(box, tampered)).toBeNull();
    expect(await openSession(box, "booking_123")).toBeNull();
    const other = createSecretBox(["another-instance-secret-0123456789abcdef"]);
    if (other) expect(await openSession(other, id)).toBeNull();
  });

  it("change their fingerprint when the money does, and only then", async () => {
    const q = (VECTORS[0] as Vector).quote;
    expect(await totalsDigest(q)).toBe(await totalsDigest({ ...q, notes: "a note" }));
    expect(await totalsDigest(q)).not.toBe(
      await totalsDigest({ ...q, total: { ...q.total, value: q.total.value + 1 } }),
    );
  });
});

describe("the switch and the words", () => {
  it("is on only when it says on", () => {
    for (const v of ["on", "ON", " on "]) expect(ucpLodgingOn(v)).toBe(true);
    for (const v of [undefined, "", "1", "true", "yes", "off", "onn"]) expect(ucpLodgingOn(v)).toBe(false);
  });

  it("speaks to guests in their language with no word of ours", () => {
    for (const lang of STAY_LANGS) expect(customerCopyProblems(sampleUcpStrings(lang), lang)).toEqual([]);
  });

  it("says what the stays doors refused in UCP's codes", () => {
    expect(
      messagesOf(new WriteError("guard_failed", "x", { details: { guard: "holds", reason: "holds" } }))[0],
    ).toMatchObject({ code: "too_many_holds", severity: "recoverable" });
    expect(
      messagesOf(
        new WriteError("guard_failed", "gone", { details: { guard: "instant_safe", status: "unavailable" } }),
      )[0],
    ).toMatchObject({
      code: "inventory_exhausted",
    });
    expect(messagesOf(new WriteError("slot_taken", "gone"))[0]?.code).toBe("inventory_exhausted");
    expect(
      messagesOf(
        new WriteError("invalid_input", "x", {
          fields: [{ path: "rooms.1.room_type_id", problem: "invalid", message: "no" }],
        }),
      )[0],
    ).toMatchObject({ code: "invalid", path: "$.stays[1]" });
    expect(() => messagesOf(new Error("boom"))).toThrow("boom");
  });
});
