import { env, SELF } from "cloudflare:test";
import { MANIFEST_PATH } from "@surfingdog/core";
import { describe, expect, it } from "vitest";

// Exercises the real Worker entry inside workerd with the bindings declared in wrangler.jsonc.
describe("worker", () => {
  it("serves the manifest through the fetch handler", async () => {
    const res = await SELF.fetch(`https://example.com${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("has its platform bindings", async () => {
    expect(env.DB).toBeDefined();
    expect(env.BLOBS).toBeDefined();
    expect(env.JOBS).toBeDefined();
    // D1 hides sqlite_version(); check the features the core relies on instead.
    await env.DB.exec("CREATE VIRTUAL TABLE IF NOT EXISTS t USING fts5(body)");
    await env.DB.prepare("INSERT INTO t VALUES (?)").bind("confirm the booking for tuesday").run();
    const hit = await env.DB.prepare("SELECT count(*) AS c FROM t WHERE t MATCH ?")
      .bind("booking")
      .first<{ c: number }>();
    expect(hit?.c).toBe(1);
    const j = await env.DB.prepare("SELECT json_extract('{\"type\":\"booking\"}', '$.type') AS t").first<{
      t: string;
    }>();
    expect(j?.t).toBe("booking");
  });
});
