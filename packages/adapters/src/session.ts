import { type Db, randomToken, readSettings, schema, ulid } from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hashKey } from "./auth";
import { publicOrigin } from "./origin";
import type { CallerEnv } from "./rest";

/**
 * Owner sign-in without passwords: a magic link by email, then a hashed session cookie. The first
 * person to sign in on a fresh instance becomes its owner; after that only known addresses get a
 * link, and the reply never says whether an address is known.
 */
export const SESSION_COOKIE = "sdi_session";
export const SESSION_TTL_MS = 30 * 86_400_000;
export const MAGIC_TTL_MS = 15 * 60_000;

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: "owner" | "staff";
  readonly sessionId: string;
}

export async function userFromCookie(db: Db, request: Request, now = Date.now()): Promise<SessionUser | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const token = /(?:^|;\s*)sdi_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return null;
  const [row] = await db.orm
    .select({
      sessionId: schema.sessions.id,
      userId: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, await hashKey(token)), gt(schema.sessions.expiresAt, now)));
  if (!row) return null;
  return { id: row.userId, email: row.email, role: row.role as "owner" | "staff", sessionId: row.sessionId };
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

export interface SessionDeps {
  readonly baseUrl?: string | undefined;
  readonly db: Db;
  readonly mailOut: MailOut;
  readonly businessName: () => Promise<string>;
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
  /** Where a sign-in link goes when it cannot be emailed: the server's log (console.log). */
  readonly log?: ((line: string) => void) | undefined;
}

async function mayBootstrap(deps: SessionDeps, email: string): Promise<boolean> {
  const list = deps.ownerEmails ? await deps.ownerEmails() : [];
  return list.some((e) => e.trim().toLowerCase() === email);
}

