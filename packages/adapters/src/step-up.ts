import {
  type Caller,
  type Db,
  isOwnerInPerson,
  maskEmail,
  randomToken,
  readSettings,
  schema,
  sixDigits,
  WriteError,
} from "@surfingdog/core";
import { asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { hashKey } from "./auth";
import { sameOrigin } from "./origin";
import { forbidden, problemResponse, unauthorized } from "./problem";
import type { CallerEnv } from "./rest";
import {
  codeHash,
  mailFailed,
  type OwnerMailDeps,
  postedFields,
  type SessionUser,
  sendOwnerMail,
  userFromCookie,
} from "./session";

/**
 * Step-up codes. Before the owner changes the address they sign in with, or takes a copy of the
 * whole inbox, a fresh six-digit code goes to the owner's address on file and has to come back. A session alone is not enough for these: a browser left signed in, or a session cookie
 * someone copied, would otherwise be all it took to move an inbox away from its owner.
 *
 * One helper for every such action. `sendStepUp` sends the code (`POST /auth/step-up` does it for the
 * owner app, `POST /v1/owner/download/code` for a download), and the action's own route calls
 * `checkStepUp` with the code it was given, which uses it up. A code is for one purpose only: one
 * asked for to change the address opens nothing else.
 */
export const STEP_UP_PURPOSES = ["email_change", "download"] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];
export const STEP_UP_TTL_MS = 10 * 60_000;
/** Wrong tries at one code before it stops working. */
export const STEP_UP_ATTEMPTS = 5;
/** Codes one owner may be sent in an hour, for every purpose together. */
export const STEP_UP_SENDS_PER_HOUR = 5;
/** Tries at codes one owner may make in a day, right or wrong. */
export const STEP_UP_TRIES_PER_DAY = 20;

const HOUR = 3_600_000;
/** The daily limit is a rolling day. */
const DAY = 24 * HOUR;

/** What the code is for, as the email says it. */
const DOING: Record<StepUpPurpose, string> = {
  email_change: "change the address you sign in with",
  download: "download a copy of your inbox",
};

export function isStepUpPurpose(value: unknown): value is StepUpPurpose {
  return typeof value === "string" && (STEP_UP_PURPOSES as readonly string[]).includes(value);
}

export interface StepUpDeps extends OwnerMailDeps {
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Sends a fresh code for `purpose` to the user's address on file, never to one the caller names.
 * Past the hour's sends it throws `too_many_attempts`; when the email cannot be sent it throws what
 * the mail service threw, and the code is gone again.
 */
export async function sendStepUp(
  deps: StepUpDeps,
  user: { readonly id: string; readonly email: string },
  purpose: StepUpPurpose,
): Promise<{ sentTo: string; expiresInSec: number }> {
  const now = deps.now ? deps.now() : Date.now();
  const hash = await hashKey(randomToken(32));
  const code = sixDigits();
  // Counted and written in one statement: requests sent together cannot each see room for one more.
  const inserted = await deps.db.client.query({
    sql: `INSERT INTO login_tokens (hash, email, kind, user_id, code_hash, attempts, expires_at, created_at)
          SELECT ?, ?, ?, ?, ?, 0, ?, ?
           WHERE (SELECT COUNT(*) FROM login_tokens WHERE user_id = ? AND kind LIKE 'step_up:%' AND created_at > ?) < ?`,
    params: [
      hash,
      user.email,
      `step_up:${purpose}`,
      user.id,
      await codeHash(hash, code),
      now + STEP_UP_TTL_MS,
      now,
      user.id,
      now - HOUR,
      STEP_UP_SENDS_PER_HOUR,
    ],
    method: "run",
  });
  if (inserted.changes === 0) {
    throw new WriteError(
      "too_many_attempts",
      `We have sent you ${STEP_UP_SENDS_PER_HOUR} codes in the last hour; please try again later.`,
    );
  }
  const name = await deps.businessName();
  try {
    await sendOwnerMail(deps, {
      what: "step-up code",
      to: user.email,
      subject: `Your code for ${name || "your inbox"}`,
      text: `Your code: ${code}\n\nEnter it to ${DOING[purpose]}. It works once, for 10 minutes.\n\nIf you did not ask for it, someone may be signed in to your inbox as you: do not pass the code on, and check Settings → Keys for anything you do not recognise.`,
    });
  } catch (error) {
    await deps.db.client.query({ sql: "DELETE FROM login_tokens WHERE hash = ?", params: [hash], method: "run" });
    throw error;
  }
  return { sentTo: maskEmail(user.email), expiresInSec: STEP_UP_TTL_MS / 1000 };
}

/**
 * Checks a step-up code for `purpose` and uses it up; throws `bad_code`, `code_expired` or
 * `too_many_attempts` otherwise. Every try is counted before the code is compared, in the statement
 * that also checks there is a try left, on the code (`STEP_UP_ATTEMPTS`) and for the owner today
 * (`STEP_UP_TRIES_PER_DAY`), so guesses sent together cannot all read the same count. Every code
 * still open for the purpose is tried, so an earlier email's code works as well as the latest.
 */
export async function checkStepUp(
  db: Db,
  user: { readonly id: string },
  purpose: StepUpPurpose,
  code: string,
  now: number,
): Promise<void> {
  const kind = `step_up:${purpose}`;
  const typed = code.replace(/\s+/g, "");
  const { rows } = await db.client.query({
    sql: `UPDATE login_tokens SET attempts = attempts + 1
           WHERE user_id = ? AND kind = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
             AND (SELECT COALESCE(SUM(attempts), 0) FROM login_tokens
                   WHERE user_id = ? AND kind LIKE 'step_up:%' AND created_at > ?) < ?
         RETURNING hash, code_hash`,
    params: [user.id, kind, now, STEP_UP_ATTEMPTS, user.id, now - DAY, STEP_UP_TRIES_PER_DAY],
    method: "all",
  });
  if (rows.length === 0) throw await whyNot(db, user.id, kind, now);
  for (const r of rows) {
    const hash = String(r[0]);
    if (!/^[0-9]{6}$/.test(typed) || (await codeHash(hash, typed)) !== String(r[1])) continue;
    const used = await db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL",
      params: [now, hash],
      method: "run",
    });
    if (used.changes !== 1) break;
    // One code, one action: the others sent for it stop working too.
    await db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL",
      params: [now, user.id, kind],
      method: "run",
    });
    return;
  }
  throw new WriteError("bad_code", "That is not the code.");
}

