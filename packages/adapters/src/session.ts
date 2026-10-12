import { type Db, randomToken, readSettings, schema, sixDigits, ulid } from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hashKey } from "./auth";
import { authPage } from "./auth-page";
import { consume, type Limit } from "./limits";
import { publicOrigin, sameOrigin } from "./origin";
import { forbidden, tooManyRequests } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * Owner sign-in without passwords: an email with a link and a six-digit code, either of which signs
 * in once, then a hashed session cookie. The first person to sign in on a fresh instance becomes its
 * owner; after that only known addresses get an email, and the reply never says whether an address
 * is known.
 *
 * Opening a link changes nothing. Mail scanners open every link in an email, and a link that signed
 * in on a GET would be used up before the owner got to it, so the link opens a page with a button,
 * and only the POST that button sends signs in. The code is for signing in on another device than
 * the one the email is read on. A host that has just confirmed an owner signs them in with a
 * handoff: the same page, a token that works once, for a minute, at that host only.
 */
export const SESSION_COOKIE = "sdi_session";
/**
 * The session cookie's name over https. `__Host-` has the browser keep it to this exact host, send
 * it over https only and never take it from a response that names a domain, so no other host under
 * the same domain can set or replace it. The plain name is only for http (a server on localhost, or
 * one with no TLS yet), where a browser keeps no `__Host-` cookie.
 */
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
export const SESSION_TTL_MS = 30 * 86_400_000;
/** How long a sign-in email's link and code work. */
export const MAGIC_TTL_MS = 15 * 60_000;
/** How long a host's handoff works: long enough for one redirect and one press of a button. */
export const HANDOFF_TTL_MS = 60_000;
/**
 * Wrong tries at one sign-in code before it stops working. The link in the same email still works:
 * nobody can guess it, and a stranger's guesses should not cost the owner the email they were sent.
 */
export const CODE_ATTEMPTS = 5;

/**
 * Sign-in emails to one address: three at once, then one a minute, whoever asks. Counted alike for
 * every address, known here or not, so being refused says nothing about one.
 */
export const SIGN_IN_MAILS: Limit = { capacity: 3, perMs: 1 / 60_000 };
/**
 * Tries at a sign-in code for one address, right or wrong, known or not: twenty a day. A code stops
 * after five wrong tries and a new one comes at most once a minute, so this is what holds a guesser
 * with many client addresses of its own to a few dozen guesses a day at a million codes.
 */
export const SIGN_IN_CODE_TRIES: Limit = { capacity: 20, perMs: 20 / 86_400_000 };

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: "owner" | "staff";
  readonly sessionId: string;
}

/**
 * The migration that brought the `__Host-` cookie (0020). A session made before it was set under
 * the plain name over https too, and is still taken under that name until it ends (`findSession`).
 */
const HOST_COOKIE_MIGRATION = "0020_owner_sign_in";

/**
 * The session token a request carries: the `__Host-` cookie, or the plain one on a request that
 * came over http. Over https a plain cookie is ignored, since any host under the same domain could
 * have set it. `baseUrl` (INBOX_PUBLIC_URL) says whether this instance is reached over https, as the
 * cookie was set by it: a proxy that forwards no X-Forwarded-Proto makes the request itself say http.
 */
export function sessionToken(request: Request, baseUrl?: string | undefined): string | null {
  const carried = carriedSession(request, baseUrl);
  return carried && !carried.plainOverHttps ? carried.token : null;
}

function carriedSession(
  request: Request,
  baseUrl: string | undefined,
): { readonly token: string; readonly plainOverHttps: boolean } | null {
  const cookie = request.headers.get("cookie") ?? "";
  const secure = /(?:^|;\s*)__Host-sdi_session=([^;]+)/.exec(cookie)?.[1];
  if (secure) return { token: secure, plainOverHttps: false };
  const plain = /(?:^|;\s*)sdi_session=([^;]+)/.exec(cookie)?.[1];
  if (!plain) return null;
  return { token: plain, plainOverHttps: publicOrigin(request, baseUrl).startsWith("https:") };
}

