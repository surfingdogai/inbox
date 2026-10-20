import { type ConnectorDefinition, gallery } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../../src/connectors/index";
import { CLIENT as APALEO_CLIENT } from "../fixtures/property/apaleo";
import { CLIENT as CLOUDBEDS_CLIENT } from "../fixtures/property/cloudbeds";
import { CLIENT_TOKEN } from "../fixtures/property/mews";

/**
 * The property systems that need a partner account (ADR-033 §8.4): registered in every release, and
 * until their operator holds the partner's credentials each says **Needs setup** on the Property system
 * card, with the reason and where it is explained, and nothing to press. With them, each is a way to
 * connect like any other. A business that is not a place to stay never sees the card.
 */

const GATED = ["mews", "apaleo", "cloudbeds"] as const;

function defs(list: ConnectorDefinition[]): Map<string, ConnectorDefinition> {
  return new Map(list.map((d) => [d.kind, d]));
}

describe("Mews, apaleo and Cloudbeds without a partner account", () => {
  for (const hosted of [true, false]) {
    it(`say Needs setup with nothing to press (${hosted ? "hosted" : "on one's own server"})`, () => {
      const cards = gallery(defs(builtInConnectors({ hosted })), { lean: "stays" });
      const card = cards.find((c) => c.id === "property");
      expect(card).toBeDefined();
      // Nothing on the card can be pressed: no way of it is ready here.
      expect(card?.status).toBe("soon");
      expect(card?.ways.some((w) => w.status === "ready")).toBe(false);
      for (const kind of GATED) {
        const way = card?.ways.find((w) => w.kind === kind);
        expect(way?.status, kind).toBe("setup");
        expect(way?.form, kind).toEqual([]);
        expect(way?.before, kind).toBeUndefined();
        expect(way?.href, kind).toBe(`https://surfingdog.ai/docs/connectors/${kind}/`);
        expect(way?.hint, kind).toMatch(hosted ? /does not have yet/ : /on this server/);
        expect(way?.hint, kind).toMatch(/calendar link/);
        // Never a promise: no "applying", no "soon", no date.
        expect(way?.hint, kind).not.toMatch(/applying|soon|\d{4}/i);
      }
    });
  }

  it("are each not ready, with the reason", () => {
    for (const d of builtInConnectors({}).filter((x) => (GATED as readonly string[]).includes(x.kind))) {
      expect(d.ready?.(), d.kind).toMatch(/partner|connect client/);
      expect(d.group).toBe("lodging");
      expect(d.capabilities).toEqual(["stay_inventory", "write_stays", "stay_events"]);
    }
  });

  it("are never shown to a business that is not a place to stay", () => {
    for (const lean of [null, "shop", "appointments"] as const) {
      const cards = gallery(defs(builtInConnectors({ hosted: true })), { lean });
      expect(cards.some((c) => c.ways.some((w) => (GATED as readonly string[]).includes(w.kind)))).toBe(false);
    }
  });
});

describe("with the partner's credentials on the server", () => {
  it("each is a way to connect: Mews by the property's token, apaleo and Cloudbeds by signing in", () => {
    const list = builtInConnectors({
      partners: { mews: { clientToken: CLIENT_TOKEN }, apaleo: APALEO_CLIENT, cloudbeds: CLOUDBEDS_CLIENT },
    });
    const card = gallery(defs(list), { lean: "stays" }).find((c) => c.id === "property");
    expect(card?.status).toBe("ready");
    const way = (kind: string) => card?.ways.find((w) => w.kind === kind);
    expect(way("mews")).toMatchObject({ status: "ready", auth: "form" });
    expect(way("mews")?.form.map((f) => [f.key, f.secret])).toEqual([["access_token", true]]);
    expect(way("apaleo")).toMatchObject({ status: "ready", auth: "oauth", action: "Continue with apaleo" });
    expect(way("cloudbeds")).toMatchObject({ status: "ready", auth: "oauth", action: "Continue with Cloudbeds" });
  });

  it("a property's own credentials stay off unless the operator switches them on", () => {
    const off = defs(builtInConnectors({}));
    expect(
      off
        .get("apaleo")
        ?.presets?.find((p) => p.id === "own_client")
        ?.ready?.(),
    ).not.toBe(true);
    expect(
      off
        .get("cloudbeds")
        ?.presets?.find((p) => p.id === "property_key")
        ?.ready?.(),
    ).not.toBe(true);
    const on = defs(builtInConnectors({ partners: { apaleoOwnClient: true, cloudbedsPropertyKey: true } }));
    expect(on.get("apaleo")?.ready?.()).toBe(true);
    expect(on.get("apaleo")?.auth).toBe("form");
    expect(on.get("cloudbeds")?.ready?.()).toBe(true);
    expect(on.get("cloudbeds")?.auth).toBe("form");
  });
});
