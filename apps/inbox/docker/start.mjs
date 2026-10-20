// The image's entry: it makes sure the server can write its data folder, then starts the server.
//
// The image runs as the user `inbox` (uid 10001), never as root. Some platforms mount a fresh volume
// that belongs to root, which that user cannot write to; on those the container is started as root
// once (their own setting, such as RAILWAY_RUN_UID=0, or `USER root` in a two-line Dockerfile, as
// deploy/fly and deploy/render do). Started as root, this file gives the data folder to `inbox` and
// becomes that user before anything else runs, so the server itself never runs as root.
//
// Commands pass through: `node start.mjs create-owner-key laptop` is `node server.mjs create-owner-key
// laptop`, as the right user. The server ends itself on TERM and INT: it stops taking requests, lets
// the job it is running finish, and closes the database.
import { accessSync, constants, lchownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const UID = 10001;
const GID = 10001;
/** The only folder root ever gives away: the image's data folder, or a folder inside it. */
const ROOT = "/opt/inbox/data";
const data = path.resolve(path.dirname(process.env.INBOX_DB ?? `${ROOT}/inbox.db`));

/**
 * Gives `dir` and everything under it to the inbox user. A link is given itself (lchown), never what
 * it points at, and never walked into, so nothing the inbox user put in the folder can lead root out
 * of it.
 */
function own(dir) {
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.uid !== UID || st.gid !== GID) lchownSync(p, UID, GID);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(path.join(p, name));
  };
  walk(dir);
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  mkdirSync(data, { recursive: true });
  if (data === ROOT || data.startsWith(`${ROOT}/`)) {
    own(data);
  } else {
    // INBOX_DB set elsewhere, such as beside the server itself: root gives nothing away there.
    console.error(`${data} is not in ${ROOT}, so it is left as it is: give it to uid ${UID} yourself.`);
  }
  process.setgroups([GID]);
  process.setgid(GID);
  process.setuid(UID);
}

try {
  mkdirSync(data, { recursive: true });
  accessSync(data, constants.W_OK);
} catch {
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  console.error(
    [
      `The inbox cannot write to ${data} (it runs as uid ${uid}).`,
      `Give that folder to uid ${UID}: on the host, sudo chown -R ${UID}:${GID} <the folder you mounted>.`,
      "Or start the container as root once (--user 0): it gives the folder to the inbox user, then runs as that user.",
    ].join("\n"),
  );
  process.exit(1);
}

await import("./server.mjs");
