/**
 * The package version, in a leaf module of its own so that anything low in the import graph can
 * reach it. It is in the `user-agent` of every outbound request this instance makes, so a receiver
 * reading its own logs can tell which Inbox called it.
 */
export const VERSION = "0.0.0";

/** `surfingdog-inbox/<version>` — the one product token every outbound request identifies with. */
export const USER_AGENT = `surfingdog-inbox/${VERSION}`;
