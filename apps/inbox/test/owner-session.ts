import type { Db } from "@surfingdog/core";
import type { LogMailOut } from "@surfingdog/platform";
import { expect } from "vitest";
import type { App } from "../src/app";

/**
 * A browser and a mailbox, for the owner's sign-in tests: asking for a sign-in email, opening its
 * link the way a browser does (the page, then the POST its button sends), and typing its code.
 */
let client = 0;
/** A client address of its own for each request, so a test meets the per-address limits it means to. */
export const clientIp = (): string => `198.51.${Math.floor(client / 250) % 250}.${(client++ % 250) + 1}`;

export async function askSignIn(app: App, origin: string, email: string): Promise<Response> {
  return await app.request(`${origin}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": clientIp() },
    body: JSON.stringify({ email }),
  });
}

/** The link and the code in the latest email to `to`. */
export function lastSignIn(mail: LogMailOut, to: string): { link: string; code: string } {
  const text = mail.sent.filter((m) => m.to.includes(to)).at(-1)?.text ?? "";
  const link = /https?:\/\/\S+\/auth\/\S+/.exec(text)?.[0];
  const code = /code: (\d{6})/.exec(text)?.[1];
  if (!link || !code) throw new Error(`no sign-in email to ${to}`);
  return { link, code };
}

/** The first link in the latest email to `to`. */
export function lastLink(mail: LogMailOut, to: string): string {
  const text = mail.sent.filter((m) => m.to.includes(to)).at(-1)?.text ?? "";
  const link = /https?:\/\/\S+/.exec(text)?.[0];
  if (!link) throw new Error(`no link in the email to ${to}`);
  return link;
}

/** The form on a page a link opens: where it posts, and its hidden fields. */
export function formOf(html: string): { action: string; fields: Record<string, string> } {
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error("no form on the page");
  const fields: Record<string, string> = {};
  for (const [, k, v] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[k ?? ""] = (v ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  }
  return { action, fields };
}

/** Posts a page's form from that page, as its button does, with whatever cookie the browser has. */
export async function postForm(
  app: App,
  origin: string,
  form: { action: string; fields: Record<string, string> },
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(`${origin}${form.action}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, ...headers },
    body: new URLSearchParams(form.fields).toString(),
  });
}

/** Opens a link as a browser does: the page it shows, then the POST its button sends. */
export async function press(app: App, link: string, headers: Record<string, string> = {}): Promise<Response> {
  const page = await app.request(link, { headers });
  expect(page.status).toBe(200);
  return postForm(app, new URL(link).origin, formOf(await page.text()), headers);
}

/** The session cookie a response set, as a request sends it back. */
export function sessionCookie(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const token = /__Host-sdi_session=([^;]+)/.exec(set)?.[1];
  if (!token) throw new Error("no session cookie");
  return `__Host-sdi_session=${token}`;
}

/** Signs `email` in with the code from a sign-in email; the cookie to send back. */
export async function signInByCode(app: App, mail: LogMailOut, origin: string, email: string): Promise<string> {
  expect((await askSignIn(app, origin, email)).status).toBe(200);
  const { code } = lastSignIn(mail, email);
  const res = await app.request(`${origin}/auth/code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "cf-connecting-ip": clientIp() },
    body: JSON.stringify({ email, code }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

/** Everything a sign-in could change, to compare before and after a request that must change nothing. */
export async function authState(db: Db): Promise<string> {
  const read = async (sql: string) => (await db.client.query({ sql, params: [], method: "all" })).rows;
  return JSON.stringify({
    tokens: await read("SELECT hash, used_at, attempts FROM login_tokens ORDER BY hash"),
    sessions: await read("SELECT id FROM sessions ORDER BY id"),
    users: await read("SELECT id, email FROM users ORDER BY id"),
    settings: await read("SELECT version FROM settings"),
  });
}
