import { createApiKey } from "@surfingdog/adapters";
import { schema } from "@surfingdog/core";
import { logMailOut, sha256Hex } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { logoPng } from "../../../packages/core/test/look-files";
import { ascii, concat, contains, SECRET_PLACE } from "../../../packages/core/test/trades-files";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The logo's doors through the whole app: the owner's upload, view and removal under /v1/owner, and
 * the copy every customer's page and email loads at /p/logo/<sha16>.<ext>, kept for good under a
 * name that changes with the picture. Node and workerd.
 */
const BASE = "https://inbox.example.org";
const T = Date.parse("2026-11-01T09:00:00Z");

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Studio Kalinda",
    domain: "studiokalinda.example",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    languages: ["en"],
    createdAt: T,
    updatedAt: T,
  });
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    baseUrl: BASE,
    secretKey: "look-routes-test-secret-0123456789abcdef",
    background: () => {},
    now: () => T,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  const crm = await createApiKey(db, { kind: "integration", name: "CRM", scopes: ["*"] });
  const put = (bytes: Uint8Array, key: string | null = owner.key) =>
    inbox.app.request(
      new Request(`${BASE}/v1/owner/look/logo`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: bytes as BodyInit,
      }),
    );
  const call = (method: string, path: string, key: string | null = owner.key) =>
    inbox.app.request(
      new Request(`${BASE}${path}`, { method, headers: key ? { authorization: `Bearer ${key}` } : {} }),
    );
  return { db, put, call, crm: crm.key };
}

type View = { doc: { look: { logo: { sha256: string; width: number; height: number } | null } } };

describe("the logo's doors", () => {
  it("take a PNG from the owner, and serve it cleaned to everyone, kept for good", async () => {
    const s = await setup();
    const res = await s.put(logoPng(160, 48));
    expect(res.status).toBe(200);
    const logo = ((await res.json()) as View).doc.look.logo;
    expect(logo).toMatchObject({ width: 160, height: 48 });
    const name = `${logo?.sha256.slice(0, 16)}.png`;

    const pub = await s.call("GET", `/p/logo/${name}`, null);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pub.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(pub.headers.get("content-disposition")).toBe("inline");
    expect(pub.headers.get("etag")).toBe(`"${logo?.sha256.slice(0, 16)}"`);
    const bytes = new Uint8Array(await pub.arrayBuffer());
    expect(await sha256Hex(bytes)).toBe(logo?.sha256);
    expect(contains(bytes, SECRET_PLACE)).toBe(false);

    // The owner app reads it through its own door, with its credentials.
    const mine = await s.call("GET", "/v1/owner/look/logo");
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-cache");
    expect(await sha256Hex(new Uint8Array(await mine.arrayBuffer()))).toBe(logo?.sha256);
    expect((await s.call("GET", "/v1/owner/look/logo", null)).status).toBe(401);
  });

  it("refuse what is not a picture, or too large, and anyone but the owner", async () => {
    const s = await setup();
    const svg = await s.put(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(svg.status).toBe(422);
    expect(((await svg.json()) as { detail: string }).detail).toBe("A logo is a PNG, JPEG or WebP picture.");
    expect((await s.put(new Uint8Array(600 * 1024))).status).toBe(413);
    expect((await s.put(concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(40)))).status).toBe(
      422,
    );
    expect((await s.put(logoPng(160, 48), null)).status).toBe(401);
    const key = await s.put(logoPng(160, 48), s.crm);
    expect(key.status).toBe(403);
    expect(((await key.json()) as { details: { reason: string } }).details.reason).toBe("owner_in_person");
    expect((await s.call("DELETE", "/v1/owner/look/logo", s.crm)).status).toBe(403);
    // Nothing refused left a file behind.
    const kept = await s.db.client.query({ sql: "SELECT count(*) FROM blobs WHERE kind = 'logo'", method: "all" });
    expect(Number(kept.rows[0]?.[0])).toBe(0);
  });

  it("answer nothing for a name that is not the logo's now, and nothing once it is removed", async () => {
    const s = await setup();
    const logo = ((await (await s.put(logoPng(160, 48))).json()) as View).doc.look.logo;
    const name = `${logo?.sha256.slice(0, 16)}.png`;
    for (const wrong of ["0123456789abcdef.png", `${logo?.sha256.slice(0, 16)}.jpg`, "logo.png", "..%2Fsettings"]) {
      const res = await s.call("GET", `/p/logo/${wrong}`, null);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("max-age=60");
    }
    const removed = await s.call("DELETE", "/v1/owner/look/logo");
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as View).doc.look.logo).toBeNull();
    expect((await s.call("GET", `/p/logo/${name}`, null)).status).toBe(404);
    expect((await s.call("GET", "/v1/owner/look/logo")).status).toBe(404);
  });
});
