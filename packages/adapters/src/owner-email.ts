import { type Db, randomToken, SETTINGS_SCHEMA_VERSION, WriteError } from "@surfingdog/core";
import { DbError } from "@surfingdog/platform";
import { type Context, Hono } from "hono";
import { hashKey } from "./auth";
import { type AuthPage, authPage } from "./auth-page";
import { sameOrigin } from "./origin";
import { problemResponse } from "./problem";
import type { CallerEnv } from "./rest";
import {
  emailOf,
  endSessions,
  linkOrigin,
  mailFailed,
  type OwnerMailDeps,
  openToken,
  postedFields,
  sendOwnerMail,
  takeToken,
  userFromCookie,
} from "./session";
import { checkStepUp, ownerInPerson } from "./step-up";

/**
 * Changing the address the owner signs in with. Only the owner in person, with a step-up code sent
 * to the address they have now; then a link goes to the new address, and nothing changes until it
 * is opened and confirmed in a browser signed in as that owner, so a typo hands the inbox to nobody.
 * The address the owner is told at (`notifications.ownerEmail`) moves with it when it was the same.
 * Once it has changed the old address is told, with a link that puts it back for seven days and
 * signs out every session; and the host, when there is one, is told each time
 * (`onOwnerEmailChange`). A server's operator can set it from the command line instead
 * (`setOwnerEmail`), for an owner who can no longer read the old address.
 */
export const EMAIL_CHANGE_TTL_MS = 24 * 3_600_000;
export const EMAIL_UNDO_TTL_MS = 7 * 86_400_000;

export interface OwnerEmailChange {
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  /** `changed`: the owner confirmed a new address. `undone`: the old address took it back. */
  readonly how: "changed" | "undone";
}

export interface OwnerEmailDeps extends OwnerMailDeps {
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
  /** Tells the host the owner's address changed. It cannot stop the change; a failure is logged. */
  readonly onOwnerEmailChange?: ((change: OwnerEmailChange) => unknown) | undefined;
}

/**
 * Moves a user from `from` to `to`, and `notifications.ownerEmail` with them when it was the same
 * address, in one batch, and only while the user still has `from`. Settings are written here and not
 * through `updateSettings`: this is the way the owner's address changes, and a host that keeps
 * `notifications.ownerEmail` from every other writer still lets this one through. An address that
 * already has an account here is refused (`invalid_input`).
 */
export async function moveOwnerEmail(
  db: Db,
  o: { userId: string; from: string; to: string; now: number },
): Promise<boolean> {
  try {
    const [moved] = await db.batch([
      { sql: "UPDATE users SET email = ? WHERE id = ? AND email = ?", params: [o.to, o.userId, o.from], method: "run" },
      {
        sql: `UPDATE settings SET doc = json_set(doc, '$.notifications.ownerEmail', ?), version = version + 1, updated_at = ?
               WHERE id = 'singleton' AND lower(json_extract(doc, '$.notifications.ownerEmail')) = ?
                 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?)`,
        params: [o.to, o.now, o.from, o.userId, o.to],
        method: "run",
      },
    ]);
    return moved?.changes === 1;
  } catch (error) {
    if (error instanceof DbError && error.code === "unique") throw taken();
    throw error;
  }
}

const taken = () =>
  new WriteError("invalid_input", "That address already has an account here.", {
    fields: [{ path: "email", problem: "invalid", message: "already has an account here" }],
  });

async function hasAccount(db: Db, email: string): Promise<boolean> {
  const { rows } = await db.client.query({
    sql: "SELECT 1 FROM users WHERE email = ?",
    params: [email],
    method: "all",
  });
  return rows.length > 0;
}

/**
 * `set-owner-email` on the command line: the operator sets the owner's address, with no email to
 * the old one. With `from`, the user who has that address; without, the one owner there is. While
 * nobody has signed in yet it is the address that may create the first account. Every session of
 * the user it moves ends.
 */
export async function setOwnerEmail(
  db: Db,
  o: { to: string; from?: string | undefined; now?: number },
): Promise<
  { outcome: "moved"; from: string; to: string } | { outcome: "first_owner"; to: string } | { outcome: "unchanged" }
