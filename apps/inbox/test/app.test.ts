import { MANIFEST_PATH } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

// Runs on Node and inside workerd — the app must behave identically on both.
describe("app", () => {
  it("answers /healthz", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("publishes the discovery manifest with the instance URL", async () => {
    const res = await createApp().request(`https://inbox.example.com${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: string; item_types: string[] };
    expect(body.instance).toBe("https://inbox.example.com");
    expect(body.item_types).toEqual([]);
  });

  it("returns typed 404s", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});
