import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * One suite, two runtimes, every package. Files ending in `.node.test.ts` run only on Node,
 * `.workers.test.ts` only inside workerd (with the bindings from wrangler.jsonc); everything else
 * runs on both. Storage is isolated per test file on the Workers side.
 */
const include = ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "node", environment: "node", include, exclude: ["**/*.workers.test.ts", "**/node_modules/**"] },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "workers", include, exclude: ["**/*.node.test.ts", "**/node_modules/**"] },
      },
    ],
  },
});
