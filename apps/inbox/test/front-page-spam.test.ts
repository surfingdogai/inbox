import { createApiKey } from "@surfingdog/adapters";
import { type Db, schema } from "@surfingdog/core";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/app";
import { freshDb, openWeekdays } from "./harness";

/**
 * The business's own form and the spam filter (ADR-041 §4.1), through the whole app: each form is
 * drawn with a signed key and a hidden field named for it; a bot's request is kept aside or held,
 * never dropped; a key from before a change of secret only counts against a request; the visitor sees
 * the same page whatever was decided, with a way to reach the business; and the form can sit inside
 * the business's own website, which alone may frame it. Runs on Node and in workerd.
 */

const BASE = "https://inbox.example.org";
const SECRET = "front-spam-test-secret-0123456789abcdef";
const clock = { t: Date.parse("2026-10-26T09:00:00Z") };

async function setup(o: { secretKey?: string; db?: Db } = {}) {
  const db = o.db ?? (await freshDb());
  if (!o.db) {
    await db.orm.insert(schema.business).values({
      id: "self",
      name: "Studio Lumen",
      domain: "studiolumen.example",
      timezone: "America/Bogota",
      currency: "COP",
      languages: ["es", "en"],
      createdAt: clock.t,
      updatedAt: clock.t,
    });
    await db.orm.insert(schema.services).values({
      id: "svc_portrait",
      name: "Portrait session",
      durationMin: 60,
      capacity: 1,
      granularityMin: 30,
      createdAt: clock.t,
      updatedAt: clock.t,
    });
    await openWeekdays(db);
  }
  const inbox = createInbox({
    db,
    mailOut: logMailOut(() => {}),
    baseUrl: BASE,
    secretKey: o.secretKey ?? SECRET,
    background: () => {},
    now: () => clock.t,
  });
  const owner = await createApiKey(db, { kind: "owner", name: "t" });
  return { db, app: inbox.app, runner: inbox.runner, owner: { authorization: `Bearer ${owner.key}` } };
}
type S = Awaited<ReturnType<typeof setup>>;

let n = 0;
const ip = () => `203.0.113.${(n++ % 250) + 1}`;
const get = (s: S, path: string) =>
  s.app.request(new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": ip() } }));
const post = (s: S, path: string, fields: Record<string, string>) =>
  s.app.request(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip() },
      body: new URLSearchParams(fields).toString(),
    }),
  );

function hiddenOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
    out[m[1] as string] = m[2] as string;
  return out;
}
const trapOf = (html: string) => /<input id="([^"]+)" name="\1" tabindex="-1"/.exec(html)?.[1] ?? "";

async function verdicts(s: S) {
  const { rows } = await s.db.client.query({
    sql: "SELECT i.type, i.state, i.screen, v.verdict, v.cause, v.signals FROM items i JOIN spam_verdicts v ON v.item_id = i.id ORDER BY i.created_at",
    method: "all",
  });
  return rows.map((r) => ({
    type: r[0],
    state: r[1],
    screen: r[2],
    verdict: r[3],
    cause: r[4],
    signals: JSON.parse(String(r[5])) as { c: string }[],
  }));
}

const message = {
  name: "Valentina Ríos",
  email: "valentina.rios@example.co",
  text: "Hola, ¿tienen sesiones de retrato los sábados?",
};

