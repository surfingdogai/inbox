import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { buildDownload, DOWNLOAD_TABLES, downloadStrip, SEARCH_TABLES } from "../src/capabilities/download";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { crc32, zip } from "../src/util/zip";
import { makeClient } from "./harness";
import { unzip } from "./unzip";

/**
 * A download's parts that do not need a database file of their own, on both runtimes: the zip, and
 * the list that says what a download does with every table.
 */
describe("a zip", () => {
  it("has the CRC-32 every unzip tool checks", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("holds each file as it was, deflated when that is smaller, with UTF-8 names", async () => {
    const text = new TextEncoder().encode("Cortes e cor no Porto. ".repeat(200));
    const noise = crypto.getRandomValues(new Uint8Array(512));
    const bytes = await zip(
      [
        { name: "README.txt", data: text },
        { name: "salão.bin", data: noise },
        { name: "empty", data: new Uint8Array() },
      ],
      new Date("2026-10-12T14:03:00Z"),
    );
    expect(bytes.length).toBeLessThan(text.length);
    const files = await unzip(bytes);
    expect(files.map((f) => [f.name, f.method])).toEqual([
      ["README.txt", 8],
      ["salão.bin", 0],
      ["empty", 0],
    ]);
    expect(files[0]?.data).toEqual(text);
    expect(files[1]?.data).toEqual(noise);
    expect(files[2]?.data).toEqual(new Uint8Array());
  });
});

describe("what a download does with each table", () => {
  // The first database a file opens in workerd takes a while to load the runtime's modules.
  it("names every table the migrations make, so a new one holding a secret cannot slip into a download", {
    timeout: 60_000,
  }, async () => {
    const client = await makeClient();
    await runMigrations(client, MIGRATIONS);
    const { rows } = await client.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    });
    const tables = rows.map((r) => String(r[0])).filter((t) => !SEARCH_TABLES.test(t));
    expect(tables.filter((t) => !(t in DOWNLOAD_TABLES))).toEqual([]);
  });

  it("empties what lets someone in, and clears every sealed secret", () => {
    const strip = downloadStrip(Date.parse("2026-10-12T14:03:00Z"));
    for (const table of [
      "sessions",
      "login_tokens",
      "passkeys",
      "api_keys",
      "oauth_codes",
      "oauth_tokens",
      "rate_limits",
      "idempotency_keys",
      "customer_codes",
      "pending_identity",
      "jobs",
    ]) {
      expect(strip).toContain(`DELETE FROM ${table}`);
    }
    expect(strip.join("\n")).toMatch(/UPDATE signing_keys SET private_jwk_enc = ''/);
    expect(strip.join("\n")).toMatch(/UPDATE webhooks SET secret_enc = '', headers_enc = NULL, active = 0/);
    expect(strip.join("\n")).toMatch(/UPDATE connectors SET config_enc = NULL, inbound_token = NULL/);
    expect(strip.join("\n")).toContain("'$.email.inboundSecret'");
  });

  it("zips the copy with a README and a manifest that list every table and what was left out", async () => {
    const seen: string[][] = [];
    const db = new TextEncoder().encode("SQLite format 3\u0000 (a copy)");
    const d = await buildDownload(
      async (strip) => {
        seen.push([...strip]);
        return {
          bytes: db,
          tables: [
            { name: "items", rows: 12 },
            { name: "sessions", rows: 0 },
            { name: "search_fts", rows: 12 },
          ],
        };
      },
      {
        now: Date.parse("2026-10-12T14:03:00Z"),
        business: "Salão Rosa",
        address: "https://inbox.test",
        version: "0.1.0",
      },
    );
    expect(seen).toEqual([downloadStrip(Date.parse("2026-10-12T14:03:00Z"))]);
    expect(d.filename).toBe("salao-rosa-2026-10-12.zip");
    expect(d.manifest).toMatchObject({
      format: "surfingdog-inbox-download/1",
      business: { name: "Salão Rosa", address: "https://inbox.test" },
      database: { file: "inbox.db", bytes: db.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      tables: [
        { name: "items", rows: 12 },
        { name: "sessions", rows: 0, left_out: "Who is signed in." },
        { name: "search_fts", rows: 12 },
      ],
    });
    const files = await unzip(d.zip);
    expect(files.map((f) => f.name)).toEqual(["README.txt", "manifest.json", "inbox.db"]);
    expect(files[2]?.data).toEqual(db);
    expect(JSON.parse(new TextDecoder().decode(files[1]?.data))).toEqual(d.manifest);
    const readme = new TextDecoder().decode(files[0]?.data);
    expect(readme).toContain("Salão Rosa: a copy of its inbox");
    expect(readme).toContain("Downloaded 12 Oct 2026 at 14:03 UTC from https://inbox.test.");
    expect(readme).toContain("- sessions: Who is signed in.");
    expect(readme).toMatch(/items\s+12 rows/);
    expect(readme).toMatch(/search_fts\s+12 rows\s+the search index/);
  });
});
