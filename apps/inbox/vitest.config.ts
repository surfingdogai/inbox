import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * One suite, two runtimes. Files ending in `.node.test.ts` run only on Node, `.workers.test.ts`
 * only inside workerd (with D1/R2/Queues bindings from wrangler.jsonc); every other test runs on both.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.workers.test.ts"],
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "../../wrangler.jsonc" } })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.node.test.ts"],
        },
      },
    ],
  },
});
