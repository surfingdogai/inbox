import { type Caller, MANIFEST_PATH, type Manifest, manifestSchema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * An owner who leaves the directories says so to every network at once, in the manifest
 * (`directory.listed`). Node and workerd.
 */
const ORIGIN = "https://inbox.example.com";
const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);
const owner: Caller = {
  actor: { kind: "owner", id: "u1", channel: "owner_ui" },
  tier: "verified_principal",
  sandbox: false,
  now: () => NOW,
};

async function setup() {
  const db = await freshDb();
  const inbox = createInbox({ db, now: () => NOW });
  const manifest = async (): Promise<Manifest> => {
    const res = await inbox.app.request(`${ORIGIN}${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    return manifestSchema.parse(await res.json());
  };
  return { db, caps: inbox.caps, manifest };
}

describe("the manifest's directory flag", () => {
  const A = "https://network.example.com";
  const B = "https://other.example.org";

  it("is absent while the business is listed", async () => {
    const s = await setup();
    expect((await s.manifest()).directory).toBeUndefined();
    await s.caps.updateSettings(owner, { doc: { networks: { [A]: { enabled: true } } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });

  it("says listed: false when the owner leaves the directories, and nothing once they come back", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, { doc: { directory: { listed: false } } });
    expect((await s.manifest()).directory).toEqual({ listed: false });
    await s.caps.updateSettings(owner, { doc: { directory: { listed: true } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });

  it("says listed: false when every network switched on is kept from the listing", async () => {
    const s = await setup();
    await s.caps.updateSettings(owner, {
      doc: {
        networks: {
          [A]: { enabled: true, share: { listing: false } },
          [B]: { enabled: true, share: { listing: false } },
        },
      },
    });
    expect((await s.manifest()).directory).toEqual({ listed: false });
    // One of them listing it again: the manifest cannot say both, so it says listed, and the
    // signed listing call tells the other.
    await s.caps.updateSettings(owner, { doc: { networks: { [B]: { share: { listing: true } } } } });
    expect((await s.manifest()).directory).toBeUndefined();
  });
});
