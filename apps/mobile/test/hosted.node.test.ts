import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PhoneLink, readPhoneLink } from "../../../packages/core/src/phones/links";
import { type Runtime, startRuntime } from "../../../packages/hosted/test/harness";
import { InboxClient } from "../src/lib/client";
import { type Native, webNative } from "../src/lib/native";
import type { KV } from "../src/lib/offline";
import { type Fetch, type InboxEntry, Sessions } from "../src/lib/session";

/**
 * The phone app with an inbox we host (ADR-003 Amendment 1), through the real router and shards: an
 * owner connects the phone while the inbox is at its setup address, then puts it live at the
 * business's own name. The setup address then answers the phone's doors 404, naming the new address;
 * the phone follows it there, with its keys and tokens, and nothing to connect again.
 */
let rt: Runtime;
beforeAll(async () => {
  rt = await startRuntime();
});
afterAll(async () => {
  await rt.close();
});

function memory(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

/** Native HTTP from the phone, to whichever host the router answers for. */
const phoneFetch: Fetch = async (input, init) => {
  const u = new URL(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const r = await rt.http(u.host, init?.method ?? "GET", `${u.pathname}${u.search}`, {
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  return new Response([204, 205, 304].includes(r.status) ? null : r.text, { status: r.status, headers: r.headers });
};

async function connectAtSetup() {
  const t = await rt.createTenant();
  const slug = `https://${t.slugHost}`;
  const cookie = await rt.signIn(t, t.slugHost);
  const owner = (method: string, path: string) =>
    rt.http(t.slugHost, method, path, { headers: { cookie, origin: slug, accept: "application/json" } });
  const made = await owner("POST", "/v1/owner/phones/pairings");
  expect(made.status).toBe(201);
  const { id, qr } = made.json as { id: string; qr: string };
  const link = readPhoneLink(qr) as PhoneLink;
  expect(link.origin).toBe(slug);
  const p: Native = webNative(memory());
  const sessions = new Sessions(p, phoneFetch);
  const pending = await sessions.pair(link);
  expect((await owner("POST", `/v1/owner/phones/pairings/${id}/confirm`)).status).toBe(200);
  expect(await sessions.confirmed(pending)).toBe("confirmed");
  const entry = await sessions.finish(pending);
  expect((await new InboxClient(entry, sessions, phoneFetch).items("all")).items).toEqual([]);
  return { t, p, entry, slug };
}

describe("a hosted inbox the phone was connected to at its setup address", () => {
  it("is followed to the business's own name once it is live, keys, tokens and all", async () => {
    const { t, p, entry, slug } = await connectAtSetup();
    await rt.setState(t, "live", { ownResolves: true });
    const own = `https://${t.ownHost}`;
    // The setup address no longer serves the phone, and says where the inbox is now.
    const old = await phoneFetch(`${slug}/v1/owner/items`, { headers: { accept: "application/json" } });
    expect(old.status).toBe(404);
    expect(((await old.json()) as { details?: { moved_to?: string } }).details?.moved_to).toBe(own);
    // The app opens again later: nothing in memory, the access token gone, only what the phone keeps.
    const sessions = new Sessions(p, phoneFetch);
    const moves: [string, string][] = [];
    sessions.onMove((e, from) => moves.push([from, e.origin]));
    const client = new InboxClient(entry, sessions, phoneFetch);
    expect((await client.items("all")).items).toEqual([]);
    expect(client.entry.origin).toBe(own);
    expect(moves).toEqual([[slug, own]]);
    // Kept on the phone, under the same alias: the notifications it opens name the new address too.
    const kept = (await sessions.list()) as InboxEntry[];
    expect(kept.map((e) => [e.alias, e.origin])).toEqual([[entry.alias, own]]);
    expect((await client.me()).phone.confirmed).toBe(true);
    // A client made from the old entry (a screen that kept it) follows as well, with no second move.
    expect((await new InboxClient(entry, sessions, phoneFetch).items("needs")).items).toEqual([]);
    expect(moves).toHaveLength(1);
  });

  it("signs out at the new address when the owner removes the inbox from the phone", async () => {
    const { t, p, entry } = await connectAtSetup();
    await rt.setState(t, "live", { ownResolves: true });
    const cookie = await rt.signIn(t, t.ownHost ?? "");
    const phones = async () => {
      const r = await rt.http(t.ownHost ?? "", "GET", "/v1/owner/phones", {
        headers: { cookie, accept: "application/json" },
      });
      return (r.json as { phones: { id: string }[] }).phones.map((x) => x.id);
    };
    expect(await phones()).toEqual([entry.deviceId]);
    await new Sessions(p, phoneFetch).remove(entry);
    // The inbox forgot the phone, so it sends it nothing more; the phone forgot the inbox.
    expect(await phones()).toEqual([]);
    expect(await new Sessions(p, phoneFetch).list()).toEqual([]);
  });

  it("is signed out when the owner removed the phone at the new address before it opened again", async () => {
    const { t, p, entry } = await connectAtSetup();
    await rt.setState(t, "live", { ownResolves: true });
    const own = t.ownHost ?? "";
    const cookie = await rt.signIn(t, own);
    const removed = await rt.http(own, "DELETE", `/v1/owner/phones/${entry.deviceId}`, {
      headers: { cookie, origin: `https://${own}`, accept: "application/json" },
    });
    expect(removed.status).toBe(200);
    // The app then wipes the inbox from the phone and says so, as for any phone removed on the computer.
    await expect(new InboxClient(entry, new Sessions(p, phoneFetch), phoneFetch).items("all")).rejects.toMatchObject({
      code: "signed_out",
    });
  });

  it("moves nowhere when the address named is not the inbox that issued the phone's tokens", async () => {
    const { t, p, entry, slug } = await connectAtSetup();
    const other = await rt.createTenant();
    await rt.setState(other, "live", { ownResolves: true });
    const sessions = new Sessions(p, phoneFetch);
    // Another inbox's address: it does not know this phone's refresh token, so nothing moves.
    await expect(sessions.follow(entry, `https://${other.ownHost}`)).rejects.toMatchObject({ code: "signed_out" });
    expect((await sessions.list()).map((e) => e.origin)).toEqual([slug]);
    // And the phone still opens its own inbox where it is.
    expect((await new InboxClient(entry, sessions, phoneFetch).items("all")).items).toEqual([]);
    expect(t.slugHost).toBeTruthy();
  });
});
