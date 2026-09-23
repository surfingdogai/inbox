import { describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK,
  DEFAULT_SETTINGS,
  enabledNetworks,
  MAX_NETWORKS,
  parseStoredSettings,
} from "../src/settings/schema";
import { canonicalNetworkOrigin } from "../src/util/hosts";

/**
 * Networks keyed by origin (ADR-017 §8.1), as a stored document is read: the legacy
 * `network: {url, join}` pair becomes a map with one entry, bad keys and entries fall back
 * instead of failing the document, and no more than eight are ever read.
 */
const read = (doc: unknown) => parseStoredSettings(doc).settings.networks;
const all = { listing: true, counts: true, receipts: true };

describe("reading networks", () => {
  it("lists the default network, switched off, on a fresh document", () => {
    expect(DEFAULT_SETTINGS.networks).toEqual({ [DEFAULT_NETWORK]: { enabled: false, issue: true, share: all } });
    expect(enabledNetworks(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("migrates the live instance's legacy pair: joined, default URL, reporting as before", () => {
    const networks = read({ network: { url: "https://network.surfingdog.ai", join: true } });
    expect(networks).toEqual({ [DEFAULT_NETWORK]: { enabled: true, issue: true, share: all } });
    // A document written before `url` was stored explicitly means the same network.
    expect(read({ network: { join: true } })).toEqual(networks);
  });

  it("migrates join: false as a network that is listed and off", () => {
    expect(read({ network: { url: DEFAULT_NETWORK, join: false } })).toEqual({
      [DEFAULT_NETWORK]: { enabled: false, issue: true, share: all },
    });
  });

  it("migrates a custom URL to its origin, as the old jobs used it", () => {
    expect(read({ network: { url: "https://Directory.Example.com/v1/", join: true } })).toEqual({
      "https://directory.example.com": { enabled: true, issue: true, share: all },
    });
  });

  it("migrates a URL that never worked to no network at all", () => {
    for (const url of ["http://10.0.0.5:8080/x", "https://localhost", "https://directory.example.com:8443", "nope"]) {
      expect(read({ network: { url, join: true } })).toEqual({});
    }
  });

  it("ignores the legacy pair once there is a map", () => {
    expect(read({ network: { join: true }, networks: {} })).toEqual({});
  });

  it("drops keys that are not origins and falls back to off for an entry that does not parse", () => {
    const networks = read({
      networks: {
        "https://Good.Example.com/": { enabled: true },
        "http://plain.example.com": { enabled: true },
        "https://internal.local": { enabled: true },
        "https://broken.example.com": { enabled: "yes", share: 3 },
      },
      business: { name: "Kept" },
    });
    expect(networks).toEqual({
      "https://good.example.com": { enabled: true, issue: true, share: all },
      "https://broken.example.com": { enabled: false, issue: true, share: all },
    });
  });

  it("reads at most eight, switched-on ones first", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) many[`https://n${i}.example.com`] = { enabled: i >= 10 };
    const networks = read({ networks: many });
    expect(Object.keys(networks)).toHaveLength(MAX_NETWORKS);
    expect(networks["https://n10.example.com"]?.enabled).toBe(true);
    expect(networks["https://n11.example.com"]?.enabled).toBe(true);
  });

  it("names only switched-on networks that take receipts for the manifest", () => {
    const { settings } = parseStoredSettings({
      networks: {
        "https://b.example.com": { enabled: true },
        "https://a.example.com": { enabled: true },
        "https://quiet.example.com": { enabled: true, share: { receipts: false } },
        "https://off.example.com": { enabled: false },
      },
    });
    expect(enabledNetworks(settings, "receipts")).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(enabledNetworks(settings)).toHaveLength(3);
  });
});

describe("one bad stored value", () => {
  it("falls back alone, with its path reported", () => {
    const { settings, ignored } = parseStoredSettings({
      booking: { autoExpireHours: 0, holdOnPropose: true },
      business: { name: "Kept", languages: ["en", "x".repeat(40)] },
      networks: "not a map",
      testMode: true,
    });
    expect(settings.booking).toMatchObject({ autoExpireHours: 72, holdOnPropose: true });
    expect(settings.business).toMatchObject({ name: "Kept", languages: ["en"] });
    expect(settings.networks).toEqual(DEFAULT_SETTINGS.networks);
    expect(settings.testMode).toBe(true);
    expect(ignored.sort()).toEqual(["booking.autoExpireHours", "business.languages", "networks"]);
  });
});

describe("network origins", () => {
  it("are https on 443 with a public host and nothing after it", () => {
    expect(canonicalNetworkOrigin("https://Network.Example.com")).toBe("https://network.example.com");
    expect(canonicalNetworkOrigin("https://network.example.com:443/")).toBe("https://network.example.com");
    for (const bad of [
      "http://network.example.com",
      "https://network.example.com:444",
      "https://network.example.com/path",
      "https://network.example.com?q",
      "https://network.example.com#f",
      "https://a:b@network.example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://printer.local",
      "https://network",
      "",
    ]) {
      expect(canonicalNetworkOrigin(bad), bad).toBeNull();
    }
  });
});
