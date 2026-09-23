import { createApiKey } from "@surfingdog/adapters";
import { schema, ulid } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, futureDay } from "./harness";

const T0 = Date.parse("2026-09-21T10:00:00Z");
/** The request goes through the door on the real clock: a day to come (nobody books a time that has started). */
const DAY = futureDay();

// A mutating request leaves jobs in the outbox; the runner drains them after the response.
describe("jobs after requests", () => {
  it("emails the owner about a new booking without anyone calling the runner", async () => {
    const db = await freshDb();
    const svc = ulid();
    await db.orm.insert(schema.services).values({
      id: svc,
      name: "Full service",
      durationMin: 90,
      capacity: 1,
      granularityMin: 30,
      createdAt: T0,
      updatedAt: T0,
    });
    const owner = await createApiKey(db, { kind: "owner", name: "t" });
    const mail = logMailOut();
    const pending: Promise<unknown>[] = [];
    const { app } = createInbox({ db, mailOut: mail, background: (w) => void pending.push(w) });
    const put = await app.request("https://inbox.test/v1/owner/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.key}` },
      body: JSON.stringify({
        doc: { business: { name: "Oficina Maré" }, notifications: { ownerEmail: "hello@oficinamare.pt" } },
      }),
    });
    expect(put.status).toBe(200);
    const res = await app.request("https://inbox.test/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          reservationFor: { serviceId: svc, name: "Full service" },
          startTime: `${DAY}T08:00:00Z`,
          endTime: `${DAY}T09:30:00Z`,
        },
        contact: { name: "Rita", email: "rita@example.com" },
      }),
    });
    expect(res.status).toBe(201);
    await Promise.all(pending);
    expect(mail.sent.map((m) => [m.to[0], m.subject])).toEqual([
      ["hello@oficinamare.pt", "New booking from Rita: Full service"],
    ]);
  });
});