> {
  const to = emailOf(o.to);
  if (!to) throw new Error(`not an email address: ${o.to}`);
  const now = o.now ?? Date.now();
  const from = o.from === undefined ? null : emailOf(o.from);
  if (o.from !== undefined && !from) throw new Error(`not an email address: ${o.from}`);
  const { rows } = await db.client.query({
    sql: from ? "SELECT id, email FROM users WHERE email = ?" : "SELECT id, email FROM users WHERE role = 'owner'",
    params: from ? [from] : [],
    method: "all",
  });
  const { rows: anyone } = await db.client.query({ sql: "SELECT 1 FROM users LIMIT 1", params: [], method: "all" });
  if (anyone.length === 0) {
    await db.client.query({
      sql: `INSERT INTO settings (id, schema_version, doc, version, updated_at) VALUES ('singleton', ?, ?, 1, ?)
            ON CONFLICT (id) DO UPDATE SET doc = json_set(settings.doc, '$.notifications.ownerEmail', ?),
              version = settings.version + 1, updated_at = excluded.updated_at`,
      params: [SETTINGS_SCHEMA_VERSION, JSON.stringify({ notifications: { ownerEmail: to } }), now, to],
      method: "run",
    });
    return { outcome: "first_owner", to };
  }
  if (rows.length === 0) throw new Error(from ? `nobody here signs in with ${from}` : "there is no owner here");
  if (rows.length > 1) throw new Error("there is more than one owner here: name the one to change by their address");
  const [row] = rows;
  const userId = String(row?.[0]);
  const current = String(row?.[1]);
  if (current === to) return { outcome: "unchanged" };
  if (await hasAccount(db, to)) throw new Error(`${to} already has an account here`);
  if (!(await moveOwnerEmail(db, { userId, from: current, to, now }))) {
    throw new Error("the address changed while this ran; run it again");
  }
  await db.batch([
    {
      sql: "UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
      params: [now, userId],
      method: "run",
    },
    { sql: "DELETE FROM sessions WHERE user_id = ?", params: [userId], method: "run" },
  ]);
  return { outcome: "moved", from: current, to };
}

