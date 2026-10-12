import {
  type Caller,
  type Db,
  isOwnerInPerson,
  maskEmail,
  readSettings,
  schema,
  sixDigits,
  WriteError,
} from "@surfingdog/core";
import type { MailOut } from "@surfingdog/platform";
import { and, asc, eq } from "drizzle-orm";
import { hashKey } from "./auth";
import { consume } from "./limits";

/**
 * Step-up codes: six fresh digits sent to the owner's own address before something that takes the
 * whole inbox away, such as a download. A session someone else got hold of, or a laptop left signed
 * in, is not enough: whoever asks must also read the owner's mail.
 *
 * A code is for one purpose and works once, for ten minutes; asking for another makes the last one
 * stop working. Tries are counted per address and purpose, five at once and one more every two
 * minutes, and a try past them burns the code. Codes are kept hashed, in `login_tokens` beside the
 * sign-in links, and are never written to a log.
 */
export type StepUpPurpose = "download";

export const STEP_UP_TTL_MS = 10 * 60_000;
/** Tries at a code: five at once, then one more every two minutes. */
const TRIES = { capacity: 5, perMs: 1 / 120_000 };
/** Codes asked for: five at once, then one more every three minutes. */
const SENDS = { capacity: 5, perMs: 1 / 180_000 };

export interface StepUpDeps {
  readonly db: Db;
  readonly mailOut: MailOut;
  readonly now?: (() => number) | undefined;
}

/** What the email with the code says: its subject and text, each given the code. */
export interface StepUpWords {
  readonly subject: (code: string) => string;
  readonly text: (code: string) => string;
}

/**
 * Only the owner in person asks for a step-up code: signed in to the owner app, or with a full owner
 * key. Never the owner's AI and never a key handed to another system.
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
 * The owner's own address, where a code goes: the signed-in person's, or for a full owner key the
 * owner's (the owner email in Settings, else the first owner who signed in). A person signed in as
 * staff gets no code: what a step-up guards is the owner's.
 */
export async function ownerAddress(db: Db, caller: Caller): Promise<string | null> {
  const userId = caller.principal?.userId;
  if (userId) {
    const [user] = await db.orm
      .select({ email: schema.users.email, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (user && user.role !== "owner") {
      throw new WriteError("not_allowed", "Only the owner can do this, signed in as the owner. Nothing was done.", {
        details: { reason: "owner_only" },
      });
    }
    return user?.email ?? null;
  }
  const set = (await readSettings(db)).notifications.ownerEmail;
  if (set) return set;
  const [first] = await db.orm
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.role, "owner"))
    .orderBy(asc(schema.users.createdAt))
    .limit(1);
  return first?.email ?? null;
}

const kindOf = (purpose: StepUpPurpose) => `step_up:${purpose}`;
const hashOf = (purpose: StepUpPurpose, address: string, code: string) =>
  hashKey(`step-up\n${purpose}\n${address.toLowerCase()}\n${code}`);

/**
 * Sends a fresh code to the owner's own address and answers where it went, masked. Refuses with
 * `mail_failed` when it cannot be sent, and never says the code anywhere but in that email.
 */
