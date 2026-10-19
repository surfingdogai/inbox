import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The phone app's screens, built to ./dist and copied into the Android project by `cap sync`. Relative
 * asset paths: the WebView serves them from inside the app.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  server: { port: 5174 },
});