/**
 * The session a request carries, with its token and when it ends. Over https a plain cookie counts
 * only for a session made before the `__Host-` cookie existed (`legacy`): every session since has
 * the `__Host-` one there, so a plain cookie another host under the domain set gains nothing, and
 * nobody who was signed in before an upgrade is signed out by it.
 */
async function findSession(
  db: Db,
  request: Request,
  now: number,
  baseUrl: string | undefined,
): Promise<{ user: SessionUser; token: string; expiresAt: number; legacy: boolean } | null> {
  const carried = carriedSession(request, baseUrl);
  if (!carried) return null;
  const { rows } = await db.client.query({
    sql: `SELECT s.id, u.id, u.email, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?
             ${carried.plainOverHttps ? "AND s.created_at < (SELECT applied_at FROM migrations WHERE name = ?)" : ""}`,
    params: [await hashKey(carried.token), now, ...(carried.plainOverHttps ? [HOST_COOKIE_MIGRATION] : [])],
    method: "all",
  });
  const row = rows[0];
  if (!row) return null;
  return {
    user: {
      sessionId: String(row[0]),
      id: String(row[1]),
      email: String(row[2]),
      role: row[3] === "staff" ? "staff" : "owner",
    },
    token: carried.token,
    expiresAt: Number(row[4]),
    legacy: carried.plainOverHttps,
  };
}

export async function userFromCookie(
  db: Db,
  request: Request,
  now = Date.now(),
  baseUrl?: string | undefined,
): Promise<SessionUser | null> {
  return (await findSession(db, request, now, baseUrl))?.user ?? null;
}

export async function createSession(
  db: Db,
  userId: string,
  request: Request,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const expiresAt = now + SESSION_TTL_MS;
  await db.orm.insert(schema.sessions).values({
    id: ulid(),
    userId,
    tokenHash: await hashKey(token),
    expiresAt,
    userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
    createdAt: now,
    lastSeenAt: now,
  });
  return { token, expiresAt };
}

/** Whether this instance is reached over https, as the browser sees it. */
function overHttps(c: Context, baseUrl: string | undefined): boolean {
  return publicOrigin(c.req.raw, baseUrl).startsWith("https:");
}

function setSessionCookie(c: Context, baseUrl: string | undefined, session: { token: string; expiresAt: number }) {
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    expires: new Date(session.expiresAt),
    ...(overHttps(c, baseUrl) ? { prefix: "host" as const } : {}),
  });
}

/** Both names go: a browser may still hold the plain cookie from before this instance had https. */
export function clearSessionCookies(c: Context, baseUrl: string | undefined): void {
  setCookie(c, SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  if (overHttps(c, baseUrl)) setCookie(c, SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, prefix: "host" });
}

/** Ends every session a user has, on every device: after their address was taken back. */
export async function endSessions(db: Db, userId: string): Promise<void> {
  await db.client.query({ sql: "DELETE FROM sessions WHERE user_id = ?", params: [userId], method: "run" });
}

/** The hash a code is kept as: the row's own hash and the code, so equal codes never hash alike. */
export async function codeHash(rowHash: string, code: string): Promise<string> {
  return hashKey(`${rowHash}:${code}`);
}

export interface OwnerMailDeps {
  readonly db: Db;
  readonly mailOut: MailOut;
  readonly businessName: () => Promise<string>;
  /** The server's log (console.log). Only an email that nothing could send is written there whole. */
  readonly log?: ((line: string) => void) | undefined;
}

/** An email to the owner, or to an address they gave. `what` names it in the log ("sign-in email"). */
export interface OwnerMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly what: string;
}

/**
 * Sends an email that is the owner's own: a sign-in, a step-up code, an address change. It goes out
 * from the transport's own address (MAIL_FROM) first, else Send from in Settings.
 *
 * With neither there is nobody to send it as: the instance is run for development, or is still being
 * set up, and its log is the only way in, so the whole email goes there (`logged`). Only whoever runs
 * the server reads that log. A send that fails is another matter: the log says why, never what the
 * email carried, since the mail service may work on a second try and a log may be read by more people
 * than the owner. It throws, and the caller says "Couldn't send".
 */
