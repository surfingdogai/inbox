import { createHandoff, HANDOFF_TTL_MS, SIGN_IN_CODE_TRIES } from "@surfingdog/adapters";
import { logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";
import { askSignIn, authState, clientIp, formOf, lastSignIn, postForm, press, sessionCookie } from "./owner-session";

const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficinamare.pt";

const tryCode = (app: App, email: string, code: string, origin = ORIGIN) =>
  app.request(`${origin}/auth/code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "cf-connecting-ip": clientIp() },
    body: JSON.stringify({ email, code }),
  });

const me = async (app: App, cookie: string, origin = ORIGIN) =>
  app.request(`${origin}/auth/me`, { headers: { cookie } });

describe("a sign-in link a mail scanner opens first", () => {
  it("changes nothing on a GET, however often, and signs in once on the POST its page sends", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: [OWNER] });
    expect((await askSignIn(app, ORIGIN, OWNER)).status).toBe(200);
    const { link } = lastSignIn(mail, OWNER);
    const before = await authState(db);
    for (let i = 0; i < 3; i++) {
      const page = await app.request(link);
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain('<form method="post" action="/auth/verify">');
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
      expect(html).toContain(`You are signing in as ${OWNER}.`);
    }
    expect((await app.request(link, { method: "HEAD" })).headers.get("set-cookie")).toBeNull();
    expect(await authState(db)).toBe(before);

    const signedIn = await press(app, link);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/");
    expect(await (await me(app, sessionCookie(signedIn))).json()).toMatchObject({ email: OWNER, role: "owner" });

    // Used once: the page and its POST both say so now.
    expect((await app.request(link)).status).toBe(410);
    const again = await postForm(app, ORIGIN, { action: "/auth/verify", fields: { token: tokenOf(link) } });
    expect(again.status).toBe(410);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the POST from another site, and the link still works from its own page", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, ORIGIN, OWNER);
    const { link } = lastSignIn(mail, OWNER);
    const before = await authState(db);
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, {}]) {
      const forged = await app.request(`${ORIGIN}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ token: tokenOf(link) }).toString(),
      });
      expect(forged.status).toBe(403);
      expect(forged.headers.get("set-cookie")).toBeNull();
    }
    expect(await authState(db)).toBe(before);
    expect((await press(app, link)).status).toBe(303);
  });
});

describe("the code in a sign-in email", () => {
  it("signs in once, instead of the link, and the link stops working", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, ORIGIN, OWNER);
    const { link, code } = lastSignIn(mail, OWNER);
    const res = await tryCode(app, OWNER, code.replace(/^(\d{3})/, "$1 "));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: { email: OWNER, role: "owner" }, redirect: "/" });
    expect(await (await me(app, sessionCookie(res))).json()).toMatchObject({ email: OWNER });
    expect((await tryCode(app, OWNER, code)).status).toBe(422);
    expect((await app.request(link)).status).toBe(410);
  });

  it("stops after five wrong tries, even for the right code, and a new email's code works", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, ORIGIN, OWNER);
    const { link, code } = lastSignIn(mail, OWNER);
    const wrong = (n: number) => String((Number(code) + n) % 1_000_000).padStart(6, "0");
    for (let i = 1; i <= 5; i++) {
      const res = await tryCode(app, OWNER, wrong(i));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "bad_code" });
    }
    const locked = await tryCode(app, OWNER, code);
    expect(locked.status).toBe(422);
    expect(locked.headers.get("set-cookie")).toBeNull();
    // Nobody can guess the link, so a stranger's guesses do not cost the owner the email.
    const page = await app.request(link);
    expect(page.status).toBe(200);

    await askSignIn(app, ORIGIN, OWNER);
    const fresh = lastSignIn(mail, OWNER);
    expect((await tryCode(app, OWNER, fresh.code)).status).toBe(200);
  });

  it("answers an address nobody signs in with exactly as it answers a wrong code", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, ORIGIN, OWNER);
    const { code } = lastSignIn(mail, OWNER);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const known = await tryCode(app, OWNER, wrong);
    const unknown = await tryCode(app, "mallory@example.com", code);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it("takes twenty tries a day for one address, from however many client addresses", async () => {
    const db = await freshDb();
    const app = createApp({ db, mailOut: logMailOut(), ownerEmails: [OWNER] });
    for (let i = 0; i < SIGN_IN_CODE_TRIES.capacity; i++) {
      expect((await tryCode(app, "someone@example.com", "000000")).status).toBe(422);
    }
    expect((await tryCode(app, "someone@example.com", "000000")).status).toBe(429);
  });
});

