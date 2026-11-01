import { logMailOut, runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/capabilities/service";
import { shortRef } from "../src/customer/format";
import { createDb } from "../src/db";
import { ulid } from "../src/ids";
import { createRunner } from "../src/jobs/index";
import { ACCENT_TONES } from "../src/look/palette";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { services } from "../src/schema/tables";
import { createSecretBox } from "../src/secrets/box";
import type { Caller } from "../src/write/caller";
import { confirming, makeClient, resetTables } from "./harness";
import { logoPng } from "./look-files";

/**
 * The business's look in what it emails its customers: once it chose one, every email to a customer
 * (what it answers, the code for their assistant, the one-time code) carries an HTML part with its
 * logo and accent, of the same words, while the text is as it would have been. A default inbox's
 * email is text alone, as it always was, and the owner's own email is never HTML. Node and workerd.
 */
const T0 = Date.parse("2026-09-22T09:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = "https://inbox.oficinamare.pt";

const owner = (t = T0): Caller => ({
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => t,
});
const customer = (t = T0): Caller => ({
  actor: { kind: "customer_human", id: "form", channel: "form" },
  tier: "anonymous",
  sandbox: false,
  now: () => t,
});

async function setup(look?: { theme?: string; accent?: string; logo?: boolean }) {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  const svc = ulid();
  await db.orm.insert(services).values({
    id: svc,
    name: "Surf lesson",
    durationMin: 90,
    capacity: 5,
    granularityMin: 30,
    price: { model: "fixed", value: 4500, currency: "EUR" },
    createdAt: T0,
    updatedAt: T0,
  });
  const secrets = createSecretBox(["look-mail-test-secret-0123456789abcdef"]);
  const caps = confirming(new Capabilities(db, secrets, BASE));
  const mailOut = logMailOut();
  caps.attachMail(mailOut);
  await caps.updateSettings(owner(), {
    doc: {
      business: { name: "Oficina Maré", timezone: "Europe/Lisbon" },
      notifications: { ownerEmail: "owner@oficinamare.pt" },
      email: { fromAddress: "hello@oficinamare.pt" },
      ...(look?.theme || look?.accent
        ? { look: { ...(look.theme ? { theme: look.theme } : {}), ...(look.accent ? { accent: look.accent } : {}) } }
        : {}),
    },
  });
  const logo = look?.logo ? (await caps.look.setLogo(owner(), logoPng(160, 48))).doc.look.logo : null;
  const runner = createRunner({ mailOut, secrets, baseUrl: BASE });
  const drain = async (t: number) => {
    for (let i = 0; i < 20; i++) if ((await runner.runDue(db, { now: t, limit: 100 })).claimed === 0) return;
  };
  const book = (contact: Record<string, unknown> = { name: "Rita", email: "rita@example.com" }) =>
    caps.createBooking(customer(), {
      payload: {
        reservationFor: { serviceId: svc, name: "Surf lesson" },
        startTime: new Date(T0 + 3 * DAY).toISOString(),
        endTime: new Date(T0 + 3 * DAY + 90 * MIN).toISOString(),
      },
      contact,
    });
  const to = (address: string) => mailOut.sent.filter((m) => m.to.includes(address));
  return { db, caps, mailOut, secrets, drain, book, to, logo };
}

/** The text with the item's reference and its links' tokens written out, so two items' emails compare. */
const sameBut = (text: string, id: string) =>
  text.replaceAll(shortRef(id), "REF").replace(/\/c\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "/c/LINK");

describe("the business's look in its emails to customers", () => {
  it("leaves a default inbox's email text alone, as it was", async () => {
    const s = await setup();
    await s.book();
    await s.drain(T0 + 2 * MIN);
    expect(s.to("rita@example.com")).toHaveLength(1);
    for (const m of s.mailOut.sent) expect(m.html).toBeUndefined();
  });

  it("adds the logo and the accent as HTML to the customer's, with the text as it would have been", async () => {
    const plain = await setup();
    const a = await plain.book();
    await plain.drain(T0 + 2 * MIN);
    const s = await setup({ theme: "warm", accent: "teal", logo: true });
    const b = await s.book();
    await s.drain(T0 + 2 * MIN);
    const [mine] = s.to("rita@example.com");
    const [theirs] = plain.to("rita@example.com");
    expect(sameBut(mine?.text ?? "", b.view.item.id)).toBe(sameBut(theirs?.text ?? "", a.view.item.id));
    expect(mine?.subject).toBe(theirs?.subject);
    const html = mine?.html ?? "";
    expect(html).toContain(`<img src="${BASE}/p/logo/${s.logo?.sha256.slice(0, 16)}.png" alt="Oficina Maré"`);
    expect(html).toContain('width="133" height="40"');
    expect(html).toContain("background:#faf6ef");
    expect(html).toContain(shortRef(b.view.item.id));
    // Its link to confirm is a button, in the accent.
    expect(html).toMatch(/<a href="https:\/\/inbox\.oficinamare\.pt\/c\/[^"]+" style="[^"]+">Confirm it&#39;s me<\/a>/);
    expect(html).toContain(`color:${ACCENT_TONES.teal.day}`);
    // The owner's alert about the same booking stays text.
    const [alert] = s.to("owner@oficinamare.pt");
    expect(alert?.text).toBeTruthy();
    expect(alert?.html).toBeUndefined();
  });

  it("makes the links in an answer the accent's buttons", async () => {
    const s = await setup({ accent: "violet" });
    const b = await s.book();
    await s.caps.transitionItem(owner(T0 + MIN), {
      item_id: b.view.item.id,
      event: "propose",
      input: {
        startTime: new Date(T0 + 4 * DAY).toISOString(),
        endTime: new Date(T0 + 4 * DAY + 90 * MIN).toISOString(),
      },
    });
    await s.drain(T0 + 3 * MIN);
    const proposed = s.to("rita@example.com").at(-1);
    expect(proposed?.subject).toMatch(/time/i);
    const link = /^Accept[^:]*: (https:\/\/\S+\/c\/\S+)$/m.exec(proposed?.text ?? "")?.[1] ?? "";
    expect(link).not.toBe("");
    // The link whole, as in the text, never the log's cut copy.
    expect(proposed?.html).toContain(`<a href="${link}" style="display:inline-block;`);
    expect(proposed?.html).toContain(`border:1px solid ${ACCENT_TONES.violet.day}`);
  });

  it("carries the look in the code email for a first-time customer's assistant", async () => {
    const s = await setup({ theme: "dark", logo: true });
    const b = await s.book();
    const id = b.view.item.id;
    const key = `sdkey1_net.example.com_${"a".repeat(16)}_${"b".repeat(32)}`;
    const box = s.secrets;
    if (!box) throw new Error("no box");
    await s.db.client.query({
      sql: `INSERT INTO pending_identity (item_id, network, state, key_enc, attempts, created_at, updated_at)
            VALUES (?, 'https://net.example.com', 'issued', ?, 1, ?, ?)`,
      params: [id, await box.seal("person-secret", `${id}|https://net.example.com|key`, key), T0, T0],
      method: "run",
    });
    await s.db.client.query({
      sql: "INSERT INTO jobs (id, kind, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at) VALUES (?, 'lifecycle_sweep', '{}', ?, 'queued', 0, 8, ?, ?)",
      params: [ulid(), T0 + DAY + MIN, "sweep", T0],
      method: "run",
    });
    await s.drain(T0 + DAY + MIN);
    const keyMail = s.to("rita@example.com").find((m) => m.text.includes(key));
    expect(keyMail?.html).toContain(key);
    expect(keyMail?.html).toContain(`${BASE}/p/logo/`);
    // A dark look's email is light.
    expect(keyMail?.html).toContain("background:#ffffff");
  });

  it("carries the look in the one-time code email", async () => {
    const s = await setup({ accent: "green" });
    await s.book({ name: "Ana Silva", email: "ana@example.pt" });
    const weak = await s.book({ name: "Ana", email: "ana@example.pt" });
    await s.caps.verifyCustomer(customer(T0 + 2 * MIN), { item_id: weak.view.item.id, access_token: weak.accessToken });
    const sent = s.mailOut.sent.filter((m) => m.to.includes("ana@example.pt"));
    const code = sent.find((m) => /\b\d{6}\b/.test(m.text) && m.html);
    const digits = /\b(\d{6})\b/.exec(code?.text ?? "")?.[1] ?? "";
    expect(digits).not.toBe("");
    expect(code?.html).toContain(digits);
    expect(code?.html).toContain(">Oficina Maré</span>");
  });
});
