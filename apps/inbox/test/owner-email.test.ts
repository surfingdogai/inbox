import {
  createApiKey,
  EMAIL_UNDO_TTL_MS,
  type OwnerEmailChange,
  STEP_UP_ATTEMPTS,
  setOwnerEmail,
} from "@surfingdog/adapters";
import type { Db } from "@surfingdog/core";
import { type LogMailOut, logMailOut } from "@surfingdog/platform";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { freshDb } from "./harness";
import { askSignIn, authState, formOf, lastLink, postForm, press, signInByCode } from "./owner-session";

const ORIGIN = "https://inbox.test";
const OWNER = "owner@oficinamare.pt";
const NEW = "rita@oficinamare.pt";

interface Owner {
  readonly db: Db;
  readonly mail: LogMailOut;
  readonly app: App;
  readonly cookie: string;
  readonly changes: OwnerEmailChange[];
  readonly clock: { t: number };
}

/** An instance whose owner is signed in, and is told at the address they sign in with. */
async function signedIn(): Promise<Owner> {
  const db = await freshDb();
  const mail = logMailOut();
  const changes: OwnerEmailChange[] = [];
  const clock = { t: Date.now() };
  const app = createApp({
    db,
    mailOut: mail,
    ownerEmails: [OWNER],
    now: () => clock.t,
    onOwnerEmailChange: (change) => {
      changes.push(change);
    },
  });
  const cookie = await signInByCode(app, mail, ORIGIN, OWNER);
  const saved = await app.request(`${ORIGIN}/v1/owner/settings`, {
    method: "PUT",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ doc: { notifications: { ownerEmail: "Owner@OficinaMare.pt" } } }),
  });
  expect(saved.status).toBe(200);
  return { db, mail, app, cookie, changes, clock };
}

const post = (o: Owner, path: string, body: unknown, headers: Record<string, string> = {}) =>
  o.app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie: o.cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Asks for a step-up code and reads it from the owner's mailbox. */
async function stepUp(o: Owner, purpose = "email_change"): Promise<string> {
  const res = await post(o, "/auth/step-up", { purpose });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, sent_to: "o•••@o•••.pt", expires_in: 600 });
  const mail = o.mail.sent.at(-1);
  expect(mail?.to).toEqual([OWNER]);
  const code = /code: (\d{6})/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error("no code mailed");
  return code;
}

const userEmail = async (db: Db) =>
  String((await db.client.query({ sql: "SELECT email FROM users", params: [], method: "all" })).rows[0]?.[0]);

const toldAt = async (o: Owner) =>
  (
    (await (await o.app.request(`${ORIGIN}/v1/owner/settings`, { headers: { cookie: o.cookie } })).json()) as {
      doc: { notifications: { ownerEmail?: string } };
    }
  ).doc.notifications.ownerEmail;

