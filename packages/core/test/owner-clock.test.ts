import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import type { Caller } from "../src/write/index";
import { makeClient, resetTables } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");

const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const form: Caller = {
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => T0,
};

/** A business in New York with one service, and a booking a customer asked for at 14:00 UTC. */
async function setup(timezone?: string) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Full service",
    durationMin: 90,
    capacity: 1,
    granularityMin: 30,
    createdAt: T0,
    updatedAt: T0,
  });
  const caps = new Capabilities(db);
  await caps.updateSettings(owner, { doc: { business: { name: "Oficina Maré" } } });
  if (timezone) await caps.setup.updateProfile(owner, { timezone });
  const created = await caps.createBooking(form, {
    payload: {
      reservationFor: { serviceId: svc, name: "Full service" },
      startTime: "2026-09-22T14:00:00Z",
      endTime: "2026-09-22T15:30:00Z",
    },
    contact: { name: "Rita Amaral", email: "rita@example.com" },
  });
  return { db, caps, svc, id: created.view.item.id, token: created.accessToken };
}

// 14:00 UTC on 22 September is 10:00 in New York (EDT); 16:00 UTC, 12:00.
const AT_TEN = 'Booking "Full service" for Tuesday, 22 September 2026 at 10:00 (';

describe("what the business reads about a booking, on its own clock", () => {
  it("says the time in the business's time zone wherever the owner reads it, and keeps the machine time as it is", async () => {
    const { caps, svc, id } = await setup("America/New_York");

    const detail = await caps.getItem(owner, { item_id: id });
    expect(detail.human).toContain(AT_TEN);
    expect(detail.human).not.toContain("UTC");
    // The machine field is unchanged: an instant, in UTC.
    expect(detail.item.payload).toMatchObject({ startTime: "2026-09-22T14:00:00Z" });

    const listed = await caps.listItems(owner, { limit: 50, open_only: true, sandbox: false });
    expect(listed.items.find((v) => v.item.id === id)?.human).toContain(AT_TEN);

    const status = await caps.getItemStatus(owner, { item_id: id });
    expect(status.human).toContain(AT_TEN);

    const noted = await caps.reply(owner, { item_id: id, body: "Ring first.", internal: true });
    expect(("view" in noted ? noted.view : noted).human).toContain(AT_TEN);

    // A change the business asks for, in its own words, both times on its clock.
    await caps.transitionItem(owner, { item_id: id, event: "confirm" });
    const moved = await caps.transitionItem(owner, {
      item_id: id,
      event: "propose_change",
      input: { startTime: "2026-09-22T16:00:00Z", endTime: "2026-09-22T17:30:00Z" },
    });
    expect(moved.view.human).toContain(AT_TEN);
    expect(moved.view.human).toContain("You asked the customer to move it to Tuesday, 22 September 2026 at 12:00 (");
    expect(moved.view.human).not.toContain("UTC");

    // A booking the owner writes down themselves, read back on the same clock.
    const written = await caps.createBooking(owner, {
      payload: {
        reservationFor: { serviceId: svc, name: "Full service" },
        startTime: "2026-09-23T14:00:00Z",
        endTime: "2026-09-23T15:30:00Z",
      },
      contact: { name: "Rui Costa", email: "rui@example.com" },
    });
    expect(written.view.human).toContain('Booking "Full service" for Wednesday, 23 September 2026 at 10:00 (');
  });

  it("tells the customer on the business's clock too, with the zone named", async () => {
    const { caps, id, token } = await setup("America/New_York");
    const seen = await caps.getItemStatus(form, { item_id: id, access_token: token });
    expect(seen.human).toContain("10:00");
    expect(seen.human).not.toContain("14:00");
    expect(seen.human).not.toContain("UTC");
  });

  it("says UTC, and names it, for a business with no time zone set", async () => {
    const { caps, id } = await setup();
    const detail = await caps.getItem(owner, { item_id: id });
    expect(detail.human).toContain('Booking "Full service" for 2026-09-22 14:00 UTC is requested');
  });
});
