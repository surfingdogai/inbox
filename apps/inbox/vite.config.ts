import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The owner app: a Vite + React SPA under ./client, built to ./dist/client, which the Worker serves
 * as static assets (wrangler.jsonc) and the Node entry serves from disk (src/node.ts).
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The doors the server answers; in dev they are proxied to it (`pnpm dev`). Same list as src/node.ts. */
const API_PATHS = ["/v1", "/mcp", "/auth", "/oauth", "/openapi.json", "/healthz", "/.well-known", "/c/", "/demo/"];
const API_TARGET = process.env.INBOX_API ?? "http://localhost:8787";

export default defineConfig({
  root: here("./client"),
  publicDir: here("./public"),
  base: "/",
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, quoteStyle: "double", semicolons: true }),
    react(),
    tailwindcss(),
  ],
  build: { outDir: here("./dist/client"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, { target: API_TARGET }])),
  },
});
