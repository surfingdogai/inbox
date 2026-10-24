/**
 * @surfingdog/hosted — many inboxes on one machine (Node only).
 *
 * A router finds each inbox by the name a request asks for: the setup address one label under a
 * parent name (never open to agents), or the business's own name once it points here. It applies
 * the rules for the inbox's state, answers what is its own to answer, and passes the rest to the
 * shard that keeps that inbox open. Shards keep one SQLite file per inbox, run only the inboxes
 * with a job due, and are watched for a stalled event loop. A signed admin API over a local socket
 * lets whoever runs the inboxes create them, apply a setup plan, test the doors, hand the owner
 * over, change an inbox's policy and remove a closed one.
 */
export * from "./allowlist";
export * from "./build";
export * from "./config";
export * from "./control-plane";
export * from "./host";
export * from "./keys";
export * from "./ledger";
export * from "./lru";
export * from "./pages";
export * from "./plan";
export * from "./probe";
export * from "./redact";
export * from "./resolver";
export * from "./router";
export * from "./rules";
export * from "./server";
export * from "./shard";
export * from "./sign";
export * from "./sockets";
export * from "./spam";
export * from "./types";
export * from "./usage";
export * from "./watchdog";
