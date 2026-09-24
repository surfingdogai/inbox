import { readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { NODE_SERVER_OPTIONS } from "../src/node-server";

/**
 * A client that sends its body a byte at a time. Node's own defaults wait five minutes for a
 * request and look only every thirty seconds, so a few thousand such clients hold the server; the
 * Node host closes them within a minute instead.
 */
describe("the Node server and a slow client", () => {
  it("is started with timeouts a trickled body cannot outlast", () => {
    expect(NODE_SERVER_OPTIONS.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(NODE_SERVER_OPTIONS.headersTimeout).toBeLessThanOrEqual(NODE_SERVER_OPTIONS.requestTimeout);
    expect(NODE_SERVER_OPTIONS.connectionsCheckingInterval).toBeLessThanOrEqual(5_000);
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/node.ts"), "utf8");
    expect(source).toMatch(/serve\(\s*\{[^}]*serverOptions:\s*NODE_SERVER_OPTIONS/);
  });

  it("closes a connection whose body never finishes", { timeout: 10_000 }, async () => {
    const app = new Hono().post("/", async (c) => c.text(String((await c.req.text()).length)));
    // The same options, scaled down so the test does not wait a minute.
    const server = serve({
      fetch: app.fetch,
      port: 0,
      hostname: "127.0.0.1",
      serverOptions: {
        ...NODE_SERVER_OPTIONS,
        requestTimeout: 400,
        headersTimeout: 300,
        connectionsCheckingInterval: 50,
      },
    });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    const started = Date.now();
    const closedAfter = await new Promise<number>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nx");
        const drip = setInterval(() => socket.write("x"), 100);
        socket.on("close", () => {
          clearInterval(drip);
          resolve(Date.now() - started);
        });
      });
      socket.on("error", () => undefined);
    });
    await new Promise((resolve) => server.close(resolve));
    expect(closedAfter).toBeLessThan(3_000);
  });
});