describe("a host's handoff", () => {
  it("signs the first owner in once, within a minute, at the host it was made for only", async () => {
    const dbA = await freshDb();
    const dbB = await freshDb();
    const A = "https://calm-otter-x7k2.tenants.test";
    const B = "https://brisk-heron-p3q9.tenants.test";
    // The host named the owner when it made the inbox; nobody has signed in yet.
    const clock = { t: Date.now() };
    const now = () => clock.t;
    const appA = createApp({ db: dbA, mailOut: logMailOut(), baseUrl: A, now, ownerEmails: [OWNER] });
    const appB = createApp({ db: dbB, mailOut: logMailOut(), baseUrl: B, now });

    const first = await createHandoff(dbA, { email: OWNER, origin: A, now: clock.t });
    expect(first.url).toBe(`${A}/auth/handoff?token=${first.token}`);
    const before = await authState(dbA);
    const page = await appA.request(first.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await authState(dbA)).toBe(before);
    const form = formOf(await page.text());

    // Another inbox, even one that could read the same storage, does not take it.
    expect((await appB.request(`${B}/auth/handoff?token=${first.token}`)).status).toBe(410);
    const elsewhere = await postForm(appB, B, form);
    expect(elsewhere.status).toBe(410);
    expect(elsewhere.headers.get("set-cookie")).toBeNull();

    const opened = await postForm(appA, A, form);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/");
    expect(await (await me(appA, sessionCookie(opened), A)).json()).toMatchObject({ email: OWNER, role: "owner" });
    expect((await postForm(appA, A, form)).status).toBe(410);

    const late = await createHandoff(dbA, { email: OWNER, origin: A, now: clock.t });
    clock.t += HANDOFF_TTL_MS + 1;
    expect((await appA.request(late.url)).status).toBe(410);
    expect((await postForm(appA, A, { action: "/auth/handoff", fields: { token: late.token } })).status).toBe(410);
  });
});

describe("the session cookie", () => {
  it("is __Host- over https: this host only, https only, every path", async () => {
    const mail = logMailOut();
    const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, ORIGIN, OWNER);
    const res = await press(app, lastSignIn(mail, OWNER).link);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-sdi_session=[^;]+;/);
    expect(set).toMatch(/; Path=\/(;|$)/);
    expect(set).toMatch(/; Secure(;|$)/);
    expect(set).toMatch(/; HttpOnly(;|$)/);
    expect(set).toMatch(/; SameSite=Lax(;|$)/);
    expect(set).not.toMatch(/Domain=/i);

    // The same session under the plain name is not taken over https: any host under the domain could set that one.
    const token = /__Host-sdi_session=([^;]+)/.exec(set)?.[1];
    expect((await me(app, `sdi_session=${token}`)).status).toBe(401);
    expect((await me(app, `__Host-sdi_session=${token}`)).status).toBe(200);

    const out = await app.request(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { cookie: `__Host-sdi_session=${token}`, origin: ORIGIN },
    });
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("__Host-sdi_session=;");
    expect(cleared).toContain("sdi_session=;");
    expect((await me(app, `__Host-sdi_session=${token}`)).status).toBe(401);
  });

  it("has the plain name over http, where a browser keeps no __Host- cookie", async () => {
    const local = "http://localhost:8787";
    const mail = logMailOut();
    const app = createApp({ db: await freshDb(), mailOut: mail, ownerEmails: [OWNER] });
    await askSignIn(app, local, OWNER);
    const res = await press(app, lastSignIn(mail, OWNER).link);
    expect(res.status).toBe(303);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^sdi_session=[^;]+;/);
    expect(set).not.toMatch(/Secure/);
    const token = /sdi_session=([^;]+)/.exec(set)?.[1];
    expect((await me(app, `sdi_session=${token}`, local)).status).toBe(200);
  });

  it("is asked for by a 401 that names only the ways in that exist", async () => {
    const app = createApp({ db: await freshDb(), mailOut: logMailOut() });
    const res = await me(app, "");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/passkey/i);
  });
});

function tokenOf(link: string): string {
  return new URL(link).searchParams.get("token") ?? "";
}
