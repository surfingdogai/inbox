#!/usr/bin/env node
// Builds the one-command installer that surfingdog.ai serves at /install.sh, from deploy/install.sh
// and the kit files it carries inside it (the Compose file, Caddy's file, the `inbox` command), and
// writes its checksum beside it. One file, so what `curl … | sh` runs can be read whole first.
//
//   node scripts/build-install.mjs           write apps/site/public/install.sh and install.sh.sha256
//   node scripts/build-install.mjs --check   fail when either is not what deploy/ would build now
//   node scripts/build-install.mjs --out d   write both into d instead (the release does this)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const DELIMITER = "SDI_KIT_EOF";

/** The installer, with every `@@EMBED <file>@@` line replaced by that file. */
export function buildInstaller(dir = root) {
  const source = readFileSync(path.join(dir, "deploy/install.sh"), "utf8");
  const built = source.replace(/^@@EMBED (\S+)@@$/gm, (_, file) => {
    const text = readFileSync(path.join(dir, file), "utf8").replace(/\n+$/, "");
    if (text.split("\n").includes(DELIMITER))
      throw new Error(`${file} has a line ${DELIMITER}, which ends its heredoc`);
    if (text.includes("@@EMBED")) throw new Error(`${file} embeds another file; only deploy/install.sh does`);
    return text;
  });
  if (built.includes("@@EMBED")) throw new Error("an @@EMBED line is left that is not on a line of its own");
  return built;
}

export const checksumLine = (text) => `${createHash("sha256").update(text).digest("hex")}  install.sh\n`;

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = args.includes("--out")
    ? path.resolve(args[args.indexOf("--out") + 1])
    : path.join(root, "apps/site/public");
  const script = buildInstaller();
  const sum = checksumLine(script);
  if (args.includes("--check")) {
    const read = (f) => {
      try {
        return readFileSync(path.join(out, f), "utf8");
      } catch {
        return null;
      }
    };
    if (read("install.sh") !== script || read("install.sh.sha256") !== sum) {
      console.error("apps/site/public/install.sh is not what deploy/ builds: run node scripts/build-install.mjs");
      process.exit(1);
    }
    console.log(`install.sh is up to date: ${sum.trim()}`);
  } else {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "install.sh"), script, { mode: 0o644 });
    writeFileSync(path.join(out, "install.sh.sha256"), sum);
    console.log(`wrote ${path.relative(root, out) || "."}/install.sh: ${sum.trim()}`);
  }
}
