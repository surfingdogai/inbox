import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerVerdict } from "../src/allowlist";
import { readConfig } from "../src/config";
import { RELAY_PATH, relayRedirect, relayTarget } from "../src/oauth-relay";
import { type Runtime, startRuntime } from "./harness";

/**
 * One address for every hosted inbox's Google sign-in (ADR-022): the router passes the owner on to the
 * inbox the state names, and only to a name it knows as an inbox.
 */
const RELAY = "connect.example.org";
const b64 = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime({ oauthRelayHost: RELAY });
});
afterAll(async () => {
  await rt.close();
});

describe("the Google sign-in relay", () => {
  it("names the one redirect address inboxes ask Google for", () => {
    expect(relayRedirect(RELAY)?.("google_calendar")).toBe(`https://${RELAY}${RELAY_PATH}`);
    expect(relayRedirect(RELAY)?.("other")).toBeUndefined();
    expect(relayRedirect(undefined)).toBeUndefined();
  });

  it("reads the inbox from the state, and nothing that is not an https origin", () => {
    const q = `?state=${b64("https://inbox.salon.example.com")}.secret&code=4%2F0Ab&scope=x`;
    expect(relayTarget(q)).toEqual({
      host: "inbox.salon.example.com",
      location: `https://inbox.salon.example.com/oauth/connect/google_calendar/callback${q}`,
    });
    for (const origin of [
      "http://inbox.example.com",
      "https://inbox.example.com:8443",
      "https://inbox.example.com/x",
      "javascript:alert(1)",
      "https://user@inbox.example.com",
    ]) {
      expect(relayTarget(`?state=${b64(origin)}.s&code=c`), origin).toBeNull();
    }
    expect(relayTarget("?state=nodot&code=c")).toBeNull();
    expect(relayTarget("?code=c")).toBeNull();
  });

  it("passes the owner on to their inbox's own callback, and refuses a name that is no inbox", async () => {
    const t = await rt.createTenant();
    const q = `?state=${b64(`https://${t.slugHost}`)}.s3cret&code=4%2F0Ab-code`;
    const r = await rt.http(RELAY, "GET", `${RELAY_PATH}${q}`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`https://${t.slugHost}/oauth/connect/google_calendar/callback${q}`);
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    const elsewhere = await rt.http(RELAY, "GET", `${RELAY_PATH}?state=${b64("https://evil.example.com")}.s&code=c`);
    expect(elsewhere.status).toBe(400);
    expect((await rt.http(RELAY, "GET", "/anything-else")).status).toBe(404);
    expect((await rt.http(RELAY, "POST", RELAY_PATH)).status).toBe(404);
  });

  it("lets the owner's browser back in below level 2, with a session only", () => {
    const cookie = "__Host-sdi_session=abc";
    expect(ownerVerdict({ method: "GET", path: "/oauth/connect/google_calendar/callback", cookie })).toBe("allow");
    expect(ownerVerdict({ method: "GET", path: "/oauth/connect/google_calendar/callback" })).toBe("refuse");
    expect(ownerVerdict({ method: "POST", path: "/oauth/connect/google_calendar/callback", cookie })).toBe("refuse");
    expect(ownerVerdict({ method: "GET", path: "/oauth/connect/../token", cookie })).toBe("refuse");
  });

  it("takes the Google client and the relay from the environment, both or neither", () => {
    const base = {
      HOSTED_SLUG_PARENT: "example.net",
      HOSTED_SHARD_KEY: "s".repeat(40),
      HOSTED_CP_SHARD_KEY: "c".repeat(40),
      HOSTED_CP_SOCKET: "/tmp/cp.sock",
      HOSTED_MASTER_KEY: "m".repeat(40),
      HOSTED_DATA_DIR: "/tmp/data",
      HOSTED_SHARD_SOCKET_DIR: "/tmp",
    };
    expect(readConfig(base, "shard").google).toBeNull();
    const c = readConfig(
      {
        ...base,
        GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com",
        GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-x",
        HOSTED_OAUTH_RELAY_HOST: "Connect.Example.Org",
      },
      "shard",
    );
    expect(c.google).toEqual({ clientId: "id.apps.googleusercontent.com", clientSecret: "GOCSPX-x" });
    expect(c.oauthRelayHost).toBe("connect.example.org");
    expect(() => readConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: "id" }, "shard")).toThrow(/go together/);
  });
});
