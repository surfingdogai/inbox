import type { Item } from "./types";

/**
 * Notices in the owner app: emails from systems (receipts, account and newsletter mail, an
 * out-of-office, a returned email) that answer no conversation. Kept, always, for you alone; out of
 * every other list; answered by nobody. Pure, so they are tested on both runtimes.
 */

export const NOTICES_TOP =
  "Notices: emails from systems, like receipts, account and newsletter mail. Nobody answers them.";
export const NOTICES_EMPTY = "No notices.";
/** On a notice itself, above its email. */
export const NOTICE_LINE = "A notice: an email from a system. Nobody answers it, and only you read it.";
/** On a notice itself: every notice from its sender (its domain), deleted at once. */
export const DELETE_ALL_LABEL = "Delete all from this sender";
export const DELETE_ALL_ASK = "Delete every notice from this sender for good?";
/** On a notice in the inbox: moved there, or brought back from Spam with Not spam. */
export const MOVED_LINE = "A notice, in your inbox now. Still yours alone: nothing answers it by itself.";
/** What a notice moved to the inbox says, with a link to it. */
export const MOVED_TO_INBOX = "Moved to your inbox.";

/** A notice still under Notices: one you have not moved to the inbox. */
export function isNotice(item: Pick<Item, "flags">): boolean {
  return item.flags.notice === true && item.flags.inInbox !== true;
}

/** A notice you moved to the inbox. */
export function wasNotice(item: Pick<Item, "flags">): boolean {
  return item.flags.notice === true && item.flags.inInbox === true;
}

// ---- new notices, said quietly in the inbox -------------------------------------------------------

/** Where this browser keeps when you last opened Notices. */
export const NOTICES_SEEN_KEY = "sdi.notices.seen";
/** Before you ever opened Notices here, those of the last week are the new ones. */
export const RECENT_NOTICES_MS = 7 * 24 * 60 * 60 * 1000;

/** When you last opened Notices, as kept: null when never, or when what is kept is not a time. */
export function readNoticesSeen(raw: string | null): number | null {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How many notices came since you last opened Notices (`seenAt`), or in the last week when you never
 * did, from when each came (`times`, as the list gives them).
 */
export function newNotices(times: readonly string[], seenAt: number | null, now: number = Date.now()): number {
  const since = seenAt ?? now - RECENT_NOTICES_MS;
  return times.filter((t) => Date.parse(t) > since).length;
}

/** The line above the inbox: "6 new notices from companies"; "100+" past what was counted. */
export function noticesLine(n: number, more = false): string {
  if (n === 1 && !more) return "1 new notice from a company";
  return `${n}${more ? "+" : ""} new notices from companies`;
}
