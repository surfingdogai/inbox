import { type Caller, Capabilities, createDb, MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { makeClient } from "./harness";

/**
 * The signed ping's standing (ADR-017 §7.3), as a live instance meets it on upgrade: every network's
 * status row keeps what it said, with no standing until a signed ping is answered, and a second
 * run changes nothing. Runs on Node and in workerd.
 */
const NET = "https://network.surfingdog.ai";
const T0 = Date.parse("2026-09-23T09:00:00Z");
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
};

describe("upgrading to the signed ping", () => {
  // First in the file: on workerd a file starts with an empty database, and this one needs it.
  it("keeps each network's status and adds an empty standing", async () => {
    const client = await makeClient();
    expect(
      await runMigrations(
        client,
        MIGRATIONS.filter((m) => m.name < "0010_standing"),
      ),
    ).toBe(10);
    await client.batch([
      {
        sql: "INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', 1, ?, 2, ?)",
        params: [JSON.stringify({ networks: { [NET]: { enabled: true } } }), T0],
        method: "run",
      },
      {
        sql: `INSERT INTO network_status (network, registration, registered_at, last_ping_at, failures, rules_version,
                rules_next_version, rules_next_at, rules_checked_at, updated_at)
              VALUES (?, 'registered', ?, ?, 0, 2, 3, ?, ?, ?)`,
        params: [NET, T0 - 86_400_000, T0, Date.parse("2026-10-09T00:00:00Z"), T0, T0],
        method: "run",
      },
    ]);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(await runMigrations(client, MIGRATIONS)).toBe(MIGRATIONS.length);

    const caps = new Capabilities(createDb(client));
    const [view] = (await caps.getNetworks(owner)).networks;
    expect(view).toMatchObject({
      origin: NET,
      enabled: true,
      registration: "registered",
      last_ping_at: new Date(T0).toISOString(),
      rules: { version: 2, next: 3, v2: true },
      standing: null,
      ping_signature: null,
    });
  });
});
