import { runMigrations, sha256Hex } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { sweepFiles } from "../src/attachments/store";
import { Capabilities } from "../src/capabilities/service";
import { createDb, type Db } from "../src/db";
import { LookCapabilities } from "../src/look/capability";
import { isTooLarge, LOGO_MAX_BYTES, LOGO_WORDS, prepareLogo, readLogo } from "../src/look/logo";
import { imageSize } from "../src/look/size";
import { MIGRATIONS } from "../src/schema/migrations.generated";
import { readSettings } from "../src/settings/schema";
import type { Caller, Principal } from "../src/write/index";
import { makeClient, resetTables } from "./harness";
import { jpeg, logoPng, riff, segment, vp8, vp8l, vp8x, webpChunk } from "./look-files";
import { ascii, concat, contains, heic, pdf, SECRET_PLACE } from "./trades-files";

/**
 * The business's logo: its size read from the header alone, what is taken and what is refused (never
 * from a name or a declared type), and how it is kept: one row of its own that no sweep, allowance
 * or erasure touches, replaced and removed only by the owner in person. Pictures built byte by byte.
 * Node and workerd.
 */
const T0 = Date.parse("2026-11-01T10:00:00Z");

const principal = (p: Partial<Principal> & Pick<Principal, "via" | "id">): Principal => ({
  name: "p",
  scopes: ["*"],
  userId: null,
  ...p,
});
const at = (now: number): Caller => ({
  actor: { kind: "owner", id: "user_1", channel: "owner_ui" },
  principal: principal({ via: "session", id: "sess_1", name: "owner@example.com", userId: "user_1" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => now,
});
const owner = at(T0);
const claude: Caller = {
  actor: { kind: "owner_ai", id: "client_claude", channel: "mcp_owner" },
  actsAs: "owner",
  principal: principal({ via: "oauth", id: "client_claude", name: "Claude", userId: "user_1" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};
const zapier: Caller = {
  actor: { kind: "integration", id: "key_zap", channel: "rest" },
  principal: principal({ via: "api_key", keyKind: "integration", id: "key_zap", name: "Zapier" }),
  tier: "verified_principal",
  sandbox: false,
  now: () => T0,
};

async function setup() {
  const db = createDb(await makeClient());
  await runMigrations(db.client, MIGRATIONS);
  await resetTables(db.client);
  return { db, caps: new Capabilities(db) };
}

async function logoRows(db: Db): Promise<{ key: string; expires: unknown; item: unknown; party: unknown }[]> {
  const { rows } = await db.client.query({
    sql: "SELECT key, expires_at, item_id, party_id FROM blobs WHERE kind = 'logo' ORDER BY key",
    params: [],
    method: "all",
  });
  return rows.map((r) => ({ key: String(r[0]), expires: r[1], item: r[2], party: r[3] }));
}

async function chunkKeys(db: Db): Promise<string[]> {
  const { rows } = await db.client.query({ sql: "SELECT key FROM attachment_chunks", params: [], method: "all" });
  return rows.map((r) => String(r[0]));
}

describe("a picture's size", () => {
  it("is read from the header of a PNG, a JPEG and each kind of WebP", () => {
    expect(imageSize("image/png", logoPng(320, 96))).toEqual({ width: 320, height: 96 });
    expect(imageSize("image/jpeg", jpeg(640, 200))).toEqual({ width: 640, height: 200 });
    expect(imageSize("image/webp", vp8(300, 100))).toEqual({ width: 300, height: 100 });
    expect(imageSize("image/webp", vp8l(1024, 512))).toEqual({ width: 1024, height: 512 });
    expect(imageSize("image/webp", vp8x(2048, 16))).toEqual({ width: 2048, height: 16 });
  });

  it("is not read from a header that is not there", () => {
    expect(imageSize("image/png", concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ascii("junk")))).toBeNull();
    expect(imageSize("image/jpeg", concat([0xff, 0xd8], segment(0xda, [1]), [0xff, 0xd9]))).toBeNull();
    expect(imageSize("image/webp", riff(webpChunk("ALPH", new Array(20).fill(0))))).toBeNull();
  });
});

describe("what is taken as a logo", () => {
  it("is a PNG, JPEG or WebP, its metadata taken out", async () => {
    const png = logoPng(120, 40);
    const clean = await prepareLogo(png);
    expect(clean).toMatchObject({ type: "image/png", width: 120, height: 40 });
    expect(contains(png, SECRET_PLACE)).toBe(true);
    expect(contains(clean.bytes, SECRET_PLACE)).toBe(false);
    expect(clean.sha256).toBe(await sha256Hex(clean.bytes));
    await expect(prepareLogo(jpeg(400, 100))).resolves.toMatchObject({ type: "image/jpeg", width: 400 });
    await expect(prepareLogo(vp8x(200, 50))).resolves.toMatchObject({ type: "image/webp", height: 50 });
  });

  it("is never what a name or a declared type says: an SVG, a PDF, a HEIC, a fake PNG are refused", async () => {
    const refused = async (bytes: Uint8Array, message: string) =>
      expect(prepareLogo(bytes)).rejects.toMatchObject({ code: "invalid_input", status: 422, message });
    await refused(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), LOGO_WORDS.type);
    await refused(ascii('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), LOGO_WORDS.type);
    await refused(pdf(), LOGO_WORDS.type);
    await refused(heic(), LOGO_WORDS.heic);
    expect(LOGO_WORDS.heic).toContain("send it as PNG or JPEG");
    await refused(concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(40)), LOGO_WORDS.unreadable);
    await refused(new Uint8Array(0), LOGO_WORDS.empty);
    await refused(logoPng(4096, 10), LOGO_WORDS.size);
    await refused(logoPng(8, 8), LOGO_WORDS.size);
    // A PNG cut short: its header reads, its chunks do not.
    const cut = logoPng(100, 100);
    await refused(cut.slice(0, cut.byteLength - 20), LOGO_WORDS.damaged);
  });

  it("is at most 512 KB", async () => {
    const big = concat(logoPng(100, 100), new Uint8Array(LOGO_MAX_BYTES));
    const error = await prepareLogo(big.slice(0, LOGO_MAX_BYTES + 1)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", message: LOGO_WORDS.tooLarge });
    expect(isTooLarge(error)).toBe(true);
  });
});

describe("the logo, kept", () => {
  it("is a row of its own, never run out, that the sweep leaves", async () => {
    const { db, caps } = await setup();
    const view = await caps.look.setLogo(owner, logoPng(120, 40));
    const logo = view.doc.look.logo;
    expect(logo).toMatchObject({ type: "image/png", width: 120, height: 40 });
    expect(await logoRows(db)).toEqual([{ key: logo?.id, expires: null, item: null, party: null }]);

    await sweepFiles(db, T0 + 48 * 3_600_000);
    expect(await logoRows(db)).toHaveLength(1);
    const bytes = await readLogo(db, logo?.id ?? "");
    expect(bytes && (await sha256Hex(bytes))).toBe(logo?.sha256);

    // Customers get it by its name now, and by no other.
    const look = await caps.look.view();
    expect(look.logo).toEqual({ file: `${logo?.sha256.slice(0, 16)}.png`, width: 120, height: 40 });
    await expect(caps.look.file(look.logo?.file ?? "")).resolves.toMatchObject({ type: "image/png" });
    expect(await caps.look.file("0000000000000000.png")).toBeNull();
    expect(await caps.look.file(`${logo?.sha256.slice(0, 16)}.jpg`)).toBeNull();
  });

  it("replaced, takes the one before with it; removed, leaves nothing", async () => {
    const { db, caps } = await setup();
    const first = (await caps.look.setLogo(owner, logoPng(120, 40))).doc.look.logo;
    const second = (await caps.look.setLogo(at(T0 + 1000), logoPng(300, 60))).doc.look.logo;
    expect(second?.id).not.toBe(first?.id);
    expect((await logoRows(db)).map((r) => r.key)).toEqual([second?.id]);
    expect(await chunkKeys(db)).toEqual([second?.id]);
    expect(await caps.look.file(`${first?.sha256.slice(0, 16)}.png`)).toBeNull();

    const removed = await caps.look.removeLogo(at(T0 + 2000));
    expect(removed.doc.look.logo).toBeNull();
    expect(await logoRows(db)).toEqual([]);
    expect(await chunkKeys(db)).toEqual([]);
    expect(await caps.look.ownerFile(owner)).toBeNull();
  });

  it("leaves no file behind when the settings could not name it", async () => {
    const { db } = await setup();
    const look = new LookCapabilities(db, {
      writeLogo: async () => {
        throw new Error("the settings changed meanwhile");
      },
    });
    await expect(look.setLogo(owner, logoPng(120, 40))).rejects.toThrow("the settings changed meanwhile");
    expect(await logoRows(db)).toEqual([]);
    expect(await chunkKeys(db)).toEqual([]);
  });

  it("is the owner's in person: the owner's AI and another system's key change nothing", async () => {
    const { db, caps } = await setup();
    for (const caller of [claude, zapier]) {
      await expect(caps.look.setLogo(caller, logoPng(120, 40))).rejects.toMatchObject({
        code: "not_allowed",
        details: { reason: "owner_in_person", where: "Settings → Look" },
      });
      await expect(caps.look.removeLogo(caller)).rejects.toMatchObject({ details: { reason: "owner_in_person" } });
    }
    expect(await logoRows(db)).toEqual([]);
    await caps.look.setLogo(owner, logoPng(120, 40));
    await expect(caps.look.removeLogo(claude)).rejects.toMatchObject({ code: "not_allowed" });
    expect((await readSettings(db)).look.logo).not.toBeNull();
    // Any person or key at the business may see it.
    await expect(caps.look.ownerFile(zapier)).resolves.toMatchObject({ type: "image/png" });
  });
});
