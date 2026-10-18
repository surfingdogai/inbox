import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiKey, createSession } from "@surfingdog/adapters";
import {
  createDb,
  type Db,
  importReceiptKeys,
  MIGRATIONS,
  type ReceiptKeyFile,
  type SetupPlanInput,
  schema,
  ulid,
} from "@surfingdog/core";
import { logMailOut, runMigrations } from "@surfingdog/platform";
import { nodeSnapshot, nodeSqliteClient } from "@surfingdog/platform/node";
import { afterEach, describe, expect, it } from "vitest";
import { unzip } from "../../../packages/core/test/unzip";
import { createInbox } from "../src/app";
import { confirmed, futureDay, nextDay } from "./harness";

/**
 * A real download, over a database file on Node: a salon set up from a plan, with a booking, a
 * receipt, a webhook, a session, keys and every secret an inbox holds. The zip's copy leaves out who
 * is signed in, keys, connected apps, rate limits and every sealed secret, and it opens in a fresh
 * inbox with the same requests, services, hours and settings, where the owner signs in again and
 * the receipts signed before still verify. The key receipts are signed with goes beside it, in
 * receipt-keys.json, and once taken in the fresh inbox signs as the old one did.
 */
const BASE = "https://inbox.test";
const OWNER = "rosa@salaorosa.pt";
const INBOUND = "salon-inbound-secret-0123456789";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-download-"));
  dirs.push(dir);
  return dir;
}

const salon: SetupPlanInput = {
  profile: { name: "Salão Rosa", timezone: "Europe/Lisbon", currency: "EUR", languages: ["pt", "en"] },
  directory: { listed: false, url: "" },
  hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "18:00"]]])),
  services: [{ name: "Corte", duration_min: 30, price: { model: "fixed", value: 1800 }, price_confirmed: true }],
  preset: "appointments",
  doors: ["message", "quote_request", "booking"],
};

