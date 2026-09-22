import { MANIFEST_PATH } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { freshDb } from "./harness";

// Runs on Node and inside workerd — the app must behave identically on both.
describe("app", () => {
  it("answers /healthz", async () => {
    const res = await createApp({ db: await freshDb() }).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("publishes the discovery manifest with every door", async () => {
    const res = await createApp({ db: await freshDb() }).request(`https://inbox.example.com${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: string; item_types: string[]; protocols: Record<string, string> };
    expect(body.instance).toBe("https://inbox.example.com");
    expect(body.item_types).toEqual(["message", "quote_request", "booking", "order"]);
    expect(body.protocols).toEqual({
      openapi: "https://inbox.example.com/openapi.json",
      rest: "https://inbox.example.com/v1",
      mcp: "https://inbox.example.com/mcp",
      mcp_owner: "https://inbox.example.com/mcp/owner",
    });
  });

  it("returns typed 404s", async () => {
    const res = await createApp({ db: await freshDb() }).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("security headers", () => {
  // Every response carries them — the owner app, the API and the discovery documents — and none of
  // the ones that would break a cross-origin load or the owner MCP's OAuth window.
  it("are on the API, the manifest and the owner routes alike", async () => {
    const app = createApp({ db: await freshDb() });
    for (const path of ["/healthz", MANIFEST_PATH, "/v1/business", "/v1/owner/items", "/openapi.json"]) {
      const res = await app.request(`https://inbox.example.com${path}`);
      const h = res.headers;
      expect(h.get("x-frame-options"), path).toBe("DENY");
      expect(h.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
      expect(h.get("x-content-type-options"), path).toBe("nosniff");
      expect(h.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(h.get("strict-transport-security"), path).toBe("max-age=15552000");
      expect(h.get("cross-origin-resource-policy"), path).toBeNull();
      expect(h.get("cross-origin-opener-policy"), path).toBeNull();
    }
  });
});
