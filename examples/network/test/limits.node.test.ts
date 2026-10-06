import { describe, expect, it } from "vitest";
import { createNetwork } from "../src/app";
import { httpManifestFetcher, publicAddress } from "../src/manifest";

/**
 * The example network's two outside edges: what it reads (a manifest, only from a public address,
 * checked as the connection is made) and what it takes (a body of at most 64 KB, cut as it arrives).
 */

describe("the addresses a manifest is read from", () => {
  it("takes public IPv4 and global IPv6", () => {
    for (const ip of ["93.184.215.14", "8.8.8.8", "2606:4700::1111", "2a00:1450:4001::200e"]) {
      expect(publicAddress(ip), ip).toBe(true);
    }
  });

  it("leaves out every private, special and embedded range", () => {
    for (const ip of [
      "0.1.2.3",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::7f00:1",
      "::a00:1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "100::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "2002:7f00:1::1",
      "not an address",
    ]) {
      expect(publicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a name that resolves to this machine, without saying what answered", async () => {
    const fetchManifest = httpManifestFetcher();
    expect(await fetchManifest("localhost")).toEqual({
      ok: false,
      error: "the domain does not resolve to a public address",
    });
    expect(await fetchManifest("127.0.0.1")).toEqual({
      ok: false,
      error: "the domain does not resolve to a public address",
    });
  });
});

describe("the bodies the network takes", () => {
  const network = () =>
    createNetwork({ origin: "https://network.example.org", fetchManifest: async () => ({ ok: false, error: "none" }) });
  const big = JSON.stringify({ domain: "a.example.com", pad: "x".repeat(70 * 1024) });

  it("refuses a declared length over 64 KB before reading it", async () => {
    const res = await network().app.fetch(
      new Request("https://network.example.org/v1/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(big.length) },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too_large");
  });

  it("cuts a body with no length once it passes 64 KB, without reading the rest", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
      },
    });
    const res = await network().app.fetch(
      new Request("https://network.example.org/v1/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: endless,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("still takes a small body", async () => {
    const res = await network().app.fetch(
      new Request("https://network.example.org/v1/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "a.example.com" }),
      }),
    );
    expect(res.status).toBe(202);
  });
});
