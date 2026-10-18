import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { pinnedFetch } from "@surfingdog/platform/node";
import {
  ConfigError,
  type HostedConfig,
  ledgerPath,
  type Role,
  readConfig,
  shardAdminSocket,
  shardSocket,
  transportFrom,
} from "./config";
import { socketControlPlane } from "./control-plane";
import { isTenantId } from "./host";
import { runtimeKey } from "./keys";
import { Ledger } from "./ledger";
import { migrateCheck } from "./migrate-check";
import { relayRedirect } from "./oauth-relay";
import { installRedaction } from "./redact";
import { CachedResolver } from "./resolver";
import { serveRouter, serveShard } from "./server";
import { Shard } from "./shard";
import { startWatchdog } from "./watchdog";

/**
 * The hosted runtime's processes:
 *
 *   router                 the router: the public socket and the admin socket
 *   shard <n>              shard n: its two sockets, its inboxes' jobs, and its watchdog
 *   all                    the router, with every shard as a child process started again when it ends
 *                          (for running it without a service manager, and in development)
 *   maintenance-off <id>   lets an inbox out of maintenance
 *   migrate-check <file>   brings a copy of an inbox's file to this release's schema, or fails
 *
 * Every setting comes from the environment (config.ts).
 */

installRedaction();

function config(role: Role): HostedConfig {
  try {
    return readConfig(process.env, role);
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(2);
  }
}

async function runRouter(c: HostedConfig): Promise<void> {
  const controlPlane = socketControlPlane({ socketPath: c.cpSocket, key: c.cpRouterKey, shards: c.shards });
  const resolver = new CachedResolver({ controlPlane, parent: c.parent });
  const listening = await serveRouter({
    parent: c.parent,
    resolver,
    shards: c.shards,
    shardSocket: (n) => shardSocket(c, n),
    shardAdminSocket: (n) => shardAdminSocket(c, n),
    securityContact: c.securityContact,
    abuseContact: c.abuseContact,
    reportForm: c.reportForm,
    adminKey: c.adminKey,
    shardKey: c.shardKey,
    oauthRelayHost: c.oauthRelayHost,
    socket: c.routerSocket,
    adminSocket: c.adminSocket,
  });
  console.log(`router: listening, ${c.shards} shards`);
  const stop = async () => {
    await listening.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function runShard(c: HostedConfig, index: number): Promise<void> {
  // Every file a shard makes is its own user's alone.
  process.umask(0o077);
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(ledgerPath(c), { hashKey: runtimeKey(c.masterKeys, "ledger-recipients") });
  const watchdog = startWatchdog({ ledgerPath: ledger.path });
  const shard = new Shard({
    index,
    shards: c.shards,
    dataDir: c.dataDir,
    masterKeys: c.masterKeys,
    controlPlane: socketControlPlane({ socketPath: c.cpSocket, key: c.cpShardKey, shards: c.shards }),
    ledger,
    transport: transportFrom(process.env),
    fetchImpl: pinnedFetch({ deny: [...c.deny] }),
    clientDir: c.clientDir,
    oauth: { google: c.google },
    oauthRedirect: relayRedirect(c.oauthRelayHost),
    maxOpen: c.openPerShard,
    maxTenantBytes: c.maxTenantBytes,
    watchdog,
  });
  await shard.start();
  const listening = await serveShard(shard, {
    socket: shardSocket(c, index),
    adminSocket: shardAdminSocket(c, index),
    shardKey: c.shardKey,
  });
  const jobs = setInterval(() => {
    shard
      .tick()
      .catch((error) => console.error(`shard ${index}: jobs: ${error instanceof Error ? error.message : error}`));
  }, 1_000);
  const prune = setInterval(() => ledger.prune(), 6 * 3_600_000);
  console.log(`shard ${index}: listening, ${shard.tenants().length} inboxes`);
  const stop = async () => {
    clearInterval(jobs);
    clearInterval(prune);
    await listening.close();
    await watchdog.stop();
    ledger.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

/** The router here, and each shard as a child process, started again (after a pause that grows) when it ends. */
async function runAll(c: HostedConfig): Promise<void> {
  const children = new Map<number, ChildProcess>();
  let stopping = false;
  const start = (index: number, restarts: number) => {
    const child = fork(process.argv[1] ?? "", ["shard", String(index)], {
      stdio: "inherit",
      execArgv: [...process.execArgv, ...(c.shardHeapMb ? [`--max-old-space-size=${c.shardHeapMb}`] : [])],
    });
    children.set(index, child);
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      children.delete(index);
      if (stopping) return;
      // A shard that ran for a minute starts again at once; one that keeps ending waits longer each time.
      const again = Date.now() - startedAt > 60_000 ? 0 : restarts + 1;
      const wait = Math.min(30_000, again === 0 ? 0 : 2 ** again * 250);
      console.error(`shard ${index} ended (${signal ?? code}); starting it again${wait ? ` in ${wait} ms` : ""}`);
      setTimeout(() => start(index, again), wait);
    });
  };
  for (let i = 0; i < c.shards; i++) start(i, 0);
  await runRouter(c);
  const stop = () => {
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const [command, arg] = process.argv.slice(2);
if (command === "router") {
  await runRouter(config("router"));
} else if (command === "shard") {
  const c = config("shard");
  const index = Number(arg);
  if (!Number.isInteger(index) || index < 0 || index >= c.shards) {
    console.error(`usage: shard <n>, n from 0 to ${c.shards - 1}`);
    process.exit(2);
  }
  await runShard(c, index);
} else if (command === "all") {
  await runAll(config("all"));
} else if (command === "maintenance-off") {
  const c = config("tool");
  if (!isTenantId(arg)) {
    console.error("usage: maintenance-off <tenant id>");
    process.exit(2);
  }
  const ledger = new Ledger(ledgerPath(c), { hashKey: runtimeKey(c.masterKeys, "ledger-recipients") });
  ledger.clearMaintenance(arg);
  ledger.close();
  console.log(`${arg} is out of maintenance`);
} else if (command === "migrate-check") {
  // Needs no settings: a deploy runs it on a copy of each inbox's file before any shard restarts.
  if (!arg) {
    console.error("usage: migrate-check <file>");
    process.exit(2);
  }
  try {
    const { from, to } = await migrateCheck(arg);
    console.log(`${arg}: schema ${from} → ${to}`);
  } catch (error) {
    console.error(`${arg}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error("usage: router | shard <n> | all | maintenance-off <tenant id> | migrate-check <file>");
  process.exit(2);
}