async function call(
  app: ReturnType<typeof createInbox>["app"],
  method: string,
  p: string,
  key?: string,
  body?: unknown,
) {
  return app.request(
    new Request(`${BASE}${p}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function rows(db: Db, sql: string): Promise<unknown[][]> {
  return (await db.client.query({ sql, method: "all" })).rows;
}

describe("a download of a real inbox", () => {
  it("leaves out every way in and every secret but the receipt key, carried beside it, and opens in a fresh inbox", {
    timeout: 30_000,
  }, async () => {
    // ---- the salon, on a database file ----
    const client = nodeSqliteClient(path.join(tempDir(), "inbox.db"));
    const db = createDb(client);
    await runMigrations(db.client, MIGRATIONS);
    const mail = logMailOut();
    const inbox = createInbox({
      db,
      mailOut: mail,
      baseUrl: BASE,
      secretKey: "the-salon-old-secret-key-0123456789",
      snapshot: nodeSnapshot(client),
      background: () => {},
    });
    const userId = ulid();
    await db.orm.insert(schema.users).values({ id: userId, email: OWNER, role: "owner", createdAt: Date.now() });
    const owner = (await createApiKey(db, { kind: "owner", name: "laptop", userId })).key;
    await createApiKey(db, { kind: "integration", name: "Zapier", scopes: ["inbox:read"] });
    await createSession(db, userId, new Request(BASE), Date.now());
    expect((await call(inbox.app, "POST", "/v1/owner/setup/plan", owner, salon)).status).toBe(200);
    const settings = { email: { inboundSecret: INBOUND }, notifications: { ownerEmail: OWNER, appUrl: BASE } };
    expect((await call(inbox.app, "PUT", "/v1/owner/settings", owner, { doc: settings })).status).toBe(200);
    const hook = await call(inbox.app, "POST", "/v1/owner/webhooks", owner, {
      url: "https://hooks.example.com/salon",
      headers: { Authorization: "Bearer zapier-secret-123" },
    });
    expect(hook.status).toBe(201);
    // An agent books; the owner confirms; a receipt is signed.
    const services = (await (await call(inbox.app, "GET", "/v1/services")).json()) as { items: { id: string }[] };
    const svc = services.items[0]?.id as string;
    const day = futureDay();
    const free = (await (
      await call(
        inbox.app,
        "GET",
        `/v1/availability?service_id=${svc}&from=${day}T00:00:00Z&to=${nextDay(day)}T00:00:00Z`,
      )
    ).json()) as { slots: { startTime: string; endTime: string }[] };
    const slot = free.slots[0];
    if (!slot) throw new Error("no free time");
    // The agent's person says yes to the price at the confirm step (`confirmed`).
    const created = await confirmed(
      (r) => inbox.app.request(r),
      new Request(`${BASE}/v1/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "SomeAssistant/1.0" },
        body: JSON.stringify({
          payload: {
            reservationFor: { serviceId: svc, name: "Corte" },
            startTime: slot.startTime,
            endTime: slot.endTime,
            totalPrice: { value: 1800, currency: "EUR" },
          },
          contact: { name: "Ana", email: "ana@example.com" },
        }),
      }),
    );
    expect(created.status).toBe(201);
    const itemId = ((await created.json()) as { view: { item: { id: string } } }).view.item.id;
    expect(
      (await call(inbox.app, "POST", `/v1/owner/items/${itemId}/transitions`, owner, { event: "confirm" })).status,
    ).toBe(200);
    for (let i = 0; i < 10; i++) if ((await inbox.runner.runDue(db, { workerId: "test" })).claimed === 0) break;
    const [oldKey] = await rows(db, "SELECT kid FROM signing_keys");
    expect(oldKey?.[0]).toBeTruthy();
    expect((await rows(db, "SELECT count(*) FROM receipts"))[0]?.[0]).toBe(1);

    // ---- a routine download: no receipt key unless asked for ----
    type Manifest = {
      tables: { name: string; rows: number; left_out?: string }[];
      receipt_keys: { file: string; active: string; kids: string[] } | null;
    };
    const download = async (body: Record<string, unknown>) => {
      expect((await call(inbox.app, "POST", "/v1/owner/download/code", owner, {})).status).toBe(200);
      const code = /code: (\d{6})/.exec(mail.sent.at(-1)?.text ?? "")?.[1];
      const res = await call(inbox.app, "POST", "/v1/owner/download", owner, { code, ...body });
      expect(res.status).toBe(200);
      const files = await unzip(new Uint8Array(await res.arrayBuffer()));
      const manifest = JSON.parse(
        new TextDecoder().decode(files.find((f) => f.name === "manifest.json")?.data),
      ) as Manifest;
      return { files, manifest };
    };
    const plain = await download({});
    expect(plain.files.map((f) => f.name).sort()).toEqual(["README.txt", "inbox.db", "manifest.json"]);
    expect(plain.manifest.receipt_keys).toBeNull();
    expect(plain.manifest.tables.find((t) => t.name === "signing_keys")?.left_out).toBeTruthy();
    expect(mail.sent.at(-1)?.text).not.toContain("receipts are signed with");

    // ---- the download that takes the key along, to move to a server of the owner's own ----
    const { files, manifest } = await download({ receipt_keys: true });
    const readme = new TextDecoder().decode(files.find((f) => f.name === "README.txt")?.data);
    expect(mail.sent.at(-1)).toMatchObject({ to: [OWNER], subject: "A copy of Salão Rosa's inbox was downloaded" });
    expect(mail.sent.at(-1)?.text).toContain("the key your receipts are signed with");
    expect(mail.sent.at(-1)?.text).toContain("make a new receipt key");

    // The key receipts are signed with goes along, in a file of its own, so the inbox the business
    // moves to signs as this one did: never inside inbox.db.
    const keyFile = JSON.parse(
      new TextDecoder().decode(files.find((f) => f.name === "receipt-keys.json")?.data),
    ) as ReceiptKeyFile;
    expect(keyFile).toMatchObject({ format: "surfingdog-receipt-keys/1", active: oldKey?.[0] });
    expect(keyFile.keys.map((k) => k.kid)).toEqual([oldKey?.[0]]);
    expect(keyFile.keys[0]?.jwk.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manifest.receipt_keys).toEqual({ file: "receipt-keys.json", active: oldKey?.[0], kids: [oldKey?.[0]] });
    expect(manifest.tables.find((t) => t.name === "signing_keys")?.left_out).toBeUndefined();
    expect(readme).toContain("node server.mjs import-receipt-keys receipt-keys.json");
    expect(readme).toContain("Keep it as safe as a password");

    // What was left out: every way in, and every secret.
    const table = (name: string) => manifest.tables.find((t) => t.name === name);
    for (const name of [
      "sessions",
      "login_tokens",
      "api_keys",
      "oauth_tokens",
      "oauth_codes",
      "rate_limits",
      "idempotency_keys",
      "jobs",
    ]) {
      expect(table(name), name).toMatchObject({ rows: 0, left_out: expect.any(String) });
      expect(readme).toContain(`- ${name}: `);
    }
    expect(table("items")?.rows).toBe(1);
    const bytes = files.find((f) => f.name === "inbox.db")?.data as Uint8Array;
    const text = new TextDecoder("latin1").decode(bytes);
    for (const secret of [INBOUND, "zapier-secret-123", String(keyFile.keys[0]?.jwk.d)]) {
      expect(text).not.toContain(secret);
    }

    // ---- opened where the owner runs it ----
    const file = path.join(tempDir(), "inbox.db");
    writeFileSync(file, bytes);
    const copy = createDb(nodeSqliteClient(file));
    expect(await rows(copy, "SELECT private_jwk_enc, retired_at IS NOT NULL FROM signing_keys")).toEqual([["", 1]]);
    expect(await rows(copy, "SELECT secret_enc, headers_enc, active FROM webhooks")).toEqual([["", null, 0]]);
    const doc = JSON.parse(String((await rows(copy, "SELECT doc FROM settings"))[0]?.[0])) as {
      email?: Record<string, unknown>;
      notifications?: Record<string, unknown>;
    };
    expect(doc.email?.inboundSecret).toBeUndefined();
    expect(doc.notifications).toEqual({ ownerEmail: OWNER });

    const mail2 = logMailOut();
    const fresh = createInbox({
      db: copy,
      mailOut: mail2,
      baseUrl: "https://inbox.salaorosa.pt",
      secretKey: "a-new-secret-key-on-the-owners-server",
      background: () => {},
    });
    const key2 = (await createApiKey(copy, { kind: "owner", name: "cli" })).key;
    const same = async (p: string) => {
      const before = await (await call(inbox.app, "GET", p, owner)).json();
      const after = await (await call(fresh.app, "GET", p, key2)).json();
      expect(after, p).toEqual(before);
    };
    await same(`/v1/owner/items/${itemId}`);
    await same("/v1/owner/services");
    await same("/v1/owner/availability");
    await same("/v1/owner/rules");
    await same("/v1/owner/profile");
    const settingsAfter = (await (await call(fresh.app, "GET", "/v1/owner/settings", key2)).json()) as {
      doc: { directory: unknown; business: unknown };
    };
    const settingsBefore = (await (
      await call(inbox.app, "GET", "/v1/owner/settings", owner)
    ).json()) as typeof settingsAfter;
    expect(settingsAfter.doc.directory).toEqual(settingsBefore.doc.directory);
    // The old key's public half is still published; the new inbox signs with a key of its own.
    const kid = await fresh.caps.receipts.keys.active().then((k) => k.kid);
    expect(kid).not.toBe(oldKey?.[0]);
    const jwks = (await (await fresh.app.request(`${BASE}/.well-known/jwks.json`)).json()) as {
      keys: { kid: string }[];
    };
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([kid, String(oldKey?.[0])].sort());
    // The key taken in: the copy signs as the inbox it came from, the key it made meanwhile retired
    // (its receipts still verify), and taking the same file in again changes nothing.
    const took = await importReceiptKeys(copy, fresh.caps.secrets, keyFile);
    expect(took).toEqual({ imported: [oldKey?.[0]], already: [], active: oldKey?.[0], retired: [kid] });
    expect((await fresh.caps.receipts.keys.active()).kid).toBe(oldKey?.[0]);
    expect(await rows(copy, "SELECT kid, retired_at IS NOT NULL FROM signing_keys ORDER BY created_at")).toEqual([
      [oldKey?.[0], 0],
      [kid, 1],
    ]);
    const again = await importReceiptKeys(copy, fresh.caps.secrets, keyFile);
    expect(again).toEqual({ imported: [], already: [oldKey?.[0]], active: oldKey?.[0], retired: [] });
    // Never in the clear in the copy's database: sealed with the new inbox's own key.
    const sealedNow = String(
      (await rows(copy, "SELECT private_jwk_enc FROM signing_keys ORDER BY created_at LIMIT 1"))[0]?.[0],
    );
    expect(sealedNow).toMatch(/^v1\./);
    expect(sealedNow).not.toContain(String(keyFile.keys[0]?.jwk.d));
    // The owner signs in again by email: the address is known there.
    const link = await fresh.app.request(
      new Request("https://inbox.salaorosa.pt/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OWNER }),
      }),
    );
    expect(link.status).toBe(200);
    expect(mail2.sent.map((m) => m.to[0])).toEqual([OWNER]);
  });
});