export async function sendOwnerMail(deps: OwnerMailDeps, mail: OwnerMail): Promise<"sent" | "logged"> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const address = deps.mailOut.sender?.address ?? (await readSettings(deps.db)).email.fromAddress;
  if (!address) {
    log(
      `${mail.what} for ${mail.to} written here, not sent: there is no address to send email from (set MAIL_FROM, or Send from in Settings)\n${mail.subject}\n${mail.text}`,
    );
    return "logged";
  }
  const name = await deps.businessName();
  try {
    await deps.mailOut.send({
      from: { address, name: name || deps.mailOut.sender?.name || "Surfing Dog Inbox" },
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    });
    return "sent";
  } catch (error) {
    log(`${mail.what} not sent: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * The address the links in an owner's email point at: INBOX_PUBLIC_URL, else the Inbox address in
 * Settings (the owner's first sign-in over https keeps it there), and only with neither the address
 * the request came to. Anyone can ask for a sign-in email, and a server reached directly takes its
 * host from whatever the asker wrote in the request: a link built from that would carry the owner's
 * token to the asker's own host.
 */
export async function linkOrigin(
  deps: { readonly db: Db; readonly baseUrl?: string | undefined },
  request: Request,
): Promise<string> {
  if (deps.baseUrl) return new URL(deps.baseUrl).origin;
  const saved = (await readSettings(deps.db)).notifications.appUrl;
  if (saved && URL.canParse(saved)) return new URL(saved).origin;
  return publicOrigin(request);
}

/** The answer when an owner's email could not be sent: the page says so, and offers the way round. */
export function mailFailed(c: Context, detail: string): Response {
  return c.json(
    {
      type: "https://surfingdog.ai/problems/mail_failed",
      title: "Email could not be sent",
      status: 502,
      code: "mail_failed",
      detail,
    },
    502,
    { "Content-Type": "application/problem+json" },
  );
}

export interface SessionDeps extends OwnerMailDeps {
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Addresses allowed to create the first account (INBOX_OWNER_EMAIL, the owner email in
   * Settings). Without one, an empty instance is only reachable with an owner API key: on a
   * public host, "first to click becomes the owner" would be a takeover.
   */
  readonly ownerEmails?: (() => Promise<readonly string[]>) | undefined;
  /**
   * Keeps the https address the owner signs in at as the Inbox address in Settings, when neither it
   * nor INBOX_PUBLIC_URL is set: receipts, and the links in emails, need an address outside a request.
   */
  readonly rememberOrigin?: ((origin: string) => Promise<unknown>) | undefined;
}

async function mayBootstrap(deps: SessionDeps, email: string): Promise<boolean> {
  const list = deps.ownerEmails ? await deps.ownerEmails() : [];
  return list.some((e) => e.trim().toLowerCase() === email);
}

/** An email address as this inbox keeps it, or null when it is not one. */
export function emailOf(value: unknown): string | null {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320 ? email : null;
}

/** A POST's fields, from a page's form or from JSON (the owner app, a script), and which it was. */
export async function postedFields(c: Context): Promise<{ fields: Record<string, string>; form: boolean }> {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  const raw = json ? await c.req.json().catch(() => null) : await c.req.parseBody().catch(() => null);
  const fields: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") fields[k] = v;
  }
  return { fields, form: !json };
}

/** One row of `login_tokens` as a link or code finds it. */
export interface TokenRow {
  readonly hash: string;
  readonly email: string;
  readonly userId: string | null;
  readonly detail: Record<string, unknown>;
}

function tokenRow(r: readonly unknown[]): TokenRow {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = r[3] ? JSON.parse(String(r[3])) : {};
    if (parsed && typeof parsed === "object") detail = parsed as Record<string, unknown>;
  } catch {
    // a row from before `detail`: nothing more to know
  }
  return { hash: String(r[0]), email: String(r[1]), userId: r[2] === null ? null : String(r[2]), detail };
}

/** The open token a link carries, read only: what a GET shows. Null when used, expired or unknown. */
export async function openToken(db: Db, token: string, kind: string, now: number): Promise<TokenRow | null> {
  if (!token) return null;
  const { rows } = await db.client.query({
    sql: "SELECT hash, email, user_id, detail FROM login_tokens WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
    params: [await hashKey(token), kind, now],
    method: "all",
  });
  return rows[0] ? tokenRow(rows[0]) : null;
}

/**
 * Uses up a token in one statement, so two requests with the same link cannot both get it. `origin`
 * holds a handoff to the host it was made for. Null when used, expired, unknown or elsewhere.
 */
export async function takeToken(
  db: Db,
  token: string,
  kind: string,
  now: number,
  origin?: string,
): Promise<TokenRow | null> {
  if (!token) return null;
  const { rows } = await db.client.query({
    sql: `UPDATE login_tokens SET used_at = ?
           WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?
             ${origin === undefined ? "" : "AND json_extract(detail, '$.origin') = ?"}
         RETURNING hash, email, user_id, detail`,
    params: [now, await hashKey(token), kind, now, ...(origin === undefined ? [] : [origin])],
    method: "all",
  });
  return rows[0] ? tokenRow(rows[0]) : null;
}

/**
 * Makes a handoff: a sign-in for `email` at `origin` that works once, within a minute, by the POST
 * of the page `url` opens. A host calls this right after it confirmed the owner's address itself,
 * and sends their browser to `url`. A handoff names its host, so it signs in nowhere else, even
 * where two inboxes share storage.
 */
export async function createHandoff(
  db: Db,
  o: { email: string; origin: string; now?: number },
): Promise<{ token: string; url: string }> {
  const email = emailOf(o.email);
  if (!email) throw new Error("createHandoff: not an email address");
  const origin = new URL(o.origin).origin;
  const now = o.now ?? Date.now();
  const token = randomToken(32);
  await db.orm.insert(schema.loginTokens).values({
    hash: await hashKey(token),
    email,
    kind: "handoff",
    detail: JSON.stringify({ origin }),
    expiresAt: now + HANDOFF_TTL_MS,
    createdAt: now,
  });
  return { token, url: `${origin}/auth/handoff?token=${token}` };
}

export function authRoutes(deps: SessionDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const businessName = async () => (await deps.businessName()) || "your inbox";

  app.post("/magic-link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; redirect?: unknown };
    const email = emailOf(body.email);
    if (!email) {
      return c.json(
        {
          type: "https://surfingdog.ai/problems/invalid_input",
          title: "Invalid input",
          status: 422,
          code: "invalid_input",
          detail: "Send a valid email address.",
          fields: [{ path: "email", problem: "invalid", message: "not an email" }],
        },
        422,
        { "Content-Type": "application/problem+json" },
      );
    }
    const turn = await consume(deps.db, "auth", `to:${await hashKey(email)}`, now(), SIGN_IN_MAILS);
    if (!turn.allowed) {
      return tooManyRequests(
        c,
        "A sign-in email went to that address a moment ago. Use its link or code, or ask again in a minute.",
        turn.retryAfterSec,
      );
    }
    const [existing] = await deps.db.orm
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    const [anyUser] = await deps.db.orm.select({ id: schema.users.id }).from(schema.users).limit(1);
    const known = Boolean(existing) || (!anyUser && (await mayBootstrap(deps, email)));
    if (!known && !anyUser) {
      // Nobody has signed in yet, so this is most likely the owner, and a typo in the value they
      // typed into the deploy form would otherwise leave them waiting for nothing. The address asked
      // for stays out of the log: on a public demo, which has no account, it is a stranger's.
      const listed = deps.ownerEmails ? (await deps.ownerEmails()).length : 0;
      log(
        listed
          ? "sign-in email not sent: that address is not in INBOX_OWNER_EMAIL, and nobody has signed in here yet, so check the value"
          : "sign-in email not sent: INBOX_OWNER_EMAIL is empty, so nobody can create the first account; set it and ask again",
      );
    }
    if (known) {
      const token = randomToken(32);
      const hash = await hashKey(token);
      const code = sixDigits();
      await deps.db.orm.insert(schema.loginTokens).values({
        hash,
        email,
        kind: "magic_link",
        codeHash: await codeHash(hash, code),
        expiresAt: now() + MAGIC_TTL_MS,
        createdAt: now(),
      });
      const redirect = typeof body.redirect === "string" ? safeRedirect(body.redirect) : "/";
      const origin = await linkOrigin(deps, c.req.raw);
      const link = `${origin}/auth/verify?token=${token}${redirect === "/" ? "" : `&redirect=${encodeURIComponent(redirect)}`}`;
      const name = await deps.businessName();
      try {
        await sendOwnerMail(deps, {
          what: "sign-in email",
          to: email,
          subject: `Sign in to ${name || "your inbox"}`,
          text: `Your sign-in code: ${code}\n\nOr open this link and press Sign in:\n${link}\n\nThe code and the link work once, for 15 minutes. If you did not ask to sign in, ignore this email.`,
        });
      } catch {
        // Nobody got this one, so it is no way in: an earlier email's link or code still is.
        await deps.db.client.query({ sql: "DELETE FROM login_tokens WHERE hash = ?", params: [hash], method: "run" });
        return mailFailed(
          c,
          "Couldn't send the sign-in email. Send it again in a minute, or use the code from an earlier one.",
        );
      }
    }
    return c.json({ ok: true, message: "If that address is known here, a sign-in email is on its way." });
  });

  /**
   * Signs `email` in: their session, the cookie, and every other sign-in email still open for the
   * address stops working. The first owner is created here, from the addresses allowed to.
   */
  const signIn = async (c: Context, email: string, redirect: string, form: boolean): Promise<Response> => {
    let [user] = await deps.db.orm.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) {
      const [anyUser] = await deps.db.orm.select({ id: schema.users.id }).from(schema.users).limit(1);
      if (anyUser || !(await mayBootstrap(deps, email))) {
        return form
          ? authPage(c, 403, {
              title: "No account",
              heading: "This address has no account here",
              lines: ["Ask the owner of this inbox to add it."],
            })
          : forbidden(c, "This address has no account here.");
      }
      const id = ulid();
      await deps.db.orm.insert(schema.users).values({ id, email, role: "owner", createdAt: now(), lastLoginAt: now() });
      [user] = await deps.db.orm.select().from(schema.users).where(eq(schema.users.id, id));
    } else {
      await deps.db.client.query({
        sql: "UPDATE users SET last_login_at = ? WHERE id = ?",
        params: [now(), user.id],
        method: "run",
      });
    }
    if (!user) throw new Error("user vanished");
    await deps.db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE email = ? AND kind = 'magic_link' AND used_at IS NULL",
      params: [now(), email],
      method: "run",
    });
    const session = await createSession(deps.db, user.id, c.req.raw, now());
    // The address the owner opened their link at is the inbox's own, until they say otherwise.
    if (user.role === "owner" && deps.rememberOrigin) {
      await deps.rememberOrigin(publicOrigin(c.req.raw, deps.baseUrl)).catch((error) => {
        console.error("sign-in: the Inbox address was not saved:", error instanceof Error ? error.message : error);
      });
    }
    setSessionCookie(c, deps.baseUrl, session);
    if (form) return c.redirect(redirect, 303);
    return c.json({ ok: true, user: { id: user.id, email: user.email, role: user.role }, redirect });
  };

  /** A sign-in POST from anywhere but a page of this inbox is refused: nobody signs anyone in from afar. */
  const crossSite = (c: Context, form: boolean): Response =>
    form
      ? authPage(c, 403, {
          title: "Sign in",
          heading: "Sign in from the page your link opened",
          lines: ["This request came from another site, so nothing was done."],
          link: { href: "/login", label: "Go to the sign-in page" },
        })
      : forbidden(c, "Sign in from this inbox's own pages.");

  const expiredLink = (c: Context, form: boolean): Response =>
    form
      ? authPage(c, 410, {
          title: "Link expired",
          heading: "This sign-in link no longer works",
          lines: ["It was used already, or it is more than 15 minutes old. Ask for a new one."],
          link: { href: "/login", label: "Ask for a new sign-in email" },
        })
      : c.json(
          {
            type: "https://surfingdog.ai/problems/link_expired",
            title: "Link expired",
            status: 410,
            code: "link_expired",
            detail: "That sign-in link is no longer valid. Request a new one.",
          },
          410,
          { "Content-Type": "application/problem+json" },
        );

  // The link in the email: a page that says what pressing its button does, and does nothing else.
  app.get("/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    const redirect = safeRedirect(c.req.query("redirect"));
    const row = await openToken(deps.db, token, "magic_link", now());
    if (!row) return expiredLink(c, true);
    return authPage(c, 200, {
      title: "Sign in",
      heading: `Sign in to ${await businessName()}`,
      lines: [`You are signing in as ${row.email}.`],
      form: { action: "/auth/verify", fields: { token, redirect }, button: "Sign in" },
    });
  });

  app.post("/verify", async (c) => {
    const { fields, form } = await postedFields(c);
    if (!sameOrigin(c.req.raw, deps.baseUrl)) return crossSite(c, form);
    const row = await takeToken(deps.db, fields.token ?? "", "magic_link", now());
    if (!row) return expiredLink(c, form);
    return signIn(c, row.email, safeRedirect(fields.redirect), form);
  });

  // The code in the email, typed into the sign-in page.
  app.post("/code", async (c) => {
    const { fields, form } = await postedFields(c);
    if (!sameOrigin(c.req.raw, deps.baseUrl)) return crossSite(c, form);
    const email = emailOf(fields.email);
    const code = (fields.code ?? "").replace(/\s+/g, "");
    if (!email || !/^[0-9]{6}$/.test(code)) {
      return c.json(
        {
          type: "https://surfingdog.ai/problems/invalid_input",
          title: "Invalid input",
          status: 422,
          code: "invalid_input",
          detail: "Send the email address and the six-digit code from the sign-in email.",
          fields: [
            ...(email ? [] : [{ path: "email", problem: "invalid", message: "not an email" }]),
            ...(/^[0-9]{6}$/.test(code) ? [] : [{ path: "code", problem: "invalid", message: "six digits" }]),
          ],
        },
        422,
        { "Content-Type": "application/problem+json" },
      );
    }
    const tries = await consume(deps.db, "auth", `code:${await hashKey(email)}`, now(), SIGN_IN_CODE_TRIES);
    if (!tries.allowed) {
      return tooManyRequests(
        c,
        "Too many tries at a code for this address today. Use the link in the sign-in email instead.",
        tries.retryAfterSec,
      );
    }
    const row = await takeCode(deps.db, email, code, now());
    if (!row) {
      return c.json(
        {
          type: "https://surfingdog.ai/problems/bad_code",
          title: "Wrong code",
          status: 422,
          code: "bad_code",
          detail:
            "That code didn't work. A code works once, for 15 minutes, and stops after five wrong tries; the link in the same email still works.",
        },
        422,
        { "Content-Type": "application/problem+json" },
      );
    }
    return signIn(c, row.email, safeRedirect(fields.redirect), form);
  });

  // A host's handoff, right after it confirmed the owner: the same page, then the same POST.
  app.get("/handoff", async (c) => {
    const token = c.req.query("token") ?? "";
    const row = await openToken(deps.db, token, "handoff", now());
    if (!row || row.detail.origin !== publicOrigin(c.req.raw, deps.baseUrl)) {
      return authPage(c, 410, {
        title: "Link expired",
        heading: "This link no longer works",
        lines: ["It works once, within a minute. Sign in with your email instead."],
        link: { href: "/login", label: "Sign in" },
      });
    }
    return authPage(c, 200, {
      title: "Open your inbox",
      heading: `Open ${await businessName()}`,
      lines: [`You are signing in as ${row.email}.`],
      form: { action: "/auth/handoff", fields: { token }, button: "Open your inbox" },
    });
  });

  app.post("/handoff", async (c) => {
    const { fields, form } = await postedFields(c);
    if (!sameOrigin(c.req.raw, deps.baseUrl)) return crossSite(c, form);
    const row = await takeToken(deps.db, fields.token ?? "", "handoff", now(), publicOrigin(c.req.raw, deps.baseUrl));
    if (!row) {
      return form
        ? authPage(c, 410, {
            title: "Link expired",
            heading: "This link no longer works",
            lines: ["It works once, within a minute. Sign in with your email instead."],
            link: { href: "/login", label: "Sign in" },
          })
        : expiredLink(c, false);
    }
    return signIn(c, row.email, "/", form);
  });

  app.get("/me", async (c) => {
    const found = await findSession(deps.db, c.req.raw, now(), deps.baseUrl);
    if (!found)
      return c.json(
        {
          type: "https://surfingdog.ai/problems/unauthorized",
          title: "Not signed in",
          status: 401,
          code: "unauthorized",
          detail: "Sign in with the link or the code from a sign-in email.",
        },
        401,
        { "Content-Type": "application/problem+json" },
      );
    // The owner app asks this first on every load: a session from before the `__Host-` cookie moves
    // to it here, and the plain cookie goes.
    if (found.legacy) {
      setCookie(c, SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
      setSessionCookie(c, deps.baseUrl, found);
    }
    const { user } = found;
    return c.json({ id: user.id, email: user.email, role: user.role });
  });

  app.post("/logout", async (c) => {
    const user = await userFromCookie(deps.db, c.req.raw, now(), deps.baseUrl);
    if (user)
      await deps.db.client.query({ sql: "DELETE FROM sessions WHERE id = ?", params: [user.sessionId], method: "run" });
    clearSessionCookies(c, deps.baseUrl);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Tries a sign-in code against every sign-in email still open for the address. The try is counted
 * on each before the code is compared, in the one statement that also checks it has a try left, so
 * guesses sent together cannot all read the same count; only the emails that statement counted the
 * try on are compared, so one that already had its five stays shut even to the right code. The one
 * it matches is used up at once.
 */
async function takeCode(db: Db, email: string, code: string, now: number): Promise<TokenRow | null> {
  const { rows } = await db.client.query({
    sql: `UPDATE login_tokens SET attempts = attempts + 1
           WHERE email = ? AND kind = 'magic_link' AND used_at IS NULL AND expires_at > ?
             AND code_hash IS NOT NULL AND attempts < ?
         RETURNING hash, code_hash`,
    params: [email, now, CODE_ATTEMPTS],
    method: "all",
  });
  for (const r of rows) {
    const hash = String(r[0]);
    if ((await codeHash(hash, code)) !== String(r[1])) continue;
    const { rows: taken } = await db.client.query({
      sql: `UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL
           RETURNING hash, email, user_id, detail`,
      params: [now, hash],
      method: "all",
    });
    return taken[0] ? tokenRow(taken[0]) : null;
  }
  return null;
}

/**
 * A path on this site, or `/`. Anyone can put a `redirect` into the link mailed to the owner, and a
 * browser reads `/\host` or `/<tab>/host` as `//host`, so the value is resolved the way a browser
 * would and only kept when it stays here.
 */
export function safeRedirect(value: string | undefined): string {
  if (!value?.startsWith("/")) return "/";
  const here = "https://inbox.invalid";
  try {
    const url = new URL(value, here);
    return url.origin === here ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

export { getCookie };
