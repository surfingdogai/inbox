import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import {
  LINK_GRACE_MS,
  linksForEmail,
  mintLinks,
  pruneActionLinks,
  siblingsOf,
  tokenFor,
  verifyLink,
} from "../src/customer/links";
import { createDb, type Db } from "../src/db";
import type { Item } from "../src/domain/types";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { createSecretBox } from "../src/secrets/box";
import { makeClient, resetTables } from "./harness";

/**
 * Links in the business's emails (ADR-018 §5): signed, one item and one action each, expiring, and
 * the same for the same email however often its job runs. Runs on Node and in workerd.
 */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const DAY = 86_400_000;
const box = createSecretBox(["links-test-secret-one-0123456789"]);
const rotated = createSecretBox(["links-test-secret-two-9876543210", "links-test-secret-one-0123456789"]);

async function fresh(): Promise<Db> {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return db;
}

const mint = (
  db: Db,
  mailKey: string,
  itemId = "01K5ITEMAAAAAAAAAAAAAAAAAA",
  actions = ["accept_time", "decline_time", "other_time"] as const,
) =>
  mintLinks(
    db,
    box as NonNullable<typeof box>,
    { itemId, mailKey, lang: "pt", termsSha: "T".repeat(43), expiresAt: T0 + 2 * DAY, actions },
    T0,
  );

const count = async (db: Db) =>
  Number((await db.client.query({ sql: "SELECT COUNT(*) FROM action_links", method: "all" })).rows[0]?.[0]);