export function authRoutes(deps: SessionDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));

  app.post("/magic-link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; redirect?: string };
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
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
    const [existing] = await db(deps)
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    const [anyUser] = await db(deps).select({ id: schema.users.id }).from(schema.users).limit(1);
    const known = Boolean(existing) || (!anyUser && (await mayBootstrap(deps, email)));
    if (!known && !anyUser) {
      // Nobody has signed in yet, so this is most likely the owner, and a typo in the value they
      // typed into the deploy form would otherwise leave them waiting for nothing. The address asked
      // for stays out of the log: on a public demo, which has no account, it is a stranger's.
      const listed = deps.ownerEmails ? (await deps.ownerEmails()).length : 0;
      log(
        listed
          ? "sign-in link not sent: that address is not in INBOX_OWNER_EMAIL, and nobody has signed in here yet, so check the value"
          : "sign-in link not sent: INBOX_OWNER_EMAIL is empty, so nobody can create the first account; set it and ask again",
      );
    }
    if (known) {
      const token = randomToken(32);
      await deps.db.orm.insert(schema.loginTokens).values({
        hash: await hashKey(token),
        email,
        kind: "magic_link",
        expiresAt: now() + MAGIC_TTL_MS,
        createdAt: now(),
      });
      const origin = publicOrigin(c.req.raw, deps.baseUrl);
      const link = `${origin}/auth/verify?token=${token}${body.redirect ? `&redirect=${encodeURIComponent(body.redirect)}` : ""}`;
      const name = await deps.businessName();
      // The transport's own address first (MAIL_FROM), the one set up to send; else Send from in
      // Settings. With neither there is nobody to send it as, and the link goes to the log.
      const address = deps.mailOut.sender?.address ?? (await readSettings(deps.db)).email.fromAddress;
      // Only people who can read this server's log see it there: whoever runs it.
      const toLog = (why: string) => log(`sign-in link for ${email} (${why}), open it within 15 minutes: ${link}`);
      if (!address) {
        toLog("no address to send email from: set MAIL_FROM, or Send from in Settings");
      } else {
        try {
          await deps.mailOut.send({
            from: { address, name: name || deps.mailOut.sender?.name || "Surfing Dog Inbox" },
            to: [email],
            subject: `Sign in to ${name || "your inbox"}`,
            text: `Open this link within 15 minutes to sign in:\n\n${link}\n\nIf you did not ask for it, ignore this email.`,
          });
        } catch (error) {
          toLog(`the email could not be sent: ${error instanceof Error ? error.message : String(error)}`);
          return c.json(
            {
              type: "https://surfingdog.ai/problems/mail_failed",
              title: "Email could not be sent",
              status: 502,
              code: "mail_failed",
              detail:
                "The sign-in email could not be sent, so the link was written to this server's log instead, with the reason. Or sign in with an API key.",
            },
            502,
            { "Content-Type": "application/problem+json" },
          );
        }
      }
    }
    return c.json({ ok: true, message: "If that address is known here, a sign-in link is on its way." });
  });

  app.get("/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    const redirect = safeRedirect(c.req.query("redirect"));
    const [row] = await db(deps)
      .select()
      .from(schema.loginTokens)
      .where(
        and(
          eq(schema.loginTokens.hash, await hashKey(token)),
          eq(schema.loginTokens.kind, "magic_link"),
          isNull(schema.loginTokens.usedAt),
          gt(schema.loginTokens.expiresAt, now()),
        ),
      );
    if (!row)
      return c.json(
        {
          type: "https://surfingdog.ai/problems/invalid_input",
          title: "Link expired",
          status: 410,
          code: "link_expired",
          detail: "That sign-in link is no longer valid. Request a new one.",
        },
        410,
        { "Content-Type": "application/problem+json" },
      );
    await deps.db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE hash = ?",
      params: [now(), row.hash],
      method: "run",
    });
    let [user] = await db(deps).select().from(schema.users).where(eq(schema.users.email, row.email));
    if (!user) {
      const [anyUser] = await db(deps).select({ id: schema.users.id }).from(schema.users).limit(1);
      if (anyUser || !(await mayBootstrap(deps, row.email)))
        return c.json(
          {
            type: "https://surfingdog.ai/problems/not_allowed",
            title: "Not allowed",
            status: 403,
            code: "not_allowed",
            detail: "This address has no account here.",
          },
          403,
          { "Content-Type": "application/problem+json" },
        );
      const id = ulid();
      await deps.db.orm
        .insert(schema.users)
        .values({ id, email: row.email, role: "owner", createdAt: now(), lastLoginAt: now() });
      [user] = await db(deps).select().from(schema.users).where(eq(schema.users.id, id));
    } else {
      await deps.db.client.query({
        sql: "UPDATE users SET last_login_at = ? WHERE id = ?",
        params: [now(), user.id],
        method: "run",
      });
    }
    if (!user) throw new Error("user vanished");
    const session = await createSession(deps.db, user.id, c.req.raw, now());
    // The address the owner opened their link at is the inbox's own, until they say otherwise.
    if (user.role === "owner" && deps.rememberOrigin) {
      await deps.rememberOrigin(publicOrigin(c.req.raw, deps.baseUrl)).catch((error) => {
        console.error("sign-in: the Inbox address was not saved:", error instanceof Error ? error.message : error);
      });
    }
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: publicOrigin(c.req.raw, deps.baseUrl).startsWith("https:"),
      sameSite: "Lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    if (c.req.header("accept")?.includes("text/html")) return c.redirect(redirect);
    return c.json({ ok: true, user: { id: user.id, email: user.email, role: user.role }, redirect });
  });

  app.get("/me", async (c) => {
    const user = await userFromCookie(deps.db, c.req.raw, now());
    if (!user)
      return c.json(
        {
          type: "https://surfingdog.ai/problems/unauthorized",
          title: "Not signed in",
          status: 401,
          code: "unauthorized",
          detail: "Sign in with a magic link or a passkey.",
        },
        401,
        { "Content-Type": "application/problem+json" },
      );
    return c.json({ id: user.id, email: user.email, role: user.role });
  });

  app.post("/logout", async (c) => {
    const user = await userFromCookie(deps.db, c.req.raw, now());
    if (user)
      await deps.db.client.query({ sql: "DELETE FROM sessions WHERE id = ?", params: [user.sessionId], method: "run" });
    setCookie(c, SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return c.json({ ok: true });
  });

  return app;
}

function db(deps: SessionDeps) {
  return deps.db.orm;
}

/** Only same-origin paths may be redirect targets after sign-in. */
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
