import { checkStayTotals, fillStayTemplate, readDoorsElsewhere, stayPolicySteps } from "@surfingdog/spec";
import { describe, expect, it } from "vitest";
import doorsElsewhere from "../../spec/vectors/doors-elsewhere-stay.json";
import nights from "../../spec/vectors/stay-nights.json";
import policy from "../../spec/vectors/stay-policy.json";
import totals from "../../spec/vectors/stay-totals.json";
import { buildStayVectors } from "../scripts/stay-vectors";
import { datePolicy, feeAt } from "../src/policy/index";
import { nightsOf, stayTimes } from "../src/stays/nights";

/**
 * The stays vectors (spec 0.11, ADR-037): what any implementation must answer for a stay's totals, its
 * policy dated across zones and clock changes, its nights and times, and a stay taken elsewhere. Read
 * case by case here, and rebuilt whole to catch a committed file that drifted from the code.
 */
describe("stay vectors", () => {
  it("are what the code builds (run scripts/gen-network-vectors.ts after a change)", () => {
    const built = JSON.parse(JSON.stringify(buildStayVectors()));
    expect(built.totals).toEqual(totals);
    expect(built.policy).toEqual(policy);
    expect(built.nights).toEqual(nights);
    expect(built.doorsElsewhere).toEqual(doorsElsewhere);
  });

  for (const c of totals.cases) {
    it(`totals: ${c.name}`, () => {
      expect(
        checkStayTotals(c.quote as never, { now: Date.parse(c.now), arrivalAt: Date.parse(c.arrival_at) }),
      ).toEqual(c.problems);
    });
  }

  for (const c of policy.cases) {
    it(`policy: ${c.name}`, () => {
      const steps = stayPolicySteps(c.preset as never);
      expect(steps).toEqual(c.policy);
      const dated = datePolicy(steps, {
        start: { date: c.check_in, time: c.check_in_time },
        zone: c.zone,
        total: c.total,
        units: c.nights,
      });
      expect(dated).toEqual(c.dated);
      for (const f of c.fees) expect(feeAt(dated, Date.parse(f.at), { total: c.total }), f.at).toEqual(f.fee);
      // Every step ends at 23:59:59 local, on its own day.
      for (const s of dated.steps) expect(s.until.slice(11, 19)).toBe("23:59:59");
    });
  }

  for (const c of nights.cases) {
    it(`nights: ${c.name}`, () => {
      expect(nightsOf(c.check_in, c.check_out)).toEqual(c.nights);
      const t = stayTimes({ checkInFrom: c.from, checkOutUntil: c.until, timezone: c.zone }, c.check_in, c.check_out);
      expect([t.startTime, t.endTime]).toEqual([c.start_time, c.end_time]);
    });
  }

  for (const c of doorsElsewhere.cases) {
    it(`doors elsewhere: ${c.name}`, () => {
      const kept = readDoorsElsewhere(c.manifest);
      expect(kept).toEqual(c.kept);
      const t = kept.find((k) => k.item_type === "stay")?.url_template;
      expect(t ? fillStayTemplate(t, doorsElsewhere.values) : null).toEqual(c.filled);
    });
  }
});
