import { CUSTOMER_PAGE_HEADERS, createApiKey, lookCss, lookOrDefault } from "@surfingdog/adapters";
import { ACCENT_TONES, type Capabilities, DEFAULT_LOOK, schema, THEME_TONES } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { logoPng } from "../../../packages/core/test/look-files";
import { createInbox } from "../src/app";
import { freshDb } from "./harness";

/**
 * The business's look on every page its customers open, through the whole app: the front page and
 * its forms, and the pages behind an email's links. A default inbox's pages are as they were, byte for
 * byte; a chosen theme sets its own tones, an accent its buttons and links, and a logo heads the page
 * above the name, from the inbox's own address, the only image a page may load. Node and workerd.
 */
const BASE = "https://inbox.example.org";
const T = Date.parse("2026-11-01T09:00:00Z");

async function setup() {
  const db = await freshDb();
  await db.orm.insert(schema.business).values({
    id: "self",
    name: "Studio Kalinda",
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
    secretKey: "customer-page-look-test-secret-0123456789",
    background: () => {},
    now: () => T,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  const auth = { authorization: `Bearer ${owner.key}` };
  let visitor = 0;
  const page = async (path: string) => {
    const res = await inbox.app.request(
      new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": `198.51.100.${++visitor}` } }),
    );
    expect(res.status).toBe(200);
    return { res, html: await res.text() };
  };
  const look = async (doc: Record<string, unknown>) => {
    const res = await inbox.app.request(
      new Request(`${BASE}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ doc: { look: doc } }),
      }),
    );
    expect(res.status).toBe(200);
  };
  const logo = async (bytes: Uint8Array) => {
    const res = await inbox.app.request(
      new Request(`${BASE}/v1/owner/look/logo`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body: bytes as BodyInit,
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { doc: { look: { logo: { sha256: string } } } }).doc.look.logo;
  };
  /** One visitor asking again and again, until the page says it is too many. */
  const tooMany = async (path: string) => {
    for (let i = 0; i < 200; i++) {
      const res = await inbox.app.request(
        new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      );
      if (res.status === 429) return res;
    }
    throw new Error("never refused");
  };
  return { page, look, logo, tooMany };
}

const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";

describe("a customer's page in the business's look", () => {
  it("is as it was, byte for byte, until the business chooses one, and again once it chooses Standard and Ink", async () => {
    const s = await setup();
    expect(lookCss(DEFAULT_LOOK)).toBe("");
    // Pages with no form on them: a form's hidden fields are drawn anew for each.
    const paths = ["/", "/c/privacy"];
    const before = await Promise.all(paths.map(async (p) => (await s.page(p)).html));
    for (const html of before) {
      expect(styleOf(html)).not.toContain("--accent");
      expect(html).not.toContain("<img");
    }
    await s.look({ theme: "dark", accent: "teal" });
    for (const [i, p] of paths.entries()) expect((await s.page(p)).html).not.toBe(before[i]);
    await s.look({ theme: "standard", accent: "ink" });
    for (const [i, p] of paths.entries()) expect((await s.page(p)).html).toBe(before[i]);
  });

  it("takes the theme's own tones, and the accent's tone for that theme", async () => {
    const s = await setup();
    await s.look({ theme: "dark", accent: "teal" });
    const dark = styleOf((await s.page("/p/quote")).html);
    expect(dark).toContain("color-scheme:dark");
    expect(dark).toContain(`--bg:${THEME_TONES.dark.bg}`);
    expect(dark).toContain("--bg:#141414");
    // A dark page's button is the accent's night tone, its label dark.
    expect(dark).toContain(`--btn:${ACCENT_TONES.teal.night};--btn-fg:${ACCENT_TONES.teal.nightFg}`);
    expect(dark).toContain("a{color:var(--accent)}");

    await s.look({ theme: "minimal", accent: "plum" });
    const minimal = styleOf((await s.page("/p/quote")).html);
    expect(minimal).toContain("color-scheme:light");
    expect(minimal).toContain(`--accent:${ACCENT_TONES.plum.day}`);
    expect(minimal).toContain("button{background:transparent;color:var(--accent);border:1px solid var(--accent)");

    await s.look({ theme: "warm", accent: "ink" });
    const warm = styleOf((await s.page("/p/quote")).html);
    expect(warm).toContain(`--bg:${THEME_TONES.warm.bg}`);
    // Ink is the theme's own ink: the button as it was, links as they were.
    expect(warm).toContain(`--btn:${THEME_TONES.warm.fg};--btn-fg:${THEME_TONES.warm.bg}`);
    expect(warm).not.toContain("a{color:var(--accent)}");
  });

  it("follows the device on Standard: the accent's day tone, and its night tone when the device is dark", async () => {
    const s = await setup();
    await s.look({ accent: "teal" });
    const style = styleOf((await s.page("/p/quote")).html);
    expect(style).toContain(`:root{--btn:${ACCENT_TONES.teal.day};--btn-fg:#ffffff;--accent:${ACCENT_TONES.teal.day}}`);
    expect(style).toContain(
      `@media (prefers-color-scheme:dark){:root{--btn:${ACCENT_TONES.teal.night};--btn-fg:#111111;--accent:${ACCENT_TONES.teal.night}}}`,
    );
    // Standard keeps its own two schemes: no scheme of its own is set.
    expect(style.match(/(?<!prefers-)color-scheme:/g)).toHaveLength(1);
  });

  it("heads the page with the logo above the name, but not inside the business's own website", async () => {
    const s = await setup();
    const logo = await s.logo(logoPng(400, 80));
    const file = `${logo.sha256.slice(0, 16)}.png`;
    const { html } = await s.page("/p/quote");
    // The name stays the text: the logo is decoration, its alt empty, at most 200 × 40.
    expect(html).toContain(
      `<p class="biz"><img src="/p/logo/${file}" alt="Studio Kalinda" width="200" height="40"></p>`,
    );
    expect(styleOf(html)).toContain(".biz img{display:block;");
    // The logo it loads is there.
    expect((await s.page(`/p/logo/${file}`)).res.headers.get("content-type")).toBe("image/png");
    // On the pages behind an email's links too.
    expect((await s.page("/c/privacy")).html).toContain(`<img src="/p/logo/${file}"`);

    await s.look({ theme: "dark" });
    const embedded = (await s.page("/p/quote?embed=1")).html;
    expect(embedded).not.toContain("<img");
    expect(embedded).not.toContain('class="biz"');
    expect(styleOf(embedded)).toContain("--bg:#141414");
  });

  it("seats the logo on a small white plate on a dark page, and on no light one", async () => {
    const s = await setup();
    await s.logo(logoPng(400, 80));
    const plate = ".biz img{box-sizing:content-box;padding:4px 6px;border-radius:4px;background:#fff}";
    // Standard follows the device: the plate only while it is dark.
    expect(styleOf((await s.page("/p/quote")).html)).toContain(`@media (prefers-color-scheme:dark){${plate}}`);
    await s.look({ theme: "dark" });
    const dark = styleOf((await s.page("/p/quote")).html);
    expect(dark).toContain(plate);
    expect(dark).not.toContain("@media (prefers-color-scheme:dark){.biz");
    for (const theme of ["minimal", "warm"]) {
      await s.look({ theme });
      expect(styleOf((await s.page("/p/quote")).html)).not.toContain(plate);
    }
  });

  it("keeps the look on a page that says something went wrong, or that it is too many", async () => {
    const s = await setup();
    await s.logo(logoPng(400, 80));
    await s.look({ theme: "dark", accent: "teal" });
    for (const path of ["/c/privacy", "/p/quote"]) {
      const html = await (await s.tooMany(path)).text();
      expect(styleOf(html)).toContain("--bg:#141414");
      expect(styleOf(html)).toContain(`--btn:${ACCENT_TONES.teal.night}`);
      expect(html).toContain('<p class="biz"><img src="/p/logo/');
    }
    // A look that cannot be read is the default: the page is still said.
    const broken = { look: { view: () => Promise.reject(new Error("no database")) } } as unknown as Capabilities;
    expect(await lookOrDefault(broken)).toEqual(DEFAULT_LOOK);
  });

  it("keeps a small logo its own size, and a tall one within 40 pixels", async () => {
    const s = await setup();
    const small = await s.logo(logoPng(32, 32));
    expect((await s.page("/p/quote")).html).toContain(
      `<img src="/p/logo/${small.sha256.slice(0, 16)}.png" alt="Studio Kalinda" width="32" height="32">`,
    );
    const tall = await s.logo(logoPng(120, 240));
    expect((await s.page("/p/quote")).html).toContain(
      `<img src="/p/logo/${tall.sha256.slice(0, 16)}.png" alt="Studio Kalinda" width="20" height="40">`,
    );
  });

  it("may load an image from its own address only", async () => {
    const s = await setup();
    for (const path of ["/", "/p/quote", "/c/privacy"]) {
      const csp = (await s.page(path)).res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self'");
    }
    expect(CUSTOMER_PAGE_HEADERS["Content-Security-Policy"]).toContain("img-src 'self'");
  });
});
