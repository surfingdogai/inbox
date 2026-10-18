import { createApiKey } from "@surfingdog/adapters";
import { discoverySnippets, schema } from "@surfingdog/core";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * Settings → Be found (ADR-022) through the owner's API: the lines for the business's own site, and
 * Surfing Dog's checker asked only when the owner asks, with one GET that follows no redirect and an
 * answer held to the published schema. The network is a recorded answer: nothing leaves the test.
 */
const BASE = "https://inbox.oficinamare.pt";
const T0 = Date.parse("2026-10-18T09:00:00Z");

/** What the network's GET /v1/discovery/{domain} answered for a site with one way in place (recorded). */
const ANSWER = {
  domain: "oficinamare.pt",
  host: "inbox.oficinamare.pt",
  manifest: "https://inbox.oficinamare.pt/.well-known/agent-inbox.json",
  checked_at: "2026-10-18T09:00:01.250Z",
  ready: false,
  ways: 1,
  next: "Add this to https://oficinamare.pt/robots.txt, above any other group:\n\nUser-agent: Claude-User\nAllow: /\n",
  items: [
    { id: "cname", need: "required", state: "ok", detail: "inbox.oficinamare.pt points to k3x9.hosted.surfingdog.ai." },
    { id: "manifest", need: "required", state: "ok", detail: "The inbox answers at inbox.oficinamare.pt." },
    {
      id: "robots",
      need: "required",
      state: "blocked",
      detail: "robots.txt keeps out AI assistants that people use: Claude-User.",
      fix: "Add this to https://oficinamare.pt/robots.txt, above any other group:\n\nUser-agent: Claude-User\nAllow: /\n",
    },
    { id: "llms_txt", need: "recommended", state: "ok", detail: "llms.txt names the inbox." },
  ],
};

async function setup(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Oficina Maré",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    createdAt: T0,
    updatedAt: T0,
  });
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  const owner = await createApiKey(db, { kind: "owner", name: "test" });
  const inbox = createInbox({ db, baseUrl: BASE, background: () => {}, fetchImpl });
  const call = (method: string, path: string, body?: unknown) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${owner.key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Be found", () => {
  it("writes the lines for the website named in Settings, and calls nobody", async () => {
    const { call, calls } = await setup(() => json(ANSWER));
    expect(
      (await call("PUT", "/v1/owner/settings", { doc: { directory: { url: "https://www.oficinamare.pt/" } } })).status,
    ).toBe(200);
    const res = await call("GET", "/v1/owner/discovery");
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      domain: "oficinamare.pt",
      domainFrom: "website",
      host: "inbox.oficinamare.pt",
      name: "Oficina Maré",
    });
    expect(view.snippets).toEqual(discoverySnippets("oficinamare.pt", "inbox.oficinamare.pt", "Oficina Maré"));
    expect(calls).toHaveLength(0);
  });

  it("guesses the domain from the inbox's own name when no website is named, and says so", async () => {
    const { call } = await setup(() => json(ANSWER));
    const view = (await (await call("GET", "/v1/owner/discovery")).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ domain: "oficinamare.pt", domainFrom: "inbox" });
  });

  it("asks the checker once, for this domain and host, following no redirect", async () => {
    const { call, calls } = await setup(() => json(ANSWER));
    await call("PUT", "/v1/owner/settings", { doc: { directory: { url: "https://oficinamare.pt" } } });
    const res = await call("POST", "/v1/owner/discovery/check");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ANSWER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://network.surfingdog.ai/v1/discovery/oficinamare.pt?host=inbox.oficinamare.pt");
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  for (const [name, answer, status, words] of [
    ["an answer that is not a check", () => json({ ...ANSWER, ways: 9 }), 500, "not a check"],
    [
      "a redirect, never followed",
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      500,
      "could not run",
    ],
    ["a busy checker", () => json({ title: "Too many" }, 429), 429, "a moment ago"],
    [
      "a site that cannot be checked",
      () => json({ detail: "bakery.myshopify.com is an address at myshopify.com." }, 422),
      409,
      "myshopify.com",
    ],
    ["an answer too large", () => new Response("x".repeat(300_000), { status: 200 }), 500, "could not run"],
  ] as const) {
    it(`refuses ${name}, in the owner's words`, async () => {
      const { call, calls } = await setup(answer);
      const res = await call("POST", "/v1/owner/discovery/check");
      expect(res.status).toBe(status);
      expect(((await res.json()) as { detail: string }).detail).toContain(words);
      expect(calls).toHaveLength(1);
    });
  }
});
