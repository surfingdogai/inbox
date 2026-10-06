import {
  type Caller,
  MANIFEST_PATH,
  type Manifest,
  manifestSchema,
  productInput,
  serviceInput,
} from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * A truthful manifest: the item types it lists are the ones this inbox can really take, worked out
 * from its services, hours and products; the profile a directory shows is what the owner published,
 * and only that; and an owner who leaves the directories says so to every network at once
 * (`directory.listed`). Node and workerd.
 */
const ORIGIN = "https://inbox.example.com";
const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => NOW,
};

async function setup() {
  const db = await freshDb();
  const inbox = createInbox({ db, now: () => NOW });
  const manifest = async (): Promise<Manifest> => {
    const res = await inbox.app.request(`${ORIGIN}${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    return manifestSchema.parse(await res.json());
  };
  return { db, caps: inbox.caps, manifest };
}

const weekdays = { mon: [["09:00", "13:00"] as [string, string]], tue: [["09:00", "18:00"] as [string, string]] };

describe("the item types the manifest lists", () => {
  it("are only message on a fresh inbox", async () => {
    const s = await setup();
    expect((await s.manifest()).item_types).toEqual(["message"]);
  });

  it("take bookings, quotes and refunds once a priced service has hours", async () => {
    const s = await setup();
    await s.caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Haircut", price: { model: "fixed", value: 2500, currency: "EUR" } }),
    );
    // A service and no hours: there is nothing to book yet, but it can be asked about.
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request"]);
    await s.caps.setup.setWeekly(owner, { weekly: weekdays });
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request", "booking", "refund"]);
  });

  it("take no refund for a service priced only on request, and follow a service's own hours", async () => {
    const s = await setup();
    const svc = await s.caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Survey", price: { model: "quote" } }),
    );
    await s.caps.setup.setWeekly(owner, { weekly: weekdays });
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request", "booking"]);
    // Its own hours, with no window, close it whatever the business's say.
    await s.caps.setup.setWeekly(owner, { weekly: {}, service_id: svc.id });
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request"]);
  });

  it("take orders and refunds with an active product, and stop when it is archived", async () => {
    const s = await setup();
    const p = await s.caps.setup.createProduct(
      owner,
      productInput.parse({ name: "Tide table", price: { value: 500, currency: "EUR" } }),
    );
    expect((await s.manifest()).item_types).toEqual(["message", "quote_request", "order", "refund"]);
    await s.caps.setup.archiveProduct(owner, { product_id: p.id });
    expect((await s.manifest()).item_types).toEqual(["message"]);
  });
});

describe("the profile the manifest carries", () => {
  it("is absent until the business has a name", async () => {
    const s = await setup();
    expect((await s.manifest()).profile).toBeUndefined();
  });

  it("maps what the owner published, and nothing else", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: {
        business: { name: "Oficina Maré", timezone: "Europe/Lisbon", languages: ["pt", "en"] },
        directory: {
          description: "Surfboard repairs and rentals on the beach.",
          categories: ["surf-shop", " ", "repairs"],
          address: { streetAddress: "", addressLocality: "Ericeira", postalCode: "2655-319", addressCountry: "PT" },
          geo: { latitude: 38.9634, longitude: -9.4176 },
          url: "https://oficinamare.pt",
        },
        commerce: { legal: { legalName: "Oficina Maré Lda", email: "owner@oficinamare.pt" } },
        notifications: { ownerEmail: "owner@oficinamare.pt" },
      },
    });
    await s.caps.setup.setWeekly(owner, { weekly: weekdays });
    await s.caps.setup.setClosures(owner, {
      closures: [
        { from: "2026-12-24", to: "2026-12-26", reason: "the owner's family" },
        { from: "2026-08-01", to: "2026-08-15" },
      ],
    });
    await s.caps.setup.createService(
      owner,
      serviceInput.parse({ name: "Ding repair", sort: 2, price: { model: "quote" } }),
    );
    await s.caps.setup.createService(owner, serviceInput.parse({ name: "Board rental", sort: 1 }));
    await s.caps.setup.createService(owner, serviceInput.parse({ name: "Old lesson", active: false }));

    const m = await s.manifest();
    expect(m.profile).toEqual({
      name: "Oficina Maré",
      languages: ["pt", "en"],
      description: "Surfboard repairs and rentals on the beach.",
      categories: ["surf-shop", "repairs"],
      url: "https://oficinamare.pt",
      address: { addressLocality: "Ericeira", postalCode: "2655-319", addressCountry: "PT" },
      geo: { latitude: 38.9634, longitude: -9.4176 },
      // Only the closures that have not ended, and never the owner's reason for one.
      hours: { timezone: "Europe/Lisbon", weekly: weekdays, closures: [{ from: "2026-12-24", to: "2026-12-26" }] },
      services: [
        { name: "Board rental", type: "booking" },
        { name: "Ding repair", type: "quote_request" },
      ],
    });
    // No contact of any person leaves in it.
    expect(JSON.stringify(m)).not.toContain("owner@oficinamare.pt");
    expect(JSON.stringify(m)).not.toContain("Lda");
  });

  it("leaves out the hours a booking falls back to when the owner set none", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { business: { name: "Oficina Maré" } } });
    const profile = (await s.manifest()).profile;
    expect(profile).toEqual({ name: "Oficina Maré", languages: ["en"], categories: [] });
  });
});

describe("the manifest's directory flag", () => {
  const A = "https://network.example.com";
  const B = "https://other.example.org";

  it("is absent while the business is listed", async () => {
    const s = await setup();
    expect((await s.manifest()).directory).toBeUndefined();
    await s.caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });

  it("says listed: false when the owner leaves the directories, and nothing once they come back", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { directory: { listed: false } } });
    expect((await s.manifest()).directory).toEqual({ listed: false });
    await s.caps.updateSettings(owner, { doc: { directory: { listed: true } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });

  it("says listed: false when every network switched on is kept from the listing", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: {
        networks: {
          [A]: { enabled: true, share: { listing: false } },
          [B]: { enabled: true, share: { listing: false } },
        },
      },
    });
    expect((await s.manifest()).directory).toEqual({ listed: false });
    // One of them listing it again: the manifest cannot say both, so it says listed, and the
    // signed listing call tells the other.
    await s.caps.updateSettings(owner, { doc: { networks: { [B]: { share: { listing: true } } } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });
});
