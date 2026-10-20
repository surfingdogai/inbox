import { readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { clientAddress } from "@surfingdog/adapters";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientAddressFrom, setClientAddress, withClientAddress } from "../src/node-server";

/**
 * INBOX_CLIENT_ADDRESS_HEADER: behind a platform's proxy that passes a CF-Connecting-IP the caller
 * wrote straight through (Fly.io's, Traefik on Coolify, Railway's edge), the inbox takes each
 * caller's address from the header that proxy sets itself, or from the connection, so no caller
 * gets a fresh bucket for every limit by writing a header.
 */
describe("where a caller's address comes from", () => {
  it("is read from the setting: a header's name, socket, or nothing", () => {
    expect(clientAddressFrom(undefined)).toEqual({ source: null, bad: null });
    expect(clientAddressFrom("  ")).toEqual({ source: null, bad: null });
    expect(clientAddressFrom("Fly-Client-IP")).toEqual({
      source: { kind: "header", name: "fly-client-ip" },
      bad: null,
    });
    expect(clientAddressFrom("socket")).toEqual({ source: { kind: "socket" }, bad: null });
    // A mistyped value stops the server rather than leave the limits open without a word.
    expect(clientAddressFrom("x real ip")).toEqual({ source: null, bad: "x real ip" });
    expect(clientAddressFrom("x-real-ip:")).toMatchObject({ bad: "x-real-ip:" });
  });

  it("replaces what the caller wrote with what the proxy or the connection says", () => {
    const forged = () =>
      new Headers({ "cf-connecting-ip": "198.51.100.66", "x-forwarded-for": "198.51.100.67, 10.0.0.1" });
    const viaFly = forged();
    viaFly.set("fly-client-ip", "203.0.113.9");
    setClientAddress(viaFly, { kind: "header", name: "fly-client-ip" }, "10.0.0.1");
    expect(viaFly.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(viaFly.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(clientAddress(new Request("https://inbox.example/", { headers: viaFly }))).toBe("203.0.113.9");

    const direct = forged();
    setClientAddress(direct, { kind: "socket" }, "203.0.113.10");
    expect(direct.get("cf-connecting-ip")).toBe("203.0.113.10");

    // No address to be had: neither header is left, so every such caller shares one bucket.
    const none = forged();
    setClientAddress(none, { kind: "header", name: "x-real-ip" }, "10.0.0.1");
    expect(none.has("cf-connecting-ip")).toBe(false);
    expect(none.has("x-forwarded-for")).toBe(false);
    expect(clientAddress(new Request("https://inbox.example/", { headers: none }))).toBe("unknown");
  });

  it("is set on the Node server's own requests, before the app sees them", { timeout: 10_000 }, async () => {
    const app = new Hono().get("/", (c) => c.text(clientAddress(c.req.raw)));
    const server = serve({ fetch: withClientAddress(app.fetch, { kind: "socket" }), port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { "cf-connecting-ip": "198.51.100.66" } });
      expect(await res.text()).toBe("127.0.0.1");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/node.ts"), "utf8");
    expect(source).toContain("withClientAddress(app.fetch, clientAddress.source)");
  });
});