/** Why no code had a try left: the day's tries, the code's own five, or no code open at all. */
async function whyNot(db: Db, userId: string, kind: string, now: number): Promise<WriteError> {
  const { rows } = await db.client.query({
    sql: `SELECT COALESCE(SUM(attempts), 0),
                 (SELECT COUNT(*) FROM login_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL AND expires_at > ?)
            FROM login_tokens WHERE user_id = ? AND kind LIKE 'step_up:%' AND created_at > ?`,
    params: [userId, kind, now, userId, now - DAY],
    method: "all",
  });
  const today = Number(rows[0]?.[0] ?? 0);
  const open = Number(rows[0]?.[1] ?? 0);
  if (today >= STEP_UP_TRIES_PER_DAY) {
    return new WriteError("too_many_attempts", "Too many tries at a code today; please try again tomorrow.");
  }
  if (open > 0) return new WriteError("too_many_attempts", "Too many wrong tries; ask for a new code.");
  return new WriteError("code_expired", "That code has expired or was used already; ask for a new one.");
}

/**
 * The owner in person: signed in to the owner app in this browser, by its session cookie (an API key
 * or an AI's token is not a person), and, for anything but a read, asking from this inbox's own
 * pages. Anything else gets the response that refuses it.
 */
export async function ownerInPerson(
  c: Context,
  deps: { readonly db: Db; readonly baseUrl?: string | undefined; readonly now?: (() => number) | undefined },
): Promise<SessionUser | Response> {
  const user = await userFromCookie(deps.db, c.req.raw, deps.now ? deps.now() : Date.now());
  if (!user) return unauthorized(c, "Sign in to the owner app in this browser first.");
  if (user.role !== "owner") return forbidden(c, "Only the owner can do this.");
  if (!["GET", "HEAD"].includes(c.req.method) && !sameOrigin(c.req.raw, deps.baseUrl)) {
    return forbidden(c, "Do this from the owner app.");
  }
  return user;
}

/**
 * The same owner in person, as the owner's API sees them (a download): signed in to the owner app, or
 * with a full owner key from the command line. Never the owner's AI and never a key handed to another
 * system.
 */
export function requireStepUpCaller(caller: Caller, what: string): void {
  if (isOwnerInPerson(caller) && caller.actor.channel !== "mcp_owner") return;
  throw new WriteError(
    "not_allowed",
    `Only the owner can ${what}, signed in to the owner app, with a code sent to their email. Nothing was done.`,
    { details: { reason: "owner_in_person", ask_owner: true } },
  );
}

/**
 * Whose code it is, for a caller of the owner's API: the person signed in, or the owner a full owner
 * key was made for; for a key that names nobody, the owner whose address is the owner email in
 * Settings, else the first owner. A person signed in as staff gets no code: what a step-up guards is
 * the owner's.
 */
export async function stepUpOwner(db: Db, caller: Caller): Promise<{ id: string; email: string }> {
  const userId = caller.principal?.userId;
  if (userId) {
    const [user] = await db.orm
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (user && user.role !== "owner") {
      throw new WriteError("not_allowed", "Only the owner can do this, signed in as the owner. Nothing was done.", {
        details: { reason: "owner_only" },
      });
    }
    if (user) return { id: user.id, email: user.email };
    throw noOwner();
  }
  const set = (await readSettings(db)).notifications.ownerEmail?.toLowerCase();
  const owners = await db.orm
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.role, "owner"))
    .orderBy(asc(schema.users.createdAt));
  const owner = owners.find((u) => u.email.toLowerCase() === set) ?? owners[0];
  if (!owner) throw noOwner();
  return owner;
}

function noOwner(): WriteError {
  return new WriteError(
    "not_allowed",
    "There is no owner here to send a code to yet: sign in to the owner app once first.",
    { details: { reason: "no_owner_address" } },
  );
}

/** `POST /auth/step-up` `{ purpose }`: a fresh code to the owner's address, for the owner app. */
export function stepUpRoutes(deps: StepUpDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.post("/", async (c) => {
    const owner = await ownerInPerson(c, deps);
    if (owner instanceof Response) return owner;
    const { fields } = await postedFields(c);
    if (!isStepUpPurpose(fields.purpose)) {
      return problemResponse(
        c,
        new WriteError("invalid_input", `Say what the code is for: ${STEP_UP_PURPOSES.join(", ")}.`, {
          fields: [{ path: "purpose", problem: "invalid", message: `one of ${STEP_UP_PURPOSES.join(", ")}` }],
        }),
      );
    }
    try {
      const sent = await sendStepUp(deps, owner, fields.purpose);
      return c.json({ ok: true, sent_to: sent.sentTo, expires_in: sent.expiresInSec });
    } catch (error) {
      if (error instanceof WriteError) return problemResponse(c, error);
      return mailFailed(c, "Couldn't send the code. Try again in a minute.");
    }
  });
  return app;
}
