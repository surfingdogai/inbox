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
/** On a notice you moved to the inbox. */
export const MOVED_LINE = "Moved from Notices. Still yours alone: nothing answers it by itself.";

/** A notice still under Notices: one you have not moved to the inbox. */
export function isNotice(item: Pick<Item, "flags">): boolean {
  return item.flags.notice === true && item.flags.inInbox !== true;
}

/** A notice you moved to the inbox. */
export function wasNotice(item: Pick<Item, "flags">): boolean {
  return item.flags.notice === true && item.flags.inInbox === true;
}