describe("changing the address the owner signs in with", () => {
  it("needs a fresh code sent to the address the owner has now, asked for in person", async () => {
    const o = await signedIn();
    // No code, or one for something else, or a wrong one: refused, and the new address hears nothing.
    expect((await post(o, "/auth/email", { email: NEW })).status).toBe(422);
    const forDownload = await stepUp(o, "download");
    expect((await post(o, "/auth/email", { email: NEW, code: forDownload })).status).toBe(422);
    const code = await stepUp(o);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const refused = await post(o, "/auth/email", { email: NEW, code: wrong });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "bad_code" });
    expect(o.mail.sent.filter((m) => m.to.includes(NEW))).toEqual([]);

    // A key, the owner's AI or another site cannot even ask for a code.
    const { key } = await createApiKey(o.db, { kind: "owner", name: "cli" });
    const byKey = await o.app.request(`${ORIGIN}/auth/step-up`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "email_change" }),
    });
    expect(byKey.status).toBe(401);
    expect(
      (await post(o, "/auth/step-up", { purpose: "email_change" }, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await post(o, "/auth/email", { email: NEW, code }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await userEmail(o.db)).toBe(OWNER);
  });

  it("changes nothing until the owner confirms from the new address, then tells the old one and the host", async () => {
    const o = await signedIn();
    const code = await stepUp(o);
    const asked = await post(o, "/auth/email", { email: NEW, code });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: true, sent_to: NEW });
    const confirm = lastLink(o.mail, NEW);
    expect(confirm).toContain(`${ORIGIN}/auth/email/confirm?token=`);

    // Opening the link, as a mail scanner does, changes nothing.
    const before = await authState(o.db);
    const page = await o.app.request(confirm);
    expect(page.status).toBe(200);
    expect(await authState(o.db)).toBe(before);
    const form = formOf(await page.text());

    // Whoever reads the new address is not enough: a typo would hand them the inbox.
    const stranger = await postForm(o.app, ORIGIN, form);
    expect(stranger.status).toBe(403);
    expect(await userEmail(o.db)).toBe(OWNER);

    const done = await postForm(o.app, ORIGIN, form, { cookie: o.cookie });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(`You sign in with ${NEW} from now on.`);
    expect(await userEmail(o.db)).toBe(NEW);
    expect(await toldAt(o)).toBe(NEW);
    expect(o.changes).toEqual([{ userId: expect.any(String), from: OWNER, to: NEW, how: "changed" }]);
    const notice = o.mail.sent.at(-1);
    expect(notice?.to).toEqual([OWNER]);
    expect(notice?.text).toContain(`${ORIGIN}/auth/email/undo?token=`);
    expect((await postForm(o.app, ORIGIN, form, { cookie: o.cookie })).status).toBe(410);

    // The owner stays signed in; the new address signs in from now on, the old one no longer does.
    const meNow = await o.app.request(`${ORIGIN}/auth/me`, { headers: { cookie: o.cookie } });
    expect(await meNow.json()).toMatchObject({ email: NEW });
    const sent = o.mail.sent.length;
    await askSignIn(o.app, ORIGIN, OWNER);
    expect(o.mail.sent.length).toBe(sent);
    await askSignIn(o.app, ORIGIN, NEW);
    expect(o.mail.sent.at(-1)?.to).toEqual([NEW]);
  });

  // The wrong address recovered: from the old address alone, with nothing set on the server.
  it("is put back by the old address's link for seven days, which signs out every session", async () => {
    const o = await signedIn();
    const code = await stepUp(o);
    await post(o, "/auth/email", { email: NEW, code });
    await press(o.app, lastLink(o.mail, NEW), { cookie: o.cookie });
    const undo = lastLink(o.mail, OWNER);
    expect(undo).toContain("/auth/email/undo?token=");

    const before = await authState(o.db);
    const page = await o.app.request(undo);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`Put back ${OWNER} as the address you sign in with?`);
    expect(await authState(o.db)).toBe(before);
    const form = formOf(html);

    const back = await postForm(o.app, ORIGIN, form);
    expect(back.status).toBe(200);
    expect(await userEmail(o.db)).toBe(OWNER);
    expect(o.changes.map((c) => c.how)).toEqual(["changed", "undone"]);
    expect(o.changes[1]).toMatchObject({ from: NEW, to: OWNER });
    expect((await o.app.request(`${ORIGIN}/auth/me`, { headers: { cookie: o.cookie } })).status).toBe(401);
    expect((await postForm(o.app, ORIGIN, form)).status).toBe(410);

    const again = await signInByCode(o.app, o.mail, ORIGIN, OWNER);
    expect(await toldAt({ ...o, cookie: again })).toBe(OWNER);
  });

  it("can no longer be put back after seven days", async () => {
    const o = await signedIn();
    await post(o, "/auth/email", { email: NEW, code: await stepUp(o) });
    await press(o.app, lastLink(o.mail, NEW), { cookie: o.cookie });
    const undo = lastLink(o.mail, OWNER);
    o.clock.t += EMAIL_UNDO_TTL_MS + 1;
    expect((await o.app.request(undo)).status).toBe(410);
    expect(await userEmail(o.db)).toBe(NEW);
  });

  it("stops a step-up code after five wrong tries, even the right one", async () => {
    const o = await signedIn();
    const code = await stepUp(o);
    for (let i = 1; i <= STEP_UP_ATTEMPTS; i++) {
      const wrong = String((Number(code) + i) % 1_000_000).padStart(6, "0");
      expect((await post(o, "/auth/email", { email: NEW, code: wrong })).status).toBe(422);
    }
    const locked = await post(o, "/auth/email", { email: NEW, code });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "too_many_attempts" });
    expect(o.mail.sent.filter((m) => m.to.includes(NEW))).toEqual([]);
  });
});

describe("set-owner-email on the command line", () => {
  it("moves the owner without an email to the old address, and signs out every session", async () => {
    const o = await signedIn();
    expect(await setOwnerEmail(o.db, { to: NEW })).toEqual({ outcome: "moved", from: OWNER, to: NEW });
    expect(await userEmail(o.db)).toBe(NEW);
    expect((await o.app.request(`${ORIGIN}/auth/me`, { headers: { cookie: o.cookie } })).status).toBe(401);
    const again = await signInByCode(o.app, o.mail, ORIGIN, NEW);
    expect(await toldAt({ ...o, cookie: again })).toBe(NEW);
    expect(await setOwnerEmail(o.db, { to: NEW })).toEqual({ outcome: "unchanged" });
    await expect(setOwnerEmail(o.db, { to: "x@example.com", from: OWNER })).rejects.toThrow(/nobody here/);
  });

  it("names the address that may create the first account, while nobody has signed in", async () => {
    const db = await freshDb();
    const mail = logMailOut();
    const app = createApp({ db, mailOut: mail });
    expect(await setOwnerEmail(db, { to: OWNER })).toEqual({ outcome: "first_owner", to: OWNER });
    await signInByCode(app, mail, ORIGIN, OWNER);
  });
});