describe("action links", () => {
  it("are 45 URL-safe characters, and verify to the row they were minted for", async () => {
    const db = await fresh();
    const tokens = await mint(db, "job-1");
    const token = tokens.get("accept_time") as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(token).toHaveLength(45);
    const row = await verifyLink(db, box, token);
    expect(row).toMatchObject({
      itemId: "01K5ITEMAAAAAAAAAAAAAAAAAA",
      action: "accept_time",
      expiresAt: T0 + 2 * DAY,
      usedAt: null,
      termsSha: "T".repeat(43),
      lang: "pt",
      mailKey: "job-1",
    });
  });

  it("refuse a tampered mac, an unknown jti, a token for another action, and a rotated secret", async () => {
    const db = await fresh();
    const tokens = await mint(db, "job-1");
    const token = tokens.get("accept_time") as string;
    const [jti, mac] = token.split(".") as [string, string];
    const flip = (s: string) => (s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    expect(await verifyLink(db, box, `${jti}.${flip(mac)}`)).toBeNull();
    expect(await verifyLink(db, box, `${flip(jti)}.${mac}`)).toBeNull();
    const decline = tokens.get("decline_time") as string;
    expect(await verifyLink(db, box, `${decline.split(".")[0]}.${mac}`)).toBeNull();
    expect(await verifyLink(db, box, "not-a-token")).toBeNull();
    expect(await verifyLink(db, null, token)).toBeNull();
    // A new secret in front retires every link already out there.
    expect(await verifyLink(db, rotated, token)).toBeNull();
  });

  it("are the same for the same email however often it is minted, and differ between emails", async () => {
    const db = await fresh();
    const first = await mint(db, "job-1");
    const again = await mintLinks(
      db,
      box as NonNullable<typeof box>,
      {
        itemId: "01K5ITEMAAAAAAAAAAAAAAAAAA",
        mailKey: "job-1",
        lang: "pt",
        termsSha: "T".repeat(43),
        // A retry an hour later computes another expiry; what is stored stands.
        expiresAt: T0 + 3 * DAY,
        actions: ["accept_time", "decline_time", "other_time"],
      },
      T0 + 3_600_000,
    );
    expect([...again.entries()]).toEqual([...first.entries()]);
    expect(await count(db)).toBe(3);
    const other = await mint(db, "job-2");
    expect(other.get("accept_time")).not.toBe(first.get("accept_time"));
    expect(await count(db)).toBe(6);
  });

  it("find their siblings from the same email, and only those", async () => {
    const db = await fresh();
    const tokens = await mint(db, "job-1");
    await mint(db, "job-2");
    const row = await verifyLink(db, box, tokens.get("accept_time") as string);
    const siblings = await siblingsOf(db, box as NonNullable<typeof box>, row as NonNullable<typeof row>);
    expect([...siblings.keys()].sort()).toEqual(["decline_time", "other_time"]);
    expect(siblings.get("decline_time")).toBe(tokens.get("decline_time"));
    expect(await tokenFor(box as NonNullable<typeof box>, row as NonNullable<typeof row>)).toBe(
      tokens.get("accept_time"),
    );
  });

  it("are dropped thirty days after they expire", async () => {
    const db = await fresh();
    await mint(db, "job-1");
    await pruneActionLinks(db, T0 + 2 * DAY + 29 * DAY);
    expect(await count(db)).toBe(3);
    await pruneActionLinks(db, T0 + 2 * DAY + 31 * DAY);
    expect(await count(db)).toBe(0);
  });

  it("go into an email only for what waits on the customer, and only when they can be signed and reached", async () => {
    const db = await fresh();
    const base = {
      id: "01K5ITEMBBBBBBBBBBBBBBBBBB",
      version: 2,
      partyId: "p",
      locationId: null,
      channel: "rest",
      subject: "Full service",
      flags: { needsHuman: false, sandbox: false, priority: 0 },
      linkedItemId: null,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      closedAt: null,
    } as const;
    const booking = {
      ...base,
      type: "booking",
      state: "proposed",
      payload: {
        reservationFor: { serviceId: "s", name: "Full service" },
        startTime: "2026-09-23T09:00:00Z",
        endTime: "2026-09-23T10:30:00Z",
        proposed: { startTime: "2026-09-23T13:00:00Z", endTime: "2026-09-23T14:30:00Z" },
      },
    } as unknown as Item;
    const input = { mailKey: "job-9", lang: "en" as const, base: "https://inbox.example.com/", now: T0 };
    const links = await linksForEmail(db, box, booking, input);
    expect([...(links?.keys() ?? [])]).toEqual(["accept_time", "decline_time", "other_time"]);
    expect(links?.get("accept_time")).toMatch(
      /^https:\/\/inbox\.example\.com\/c\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/,
    );
    // A time link lives until the answer-by date the email shows (the proposed start, with no
    // minimum notice) and a day more, so the page can say why it is too late.
    const row = await verifyLink(db, box, (links?.get("accept_time") ?? "").split("/c/")[1] ?? "");
    expect(row?.expiresAt).toBe(Date.parse("2026-09-24T13:00:00Z"));
    // Three weeks out, it never dies before that date: not the old two-week cap.
    const far = await linksForEmail(
      db,
      box,
      {
        ...booking,
        payload: {
          ...(booking as { payload: object }).payload,
          proposed: { startTime: "2026-10-14T13:00:00Z", endTime: "2026-10-14T14:30:00Z" },
        },
      } as unknown as Item,
      { ...input, mailKey: "job-far", minNoticeMin: 60 },
    );
    const farRow = await verifyLink(db, box, (far?.get("accept_time") ?? "").split("/c/")[1] ?? "");
    expect(farRow?.expiresAt).toBe(Date.parse("2026-10-14T12:00:00Z") + LINK_GRACE_MS);
    // A quote valid for sixty days: its links live to its last day, and a day more.
    const quote = await linksForEmail(
      db,
      box,
      {
        ...base,
        type: "quote_request",
        state: "quoted",
        payload: {
          itemOffered: { name: "Wheel rebuild" },
          description: "Rear wheel",
          quote: {
            totalPrice: { value: 12_000, currency: "EUR" },
            validThrough: new Date(T0 + 60 * 86_400_000).toISOString(),
            lines: [],
            creates: "order",
          },
        },
      } as unknown as Item,
      { ...input, mailKey: "job-quote" },
    );
    const quoteRow = await verifyLink(db, box, (quote?.get("accept_quote") ?? "").split("/c/")[1] ?? "");
    expect(quoteRow?.expiresAt).toBe(T0 + 60 * 86_400_000 + LINK_GRACE_MS);
    expect(await linksForEmail(db, null, booking, input)).toBeNull();
    expect(await linksForEmail(db, box, booking, { ...input, base: "" })).toBeNull();
    expect(await linksForEmail(db, box, { ...booking, state: "requested" } as Item, input)).toBeNull();
    const asking = await linksForEmail(db, box, { ...booking, state: "needs_info" } as Item, {
      ...input,
      mailKey: "job-10",
    });
    expect([...(asking?.keys() ?? [])]).toEqual(["details"]);
  });
});
