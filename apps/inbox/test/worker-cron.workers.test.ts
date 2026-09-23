import { createScheduledController, env } from "cloudflare:test";
import { MIGRATIONS } from "@surfingdog/core";
import { runMigrations } from "@surfingdog/platform";
import { d1Client } from "@surfingdog/platform/cloudflare";
import { describe, expect, it } from "vitest";
import worker from "../src/worker";

/**
 * On Workers, migrations used to run only on the first HTTP request after a deploy. The cron runs
 * the job outbox without one, so the first ticks after an upgrade met tables the new version needs
 * and the database did not have yet (the networks' tables, 0006): network jobs failed, and receipt
 * jobs queued before the deploy spent their attempts on it. Cron migrates first, as Node does at boot.
 */
describe("the worker's cron after a deploy", () => {
  it("brings a database the previous version left up to date before it runs a job", async () => {
    const previous = MIGRATIONS.filter((m) => m.name !== "0006_networks");
    expect(previous).toHaveLength(MIGRATIONS.length - 1);
    await runMigrations(d1Client(env.DB as Parameters<typeof d1Client>[0]), previous);

    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env);

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('network_publications', 'network_status') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["network_publications", "network_status"]);
    // And the hourly tick ran.
    const tick = await env.DB.prepare("SELECT status FROM jobs WHERE kind = 'network_ping' AND status = 'done'").all();
    expect(tick.results.length).toBeGreaterThan(0);
  });
});
