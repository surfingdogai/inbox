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

  it("answers the page a link in the business's email opens, never the owner app", async () => {
    const res = await SELF.fetch("https://example.com/c/not-a-real-token", { headers: { "accept-language": "pt-PT" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain("Esta ligação não é válida.");
  });

  it("answers the page about the booking network too, never the owner app", async () => {
    const res = await SELF.fetch("https://example.com/c/privacy?l=en");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("How we recognise returning customers");
    expect(html).not.toContain("<script");
  });

  it("answers /demo itself, and has no live view on an instance that is not a demo", async () => {
    const res = await SELF.fetch("https://example.com/demo/live");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("has its platform bindings", async () => {
    expect(env.DB).toBeDefined();
    // Email out: the binding the Deploy to Cloudflare button adds, so MAIL_FROM is all it needs.
    expect(env.EMAIL).toBeDefined();
    expect(env.JOBS).toBeDefined();
    // Nothing stores files, so the button asks nobody to switch on R2.
    expect("BLOBS" in env).toBe(false);
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
