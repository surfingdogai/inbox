import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The phone app's screens, built to ./dist and copied into the Android project by `cap sync`. Relative
 * asset paths: the WebView serves them from inside the app.
 *
 * Two copies of the app come from them (store/play/signing.md): `vite build` makes the download
 * page's, `vite build --mode play` Google Play's.
 */
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), channel(mode === "play" ? "play" : "direct")],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  server: { port: 5174 },
}));

/**
 * For Google Play, `src/channel.ts` (the update check and its line, lib/update.ts) is replaced by
 * `src/channel.play.ts` (neither), so nothing of it is in that build. Each build says which copy it is
 * in `channel.json`, which the Android build checks before it packs the screens into a copy
 * (android/app/build.gradle → checkScreens).
 */
function channel(which: "direct" | "play"): Plugin {
  const direct = fileURLToPath(new URL("./src/channel.ts", import.meta.url));
  const play = fileURLToPath(new URL("./src/channel.play.ts", import.meta.url));
  return {
    name: "surfingdog-channel",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (which !== "play" || !importer) return null;
      const found = await this.resolve(source, importer, { ...options, skipSelf: true });
      return found?.id === direct ? play : null;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "channel.json", source: `${JSON.stringify({ channel: which })}\n` });
    },
  };
}