/** `POST /auth/email`, and the pages its two links open: `/auth/email/confirm` and `/auth/email/undo`. */
export function ownerEmailRoutes(deps: OwnerEmailDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const businessName = async () => (await deps.businessName()) || "your inbox";

  const tellHost = async (change: OwnerEmailChange) => {
    if (!deps.onOwnerEmailChange) return;
    try {
      await deps.onOwnerEmailChange(change);
    } catch (error) {
      log(`owner address ${change.how}, but the host was not told: ${error instanceof Error ? error.message : error}`);
    }
  };

  /** A page, or for JSON (a script) the same outcome: the answer, or a problem document. */
  const answer = (
    c: Context,
    form: boolean,
    status: 200 | 403 | 409 | 410,
    page: AuthPage,
    json: { readonly code: string; readonly detail: string } | { readonly ok: true; readonly email: string },
  ): Response => {
    if (form) return authPage(c, status, page);
    if ("ok" in json) return c.json(json, status);
    return c.json(
      { type: `https://surfingdog.ai/problems/${json.code}`, title: page.heading, status, ...json },
      status,
      { "Content-Type": "application/problem+json" },
    );
  };

  const gone: AuthPage = {
    title: "Link expired",
    heading: "This link no longer works",
    lines: ["It was used already, a newer request replaced it, or it is too old. Nothing changed."],
    link: { href: "/", label: "Go to your inbox" },
  };
  const goneJson = { code: "link_expired", detail: "That link is no longer valid." };

  // The owner asks, with the step-up code from their current address.
  app.post("/", async (c) => {
    const owner = await ownerInPerson(c, deps);
    if (owner instanceof Response) return owner;
    const { fields } = await postedFields(c);
    const to = emailOf(fields.email);
    if (!to) {
      return problemResponse(
        c,
        new WriteError("invalid_input", "Send the new address.", {
          fields: [{ path: "email", problem: "invalid", message: "not an email" }],
        }),
      );
    }
    if (to === owner.email) {
      return problemResponse(
        c,
        new WriteError("invalid_input", "That is the address you sign in with already.", {
          fields: [{ path: "email", problem: "invalid", message: "the same address" }],
        }),
      );
    }
    if (await hasAccount(deps.db, to)) return problemResponse(c, taken());
    try {
      await checkStepUp(deps.db, owner, "email_change", fields.code ?? "", now());
    } catch (error) {
      return problemResponse(c, error);
    }
    const token = randomToken(32);
    const hash = await hashKey(token);
    await deps.db.batch([
      // Only the latest request waits for its link: an earlier one not yet confirmed stops working.
      {
        sql: "UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND kind = 'email_change' AND used_at IS NULL",
        params: [now(), owner.id],
        method: "run",
      },
      {
        sql: `INSERT INTO login_tokens (hash, email, kind, user_id, detail, attempts, expires_at, created_at)
              VALUES (?, ?, 'email_change', ?, ?, 0, ?, ?)`,
        params: [hash, to, owner.id, JSON.stringify({ from: owner.email, to }), now() + EMAIL_CHANGE_TTL_MS, now()],
        method: "run",
      },
    ]);
    const link = `${await linkOrigin(deps, c.req.raw)}/auth/email/confirm?token=${token}`;
    try {
      await sendOwnerMail(deps, {
        what: "address change email",
        to,
        subject: `Confirm your new address for ${await businessName()}`,
        text: `Open this link and press Confirm to sign in to ${await businessName()} with this address from now on:\n${link}\n\nOpen it in the browser where you are signed in. It works once, for 24 hours, and until then nothing changes. If you did not ask for this, ignore this email.`,
      });
    } catch {
      await deps.db.client.query({ sql: "DELETE FROM login_tokens WHERE hash = ?", params: [hash], method: "run" });
      return mailFailed(c, "Couldn't send to that address. Check it, then ask for a new code and try again.");
    }
    return c.json({ ok: true, sent_to: to });
  });

  // The link in the new address's email: what confirming does, and a button.
  app.get("/confirm", async (c) => {
    const token = c.req.query("token") ?? "";
    const row = await openToken(deps.db, token, "email_change", now());
    if (!row) return authPage(c, 410, gone);
    return authPage(c, 200, {
      title: "Confirm your new address",
      heading: `Sign in to ${await businessName()} with ${row.email}?`,
      lines: ["From then on this is the address you sign in with, and where you are told about new requests."],
      form: { action: "/auth/email/confirm", fields: { token }, button: "Confirm" },
    });
  });

  app.post("/confirm", async (c) => {
    const { fields, form } = await postedFields(c);
    if (!sameOrigin(c.req.raw, deps.baseUrl)) {
      return answer(
        c,
        form,
        403,
        { title: "Not confirmed", heading: "Confirm from the page your link opened", lines: ["Nothing changed."] },
        { code: "not_allowed", detail: "Confirm from this inbox's own page." },
      );
    }
    const token = fields.token ?? "";
    const open = await openToken(deps.db, token, "email_change", now());
    if (!open) return answer(c, form, 410, gone, goneJson);
    // Whoever reads the new address is not enough: a typo would hand them the inbox. It is confirmed
    // in a browser signed in as the owner who asked.
    const user = await userFromCookie(deps.db, c.req.raw, now(), deps.baseUrl);
    if (!user || user.id !== open.userId) {
      return answer(
        c,
        form,
        403,
        {
          title: "Sign in first",
          heading: "Open this link where you are signed in",
          lines: [
            `Sign in to ${await businessName()} in this browser with the address you use now, then open the link in the email again. Nothing changed.`,
          ],
          link: { href: "/login", label: "Sign in" },
        },
        { code: "not_allowed", detail: "Confirm in a browser signed in as the owner who asked." },
      );
    }
    const row = await takeToken(deps.db, token, "email_change", now());
    if (!row?.userId) return answer(c, form, 410, gone, goneJson);
    const from = String(row.detail.from ?? "");
    const to = row.email;
    let moved = false;
    try {
      moved = await moveOwnerEmail(deps.db, { userId: row.userId, from, to, now: now() });
    } catch (error) {
      if (error instanceof WriteError) {
        return answer(
          c,
          form,
          409,
          { title: "Not changed", heading: "That address already has an account here", lines: ["Nothing changed."] },
          { code: "invalid_input", detail: error.message },
        );
      }
      throw error;
    }
    if (!moved) {
      return answer(
        c,
        form,
        409,
        {
          title: "Not changed",
          heading: "Your address changed since you asked",
          lines: ["So nothing changed now. Ask again from Settings if you still want to."],
          link: { href: "/settings/keys", label: "Go to Settings" },
        },
        { code: "version_conflict", detail: "The address changed since this was asked for." },
      );
    }
    const undo = randomToken(32);
    await deps.db.client.query({
      sql: `INSERT INTO login_tokens (hash, email, kind, user_id, detail, attempts, expires_at, created_at)
            VALUES (?, ?, 'email_undo', ?, ?, 0, ?, ?)`,
      params: [await hashKey(undo), from, row.userId, JSON.stringify({ from, to }), now() + EMAIL_UNDO_TTL_MS, now()],
      method: "run",
    });
    const undoLink = `${await linkOrigin(deps, c.req.raw)}/auth/email/undo?token=${undo}`;
    let told = true;
    try {
      await sendOwnerMail(deps, {
        what: "address change notice",
        to: from,
        subject: `The address you sign in with was changed`,
        text: `From now on you sign in to ${await businessName()} with ${to}, not with this address.\n\nIf that wasn't you, put this address back within 7 days:\n${undoLink}\n\nThat also signs out every session.`,
      });
    } catch {
      told = false;
    }
    await tellHost({ userId: row.userId, from, to, how: "changed" });
    return answer(
      c,
      form,
      200,
      {
        title: "Address changed",
        heading: "Done",
        lines: [
          `You sign in with ${to} from now on.`,
          told
            ? `${from} was told, with a link that puts it back for 7 days.`
            : `We couldn't send the notice to ${from}.`,
        ],
        link: { href: "/", label: "Go to your inbox" },
      },
      { ok: true, email: to },
    );
  });

  // The link in the old address's notice: what putting it back does, and a button.
  app.get("/undo", async (c) => {
    const token = c.req.query("token") ?? "";
    const row = await openToken(deps.db, token, "email_undo", now());
    if (!row) return authPage(c, 410, gone);
    return authPage(c, 200, {
      title: "Put your address back",
      heading: `Put back ${row.email} as the address you sign in with?`,
      lines: [
        `The address for ${await businessName()} was changed to ${String(row.detail.to ?? "another one")}. If that wasn't you, put yours back. Every session is signed out, wherever it is.`,
      ],
      form: { action: "/auth/email/undo", fields: { token }, button: "Put it back" },
    });
  });

  app.post("/undo", async (c) => {
    const { fields, form } = await postedFields(c);
    if (!sameOrigin(c.req.raw, deps.baseUrl)) {
      return answer(
        c,
        form,
        403,
        { title: "Not changed", heading: "Use the page your link opened", lines: ["Nothing changed."] },
        { code: "not_allowed", detail: "Undo from this inbox's own page." },
      );
    }
    const row = await takeToken(deps.db, fields.token ?? "", "email_undo", now());
    if (!row?.userId) return answer(c, form, 410, gone, goneJson);
    const back = row.email;
    const { rows } = await deps.db.client.query({
      sql: "SELECT email FROM users WHERE id = ?",
      params: [row.userId],
      method: "all",
    });
    const current = rows[0] ? String(rows[0][0]) : null;
    if (current === null) return answer(c, form, 410, gone, goneJson);
    // Back to the old address whatever it is now: changing it again straight away is how someone
    // would try to get round this link.
    if (current !== back) {
      try {
        if (!(await moveOwnerEmail(deps.db, { userId: row.userId, from: current, to: back, now: now() }))) {
          return answer(c, form, 409, gone, goneJson);
        }
      } catch (error) {
        if (error instanceof WriteError) {
          return answer(
            c,
            form,
            409,
            { title: "Not changed", heading: "That address has another account here now", lines: ["Nothing changed."] },
            { code: "invalid_input", detail: error.message },
          );
        }
        throw error;
      }
    }
    // Everything the other address could still use goes: its pending changes, other undo links,
    // codes, and every session.
    await deps.db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
      params: [now(), row.userId],
      method: "run",
    });
    await endSessions(deps.db, row.userId);
    if (current !== back) await tellHost({ userId: row.userId, from: current, to: back, how: "undone" });
    return answer(
      c,
      form,
      200,
      {
        title: "Address put back",
        heading: "Done",
        lines: [
          `You sign in with ${back} again, and every session was signed out.`,
          "Sign in, then check Settings → Keys for anything you do not recognise.",
        ],
        link: { href: "/login", label: "Sign in" },
      },
      { ok: true, email: back },
    );
  });

  return app;
}
