import { describe, expect, it } from "vitest";
import { API_KEY, genericPropertySystem, signedHint } from "./fakes/property/generic";
import { propertyContract, runContext } from "./property/contract";

/**
 * The generic fake property system (ADR-037 §8) against the property system contract, in both of the
 * ways a system guards a write: refusing a full night, and taking it and going below none.
 */
const make = (oversell: boolean) => () => {
  const sys = genericPropertySystem({
    name: "Ryokan Hoshi",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    rooms: [
      { id: "R1", name: "Japanese room", units: 1, prices: { FLEX: 25_800 } },
      { id: "R2", name: "Garden suite", units: 3, prices: { FLEX: 38_000 } },
    ],
  });
  if (oversell) sys.mode.guard = "oversell";
  return {
    definition: sys.definition as never,
    http: sys.platform.http,
    secret: { api_key: API_KEY, hook_secret: "" },
    propertyId: "P1",
    oneUnitRoom: "R1",
    rate: "FLEX",
    oversells: oversell,
    exhaust: () => {
      sys.mode.credits = 0;
    },
  };
};

propertyContract("generic fake, refusing full nights", make(false));
propertyContract("generic fake, taking full nights", make(true));

describe("the generic fake's own behaviour", () => {
  it("holds that do not block leave the room on sale, as some systems' do", async () => {
    const sys = genericPropertySystem({ rooms: [{ id: "R1", name: "Double", units: 1, prices: {} }] });
    sys.mode.hold = "nonblocking";
    const ctx = runContext(sys.platform.http, { api_key: API_KEY });
    const writer = sys.definition.stayWriter;
    if (!writer) throw new Error("no writer");
    const stay = {
      itemId: "i1",
      reference: "ABC123",
      key: "sd-hold-1",
      propertyId: "P1",
      checkIn: "2027-01-10",
      checkOut: "2027-01-11",
      rooms: [{ roomId: "R1", adults: 2, childrenAges: [], price: { value: 100, currency: "EUR" } }],
    };
    await writer.put(ctx, stay, null, "hold");
    expect(sys.free("R1", "2027-01-10")).toBe(1);
    sys.mode.hold = "blocks";
    expect(sys.free("R1", "2027-01-10")).toBe(0);
  });

  it("sends each webhook twice, the later first, signed over the exact bytes", async () => {
    const sys = genericPropertySystem({ rooms: [{ id: "R1", name: "Double", units: 1, prices: {} }] });
    const hints = sys.hints("R1", "2027-01-10", "2027-01-12");
    expect(hints.map((h) => h.seq)).toEqual([2, 1, 2]);
    const hint = hints[0];
    if (!hint) throw new Error("no hint");
    const { body, signature } = await signedHint(hint);
    const hooks = sys.definition.hooks;
    if (!hooks) throw new Error("no hooks");
    const ctx = runContext(sys.platform.http, { api_key: API_KEY, hook_secret: "fake-hook-secret-0123456789" });
    const event = await hooks.verify(ctx, {
      headers: new Headers({ "x-fake-signature": signature }),
      body,
      query: new URLSearchParams(),
    });
    expect(event?.refs).toEqual(["R1:2027-01-10:2027-01-12"]);
    await expect(
      hooks.verify(ctx, {
        headers: new Headers({ "x-fake-signature": signature }),
        body: `${body} `,
        query: new URLSearchParams(),
      }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(await hooks.read(ctx, event as never)).toEqual([
      { kind: "stay_nights", roomIds: ["R1"], from: "2027-01-10", to: "2027-01-12" },
    ]);
  });
});
