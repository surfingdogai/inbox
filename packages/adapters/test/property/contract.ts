import {
  ConnectorError,
  type ConnectorHttp,
  isPropertySystem,
  type OutboundStay,
  type PropertySystem,
  type RunContext,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";

/**
 * The contract every property system's adapter keeps (ADR-033 §8.5), as tests any adapter runs with
 * its own fake or recorded fixtures: it reads the properties, rooms, rates and what is free night by
 * night; writes a stay under our own key and finds it again by that key; writes the same key once,
 * however often it is sent; refuses (never takes quietly) a stay on a night it has no room for, or
 * takes it and says so itself, definitely (`oversold`: its overbooking flag, or its count of bookings
 * against its rooms), so the inbox's read-back takes the stay back; moves a stay it wrote, refusing or
 * flagging a move onto a full night the same way;
 * cancels by status, never by deleting; and says how many credits it has left, and when it asks the
 * inbox to wait. Nothing here names any vendor.
 */

export interface ContractSystem {
  readonly definition: PropertySystem & { readonly kind: string };
  readonly http: ConnectorHttp;
  readonly secret: Readonly<Record<string, string>>;
  /** The property, a room with one unit, and one with more, in the system's ids. */
  readonly propertyId: string;
  readonly oneUnitRoom: string;
  readonly rate?: string | undefined;
  /** Spends every credit, so the next call is asked to wait. */
  readonly exhaust?: (() => void) | undefined;
  /** Whether the system takes a stay on a full night (and shows it below none) instead of refusing it. */
  readonly oversells?: boolean | undefined;
}

export function runContext(
  http: ConnectorHttp,
  secret: Readonly<Record<string, string>>,
  now = Date.now(),
): RunContext {
  return {
    http,
    now,
    inbox: {
      id: "inbox-test",
      origin: "https://inbox.example.com",
      host: "inbox.example.com",
      name: "Test",
      timezone: "UTC",
      language: "en",
    },
    hookUrl: null,
    hooksLive: true,
    secret,
    extra: {},
    calendars: [],
    busyCalendars: [],
    destinations: [],
    destination: null,
    own: { ids: new Set(), spans: [] },
    marker: "marker",
    async saveSecret() {},
  };
}

function stay(s: ContractSystem, key: string, checkIn: string, checkOut: string): OutboundStay {
  return {
    itemId: `item-${key}`,
    reference: key.slice(-6).toUpperCase(),
    key,
    propertyId: s.propertyId,
    checkIn,
    checkOut,
    rooms: [
      {
        roomId: s.oneUnitRoom,
        ...(s.rate ? { rateId: s.rate } : {}),
        adults: 2,
        childrenAges: [],
        price: { value: 30_000, currency: "EUR" },
      },
    ],
  };
}

export function propertyContract(name: string, make: () => ContractSystem): void {
  describe(`property system contract: ${name}`, () => {
    it("is a property system: it reads stays and writes them", () => {
      const s = make();
      expect(isPropertySystem(s.definition as never)).toBe(true);
      expect(s.definition.stayWriter).toBeDefined();
    });

    it("reads properties, rooms, rates and what is free night by night", async () => {
      const s = make();
      const ctx = runContext(s.http, s.secret);
      const props = await s.definition.stays.properties(ctx);
      expect(props.map((p) => p.id)).toContain(s.propertyId);
      const rooms = await s.definition.stays.rooms(ctx, s.propertyId);
      expect(rooms.find((r) => r.id === s.oneUnitRoom)?.units).toBe(1);
      expect(Array.isArray(await s.definition.stays.ratePlans(ctx, s.propertyId))).toBe(true);
      const read = await s.definition.stays.ari(ctx, s.propertyId, { from: "2027-03-01", to: "2027-03-04" });
      const rows = Array.isArray(read) ? read : read.rows;
      const mine = rows.filter((r) => r.roomId === s.oneUnitRoom).map((r) => r.night);
      expect(mine).toEqual(["2027-03-01", "2027-03-02", "2027-03-03"]);
    });

    it("writes a stay under our key once, however often it is sent, and finds it by that key", async () => {
      const s = make();
      const ctx = runContext(s.http, s.secret);
      const writer = s.definition.stayWriter;
      if (!writer) throw new Error("no writer");
      const one = stay(s, "sd-contract-1", "2027-04-10", "2027-04-12");
      const a = await writer.put(ctx, one, null, "confirmed");
      const b = await writer.put(ctx, one, null, "confirmed");
      expect(a.externalId).toBeTruthy();
      expect(b.externalId).toBe(a.externalId);
      expect((await writer.find(ctx, one))?.externalId).toBe(a.externalId);
      expect(await writer.find(ctx, stay(s, "sd-contract-unknown", "2027-04-10", "2027-04-12"))).toBeNull();
    });

    it("never quietly takes a night it has no room for", async () => {
      const s = make();
      const ctx = runContext(s.http, s.secret);
      const writer = s.definition.stayWriter;
      if (!writer) throw new Error("no writer");
      const firstStay = stay(s, "sd-contract-a", "2027-05-01", "2027-05-03");
      const first = await writer.put(ctx, firstStay, null, "confirmed");
      const second = stay(s, "sd-contract-b", "2027-05-02", "2027-05-04");
      if (s.oversells) {
        // A system that takes it says so itself, definitely: never left to a count clamped at none.
        expect(writer.oversold).toBeDefined();
        const taken = await writer.put(ctx, second, null, "confirmed");
        expect(await writer.oversold?.(ctx, second, taken)).toBe(true);
        await writer.cancel(ctx, taken);
        expect(await writer.oversold?.(ctx, firstStay, first)).toBe(false);
      } else {
        await expect(writer.put(ctx, second, null, "confirmed")).rejects.toMatchObject({ code: "refused" });
      }
    });

    it("never quietly moves a stay onto a night it has no room for", async () => {
      const s = make();
      const ctx = runContext(s.http, s.secret);
      const writer = s.definition.stayWriter;
      if (!writer) throw new Error("no writer");
      await writer.put(ctx, stay(s, "sd-contract-c", "2027-07-03", "2027-07-05"), null, "confirmed");
      const mine = stay(s, "sd-contract-d", "2027-07-01", "2027-07-03");
      const link = await writer.put(ctx, mine, null, "confirmed");
      const longer = { ...mine, checkOut: "2027-07-04" };
      if (s.oversells) {
        await writer.put(ctx, longer, link, "confirmed");
        expect(await writer.oversold?.(ctx, longer, link)).toBe(true);
      } else {
        await expect(writer.put(ctx, longer, link, "confirmed")).rejects.toMatchObject({ code: "refused" });
      }
    });

    it("moves a stay it wrote, and cancels by status, never by deleting", async () => {
      const s = make();
      const ctx = runContext(s.http, s.secret);
      const writer = s.definition.stayWriter;
      if (!writer) throw new Error("no writer");
      const one = stay(s, "sd-contract-move", "2027-06-01", "2027-06-03");
      const link = await writer.put(ctx, one, null, "confirmed");
      await writer.put(ctx, { ...one, checkIn: "2027-06-05", checkOut: "2027-06-07" }, link, "confirmed");
      const read = await s.definition.stays.ari(ctx, s.propertyId, { from: "2027-06-01", to: "2027-06-08" });
      const rows = Array.isArray(read) ? read : read.rows;
      const units = (night: string) => rows.find((r) => r.roomId === s.oneUnitRoom && r.night === night)?.units;
      expect(units("2027-06-01")).toBe(1);
      expect(units("2027-06-05")).toBe(0);
      await writer.cancel(ctx, link);
      const after = await s.definition.stays.ari(ctx, s.propertyId, { from: "2027-06-05", to: "2027-06-06" });
      expect((Array.isArray(after) ? after : after.rows).find((r) => r.roomId === s.oneUnitRoom)?.units).toBe(1);
      // Still there, as cancelled: found by its key.
      expect((await writer.find(ctx, one))?.externalId).toBe(link.externalId);
    });

    it("says what its credits are, and asks the inbox to wait when they are spent", async () => {
      const s = make();
      if (!s.definition.stays.credits || !s.exhaust) return;
      const ctx = runContext(s.http, s.secret);
      let seen: { remaining: number; resetsInMs: number } | null = null;
      const counted: ConnectorHttp = {
        async request(r) {
          const res = await s.http.request(r);
          seen = s.definition.stays.credits?.(res) ?? seen;
          return res;
        },
      };
      await s.definition.stays.properties(runContext(counted, s.secret));
      expect(seen).not.toBeNull();
      s.exhaust();
      const waited = await s.definition.stays.rooms(ctx, s.propertyId).catch((e: unknown) => e);
      expect(waited).toBeInstanceOf(ConnectorError);
      expect((waited as ConnectorError).code).toBe("rate_limited");
      expect((waited as ConnectorError).retryAfterMs).toBeGreaterThan(0);
    });
  });
}