export async function sendStepUpCode(
  deps: StepUpDeps,
  caller: Caller,
  purpose: StepUpPurpose,
  words: StepUpWords,
): Promise<{ sent_to: string; expires_at: string }> {
  const now = deps.now ? deps.now() : Date.now();
  const address = await ownerAddress(deps.db, caller);
  if (!address) {
    throw new WriteError("not_allowed", "There is no owner email address to send a code to: set one in Settings.", {
      details: { reason: "no_owner_address" },
    });
  }
  const sends = await consume(deps.db, "auth", `step-up:${address.toLowerCase()}`, now, SENDS);
  if (!sends.allowed) {
    throw new WriteError("too_many_attempts", "Too many codes asked for. Wait a few minutes and ask again.", {
      details: { retry_after_seconds: Math.ceil(sends.retryAfterSec) },
    });
  }
  const from = deps.mailOut.sender?.address ?? (await readSettings(deps.db)).email.fromAddress;
  if (!from) {
    throw new MailFailed(
      "This inbox has no address to send email from (MAIL_FROM, or Send from in Settings), so the code could not be sent.",
    );
  }
  const code = sixDigits();
  const kind = kindOf(purpose);
  await deps.db.batch([
    // Asking again makes the last code stop working: only the newest one in the mailbox counts.
    {
      sql: "UPDATE login_tokens SET used_at = ? WHERE kind = ? AND email = ? AND used_at IS NULL",
      params: [now, kind, address],
      method: "run",
    },
    {
      // The same six digits again (one time in a million) is a fresh code, not a clash.
      sql: `INSERT INTO login_tokens (hash, email, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (hash) DO UPDATE SET expires_at = excluded.expires_at, used_at = NULL, created_at = excluded.created_at`,
      params: [await hashOf(purpose, address, code), address, kind, now + STEP_UP_TTL_MS, now],
      method: "run",
    },
  ]);
  try {
    await deps.mailOut.send({
      from: { address: from, name: deps.mailOut.sender?.name ?? "Surfing Dog Inbox" },
      to: [address],
      subject: words.subject(code),
      text: words.text(code),
    });
  } catch (error) {
    // The reason, never the code: whoever reads this log is not the owner.
    console.error("step-up: the code email could not be sent:", error instanceof Error ? error.message : error);
    throw new MailFailed("The code could not be sent. Try again in a minute.");
  }
  return { sent_to: maskEmail(address), expires_at: new Date(now + STEP_UP_TTL_MS).toISOString() };
}

/**
 * Uses the code sent for `purpose`: throws `bad_code`, `code_expired` or `too_many_attempts`, or
 * returns once it has marked the code used, so the same code never works twice.
 */
export async function useStepUpCode(
  deps: StepUpDeps,
  caller: Caller,
  purpose: StepUpPurpose,
  code: unknown,
): Promise<void> {
  const now = deps.now ? deps.now() : Date.now();
  const address = await ownerAddress(deps.db, caller);
  if (!address) throw badCode();
  const kind = kindOf(purpose);
  const tries = await consume(deps.db, "verify", `step-up:${purpose}:${address.toLowerCase()}`, now, TRIES);
  if (!tries.allowed) {
    await deps.db.client.query({
      sql: "UPDATE login_tokens SET used_at = ? WHERE kind = ? AND email = ? AND used_at IS NULL",
      params: [now, kind, address],
      method: "run",
    });
    throw new WriteError("too_many_attempts", "Too many wrong codes. Ask for a new one in a few minutes.", {
      details: { retry_after_seconds: Math.ceil(tries.retryAfterSec) },
    });
  }
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) throw badCode();
  const hash = await hashOf(purpose, address, code);
  const [row] = await deps.db.orm
    .select({ expiresAt: schema.loginTokens.expiresAt, usedAt: schema.loginTokens.usedAt })
    .from(schema.loginTokens)
    .where(and(eq(schema.loginTokens.hash, hash), eq(schema.loginTokens.kind, kind)));
  if (!row || row.usedAt !== null) throw badCode();
  if (row.expiresAt <= now) {
    throw new WriteError("code_expired", "That code has expired. Ask for a new one.", {
      fields: [{ path: "code", problem: "invalid", message: "expired" }],
    });
  }
  // Compare-and-set: of two requests with the same code, one uses it.
  const used = await deps.db.client.query({
    sql: "UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL",
    params: [now, hash],
    method: "run",
  });
  if (used.changes !== 1) throw badCode();
}

function badCode(): WriteError {
  return new WriteError("bad_code", "That is not the code we sent. Check the latest email, or ask for a new code.", {
    fields: [{ path: "code", problem: "invalid", message: "not the code sent" }],
  });
}

/** The email with the code could not be sent: a 502 the route answers with. */
export class MailFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailFailed";
  }
}
