import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * One suite, two runtimes, every package. Files ending in `.node.test.ts` run only on Node,
 * `.workers.test.ts` only inside workerd (with the bindings from wrangler.jsonc); everything else
 * runs on both. Storage is isolated per test file on the Workers side.
 */
const include = ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"];

/**
 * The packages that build on the SDK (the network checker, the example network) are tested
 * against its source, so a test never runs against a stale build.
 */
const resolve = {
  alias: { "@surfingdog/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)) },
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: { name: "node", environment: "node", include, exclude: ["**/*.workers.test.ts", "**/node_modules/**"] },
      },
      {
        resolve,
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "workers", include, exclude: ["**/*.node.test.ts", "**/node_modules/**"] },
      },
    ],
  },
});
