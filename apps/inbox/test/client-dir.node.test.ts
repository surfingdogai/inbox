import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientDirFrom } from "../src/node-server";

/**
 * Where the Node server finds the owner app without INBOX_STATIC: `client` beside the bundle, as the
 * build, the release's inbox-server.tar.gz and the image lay it out, else ../dist/client from the
 * source. A release unpacked and started with `node server.mjs` serves its app.
 */
describe("the owner app's folder", () => {
  const has =
    (...dirs: string[]) =>
    (dir: string) =>
      dirs.includes(dir);

  it("is INBOX_STATIC when it is set", () => {
    expect(clientDirFrom("/srv/app", "/opt/inbox", has())).toBe("/srv/app");
    expect(clientDirFrom("  ", "/opt/inbox", has("/opt/inbox/client"))).toBe("/opt/inbox/client");
  });

  it("is client beside the bundle: the repository's build, the release and the image", () => {
    expect(clientDirFrom(undefined, "/repo/apps/inbox/dist", has("/repo/apps/inbox/dist/client"))).toBe(
      "/repo/apps/inbox/dist/client",
    );
    expect(clientDirFrom(undefined, "/home/me/inbox", has("/home/me/inbox/client"))).toBe("/home/me/inbox/client");
  });

  it("is ../dist/client from the source, for pnpm dev", () => {
    expect(clientDirFrom(undefined, "/repo/apps/inbox/src", has("/repo/apps/inbox/dist/client"))).toBe(
      "/repo/apps/inbox/dist/client",
    );
  });

  it("names where the build goes when there is none", () => {
    expect(clientDirFrom(undefined, "/home/me/inbox", has())).toBe("/home/me/inbox/client");
  });

  it("is where the release puts it: client beside server.mjs in inbox-server.tar.gz", () => {
    const release = readFileSync(path.resolve(import.meta.dirname, "../../../.github/workflows/release.yml"), "utf8");
    expect(release).toContain("cp apps/inbox/dist/server.mjs");
    expect(release).toContain("cp -r apps/inbox/dist/client out/inbox/client");
  });
});