describe("the form's key", () => {
  it("is signed, names its hidden field, and a request sent with it at a human pace comes straight in", async () => {
    const s = await setup();
    const html = await (await get(s, "/p/message")).text();
    const hidden = hiddenOf(html);
    expect(hidden.k).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}[0-9A-HJKMNP-TV-Z]{10}$/);
    const trap = trapOf(html);
    expect(trap).toMatch(/^f_[0-9a-z]{6}$/);
    expect(html).toContain(
      `name="${trap}" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"`,
    );
    // Another form, another name.
    expect(trapOf(await (await get(s, "/p/message")).text())).not.toBe(trap);
    clock.t += 20_000;
    const sent = await post(s, "/p/message", { ...hidden, ...message, [trap]: "" });
    expect(sent.status).toBe(303);
    const [v] = await verdicts(s);
    expect(v).toMatchObject({ screen: "delivered", verdict: "deliver" });
    expect(v?.signals).toEqual([]);
  });

  it("counts a key from before a change of secret against the request, and never decides on it alone", async () => {
    const before = await setup();
    const html = await (await get(before, "/p/message")).text();
    const after = await setup({ secretKey: `rotated-secret-0123456789abcdefghij,${SECRET}`, db: before.db });
    clock.t += 20_000;
    await post(after, "/p/message", { ...hiddenOf(html), ...message });
    const [v] = await verdicts(after);
    expect(v?.signals.map((x) => x.c)).toEqual(["key_invalid"]);
    expect(v).toMatchObject({ verdict: "warn", screen: "warned" });
  });

  it("puts aside what was posted without opening the form at all", async () => {
    const s = await setup();
    await post(s, "/p/message", message);
    expect(await verdicts(s)).toMatchObject([{ state: "spam", screen: "aside", cause: "no_key" }]);
  });

  it("labels a form filled faster than anyone types, by the inbox's own clock", async () => {
    const s = await setup();
    const html = await (await get(s, "/p/message")).text();
    clock.t += 1_000;
    await post(s, "/p/message", { ...hiddenOf(html), ...message });
    const [v] = await verdicts(s);
    expect(v?.signals.map((x) => x.c)).toEqual(["too_fast"]);
    expect(v?.verdict).toBe("warn");
  });
});

describe("a filled hidden field", () => {
  it("puts a message aside and holds a booking, never drops either, and the visitor is thanked the same", async () => {
    const s = await setup();
    const msg = await (await get(s, "/p/message")).text();
    clock.t += 20_000;
    const a = await post(s, "/p/message", { ...hiddenOf(msg), ...message, [trapOf(msg)]: "https://cheap.example.net" });
    const book = await (await get(s, "/p/book?service=svc_portrait")).text();
    const start = /name="start" value="([^"]+)"/.exec(book)?.[1] as string;
    clock.t += 20_000;
    const b = await post(s, "/p/book", {
      ...hiddenOf(book),
      start,
      name: "Bot",
      email: "bot@example.net",
      [trapOf(book)]: "x",
    });
    expect(a.headers.get("location")).toBe("/p/sent?k=message");
    expect(b.headers.get("location")).toBe("/p/sent?k=booking");
    expect((await verdicts(s)).map((v) => [v.type, v.state, v.screen, v.cause])).toEqual([
      ["message", "spam", "aside", "trap"],
      ["booking", "requested", "held", "trap"],
    ]);
  });
});

describe("the page after sending", () => {
  it("is the same whatever the filter decided, with a way to reach the business when it shows one", async () => {
    const s = await setup();
    await s.app.request(
      new Request(`${BASE}/v1/owner/settings`, {
        method: "PUT",
        headers: { ...s.owner, "content-type": "application/json" },
        body: JSON.stringify({
          doc: {
            commerce: {
              legal: { legalName: "Studio Lumen SAS", email: "hola@studiolumen.example", phone: "+57 601 555 0100" },
            },
          },
        }),
      }),
    );
    const good = (await (await get(s, "/p/sent?k=message")).text()).replaceAll("&#39;", "'");
    expect(good).toContain(
      "Haven't heard from us in two working days? Write to hola@studiolumen.example or call +57 601 555 0100.",
    );
    // The bot that went aside is sent to the very same page.
    const bot = await post(s, "/p/message", message);
    expect(bot.headers.get("location")).toBe("/p/sent?k=message");
    const es = await (
      await s.app.request(
        new Request(`${BASE}/p/sent?k=message`, { headers: { "accept-language": "pt", "cf-connecting-ip": ip() } }),
      )
    ).text();
    expect(es).toContain(
      "Não teve resposta nossa em dois dias úteis? Escreva para hola@studiolumen.example ou ligue para +57 601 555 0100.",
    );
  });
});

describe("the form inside the business's own website", () => {
  it("draws the form alone, and only the business's own site may frame it", async () => {
    const s = await setup();
    const plain = await get(s, "/p/message");
    expect(plain.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const r = await get(s, "/p/message?embed=1");
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors https://studiolumen.example https://www.studiolumen.example");
    expect(csp).toContain("default-src 'none'");
    expect(r.headers.get("x-frame-options")).toBeNull();
    const html = await r.text();
    expect(html).not.toContain('class="biz"');
    expect(html).not.toContain("<footer>");
    expect(html).toContain('action="/p/message?embed=1"');
    expect(html).not.toContain("<script");
  });
});
